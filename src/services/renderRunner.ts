import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "child_process";
import * as path from "path";
import * as fs from "fs";
import { EventEmitter } from "events";
import { setActiveSlug } from "./scenarioManager";

export interface RenderTask {
  id: string;
  slug: string;
  status: "running" | "completed" | "failed" | "stopped";
  logs: string[];
  progressPercent?: number;
  currentFrame?: number;
  totalFrames?: number;
  startTime: number;
  endTime?: number;
  outputFile?: string;
  outputSizeBytes?: number;
  error?: string;
}

export interface RenderInfo {
  exists: boolean;
  slug: string;
  filePath?: string;
  fileSizeBytes?: number;
  lastModified?: string;
  videoUrl?: string;
  downloadUrl?: string;
}

class RenderRunner extends EventEmitter {
  private currentTask: RenderTask | null = null;
  private childProcess: ChildProcessWithoutNullStreams | null = null;

  getCurrentTask(): RenderTask | null {
    return this.currentTask;
  }

  getRenderInfo(slug: string): RenderInfo {
    const rootDir = path.resolve(__dirname, "..", "..");
    const outputPath = path.join(rootDir, "output", `${slug}.mp4`);

    if (fs.existsSync(outputPath)) {
      try {
        const stat = fs.statSync(outputPath);
        return {
          exists: true,
          slug,
          filePath: outputPath,
          fileSizeBytes: stat.size,
          lastModified: stat.mtime.toISOString(),
          videoUrl: `/api/rendered-video/${slug}`,
          downloadUrl: `/api/download/${slug}`,
        };
      } catch {}
    }

    return {
      exists: false,
      slug,
    };
  }

  startRender(slug: string): RenderTask {
    if (this.childProcess || (this.currentTask && this.currentTask.status === "running")) {
      this.stopCurrentTask();
    }

    const rootDir = path.resolve(__dirname, "..", "..");
    const dataDir = path.join(rootDir, "data", slug);
    const outputDir = path.join(rootDir, "output");
    const recordingPath = path.join(dataDir, "recording.mp4");
    const editPlanPath = path.join(dataDir, "edit-plan.json");

    // Pre-flight checks
    if (!fs.existsSync(dataDir)) {
      throw new Error(`시나리오 디렉토리 'data/${slug}'가 존재하지 않습니다.`);
    }
    if (!fs.existsSync(recordingPath)) {
      throw new Error(`녹화 파일 'data/${slug}/recording.mp4'가 없습니다. 먼저 녹화를 진행해주세요.`);
    }
    if (!fs.existsSync(editPlanPath)) {
      throw new Error(`줌 플랜 'data/${slug}/edit-plan.json'이 없습니다. 먼저 녹화 및 줌 생성을 완료해주세요.`);
    }

    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // 1. Sync Root.tsx to point to this slug
    setActiveSlug(slug);

    // 2. Ensure public/recording.mp4 is available for Remotion
    const publicRecording = path.join(rootDir, "public", "recording.mp4");
    try {
      fs.copyFileSync(recordingPath, publicRecording);
    } catch (e) {
      console.warn("public/recording.mp4 복사 경고:", e);
    }

    const outputFilePath = path.join(outputDir, `${slug}.mp4`);
    const taskId = "render-" + Date.now().toString(36);

    this.currentTask = {
      id: taskId,
      slug,
      status: "running",
      logs: [],
      startTime: Date.now(),
      outputFile: outputFilePath,
    };

    this.log(`🎞️ [Remotion 렌더러 시작] 시나리오 '${slug}' 최종 MP4 렌더링을 시작합니다.`);
    this.log(`  * 입력: data/${slug}/recording.mp4 + edit-plan.json (카메라 줌 + 마우스 모션그래픽)`);
    this.log(`  * 출력: output/${slug}.mp4`);

    // Run Remotion CLI: npx remotion render src/index.ts ScreenDemo output/<slug>.mp4 --gl=angle
    const args = [
      "remotion",
      "render",
      "src/index.ts",
      "ScreenDemo",
      `output/${slug}.mp4`,
      "--gl=angle",
    ];

    this.log(`  * 실행 커맨드: npx ${args.join(" ")}`);

    const child = spawn("npx", args, {
      cwd: rootDir,
      shell: true,
      env: { ...process.env, FORCE_COLOR: "1" },
    });

    this.childProcess = child;

    let isRenderingFrames = false;
    let lastLoggedPercent = -1;
    let lastLogTime = 0;
    let stdoutBuffer = "";

    child.stdout.on("data", (data) => {
      const rawText = data.toString("utf-8");
      stdoutBuffer += rawText;

      // Split by newline or carriage return (\r is heavily used by Remotion for in-place CLI progress)
      const chunks = stdoutBuffer.split(/[\r\n]+/);
      if (!rawText.endsWith("\n") && !rawText.endsWith("\r")) {
        stdoutBuffer = chunks.pop() || "";
      } else {
        stdoutBuffer = "";
      }

      for (const rawLine of chunks) {
        // Strip ANSI escape codes
        const line = rawLine.replace(/\u001b\[[0-9;]*[a-zA-Z]/g, "").trim();
        if (!line) continue;

        // Detect transition from bundling to actual video frame rendering
        if (line.includes("Composition ") || line.includes("Concurrency ") || line.includes("Codec ")) {
          isRenderingFrames = true;
          lastLoggedPercent = -1;
          this.log(line);
          continue;
        }

        // Check if line contains frame/percent progress indicators
        const percentMatch = line.match(/(\d+(?:\.\d+)?)%/);
        const frameMatch = line.match(/(\d+)\s*(?:\/|of)\s*(\d+)/i);

        if (isRenderingFrames && (frameMatch || percentMatch)) {
          let percent = 0;
          let currentFrame = 0;
          let totalFrames = 0;

          if (frameMatch) {
            currentFrame = parseInt(frameMatch[1], 10);
            totalFrames = parseInt(frameMatch[2], 10);
            if (totalFrames > 0) {
              percent = Math.round((currentFrame / totalFrames) * 100);
            }
          } else if (percentMatch) {
            percent = Math.round(parseFloat(percentMatch[1]));
          }

          if (this.currentTask) {
            this.currentTask.progressPercent = percent;
            if (currentFrame > 0) this.currentTask.currentFrame = currentFrame;
            if (totalFrames > 0) this.currentTask.totalFrames = totalFrames;
          }

          const now = Date.now();
          // Update in-place single-line progress smoothly: at least 1% change or every 500ms
          if (
            percent > lastLoggedPercent ||
            now - lastLogTime >= 500 ||
            percent === 100
          ) {
            lastLoggedPercent = percent;
            lastLogTime = now;
            const filled = Math.min(20, Math.max(0, Math.round((percent / 100) * 20)));
            const empty = 20 - filled;
            const bar = `[${"█".repeat(filled)}${"░".repeat(empty)}]`;
            const frameInfo = totalFrames > 0 ? ` (${currentFrame}/${totalFrames} frames)` : "";
            this.log(`🎞️ 비디오 프레임 렌더링: ${bar} ${percent}%${frameInfo}`, true);
          }
          continue;
        }

        // Before frame rendering (Webpack bundling progress): ignore raw percent lines to avoid false 100%
        if (!isRenderingFrames && percentMatch) {
          continue;
        }

        // Informational lines (bundling, audio, completion, etc.) are logged normally
        this.log(line);
      }
    });

    child.stderr.on("data", (data) => {
      const text = data.toString("utf-8");
      if (
        text.includes("ExperimentalWarning") ||
        text.includes("DeprecationWarning") ||
        text.includes("Debugger attached")
      ) {
        return;
      }

      const lines = text.split("\n");
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;
        if (
          line.includes("[Warn]") ||
          line.includes("WARNING") ||
          line.includes("⚠️") ||
          line.toLowerCase().startsWith("warning:")
        ) {
          this.log(`⚠️ ${line}`);
        } else if (
          line.includes("[ERR]") ||
          line.includes("Error:") ||
          line.includes("❌")
        ) {
          this.log(`[ERR] ${line}`);
        } else {
          this.log(line);
        }
      }
    });

    child.on("close", (code) => {
      if (!this.currentTask) return;
      if (this.currentTask.status === "stopped") {
        this.childProcess = null;
        return;
      }

      this.currentTask.endTime = Date.now();
      const elapsed = ((this.currentTask.endTime - this.currentTask.startTime) / 1000).toFixed(1);

      if (code === 0 && fs.existsSync(outputFilePath)) {
        const stat = fs.statSync(outputFilePath);
        const sizeMb = (stat.size / (1024 * 1024)).toFixed(2);
        this.currentTask.status = "completed";
        this.currentTask.progressPercent = 100;
        this.currentTask.outputSizeBytes = stat.size;
        this.log(`\n🎉 [렌더링 완료!] 최종 비디오 파일이 성공적으로 추출되었습니다!`);
        this.log(`  * 파일 경로: ${outputFilePath} (${sizeMb} MB)`);
        this.log(`  * 소요 시간: ${elapsed}초`);
        this.log(`  * 웹 대시보드에서 즉시 다운로드하거나 영상 플레이어에서 확인할 수 있습니다.`);
      } else {
        this.currentTask.status = "failed";
        this.currentTask.error = `종료 코드: ${code}`;
        this.log(`❌ [렌더링 실패] 렌더링 프로세스가 비정상 종료되었습니다 (코드 ${code}, 소요 시간: ${elapsed}초)`);
      }

      this.childProcess = null;
      this.emit("status", this.currentTask);
    });

    child.on("error", (err) => {
      if (!this.currentTask) return;
      this.currentTask.status = "failed";
      this.currentTask.error = err.message;
      this.log(`❌ [렌더러 프로세스 오류] ${err.message}`);
      this.childProcess = null;
      this.emit("status", this.currentTask);
    });

    return this.currentTask;
  }

  stopCurrentTask(): boolean {
    if (this.childProcess || (this.currentTask && this.currentTask.status === "running")) {
      const pid = this.childProcess?.pid;
      if (pid) {
        if (process.platform === "win32") {
          try {
            spawnSync("taskkill", ["/pid", pid.toString(), "/T", "/F"], { stdio: "ignore" });
          } catch (e) {
            console.error("taskkill error:", e);
          }
        } else {
          try {
            this.childProcess?.kill("SIGKILL");
          } catch {}
        }
      }

      if (this.currentTask) {
        this.currentTask.status = "stopped";
        this.currentTask.endTime = Date.now();
        this.log("⏹️ 사용자에 의해 비디오 렌더링 작업이 중단되었습니다.");
        this.emit("status", this.currentTask);
      }

      this.childProcess = null;
      return true;
    }
    return false;
  }

  private log(message: string, isProgress = false) {
    if (!this.currentTask) return;
    const lines = message.split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      if (isProgress) {
        const lastIdx = this.currentTask.logs.length - 1;
        if (
          lastIdx >= 0 &&
          (this.currentTask.logs[lastIdx].includes("비디오 프레임 렌더링:") ||
            this.currentTask.logs[lastIdx].includes("렌더링 진행:"))
        ) {
          this.currentTask.logs[lastIdx] = line;
        } else {
          this.currentTask.logs.push(line);
        }
        this.emit("log", { taskId: this.currentTask.id, line, isProgress: true });
      } else {
        this.currentTask.logs.push(line);
        this.emit("log", { taskId: this.currentTask.id, line, isProgress: false });
      }
    }
  }
}

export const renderRunner = new RenderRunner();

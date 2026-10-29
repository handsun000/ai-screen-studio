import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { EventEmitter } from "events";
import {
  computeTimeRegionsAndSyncCues,
  ensurePublicNarrationAssets,
  getNarration,
} from "./narrationService";
import type { EditPlan, MomentsFile, TimeRegion } from "../types";

export interface RenderOptions {
  fps?: 30 | 60;
}

export interface RenderTask {
  id: string;
  slug: string;
  fps: 30 | 60;
  status: "queued" | "running" | "completed" | "failed" | "stopped";
  logs: string[];
  progress?: number;
  progressPercent?: number;
  renderedFrames?: number;
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

function linkOrCopyFileSync(srcPath: string, destPath: string): void {
  if (!fs.existsSync(srcPath)) return;
  const destDir = path.dirname(destPath);
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }
  if (fs.existsSync(destPath)) {
    try {
      fs.unlinkSync(destPath);
    } catch {}
  }
  try {
    fs.linkSync(srcPath, destPath);
  } catch {
    fs.copyFileSync(srcPath, destPath);
  }
}

function getLatestMtimeMs(targetPath: string): number {
  if (!fs.existsSync(targetPath)) return 0;
  try {
    const stat = fs.statSync(targetPath);
    if (!stat.isDirectory()) {
      return stat.mtimeMs;
    }
    let maxMtime = stat.mtimeMs;
    for (const entry of fs.readdirSync(targetPath, { withFileTypes: true })) {
      if (entry.name === "services" || entry.name.startsWith(".")) continue;
      const childMtime = getLatestMtimeMs(path.join(targetPath, entry.name));
      if (childMtime > maxMtime) maxMtime = childMtime;
    }
    return maxMtime;
  } catch {
    return 0;
  }
}

export function scaleEditPlanForFps(
  rawEditPlan: EditPlan,
  momentsFile: MomentsFile,
  targetFps: 30 | 60
): EditPlan {
  const cloned: EditPlan = JSON.parse(JSON.stringify(rawEditPlan));
  const sourceFps = Math.max(1, Number(cloned.fps) || 60);
  const scale = targetFps / sourceFps;

  const rawTotalMs =
    momentsFile?.metadata?.totalDurationMs && momentsFile.metadata.totalDurationMs > 0
      ? Math.round(momentsFile.metadata.totalDurationMs)
      : Math.max(
          1000,
          Math.round(((cloned.rawDurationFrames || cloned.totalDurationFrames || sourceFps * 10) / sourceFps) * 1000)
        );

  if (Array.isArray(cloned.segments)) {
    cloned.segments = cloned.segments.map((seg) => {
      const startFrame = Math.max(0, Math.round(Number(seg.startFrame || 0) * scale));
      const endFrame = Math.max(startFrame + 1, Math.round(Number(seg.endFrame || 0) * scale));
      return {
        ...seg,
        startFrame,
        endFrame,
      };
    });
  }

  cloned.fps = targetFps;

  if (cloned.narration && Array.isArray(cloned.narration.cues) && cloned.narration.cues.length > 0) {
    const { timeRegions, totalCompFrames, rawTotalFrames } = computeTimeRegionsAndSyncCues(
      cloned.narration.cues,
      rawTotalMs,
      targetFps
    );
    cloned.timeRegions = timeRegions;
    cloned.totalDurationFrames = totalCompFrames;
    cloned.rawDurationFrames = rawTotalFrames;
  } else if (Array.isArray(cloned.timeRegions) && cloned.timeRegions.length > 0) {
    let compCursor = 0;
    let videoCursor = 0;
    const scaledRegions: TimeRegion[] = [];
    for (const r of cloned.timeRegions) {
      const vStart = scaledRegions.length === 0 ? Math.max(0, Math.round(r.videoStartFrame * scale)) : videoCursor;
      const vEnd = Math.max(vStart + 1, Math.round(r.videoEndFrame * scale));
      const cStart = scaledRegions.length === 0 ? Math.max(0, Math.round(r.compStartFrame * scale)) : compCursor;
      const cEnd = Math.max(cStart + 1, Math.round(r.compEndFrame * scale));
      const rawFrames = Math.max(1, vEnd - vStart);
      const compFrames = Math.max(1, cEnd - cStart);
      scaledRegions.push({
        videoStartFrame: vStart,
        videoEndFrame: vEnd,
        compStartFrame: cStart,
        compEndFrame: cEnd,
        speed: Number((rawFrames / compFrames).toFixed(5)),
        cueId: r.cueId,
      });
      videoCursor = vEnd;
      compCursor = cEnd;
    }
    cloned.timeRegions = scaledRegions;
    cloned.rawDurationFrames = Math.max(1, videoCursor);
    cloned.totalDurationFrames = Math.max(1, compCursor);
  } else {
    const totalFrames = Math.max(1, Math.round((rawTotalMs / 1000) * targetFps));
    cloned.rawDurationFrames = totalFrames;
    cloned.totalDurationFrames = totalFrames;
  }

  return cloned;
}

class RenderRunner extends EventEmitter {
  private currentTask: RenderTask | null = null;
  private queue: RenderTask[] = [];
  private recentTasksBySlug = new Map<string, RenderTask>();
  private childProcess: ChildProcessWithoutNullStreams | null = null;
  private bundlePromise: Promise<string> | null = null;

  getCurrentTask(): RenderTask | null {
    return this.currentTask;
  }

  getQueue(): RenderTask[] {
    return [...this.queue];
  }

  getTaskForSlug(slug: string): RenderTask | null {
    if (this.currentTask && this.currentTask.slug === slug) {
      return this.currentTask;
    }
    const queued = this.queue.find((q) => q.slug === slug);
    if (queued) return queued;
    return this.recentTasksBySlug.get(slug) || null;
  }

  getAllActiveAndQueuedTasks(): { currentTask: RenderTask | null; queue: RenderTask[] } {
    return {
      currentTask: this.currentTask,
      queue: [...this.queue],
    };
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

  startRender(slug: string, options?: RenderOptions): RenderTask {
    const rootDir = path.resolve(__dirname, "..", "..");
    const dataDir = path.join(rootDir, "data", slug);
    const outputDir = path.join(rootDir, "output");
    const recordingPath = path.join(dataDir, "recording.mp4");
    const editPlanPath = path.join(dataDir, "edit-plan.json");

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

    const targetFps: 30 | 60 = options?.fps === 60 ? 60 : 30;

    // If this exact slug is already running, return it (or if queued, update its fps)
    if (this.currentTask && this.currentTask.status === "running" && this.currentTask.slug === slug) {
      return this.currentTask;
    }
    const existingQueued = this.queue.find((q) => q.slug === slug);
    if (existingQueued) {
      existingQueued.fps = targetFps;
      this.emit("status", existingQueued);
      return existingQueued;
    }

    const outputFilePath = path.join(outputDir, `${slug}.mp4`);
    const taskId = "render-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6);

    const task: RenderTask = {
      id: taskId,
      slug,
      fps: targetFps,
      status: this.currentTask && this.currentTask.status === "running" ? "queued" : "running",
      logs: [],
      progress: 0,
      progressPercent: 0,
      renderedFrames: 0,
      currentFrame: 0,
      totalFrames: 0,
      startTime: Date.now(),
      outputFile: outputFilePath,
    };

    this.recentTasksBySlug.set(slug, task);

    if (task.status === "queued") {
      this.queue.push(task);
      this.logForTask(
        task,
        `🕒 [렌더링 대기열 등록] '${slug}' (${targetFps}fps) 작업이 대기열(#${this.queue.length})에 추가되었습니다.`
      );
      this.emit("status", task);
      return task;
    }

    this.currentTask = task;
    this.emit("status", task);
    void this.executeTask(task);
    return task;
  }

  private async getOrBuildRemotionBundle(rootDir: string, task: RenderTask): Promise<string> {
    if (this.bundlePromise) {
      return this.bundlePromise;
    }

    this.bundlePromise = (async () => {
      const cacheRoot = path.join(rootDir, "node_modules", ".cache");
      const bundleDir = path.join(cacheRoot, "screen-demo-remotion-bundle");
      const metaPath = path.join(bundleDir, ".bundle-meta.json");
      const indexHtmlPath = path.join(bundleDir, "index.html");
      const bundleJsPath = path.join(bundleDir, "bundle.js");

      const srcDir = path.join(rootDir, "src");
      const latestSrcMtime = Math.round(getLatestMtimeMs(srcDir));

      let cacheValid = false;
      if (fs.existsSync(indexHtmlPath) && fs.existsSync(bundleJsPath) && fs.existsSync(metaPath)) {
        try {
          const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
          if (meta && meta.latestSrcMtime === latestSrcMtime) {
            cacheValid = true;
          }
        } catch {}
      }

      if (!cacheValid) {
        this.logForTask(task, `⚡ [Webpack 번들 캐시 생성] Remotion 컴포지션 번들을 빌드합니다 (최초 1회)...`);
        const t0 = Date.now();
        if (fs.existsSync(bundleDir)) {
          try {
            fs.rmSync(bundleDir, { recursive: true, force: true });
          } catch {}
        }
        fs.mkdirSync(bundleDir, { recursive: true });

        // Dynamic require of @remotion/bundler to build reusable bundle directory
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { bundle } = require("@remotion/bundler");
        await bundle({
          entryPoint: path.join(rootDir, "src", "index.ts"),
          outDir: bundleDir,
          publicDir: path.join(rootDir, "public"),
        });

        fs.writeFileSync(
          metaPath,
          JSON.stringify({ latestSrcMtime, builtAt: new Date().toISOString() }, null, 2),
          "utf-8"
        );
        this.logForTask(
          task,
          `✅ [번들 캐시 준비 완료] ${((Date.now() - t0) / 1000).toFixed(1)}초 소요 (이후 렌더링은 0초 즉시 재사용)`
        );
      }

      // Ensure static sfx assets exist in bundleDir/public/sfx
      const srcSfxDir = path.join(rootDir, "public", "sfx");
      const destSfxDir = path.join(bundleDir, "public", "sfx");
      if (fs.existsSync(srcSfxDir)) {
        fs.mkdirSync(destSfxDir, { recursive: true });
        for (const f of fs.readdirSync(srcSfxDir)) {
          const dst = path.join(destSfxDir, f);
          if (!fs.existsSync(dst)) {
            linkOrCopyFileSync(path.join(srcSfxDir, f), dst);
          }
        }
      }

      return bundleDir;
    })();

    try {
      return await this.bundlePromise;
    } finally {
      this.bundlePromise = null;
    }
  }

  private runPythonAsync(rootDir: string, scriptArgs: string[]): Promise<void> {
    return new Promise((resolve) => {
      const proc = spawn("python", scriptArgs, {
        cwd: rootDir,
        stdio: "ignore",
      });
      proc.on("close", () => resolve());
      proc.on("error", () => resolve());
    });
  }

  private async executeTask(task: RenderTask): Promise<void> {
    const { slug, fps: targetFps } = task;
    const rootDir = path.resolve(__dirname, "..", "..");
    const dataDir = path.join(rootDir, "data", slug);
    const recordingPath = path.join(dataDir, "recording.mp4");
    const momentsPath = path.join(dataDir, "moments.json");
    const editPlanPath = path.join(dataDir, "edit-plan.json");
    const outputFilePath = task.outputFile || path.join(rootDir, "output", `${slug}.mp4`);

    let bundleDir = "";
    const stageFolderName = `${slug}-${task.id}`;
    const propsFilePath = path.join(dataDir, `.render-props-${task.id}.json`);

    try {
      task.startTime = Date.now();
      this.logForTask(
        task,
        `🎞️ [백그라운드 렌더러 시작] '${slug}' 최종 MP4 렌더링 (${targetFps}fps · 완전 격리 모드)`
      );

      // 1. Check if moments.json is already calibrated; only run calibrate-moments.py asynchronously if needed
      let needsCalibration = true;
      if (fs.existsSync(momentsPath) && fs.existsSync(editPlanPath)) {
        try {
          const mData = JSON.parse(fs.readFileSync(momentsPath, "utf-8"));
          if (
            mData?.metadata?.calibratedToVideoDurationMs &&
            mData.metadata.calibratedToVideoDurationMs === mData.metadata.totalDurationMs
          ) {
            needsCalibration = false;
          }
        } catch {}
      }

      if (needsCalibration) {
        this.logForTask(task, `  * 프레임 타임스탬프 자동 보정 확인 중...`);
        await this.runPythonAsync(rootDir, ["scripts/calibrate-moments.py", slug]);
      }

      if ((task.status as string) === "stopped") return;

      // 2. Ensure narration audio files exist if narration.json has cues
      try {
        const existingNarration = getNarration(slug);
        if (existingNarration && existingNarration.cues?.length) {
          const missingAudio = existingNarration.cues.some(
            (c) => !c.audioFile || !fs.existsSync(path.join(rootDir, "public", c.audioFile))
          );
          if (missingAudio) {
            const ttsArgs = ["scripts/synthesize-tts.py", slug];
            if (existingNarration.voice) ttsArgs.push("--voice", existingNarration.voice);
            if (existingNarration.rate) ttsArgs.push("--rate", existingNarration.rate);
            if (existingNarration.pitch) ttsArgs.push("--pitch", existingNarration.pitch);
            await this.runPythonAsync(rootDir, ttsArgs);
          } else {
            ensurePublicNarrationAssets(slug);
          }
        }
      } catch (e) {
        console.warn("나레이션 오디오 에셋 동기화 경고:", e);
      }

      if ((task.status as string) === "stopped") return;

      // 3. Get or build cached Remotion bundle (0ms on cache hit)
      bundleDir = await this.getOrBuildRemotionBundle(rootDir, task);

      if ((task.status as string) === "stopped") return;

      // 4. Stage isolated scenario video & narration assets into bundleDir/public and rootDir/public via NTFS hardlinks (0ms)
      const videoRelPath = `renders/${stageFolderName}/recording.mp4`;
      const publicStageVideo = path.join(rootDir, "public", "renders", stageFolderName, "recording.mp4");
      const bundleStageVideo = path.join(bundleDir, "public", "renders", stageFolderName, "recording.mp4");
      linkOrCopyFileSync(recordingPath, publicStageVideo);
      linkOrCopyFileSync(recordingPath, bundleStageVideo);

      const srcAudioDir = path.join(dataDir, "audio");
      if (fs.existsSync(srcAudioDir)) {
        const publicNarrDir = path.join(rootDir, "public", "narration", slug);
        const bundleNarrDir = path.join(bundleDir, "public", "narration", slug);
        fs.mkdirSync(publicNarrDir, { recursive: true });
        fs.mkdirSync(bundleNarrDir, { recursive: true });
        for (const f of fs.readdirSync(srcAudioDir)) {
          if (f.endsWith(".mp3")) {
            const srcMp3 = path.join(srcAudioDir, f);
            linkOrCopyFileSync(srcMp3, path.join(publicNarrDir, f));
            linkOrCopyFileSync(srcMp3, path.join(bundleNarrDir, f));
          }
        }
      }

      // 5. Build isolated inputProps JSON scaled to targetFps (30fps or 60fps) without touching src/Root.tsx
      const rawEditPlan: EditPlan = JSON.parse(fs.readFileSync(editPlanPath, "utf-8"));
      const momentsFile: MomentsFile = fs.existsSync(momentsPath)
        ? JSON.parse(fs.readFileSync(momentsPath, "utf-8"))
        : {
            metadata: {
              url: "",
              viewportWidth: 1920,
              viewportHeight: 1080,
              totalDurationMs: 10000,
              recordingStart: new Date().toISOString(),
            },
            moments: [],
          };

      const scaledEditPlan = scaleEditPlanForFps(rawEditPlan, momentsFile, targetFps);
      task.totalFrames = scaledEditPlan.totalDurationFrames;

      const inputProps = {
        editPlan: scaledEditPlan,
        moments: momentsFile,
        videoFileName: videoRelPath,
        showCursor: true,
        showSfx: false,
      };
      fs.writeFileSync(propsFilePath, JSON.stringify(inputProps), "utf-8");

      const cpuThreads = os.cpus()?.length || 8;
      const concurrency = Math.max(4, Math.min(8, Math.floor(cpuThreads * 0.7)));
      const remotionCliPath = path.join(rootDir, "node_modules", "@remotion", "cli", "remotion-cli.js");

      const cliArgs = [
        remotionCliPath,
        "render",
        bundleDir,
        "ScreenDemo",
        `output/${slug}.mp4`,
        `--props=${propsFilePath}`,
        "--gl=angle",
        `--concurrency=${concurrency}`,
        "--image-format=jpeg",
        "--jpeg-quality=85",
        "--x264-preset=veryfast",
        "--overwrite",
      ];

      this.logForTask(
        task,
        `  * 설정: ${targetFps}fps (총 ${scaledEditPlan.totalDurationFrames}프레임) · 멀티코어 ${concurrency}스레드 · JPEG/veryfast 가속`
      );
      this.emit("status", task);

      const cleanupStaging = () => {
        try {
          if (fs.existsSync(propsFilePath)) {
            fs.unlinkSync(propsFilePath);
          }
        } catch {}
        try {
          const pubStageDir = path.join(rootDir, "public", "renders", stageFolderName);
          if (fs.existsSync(pubStageDir)) {
            fs.rmSync(pubStageDir, { recursive: true, force: true });
          }
        } catch {}
        try {
          if (bundleDir) {
            const bdlStageDir = path.join(bundleDir, "public", "renders", stageFolderName);
            if (fs.existsSync(bdlStageDir)) {
              fs.rmSync(bdlStageDir, { recursive: true, force: true });
            }
          }
        } catch {}
      };

      await new Promise<void>((resolve) => {
        const child = spawn(process.execPath, cliArgs, {
          cwd: rootDir,
          shell: false,
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

          const chunks = stdoutBuffer.split(/[\r\n]+/);
          if (!rawText.endsWith("\n") && !rawText.endsWith("\r")) {
            stdoutBuffer = chunks.pop() || "";
          } else {
            stdoutBuffer = "";
          }

          for (const rawLine of chunks) {
            const line = rawLine.replace(/\u001b\[[0-9;]*[a-zA-Z]/g, "").trim();
            if (!line) continue;

            if (line.includes("Composition ") || line.includes("Concurrency ") || line.includes("Codec ")) {
              isRenderingFrames = true;
              lastLoggedPercent = -1;
              this.logForTask(task, line);
              continue;
            }

            const percentMatch = line.match(/(\d+(?:\.\d+)?)%/);
            const frameMatch = line.match(/(\d+)\s*(?:\/|of)\s*(\d+)/i);

            if (isRenderingFrames && (frameMatch || percentMatch)) {
              let percent = 0;
              let currentFrame = 0;
              let totalFrames = task.totalFrames || 0;

              if (frameMatch) {
                currentFrame = parseInt(frameMatch[1], 10);
                totalFrames = parseInt(frameMatch[2], 10);
                if (totalFrames > 0) {
                  percent = Math.round((currentFrame / totalFrames) * 100);
                }
              } else if (percentMatch) {
                percent = Math.round(parseFloat(percentMatch[1]));
              }

              task.progress = percent;
              task.progressPercent = percent;
              if (currentFrame > 0) {
                task.renderedFrames = currentFrame;
                task.currentFrame = currentFrame;
              }
              if (totalFrames > 0) task.totalFrames = totalFrames;

              const now = Date.now();
              if (percent > lastLoggedPercent || now - lastLogTime >= 450 || percent === 100) {
                lastLoggedPercent = percent;
                lastLogTime = now;
                const filled = Math.min(20, Math.max(0, Math.round((percent / 100) * 20)));
                const empty = 20 - filled;
                const bar = `[${"█".repeat(filled)}${"░".repeat(empty)}]`;
                const frameInfo = totalFrames > 0 ? ` (${currentFrame}/${totalFrames}f · ${targetFps}fps)` : "";
                this.logForTask(task, `🎞️ [${slug}] 렌더링: ${bar} ${percent}%${frameInfo}`, true);
                this.emit("progress", task);
              }
              continue;
            }

            if (!isRenderingFrames && percentMatch) {
              continue;
            }

            this.logForTask(task, line);
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
              this.logForTask(task, `⚠️ ${line}`);
            } else if (line.includes("[ERR]") || line.includes("Error:") || line.includes("❌")) {
              this.logForTask(task, `[ERR] ${line}`);
            } else {
              this.logForTask(task, line);
            }
          }
        });

        child.on("close", (code) => {
          this.childProcess = null;
          cleanupStaging();
          if (task.status === "stopped") {
            resolve();
            return;
          }

          task.endTime = Date.now();
          const elapsed = ((task.endTime - task.startTime) / 1000).toFixed(1);

          if (code === 0 && fs.existsSync(outputFilePath)) {
            const stat = fs.statSync(outputFilePath);
            const sizeMb = (stat.size / (1024 * 1024)).toFixed(2);
            task.status = "completed";
            task.progress = 100;
            task.progressPercent = 100;
            if (task.totalFrames) {
              task.renderedFrames = task.totalFrames;
              task.currentFrame = task.totalFrames;
            }
            task.outputSizeBytes = stat.size;
            this.logForTask(
              task,
              `\n🎉 [렌더링 완료!] '${slug}' 최종 MP4 파일 생성 완료 (${sizeMb}MB, ${targetFps}fps, 소요 시간: ${elapsed}초)`
            );
          } else {
            task.status = "failed";
            task.error = `종료 코드: ${code}`;
            this.logForTask(
              task,
              `❌ [렌더링 실패] '${slug}' 프로세스가 비정상 종료되었습니다 (코드 ${code}, 소요 시간: ${elapsed}초)`
            );
          }

          this.emit("status", task);
          resolve();
        });

        child.on("error", (err) => {
          this.childProcess = null;
          cleanupStaging();
          if (task.status !== "stopped") {
            task.status = "failed";
            task.error = err.message;
            task.endTime = Date.now();
            this.logForTask(task, `❌ [렌더러 프로세스 오류] ${err.message}`);
            this.emit("status", task);
          }
          resolve();
        });
      });
    } catch (err: any) {
      if (task.status !== "stopped") {
        task.status = "failed";
        task.error = err?.message || String(err);
        task.endTime = Date.now();
        this.logForTask(task, `❌ [렌더링 준비 오류] ${task.error}`);
        this.emit("status", task);
      }
    } finally {
      // Clean up temporary isolated staging files immediately
      try {
        if (fs.existsSync(propsFilePath)) {
          fs.unlinkSync(propsFilePath);
        }
      } catch {}
      try {
        const pubStageDir = path.join(rootDir, "public", "renders", stageFolderName);
        if (fs.existsSync(pubStageDir)) {
          fs.rmSync(pubStageDir, { recursive: true, force: true });
        }
      } catch {}
      try {
        if (bundleDir) {
          const bdlStageDir = path.join(bundleDir, "public", "renders", stageFolderName);
          if (fs.existsSync(bdlStageDir)) {
            fs.rmSync(bdlStageDir, { recursive: true, force: true });
          }
        }
      } catch {}

      // Advance to next queued render task if any
      if (this.queue.length > 0) {
        const nextTask = this.queue.shift()!;
        nextTask.status = "running";
        this.currentTask = nextTask;
        this.emit("status", nextTask);
        void this.executeTask(nextTask);
      }
    }
  }

  stopCurrentTask(slug?: string): boolean {
    // 1. If a specific slug is requested and it's in the waiting queue, remove only that queued item
    if (slug) {
      const qIdx = this.queue.findIndex((q) => q.slug === slug);
      if (qIdx >= 0) {
        const [removed] = this.queue.splice(qIdx, 1);
        removed.status = "stopped";
        removed.endTime = Date.now();
        this.logForTask(removed, `⏹️ '${slug}' 렌더링 대기열 작업이 취소되었습니다.`);
        this.emit("status", removed);
        return true;
      }
      if (this.currentTask && this.currentTask.slug !== slug) {
        return false;
      }
    } else {
      // If stopping all without slug, clear waiting queue too
      while (this.queue.length > 0) {
        const q = this.queue.shift()!;
        q.status = "stopped";
        q.endTime = Date.now();
        this.emit("status", q);
      }
    }

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
        this.logForTask(this.currentTask, `⏹️ 사용자에 의해 '${this.currentTask.slug}' 비디오 렌더링이 중단되었습니다.`);
        this.emit("status", this.currentTask);
      }

      this.childProcess = null;
      return true;
    }
    return false;
  }

  private logForTask(task: RenderTask, message: string, isProgress = false) {
    const lines = message.split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      if (isProgress) {
        const lastIdx = task.logs.length - 1;
        if (
          lastIdx >= 0 &&
          (task.logs[lastIdx].includes("렌더링:") ||
            task.logs[lastIdx].includes("비디오 프레임 렌더링:") ||
            task.logs[lastIdx].includes("렌더링 진행:"))
        ) {
          task.logs[lastIdx] = line;
        } else {
          task.logs.push(line);
        }
        this.emit("log", {
          taskId: task.id,
          slug: task.slug,
          line,
          isProgress: true,
          percent: task.progress ?? task.progressPercent ?? 0,
          renderedFrames: task.renderedFrames ?? task.currentFrame ?? 0,
          totalFrames: task.totalFrames ?? 0,
          task,
        });
      } else {
        task.logs.push(line);
        this.emit("log", { taskId: task.id, slug: task.slug, line, isProgress: false, task });
      }
    }
  }
}

export const renderRunner = new RenderRunner();

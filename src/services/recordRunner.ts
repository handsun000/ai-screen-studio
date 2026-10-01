import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "child_process";
import * as path from "path";
import { EventEmitter } from "events";

export interface RecordTask {
  id: string;
  slug: string;
  status: "running" | "completed" | "failed" | "stopped";
  logs: string[];
  startTime: number;
  endTime?: number;
  error?: string;
}

class RecordRunner extends EventEmitter {
  private currentTask: RecordTask | null = null;
  private childProcess: ChildProcessWithoutNullStreams | null = null;

  getCurrentTask(): RecordTask | null {
    return this.currentTask;
  }

  startRecord(slug: string, options: { headed?: boolean; login?: boolean } = {}): RecordTask {
    // 1. Forcefully kill any previous running task or child process to prevent zombie duplicates
    if (this.childProcess || (this.currentTask && this.currentTask.status === "running")) {
      this.stopCurrentTask();
    }

    const taskId = "task-" + Date.now().toString(36);
    this.currentTask = {
      id: taskId,
      slug,
      status: "running",
      logs: [],
      startTime: Date.now(),
    };

    // Default to headed mode (visible browser) unless explicitly set to false
    const isHeaded = options.headed !== false;
    const args = ["scripts/record.ts", slug];
    if (isHeaded) {
      args.push("--headed");
    } else {
      args.push("--headless");
    }
    if (options.login) args.push("--login");

    const rootDir = path.resolve(__dirname, "..", "..");
    this.log(`🚀 [시작] '${slug}' 자동 녹화 및 후가공 파이프라인 시작 (tsx ${args.join(" ")})`);

    const child = spawn("npx", ["tsx", ...args], {
      cwd: rootDir,
      shell: true,
      env: { ...process.env, FORCE_COLOR: "1" },
    });

    this.childProcess = child;

    child.stdout.on("data", (data) => {
      const text = data.toString("utf-8");
      this.log(text.trimEnd());
    });

    child.stderr.on("data", (data) => {
      const text = data.toString("utf-8");
      if (
        text.includes("ExperimentalWarning") ||
        text.includes("DeprecationWarning") ||
        text.includes("Debugger attached") ||
        text.includes("libva error")
      ) {
        return;
      }

      const lines = text.split("\n");
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;

        // Categorize stderr lines properly so non-fatal warnings do not show as red errors
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
          line.includes("❌") ||
          line.includes("Timeout") ||
          line.includes("Exception")
        ) {
          this.log(line.startsWith("[ERR]") ? line : `[ERR] ${line}`);
        } else {
          // Standard info/diagnostic line
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

      if (code === 0) {
        this.currentTask.status = "completed";
        this.log(`✅ [완료] 녹화 및 줌 플랜 생성이 성공적으로 완료되었습니다! (소요 시간: ${elapsed}초)`);
      } else {
        this.currentTask.status = "failed";
        this.currentTask.error = `종료 코드: ${code}`;
        this.log(`❌ [오류] 프로세스가 비정상 종료되었습니다 (코드 ${code}, 소요 시간: ${elapsed}초)`);
      }

      this.childProcess = null;
      this.emit("status", this.currentTask);
    });

    child.on("error", (err) => {
      if (!this.currentTask) return;
      this.currentTask.status = "failed";
      this.currentTask.error = err.message;
      this.log(`❌ [프로세스 오류] ${err.message}`);
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
            // Forcefully terminate the entire process tree on Windows (/T = tree, /F = forceful)
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
        this.log("⏹️ 사용자에 의해 녹화 작업이 완전히 중단되었습니다.");
        this.emit("status", this.currentTask);
      }

      this.childProcess = null;
      return true;
    }
    return false;
  }

  sendInput(input: string = "\n"): boolean {
    if (this.childProcess && this.childProcess.stdin && !this.childProcess.stdin.destroyed) {
      const data = input.endsWith("\n") ? input : input + "\n";
      this.childProcess.stdin.write(data);
      this.log(`> [Enter / 입력 전송] ${input.trim() || "⏎ (Enter)"}`);
      return true;
    }
    return false;
  }

  private log(message: string) {
    if (!this.currentTask) return;
    const lines = message.split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      this.currentTask.logs.push(line);
      this.emit("log", { taskId: this.currentTask.id, line });
    }
  }
}

export const recordRunner = new RecordRunner();

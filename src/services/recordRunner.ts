import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
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
    if (this.currentTask && this.currentTask.status === "running") {
      throw new Error(`이미 '${this.currentTask.slug}' 작업이 실행 중입니다.`);
    }

    const taskId = "task-" + Date.now().toString(36);
    this.currentTask = {
      id: taskId,
      slug,
      status: "running",
      logs: [],
      startTime: Date.now(),
    };

    const args = ["scripts/record.ts", slug];
    if (options.headed) args.push("--headed");
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
      this.log(`[ERR] ${text.trimEnd()}`);
    });

    child.on("close", (code) => {
      if (!this.currentTask) return;
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
    if (this.childProcess && this.currentTask?.status === "running") {
      this.childProcess.kill("SIGTERM");
      this.currentTask.status = "stopped";
      this.currentTask.endTime = Date.now();
      this.log("⏹️ 사용자에 의해 녹화 작업이 중단되었습니다.");
      this.emit("status", this.currentTask);
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

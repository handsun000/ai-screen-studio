import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawn, execSync } from "child_process";
import { GoogleGenAI } from "@google/genai";
import { getConfig, AiExecutionMode, AiCliProvider } from "./configManager";
import { recordAiUsage } from "./aiUsageTracker";

export interface CliModelOption {
  id: string;
  label: string;
}

export interface AvailableCliInfo {
  id: AiCliProvider;
  name: string;
  installed: boolean;
  binaryPath: string;
  models: CliModelOption[];
  note: string;
}

export interface GenerateAiOptions {
  feature: string;
  prompt: string;
  systemInstruction?: string;
  imagesBase64?: Array<{ mimeType: string; data: string }>;
  temperature?: number;
  jsonMode?: boolean;
  slug?: string;
  forceMode?: AiExecutionMode;
  cliProviderOverride?: AiCliProvider;
  cliModelOverride?: string;
  timeoutMs?: number;
}

export interface GenerateAiResult {
  text: string;
  modelUsed: string;
  mode: AiExecutionMode;
  usageMetadata?: any;
}

export function getGeminiApiKeys(): string[] {
  const keys: string[] = [];
  if (process.env.GEMINI_API_KEYS) {
    keys.push(
      ...process.env.GEMINI_API_KEYS.split(",")
        .map((k) => k.trim())
        .filter(Boolean)
    );
  }
  if (process.env.GEMINI_API_KEY) {
    const primary = process.env.GEMINI_API_KEY.trim();
    if (primary && !keys.includes(primary)) {
      keys.unshift(primary);
    }
  }
  for (let i = 2; i <= 10; i++) {
    const extra = process.env[`GEMINI_API_KEY_${i}`]?.trim();
    if (extra && !keys.includes(extra)) {
      keys.push(extra);
    }
  }
  return keys;
}

export function normalizeApiModelId(configured: string): string {
  const m = (configured || "").trim();
  if (!m || m === "gemini-3.8-flash" || m === "gemini-3-flash") {
    return "gemini-3.1-flash-lite-preview";
  }
  return m;
}

function findExecutablePath(candidates: string[], whichName: string): string {
  for (const c of candidates) {
    if (c && fs.existsSync(c)) {
      return c;
    }
  }
  try {
    const cmd = process.platform === "win32" ? `where.exe ${whichName}` : `which ${whichName}`;
    const out = execSync(cmd, { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 2500 }).trim();
    const firstLine = out.split(/\r?\n/)[0]?.trim();
    if (firstLine && fs.existsSync(firstLine)) {
      return firstLine;
    }
  } catch {
    // ignore
  }
  return "";
}

let cachedClis: AvailableCliInfo[] | null = null;
let cachedClisAt = 0;

export function detectAvailableClis(forceRefresh = false): AvailableCliInfo[] {
  const now = Date.now();
  if (!forceRefresh && cachedClis && now - cachedClisAt < 30_000) {
    return cachedClis;
  }

  const home = os.homedir();
  const localAppData = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");

  const agyPath = findExecutablePath(
    [
      path.join(localAppData, "agy", "bin", "agy.exe"),
      path.join(localAppData, "Programs", "Antigravity", "bin", "agy.exe"),
    ],
    "agy"
  );

  const claudePath = findExecutablePath(
    [
      path.join(home, ".local", "bin", "claude.exe"),
      path.join(appData, "npm", "claude.cmd"),
    ],
    "claude"
  );

  const geminiPath = findExecutablePath(
    [
      path.join(appData, "npm", "gemini.cmd"),
      path.join(localAppData, "npm", "gemini.cmd"),
    ],
    "gemini"
  );

  cachedClis = [
    {
      id: "agy",
      name: "Antigravity CLI (agy)",
      installed: Boolean(agyPath),
      binaryPath: agyPath,
      models: [
        { id: "gemini-3.8-flash-low", label: "Gemini 3.8 Flash (Low · 초고속 추천)" },
        { id: "gemini-3.8-flash-medium", label: "Gemini 3.8 Flash (Medium · 균형)" },
        { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High · 정밀)" },
        { id: "gemini-4-argon-low", label: "Gemini 4 Argon (Low · 고속)" },
        { id: "gemini-4-argon-medium", label: "Gemini 4 Argon (Medium · 고성능)" },
        { id: "claude-sonnet-5-5-medium", label: "Claude Sonnet 5.5 (Medium)" },
      ],
      note: "Google Antigravity 로그인 세션 사용 (API 키 불필요 · 요금 ₩0)",
    },
    {
      id: "claude",
      name: "Claude Code CLI (claude)",
      installed: Boolean(claudePath),
      binaryPath: claudePath,
      models: [
        { id: "default", label: "Claude 기본 모델 (Default)" },
        { id: "sonnet", label: "Claude Sonnet (표준)" },
        { id: "haiku", label: "Claude Haiku (초고속)" },
        { id: "opus", label: "Claude Opus (최고성능)" },
      ],
      note: "Claude Code 로그인 구독 세션 사용 (API 키 불필요 · 요금 ₩0)",
    },
    {
      id: "gemini",
      name: "Google Gemini CLI (gemini)",
      installed: Boolean(geminiPath),
      binaryPath: geminiPath,
      models: [
        { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
        { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
      ],
      note: "Google Workspace 엔터프라이즈 계정 전용 (개인 계정은 Antigravity CLI 사용)",
    },
  ];
  cachedClisAt = now;
  return cachedClis;
}

/**
 * Strips markdown code fences and extracts clean JSON when jsonMode is requested.
 */
export function cleanJsonResponse(raw: string): string {
  let trimmed = String(raw || "").trim();
  if (!trimmed) return "";

  // Strip ```json ... ``` fences if present
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch && fenceMatch[1]) {
    trimmed = fenceMatch[1].trim();
  }

  // Find outermost JSON object or array if there is leading/trailing commentary
  const firstBrace = trimmed.indexOf("{");
  const firstBracket = trimmed.indexOf("[");
  let startIdx = -1;
  let endChar = "}";

  if (firstBrace >= 0 && (firstBracket < 0 || firstBrace < firstBracket)) {
    startIdx = firstBrace;
    endChar = "}";
  } else if (firstBracket >= 0) {
    startIdx = firstBracket;
    endChar = "]";
  }

  if (startIdx >= 0) {
    const endIdx = trimmed.lastIndexOf(endChar);
    if (endIdx > startIdx) {
      return trimmed.slice(startIdx, endIdx + 1).trim();
    }
  }

  return trimmed;
}

function buildCliPromptString(options: GenerateAiOptions): string {
  const parts: string[] = [];

  parts.push(
    "[중요 실행 규칙: 파일 읽기/쓰기, 디렉터리 탐색, 터미널 명령 실행 등 어떠한 도구(Tool)도 절대 호출하지 마십시오. 오직 아래 주어진 텍스트 정보만 분석하여 즉시 텍스트로 답변하십시오.]"
  );

  if (options.jsonMode) {
    parts.push(
      "[JSON 출력 규칙: 마크다운 코드블록(```json)이나 인사말, 부연 설명 없이 오직 유효한 순수 JSON 문자열만 즉시 출력하십시오.]"
    );
  }

  if (options.systemInstruction) {
    parts.push(`=== 시스템 지침 (System Instruction) ===\n${options.systemInstruction.trim()}`);
  }

  parts.push(`=== 사용자 요청 (Prompt) ===\n${options.prompt.trim()}`);

  return parts.join("\n\n");
}

async function spawnAgyCli(
  binaryPath: string,
  model: string,
  fullPrompt: string,
  timeoutMs: number
): Promise<{ text: string; usage?: any }> {
  const effectiveModel = model && model !== "default" ? model : "gemini-3.8-flash-low";
  const args = [
    "--model",
    effectiveModel,
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--disable-slash-commands",
    "-p=",
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(binaryPath, args, {
      cwd: os.tmpdir(),
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdoutBuf = "";
    let stderrBuf = "";
    let finished = false;

    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      try {
        child.kill();
      } catch {}
      reject(new Error(`Antigravity CLI (agy) 응답 시간 초과 (${Math.round(timeoutMs / 1000)}s)`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdoutBuf += chunk.toString("utf-8");
    });

    child.stderr.on("data", (chunk) => {
      stderrBuf += chunk.toString("utf-8");
    });

    child.on("error", (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);

      const lines = stdoutBuf
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);

      let resultResponse = "";
      let assistantFallback = "";
      let usage: any = undefined;
      let errorDetail = "";

      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.event === "result" && parsed.result) {
            if (parsed.result.status === "SUCCESS" && typeof parsed.result.response === "string") {
              resultResponse = parsed.result.response;
              usage = parsed.result.usage;
            } else if (parsed.result.error) {
              errorDetail = JSON.stringify(parsed.result.error);
            }
          } else if (parsed.event === "assistant" && Array.isArray(parsed.message?.content)) {
            for (const item of parsed.message.content) {
              if (item?.type === "text" && typeof item.text === "string") {
                assistantFallback += item.text;
              }
            }
          }
        } catch {
          // ignore non-json line
        }
      }

      const finalText = (resultResponse || assistantFallback).trim();
      if (finalText) {
        resolve({ text: finalText, usage });
        return;
      }

      reject(
        new Error(
          `Antigravity CLI 오류 (exit ${code}): ${
            errorDetail || stderrBuf.trim() || stdoutBuf.trim().slice(0, 300) || "응답이 비어있습니다."
          }`
        )
      );
    });

    try {
      const inputPayload =
        JSON.stringify({
          event: "user",
          message: {
            text: fullPrompt,
            content: fullPrompt,
          },
        }) + "\n";
      child.stdin.write(inputPayload, "utf-8");
      child.stdin.end();
    } catch (writeErr) {
      if (!finished) {
        finished = true;
        clearTimeout(timer);
        reject(writeErr);
      }
    }
  });
}

async function spawnClaudeCli(
  binaryPath: string,
  model: string,
  fullPrompt: string,
  timeoutMs: number
): Promise<{ text: string; usage?: any }> {
  const args: string[] = [];
  if (model && model !== "default" && !model.startsWith("gemini-")) {
    args.push("--model", model);
  }
  args.push("-p", "--output-format", "json");

  const isCmd = binaryPath.toLowerCase().endsWith(".cmd") || binaryPath.toLowerCase().endsWith(".bat");

  return new Promise((resolve, reject) => {
    const child = spawn(binaryPath, args, {
      cwd: os.tmpdir(),
      windowsHide: true,
      shell: isCmd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdoutBuf = "";
    let stderrBuf = "";
    let finished = false;

    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      try {
        child.kill();
      } catch {}
      reject(new Error(`Claude CLI 응답 시간 초과 (${Math.round(timeoutMs / 1000)}s)`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdoutBuf += chunk.toString("utf-8");
    });

    child.stderr.on("data", (chunk) => {
      stderrBuf += chunk.toString("utf-8");
    });

    child.on("error", (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);

      const rawOut = stdoutBuf.trim();
      try {
        const parsed = JSON.parse(rawOut);
        if (parsed && !parsed.is_error && typeof parsed.result === "string") {
          resolve({ text: parsed.result.trim(), usage: parsed.usage });
          return;
        }
        if (parsed?.is_error) {
          reject(new Error(`Claude CLI 에러: ${parsed.result || JSON.stringify(parsed)}`));
          return;
        }
      } catch {
        if (code === 0 && rawOut) {
          resolve({ text: rawOut });
          return;
        }
      }

      reject(
        new Error(
          `Claude CLI 실행 실패 (exit ${code}): ${stderrBuf.trim() || rawOut.slice(0, 300) || "응답 없음"}`
        )
      );
    });

    try {
      child.stdin.write(fullPrompt, "utf-8");
      child.stdin.end();
    } catch (writeErr) {
      if (!finished) {
        finished = true;
        clearTimeout(timer);
        reject(writeErr);
      }
    }
  });
}

async function spawnGeminiCli(
  binaryPath: string,
  model: string,
  fullPrompt: string,
  timeoutMs: number
): Promise<{ text: string; usage?: any }> {
  const args: string[] = [];
  if (model && model !== "default" && model.startsWith("gemini-")) {
    args.push("-m", model);
  }
  args.push("-p", " ", "-o", "json");

  const isCmd = binaryPath.toLowerCase().endsWith(".cmd") || binaryPath.toLowerCase().endsWith(".bat");

  return new Promise((resolve, reject) => {
    const child = spawn(binaryPath, args, {
      cwd: os.tmpdir(),
      windowsHide: true,
      shell: isCmd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdoutBuf = "";
    let stderrBuf = "";
    let finished = false;

    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      try {
        child.kill();
      } catch {}
      reject(new Error(`Gemini CLI 응답 시간 초과 (${Math.round(timeoutMs / 1000)}s)`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdoutBuf += chunk.toString("utf-8");
    });

    child.stderr.on("data", (chunk) => {
      stderrBuf += chunk.toString("utf-8");
    });

    child.on("error", (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);

      const rawOut = stdoutBuf.trim();
      if (code === 0 && rawOut) {
        try {
          const parsed = JSON.parse(rawOut);
          if (typeof parsed.response === "string") {
            resolve({ text: parsed.response.trim(), usage: parsed.stats });
            return;
          }
        } catch {
          resolve({ text: rawOut });
          return;
        }
      }

      reject(
        new Error(
          `Gemini CLI 실행 실패 (exit ${code}): ${stderrBuf.trim() || rawOut.slice(0, 300) || "응답 없음"}`
        )
      );
    });

    try {
      child.stdin.write(fullPrompt, "utf-8");
      child.stdin.end();
    } catch (writeErr) {
      if (!finished) {
        finished = true;
        clearTimeout(timer);
        reject(writeErr);
      }
    }
  });
}

export async function runCliPrompt(options: GenerateAiOptions): Promise<GenerateAiResult> {
  const config = getConfig();
  const available = detectAvailableClis();
  const preferredProvider: AiCliProvider = options.cliProviderOverride || config.aiCliProvider || "agy";
  const preferredModel: string = options.cliModelOverride || config.aiCliModel || "gemini-3.8-flash-low";
  const timeoutMs = options.timeoutMs || 90_000;

  // Build ordered list of installed providers starting with user's preferred provider
  const providerOrder: AvailableCliInfo[] = [];
  const primaryInfo = available.find((c) => c.id === preferredProvider && c.installed);
  if (primaryInfo) {
    providerOrder.push(primaryInfo);
  }
  for (const c of available) {
    if (c.installed && !providerOrder.some((p) => p.id === c.id)) {
      providerOrder.push(c);
    }
  }

  if (providerOrder.length === 0) {
    throw new Error(
      "설치된 로컬 AI CLI 도구(Antigravity CLI 'agy' 또는 Claude CLI 'claude')를 찾을 수 없습니다. 대시보드에서 API 모드로 전환하거나 CLI를 설치해주세요."
    );
  }

  const fullPrompt = buildCliPromptString(options);
  let lastError: any = null;

  for (const cliInfo of providerOrder) {
    const modelForCli =
      cliInfo.id === preferredProvider
        ? preferredModel
        : cliInfo.models[0]?.id || "default";

    try {
      console.log(
        `  💻 [AI CLI 요청] ${options.feature} -> ${cliInfo.name} (모델: ${modelForCli})`
      );
      let res: { text: string; usage?: any };
      if (cliInfo.id === "agy") {
        res = await spawnAgyCli(cliInfo.binaryPath, modelForCli, fullPrompt, timeoutMs);
      } else if (cliInfo.id === "claude") {
        res = await spawnClaudeCli(cliInfo.binaryPath, modelForCli, fullPrompt, timeoutMs);
      } else {
        res = await spawnGeminiCli(cliInfo.binaryPath, modelForCli, fullPrompt, timeoutMs);
      }

      const finalText = options.jsonMode ? cleanJsonResponse(res.text) : res.text.trim();
      if (!finalText) {
        throw new Error(`${cliInfo.name} 응답이 비어있습니다.`);
      }

      const modelLabel = `[CLI] ${cliInfo.id}/${modelForCli}`;
      recordAiUsage({
        feature: options.feature,
        model: modelLabel,
        mode: "cli",
        usageMetadata: res.usage,
        slug: options.slug,
        fallbackPromptChars: fullPrompt.length,
        fallbackOutputChars: finalText.length,
      });

      return {
        text: finalText,
        modelUsed: modelLabel,
        mode: "cli",
        usageMetadata: res.usage,
      };
    } catch (err: any) {
      lastError = err;
      console.warn(
        `  ⚠️ [AI CLI 폴백] ${cliInfo.name} 호출 실패: ${err.message || err}`
      );
    }
  }

  throw lastError || new Error("모든 AI CLI 호출이 실패했습니다.");
}

export async function runApiPrompt(options: GenerateAiOptions): Promise<GenerateAiResult> {
  const apiKeys = getGeminiApiKeys();
  if (apiKeys.length === 0) {
    throw new Error(
      "GEMINI_API_KEY가 .env 파일에 설정되지 않았습니다. API 키를 설정하거나 대시보드 상단에서 '💻 CLI 모드'로 전환해주세요."
    );
  }

  const config = getConfig();
  const primaryModel = normalizeApiModelId(config.geminiModel);
  const candidateModels = Array.from(
    new Set([primaryModel, "gemini-3.1-flash-lite-preview", "gemini-2.5-flash", "gemini-2.0-flash"])
  );

  const contentsParts: any[] = [];
  if (Array.isArray(options.imagesBase64)) {
    for (const img of options.imagesBase64) {
      if (img && img.data) {
        contentsParts.push({
          inlineData: {
            mimeType: img.mimeType || "image/jpeg",
            data: img.data,
          },
        });
      }
    }
  }
  contentsParts.push({ text: options.prompt });

  let lastError: any = null;
  for (let kIdx = 0; kIdx < apiKeys.length; kIdx++) {
    const ai = new GoogleGenAI({ apiKey: apiKeys[kIdx] });
    for (const modelName of candidateModels) {
      try {
        const reqConfig: any = {
          temperature: options.temperature ?? 0.2,
        };
        if (options.systemInstruction) {
          reqConfig.systemInstruction = options.systemInstruction;
        }
        if (options.jsonMode) {
          reqConfig.responseMimeType = "application/json";
        }

        const response = await ai.models.generateContent({
          model: modelName,
          contents: contentsParts.length === 1 ? options.prompt : contentsParts,
          config: reqConfig,
        });

        const rawText = (response.text || "").trim();
        const finalText = options.jsonMode ? cleanJsonResponse(rawText) : rawText;
        if (!finalText) {
          throw new Error("Gemini API 응답이 비어있습니다.");
        }

        recordAiUsage({
          feature: options.feature,
          model: modelName,
          mode: "api",
          usageMetadata: (response as any).usageMetadata,
          slug: options.slug,
          fallbackPromptChars: (options.systemInstruction?.length || 0) + options.prompt.length,
          fallbackOutputChars: finalText.length,
        });

        return {
          text: finalText,
          modelUsed: modelName,
          mode: "api",
          usageMetadata: (response as any).usageMetadata,
        };
      } catch (err: any) {
        lastError = err;
        const msg = String(err?.message || err);
        if (msg.includes("429") || msg.includes("quota") || msg.includes("404") || msg.includes("not found")) {
          continue;
        }
        break;
      }
    }
  }

  throw lastError || new Error("Gemini API 호출에 실패했습니다.");
}

export async function generateAiContent(options: GenerateAiOptions): Promise<GenerateAiResult> {
  const config = getConfig();
  const activeMode: AiExecutionMode = options.forceMode || config.aiMode || "api";

  if (activeMode === "cli") {
    return runCliPrompt(options);
  }
  return runApiPrompt(options);
}

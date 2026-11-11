import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawn, spawnSync, execSync } from "child_process";
import { GoogleGenAI } from "@google/genai";
import { getConfig, AiExecutionMode, AiCliProvider, AiApiProvider } from "./configManager";
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
  disableCliFallback?: boolean;
  timeoutMs?: number;
  apiProviderOverride?: AiApiProvider;
  apiModelOverride?: string;
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

const DEFAULT_AGY_MODELS: CliModelOption[] = [
  { id: "gemini-3.8-flash-low", label: "Gemini 3.8 Flash (Low · 초고속 추천)" },
  { id: "gemini-3.8-flash-medium", label: "Gemini 3.8 Flash (Medium · 균형)" },
  { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High · 정밀)" },
  { id: "gemini-4-argon-low", label: "Gemini 4 Argon (Low · 고속)" },
  { id: "gemini-4-argon-medium", label: "Gemini 4 Argon (Medium · 고성능)" },
  { id: "gemini-4-argon-high", label: "Gemini 4 Argon (High · 최고성능)" },
  { id: "claude-sonnet-5-5-low", label: "Claude Sonnet 5.5 (Low)" },
  { id: "claude-sonnet-5-5-medium", label: "Claude Sonnet 5.5 (Medium)" },
  { id: "claude-sonnet-5-5-high", label: "Claude Sonnet 5.5 (High)" },
  { id: "claude-opus-5-5-low", label: "Claude Opus 5.5 (Low)" },
  { id: "claude-opus-5-5-medium", label: "Claude Opus 5.5 (Medium)" },
  { id: "claude-opus-5-5-high", label: "Claude Opus 5.5 (High)" },
  { id: "gpt-oss-120b-medium", label: "GPT-OSS 120B (Medium)" },
];

function queryAgyModelsDynamic(agyPath: string): CliModelOption[] {
  if (!agyPath) return DEFAULT_AGY_MODELS;
  try {
    const res = spawnSync(agyPath, ["models"], {
      encoding: "utf-8",
      timeout: 3500,
      windowsHide: true,
    });
    const combined = `${res.stdout || ""}\n${res.stderr || ""}`;
    const parsed: CliModelOption[] = [];
    const seen = new Set<string>();
    const labelOverrides = new Map(DEFAULT_AGY_MODELS.map((m) => [m.id, m.label]));

    for (const rawLine of combined.split(/\r?\n/)) {
      const line = rawLine.trim();
      const m = line.match(/^([a-z0-9._-]+)\t(.+)$/i);
      if (m) {
        const id = m[1].trim();
        const rawLabel = m[2].trim();
        if (id && !seen.has(id)) {
          seen.add(id);
          parsed.push({
            id,
            label: labelOverrides.get(id) || rawLabel,
          });
        }
      }
    }

    if (parsed.length > 0) {
      // Ensure gemini-3.8-flash-low is placed first as the recommended fast model
      parsed.sort((a, b) => {
        if (a.id === "gemini-3.8-flash-low") return -1;
        if (b.id === "gemini-3.8-flash-low") return 1;
        return 0;
      });
      return parsed;
    }
  } catch {
    // fallback to DEFAULT_AGY_MODELS
  }
  return DEFAULT_AGY_MODELS;
}

const DEFAULT_OLLAMA_MODELS: CliModelOption[] = [
  { id: "qwen3:8b", label: "Qwen 3 (8B · 로컬 추천)" },
  { id: "gemma3:12b", label: "Gemma 3 (12B)" },
  { id: "llama3.3:latest", label: "Llama 3.3 (Latest)" },
  { id: "deepseek-r1:8b", label: "DeepSeek R1 (8B)" },
];

function queryOllamaModelsDynamic(ollamaPath: string): CliModelOption[] {
  if (!ollamaPath) return DEFAULT_OLLAMA_MODELS;
  try {
    const res = spawnSync(ollamaPath, ["list"], {
      encoding: "utf-8",
      timeout: 2500,
      windowsHide: true,
    });
    const out = String(res.stdout || "").trim();
    if (!out) return DEFAULT_OLLAMA_MODELS;
    const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const models: CliModelOption[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < lines.length; i++) {
      if (i === 0 && /^NAME\s+ID/i.test(lines[i])) continue;
      const cols = lines[i].split(/\s{2,}/);
      const modelId = cols[0]?.trim();
      const sizeStr = cols[2]?.trim();
      if (modelId && !seen.has(modelId)) {
        seen.add(modelId);
        models.push({
          id: modelId,
          label: sizeStr ? `${modelId} (${sizeStr} · 로컬 설치됨)` : `${modelId} (로컬 설치됨)`,
        });
      }
    }
    if (models.length > 0) {
      for (const fallback of DEFAULT_OLLAMA_MODELS) {
        if (!seen.has(fallback.id)) {
          models.push(fallback);
        }
      }
      return models;
    }
  } catch {
    // ignore
  }
  return DEFAULT_OLLAMA_MODELS;
}

const NAON_DEFAULT_MODEL_ID = "qwen3.8-27b";

const DEFAULT_NAONCODE_MODELS: CliModelOption[] = [
  { id: "qwen3.8-27b", label: "Qwen 3.8 27B (NAON AI Gateway · 기본 추천)" },
  { id: "qwen3.8-27b-NAON", label: "Qwen 3.8 27B NAON (사내 전용 게이트웨이)" },
  { id: "qwen3.6:35b-NAON", label: "Qwen 3.6 35B NAON (사내 전용 게이트웨이)" },
  { id: "qwen3.8-flash-openrouter", label: "Qwen 3.8 Flash (OpenRouter · 고속)" },
  { id: "qwen3-30b-a3b", label: "Qwen 3 30B-A3B (NAON AI Gateway)" },
  { id: "gemma-3-27b-it", label: "Gemma 3 27B IT (NAON AI Gateway)" },
  { id: "deepseek-v4", label: "DeepSeek V4 (NAON AI Gateway · 추론)" },
  { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash (NAON AI Gateway)" },
  { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro (NAON AI Gateway)" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 (NAON AI Gateway)" },
  { id: "gpt-5", label: "GPT-5 (NAON AI Gateway)" },
];

function queryNaoncodeModelsDynamic(home: string): CliModelOption[] {
  const models: CliModelOption[] = [];
  const seen = new Set<string>();
  const labelMap = new Map(DEFAULT_NAONCODE_MODELS.map((m) => [m.id, m.label]));

  try {
    const selectedModelPath = path.join(home, ".nmscode", "selected-model");
    if (fs.existsSync(selectedModelPath)) {
      const selected = fs.readFileSync(selectedModelPath, "utf-8").trim();
      if (selected && !seen.has(selected)) {
        seen.add(selected);
        const baseLabel = labelMap.get(selected) || `${selected} (NAON AI Gateway)`;
        models.push({
          id: selected,
          label: baseLabel.includes("현재 선택됨") ? baseLabel : `${baseLabel.replace(/\)$/, " · 현재 선택됨)")}`,
        });
      }
    }
  } catch {
    // ignore
  }

  for (const fallback of DEFAULT_NAONCODE_MODELS) {
    if (!seen.has(fallback.id)) {
      seen.add(fallback.id);
      models.push(fallback);
    }
  }

  return models;
}

function resolveNaoncodeEntryPath(appData: string, localAppData: string): string {
  const directCandidates = [
    path.join(appData, "npm", "node_modules", "naoncode", "dist", "index.js"),
    path.join(localAppData, "npm", "node_modules", "naoncode", "dist", "index.js"),
  ];
  for (const c of directCandidates) {
    if (c && fs.existsSync(c)) {
      return c;
    }
  }
  const foundBin = findExecutablePath(
    [
      path.join(appData, "npm", "naoncode.cmd"),
      path.join(localAppData, "npm", "naoncode.cmd"),
    ],
    "naoncode"
  );
  if (foundBin) {
    const adjacentEntry = path.join(path.dirname(foundBin), "node_modules", "naoncode", "dist", "index.js");
    if (fs.existsSync(adjacentEntry)) {
      return adjacentEntry;
    }
    return foundBin;
  }
  return "";
}

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

  const naoncodePath = resolveNaoncodeEntryPath(appData, localAppData);

  const claudePath = findExecutablePath(
    [
      path.join(home, ".local", "bin", "claude.exe"),
      path.join(appData, "npm", "claude.cmd"),
      path.join(localAppData, "Programs", "claude", "claude.exe"),
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

  const codexPath = findExecutablePath(
    [
      path.join(appData, "npm", "codex.cmd"),
      path.join(localAppData, "npm", "codex.cmd"),
      path.join(home, ".local", "bin", "codex.exe"),
    ],
    "codex"
  );

  const ollamaPath = findExecutablePath(
    [
      path.join(localAppData, "Programs", "Ollama", "ollama.exe"),
      "C:\\Program Files\\Ollama\\ollama.exe",
    ],
    "ollama"
  );

  const copilotPath = findExecutablePath(
    [
      path.join(appData, "npm", "copilot.cmd"),
      path.join(localAppData, "Programs", "GitHub Copilot CLI", "copilot.exe"),
      path.join(home, ".local", "bin", "copilot.exe"),
    ],
    "copilot"
  );

  const rawList: AvailableCliInfo[] = [
    {
      id: "agy",
      name: "Antigravity CLI (agy)",
      installed: Boolean(agyPath),
      binaryPath: agyPath,
      models: queryAgyModelsDynamic(agyPath),
      note: "Google Antigravity 로그인 세션 (API 키 불필요 · 요금 ₩0 · 13종 모델 실시간 조회)",
    },
    {
      id: "naoncode",
      name: "NAON CODE CLI (naoncode)",
      installed: Boolean(naoncodePath),
      binaryPath: naoncodePath,
      models: queryNaoncodeModelsDynamic(home),
      note: "나온소프트 사내 NAON AI Gateway 로그인 세션 (API 키 불필요 · 요금 ₩0 · ACP JSON-RPC 스트림)",
    },
    {
      id: "claude",
      name: "Claude Code CLI (claude)",
      installed: Boolean(claudePath),
      binaryPath: claudePath,
      models: [
        { id: "default", label: "Claude 기본 모델 (Default)" },
        { id: "sonnet", label: "Claude Sonnet (표준 · 추천)" },
        { id: "haiku", label: "Claude Haiku (초고속)" },
        { id: "opus", label: "Claude Opus (최고성능)" },
        { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
        { id: "claude-opus-4-6", label: "Claude Opus 4.6" },
        { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
      ],
      note: "Claude Code 구독 로그인 세션 사용 (API 키 불필요 · 요금 ₩0)",
    },
    {
      id: "gemini",
      name: "Google Gemini CLI (gemini)",
      installed: Boolean(geminiPath),
      binaryPath: geminiPath,
      models: [
        { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash (고속 추천)" },
        { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro (고성능)" },
        { id: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash Lite (초경량)" },
        { id: "gemini-3-flash-preview", label: "Gemini 3 Flash Preview" },
        { id: "gemini-3-pro-preview", label: "Gemini 3 Pro Preview" },
      ],
      note: "Google Gemini CLI 로그인 세션 사용",
    },
    {
      id: "codex",
      name: "OpenAI Codex CLI (codex)",
      installed: Boolean(codexPath),
      binaryPath: codexPath,
      models: [
        { id: "gpt-5-codex", label: "GPT-5 Codex (표준 추천)" },
        { id: "gpt-5", label: "GPT-5 (고성능)" },
        { id: "o4-mini", label: "o4-mini (초고속 추론)" },
        { id: "o3", label: "o3 (심층 추론)" },
      ],
      note: "ChatGPT Plus/Pro/Team 로그인 세션 사용 (@openai/codex)",
    },
    {
      id: "ollama",
      name: "Ollama Local LLM (ollama)",
      installed: Boolean(ollamaPath),
      binaryPath: ollamaPath,
      models: queryOllamaModelsDynamic(ollamaPath),
      note: "완전 오프라인 로컬 GPU/CPU LLM 실행 (API 요금 ₩0 · ollama list 연동)",
    },
    {
      id: "copilot",
      name: "GitHub Copilot CLI (copilot)",
      installed: Boolean(copilotPath),
      binaryPath: copilotPath,
      models: [
        { id: "claude-sonnet-4.5", label: "Claude Sonnet 4.5 (Copilot)" },
        { id: "gpt-5", label: "GPT-5 (Copilot)" },
        { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro (Copilot)" },
      ],
      note: "GitHub Copilot 구독 로그인 세션 사용 (@github/copilot)",
    },
  ];

  // Sort installed CLIs first while preserving relative order
  cachedClis = [
    ...rawList.filter((c) => c.installed),
    ...rawList.filter((c) => !c.installed),
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

async function spawnCodexCli(
  binaryPath: string,
  model: string,
  fullPrompt: string,
  timeoutMs: number
): Promise<{ text: string; usage?: any }> {
  const args: string[] = ["exec", "--skip-git-repo-check"];
  if (model && model !== "default") {
    args.push("-m", model);
  }
  args.push("-");

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
      reject(new Error(`Codex CLI 응답 시간 초과 (${Math.round(timeoutMs / 1000)}s)`));
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
        resolve({ text: rawOut });
        return;
      }

      reject(
        new Error(
          `Codex CLI 실행 실패 (exit ${code}): ${stderrBuf.trim() || rawOut.slice(0, 300) || "응답 없음"}`
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

async function spawnOllamaCli(
  binaryPath: string,
  model: string,
  fullPrompt: string,
  timeoutMs: number
): Promise<{ text: string; usage?: any }> {
  const effectiveModel = model && model !== "default" ? model : "qwen3:8b";
  const args = ["run", effectiveModel];

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
      reject(new Error(`Ollama CLI 응답 시간 초과 (${Math.round(timeoutMs / 1000)}s)`));
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

      // Strip terminal ANSI escape sequences if present
      const cleanOut = stdoutBuf.replace(/\x1B\[[0-9;?]*[a-zA-Z]/g, "").trim();
      if (code === 0 && cleanOut) {
        resolve({ text: cleanOut });
        return;
      }

      reject(
        new Error(
          `Ollama CLI 실행 실패 (exit ${code}): ${stderrBuf.trim() || cleanOut.slice(0, 300) || "응답 없음"}`
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

async function spawnCopilotCli(
  binaryPath: string,
  model: string,
  fullPrompt: string,
  timeoutMs: number
): Promise<{ text: string; usage?: any }> {
  const args: string[] = [];
  if (model && model !== "default") {
    args.push("--model", model);
  }
  args.push("-p", fullPrompt);

  const isCmd = binaryPath.toLowerCase().endsWith(".cmd") || binaryPath.toLowerCase().endsWith(".bat");

  return new Promise((resolve, reject) => {
    const child = spawn(binaryPath, args, {
      cwd: os.tmpdir(),
      windowsHide: true,
      shell: isCmd,
      stdio: ["ignore", "pipe", "pipe"],
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
      reject(new Error(`Copilot CLI 응답 시간 초과 (${Math.round(timeoutMs / 1000)}s)`));
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
        resolve({ text: rawOut });
        return;
      }

      reject(
        new Error(
          `Copilot CLI 실행 실패 (exit ${code}): ${stderrBuf.trim() || rawOut.slice(0, 300) || "응답 없음"}`
        )
      );
    });
  });
}

async function spawnNaoncodeCli(
  binaryPath: string,
  model: string,
  fullPrompt: string,
  timeoutMs: number
): Promise<{ text: string; usage?: any }> {
  const trimmedModel = String(model || "").trim();
  const effectiveModel =
    trimmedModel &&
    trimmedModel !== "default" &&
    !trimmedModel.startsWith("gemini-3.8-") &&
    !trimmedModel.startsWith("gemini-4-")
      ? trimmedModel
      : NAON_DEFAULT_MODEL_ID;

  let entryJs = binaryPath;
  if (!entryJs.toLowerCase().endsWith(".js")) {
    const candidateJs = path.join(path.dirname(binaryPath), "node_modules", "naoncode", "dist", "index.js");
    if (fs.existsSync(candidateJs)) {
      entryJs = candidateJs;
    }
  }

  const isJsEntry = entryJs.toLowerCase().endsWith(".js");
  const cmd = isJsEntry ? process.execPath : binaryPath;
  const acpFlags = [
    "acp",
    "--model",
    effectiveModel,
    "--tools",
    "readonly",
    "--mode",
    "plan",
    "--no-skills",
    "--no-project-md",
    "--effort",
    "low",
  ];
  const args = isJsEntry ? [entryJs, ...acpFlags] : acpFlags;
  const isCmdShim = !isJsEntry && (binaryPath.toLowerCase().endsWith(".cmd") || binaryPath.toLowerCase().endsWith(".bat"));

  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: os.tmpdir(),
      windowsHide: true,
      shell: isCmdShim,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        NMS_MCP_ENABLED: "0",
      },
    });

    let stdoutLineBuf = "";
    let stdoutAll = "";
    let stderrBuf = "";
    let finished = false;
    let responseText = "";
    let usedTokens = 0;
    let sentSessionNew = false;
    let sentPrompt = false;
    let errorDetail = "";

    const finishWithSuccess = () => {
      if (finished) return true;
      const cleanedText = responseText.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
      if (!cleanedText) return false;
      finished = true;
      clearTimeout(timer);
      try {
        child.stdin.end();
      } catch {}
      try {
        child.kill();
      } catch {}
      let usage: any = undefined;
      if (usedTokens > 0) {
        const estOut = Math.max(1, Math.round(cleanedText.length / 3));
        const estIn = Math.max(1, usedTokens - estOut);
        usage = {
          promptTokenCount: estIn,
          candidatesTokenCount: estOut,
          totalTokenCount: usedTokens,
        };
      }
      resolve({ text: cleanedText, usage });
      return true;
    };

    const timer = setTimeout(() => {
      if (finished) return;
      if (finishWithSuccess()) return;
      finished = true;
      try {
        child.kill();
      } catch {}
      reject(new Error(`NAON CODE CLI (naoncode) 응답 시간 초과 (${Math.round(timeoutMs / 1000)}s)`));
    }, timeoutMs);

    const handleAcpJsonLine = (rawLine: string) => {
      const line = rawLine.trim();
      if (!line.startsWith("{")) return;
      try {
        const msg = JSON.parse(line);
        if (msg.id === 1 && !sentSessionNew) {
          sentSessionNew = true;
          const newReq =
            JSON.stringify({
              jsonrpc: "2.0",
              id: 2,
              method: "session/new",
              params: { cwd: os.tmpdir(), mcpServers: [] },
            }) + "\n";
          child.stdin.write(newReq, "utf-8");
        } else if (msg.id === 2 && !sentPrompt) {
          if (msg.error) {
            errorDetail = msg.error.message || JSON.stringify(msg.error);
            if (!finished) {
              finished = true;
              clearTimeout(timer);
              try {
                child.kill();
              } catch {}
              reject(new Error(`NAON CODE CLI 세션 생성 실패: ${errorDetail}`));
            }
            return;
          }
          const sessionId = msg.result?.sessionId;
          if (sessionId) {
            sentPrompt = true;
            const promptReq =
              JSON.stringify({
                jsonrpc: "2.0",
                id: 3,
                method: "session/prompt",
                params: {
                  sessionId,
                  prompt: [{ type: "text", text: fullPrompt }],
                },
              }) + "\n";
            child.stdin.write(promptReq, "utf-8");
          }
        } else if (msg.method === "session/update") {
          const u = msg.params?.update;
          if (u?.sessionUpdate === "agent_message_chunk" && typeof u?.content?.text === "string") {
            responseText += u.content.text;
          } else if (u?.sessionUpdate === "usage_update" && typeof u?.used === "number") {
            usedTokens = u.used;
          }
        } else if (msg.id === 3) {
          if (msg.error) {
            errorDetail = msg.error.message || JSON.stringify(msg.error);
          }
          if (!finishWithSuccess() && !finished) {
            finished = true;
            clearTimeout(timer);
            try {
              child.kill();
            } catch {}
            reject(
              new Error(
                `NAON CODE CLI (naoncode) 오류: ${
                  errorDetail || stderrBuf.trim() || "응답이 비어있습니다."
                }`
              )
            );
          }
        }
      } catch {
        // ignore non-json line
      }
    };

    child.stdout.on("data", (chunk) => {
      const str = chunk.toString("utf-8");
      stdoutAll += str;
      stdoutLineBuf += str;
      const lines = stdoutLineBuf.split(/\r?\n/);
      stdoutLineBuf = lines.pop() ?? "";
      for (const l of lines) {
        if (finished) break;
        handleAcpJsonLine(l);
      }
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
      if (stdoutLineBuf.trim()) {
        handleAcpJsonLine(stdoutLineBuf);
        stdoutLineBuf = "";
      }
      if (finishWithSuccess()) return;
      finished = true;
      clearTimeout(timer);

      reject(
        new Error(
          `NAON CODE CLI (naoncode) 오류 (exit ${code}): ${
            errorDetail || stderrBuf.trim() || stdoutAll.trim().slice(0, 300) || "응답이 비어있습니다."
          }`
        )
      );
    });

    try {
      const initReq =
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: 1, clientCapabilities: {} },
        }) + "\n";
      child.stdin.write(initReq, "utf-8");
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
  const primaryEntry = available.find((c) => c.id === preferredProvider);
  if (options.disableCliFallback) {
    if (!primaryEntry || !primaryEntry.installed) {
      throw new Error(
        `선택한 로컬 CLI 도구(${primaryEntry?.name || preferredProvider})가 PC에 설치되어 있지 않습니다.`
      );
    }
    providerOrder.push(primaryEntry);
  } else {
    if (primaryEntry && primaryEntry.installed) {
      providerOrder.push(primaryEntry);
    }
    for (const c of available) {
      if (c.installed && !providerOrder.some((p) => p.id === c.id)) {
        providerOrder.push(c);
      }
    }
  }

  if (providerOrder.length === 0) {
    throw new Error(
      "설치된 로컬 AI CLI 도구(Antigravity, NAON CODE, Claude, Gemini, Codex, Ollama, Copilot)를 찾을 수 없습니다. 대시보드에서 API 모드로 전환하거나 CLI를 설치해주세요."
    );
  }

  const fullPrompt = buildCliPromptString(options);
  let lastError: any = null;

  for (const cliInfo of providerOrder) {
    const rawModelForCli =
      cliInfo.id === preferredProvider
        ? preferredModel
        : cliInfo.models[0]?.id || "default";
    const modelForCli =
      cliInfo.id === "naoncode"
        ? !rawModelForCli ||
          rawModelForCli === "default" ||
          rawModelForCli.startsWith("gemini-3.8-") ||
          rawModelForCli.startsWith("gemini-4-")
          ? NAON_DEFAULT_MODEL_ID
          : rawModelForCli
        : rawModelForCli;

    try {
      console.log(
        `  💻 [AI CLI 요청] ${options.feature} -> ${cliInfo.name} (모델: ${modelForCli})`
      );
      let res: { text: string; usage?: any };
      if (cliInfo.id === "agy") {
        res = await spawnAgyCli(cliInfo.binaryPath, modelForCli, fullPrompt, timeoutMs);
      } else if (cliInfo.id === "naoncode") {
        res = await spawnNaoncodeCli(cliInfo.binaryPath, modelForCli, fullPrompt, timeoutMs);
      } else if (cliInfo.id === "claude") {
        res = await spawnClaudeCli(cliInfo.binaryPath, modelForCli, fullPrompt, timeoutMs);
      } else if (cliInfo.id === "codex") {
        res = await spawnCodexCli(cliInfo.binaryPath, modelForCli, fullPrompt, timeoutMs);
      } else if (cliInfo.id === "ollama") {
        res = await spawnOllamaCli(cliInfo.binaryPath, modelForCli, fullPrompt, timeoutMs);
      } else if (cliInfo.id === "copilot") {
        res = await spawnCopilotCli(cliInfo.binaryPath, modelForCli, fullPrompt, timeoutMs);
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

export async function runGeminiApiPrompt(options: GenerateAiOptions): Promise<GenerateAiResult> {
  const apiKeys = getGeminiApiKeys();
  if (apiKeys.length === 0) {
    throw new Error(
      "Gemini API Key가 설정되지 않았습니다. 대시보드 상단 AI 모달에서 API 키를 입력하거나 '💻 CLI 모드'로 전환해주세요."
    );
  }

  const config = getConfig();
  const primaryModel = normalizeApiModelId(options.apiModelOverride || config.geminiModel);
  const candidateModels = Array.from(
    new Set([primaryModel, "gemini-2.5-flash", "gemini-3.1-flash-lite-preview", "gemini-2.0-flash"])
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

export async function runOpenAiApiPrompt(options: GenerateAiOptions, isCustom = false): Promise<GenerateAiResult> {
  const config = getConfig();
  const apiKey = isCustom
    ? (config.customApiKey || process.env.CUSTOM_API_KEY || "no-key")
    : (config.openaiApiKey || process.env.OPENAI_API_KEY || "");
  const baseUrl = isCustom
    ? (config.customBaseUrl || process.env.CUSTOM_BASE_URL || "https://api.deepseek.com/v1")
    : "https://api.openai.com/v1";
  const model =
    options.apiModelOverride ||
    (isCustom ? (config.customModel || "deepseek-chat") : (config.openaiModel || "gpt-4o-mini"));

  if (!isCustom && !apiKey) {
    throw new Error("OpenAI API Key가 설정되지 않았습니다. 대시보드 상단 AI 모달에서 API 키를 입력해주세요.");
  }

  const messages: any[] = [];
  if (options.systemInstruction) {
    messages.push({ role: "system", content: options.systemInstruction });
  }

  if (Array.isArray(options.imagesBase64) && options.imagesBase64.length > 0) {
    const userContent: any[] = [];
    for (const img of options.imagesBase64) {
      if (img && img.data) {
        const mime = img.mimeType || "image/jpeg";
        userContent.push({
          type: "image_url",
          image_url: { url: `data:${mime};base64,${img.data}` },
        });
      }
    }
    userContent.push({ type: "text", text: options.prompt });
    messages.push({ role: "user", content: userContent });
  } else {
    messages.push({ role: "user", content: options.prompt });
  }

  const reqBody: any = {
    model,
    messages,
    temperature: options.temperature ?? 0.2,
  };
  if (options.jsonMode) {
    reqBody.response_format = { type: "json_object" };
  }

  const endpoint = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs || 45000;
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(reqBody),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errText = await res.text();
      let errMsg = `HTTP ${res.status}`;
      try {
        const errJson = JSON.parse(errText);
        errMsg = errJson.error?.message || errJson.message || errText;
      } catch {
        errMsg = errText || errMsg;
      }
      throw new Error(`[${isCustom ? "Custom/DeepSeek" : "OpenAI"}] API 오류: ${errMsg}`);
    }

    const data: any = await res.json();
    const rawText = String(data.choices?.[0]?.message?.content || "").trim();
    const finalText = options.jsonMode ? cleanJsonResponse(rawText) : rawText;
    if (!finalText) {
      throw new Error(`[${isCustom ? "Custom" : "OpenAI"}] 응답이 비어있습니다.`);
    }

    const usage = data.usage || {};
    recordAiUsage({
      feature: options.feature,
      model,
      mode: "api",
      usageMetadata: {
        promptTokenCount: usage.prompt_tokens || 0,
        candidatesTokenCount: usage.completion_tokens || 0,
        totalTokenCount: usage.total_tokens || 0,
      },
      slug: options.slug,
      fallbackPromptChars: (options.systemInstruction?.length || 0) + options.prompt.length,
      fallbackOutputChars: finalText.length,
    });

    return {
      text: finalText,
      modelUsed: model,
      mode: "api",
      usageMetadata: usage,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function runAnthropicApiPrompt(options: GenerateAiOptions): Promise<GenerateAiResult> {
  const config = getConfig();
  const apiKey = config.anthropicApiKey || process.env.ANTHROPIC_API_KEY || "";
  const model = options.apiModelOverride || config.anthropicModel || "claude-3-5-sonnet-20241022";

  if (!apiKey) {
    throw new Error("Anthropic Claude API Key가 설정되지 않았습니다. 대시보드 상단 AI 모달에서 API 키를 입력해주세요.");
  }

  const userContent: any[] = [];
  if (Array.isArray(options.imagesBase64) && options.imagesBase64.length > 0) {
    for (const img of options.imagesBase64) {
      if (img && img.data) {
        userContent.push({
          type: "image",
          source: {
            type: "base64",
            media_type: img.mimeType || "image/jpeg",
            data: img.data,
          },
        });
      }
    }
  }
  userContent.push({ type: "text", text: options.prompt });

  let systemPrompt = options.systemInstruction || "";
  if (options.jsonMode && !systemPrompt.includes("JSON")) {
    systemPrompt += "\nYou must respond strictly with a valid JSON object only. No markdown formatting, no code fences.";
  }

  const reqBody: any = {
    model,
    max_tokens: 4096,
    temperature: options.temperature ?? 0.2,
    messages: [{ role: "user", content: userContent }],
  };
  if (systemPrompt) {
    reqBody.system = systemPrompt;
  }

  const endpoint = "https://api.anthropic.com/v1/messages";
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs || 45000;
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(reqBody),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errText = await res.text();
      let errMsg = `HTTP ${res.status}`;
      try {
        const errJson = JSON.parse(errText);
        errMsg = errJson.error?.message || errJson.message || errText;
      } catch {
        errMsg = errText || errMsg;
      }
      throw new Error(`[Claude API] 오류: ${errMsg}`);
    }

    const data: any = await res.json();
    const rawText = String(data.content?.[0]?.text || "").trim();
    const finalText = options.jsonMode ? cleanJsonResponse(rawText) : rawText;
    if (!finalText) {
      throw new Error("[Claude API] 응답이 비어있습니다.");
    }

    const usage = data.usage || {};
    recordAiUsage({
      feature: options.feature,
      model,
      mode: "api",
      usageMetadata: {
        promptTokenCount: usage.input_tokens || 0,
        candidatesTokenCount: usage.output_tokens || 0,
        totalTokenCount: (usage.input_tokens || 0) + (usage.output_tokens || 0),
      },
      slug: options.slug,
      fallbackPromptChars: (options.systemInstruction?.length || 0) + options.prompt.length,
      fallbackOutputChars: finalText.length,
    });

    return {
      text: finalText,
      modelUsed: model,
      mode: "api",
      usageMetadata: usage,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function runApiPrompt(options: GenerateAiOptions): Promise<GenerateAiResult> {
  const config = getConfig();
  const provider = options.apiProviderOverride || config.aiApiProvider || "gemini";

  if (provider === "openai") {
    return runOpenAiApiPrompt(options, false);
  }
  if (provider === "anthropic") {
    return runAnthropicApiPrompt(options);
  }
  if (provider === "custom") {
    return runOpenAiApiPrompt(options, true);
  }
  return runGeminiApiPrompt(options);
}

export async function generateAiContent(options: GenerateAiOptions): Promise<GenerateAiResult> {
  const config = getConfig();
  const activeMode: AiExecutionMode = options.forceMode || config.aiMode || "api";

  if (activeMode === "cli") {
    return runCliPrompt(options);
  }
  return runApiPrompt(options);
}

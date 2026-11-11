import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";

dotenv.config({ override: true });

const ENV_FILE_PATH = path.resolve(__dirname, "..", "..", ".env");

export type AiExecutionMode = "api" | "cli";
export type AiCliProvider = "agy" | "naoncode" | "claude" | "gemini" | "codex" | "ollama" | "copilot";
export type AiApiProvider = "gemini" | "openai" | "anthropic" | "custom";

export interface StudioConfig {
  targetProjectPath: string;
  targetBaseUrl: string;
  geminiModel: string;
  aiMode: AiExecutionMode;
  aiCliProvider: AiCliProvider;
  aiCliModel: string;
  // Multi-AI API settings
  aiApiProvider: AiApiProvider;
  geminiApiKey: string;
  openaiApiKey: string;
  openaiModel: string;
  anthropicApiKey: string;
  anthropicModel: string;
  customApiKey: string;
  customBaseUrl: string;
  customModel: string;
}

export const DEFAULT_GROUPWARE_PROJECTS = [
  "C:/dev/IdeaProjects/bc2026/bc2026_gw",
  "C:/dev/IdeaProjects/bc2026/bc2026_iam",
  "C:/dev/IdeaProjects/unison/unison_gw",
  "C:/dev/IdeaProjects/unison/unison_iam",
];

export function getDiscoveredGroupwareProjects(): string[] {
  return DEFAULT_GROUPWARE_PROJECTS.filter((p) => fs.existsSync(p));
}

function normalizeAiMode(raw?: string): AiExecutionMode {
  return String(raw || "").trim().toLowerCase() === "cli" ? "cli" : "api";
}

function normalizeAiCliProvider(raw?: string): AiCliProvider {
  const v = String(raw || "").trim().toLowerCase();
  if (v === "naoncode" || v === "nmscode") return "naoncode";
  if (v === "claude") return "claude";
  if (v === "gemini") return "gemini";
  if (v === "codex") return "codex";
  if (v === "ollama") return "ollama";
  if (v === "copilot") return "copilot";
  return "agy";
}

function normalizeAiApiProvider(raw?: string): AiApiProvider {
  const v = String(raw || "").trim().toLowerCase();
  if (v === "openai") return "openai";
  if (v === "anthropic" || v === "claude") return "anthropic";
  if (v === "custom" || v === "deepseek") return "custom";
  return "gemini";
}

// In-memory runtime config, initialized from .env or defaults
const discoveredGw = getDiscoveredGroupwareProjects();
let currentConfig: StudioConfig = {
  targetProjectPath: process.env.TARGET_PROJECT_PATH || (discoveredGw.length > 0 ? discoveredGw[0] : ""),
  targetBaseUrl: (process.env.TARGET_BASE_URL || "").trim(),
  geminiModel: process.env.GEMINI_MODEL || "gemini-2.5-flash",
  aiMode: normalizeAiMode(process.env.AI_MODE),
  aiCliProvider: normalizeAiCliProvider(process.env.AI_CLI_PROVIDER),
  aiCliModel: (process.env.AI_CLI_MODEL || "gemini-3.8-flash-low").trim(),
  aiApiProvider: normalizeAiApiProvider(process.env.AI_API_PROVIDER),
  geminiApiKey: (process.env.GEMINI_API_KEY || "").trim(),
  openaiApiKey: (process.env.OPENAI_API_KEY || "").trim(),
  openaiModel: (process.env.OPENAI_MODEL || "gpt-4o-mini").trim(),
  anthropicApiKey: (process.env.ANTHROPIC_API_KEY || "").trim(),
  anthropicModel: (process.env.ANTHROPIC_MODEL || "claude-3-5-sonnet-20241022").trim(),
  customApiKey: (process.env.CUSTOM_API_KEY || "").trim(),
  customBaseUrl: (process.env.CUSTOM_BASE_URL || "https://api.deepseek.com/v1").trim(),
  customModel: (process.env.CUSTOM_MODEL || "deepseek-chat").trim(),
};

export interface ProjectAnalysis {
  path: string;
  exists: boolean;
  projectName: string;
  projectType: string;
  docFiles: string[];
  sourceSummary: string;
}

export function maskSecretKey(key?: string): string {
  const s = String(key || "").trim();
  if (!s) return "";
  if (s.length <= 8) return "••••••••";
  return `${s.slice(0, 4)}••••${s.slice(-4)}`;
}

export interface SafeStudioConfig extends Omit<StudioConfig, "geminiApiKey" | "openaiApiKey" | "anthropicApiKey" | "customApiKey"> {
  geminiApiKeyPreview: string;
  hasGeminiKey: boolean;
  openaiApiKeyPreview: string;
  hasOpenaiKey: boolean;
  anthropicApiKeyPreview: string;
  hasAnthropicKey: boolean;
  customApiKeyPreview: string;
  hasCustomKey: boolean;
}

export function getConfig(): StudioConfig {
  return { ...currentConfig };
}

export function getSafeConfig(): SafeStudioConfig {
  const c = getConfig();
  return {
    ...c,
    geminiApiKeyPreview: maskSecretKey(c.geminiApiKey),
    hasGeminiKey: Boolean(c.geminiApiKey),
    openaiApiKeyPreview: maskSecretKey(c.openaiApiKey),
    hasOpenaiKey: Boolean(c.openaiApiKey),
    anthropicApiKeyPreview: maskSecretKey(c.anthropicApiKey),
    hasAnthropicKey: Boolean(c.anthropicApiKey),
    customApiKeyPreview: maskSecretKey(c.customApiKey),
    hasCustomKey: Boolean(c.customApiKey),
  };
}

export function updateConfig(newConfig: Partial<StudioConfig>): StudioConfig {
  if (newConfig.targetProjectPath !== undefined) {
    currentConfig.targetProjectPath = newConfig.targetProjectPath.trim().replace(/\\/g, "/");
  }
  if (newConfig.targetBaseUrl !== undefined) {
    let raw = newConfig.targetBaseUrl.trim();
    if (raw && !/^https?:\/\//i.test(raw)) {
      raw = "http://" + raw;
    }
    currentConfig.targetBaseUrl = raw;
  }
  if (newConfig.geminiModel !== undefined && newConfig.geminiModel.trim()) {
    currentConfig.geminiModel = newConfig.geminiModel.trim();
    process.env.GEMINI_MODEL = currentConfig.geminiModel;
  }
  if (newConfig.aiMode !== undefined) {
    currentConfig.aiMode = normalizeAiMode(newConfig.aiMode);
    process.env.AI_MODE = currentConfig.aiMode;
  }
  if (newConfig.aiCliProvider !== undefined) {
    currentConfig.aiCliProvider = normalizeAiCliProvider(newConfig.aiCliProvider);
    process.env.AI_CLI_PROVIDER = currentConfig.aiCliProvider;
  }
  if (newConfig.aiCliModel !== undefined && newConfig.aiCliModel.trim()) {
    currentConfig.aiCliModel = newConfig.aiCliModel.trim();
    process.env.AI_CLI_MODEL = currentConfig.aiCliModel;
  }
  if (newConfig.aiApiProvider !== undefined) {
    currentConfig.aiApiProvider = normalizeAiApiProvider(newConfig.aiApiProvider);
    process.env.AI_API_PROVIDER = currentConfig.aiApiProvider;
  }
  if (newConfig.geminiApiKey !== undefined) {
    currentConfig.geminiApiKey = newConfig.geminiApiKey.trim();
    process.env.GEMINI_API_KEY = currentConfig.geminiApiKey;
  }
  if (newConfig.openaiApiKey !== undefined) {
    currentConfig.openaiApiKey = newConfig.openaiApiKey.trim();
    process.env.OPENAI_API_KEY = currentConfig.openaiApiKey;
  }
  if (newConfig.openaiModel !== undefined && newConfig.openaiModel.trim()) {
    currentConfig.openaiModel = newConfig.openaiModel.trim();
    process.env.OPENAI_MODEL = currentConfig.openaiModel;
  }
  if (newConfig.anthropicApiKey !== undefined) {
    currentConfig.anthropicApiKey = newConfig.anthropicApiKey.trim();
    process.env.ANTHROPIC_API_KEY = currentConfig.anthropicApiKey;
  }
  if (newConfig.anthropicModel !== undefined && newConfig.anthropicModel.trim()) {
    currentConfig.anthropicModel = newConfig.anthropicModel.trim();
    process.env.ANTHROPIC_MODEL = currentConfig.anthropicModel;
  }
  if (newConfig.customApiKey !== undefined) {
    currentConfig.customApiKey = newConfig.customApiKey.trim();
    process.env.CUSTOM_API_KEY = currentConfig.customApiKey;
  }
  if (newConfig.customBaseUrl !== undefined && newConfig.customBaseUrl.trim()) {
    currentConfig.customBaseUrl = newConfig.customBaseUrl.trim();
    process.env.CUSTOM_BASE_URL = currentConfig.customBaseUrl;
  }
  if (newConfig.customModel !== undefined && newConfig.customModel.trim()) {
    currentConfig.customModel = newConfig.customModel.trim();
    process.env.CUSTOM_MODEL = currentConfig.customModel;
  }

  // Update .env file to persist changes
  try {
    let envContent = "";
    if (fs.existsSync(ENV_FILE_PATH)) {
      envContent = fs.readFileSync(ENV_FILE_PATH, "utf-8");
    }

    const updates: Record<string, string> = {
      TARGET_PROJECT_PATH: currentConfig.targetProjectPath,
      TARGET_BASE_URL: currentConfig.targetBaseUrl,
      GEMINI_MODEL: currentConfig.geminiModel,
      AI_MODE: currentConfig.aiMode,
      AI_CLI_PROVIDER: currentConfig.aiCliProvider,
      AI_CLI_MODEL: currentConfig.aiCliModel,
      AI_API_PROVIDER: currentConfig.aiApiProvider,
      GEMINI_API_KEY: currentConfig.geminiApiKey,
      OPENAI_API_KEY: currentConfig.openaiApiKey,
      OPENAI_MODEL: currentConfig.openaiModel,
      ANTHROPIC_API_KEY: currentConfig.anthropicApiKey,
      ANTHROPIC_MODEL: currentConfig.anthropicModel,
      CUSTOM_API_KEY: currentConfig.customApiKey,
      CUSTOM_BASE_URL: currentConfig.customBaseUrl,
      CUSTOM_MODEL: currentConfig.customModel,
    };

    for (const [key, val] of Object.entries(updates)) {
      const regex = new RegExp(`^${key}=.*$`, "m");
      if (regex.test(envContent)) {
        envContent = envContent.replace(regex, `${key}=${val}`);
      } else {
        envContent += `\n${key}=${val}`;
      }
    }

    fs.writeFileSync(ENV_FILE_PATH, envContent.trim() + "\n", "utf-8");
  } catch (err) {
    console.warn("Failed to persist config to .env:", err);
  }

  return { ...currentConfig };
}

/**
 * Analyzes any target project path to detect its framework, documentation, and structure.
 */
export function analyzeProject(targetPath?: string): ProjectAnalysis {
  const p = (targetPath !== undefined ? targetPath : currentConfig.targetProjectPath).trim().replace(/\\/g, "/");

  if (!p) {
    return {
      path: "",
      exists: true,
      projectName: "Live URL Direct Mode",
      projectType: "Universal Web Service",
      docFiles: [],
      sourceSummary: "로컬 소스코드 의존성 없이 실시간 웹 URL과 자연어 프롬프트만으로 동작합니다.",
    };
  }

  if (!fs.existsSync(p)) {
    return {
      path: p,
      exists: false,
      projectName: path.basename(p) || "Unknown",
      projectType: "경로가 존재하지 않음",
      docFiles: [],
      sourceSummary: "지정된 폴더를 찾을 수 없습니다. 경로를 확인하거나 비워두세요.",
    };
  }

  const projectName = path.basename(p);
  const docFiles: string[] = [];

  // Check for markdown documentation (agyDocs, docs, root)
  const candidateDocDirs = [path.join(p, "agyDocs"), path.join(p, "docs"), p];
  for (const dir of candidateDocDirs) {
    if (!fs.existsSync(dir)) continue;
    try {
      const files = fs.readdirSync(dir);
      for (const file of files) {
        if (file.endsWith(".md") && !docFiles.includes(file)) {
          docFiles.push(file);
        }
      }
    } catch {}
  }

  // Detect project type
  let projectType = "일반 웹 프로젝트";
  let sourceSummary = "";

  const hasNaonWeb = fs.existsSync(path.join(p, "naon-module-web")) || fs.existsSync(path.join(p, "src", "main", "webapp"));
  const hasNext = fs.existsSync(path.join(p, "next.config.js")) || fs.existsSync(path.join(p, "next.config.mjs")) || fs.existsSync(path.join(p, "next.config.ts"));
  const hasVite = fs.existsSync(path.join(p, "vite.config.ts")) || fs.existsSync(path.join(p, "vite.config.js"));
  const hasReact = fs.existsSync(path.join(p, "package.json")) && !hasNext && !hasVite;

  if (hasNaonWeb) {
    projectType = "Naon/Spring 그룹웨어 웹 애플리케이션";
    sourceSummary = "JSP, JS, Mustache 템플릿 및 엔터프라이즈 모듈 구조 감지됨";
  } else if (hasNext) {
    projectType = "Next.js 애플리케이션";
    sourceSummary = "App Router 또는 Pages Router 감지됨";
  } else if (hasVite) {
    projectType = "Vite (React/Vue) 애플리케이션";
    sourceSummary = "SPA 컴포넌트 구조 감지됨";
  } else if (hasReact) {
    projectType = "React / Node.js 애플리케이션";
    sourceSummary = "package.json 기반 프로젝트";
  } else {
    sourceSummary = "웹 소스 및 문서 파일 탐색 가능";
  }

  return {
    path: p,
    exists: true,
    projectName,
    projectType,
    docFiles,
    sourceSummary,
  };
}

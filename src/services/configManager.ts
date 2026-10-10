import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";

dotenv.config({ override: true });

const ENV_FILE_PATH = path.resolve(__dirname, "..", "..", ".env");

export interface StudioConfig {
  targetProjectPath: string;
  targetBaseUrl: string;
  geminiModel: string;
}

// In-memory runtime config, initialized from .env or defaults
let currentConfig: StudioConfig = {
  targetProjectPath: process.env.TARGET_PROJECT_PATH || "",
  targetBaseUrl: process.env.TARGET_BASE_URL || "https://gwdev.unison.co.kr",
  geminiModel: process.env.GEMINI_MODEL || "gemini-3.8-flash",
};

export interface ProjectAnalysis {
  path: string;
  exists: boolean;
  projectName: string;
  projectType: string;
  docFiles: string[];
  sourceSummary: string;
}

export function getConfig(): StudioConfig {
  return { ...currentConfig };
}

export function updateConfig(newConfig: Partial<StudioConfig>): StudioConfig {
  if (newConfig.targetProjectPath !== undefined) {
    currentConfig.targetProjectPath = newConfig.targetProjectPath.trim().replace(/\\/g, "/");
  }
  if (newConfig.targetBaseUrl !== undefined) {
    currentConfig.targetBaseUrl = newConfig.targetBaseUrl.trim();
  }
  if (newConfig.geminiModel !== undefined) {
    currentConfig.geminiModel = newConfig.geminiModel.trim();
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

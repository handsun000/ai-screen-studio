import { GoogleGenAI } from "@google/genai";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
import type { BrowsePlan } from "../types";
import { getConfig } from "./configManager";
import { MASTER_DIRECTING_GUIDELINES } from "./tutorialTemplates";

dotenv.config();

const API_KEY = process.env.GEMINI_API_KEY || "";
const MODEL_NAME = process.env.GEMINI_MODEL || "gemini-3.8-flash";

export interface GeneratePlanOptions {
  prompt: string;
  slug?: string;
  moduleHint?: string;
  targetProjectPath?: string;
  targetUrl?: string;
  directingStyle?: "standard" | "fast" | "detailed";
}

/**
 * Searches the target project (dynamically configured) for:
 * 1. Relevant Markdown documentation (e.g. agyDocs/tutorial_scenarios.md, docs/*.md)
 * 2. Relevant source files (JSP, JS, TSX, Vue, HTML) matching prompt keywords
 */
export function scanTargetProjectContext(prompt: string, targetPath?: string): string {
  const contextSnippets: string[] = [];
  const projectRoot = (targetPath || getConfig().targetProjectPath).trim().replace(/\\/g, "/");

  if (!fs.existsSync(projectRoot)) {
    return `[알림] 타겟 프로젝트 경로를 찾을 수 없습니다: ${projectRoot}`;
  }

  // --- 1. Scan Documentation (agyDocs, docs, root *.md) ---
  const docDirs = [path.join(projectRoot, "agyDocs"), path.join(projectRoot, "docs"), projectRoot];
  const promptKeywords = prompt
    .split(/[\s,()_+/]+/)
    .map((k) => k.trim())
    .filter((k) => k.length >= 2);

  for (const dir of docDirs) {
    if (!fs.existsSync(dir)) continue;
    try {
      const files = fs.readdirSync(dir);
      for (const file of files) {
        if (!file.endsWith(".md")) continue;
        const filePath = path.join(dir, file);
        if (!fs.statSync(filePath).isFile()) continue;

        const content = fs.readFileSync(filePath, "utf-8");
        const lines = content.split("\n");

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const hasMatch = promptKeywords.some((kw) => line.includes(kw));
          if (hasMatch) {
            const start = Math.max(0, i - 3);
            const end = Math.min(lines.length, i + 20);
            contextSnippets.push(
              `[참조 문서: ${path.basename(dir)}/${file} (L${start + 1}-${end})]\n` +
                lines.slice(start, end).join("\n")
            );
            i = end; // skip ahead to avoid overlapping duplicates
            if (contextSnippets.length >= 4) break;
          }
        }
      }
    } catch {}
  }

  // --- 2. Scan Source Code Directories ---
  // Detect candidate source root dirs
  const candidateSourceDirs = [
    path.join(projectRoot, "naon-module-web", "src", "main", "webapp", "jsp", "biz"),
    path.join(projectRoot, "src", "main", "webapp", "jsp"),
    path.join(projectRoot, "src", "pages"),
    path.join(projectRoot, "src", "app"),
    path.join(projectRoot, "src", "views"),
    path.join(projectRoot, "src", "components"),
    path.join(projectRoot, "public"),
    path.join(projectRoot, "views"),
  ];

  let activeSourceRoot = candidateSourceDirs.find((d) => fs.existsSync(d));

  if (activeSourceRoot) {
    try {
      // Find files matching keywords
      const scanDirRecursively = (dir: string, depth = 0): string[] => {
        if (depth > 4) return [];
        const result: string[] = [];
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            result.push(...scanDirRecursively(fullPath, depth + 1));
          } else if (
            entry.isFile() &&
            (entry.name.endsWith(".jsp") ||
              entry.name.endsWith(".js") ||
              entry.name.endsWith(".vue") ||
              entry.name.endsWith(".tsx") ||
              entry.name.endsWith(".html"))
          ) {
            result.push(fullPath);
          }
        }
        return result;
      };

      const allFiles = scanDirRecursively(activeSourceRoot);

      // Prioritize files whose path or name contains any keyword
      const matchedFiles = allFiles
        .filter((fp) => {
          const lower = fp.toLowerCase();
          return promptKeywords.some((kw) => lower.includes(kw.toLowerCase()));
        })
        .slice(0, 5);

      const filesToInspect =
        matchedFiles.length > 0 ? matchedFiles : allFiles.slice(0, 3);

      for (const filePath of filesToInspect) {
        const content = fs.readFileSync(filePath, "utf-8");
        const relPath = path.relative(projectRoot, filePath);

        const idMatches = content.match(/id=["']([a-zA-Z0-9_\-]+)["']/g) || [];
        const classMatches = content.match(/class=["']([a-zA-Z0-9_\-\s]+)["']/g) || [];
        const btnMatches = content.match(/<button[^>]*>.*?<\/button>/gi) || [];
        const inputMatches = content.match(/<input[^>]*>/gi) || [];

        const snippet = [
          `[소스 파일: ${relPath}]`,
          idMatches.length > 0 ? `Key IDs: ${idMatches.slice(0, 10).join(", ")}` : "",
          classMatches.length > 0 ? `Key Classes: ${classMatches.slice(0, 10).join(", ")}` : "",
          btnMatches.length > 0
            ? `Buttons: ${btnMatches.slice(0, 5).join(" | ").replace(/<[^>]+>/g, " ")}`
            : "",
          inputMatches.length > 0
            ? `Inputs: ${inputMatches.slice(0, 5).join(" | ").replace(/<[^>]+>/g, " ")}`
            : "",
        ]
          .filter(Boolean)
          .join("\n");

        contextSnippets.push(snippet);
      }
    } catch (e) {
      // Ignore directory scan errors
    }
  }

  return contextSnippets.length > 0
    ? contextSnippets.join("\n\n---\n\n")
    : `[기본 정보] 타겟 프로젝트 (${path.basename(projectRoot)}) 감지 완료.`;
}

/**
 * Loads verified examples from data/ directory to provide as few-shot training.
 */
function loadFewShotExamples(): string {
  const dataDir = path.resolve(__dirname, "..", "..", "data");
  const examples: string[] = [];

  const sampleSlugs = ["approval-draft", "menu-guide-and-notification"];
  for (const slug of sampleSlugs) {
    const planPath = path.join(dataDir, slug, "browse-plan.json");
    if (fs.existsSync(planPath)) {
      try {
        const content = fs.readFileSync(planPath, "utf-8");
        const parsed = JSON.parse(content);
        const summary = {
          name: slug,
          sampleActions: (parsed.actions || []).slice(0, 5),
        };
        examples.push(`[검증된 예시 시나리오: ${slug}]\n` + JSON.stringify(summary, null, 2));
      } catch {}
    }
  }

  return examples.join("\n\n");
}

/**
 * Generates BrowsePlan using Google AI Studio Gemini API with dynamic project & URL awareness.
 */
export async function generateBrowsePlanWithGemini(
  options: GeneratePlanOptions
): Promise<{ plan: BrowsePlan; explanation: string; suggestedSlug: string }> {
  const apiKeys = [
    process.env.GEMINI_API_KEY,
    process.env.GEMINI_API_KEY_ALT,
  ].filter(Boolean) as string[];

  if (apiKeys.length === 0) {
    throw new Error("GEMINI_API_KEY가 .env 또는 시스템 환경변수에 설정되어 있지 않습니다.");
  }

  const currentConfig = getConfig();
  const effectiveTargetPath = options.targetProjectPath || currentConfig.targetProjectPath;
  const effectiveTargetUrl = options.targetUrl || currentConfig.targetBaseUrl;

  const codeContext = scanTargetProjectContext(options.prompt, effectiveTargetPath);
  const fewShotContext = loadFewShotExamples();
  const systemInstruction = `
${MASTER_DIRECTING_GUIDELINES}

---

### [4] 타겟 실행 환경 정보 (Current Target System Information)
- 타겟 서비스 웹 URL: ${effectiveTargetUrl}
- 타겟 프로젝트 로컬 경로: ${effectiveTargetPath}

### [5] 검증된 레퍼런스 시나리오 패턴 (Verified Reference Examples)
${fewShotContext}

### [6] 타겟 프로젝트에서 실시간 스캔된 컨텍스트 (Scanned Project Context, if any)
${codeContext}
`;

  const userContent = `
User Scenario Request: "${options.prompt}"
Requested Slug: ${options.slug || "auto-generate"}
Target URL: ${effectiveTargetUrl}
Directing Style: ${options.directingStyle || "standard"} (${
  options.directingStyle === "fast"
    ? "Fast showcase pacing: 1200ms-1800ms wait intervals"
    : options.directingStyle === "detailed"
    ? "Detailed manual pacing: 3500ms-4500ms wait intervals"
    : "Standard educational pacing: 2500ms-3500ms wait intervals"
})

Strictly follow the 5-phase video directing framework (Phase 1 Lead-in -> Phase 2 Intentional Navigation -> Phase 3 Interaction -> Phase 4 Action Execution -> Phase 5 Outcome Review).

Generate a complete BrowsePlan JSON structure that satisfies this scenario.
The response must be valid JSON with this exact schema:
{
  "suggestedSlug": "kebab-case-slug-name",
  "explanation": "Brief Korean explanation of what this scenario covers",
  "plan": {
    "url": "${effectiveTargetUrl}",
    "viewport": { "width": 1920, "height": 1080 },
    "requiresLogin": true,
    "cursor": { "delayMs": 800, "preClickRestMs": 180 },
    "actions": [
      {
        "type": "wait" | "click" | "hover" | "type" | "dblclick" | "scroll" | "navigate",
        "selector": "css selector string (if applicable)",
        "iframe": "iframe selector string (if applicable)",
        "text": "text to type (if type action)",
        "ms": 2000,
        "description": "한글 설명",
        "optional": false,
        "force": false
      }
    ]
  }
}
`;

  const configuredModel = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";
  const candidateModels = Array.from(
    new Set([
      configuredModel,
      "gemini-3.5-flash-lite",
      "gemini-2.5-flash-lite",
      "gemini-flash-latest",
      "gemini-3.5-flash",
      "gemini-2.5-flash",
    ])
  );

  let responseText = "";
  let lastError: any = null;

  outerLoop:
  for (const model of candidateModels) {
    for (const key of apiKeys) {
      try {
        console.log(`[Gemini] Attempting generation with model "${model}"...`);
        const ai = new GoogleGenAI({ apiKey: key });
        const response = await ai.models.generateContent({
          model,
          contents: userContent,
          config: {
            systemInstruction,
            responseMimeType: "application/json",
            temperature: 0.2,
          },
        });
        if (response.text && response.text.trim().length > 0) {
          responseText = response.text;
          console.log(`[Gemini] Successfully generated plan with model "${model}"!`);
          break outerLoop;
        }
      } catch (err: any) {
        lastError = err;
        const msg = err.message || (typeof err === "string" ? err : JSON.stringify(err));
        console.warn(`[Gemini] Model "${model}" failed (status: ${err.status || "err"}): ${msg.substring(0, 100)}`);
      }
    }
  }

  if (!responseText && lastError) {
    throw new Error(`모든 Gemini 모델 및 API 키 호출이 실패했습니다. (마지막 에러: ${lastError.message || lastError.status || "오류"})`);
  }

  let parsed: any;
  try {
    parsed = JSON.parse(responseText);
  } catch (err) {
    throw new Error(`Gemini 응답 JSON 파싱 실패: ${responseText.substring(0, 200)}`);
  }

  const suggestedSlug =
    options.slug ||
    parsed.suggestedSlug ||
    "scenario-" + Date.now().toString(36);

  return {
    plan: parsed.plan,
    explanation: parsed.explanation || "시나리오가 성공적으로 생성되었습니다.",
    suggestedSlug: suggestedSlug.replace(/[^a-zA-Z0-9_\-]/g, "-").toLowerCase(),
  };
}


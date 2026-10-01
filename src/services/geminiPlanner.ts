import { GoogleGenAI } from "@google/genai";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
import type { BrowsePlan } from "../types";
import { getConfig } from "./configManager";
import { MASTER_DIRECTING_GUIDELINES } from "./tutorialTemplates";
import { exploreCodebaseForActionSpec, ActionSpecResult } from "./codeExplorerAgent";
import { getCachedPlan, setCachedPlan } from "./aiCacheManager";
import { sanitizeBrowsePlan } from "./planSanitizer";

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
  bypassCache?: boolean;
  onProgress?: (message: string) => void;
}

export interface GeneratePlanResult {
  plan: BrowsePlan;
  explanation: string;
  suggestedSlug: string;
  actionSpecMarkdown?: string;
  actionSpec?: ActionSpecResult;
  isFromCache?: boolean;
  cachedAt?: string;
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

  // --- 2. Scan Source Code & JavaScript Controllers ---
  // Detect candidate source root dirs (including JS resources and JSP)
  const candidateSourceDirs = [
    path.join(projectRoot, "naon-module-web", "src", "main", "webapp", "resources", "biz"),
    path.join(projectRoot, "naon-module-web", "src", "main", "webapp", "jsp", "biz"),
    path.join(projectRoot, "src", "main", "webapp", "resources", "biz"),
    path.join(projectRoot, "src", "main", "webapp", "jsp"),
    path.join(projectRoot, "src", "pages"),
    path.join(projectRoot, "src", "app"),
    path.join(projectRoot, "src", "views"),
    path.join(projectRoot, "src", "components"),
    path.join(projectRoot, "public"),
    path.join(projectRoot, "views"),
  ];

  const activeSourceRoots = candidateSourceDirs.filter((d) => fs.existsSync(d));

  if (activeSourceRoots.length > 0) {
    try {
      // Map prompt keywords to Naon/Enterprise modules for direct fast lookup
      const moduleKeywordMap: Record<string, string[]> = {
        app: ["결재", "기안", "상신", "전자결재"],
        doc: ["문서", "문서함", "문서관리"],
        board: ["게시", "게시판", "게시글"],
        schedule: ["일정", "캘린더", "일정관리"],
        work: ["업무", "태스크", "스마트워크"],
        note: ["쪽지", "메시지"],
        organization: ["조직도", "사용자", "부서"],
        project: ["프로젝트"],
      };

      const matchedModules = Object.entries(moduleKeywordMap)
        .filter(([_, kws]) => kws.some((kw) => prompt.includes(kw)))
        .map(([mod]) => mod);

      // Target specific module directories directly for instant lookup
      const specificModuleDirs: string[] = [];
      for (const mod of matchedModules) {
        specificModuleDirs.push(
          path.join(projectRoot, "naon-module-web", "src", "main", "webapp", "resources", "biz", "gw", mod),
          path.join(projectRoot, "naon-module-web", "src", "main", "webapp", "jsp", "biz", "gw", mod)
        );
      }
      const existingSpecificDirs = specificModuleDirs.filter((d) => fs.existsSync(d));
      const rootsToScan = existingSpecificDirs.length > 0 ? existingSpecificDirs : activeSourceRoots.slice(0, 2);

      // Find files matching keywords recursively with limit
      const scanDirRecursively = (dir: string, depth = 0): string[] => {
        if (depth > 3) return [];
        const result: string[] = [];
        try {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const entry of entries) {
            if (result.length >= 25) break;
            if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "dist") continue;
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
        } catch {}
        return result;
      };

      const allFiles: string[] = [];
      for (const root of rootsToScan) {
        allFiles.push(...scanDirRecursively(root));
        if (allFiles.length >= 25) break;
      }

      // Prioritize files whose path or name contains any keyword
      const matchedFiles = allFiles
        .filter((fp) => {
          const lower = fp.toLowerCase();
          return promptKeywords.some((kw) => lower.includes(kw.toLowerCase()));
        })
        .slice(0, 6);

      const filesToInspect = matchedFiles.length > 0 ? matchedFiles : allFiles.slice(0, 3);
      const validationHints: string[] = [];

      for (const filePath of filesToInspect) {
        const content = fs.readFileSync(filePath, "utf-8");
        const relPath = path.relative(projectRoot, filePath);
        const isJs = filePath.endsWith(".js") || filePath.endsWith(".tsx") || filePath.endsWith(".ts");

        const idMatches = content.match(/id=["']([a-zA-Z0-9_\-]+)["']/g) || [];
        const classMatches = content.match(/class=["']([a-zA-Z0-9_\-\s]+)["']/g) || [];
        const btnMatches = content.match(/<button[^>]*>.*?<\/button>/gi) || [];
        const inputMatches = content.match(/<input[^>]*>/gi) || [];

        // Scan JS validation alerts and required checks
        if (isJs) {
          const lines = content.split("\n");
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (
              line.includes("alert") ||
              line.includes("validate") ||
              line.includes("chkValid") ||
              line.includes("checkLine") ||
              line.includes("required")
            ) {
              const trimmed = line.trim();
              if (
                trimmed.includes("/*") ||
                trimmed.includes("//") ||
                trimmed.toLowerCase().includes("title") ||
                trimmed.toLowerCase().includes("line") ||
                trimmed.toLowerCase().includes("subject")
              ) {
                validationHints.push(`[${path.basename(filePath)} L${i + 1}] ${trimmed.slice(0, 120)}`);
                if (validationHints.length >= 8) break;
              }
            }
          }
        }

        const snippet = [
          `[소스 파일: ${relPath}]`,
          idMatches.length > 0 ? `Key IDs: ${idMatches.slice(0, 8).join(", ")}` : "",
          classMatches.length > 0 ? `Key Classes: ${classMatches.slice(0, 8).join(", ")}` : "",
          btnMatches.length > 0
            ? `Buttons: ${btnMatches.slice(0, 4).join(" | ").replace(/<[^>]+>/g, " ")}`
            : "",
          inputMatches.length > 0
            ? `Inputs: ${inputMatches.slice(0, 4).join(" | ").replace(/<[^>]+>/g, " ")}`
            : "",
        ]
          .filter(Boolean)
          .join("\n");

        contextSnippets.push(snippet);
      }

      if (validationHints.length > 0) {
        contextSnippets.unshift(
          `[🚨 감지된 자바스크립트 폼 유효성 검사 및 필수 전제조건 (반드시 시나리오 상신/제출 전에 채울 것)]:\n` +
            validationHints.join("\n")
        );
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
 * Provides the complete, realistic multi-step sequences so Gemini learns authentic enterprise flows.
 */
function loadFewShotExamples(): string {
  const dataDir = path.resolve(__dirname, "..", "..", "data");
  const examples: string[] = [];

  const sampleSlugs = ["create-and-submit", "approval-draft", "menu-guide-and-notification"];
  for (const slug of sampleSlugs) {
    const planPath = path.join(dataDir, slug, "browse-plan.json");
    if (fs.existsSync(planPath)) {
      try {
        const content = fs.readFileSync(planPath, "utf-8");
        const parsed = JSON.parse(content);
        // Clean actions to essential compact form, but preserve ALL workflow steps (no slicing!)
        const compactActions = (parsed.actions || []).map((a: any) => {
          const act: Record<string, any> = {
            type: a.type,
            description: a.description,
          };
          if (a.selector) act.selector = a.selector;
          if (a.iframe) act.iframe = a.iframe;
          if (a.text) act.text = a.text;
          if (a.ms) act.ms = a.ms;
          if (a.optional) act.optional = a.optional;
          if (a.deltaY) act.deltaY = a.deltaY;
          return act;
        });

        const summary = {
          name: slug,
          totalActions: compactActions.length,
          note: slug === "approval-draft" ? "전자결재 폼 작성 표준 흐름: 양식선택 -> 제목입력 -> 조직도/결재선 지정 -> 본문작성 -> 상신 및 확인" : "GNB 및 메뉴 알림 투어 흐름",
          actions: compactActions,
        };
        examples.push(`[검증된 완전한 레퍼런스 시나리오: ${slug}]\n` + JSON.stringify(summary, null, 2));
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
): Promise<GeneratePlanResult> {
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

  // --- Check Smart AI Plan Cache (Token-Saving Layer) ---
  if (!options.bypassCache) {
    const cached = getCachedPlan(
      options.prompt,
      effectiveTargetPath,
      effectiveTargetUrl,
      options.directingStyle
    );
    if (cached) {
      options.onProgress?.(`⚡ [캐시 적중 (Cache Hit)] 동일한 질문에 대한 AI 분석 결과가 보관되어 있습니다. Gemini 호출을 생략하고 0.05초 만에 즉시 불러옵니다! (토큰 소모: 0)`);
      return {
        ...cached,
        suggestedSlug: options.slug || cached.suggestedSlug,
      };
    }
  }

  // --- Stage 1: Autonomous Code Explorer Agent ---
  let actionSpecResult: ActionSpecResult | null = null;
  try {
    options.onProgress?.(`🔍 [1단계: 소스코드 자율 탐색] 프로젝트 소스코드 및 DOM 구조를 분석합니다...`);
    actionSpecResult = await exploreCodebaseForActionSpec(
      options.prompt,
      effectiveTargetPath,
      options.onProgress
    );
    options.onProgress?.(`📝 [1단계 완료] 화면 조작 기획서(Action Spec) 작성 완료. 식별된 셀렉터 ${actionSpecResult.identifiedSelectors.length}개`);
  } catch (err: any) {
    options.onProgress?.(`⚠️ [1단계 알림] 자율 탐색 실패/건너뜀 (${err.message}). 기본 정적 스캔으로 대체합니다.`);
  }

  // --- Stage 2: Video Directing Planner ---
  options.onProgress?.(`🎬 [2단계: 영상 연출 플래너] 5단계 템포 및 카메라 줌 플랜을 수립 중입니다...`);

  const codeContext = scanTargetProjectContext(options.prompt, effectiveTargetPath);
  const fewShotContext = loadFewShotExamples();
  const actionSpecSection = actionSpecResult?.actionSpecMarkdown
    ? `### [5] 1단계 코드 탐색 에이전트가 소스코드에서 직접 추출한 [화면 조작 기획서 (Action Spec)]\n아래 기획서에 식별된 실제 DOM 셀렉터, 유효성 검사 alert 방지 조건, 필수 입력 필드를 반드시 반영하여 실행 가능한 Playwright 액션들을 구성하세요:\n\n${actionSpecResult.actionSpecMarkdown}`
    : `### [5] 타겟 프로젝트에서 실시간 스캔된 컨텍스트\n${codeContext}`;

  const systemInstruction = `
${MASTER_DIRECTING_GUIDELINES}

---

### [4] 타겟 실행 환경 정보 (Current Target System Information)
- 타겟 서비스 웹 URL: ${effectiveTargetUrl}
- 타겟 프로젝트 로컬 경로: ${effectiveTargetPath}

${actionSpecSection}

### [6] 검증된 레퍼런스 시나리오 패턴 (Verified Reference Examples)
${fewShotContext}
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

  // --- Stage 3: Intelligent Plan Sanitization & Auto-Correction ---
  const { plan: sanitizedPlan, report } = sanitizeBrowsePlan(parsed.plan);
  if (report.fixedActionsCount > 0 || report.removedActionsCount > 0) {
    options.onProgress?.(`🛡️ [AI 플랜 자동 교정] 위험 요소 ${report.removedActionsCount}개 제거, 셀렉터 ${report.fixedActionsCount}개 모달 스코프 강화 완료!`);
    report.changes.forEach((c) => options.onProgress?.(`  ${c}`));
  }

  const suggestedSlug =
    options.slug ||
    parsed.suggestedSlug ||
    "scenario-" + Date.now().toString(36);

  const finalResult: GeneratePlanResult = {
    plan: sanitizedPlan,
    explanation: parsed.explanation || "시나리오가 성공적으로 생성되었습니다.",
    suggestedSlug: suggestedSlug.replace(/[^a-zA-Z0-9_\-]/g, "-").toLowerCase(),
    actionSpecMarkdown: actionSpecResult?.actionSpecMarkdown,
    actionSpec: actionSpecResult || undefined,
    isFromCache: false,
  };

  // Save to cache for future identical requests (token saver)
  try {
    setCachedPlan(
      options.prompt,
      effectiveTargetPath,
      effectiveTargetUrl,
      options.directingStyle,
      finalResult
    );
  } catch {}

  return finalResult;
}


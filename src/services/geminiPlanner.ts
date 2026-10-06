import { GoogleGenAI } from "@google/genai";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
import type { BrowsePlan } from "../types";
import { getConfig } from "./configManager";
import { MASTER_DIRECTING_GUIDELINES } from "./tutorialTemplates";
import {
  createCodeExplorerTools,
  codeExplorerToolDeclarations,
  ActionSpecResult,
} from "./codeExplorerAgent";
import { getCachedPlan, setCachedPlan } from "./aiCacheManager";
import { sanitizeBrowsePlan } from "./planSanitizer";

dotenv.config({ override: true });

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
        eapp: ["결재", "기안", "상신", "전자결재"],
        doc: ["문서", "문서함", "문서관리"],
        board: ["게시", "게시판", "게시글"],
        schedule: ["일정", "캘린더", "일정관리"],
        scd: ["일정", "캘린더", "일정관리"],
        work: ["업무", "태스크", "스마트워크"],
        smw: ["업무", "태스크", "스마트워크"],
        note: ["쪽지", "메시지"],
        not: ["쪽지", "메시지"],
        organization: ["조직도", "사용자", "부서"],
        project: ["프로젝트"],
        search: ["검색", "통합검색", "조회", "찾기"],
        mail: ["메일", "웹메일", "편지"],
        eml: ["메일", "웹메일", "편지"],
        res: ["자원", "예약", "회의실", "시설"],
        rmg: ["자원", "예약", "회의실", "시설"],
        attend: ["근태", "출퇴근", "휴가", "근무"],
        survey: ["설문", "투표", "조사"],
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
 * Safely parses and repairs JSON from Gemini response (handles markdown fences, unclosed strings/brackets from token limits).
 */
export function parseAndRepairJson(raw: string): any {
  let cleaned = raw.trim();

  // 1. Strip markdown fences if present
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  }

  // 2. Extract outermost JSON object
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  }

  // 3. First attempt: standard parse
  try {
    return JSON.parse(cleaned);
  } catch (firstErr: any) {
    // 4. Second attempt: Auto-repair cut-off JSON strings/brackets
    let repaired = cleaned;
    const quotes = (repaired.match(/(?<!\\)"/g) || []).length;
    if (quotes % 2 !== 0) {
      repaired += '"';
    }

    let openBrackets = (repaired.match(/\[/g) || []).length;
    let closeBrackets = (repaired.match(/\]/g) || []).length;
    while (openBrackets > closeBrackets) {
      repaired += "]";
      closeBrackets++;
    }

    let openBraces = (repaired.match(/\{/g) || []).length;
    let closeBraces = (repaired.match(/\}/g) || []).length;
    while (openBraces > closeBraces) {
      repaired += "}";
      closeBraces++;
    }

    try {
      return JSON.parse(repaired);
    } catch {
      throw firstErr;
    }
  }
}

/**
 * Generates BrowsePlan using Google AI Studio Gemini API with unified, autonomous code exploration.
 * Inspects source code directly via function calling tools and outputs the final BrowsePlan JSON in a single session.
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

  options.onProgress?.(`🚀 [통합 AI 디렉터] 소스코드 역공학 탐색 및 5단계 영상 연출 플랜 수립을 시작합니다...`);

  // --- Initialize Autonomous Code Explorer Tools for Target Project ---
  const toolExecutors = createCodeExplorerTools(effectiveTargetPath);
  const toolDeclarations = codeExplorerToolDeclarations;
  const toolActivityLogs: string[] = [];

  const codeContext = scanTargetProjectContext(options.prompt, effectiveTargetPath);
  const fewShotContext = loadFewShotExamples();

  const systemInstruction = `
당신은 웹 애플리케이션의 소스코드를 직접 역공학(Reverse Engineering)하여,
5단계 고품질 비디오 자동화 브라우징 플랜(BrowsePlan JSON)을 기획하는 전문 통합 AI 디렉터입니다.
웹의 모든 메뉴와 기능(통합검색, 전자결재, 문서관리, 게시판, 메일, 일정관리 등)에 대해 보편적이고 정확한 플랜을 수립해야 합니다.

${MASTER_DIRECTING_GUIDELINES}

---

### [4] 타겟 실행 환경 정보 (Current Target System Information)
- 타겟 서비스 웹 URL: ${effectiveTargetUrl}
- 타겟 프로젝트 로컬 경로: ${effectiveTargetPath}

### [5] 타겟 프로젝트 기본 사전 감지 컨텍스트
${codeContext}

### [6] 검증된 레퍼런스 시나리오 패턴 (Verified Reference Examples)
${fewShotContext}

---

### [7] 🚨 소스코드 정밀 역공학 및 도구(Tools) 활용 원칙
1. **도구 활용 (searchCodeText, findFiles, readSourceSnippet, extractAlertsAndValidation)**:
   - 사용자가 요청한 업무 기능(통합검색, 전자결재, 문서관리, 게시판, 메일, 일정관리 등)의 소스코드에서 실제 버튼 ID, 폼 필드 태그, 필수 유효성 검사 alert 조건을 능동적으로 탐색하십시오.
   - 대상 화면의 트리거 버튼이나 저장/검색 버튼의 정확한 셀렉터를 모를 경우 반드시 searchCodeText 또는 findFiles를 호출하여 확인하십시오.
2. **다중 버튼 충돌 방지 및 영역 스코핑**:
   - '저장', '등록', '확인', '닫기', '검색' 등은 화면 여러 곳(헤더, 사이드바, 본문, 팝업 모달)에 동시에 존재할 수 있습니다.
   - 모달 팝업 내부의 버튼은 반드시 \`.ui-dialog:visible button:has-text('저장')\` 또는 \`.ui-dialog:visible #savebtn\`처럼 모달 범위를 한정하십시오.
   - 사이드바 버튼은 \`#snb\`, 헤더 버튼은 \`header\` 접두사를 붙여서 특정 버튼을 100% 명확히 가리키십시오.
3. **가상 ID 절대 금지 및 모르면 비워두기 (Zero-Guessing Policy)**:
   - 소스코드에 없거나 확인되지 않은 임의의 영어 ID(#search_box_input, #btn_save_dialog 등)를 절대로 지어내지 마십시오!
   - 한글 텍스트 매칭(예: \`button:has-text("등록"):visible\`)이 확실한 경우는 텍스트 매칭을 사용하십시오.
   - 텍스트 매칭조차 불확실하거나 소스코드에서 확정할 수 없는 인터랙티브 요소는 **\`"selector": ""\` (빈 문자열)로 비워두십시오!**
   - 비워둔 항목은 JSON의 \`explanation\` 필드에 사용자가 대시보드 에디터에서 직접 입력해야 하는 항목을 친절히 안내하십시오.
4. **포탈 전체메뉴(서랍) 내 숨겨진 하위 메뉴 탐색 원칙**:
   - 엔터프라이즈 포탈 메인 화면에서 세부 업무 메뉴(일정관리, 전자결재, 문서관리, 게시판 등)가 상단 바에 직접 노출되어 있지 않은 경우,
     반드시 [포탈 전체메뉴(button.btn_svc_open) 클릭] -> [1200ms 펼침 대기] -> [서랍 내 목표 메뉴(#svc_box a:has-text('...')) 클릭] 시퀀스를 준수하십시오.
5. **모든 업무 기능(설문, 프로젝트, 주소록, 근태, 문서, 결재, 일정, 예약 등) 등록/작성 고유 필수 조건 전수 충족 지침 (Dynamic Zero-Validation-Failure Policy)**:
   - 사용자가 요청하는 기능은 문서/결재/일정뿐만 아니라 설문조사 작성, 프로젝트 생성, 주소록 연락처 추가, 근태 연차신청, 시설/자원 예약, 업무일지 등록, 회원 가입, 관리자 설정 등 시스템의 모든 기능이 대상이 됩니다.
   - 각 기능마다 화면 구조와 필수 조건(Validation Alert)이 완전히 다릅니다. 따라서 어떤 시나리오든 고정된 단계를 억지로 끼워 넣지 말고, **반드시 도구(findFiles, searchCodeText, readSourceSnippet, extractAlertsAndValidation)를 호출하여 해당 기능의 실제 소스코드(JSP/JS)와 유효성 검사 alert 목록을 능동적으로 역공학 탐색**하십시오.
   - [🚨 절대 금지]: 필수 조건을 생략하고 곧바로 저장 버튼을 누르지 마십시오. (브라우저 유효성 검사 alert 창이 떠서 시연이 중단됩니다.)
   - 소스코드에 정의된 실제 필수 조건(예: alert("...를 입력하세요", "...를 선택하세요"))을 빠짐없이 확인하고, 그 기능이 요구하는 필수 값들을 시나리오 단계에서 모두 거친 뒤 최종 저장/완료 버튼을 클릭하도록 100% 동적으로 플랜을 수립해야 합니다.
   - 📄 **문서 등록 (4단계 필수 시퀀스)**: 좌측 [문서 등록] 버튼 클릭 ➔ '문서함 선택' 모달 팝업 열림 대기(1500ms) ➔ 팝업 내 실제 등록 대상 문서함(말단 리프 노드) 클릭(".ui-dialog:visible .dynatree-container .dynatree-node:not(.dynatree-folder) a.dynatree-title:visible, .ui-dialog:visible .dynatree-container li:not(:has(ul)) a.dynatree-title:visible, .ui-dialog:visible .dynatree-container li:last-child a.dynatree-title:visible") ➔ 팝업 [확인] 버튼 클릭(".ui-dialog:visible .ui-dialog-buttonpane button:has-text('확인'):visible")하여 모달 닫기 ➔ 본문 등록 폼 렌더링 후 제목 입력 ➔ 본문 내용 작성 ➔ 상단 [저장] 클릭! (절대로 등록 불가한 최상위 부모 폴더 노드를 선택하지 마십시오!)
   - 모든 필수 조건이 입력/선택된 후에 최종 [저장/상신/등록] 버튼을 클릭하고 브라우저 확인(Confirm) 다이얼로그를 승인해야 합니다.
6. **실제 DB 데이터 기반 검색 및 조회 연동 (Method 2: Zero-Hallucinated-Data Policy)**:
   - **[🚨 검색/조회 목적 시나리오에 불필요한 신규 등록 단계 생성 엄격 금지]**:
     사용자의 요청 의도가 '조회', '검색', '확인', '열람', '상세보기'인 경우, 시나리오 앞부분에 불필요하게 [신규 등록/작성] 버튼을 눌러 가상 제목과 본문을 입력하고 저장하는 등록 단계를 절대로 끼워 넣지 마십시오!
     시연은 [목표 메뉴 이동] -> [분류/함 선택 및 목록 로딩 대기] -> [화면의 실제 DB 데이터 스크래핑 및 검색창 입력] -> [검색 실행] -> [해당 실제 데이터 클릭 상세 확인]의 순수 조회 파이프라인으로 구성해야 합니다.
   - **[🚨 가상 검색어/제목 날조 엄격 금지]**:
     절대로 '2026학년도 대학 혁신지원사업...', '테스트 기안서', '김철수' 같은 임의의 가상 검색어나 제목을 날조하여 고정하지 마십시오!
   - 검색창 입력('type') 액션에는 반드시:
     • \`"useScraped": "auto"\`
     • \`"dynamicStrategy": "first-row-title"\` (사원인 경우 "first-row-user")
     • \`"description": "화면 목록의 실제 데이터로 검색어 자동 연동 입력"\`
     • \`"text": "실시간 실제 목록 데이터"\`
     를 지정하여, Playwright 런타임이 화면에 실제로 렌더링된 첫 번째 글/문서/사원명을 스크래핑하여 타이핑하도록 하십시오.
   - 검색 결과 클릭 단계에도 \`"useScraped": "auto"\`를 지정하여 스크래핑된 실제 항목을 100% 매칭 클릭하도록 연결하십시오.
7. **최종 출력 규격**:
   - 소스코드 탐색이 완료되면, 중간 마크다운 설명서 없이 **곧바로 완전하고 유효한 BrowsePlan JSON 형식**으로만 응답하십시오.
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
Explore the source code if necessary using tools, then produce the complete BrowsePlan JSON structure that satisfies this scenario.

The final response must be valid JSON with this exact schema:
{
  "suggestedSlug": "kebab-case-slug-name",
  "explanation": "한글 시나리오 요약 및 [⚠️ 사용자 직접 입력 필요 항목 안내]",
  "plan": {
    "url": "${effectiveTargetUrl}",
    "viewport": { "width": 1920, "height": 1080 },
    "requiresLogin": true,
    "actions": [
      {
        "type": "wait" | "click" | "hover" | "type" | "dblclick" | "scroll" | "navigate",
        "selector": "css selector string (leave empty \"\" if unknown, user will input in dashboard)",
        "iframe": "iframe selector string (if applicable)",
        "text": "text to type (if type action)",
        "ms": 2000,
        "description": "한글 설명",
        "force": false
      }
    ]
  }
}
`;

  const configuredModel = process.env.GEMINI_MODEL || "gemini-3.8-flash";
  const candidateModels = Array.from(
    new Set([
      configuredModel,
      "gemini-3.8-flash",
      "gemini-3.5-flash",
      "gemini-3.5-flash-lite",
      "gemini-flash-latest",
    ])
  );

  let parsed: any = null;
  let lastError: any = null;

  modelLoop:
  for (const model of candidateModels) {
    for (const key of apiKeys) {
      try {
        console.log(`[Unified Gemini Director] Attempting with model "${model}"...`);
        const ai = new GoogleGenAI({ apiKey: key });

        const contents: any[] = [
          {
            role: "user",
            parts: [{ text: userContent }],
          },
        ];

        let turn = 0;
        const maxToolTurns = 3;

        while (turn < maxToolTurns) {
          turn++;
          const response = await ai.models.generateContent({
            model,
            contents,
            config: {
              systemInstruction,
              tools: [{ functionDeclarations: toolDeclarations as any }],
              temperature: 0.2,
              maxOutputTokens: 8192,
            },
          });

          const functionCalls = response.functionCalls;
          if (functionCalls && functionCalls.length > 0) {
            // Gemini called autonomous code exploration tools
            contents.push(response.candidates?.[0]?.content);

            for (const call of functionCalls) {
              const toolName = call.name as keyof typeof toolExecutors;
              const toolArgs = call.args as any;
              const logEntry = `🔧 [코드 탐색 ${turn}/${maxToolTurns}] ${toolName}(${JSON.stringify(toolArgs).slice(0, 50)}...)`;
              toolActivityLogs.push(logEntry);
              options.onProgress?.(logEntry);

              let toolResult: any;
              if (toolExecutors[toolName]) {
                toolResult = (toolExecutors[toolName] as any)(toolArgs);
              } else {
                toolResult = { error: `알 수 없는 도구: ${toolName}` };
              }

              contents.push({
                role: "user",
                parts: [
                  {
                    functionResponse: {
                      name: call.name,
                      response: toolResult,
                    },
                  },
                ],
              });
            }
          } else {
            // Gemini decided it has enough info and generated the final response directly
            const text = response.text || "";
            if (text.trim().length > 0) {
              try {
                parsed = parseAndRepairJson(text);
                console.log(`[Unified Gemini Director] Generated plan with model "${model}" in ${turn} turn(s)!`);
                break modelLoop;
              } catch (jsonErr: any) {
                console.warn(`[Unified Gemini Director] Model "${model}" produced unparseable JSON (${jsonErr.message}).`);
                lastError = jsonErr;
              }
            }
            break;
          }
        }

        // If tool turns completed and we need the final JSON plan
        if (!parsed) {
          options.onProgress?.(`🎬 [플랜 합성] 소스코드 탐색 결과를 종합하여 최종 5단계 BrowsePlan JSON을 작성 중입니다...`);
          contents.push({
            role: "user",
            parts: [
              {
                text: "소스코드 탐색이 완료되었습니다. 지금까지 탐색하고 확인된 소스코드 요소들을 바탕으로, 더 이상의 도구 호출 없이 최종 BrowsePlan JSON만을 즉시 산출하십시오.",
              },
            ],
          });

          const finalResponse = await ai.models.generateContent({
            model,
            contents,
            config: {
              systemInstruction,
              responseMimeType: "application/json",
              temperature: 0.2,
              maxOutputTokens: 8192,
            },
          });

          const finalText = finalResponse.text || "";
          if (finalText.trim().length > 0) {
            try {
              parsed = parseAndRepairJson(finalText);
              console.log(`[Unified Gemini Director] Successfully finalized JSON plan with model "${model}"!`);
              break modelLoop;
            } catch (jsonErr: any) {
              console.warn(`[Unified Gemini Director] Final JSON parse failed: ${jsonErr.message}`);
              lastError = jsonErr;
            }
          }
        }
      } catch (err: any) {
        lastError = err;
        const msg = err.message || (typeof err === "string" ? err : JSON.stringify(err));
        console.warn(`[Unified Gemini Director] Model "${model}" failed (status: ${err.status || "err"}): ${msg.substring(0, 100)}`);
      }
    }
    if (parsed) break;
  }


  if (!parsed) {
    throw new Error(`모든 Gemini 모델 및 API 키 호출이 실패했거나 유효한 JSON을 생성하지 못했습니다. (원인: ${lastError?.message || "알 수 없는 오류"})`);
  }

  // --- Plan Sanitization & Browser Safety Check (Zero Hardcoding) ---
  const { plan: sanitizedPlan, report } = sanitizeBrowsePlan(parsed.plan);
  if (report.fixedActionsCount > 0 || report.removedActionsCount > 0) {
    options.onProgress?.(`🛡️ [AI 플랜 안전성 점검] 위험 요소 ${report.removedActionsCount}개 제거, 셀렉터 ${report.fixedActionsCount}개 문법/스코프 보정 완료`);
    report.changes.forEach((c) => options.onProgress?.(`  ${c}`));
  }

  const suggestedSlug =
    options.slug ||
    parsed.suggestedSlug ||
    "scenario-" + Date.now().toString(36);

  // Build a summary for the Dashboard "Action Spec" inspection panel
  const actionSpecSummary = [
    `# [화면 조작 기획 및 소스코드 탐색 결과] ${options.prompt}`,
    "",
    `## 1. 개요 및 연출 의도`,
    `- 설명: ${parsed.explanation || "시나리오가 성공적으로 생성되었습니다."}`,
    `- 총 연출 액션 수: ${sanitizedPlan.actions.length}단계`,
    "",
    `## 2. 실시간 소스코드 도구 탐색 내역`,
    toolActivityLogs.length > 0
      ? toolActivityLogs.map((l) => `- ${l}`).join("\n")
      : "- 정적 소스코드 컨텍스트 및 표준 DOM 구조를 기반으로 플랜을 직결 생성했습니다.",
    "",
    `## 3. 식별된 핵심 인터랙티브 요소`,
    ...sanitizedPlan.actions
      .filter((a) => a.selector)
      .map((a, idx) => `- 단계 ${idx + 1} (${a.type}): \`${a.selector}\` (${a.description})`),
  ].join("\n");

  const finalResult: GeneratePlanResult = {
    plan: sanitizedPlan,
    explanation: parsed.explanation || "시나리오가 성공적으로 생성되었습니다.",
    suggestedSlug: suggestedSlug.replace(/[^a-zA-Z0-9_\-]/g, "-").toLowerCase(),
    actionSpecMarkdown: actionSpecSummary,
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



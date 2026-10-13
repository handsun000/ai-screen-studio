import { GoogleGenAI } from "@google/genai";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
import type { BrowsePlan } from "../types";
import { getConfig, DEFAULT_GROUPWARE_PROJECTS } from "./configManager";
import { getGroupwarePromptContext } from "./groupwareCatalog";
import { MASTER_DIRECTING_GUIDELINES } from "./tutorialTemplates";
import {
  createCodeExplorerTools,
  codeExplorerToolDeclarations,
  ActionSpecResult,
} from "./codeExplorerAgent";
import { getCachedPlan, setCachedPlan } from "./aiCacheManager";
import { sanitizeBrowsePlan } from "./planSanitizer";
import { probeTargetScreens, VisualProbeScreen } from "./visualProbeAgent";
import { ensureSessionForSlug } from "./authManager";

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
  depth?: "basic" | "standard" | "advanced";
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
  visualScreensCount?: number;
}

/**
 * Searches the target project (dynamically configured) for:
 * 1. Relevant Markdown documentation (e.g. agyDocs/tutorial_scenarios.md, docs/*.md)
 * 2. Relevant source files (JSP, JS, TSX, Vue, HTML) matching prompt keywords
 */
export function scanTargetProjectContext(prompt: string, targetPath?: string): string {
  const contextSnippets: string[] = [];
  const rawPath = targetPath !== undefined ? targetPath : getConfig().targetProjectPath;
  let projectRoot = (rawPath || "").trim().replace(/\\/g, "/");
  if (!projectRoot || !fs.existsSync(projectRoot)) {
    const discovered = DEFAULT_GROUPWARE_PROJECTS.filter((p) => fs.existsSync(p));
    if (discovered.length > 0) projectRoot = discovered[0].replace(/\\/g, "/");
  }

  if (!projectRoot) {
    return "[실시간 웹 모드] 로컬 소스코드 의존성 없이 대상 서비스 URL 및 표준 웹 인터랙션 명세로 시나리오를 구성합니다.";
  }

  if (!fs.existsSync(projectRoot)) {
    return `[알림] 지정된 타겟 프로젝트 경로를 찾을 수 없습니다: ${projectRoot}`;
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
      options.directingStyle,
      options.depth
    );
    if (cached) {
      options.onProgress?.(`⚡ [캐시 적중 (Cache Hit)] 동일한 질문에 대한 AI 분석 결과가 보관되어 있습니다. Gemini 호출을 생략하고 0.05초 만에 즉시 불러옵니다! (토큰 소모: 0)`);
      return {
        ...cached,
        suggestedSlug: options.slug || cached.suggestedSlug,
      };
    }
  }

  const hasLocalSource = !!(effectiveTargetPath && fs.existsSync(effectiveTargetPath));
  if (hasLocalSource) {
    options.onProgress?.(`🚀 [통합 AI 디렉터] 소스코드 역공학 탐색 및 5단계 영상 연출 플랜 수립을 시작합니다...`);
  } else {
    options.onProgress?.(`🌐 [실시간 웹 모드] URL(${effectiveTargetUrl}) 기반 5단계 영상 연출 플랜 수립을 시작합니다...`);
  }

  // --- Pre-flight Visual Explorer Probe (Visual-First Scenario Generation) ---
  let visualScreens: VisualProbeScreen[] = [];
  if (effectiveTargetUrl) {
    try {
      options.onProgress?.(`👁️ [시각적 사전 탐색] 시나리오 AI가 브라우저를 띄워 실제 화면을 눈으로 확인하고 DOM 구조를 분석합니다...`);
      const probeResult = await probeTargetScreens({
        targetUrl: effectiveTargetUrl,
        prompt: options.prompt,
        slug: options.slug,
        onProgress: options.onProgress,
      });
      if (probeResult.success && probeResult.screens.length > 0) {
        visualScreens = probeResult.screens;
        options.onProgress?.(`📸 [시각 정보 주입] 확보된 ${visualScreens.length}장의 실제 브라우저 화면과 DOM 후보군을 Gemini 멀티모달 시각 엔진에 주입합니다.`);
      }
    } catch (probeErr: any) {
      console.warn(`[VisualProbe] Failed during scenario planning: ${probeErr.message}`);
    }
  }

  // --- Initialize Autonomous Code Explorer Tools for Target Project (Optional) ---
  const toolExecutors = hasLocalSource ? createCodeExplorerTools(effectiveTargetPath) : {};
  const toolDeclarations = hasLocalSource ? codeExplorerToolDeclarations : [];
  const toolActivityLogs: string[] = [];

  const codeContext = scanTargetProjectContext(options.prompt, effectiveTargetPath);
  const fewShotContext = loadFewShotExamples();

  const commonDirectingRules = `
${getGroupwarePromptContext(options.prompt)}

---

### [Core Directing Rules & Quality Assurance Framework]
1. **Contextual Scoping & Anti-Collision**:
   - Universal action labels ('저장', '등록', '확인', '닫기', '검색') exist simultaneously in headers, sidebars, content toolbars, and modals.
   - Modals: Always qualify with \`.ui-dialog:visible\` (e.g., \`.ui-dialog:visible button:has-text('저장')\`, \`.ui-dialog:visible #savebtn\`).
   - Sidebar buttons: Qualify with \`#snb\` (e.g., \`#snb button:has-text('등록')\`).
   - Top Header buttons: Qualify with \`header\` or \`.gnb\` (e.g., \`header button.btn_svc_open\`).
   - Content Toolbars: Qualify with \`#content\` or \`.new_srch_bar\`.

2. **Zero-Guessing Policy & Empty Selector Guidance**:
   - NEVER invent fake English IDs (#search_box_input, #_DOC_TITLE_, #btn_save_dialog).
   - Use verified Korean text matching (e.g., \`button:has-text("등록"):visible\`) when visible.
   - If a selector cannot be determined or confirmed, set **\`"selector": ""\` (empty string)**.
   - In the root \`explanation\` field, politely list all empty selectors so users can easily configure them in the dashboard UI.

3. **Hidden Portal Service Drawer Rule (CRITICAL)**:
   - When navigating from the portal dashboard to ANY business sub-module (Approval, Documents, Board, Schedule, Mail, Attendance, Resource, Admin):
     Mandatory Sequence:
     1. \`click\`: \`button.btn_svc_open:visible, button[title='포탈 전체메뉴'], .btn_svc_open:visible\`
     2. \`wait\`: \`1200ms\` (wait for drawer expansion)
     3. \`click\`: \`#svc_box a:has-text('메뉴명'), a:has-text('메뉴명'):visible\`
     4. \`wait\`: \`3000ms\` (wait for module page to fully load)
   - NEVER click hidden sub-menu links directly while their display is none!

4. **Universal 4-Archetype Scenario Routing (ALL Modules)**:
   Classify the user's intent into one of the 4 archetypes across ANY enterprise module. NEVER rigidly force create/submit forms onto every request!

   ① **Archetype 1: Pure Exploration & Structure (EXPLORATION)**
      - Intent: "기본 구조", "구조", "둘러보기", "탐색", "화면 구성", "온보딩", "투어", "레이아웃", "메뉴 확인", "overview", "structure", "tour"
      - 🚫 STRICT BAN: NEVER click [신규 등록], [작성], [기안], [저장]! Zero form inputs!
      - Flow: [Portal Intro] -> [Open Drawer & Navigate] -> [Module Page Load] -> [Expand Sidebar Trees & Click Sub-folders/Calendars] -> [Switch View Modes (Table vs Split vs Calendar View) or Sorting/Filter Dropdowns] -> [Tour Content Widgets/Lists] -> [Summarize Structure & Outro]

   ② **Archetype 2: Pure Search & View (SEARCH_VIEW)**
      - Intent: "검색", "조회", "열람", "상세", "찾기", "확인", "search", "lookup", "view detail" (without explicit create request)
      - 🚫 STRICT BAN: NEVER insert dummy create/submit steps before searching!
      - Flow: [Portal Intro] -> [Navigate to Module] -> [Link Live Scraped Item ("useScraped": "auto", "dynamicStrategy": "first-row-title")] -> [Type Scraped Keyword into Content Toolbar Search Input] -> [Click Content Toolbar Search Button] -> [Inspect Filtered Results] -> [Click Filtered Item to Open Detail View] -> [Tour Detail Body/Attachments/Approval Line Tabs] -> [Return to List]

   ③ **Archetype 3: Create & Submit (CREATE_SUBMIT)**
      - Intent: "등록", "작성", "기안", "상신", "신청", "추가", "생성", "예약", "create", "register", "submit"
      - Flow (Zero-Validation-Failure Policy): [Portal Intro] -> [Navigate to Module] -> [Click New Write/Register/Draft Button] -> [Fulfill ALL Mandatory Module Prerequisites (select folder/calendar/form tree leaf node to prevent "Select container" alert)] -> [Focus & Type Title Field (prevents "Enter title" alert)] -> [Write Body Content in Web Editor] -> (Configure permissions/attendees ONLY if explicitly requested in user prompt) -> [Click Save/Submit Button with Modal Scope] -> [Accept Browser Confirm Dialog] -> [Confirm Completion Dialog & Wait 4000ms+ for List Reload]
      - 🚫 STRICT BAN (Lean Form Policy): NEVER invent unrequested advanced settings (expand advanced options, retention dropdown, security level radio, tags, document summary, notification toggles) that are not visible by default!
      - 🛡️ **UNIVERSAL SHUTTLE & PICKER DIALOG STANDARD (Transfer List Pattern & 2-Tier Nested Modals)**:
        When a tutorial involves selecting users, attendees, departments, or permissions via a popup dialog (e.g. 조직도, 참석자 선택, 권한 대상자 지정, 결재선 지정):
        A genuine manual video MUST visually demonstrate the complete user selection process so viewers can follow along. NEVER skip picking the target and jump straight to transfer or confirm!
        Strictly plan the sequence:
        1) [설정 레이어 오픈]: Click the trigger button on the main form (e.g. \`button:has-text('권한설정'):visible\`, \`button:has-text('결재선'):visible\`, \`button:has-text('참석자'):visible\`)
        2) [하위 픽커/조직도 호출 (중첩 레이어 구조 시 필수!)]: If the opened settings layer contains an inner [추가] or [조직도] button, click it to summon the actual user selection popup!
           Selector: \`.ui-dialog:visible button:has-text('추가'):visible, .ui-dialog:visible button:has-text('조직도'):visible, .ui-dialog:visible button:has-text('주소록'):visible\`
           Description: "설정 대화상자 내 [추가] 버튼 클릭하여 조직도 팝업 호출"
        3) [시각적 대상 선택 - 사원/사용자 카드 선택 필수!]: In enterprise org pickers, the left tree is ONLY a department filter. The ACTUAL selectable entity is the employee card in the middle pane! Click the first employee card/row in the middle list (description MUST include '사원 선택' or '사용자 선택'):
           Selector: \`.ui-dialog:visible label.user_info.chkbox, .ui-dialog:visible label[class*='user_info'], .ui-dialog:visible #orgUserList_listbox label.user_info, .ui-dialog:visible [id^='user_']:first-child, .ui-dialog:visible .user_card:first-child, .ui-dialog:visible [class*='user_lst'] li:first-child, .ui-dialog:visible [class*='user']:has(.name):first-child, .ui-dialog:visible li:first-child label, .ui-dialog:visible tr:first-child td\`
           (Notice: This highlights the employee card with a distinct blue border so viewers clearly see who is being selected!)
        4) [대상 목록으로 추가/전달]: Click the transfer/add button (\`.ui-dialog:visible button.drop_tgl:visible, .ui-dialog:visible button:has-text('추가'):visible, .ui-dialog:visible button:has-text('선택'):visible, .ui-dialog:visible button:has-text('권한'):visible, .ui-dialog:visible button.btn_rgt:visible\`) to move the selected employee from the middle pane into the right target box
        5) [하위 조직도 팝업 확인]: Click the confirm button on the user picker dialog (\`.ui-dialog:visible .ui-dialog-buttonpane button:has-text('확인'):visible, .ui-dialog:visible button:has-text('확인'):visible\`)
        6) [상위 설정 대화상자 확인 (중첩 레이어 닫기 및 본문 복귀)]: Click the confirm button on the outer settings layer (\`.ui-dialog:visible .ui-dialog-buttonpane button:has-text('확인'):visible, .ui-dialog:visible button:has-text('확인'):visible, .modal:visible button:has-text('확인'):visible\`)
        🚫 NEVER hallucinate 5 separate individual checkbox clicks (e.g. 조회/인쇄/저장/수정/개정) with fictitious IDs! In enterprise web apps, permissions are managed via modal dialogs, org pickers, or level select dropdowns.

   ④ **Archetype 4: Workflow & Management (WORKFLOW_MANAGE)**
      - Intent: "결재", "승인", "반려", "수정", "상태 변경", "권한 설정", "approve", "reject", "edit", "status"
      - Flow: [Navigate to Module] -> [Select Pending Approval / Target Item from List] -> [Inspect Detailed Document & Approval Line] -> [Click Approve/Reject or Edit Button] -> [Enter Approval Comments or Modify Options] -> [Click Final Confirm Button] -> [Verify State Transition in List]

5. **Dynamic Live Data Linking (Method 2: Zero-Hallucinated-Data Policy)**:
   - NEVER invent fake document/article titles or employee names ("2026학년도 대학 혁신...", "테스트 기안서", "김철수").
   - In \`type\` search actions, always specify:
     • \`"useScraped": "auto"\`
     • \`"dynamicStrategy": "first-row-title"\` (or "first-row-user" for employee lookup)
     • \`"description": "화면 목록의 실제 데이터로 검색어 자동 연동 입력"\`
     • \`"text": "실시간 실제 목록 데이터"\`
   - Playwright runtime will automatically scrape the real text from the rendered table and type it.
   - Content Toolbar Search Scoping (CRITICAL BAN on GNB Header and Sidebar Search):
     • Content Search Input (type): \`input#atclList_searchWord:visible, input[id*='searchWord']:visible, .new_srch_bar input:visible, #content .srch_input input:visible, #content input[id*='search']:visible, #content input[placeholder*='검색']:visible\`
     • Content Search Button (click): \`button#atclList_srchBtn:visible, button[id*='srchBtn']:visible, button[id*='searchBtn']:visible, .new_srch_bar button:visible, #content .srch_input button:has(.ico_srch):visible, #content .srch_input button[title='검색']:visible, #content button[title='검색']:visible, #content button.btn_srch:visible\`

6. **Korean UI Localization Directive (CRITICAL)**:
   - Target web application runs in **Korean**.
   - All action \`description\` strings MUST be in natural, polite Korean.
   - All text-matching selectors (\`:has-text('...')\`, \`button[title='...']\`, \`label:has-text('...')\`) MUST use exact Korean UI strings.
   - The root \`explanation\` field MUST be in Korean.

7. **Strict JSON Output**:
   - Respond ONLY with a valid, complete BrowsePlan JSON structure. No markdown chatter outside the JSON code block.

`;

  const systemInstruction = hasLocalSource
    ? `
You are the Lead Video Automation Director & Browser Reverse Engineering Architect.
Your role is to reverse-engineer web application source code and generate studio-grade, 5-phase BrowsePlan JSON scenarios.
You must construct universally accurate, production-ready plans for any enterprise module (Search, Approval, Documents, Board, Mail, Schedule, Attendance, Resource, Admin).

${MASTER_DIRECTING_GUIDELINES}

---

### Target System Environment
- Target Web URL: ${effectiveTargetUrl}
- Target Project Local Path: ${effectiveTargetPath}

### Discovered Project Source Context
${codeContext}

### Verified Reference Scenario Patterns
${fewShotContext}

### Reverse Engineering & Tool Usage Directives
- Use tools (searchCodeText, findFiles, readSourceSnippet, extractAlertsAndValidation) to inspect real button IDs, form field names, and validation alerts.

${commonDirectingRules}
`
    : `
You are the Lead Video Automation Director & Browser Reverse Engineering Architect.
Your role is to generate studio-grade, 5-phase BrowsePlan JSON scenarios based on live web application URL (${effectiveTargetUrl}) and standard enterprise interaction patterns.
Without local source files, you infer precise leaf selectors from intuitive visible button text (button:has-text), visible inputs (:visible), form interactions, and modal dialogs (.ui-dialog:visible).

${MASTER_DIRECTING_GUIDELINES}

---

### Target System Environment
- Target Web URL: ${effectiveTargetUrl}
- Operation Mode: Live Web Direct Mode (No local source required)

### Verified Reference Scenario Patterns
${fewShotContext}

${commonDirectingRules}
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
Scenario Depth: ${options.depth || "standard"} (${
    options.depth === "basic"
      ? "Basic (Summary): Keep it under 1 minute (10-15 actions). Cover ONLY the most essential happy-path flow. Skip optional settings and minor UI elements."
      : options.depth === "advanced"
      ? "Advanced (Deep-Dive Masterclass): Make a comprehensive 3-5 minute guide with AT LEAST 40-60 actions! Exhaustively explore all optional settings, toggle advanced menus, switch between tabs, hover over tooltips to explain them, deeply configure options, and thoroughly review the page before finally submitting. Do not take shortcuts!"
      : "Standard (Normal): Make a 1-2 minute standard guide (20-35 actions). Cover the main flow and one or two important options."
  })

Classify the user's intent into one of the 4 Universal Archetypes (EXPLORATION, SEARCH_VIEW, CREATE_SUBMIT, WORKFLOW_MANAGE) and construct the plan accordingly.
Follow the 5-phase video directing framework (Phase 1 Lead-in -> Phase 2 Intentional Navigation -> Phase 3 Interaction -> Phase 4 Action Execution -> Phase 5 Outcome Review).
Explore the source code if necessary using tools, then produce the complete BrowsePlan JSON structure that satisfies this scenario.
Ensure all action "description" strings and text-matching selectors (:has-text('...')) are in Korean.

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
        "description": "한글 액션 설명",
        "force": false,
        "useScraped": "auto",
        "dynamicStrategy": "first-row-title"
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
            parts: [
              { text: userContent },
              ...(visualScreens.length > 0
                ? [
                    {
                      text:
                        `\n\n### [👁️ 사전 시각 탐색: 실제 브라우저 실시간 캡처 화면 및 추출된 DOM 요소 증거]\n` +
                        `시나리오 AI가 브라우저를 직접 구동하여 현 시점 실제 접속한 화면 스크린샷과 추출된 DOM 요소들입니다.\n` +
                        `절대로 추측이나 상상으로 셀렉터를 지어내지 말고, 아래 캡처된 실제 화면 이미지에서 사용자가 조작해야 하는 요소를 직접 눈으로 확인한 뒤,\n` +
                        `함께 제공된 [추출된 실제 인터랙티브 엘리먼트 후보군]의 'suggestedSelector' 또는 정확한 클래스/텍스트를 100% 사용하여 시나리오를 구성하십시오.\n`,
                    },
                    ...visualScreens.flatMap((s, i) => [
                      {
                        text:
                          `\n\n#### 📸 [화면 #${i + 1}: ${s.name}] (URL: ${s.url})\n` +
                          (s.dialogTitle ? `활성 대화상자: "${s.dialogTitle}"\n` : "") +
                          (s.openedBy ? `⚠️ 필수 진입 트리거: "${s.openedBy}" (이 화면으로 진입하려면 직전 단계에서 이 트리거를 클릭하는 액션이 반드시 필요합니다!)\n` : "") +
                          `화면에서 추출된 실제 인터랙티브 엘리먼트 후보군:\n` +
                          JSON.stringify(s.candidates.slice(0, 35), null, 2),
                      },
                      {
                        inlineData: {
                          mimeType: "image/jpeg",
                          data: s.base64,
                        },
                      },
                    ]),
                  ]
                : []),
            ],
          },
        ];

        let turn = 0;
        const maxToolTurns = toolDeclarations.length > 0 ? 3 : 1;

        while (turn < maxToolTurns) {
          turn++;
          const response = await ai.models.generateContent({
            model,
            contents,
            config: {
              systemInstruction,
              tools: toolDeclarations.length > 0 ? [{ functionDeclarations: toolDeclarations as any }] : undefined,
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

          let retryCount = 0;
          while (retryCount < 2) {
            const finalResponse = await ai.models.generateContent({
              model,
              contents,
              config: {
                systemInstruction,
                responseMimeType: "application/json",
                temperature: 0.2 + (retryCount * 0.2), // Increase temp on retry
                maxOutputTokens: 8192,
              },
            });

            const finalText = finalResponse.text || "";
            if (finalText.trim().length > 0) {
              try {
                parsed = parseAndRepairJson(finalText);
                
                // AI 자가 검증: 파싱은 되었으나 actions 등 필수 구조가 비정상인지 확인
                if (!parsed || !parsed.plan || !Array.isArray(parsed.plan.actions) || parsed.plan.actions.length === 0) {
                  throw new Error("생성된 JSON에 actions 배열이 누락되었거나 비어 있습니다. BrowsePlan 스펙에 맞춰 처음부터 다시 작성해주세요.");
                }
                
                // 정제기 통과 여부 검증
                sanitizeBrowsePlan(parsed.plan);

                console.log(`[Unified Gemini Director] Successfully finalized JSON plan with model "${model}"!`);
                break modelLoop;
              } catch (jsonErr: any) {
                console.warn(`[Unified Gemini Director] JSON parse or validation failed (Attempt ${retryCount + 1}): ${jsonErr.message}`);
                lastError = jsonErr;
                parsed = null;
                
                // 에러 메시지를 컨텍스트에 추가하여 AI에게 재작성(자가 치유) 지시
                contents.push({ role: "model", parts: [{ text: finalText }] });
                contents.push({
                  role: "user",
                  parts: [{ text: `🚨 오류 발생: ${jsonErr.message}\n이전 응답의 JSON 형식이 잘못되었거나 필수 항목이 누락되었습니다. 오류를 수정한 완벽한 JSON을 다시 생성하십시오.` }]
                });
                options.onProgress?.(`⚠️ AI 시나리오 검증 실패. 원인 분석 후 자동 재시도 중... (${retryCount + 1}/2)`);
              }
            }
            retryCount++;
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
    ...(visualScreens.length > 0
      ? [`- 👁️ 사전 시각 탐색: 실제 브라우저 화면 ${visualScreens.length}장 캡처 및 DOM 후보군 시각 분석 반영`]
      : []),
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
    visualScreensCount: visualScreens.length,
  };

  // Save to cache for future identical requests (token saver)
  try {
    setCachedPlan(
      options.prompt,
      effectiveTargetPath,
      effectiveTargetUrl,
      options.directingStyle,
      options.depth,
      finalResult
    );
  } catch {}

  try {
    ensureSessionForSlug(finalResult.suggestedSlug);
  } catch {}

  return finalResult;
}



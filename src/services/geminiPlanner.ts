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
import { recordAiUsage } from "./aiUsageTracker";
import { probeTargetScreens, VisualProbeScreen } from "./visualProbeAgent";
import type { LiveDOMCandidate } from "./elementSelfHealer";
import { ensureSessionForSlug } from "./authManager";

dotenv.config({ override: true });

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
 * Prioritizes and compacts LiveDOMCandidates from VisualProbe so that critical form inputs,
 * modal buttons, and prompt-matching elements in the main content area are NEVER truncated
 * behind top GNB header / sidebar items.
 */
function prioritizeProbeCandidates(
  candidates: LiveDOMCandidate[],
  prompt: string,
  maxItems = 85
): Array<Record<string, any>> {
  if (!candidates || candidates.length === 0) return [];

  const promptKeywords = (prompt || "")
    .toLowerCase()
    .split(/[\s,()_+/]+/)
    .map((k) => k.trim())
    .filter((k) => k.length >= 2);

  const scored = candidates.map((c, idx) => {
    let score = 0;
    const textLower = (c.text || "").toLowerCase();
    const idLower = (c.id || "").toLowerCase();
    const selLower = (c.suggestedSelector || "").toLowerCase();
    const titleLower = (c.title || "").toLowerCase();
    const placeholderLower = (c.placeholder || "").toLowerCase();

    // 1. Active Modal elements have highest priority
    if (c.inModal) {
      score += 100;
    }

    // 2. Direct keyword match with user prompt
    for (const kw of promptKeywords) {
      if (
        textLower.includes(kw) ||
        idLower.includes(kw) ||
        titleLower.includes(kw) ||
        placeholderLower.includes(kw)
      ) {
        score += 75;
      }
    }

    // 3. Main Content form controls & interactive buttons
    if (!c.inHeader && !c.inSidebar) {
      score += 40;
      if (c.tag === "input" || c.tag === "textarea" || c.tag === "select" || c.frame) {
        score += 35;
      } else if (c.tag === "button" || selLower.includes("btn_write") || selLower.includes("app_work_box")) {
        score += 30;
      }
    }

    // 4. Left Sidebar primary write/register buttons
    if (c.inSidebar) {
      if (
        textLower.includes("등록") ||
        textLower.includes("작성") ||
        textLower.includes("쓰기") ||
        textLower.includes("신청") ||
        textLower.includes("결재현황") ||
        idLower.includes("write") ||
        idLower.includes("reg")
      ) {
        score += 45;
      } else {
        score += 5;
      }
    }

    // 5. Top GNB Header: keep only the service drawer button (btn_svc_open), penalize global header noise
    if (c.inHeader) {
      if (selLower.includes("btn_svc_open") || titleLower.includes("전체메뉴") || textLower.includes("전체메뉴")) {
        score += 60;
      } else {
        score -= 50;
      }
    }

    return { candidate: c, score, idx };
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.idx - b.idx;
  });

  return scored.slice(0, maxItems).map(({ candidate: c }) => {
    const compact: Record<string, any> = {
      tag: c.tag,
      suggestedSelector: c.suggestedSelector,
    };
    if (c.text) compact.text = c.text;
    if (c.id) compact.id = c.id;
    if (c.placeholder) compact.placeholder = c.placeholder;
    if (c.title) compact.title = c.title;
    if (c.inModal) compact.inModal = c.inModal;
    if (c.inSidebar) compact.inSidebar = true;
    if (c.frame) compact.iframe = c.frame;
    return compact;
  });
}

/**
 * Searches the target project (dynamically configured) for:
 * 1. Relevant Markdown documentation (e.g. agyDocs/tutorial_scenarios.md, docs/*.md)
 * 2. Relevant source files (JSP, JS, TSX, Vue, HTML) matching prompt keywords across all 23 groupware modules
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
  const promptKeywords = (prompt || "")
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
            i = end;
            if (contextSnippets.length >= 4) break;
          }
        }
      }
    } catch {}
  }

  // --- 2. Scan Source Code & JavaScript Controllers ---
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
      // Full mapping across all 23 Naonsoft EKP enterprise modules
      const moduleKeywordMap: Record<string, string[]> = {
        app: ["결재", "기안", "상신", "전자결재", "회의록", "품의", "결재선", "보관함", "기록물철"],
        doc: ["문서", "문서함", "문서관리", "문서등록"],
        board: ["게시", "게시판", "게시글", "공지"],
        schedule: ["일정", "캘린더", "일정관리", "스케줄"],
        reservation: ["자원", "예약", "회의실", "차량", "시설"],
        work: ["업무보고", "보고서", "일일보고", "주간보고", "보고함"],
        smartwork: ["스마트워크", "업무함", "태스크"],
        project: ["프로젝트", "일감", "마일스톤", "이슈"],
        space: ["스페이스"],
        teamsite: ["팀사이트"],
        survey: ["설문", "투표", "앙케이트"],
        filebox: ["파일함", "웹하드", "자료실", "폴더"],
        memo: ["메모", "포스트잇"],
        note: ["쪽지", "사내쪽지"],
        email: ["메일", "웹메일", "전자우편", "편지"],
        addr: ["주소록", "연락처"],
        attend: ["근태", "출퇴근", "휴가", "부재", "근무"],
        organization: ["조직도", "사용자", "부서", "사원"],
      };

      const matchedModules = Object.entries(moduleKeywordMap)
        .filter(([_, kws]) => kws.some((kw) => prompt.includes(kw)))
        .map(([mod]) => mod);

      const specificModuleDirs: string[] = [];
      for (const mod of matchedModules) {
        specificModuleDirs.push(
          path.join(projectRoot, "naon-module-web", "src", "main", "webapp", "resources", "biz", "gw", mod),
          path.join(projectRoot, "naon-module-web", "src", "main", "webapp", "jsp", "biz", "gw", mod),
          path.join(projectRoot, "src", "main", "webapp", "resources", "biz", "gw", mod),
          path.join(projectRoot, "src", "main", "webapp", "jsp", "biz", "gw", mod)
        );
      }
      const existingSpecificDirs = specificModuleDirs.filter((d) => fs.existsSync(d));
      const rootsToScan = existingSpecificDirs.length > 0 ? existingSpecificDirs : activeSourceRoots.slice(0, 2);

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
          idMatches.length > 0 ? `Key IDs: ${idMatches.slice(0, 10).join(", ")}` : "",
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
    } catch {}
  }

  return contextSnippets.length > 0
    ? contextSnippets.join("\n\n---\n\n")
    : `[기본 정보] 타겟 프로젝트 (${path.basename(projectRoot)}) 감지 완료.`;
}

/**
 * Loads verified examples from data/ directory to provide as few-shot training.
 * Preserves all modern action fields (sourceSelector, targetSelector, useScraped, dynamicStrategy)
 * while excluding deprecated optional flags.
 */
function loadFewShotExamples(prompt: string): string {
  const dataDir = path.resolve(__dirname, "..", "..", "data");
  const examples: string[] = [];
  const p = (prompt || "").toLowerCase();

  // Select the most relevant verified scenarios based on prompt intent
  const candidateSlugs: string[] = [];
  if (p.includes("결재") || p.includes("기안") || p.includes("상신") || p.includes("회의록") || p.includes("드래그")) {
    candidateSlugs.push("tutorial-draft", "approval-draft");
  }
  if (p.includes("문서") || p.includes("권한") || p.includes("검색") || p.includes("조회")) {
    candidateSlugs.push("tutorial-document");
  }
  if (p.includes("일정") || p.includes("캘린더") || p.includes("스케줄") || p.includes("자원") || p.includes("회의실")) {
    candidateSlugs.push("tutorial-diary", "tutorial-schedule");
  }
  candidateSlugs.push("create-and-submit");

  const uniqueSlugs = Array.from(new Set(candidateSlugs));

  for (const slug of uniqueSlugs) {
    if (examples.length >= 2) break;
    const planPath = path.join(dataDir, slug, "browse-plan.json");
    if (fs.existsSync(planPath)) {
      try {
        const content = fs.readFileSync(planPath, "utf-8");
        const parsed = JSON.parse(content);
        const compactActions = (parsed.actions || []).map((a: any) => {
          const act: Record<string, any> = {
            type: a.type,
            description: a.description,
          };
          if (a.selector) act.selector = a.selector;
          if (a.sourceSelector) act.sourceSelector = a.sourceSelector;
          if (a.targetSelector) act.targetSelector = a.targetSelector;
          if (a.iframe) act.iframe = a.iframe;
          if (a.text) act.text = a.text;
          if (a.ms) act.ms = a.ms;
          if (a.deltaY) act.deltaY = a.deltaY;
          if (a.useScraped) act.useScraped = a.useScraped;
          if (a.dynamicStrategy) act.dynamicStrategy = a.dynamicStrategy;
          return act;
        });

        const summary = {
          name: slug,
          totalActions: compactActions.length,
          actions: compactActions,
        };
        examples.push(`[검증된 레퍼런스 시나리오: ${slug}]\n` + JSON.stringify(summary, null, 2));
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

  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  }

  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  }

  try {
    return JSON.parse(cleaned);
  } catch (firstErr: any) {
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
 * Normalizes a user prompt (whether written as an arrow chain 'A -> B -> C' or natural Korean sentences)
 * into a canonical, unambiguous step-chain with single-quoted target values ('...') and missing modal confirmations filled in.
 */
export function normalizeUserPrompt(rawPrompt: string): {
  normalizedPrompt: string;
  steps: string[];
  addedHints: string[];
} {
  const addedHints: string[] = [];
  let text = (rawPrompt || "")
    .trim()
    .replace(/두번쨰/g, "두번째")
    .replace(/첫번쨰/g, "첫번째")
    .replace(/세번쨰/g, "세번째")
    .replace(/결제선/g, "결재선")
    .replace(/전자결제/g, "전자결재")
    .replace(/결제 작성/g, "결재 작성")
    .replace(/결제상신/g, "결재상신");

  if (!text) {
    return { normalizedPrompt: "", steps: [], addedHints: [] };
  }

  // If the user wrote natural sentences without '->', split on common sequential Korean connectors when 3+ clauses exist
  const hasArrows = /->|➔|=>|▶/.test(text);
  let rawSegments: string[] = [];
  if (hasArrows) {
    rawSegments = text
      .split(/\s*(?:->|➔|=>|▶)\s*/)
      .map((s) => s.trim())
      .filter(Boolean);
  } else if (text.includes("\n")) {
    rawSegments = text
      .split(/\r?\n/)
      .map((s) => s.replace(/^\d+[.)]\s*/, "").trim())
      .filter(Boolean);
  } else {
    // Split long prose into clauses if it has multiple sequential connectors
    const proseParts = text
      .split(/(?:하고\s*,?\s*|한\s*뒤\s*,?\s*|한\s*후\s*,?\s*|누르고\s*,?\s*|클릭하고\s*,?\s*|입력하고\s*,?\s*|선택하고\s*,?\s*)/)
      .filter((s) => s.trim().length > 0);
    if (proseParts.length >= 3) {
      // Keep original connectors by using regex match
      const matchedClauses =
        text.match(
          /[^,]+?(?:하고|한\s*뒤|한\s*후|누르고|클릭하고|입력하고|선택하고|해줘|클릭|입력|선택|저장|상신)(?=\s|,|$)/g
        ) || [text];
      if (matchedClauses.length >= 3) {
        rawSegments = matchedClauses.map((s) => s.replace(/^,\s*/, "").trim()).filter(Boolean);
        addedHints.push("서술형 문장을 단계별 화살표(->) 체인 구조로 자동 분해");
      } else {
        rawSegments = [text];
      }
    } else {
      rawSegments = [text];
    }
  }

  const quoteValue = (val: string): string => {
    const cleaned = val.trim().replace(/^['"]|['"]$/g, "").trim();
    return `'${cleaned}'`;
  };

  let quotedCount = 0;
  const normalizedSteps: string[] = [];

  // Helper to resolve popup metadata by category keyword
  const getPopupMeta = (rawKind: string) => {
    if (rawKind.includes("결재분류") || rawKind.includes("분류")) {
      return {
        name: "결재분류",
        openStep: "결재분류 폴더 선택 버튼 클릭",
        itemPrefix: "결재분류 팝업 트리에서",
        confirmStep: "결재분류 팝업에서 확인 클릭",
      };
    }
    if (rawKind.includes("기록물철")) {
      return {
        name: "기록물철",
        openStep: "기록물철 선택 버튼 클릭",
        itemPrefix: "기록물철 팝업 트리에서",
        confirmStep: "기록물철 팝업에서 확인 클릭",
      };
    }
    if (rawKind.includes("문서보관함") || rawKind.includes("보관함")) {
      return {
        name: "문서보관함",
        openStep: "문서보관함 선택 버튼 클릭",
        itemPrefix: "문서보관함 팝업 트리에서",
        confirmStep: "문서보관함 팝업에서 확인 클릭",
      };
    }
    if (rawKind.includes("자원")) {
      return {
        name: "자원 선택",
        openStep: "자원 선택 버튼 클릭",
        itemPrefix: "자원 선택 팝업 트리에서",
        confirmStep: "자원 선택 팝업에서 확인 클릭",
      };
    }
    if (rawKind.includes("문서함")) {
      return {
        name: "문서함 선택",
        openStep: "문서함 선택 버튼 클릭",
        itemPrefix: "문서함 선택 팝업 트리에서",
        confirmStep: "문서함 선택 팝업에서 확인 클릭",
      };
    }
    return {
      name: "게시판 선택",
      openStep: "게시판 선택 버튼 클릭",
      itemPrefix: "게시판 선택 팝업 트리에서",
      confirmStep: "게시판 선택 팝업에서 확인 클릭",
    };
  };

  // Helper to check if a step is an unrelated form action (not selecting a tree item inside the popup)
  const isFormFieldOrSubmitStep = (s: string): boolean => {
    if (!s) return true;
    return /입력|작성|타이핑|탭\s*선택|탭\s*클릭|결재선|결재상신|상신\s*버튼|저장\s*버튼|기안의견|문서\s*내용|본문|제목|드래그/.test(
      s
    );
  };

  for (let i = 0; i < rawSegments.length; i++) {
    let step = rawSegments[i];
    const hasQuotesAlready = /['"][^'"]+['"]/.test(step);

    // [Case B] 1-step combined popup shorthand:
    // e.g. "결재분류에서 테스트 선택", "결재분류로 테스트 선택", "결재분류 테스트 선택", "자원 대회의실 선택", "기록물철 인사철 선택"
    const combinedPopupMatch = step.match(
      /^(결재분류\s*폴더|결재분류|기록물철|문서보관함|자원\s*선택|자원|문서함\s*선택|문서함)(?:에서|으로|로|에|\s+)\s*['"]?([^'"]+?)['"]?\s*(?:선택|클릭|지정)(?:하기|해줘)?$/
    );
    if (
      combinedPopupMatch &&
      !/^(폴더|버튼|폴더\s*버튼|선택\s*버튼|팝업|모달|확인|취소|탭)$/.test(combinedPopupMatch[2].trim()) &&
      !combinedPopupMatch[2].includes("버튼") &&
      !combinedPopupMatch[2].includes("확인")
    ) {
      const meta = getPopupMeta(combinedPopupMatch[1]);
      const targetItem = combinedPopupMatch[2].trim();
      quotedCount++;

      const prevStep = normalizedSteps[normalizedSteps.length - 1] || "";
      if (!prevStep.includes(meta.name) || !prevStep.includes("버튼")) {
        normalizedSteps.push(meta.openStep);
      }
      normalizedSteps.push(`${meta.itemPrefix} ${quoteValue(targetItem)} 항목 선택`);

      const nextRaw = rawSegments[i + 1] || "";
      if (!nextRaw.includes("확인")) {
        normalizedSteps.push(meta.confirmStep);
      }
      addedHints.push(
        `축약된 [${step}] 표현을 [버튼 클릭 ➔ 팝업 트리에서 '${targetItem}' 항목 선택 ➔ 팝업 확인 클릭] 3단계로 자동 전개`
      );
      continue;
    }

    // [Case A & C] Popup open button step:
    // e.g. "결재분류 선택", "결재분류 클릭", "결재분류 폴더 버튼 선택", "기록물철 선택", "자원 선택", "문서함 선택"
    const popupOpenMatch = step.match(
      /^(결재분류|분류\s*폴더|기록물철|문서보관함|자원|문서함)(?:\s*폴더)?(?:\s*선택)?(?:\s*버튼)?\s*(?:선택|클릭)(?:하기|해줘)?$/
    );
    if (popupOpenMatch) {
      const meta = getPopupMeta(popupOpenMatch[1]);
      step = meta.openStep;
      normalizedSteps.push(step);

      const nextRaw = rawSegments[i + 1] || "";
      // [Case C] If the user ONLY wrote "결재분류 선택" and immediately moved on to another field (like 기안의견 입력, 결재선 탭, 상신) without specifying which folder item to pick:
      if (isFormFieldOrSubmitStep(nextRaw)) {
        normalizedSteps.push(`${meta.itemPrefix} 첫 번째 항목 선택`);
        normalizedSteps.push(meta.confirmStep);
        addedHints.push(
          `[${popupOpenMatch[0]}] 단독 단계 뒤에 누락된 [팝업 트리 항목 선택 ➔ 팝업 확인 클릭] 단계를 자동 보충`
        );
      }
      continue;
    }

    // [Case D-1] Auto-inject "결재선 탭 선택" before "결재선 선택" / "결재선 선택 버튼 클릭" if omitted
    if (
      /^결재선(?:\s*(?:선택|지정))?(?:\s*버튼)?\s*(?:클릭|선택|지정)$/.test(step) &&
      !step.includes("팝업") &&
      !step.includes("탭")
    ) {
      const prevStep = normalizedSteps[normalizedSteps.length - 1] || "";
      if (!prevStep.includes("결재선 탭")) {
        normalizedSteps.push("결재선 탭 선택");
        addedHints.push("결재선 선택 버튼 클릭 전 누락된 [결재선 탭 선택] 단계 자동 보충");
      }
      step = "결재선 선택 버튼 클릭";
      normalizedSteps.push(step);
      continue;
    }

    if (!hasQuotesAlready) {
      // 1) "검색으로 OOO 검색" or "검색창에 OOO 검색/입력"
      if (/^(?:검색으로|검색창에|검색란에)\s+(.+?)\s*(?:검색|입력|조회)(?:하기|해줘)?$/.test(step)) {
        step = step.replace(
          /^(검색으로|검색창에|검색란에)\s+(.+?)\s*(검색|입력|조회)(?:하기|해줘)?$/,
          (_, p1, val, p3) => {
            quotedCount++;
            return `${p1} ${quoteValue(val)} ${p3}`;
          }
        );
      }
      // 2) "OOO 결재업무 작성" / "OOO 양식 작성"
      else if (/^(.+?)\s*(?:결재업무|양식)\s*(?:작성|선택)(?:하기|해줘)?$/.test(step)) {
        step = step.replace(
          /^(.+?)\s*(결재업무|양식)\s*(작성|선택)(?:하기|해줘)?$/,
          (_, val, kind) => {
            quotedCount++;
            return `${quoteValue(val)} ${kind} 카드 선택 후 작성 클릭`;
          }
        );
        addedHints.push("결재업무 양식 진입을 [카드 선택 후 내부 작성 버튼 클릭]으로 구체화");
      }
      // 3) "제목(에) OOO 입력"
      else if (/^(?:제목에|제목란에|제목은|제목|일정\s*제목에|일정\s*제목|문서\s*제목에|문서\s*제목)\s+(.+?)\s*(?:입력|작성|타이핑)(?:하기|해줘)?$/.test(step)) {
        step = step.replace(
          /^(제목|일정\s*제목|문서\s*제목)(?:에|란에|은)?\s+(.+?)\s*(입력|작성|타이핑)(?:하기|해줘)?$/,
          (_, field, val, verb) => {
            quotedCount++;
            return `${field}에 ${quoteValue(val)} ${verb}`;
          }
        );
      }
      // 4) "기안의견(에) OOO 입력" / "결재의견(에) OOO 입력" / "장소(에) OOO 입력"
      else if (/^(?:기안의견에|기안의견은|기안의견|결재의견에|결재의견|의견에|장소에|장소)\s+(.+?)\s*(?:입력|작성)(?:하기|해줘)?$/.test(step)) {
        step = step.replace(
          /^(기안의견|결재의견|의견|장소)(?:에|은)?\s+(.+?)\s*(입력|작성)(?:하기|해줘)?$/,
          (_, field, val, verb) => {
            quotedCount++;
            return `${field}에 ${quoteValue(val)} ${verb}`;
          }
        );
      }
      // 5) "문서 내용에 / 본문에 / 내용에 / 신청사유에 OOO 입력"
      else if (/^(?:문서\s*내용에|문서\s*내용|본문에|본문\s*내용에|내용에|내용은|신청사유에|신청사유)\s+(.+?)\s*(?:입력|작성)(?:하기|해줘)?$/.test(step)) {
        step = step.replace(
          /^(문서\s*내용|본문\s*내용|본문|내용|신청사유)(?:에|은)?\s+(.+?)\s*(입력|작성)(?:하기|해줘)?$/,
          (_, field, val, verb) => {
            quotedCount++;
            return `${field}에 ${quoteValue(val)} ${verb}`;
          }
        );
      }
      // 6) "... 팝업에서 OOO 부서 선택"
      else if (/팝업에서\s+(.+?)\s+부서\s*(?:선택|클릭)/.test(step)) {
        step = step.replace(/팝업에서\s+(.+?)\s+부서\s*(선택|클릭)/, (_, dept, verb) => {
          quotedCount++;
          return `팝업에서 ${quoteValue(dept)} 부서 ${verb}`;
        });
      }
      // 7) "... (test001) 체크박스 선택"
      else if (/([a-zA-Z0-9_-]{3,})\s*(?:사원\s*)?(?:체크박스|체크)\s*(?:선택|클릭)/.test(step)) {
        step = step.replace(
          /([a-zA-Z0-9_-]{3,})\s*(사원\s*)?(체크박스|체크)\s*(선택|클릭)/,
          (_, user, emp, chk, verb) => {
            quotedCount++;
            return `${quoteValue(user)} ${emp || ""}${chk} ${verb}`;
          }
        );
      }
      // 8) "... 첫번째 합의 버튼 선택"
      else if (/(첫번째|두번째)?\s*(합의|결재|협조|감사|수신|참조)\s*버튼\s*(선택|클릭)/.test(step)) {
        step = step.replace(
          /(첫번째\s*|두번째\s*)?(합의|결재|협조|감사|수신|참조)\s*버튼\s*(선택|클릭)/,
          (_, ord, role, verb) => {
            quotedCount++;
            return `${ord || ""}'${role}' 버튼 ${verb}`;
          }
        );
      }
      // 9) "... test002 두번째 결재칸으로 드래그 앤 드롭"
      else if (/([a-zA-Z0-9_-]{3,})[을를]?\s*(두번째|2번째|첫번째)?\s*(결재칸|결재선|합의칸|슬롯).*드래그/.test(step)) {
        step = step.replace(
          /([a-zA-Z0-9_-]{3,})([을를])?\s*(두번째|2번째|첫번째)?\s*(결재칸|결재선|합의칸|슬롯)(.*드래그.*)/,
          (_, user, _josa, ord, slot, rest) => {
            quotedCount++;
            return `'${user}'를 ${ord ? `${ord} ` : ""}${slot}${rest}`;
          }
        );
      }
      // 10) Short "OOO 선택" right after a folder/category/resource/docbox button step (Case A step 2)
      else if (
        i > 0 &&
        /결재분류|분류\s*폴더|기록물철|문서보관함|문서함|게시판|자원/.test(rawSegments[i - 1]) &&
        /^([가-힣a-zA-Z0-9_\s]{1,20}?)\s*(?:선택|클릭)$/.test(step) &&
        !step.includes("버튼") &&
        !step.includes("확인") &&
        !step.includes("탭")
      ) {
        const m = step.match(/^([가-힣a-zA-Z0-9_\s]{1,20}?)\s*(선택|클릭)$/);
        if (m) {
          quotedCount++;
          const meta = getPopupMeta(rawSegments[i - 1]);
          step = `${meta.itemPrefix} ${quoteValue(m[1])} 항목 ${m[2]}`;
        }
      }
    }

    normalizedSteps.push(step);

    // [Case A step 3] Check if the previous step opened a category/folder/resource modal
    // and THIS step selected a tree node (e.g. '테스트' 선택), but the NEXT step does NOT click '확인'!
    if (
      i > 0 &&
      /결재분류|분류\s*폴더|기록물철|문서보관함|문서함|게시판|자원/.test(rawSegments[i - 1]) &&
      /선택|클릭/.test(step) &&
      !step.includes("확인") &&
      !step.includes("버튼")
    ) {
      const nextRaw = rawSegments[i + 1] || "";
      if (!nextRaw.includes("확인")) {
        const meta = getPopupMeta(rawSegments[i - 1]);
        normalizedSteps.push(meta.confirmStep);
        addedHints.push(`팝업 항목 선택 후 누락된 [${meta.confirmStep}] 단계 자동 보충`);
      }
    }

    // [Case D-2] Multi-step popup (결재선 선택 팝업, 조직도 팝업, 공유자/참석자 팝업):
    // If THIS step is inside a popup ("... 팝업에서 ...") and is NOT "확인/닫기/취소",
    // and the NEXT step leaves the popup (e.g., "결재상신 버튼 클릭", "저장 버튼 클릭") without clicking "확인"!
    const inPopupMatch = step.match(/(결재선\s*선택\s*팝업|조직도\s*팝업|공유자\s*팝업|참석자\s*팝업|담당자\s*팝업)에서/);
    if (inPopupMatch && !/확인|닫기|취소/.test(step)) {
      const nextRaw = rawSegments[i + 1] || "";
      if (nextRaw && !nextRaw.includes("팝업") && !nextRaw.includes("확인")) {
        const confirmStep = `${inPopupMatch[1]}에서 확인 클릭`;
        normalizedSteps.push(confirmStep);
        addedHints.push(`${inPopupMatch[1]} 작업 완료 후 누락된 [${confirmStep}] 단계 자동 보충`);
      }
    }
  }

  if (quotedCount > 0) {
    addedHints.unshift(`입력 텍스트 및 타겟 명칭 ${quotedCount}곳에 작은따옴표(' ') 정밀 구분자 자동 적용`);
  }

  const normalizedPrompt =
    normalizedSteps.length > 1 ? normalizedSteps.join(" -> ") : normalizedSteps[0] || text;

  return {
    normalizedPrompt,
    steps: normalizedSteps,
    addedHints,
  };
}

/**
 * Polishes any user prompt (either free-form prose or a rough arrow chain) into a studio-grade
 * 'Step 1 -> Step 2 -> Step 3' chain with single-quoted target values and complete modal confirmations.
 */
export async function polishPromptWithAI(rawPrompt: string): Promise<{
  normalizedPrompt: string;
  steps: string[];
  addedHints: string[];
}> {
  const det = normalizeUserPrompt(rawPrompt);
  // If the user already wrote an arrow chain (or deterministic splitter produced >= 4 steps), return immediately (<5ms)!
  if (det.steps.length >= 4 || /->|➔|=>/.test(rawPrompt)) {
    return det;
  }

  const apiKeys = [process.env.GEMINI_API_KEY, process.env.GEMINI_API_KEY_ALT].filter(Boolean) as string[];
  if (apiKeys.length === 0) {
    return det;
  }

  try {
    const ai = new GoogleGenAI({ apiKey: apiKeys[0] });
    const model = process.env.GEMINI_MODEL || "gemini-3.5-flash";
    const response = await ai.models.generateContent({
      model,
      contents: [
        {
          role: "user",
          parts: [
            {
              text: `Convert the following user scenario request into a step-by-step Korean arrow chain ('단계1 -> 단계2 -> 단계3').
Rules:
1. Wrap every specific target name, template name, user ID, folder name, search keyword, title, and body text in single quotes ('...').
2. Whenever a popup/modal is opened (결재분류, 문서함 선택, 결재선 선택, 자원 선택 등) and an item is selected, ALWAYS include '-> 팝업에서 확인 클릭' right after.
3. For Electronic Approval (전자결재) template selection, use: "검색으로 '양식명' 검색 -> '양식명' 결재업무 카드 선택 후 작성 클릭".
4. Return ONLY a JSON object: {"normalizedPrompt": "단계1 -> 단계2 -> ...", "addedHints": ["보완된 사항 요약1", "보완된 사항 요약2"]}

User Request: "${rawPrompt}"`,
            },
          ],
        },
      ],
      config: {
        temperature: 0.1,
        responseMimeType: "application/json",
      },
    });

    recordAiUsage({
      feature: "프롬프트 다듬기",
      model,
      usageMetadata: response.usageMetadata,
      fallbackPromptChars: rawPrompt.length + 500,
      fallbackOutputChars: (response.text || "").length,
    });

    const parsed = JSON.parse(response.text || "{}");
    if (parsed.normalizedPrompt) {
      const reNorm = normalizeUserPrompt(parsed.normalizedPrompt);
      return {
        normalizedPrompt: reNorm.normalizedPrompt,
        steps: reNorm.steps,
        addedHints: Array.from(new Set([...(parsed.addedHints || []), ...reNorm.addedHints])),
      };
    }
  } catch {}

  return det;
}

/**
 * Generates BrowsePlan using Google AI Studio Gemini API with unified, autonomous code exploration
 * and pre-flight multimodal visual probing.
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

  // --- Step 0: Automatic Prompt Normalization & Step-Chain Extraction ---
  const normalizedInfo = normalizeUserPrompt(options.prompt);
  const effectivePrompt = normalizedInfo.normalizedPrompt || options.prompt;
  if (normalizedInfo.addedHints.length > 0) {
    options.onProgress?.(
      `🪄 [프롬프트 자동 정밀 보정] ${normalizedInfo.addedHints.join(" / ")}`
    );
  }

  const currentConfig = getConfig();
  const effectiveTargetPath = options.targetProjectPath || currentConfig.targetProjectPath;
  const effectiveTargetUrl = options.targetUrl || currentConfig.targetBaseUrl;

  // --- Check Smart AI Plan Cache (Token-Saving Layer) ---
  if (!options.bypassCache) {
    const cached = getCachedPlan(
      effectivePrompt,
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
        prompt: effectivePrompt,
        slug: options.slug,
        onProgress: options.onProgress,
      });
      if (probeResult.success && probeResult.screens.length > 0) {
        visualScreens = probeResult.screens;
        options.onProgress?.(`📸 [시각 정보 주입] 확보된 ${visualScreens.length}장의 실제 브라우저 화면과 핵심 DOM 후보군을 Gemini 멀티모달 시각 엔진에 주입합니다.`);
      }
    } catch (probeErr: any) {
      console.warn(`[VisualProbe] Failed during scenario planning: ${probeErr.message}`);
    }
  }

  // --- Initialize Autonomous Code Explorer Tools for Target Project (Optional) ---
  const toolExecutors = hasLocalSource ? createCodeExplorerTools(effectiveTargetPath) : {};
  const toolDeclarations = hasLocalSource ? codeExplorerToolDeclarations : [];
  const toolActivityLogs: string[] = [];

  const codeContext = scanTargetProjectContext(effectivePrompt, effectiveTargetPath);
  const fewShotContext = loadFewShotExamples(effectivePrompt);
  const groupwareContext = getGroupwarePromptContext(effectivePrompt);

  // Unified, non-redundant System Instruction (Single Source of Truth)
  const systemInstruction = `
You are the Lead Video Automation Director & Browser Reverse Engineering Architect.
Your role is to construct a studio-grade, 5-phase BrowsePlan JSON scenario that executes with 100% precision in Playwright.

${groupwareContext}

${MASTER_DIRECTING_GUIDELINES}

---

### Target System Environment
- Target Web URL: ${effectiveTargetUrl}
- Operation Mode: ${hasLocalSource ? `Local Source + Live Web Hybrid (${effectiveTargetPath})` : "Live Web Direct Mode"}

${hasLocalSource ? `### Discovered Project Source Context\n${codeContext}\n\n### Reverse Engineering Tool Usage\n- If any selector is not already covered in [NAONSOFT ENTERPRISE GROUPWARE KNOWLEDGE BASE V3] or [사전 시각 탐색 DOM 후보군], use tools (searchCodeText, findFiles, readSourceSnippet, extractAlertsAndValidation) to inspect real JSP/JS files.` : ""}

### Verified Reference Scenario Patterns
${fewShotContext}
`;

  const stepChainDirective =
    normalizedInfo.steps.length >= 2
      ? `\n### [Mandatory User Step-Chain Sequence (${normalizedInfo.steps.length} Ordered Milestones — Do NOT Skip Any Step!)]\n${normalizedInfo.steps
          .map((s, idx) => `  Step ${idx + 1}: ${s}`)
          .join("\n")}\n`
      : "";

  const userContent = `
User Scenario Request: "${effectivePrompt}"
${stepChainDirective}
Requested Slug: ${options.slug || "auto-generate"}
Target URL: ${effectiveTargetUrl}
Directing Style: ${options.directingStyle || "standard"} (${
    options.directingStyle === "fast"
      ? "Fast showcase pacing: 1200ms-1800ms wait intervals"
      : options.directingStyle === "detailed"
      ? "Detailed manual pacing: 3500ms-4500ms wait intervals"
      : "Standard educational pacing: 2500ms-3500ms wait intervals"
  })
Scenario Completeness Policy: ${
    normalizedInfo.steps.length >= 2
      ? `Follow the user's ${normalizedInfo.steps.length} step-chain milestones 1:1 from start to finish (do NOT truncate steps and do NOT invent unrelated filler steps).`
      : "Cover the complete requested flow naturally from entry to final verification without omitting any user requirement."
  }

1. Classify the user's intent into one of the 4 Universal Archetypes (EXPLORATION, SEARCH_VIEW, CREATE_SUBMIT, WORKFLOW_MANAGE).
2. Apply the Conditional Target Resolution Policy:
   - If the user explicitly named a target (e.g., '회의록', '테스트', 'test001', 'test002', '결재선'), NEVER use blind :first-child! Plan the full search/selection sequence and match the exact Korean/alphanumeric text (:has-text('...')).
   - Only use "useScraped": "auto" and "dynamicStrategy": "first-row-title" when searching existing list rows in a generic SEARCH_VIEW scenario where no specific keyword was given. NEVER include "useScraped" on form title/body inputs or explicit keyword searches!
3. Ensure all action "description" strings, "explanation", and text-matching selectors (:has-text('...')) are in Korean.

Respond ONLY with valid JSON matching this schema:
{
  "suggestedSlug": "kebab-case-slug-name",
  "explanation": "한글 시나리오 요약 및 [⚠️ 사용자 직접 입력 필요 항목 안내]",
  "plan": {
    "url": "${effectiveTargetUrl}",
    "viewport": { "width": 1920, "height": 1080 },
    "requiresLogin": true,
    "actions": [
      {
        "type": "wait" | "click" | "hover" | "type" | "dblclick" | "scroll" | "navigate" | "dragAndDrop",
        "selector": "css selector string (leave empty \"\" if unknown)",
        "sourceSelector": "css selector for drag start element (ONLY when type is dragAndDrop)",
        "targetSelector": "css selector for drop target element (ONLY when type is dragAndDrop)",
        "iframe": "iframe selector string (ONLY when inside an editor iframe like #subBody)",
        "text": "text to type (ONLY when type is 'type')",
        "ms": 2000,
        "description": "한글 액션 설명",
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
            parts: [
              { text: userContent },
              ...(visualScreens.length > 0
                ? [
                    {
                      text:
                        `\n\n### [👁️ 사전 시각 탐색: 실제 브라우저 실시간 캡처 화면 및 우선순위 정제된 DOM 요소 증거]\n` +
                        `시나리오 AI가 브라우저를 직접 구동하여 현 시점 실제 접속한 화면 스크린샷과 추출된 핵심 DOM 요소들입니다.\n` +
                        `절대로 추측이나 상상으로 셀렉터를 지어내지 말고, 아래 캡처된 실제 화면 이미지와 [추출된 핵심 인터랙티브 엘리먼트 후보군]의 'suggestedSelector' 및[NAONSOFT ENTERPRISE GROUPWARE KNOWLEDGE BASE V3]를 결합하여 시나리오를 구성하십시오.\n`,
                    },
                    ...visualScreens.flatMap((s, i) => {
                      const prioritized = prioritizeProbeCandidates(s.candidates, options.prompt, 85);
                      return [
                        {
                          text:
                            `\n\n#### 📸 [화면 #${i + 1}: ${s.name}] (URL: ${s.url})\n` +
                            (s.dialogTitle ? `활성 대화상자: "${s.dialogTitle}"\n` : "") +
                            (s.openedBy ? `⚠️ 필수 진입 트리거: "${s.openedBy}" (이 화면으로 진입하려면 직전 단계에서 이 트리거를 클릭하는 액션이 반드시 필요합니다!)\n` : "") +
                            `화면에서 추출된 핵심 인터랙티브 엘리먼트 후보군 (중요도순 상위 ${prioritized.length}개 / 전체 ${s.candidates.length}개):\n` +
                            JSON.stringify(prioritized, null, 2),
                        },
                        {
                          inlineData: {
                            mimeType: "image/jpeg",
                            data: s.base64,
                          },
                        },
                      ];
                    }),
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
              responseMimeType: toolDeclarations.length === 0 ? "application/json" : undefined,
              temperature: 0.2,
              maxOutputTokens: 8192,
            },
          });

          const usageRec = recordAiUsage({
            feature: "시나리오 생성",
            model,
            usageMetadata: response.usageMetadata,
            fallbackPromptChars: systemInstruction.length + prompt.length,
            fallbackOutputChars: (response.text || "").length,
          });
          options.onProgress?.(
            `💰 [AI 토큰/요금] 입력 ${usageRec.promptTokens.toLocaleString()} + 출력 ${usageRec.outputTokens.toLocaleString()} = ${usageRec.totalTokens.toLocaleString()} 토큰 ($${usageRec.costUsd.toFixed(5)} / 약 ${usageRec.costKrw.toFixed(2)}원)`
          );

          const functionCalls = response.functionCalls;
          if (functionCalls && functionCalls.length > 0) {
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
            const text = response.text || "";
            if (text.trim().length > 0) {
              try {
                parsed = parseAndRepairJson(text);
                if (!parsed || !parsed.plan || !Array.isArray(parsed.plan.actions) || parsed.plan.actions.length === 0) {
                  throw new Error("생성된 JSON에 actions 배열이 누락되었거나 비어 있습니다.");
                }
                console.log(`[Unified Gemini Director] Generated plan with model "${model}" in ${turn} turn(s)!`);
                break modelLoop;
              } catch (jsonErr: any) {
                console.warn(`[Unified Gemini Director] Model "${model}" produced unparseable JSON (${jsonErr.message}).`);
                lastError = jsonErr;
                parsed = null;
              }
            }
            break;
          }
        }

        // If tool turns completed and we need the final JSON plan
        if (!parsed) {
          options.onProgress?.(`🎬 [플랜 합성] 소스코드 및 시각 탐색 결과를 종합하여 최종 5단계 BrowsePlan JSON을 작성 중입니다...`);
          contents.push({
            role: "user",
            parts: [
              {
                text: "소스코드 및 화면 탐색이 완료되었습니다. 지금까지 확인된 요소들을 바탕으로, 더 이상의 도구 호출 없이 최종 BrowsePlan JSON만을 즉시 산출하십시오.",
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
                temperature: 0.2 + retryCount * 0.2,
                maxOutputTokens: 8192,
              },
            });

            const finalUsageRec = recordAiUsage({
              feature: "시나리오 플랜 합성",
              model,
              usageMetadata: finalResponse.usageMetadata,
              fallbackPromptChars: systemInstruction.length + prompt.length,
              fallbackOutputChars: (finalResponse.text || "").length,
            });
            options.onProgress?.(
              `💰 [AI 토큰/요금] 입력 ${finalUsageRec.promptTokens.toLocaleString()} + 출력 ${finalUsageRec.outputTokens.toLocaleString()} = ${finalUsageRec.totalTokens.toLocaleString()} 토큰 ($${finalUsageRec.costUsd.toFixed(5)} / 약 ${finalUsageRec.costKrw.toFixed(2)}원)`
            );

            const finalText = finalResponse.text || "";
            if (finalText.trim().length > 0) {
              try {
                parsed = parseAndRepairJson(finalText);

                if (!parsed || !parsed.plan || !Array.isArray(parsed.plan.actions) || parsed.plan.actions.length === 0) {
                  throw new Error("생성된 JSON에 actions 배열이 누락되었거나 비어 있습니다. BrowsePlan 스펙에 맞춰 처음부터 다시 작성해주세요.");
                }

                sanitizeBrowsePlan(parsed.plan);

                console.log(`[Unified Gemini Director] Successfully finalized JSON plan with model "${model}"!`);
                break modelLoop;
              } catch (jsonErr: any) {
                console.warn(`[Unified Gemini Director] JSON parse or validation failed (Attempt ${retryCount + 1}): ${jsonErr.message}`);
                lastError = jsonErr;
                parsed = null;

                contents.push({ role: "model", parts: [{ text: finalText }] });
                contents.push({
                  role: "user",
                  parts: [
                    {
                      text: `🚨 오류 발생: ${jsonErr.message}\n이전 응답의 JSON 형식이 잘못되었거나 필수 항목이 누락되었습니다. 오류를 수정한 완벽한 JSON을 다시 생성하십시오.`,
                    },
                  ],
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

  const actionSpecSummary = [
    `# [화면 조작 기획 및 소스코드 탐색 결과] ${options.prompt}`,
    "",
    `## 1. 개요 및 연출 의도`,
    `- 설명: ${parsed.explanation || "시나리오가 성공적으로 생성되었습니다."}`,
    `- 총 연출 액션 수: ${sanitizedPlan.actions.length}단계`,
    ...(visualScreens.length > 0
      ? [`- 👁️ 사전 시각 탐색: 실제 브라우저 화면 ${visualScreens.length}장 캡처 및 핵심 DOM 후보군(최대 85개/화면) 시각 분석 반영`]
      : []),
    "",
    `## 2. 실시간 소스코드 도구 탐색 내역`,
    toolActivityLogs.length > 0
      ? toolActivityLogs.map((l) => `- ${l}`).join("\n")
      : "- 그룹웨어 V3 지식베이스 및 실시간 시각 탐색 DOM 구조를 기반으로 플랜을 직결 생성했습니다.",
    "",
    `## 3. 식별된 핵심 인터랙티브 요소`,
    ...sanitizedPlan.actions
      .filter((a) => a.selector || a.sourceSelector)
      .map((a, idx) =>
        a.type === "dragAndDrop"
          ? `- 단계 ${idx + 1} (${a.type}): \`${a.sourceSelector}\` ➔ \`${a.targetSelector}\` (${a.description})`
          : `- 단계 ${idx + 1} (${a.type}): \`${a.selector}\` (${a.description})`
      ),
  ].join("\n");

  const finalResult: GeneratePlanResult = {
    plan: sanitizedPlan,
    explanation: parsed.explanation || "시나리오가 성공적으로 생성되었습니다.",
    suggestedSlug: suggestedSlug.replace(/[^a-zA-Z0-9_\-]/g, "-").toLowerCase(),
    actionSpecMarkdown: actionSpecSummary,
    isFromCache: false,
    visualScreensCount: visualScreens.length,
  };

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

import { GoogleGenAI, Type } from "@google/genai";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";

dotenv.config({ override: true });

const API_KEY = process.env.GEMINI_API_KEY || "";
const API_KEY_ALT = process.env.GEMINI_API_KEY_ALT || "";
const MODEL_CANDIDATES = [
  process.env.GEMINI_MODEL || "gemini-3.8-flash",
  "gemini-3.8-flash",
  "gemini-3.5-flash",
  "gemini-3.5-flash-lite",
  "gemini-flash-latest",
  "gemini-2.5-flash",
];

export interface ActionSpecResult {
  actionSpecMarkdown: string;
  identifiedSelectors: Array<{ name: string; selector: string; description: string }>;
  validationAlerts: string[];
  recommendedSteps: string[];
}

/**
 * Creates autonomous code exploration tools for a given target project root.
 */
export function createCodeExplorerTools(projectRoot: string) {
  const normalizedRoot = projectRoot.trim().replace(/\\/g, "/");

  return {
    /**
     * Search files matching module or keyword
     */
    findFiles: (args: { moduleName?: string; keyword?: string; fileType?: string }) => {
      const results: string[] = [];
      const moduleName = (args.moduleName || "").trim().toLowerCase();
      const keyword = (args.keyword || "").trim().toLowerCase();
      const fileType = (args.fileType || "all").trim().toLowerCase();

      // Map common module names to actual enterprise directory names
      const moduleAliases: Record<string, string[]> = {
        mail: ["eml", "mail"],
        email: ["eml", "mail"],
        eml: ["eml", "mail"],
        schedule: ["scd", "schedule"],
        calendar: ["scd", "schedule"],
        scd: ["scd", "schedule"],
        note: ["not", "note"],
        not: ["not", "note"],
        app: ["app", "eapp", "approval"],
        approval: ["app", "eapp", "approval"],
        eapp: ["app", "eapp", "approval"],
        doc: ["doc", "document"],
        document: ["doc", "document"],
        board: ["board", "brd"],
        brd: ["board", "brd"],
        work: ["work", "smw", "wor"],
        smw: ["work", "smw", "wor"],
        attend: ["attend", "atn"],
        atn: ["attend", "atn"],
        res: ["res", "rmg"],
        rmg: ["res", "rmg"],
      };

      // Priority search roots
      const candidateRoots: string[] = [];
      if (moduleName) {
        const targetMods = moduleAliases[moduleName] || [moduleName];
        for (const mod of targetMods) {
          candidateRoots.push(
            path.join(normalizedRoot, "naon-module-web", "src", "main", "webapp", "resources", "biz", "gw", mod),
            path.join(normalizedRoot, "naon-module-web", "src", "main", "webapp", "jsp", "biz", "gw", mod),
            path.join(normalizedRoot, "src", "main", "webapp", "resources", "biz", "gw", mod),
            path.join(normalizedRoot, "src", "main", "webapp", "jsp", "biz", "gw", mod)
          );
        }
      } else {
        candidateRoots.push(
          path.join(normalizedRoot, "naon-module-web", "src", "main", "webapp", "resources", "biz", "gw"),
          path.join(normalizedRoot, "naon-module-web", "src", "main", "webapp", "jsp", "biz", "gw"),
          path.join(normalizedRoot, "src")
        );
      }

      function scanDir(dir: string, depth = 0) {
        if (depth > 6 || results.length >= 25 || !fs.existsSync(dir)) return;
        try {
          const items = fs.readdirSync(dir);
          for (const item of items) {
            if (results.length >= 25) break;
            if (item.startsWith(".") || item === "node_modules" || item === "target" || item === "dist") continue;

            const fullPath = path.join(dir, item);
            let stat: fs.Stats;
            try {
              stat = fs.statSync(fullPath);
            } catch {
              continue;
            }

            if (stat.isDirectory()) {
              scanDir(fullPath, depth + 1);
            } else if (stat.isFile()) {
              const lower = item.toLowerCase();
              const ext = path.extname(lower).replace(".", "");
              if (fileType !== "all" && ext !== fileType) continue;

              if (!keyword || lower.includes(keyword) || fullPath.toLowerCase().includes(keyword)) {
                const relPath = path.relative(normalizedRoot, fullPath).replace(/\\/g, "/");
                results.push(`${relPath} (${Math.round(stat.size / 1024)}KB)`);
              }
            }
          }
        } catch {}
      }

      for (const root of candidateRoots) {
        if (fs.existsSync(root)) {
          scanDir(root, 0);
          if (results.length >= 20) break;
        }
      }

      return {
        matchedCount: results.length,
        files: results.slice(0, 20),
        searchedModule: moduleName || "all"
      };
    },

    /**
     * Read lines of source file
     */
    readSourceSnippet: (args: { filePath: string; startLine?: number; lineCount?: number }) => {
      const fullPath = path.isAbsolute(args.filePath)
        ? args.filePath
        : path.join(normalizedRoot, args.filePath);

      if (!fs.existsSync(fullPath)) {
        return { error: `파일을 찾을 수 없습니다: ${args.filePath}` };
      }

      try {
        const content = fs.readFileSync(fullPath, "utf-8");
        const allLines = content.split("\n");
        const start = Math.max(1, args.startLine || 1);
        const count = Math.min(150, Math.max(10, args.lineCount || 80));
        const end = Math.min(allLines.length, start + count - 1);

        const linesWithNumbers: string[] = [];
        for (let i = start - 1; i < end; i++) {
          linesWithNumbers.push(`L${i + 1}: ${allLines[i]}`);
        }

        return {
          filePath: args.filePath,
          totalLines: allLines.length,
          range: `L${start} - L${end}`,
          content: linesWithNumbers.join("\n")
        };
      } catch (err: any) {
        return { error: `파일 읽기 오류: ${err.message}` };
      }
    },

    /**
     * Extract alert and validation rules from JavaScript/JSP
     */
    extractAlertsAndValidation: (args: { filePath: string }) => {
      const fullPath = path.isAbsolute(args.filePath)
        ? args.filePath
        : path.join(normalizedRoot, args.filePath);

      if (!fs.existsSync(fullPath)) {
        return { error: `파일을 찾을 수 없습니다: ${args.filePath}` };
      }

      try {
        const content = fs.readFileSync(fullPath, "utf-8");
        const lines = content.split("\n");
        const matches: Array<{ line: number; code: string; comment?: string }> = [];

        for (let i = 0; i < lines.length; i++) {
          const l = lines[i];
          if (
            l.includes("alert(") ||
            l.includes("naon.ui.alert") ||
            l.includes("confirm(") ||
            l.includes("naon.ui.confirm") ||
            l.includes("chkValid") ||
            l.includes("validate")
          ) {
            const snippet = lines.slice(i, Math.min(lines.length, i + 3)).map((s) => s.trim()).join(" ");
            let comment = "";
            const commentMatch = snippet.match(/\/\*([^*]+)\*\//) || snippet.match(/\/\/(.+)$/);
            if (commentMatch) comment = commentMatch[1].trim();

            matches.push({
              line: i + 1,
              code: snippet.slice(0, 140),
              comment: comment || undefined
            });
            if (matches.length >= 10) break;
          }
        }

        return {
          filePath: args.filePath,
          totalAlertRules: matches.length,
          validationAlerts: matches
        };
      } catch (err: any) {
        return { error: `유효성 검사 추출 오류: ${err.message}` };
      }
    },

    /**
     * Grep search text/ID across code files
     */
    searchCodeText: (args: { keyword: string; moduleName?: string; fileType?: string }) => {
      const rawKeyword = (args.keyword || "").trim();
      const moduleName = (args.moduleName || "").trim().toLowerCase();
      const fileType = (args.fileType || "all").trim().toLowerCase();
      if (!rawKeyword) {
        return { error: "검색어를 지정해주세요." };
      }

      const matches: Array<{ file: string; line: number; snippet: string }> = [];
      const searchRegex = new RegExp(rawKeyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");

      const candidateRoots: string[] = [];
      if (moduleName) {
        candidateRoots.push(
          path.join(normalizedRoot, "naon-module-web", "src", "main", "webapp", "resources", "biz", "gw", moduleName),
          path.join(normalizedRoot, "naon-module-web", "src", "main", "webapp", "jsp", "biz", "gw", moduleName),
          path.join(normalizedRoot, "src", "main", "webapp", "resources", "biz", "gw", moduleName),
          path.join(normalizedRoot, "src", "main", "webapp", "jsp", "biz", "gw", moduleName)
        );
      } else {
        candidateRoots.push(
          path.join(normalizedRoot, "naon-module-web", "src", "main", "webapp", "resources", "biz", "gw"),
          path.join(normalizedRoot, "naon-module-web", "src", "main", "webapp", "jsp", "biz", "gw"),
          path.join(normalizedRoot, "src")
        );
      }

      function grepInDir(dir: string, depth = 0) {
        if (depth > 6 || matches.length >= 20 || !fs.existsSync(dir)) return;
        try {
          const items = fs.readdirSync(dir);
          for (const item of items) {
            if (matches.length >= 20) break;
            if (item.startsWith(".") || item === "node_modules" || item === "target" || item === "dist") continue;

            const full = path.join(dir, item);
            let stat: fs.Stats;
            try {
              stat = fs.statSync(full);
            } catch {
              continue;
            }

            if (stat.isDirectory()) {
              grepInDir(full, depth + 1);
            } else if (stat.isFile()) {
              const ext = path.extname(item.toLowerCase()).replace(".", "");
              if (fileType !== "all" && ext !== fileType) continue;
              if (!["js", "jsp", "html", "vue", "tsx", "jsx"].includes(ext)) continue;

              try {
                const content = fs.readFileSync(full, "utf-8");
                const lines = content.split("\n");
                for (let i = 0; i < lines.length; i++) {
                  if (searchRegex.test(lines[i])) {
                    const relPath = path.relative(normalizedRoot, full).replace(/\\/g, "/");
                    matches.push({
                      file: relPath,
                      line: i + 1,
                      snippet: lines[i].trim().slice(0, 140),
                    });
                    if (matches.length >= 20) break;
                  }
                }
              } catch {}
            }
          }
        } catch {}
      }

      for (const root of candidateRoots) {
        if (fs.existsSync(root)) {
          grepInDir(root, 0);
          if (matches.length >= 20) break;
        }
      }

      return {
        keyword: rawKeyword,
        totalHits: matches.length,
        matches,
      };
    },

    /**
     * Search documentation
     */
    searchDocs: (args: { query: string }) => {
      const query = args.query.toLowerCase().trim();
      const docDirs = [path.join(normalizedRoot, "agyDocs"), path.join(normalizedRoot, "docs"), normalizedRoot];
      const snippets: string[] = [];

      for (const dir of docDirs) {
        if (!fs.existsSync(dir)) continue;
        try {
          const files = fs.readdirSync(dir);
          for (const file of files) {
            if (!file.endsWith(".md")) continue;
            const fullPath = path.join(dir, file);
            const content = fs.readFileSync(fullPath, "utf-8");
            const lines = content.split("\n");

            for (let i = 0; i < lines.length; i++) {
              if (lines[i].toLowerCase().includes(query)) {
                const start = Math.max(0, i - 2);
                const end = Math.min(lines.length, i + 12);
                snippets.push(`[${path.basename(dir)}/${file} L${start + 1}-${end}]\n` + lines.slice(start, end).join("\n"));
                i = end;
                if (snippets.length >= 3) break;
              }
            }
          }
        } catch {}
      }

      return {
        query,
        foundDocs: snippets.length,
        snippets
      };
    }
  };
}

/**
 * Gemini Tool Declarations for Code Exploration
 */
export const codeExplorerToolDeclarations = [
  {
    name: "searchCodeText",
    description: "Search for exact text, Korean labels (e.g. '일정등록', '기안작성', '새문서', '저장', '상신', '검색'), button IDs, or click event handlers across JSP, JS, and HTML source files. Highly recommended as the 1st step to find the exact DOM selector of buttons and form fields!",
    parameters: {
      type: Type.OBJECT,
      properties: {
        keyword: { type: Type.STRING, description: "Text or label to search, e.g. '일정등록', '일정', '기안', '검색', 'save', 'write'" },
        moduleName: { type: Type.STRING, description: "Module name like 'schedule', 'app', 'doc', 'board', 'search', 'mail'" },
        fileType: { type: Type.STRING, description: "File extension like 'jsp', 'js', or 'all'" }
      },
      required: ["keyword"]
    }
  },
  {
    name: "findFiles",
    description: "Search for source files (JSP, JS, TSX, HTML) in target project by module name (e.g. app, doc, board, schedule, search, mail) or keyword (e.g. reg, write, view, list, search, left).",
    parameters: {
      type: Type.OBJECT,
      properties: {
        moduleName: { type: Type.STRING, description: "Module name like 'app', 'doc', 'board', 'work', 'schedule', 'search', 'mail'" },
        keyword: { type: Type.STRING, description: "Filename keyword like 'write', 'reg', 'popup', 'view', 'list', 'left', 'search'" },
        fileType: { type: Type.STRING, description: "File extension like 'js', 'jsp', or 'all'" }
      }
    }
  },
  {
    name: "readSourceSnippet",
    description: "Read lines of a specific source file to identify exact HTML form elements, DOM IDs, button classes, and JavaScript event handlers.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        filePath: { type: Type.STRING, description: "Project-relative file path returned by findFiles or searchCodeText" },
        startLine: { type: Type.INTEGER, description: "Start line number (1-based)" },
        lineCount: { type: Type.INTEGER, description: "Number of lines to read (max 150)" }
      },
      required: ["filePath"]
    }
  },
  {
    name: "extractAlertsAndValidation",
    description: "Extract alert messages, form validation checks (chkValid, naon.ui.alert, empty title checks) from a JavaScript or JSP file to discover mandatory input fields.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        filePath: { type: Type.STRING, description: "Project-relative file path" }
      },
      required: ["filePath"]
    }
  },
  {
    name: "searchDocs",
    description: "Search project documentation (agyDocs, docs, CLAUDE.md) for existing architectural notes or scenario guidelines.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: { type: Type.STRING, description: "Search query or keyword" }
      },
      required: ["query"]
    }
  }
];

/**
 * Stage 1: Autonomous Code Explorer Agent (Legacy wrapper)
 */
export async function exploreCodebaseForActionSpec(
  prompt: string,
  projectRoot: string,
  onProgress?: (message: string) => void
): Promise<ActionSpecResult> {
  const normalizedRoot = projectRoot.trim().replace(/\\/g, "/");
  onProgress?.(`🔍 [Code Explorer Agent] 대상 프로젝트 경로 탐색 준비: ${path.basename(normalizedRoot)}`);

  const toolExecutors = createCodeExplorerTools(projectRoot);
  const toolDeclarations = codeExplorerToolDeclarations;
  const systemInstruction = `당신은 웹 애플리케이션의 소스코드를 직접 역공학(Reverse Engineering)하여 정밀 분석하는 전문 'Code Explorer Agent'입니다.
사용자가 "상단 메뉴에서 일정관리로 이동하여 주간 부서 회의 일정을 등록하고 저장하는 시나리오"처럼 일상적인 자연어로 간단하게 요청하더라도, 당신은 전문 시니어 개발자처럼 소스코드를 정밀하게 파고들어 100% 검증된 [화면 조작 기획서 (Action Spec)]를 작성해야 합니다.

[★ 핵심 원칙 1: 사용자 요청 4대 인터랙션 자동 분해 (Chain of Goals)]
사용자의 단순한 요청에서 다음 4대 핵심 요소를 차례대로 도구를 통해 소스코드에서 반드시 찾아내십시오:
1. [진입 메뉴/경로]: 사용자가 언급한 업무 기능(예: '일정관리', '전자결재', '게시판', '문서관리')의 GNB 메뉴 텍스트 및 링크.
2. [등록/작성 트리거 버튼]: 화면에서 작성/등록을 시작하는 버튼.
   - 엔터프라이즈 시스템에서 이 버튼은 메인 화면이 아니라 [좌측 사이드바 (*LeftView.jsp, *Left.js)] 상단(#reg_*_lefttop, .workset_btn, button#gapLeft_workWriteBtn 등)에 있습니다!
   - searchCodeText로 '일정등록', '기안작성', '글작성', '등록' 등을 검색하여 실제 <button id="...">를 찾아내십시오.
3. [작성 폼 3대 핵심 필드 심층 추적 (Deep Drill-down)]:
   - 등록 버튼을 클릭했을 때 열리는 폼 파일(*SimpleView.jsp, *Write.jsp, 또는 팝업 컴포넌트)을 findFiles나 searchCodeText로 찾아 반드시 readSourceSnippet으로 직접 읽으십시오!
   - 그 화면 소스 안에서 실제 사용되는 3대 요소를 찾아내십시오:
     ① 제목 필드 (예: <input id="subject" name="subject">)
     ② 본문 내용 필드 (예: <textarea id="cn">)
     ③ 최종 저장/등록 버튼 (예: <button id="savebtn">)
4. [유효성 검사(Validation Alert) 추적]:
   - 폼 저장 시 필수값 누락을 체크하는 자바스크립트 if문 및 alert() 메시지를 extractAlertsAndValidation으로 찾아 필수 입력 순서를 규정하십시오.

[★ 핵심 원칙 2: 🚨 출처 증거 강제 (Evidence-Based Verification)]
- 당신이 도구(searchCodeText, readSourceSnippet)로 실제 소스 라인을 직접 읽어서 확인한 ID만 기획서에 기록하십시오.
- 식별된 모든 DOM 셀렉터 옆에는 반드시 [확인된 출처: 파일명:라인번호] (예: scdLeftView.jsp:L48)를 명시하십시오!
- 출처 라인 번호가 없는 가상의 ID는 절대 인정되지 않습니다.

[★ 핵심 원칙 3: 🚨 모르면 절대로 ID를 추측하지 말고 비워두거나 텍스트 매칭 사용! (Zero-Guessing Policy)]
- 만약 특정 버튼이나 입력창의 ID를 소스코드에서 찾지 못했거나 불확실하다면, 절대로 그럴듯한 영어 ID(#btn_orgUIselectDialog, #scd_write_btn, #_DOC_TITLE_ 등)를 지어내지 마십시오!
- 모르는 항목은 다음과 같이 정직하게 처리하십시오:
  1) 화면 텍스트 매칭이 가능하면: 예) \`button:has-text("일정 등록"):visible\`
  2) 텍스트 매칭도 불확실하면: **아예 셀렉터를 비워두고(\`""\`)**, 기획서의 [## 3. ⚠️ 사용자 확인/직접 입력 필요 항목]에 등록하십시오!
  3) 기획서와 설명에 "사용자가 대시보드 에디터에서 직접 셀렉터를 입력해야 함"을 명확히 안내하십시오.
  - 대시보드 에디터는 비어있는 셀렉터가 있는 액션 카드에 주황색 펄스 테두리와 '⚠️ 셀렉터 입력 필요' 배지, 그리고 퀵 채우기 헬퍼를 자동으로 띄워주기 때문에, 사용자가 1초 만에 안전하게 직접 입력할 수 있습니다!

[도메인별 모듈 접두사 및 급소 파일 매핑 사전]
- 검색/통합검색: moduleName="search", 파일 접두어 \`search\` (급소: searchBox.jsp, unifiedSearch.jsp, searchResult.jsp, gnbSearch.jsp)
- 일정/캘린더: moduleName="schedule", 파일 접두어 \`scd\` (급소: scdLeftView.jsp, scdInsertScheduleSimpleView.jsp, scdInsertScheduleSimpleView.js)
- 전자결재: moduleName="app", 파일 접두어 \`gap\` (급소: gapLeftView.jsp, gapWorkSelect.jsp, gapDocReg.jsp)
- 게시판: moduleName="board", 파일 접두어 \`brd\` (급소: brdLeftView.jsp, brdAtclReg.jsp)
- 문서관리: moduleName="doc", 파일 접두어 \`doc\` (급소: docLeftView.jsp, docWrite.jsp)
- 업무/스마트워크: moduleName="work", 파일 접두어 \`wor\` (급소: worLeftView.jsp, worWorkReg.jsp)
- 메일/웹메일: moduleName="mail", 파일 접두어 \`eml\` (급소: emlLeftView.jsp, emlWrite.jsp)
- 자원예약: moduleName="res", 파일 접두어 \`rmg\` (급소: rmgLeftView.jsp, rmgResReg.jsp)
- 근태관리: moduleName="attend", 파일 접두어 \`atn\` (급소: atnLeftView.jsp, atnCard.jsp)
- 설문조사: moduleName="survey", 파일 접두어 \`sur\` (급소: surLeftView.jsp, surWrite.jsp)
- 프로젝트: moduleName="project", 파일 접두어 \`prj\` (급소: prjLeftView.jsp, prjTaskReg.jsp)

[★ 실전 역공학 도구 호출 4단계 황금 워크플로우 (Golden Tool Execution Sequence)]
턴을 낭비하지 않고 100% 정밀하게 소스코드를 파고들기 위해 다음 순서로 도구를 호출하십시오:
1단계 [트리거 버튼 찾기]:
  - \`searchCodeText({ keyword: "등록", moduleName: "...", fileType: "jsp" })\` 또는
  - \`findFiles({ moduleName: "...", keyword: "Left" })\` 호출 후, 좌측 메뉴 JSP를 \`readSourceSnippet\`으로 읽어 등록 버튼 ID(#reg_..., #btn_...)를 100% 특정!
2단계 [작성 폼 뷰 파일 찾기]:
  - \`findFiles({ moduleName: "...", keyword: "Simple" })\` 또는 \`findFiles({ moduleName: "...", keyword: "Reg" })\` 호출
  - 모달/폼 JSP 파일(예: ...SimpleView.jsp, ...Reg.jsp)을 특정!
3단계 [3대 핵심 필드(제목/본문/저장) 라인 직접 확인]:
  - 2단계에서 찾은 파일에 대해 \`readSourceSnippet({ filePath: "...", startLine: 1, lineCount: 120 })\` 호출
  - 실제 소스 라인에서 <input id="...">, <textarea id="...">, <button id="savebtn"...>을 눈으로 확인하고 출처 라인 번호(scdInsertScheduleSimpleView.jsp:L52)와 함께 기획서에 기록!
4단계 [유효성 검사 alert 메시지 확인]:
  - \`extractAlertsAndValidation({ filePath: "...js" })\` 호출로 빈 제목 alert("제목을 입력하세요") 등 방어 조건을 기획서에 기록!

[최종 기획서 Markdown 출력 규격]
# [화면 조작 기획서] {기능명}

## 1. 대상 화면 및 진입 경로
- 메뉴 링크: {셀렉터} [확인 출처: ...]

## 2. 소스코드에서 검증된 핵심 DOM 셀렉터 (100% 출처 확인됨)
- 등록/작성 버튼: {셀렉터} [확인 출처: 파일명:L번호]
- 제목 입력 필드: {셀렉터} [확인 출처: 파일명:L번호]
- 본문 입력 필드: {셀렉터} [확인 출처: 파일명:L번호]
- 저장/상신 버튼: {셀렉터} [확인 출처: 파일명:L번호]

## 3. ⚠️ 사용자 확인/직접 입력 필요 항목 (소스코드에서 ID를 확정하지 못한 항목)
- {항목명}: 소스코드에서 ID 미발견 -> 화면 텍스트 \`button:has-text('...')\` 대체 권장 또는 사용자가 대시보드에서 직접 지정 필요

## 4. 유효성 검사(Alert) 방지 규칙 및 필수 입력 조건
- {검증 조건 및 alert 문구}

## 5. 정밀 조작 시퀀스 (1단계 ~ N단계)
- 1단계: ...
`;

  // Multi-turn ReAct Loop (Up to 5 turns)
  const contents: any[] = [
    {
      role: "user",
      parts: [
        {
          text: `[사용자 요구사항]
"${prompt}"

[역공학 4단계 필수 탐색 지시사항]
1. [트리거 버튼 식별]: 먼저 사용자가 요청한 업무 모듈의 좌측 메뉴 파일(*LeftView.jsp)을 findFiles나 searchCodeText로 찾아 readSourceSnippet으로 읽고, 등록/작성 버튼의 실제 ID를 찾으십시오.
2. [등록 폼 파일 특정]: 등록 버튼이 띄우는 폼 뷰 파일(*SimpleView.jsp, *Reg.jsp, *Write.jsp)을 findFiles로 찾으십시오.
3. [3대 필수 필드 확정]: 해당 폼 파일의 소스코드를 readSourceSnippet으로 직접 읽어서 제목(subject/title), 내용(cn/content), 저장버튼(savebtn/btn_save)의 실제 태그와 ID를 반드시 파일 라인 번호와 함께 기획서에 기록하십시오.
4. 🚨 [무추측 & 비워두기]: 소스코드 라인에서 확인되지 않은 가상의 영어 ID는 절대 생성하지 마십시오. 모르는 항목은 button:has-text(...)로 대체하거나 비워두고, '## 3. ⚠️ 사용자 확인/직접 입력 필요 항목'에 등록하십시오.`
        }
      ]
    }
  ];

  const apiKeys = [API_KEY, API_KEY_ALT].filter(Boolean);
  let finalMarkdown = "";
  const identifiedSelectors: Array<{ name: string; selector: string; description: string }> = [];
  const validationAlerts: string[] = [];
  const recommendedSteps: string[] = [];

  for (const apiKey of apiKeys) {
    for (const model of MODEL_CANDIDATES) {
      try {
        const ai = new GoogleGenAI({ apiKey });
        let turn = 0;
        const maxTurns = 5;

        onProgress?.(`🚀 [Code Explorer] 모델 ${model} 활성화, 코드 탐색 시작...`);

        while (turn < maxTurns) {
          turn++;
          const response = await ai.models.generateContent({
            model,
            contents,
            config: {
              systemInstruction,
              tools: [{ functionDeclarations: toolDeclarations as any }]
            }
          });

          const functionCalls = response.functionCalls;
          if (functionCalls && functionCalls.length > 0) {
            // AI decided to call tools
            contents.push(response.candidates?.[0]?.content);

            for (const call of functionCalls) {
              const toolName = call.name as keyof typeof toolExecutors;
              const toolArgs = call.args as any;

              onProgress?.(`🔧 [도구 실행 ${turn}/${maxTurns}] ${toolName}(${JSON.stringify(toolArgs).slice(0, 60)}...)`);

              let toolResult: any;
              if (toolExecutors[toolName]) {
                toolResult = toolExecutors[toolName](toolArgs);
              } else {
                toolResult = { error: `알 수 없는 도구: ${toolName}` };
              }

              contents.push({
                role: "user",
                parts: [
                  {
                    functionResponse: {
                      name: call.name,
                      response: toolResult
                    }
                  }
                ]
              });
            }
          } else {
            // AI produced final answer without further tool calls
            finalMarkdown = response.text || "";
            break;
          }
        }

        if (finalMarkdown && finalMarkdown.length > 100) {
          onProgress?.(`✅ [기획서 완성] 소스코드 기반 정밀 조작 기획서(Action Spec) 작성 완료!`);
          break;
        }
      } catch (err: any) {
        onProgress?.(`⚠️ 모델 ${model} 시도 중 오류 발생: ${err.message?.slice(0, 80)}... 다음 대체 모델 시도`);
      }
    }
    if (finalMarkdown) break;
  }

  // Fallback if agent failed to reach final answer
  if (!finalMarkdown) {
    onProgress?.(`⚠️ [알림] 에이전트 다중턴 실패, 기본 소스코드 패턴으로 기획서 초안 생성`);
    finalMarkdown = `# [기획서] ${prompt}\n\n## 1. 대상 화면 및 경로\n- 기본 대시보드 및 메인 업무 화면\n\n## 2. 필수 조작 시퀀스\n- 1단계: 메인 메뉴 탐색\n- 2단계: 양식 선택 및 작성\n- 3단계: 내용 입력 및 제출`;
  }

  // Parse selectors and alerts from markdown text
  const selectorLines = finalMarkdown.match(/[`'"](#|\.|\/\/)[^`'"]+[`'"]/g) || [];
  for (const s of Array.from(new Set(selectorLines))) {
    const raw = s.replace(/[`'"]/g, "");
    identifiedSelectors.push({
      name: raw,
      selector: raw,
      description: "소스코드에서 식별된 DOM 셀렉터"
    });
  }

  return {
    actionSpecMarkdown: finalMarkdown,
    identifiedSelectors,
    validationAlerts,
    recommendedSteps
  };
}

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
        mail: ["email", "eml", "mail"],
        email: ["email", "eml", "mail"],
        eml: ["email", "eml", "mail"],
        schedule: ["schedule", "scd"],
        calendar: ["schedule", "scd"],
        scd: ["schedule", "scd"],
        note: ["note", "not"],
        not: ["note", "not"],
        app: ["app", "eapp", "approval"],
        approval: ["app", "eapp", "approval"],
        eap: ["app", "eapp", "approval"],
        eapp: ["app", "eapp", "approval"],
        doc: ["doc", "document"],
        document: ["doc", "document"],
        board: ["board", "brd"],
        brd: ["board", "brd"],
        work: ["work", "wor"],
        wor: ["work", "wor"],
        smartwork: ["smartwork", "smw"],
        smw: ["smartwork", "smw"],
        project: ["project", "prj", "space", "teamsite"],
        prj: ["project", "prj"],
        survey: ["survey", "sur"],
        sur: ["survey", "sur"],
        filebox: ["filebox", "fbx"],
        fbx: ["filebox", "fbx"],
        memo: ["memo", "mmo"],
        mmo: ["memo", "mmo"],
        addr: ["addr"],
        org: ["organization", "org"],
        organization: ["organization", "org"],
        attend: ["attend", "atn"],
        atn: ["attend", "atn"],
        res: ["reservation", "res", "rmg"],
        rmg: ["reservation", "res", "rmg"],
        reservation: ["reservation", "res", "rmg"],
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
  const systemInstruction = `You are an elite **Code Explorer & Reverse Engineering Agent** for enterprise web applications.
Your mission is to inspect the target project's JSP, JS, and HTML source files using the provided tools and produce a 100% verified **[화면 조작 기획서 (Action Spec)]** in Korean.

### [Core Rule 1: 4-Stage Chain of Goals]
Decompose the user's natural language request and verify these 4 elements in the source code:
1. **[Entry Menu / GNB Route]**: GNB menu text and drawer entry (\`button.btn_svc_open:visible\` -> \`#svc_box a:has-text('...')\`).
2. **[Write / Action Trigger Button]**: Located at the top of the module's Left Sidebar (\`*LeftView.jsp\`, \`*SideBar.jsp\`, \`*Left.js\`), e.g. \`button#reg_shedule_lefttop\`, \`#eapLeft_workWriteBtn\`, \`button#rmgResSideBar_apply\`, \`button#worSideBar_workReg\`.
3. **[Form 3 Core Fields (Deep Drill-Down)]**:
   - Locate the registration/view JSP (\`*SimpleView.jsp\`, \`*Reg.jsp\`, \`*Write.jsp\`) via \`findFiles\` or \`searchCodeText\`, and inspect it with \`readSourceSnippet\`.
   - Identify: ① Title input (\`#subject\`, \`#eapDocReg_docSubject\`, etc.), ② Body editor (\`#cn\`, \`textarea#reqWhy\`, etc.), ③ Final Submit/Save button (\`#savebtn\`, \`#eapDocReg_draftBtn\`, \`#resInsertDetailView_saveBtn\`, etc.).
4. **[Validation Alert & Prerequisite Rules]**:
   - Use \`extractAlertsAndValidation\` on the corresponding \`.js\` controller to find \`naon.ui.alert\` / \`alert()\` checks and mandatory field order.

### [Core Rule 2: Evidence-Based Verification (Citation Mandatory)]
- Record ONLY DOM IDs and selectors that you directly confirmed via \`searchCodeText\` or \`readSourceSnippet\`.
- Next to every selector, you MUST cite \`[확인 출처: 파일명:L라인번호]\` (e.g., \`[확인 출처: scdLeftView.jsp:L48]\`).

### [Core Rule 3: Zero-Guessing Policy]
- NEVER invent fake English IDs (\`#btn_orgUIselectDialog\`, \`#scd_write_btn\`, \`#_DOC_TITLE_\`).
- If an element's ID cannot be found in source code:
  1) Recommend visible Korean text matching (\`button:has-text('...'):visible\`), OR
  2) Leave the selector blank (\`""\`) and list it under \`## 3. ⚠️ 사용자 확인/직접 입력 필요 항목\`.

### [Naonsoft Enterprise Groupware Module & Key File Dictionary]
- 전자결재 (Corporate EAP): \`moduleName="eap"\`, prefix \`eap\` (Key files: \`eapLeftView.jsp\`, \`eapWorkSelect.jsp\`, \`eapDocReg.jsp\`, \`eapLineSelect.jsp\`, \`eapApproval.jsp\`)
- 공공전자결재 (Gov GAP): \`moduleName="app"\`, prefix \`gap\` (Key files: \`gapLeftView.jsp\`, \`gapWorkSelect.jsp\`, \`gapDocReg.jsp\`)
- 일정관리 (Schedule): \`moduleName="schedule"\`, prefix \`scd\` (Key files: \`scdLeftView.jsp\`, \`scdInsertScheduleSimpleView.jsp\`, \`scdInsertScheduleDetailView.jsp\`)
- 자원예약 (Reservation): \`moduleName="rmg"\`, prefix \`rmg\` (Key files: \`rmgResSideBar.jsp\`, \`rmgResInsertDetailView.jsp\`, \`rmgResSelect.jsp\`)
- 게시판 (Board): \`moduleName="board"\`, prefix \`brd\` (Key files: \`brdBoardSideBar.jsp\`, \`brdAtclReg.jsp\`, \`brdAtclList.jsp\`)
- 문서관리 (Doc): \`moduleName="doc"\`, prefix \`doc\` (Key files: \`docLeft.jsp\`, \`docAtclReg.jsp\`, \`docSelect.jsp\`)
- 업무보고 (Work Report): \`moduleName="work"\`, prefix \`wor\` (Key files: \`worSideBar.jsp\`, \`worWorkReg.jsp\`)
- 스마트워크 (SmartWork): \`moduleName="smartwork"\`, prefix \`smw\` (Key files: \`smwWorkMenu.jsp\`, \`smwWorkReg.jsp\`, \`smwBoxSelect.jsp\`)
- 사내쪽지 (Note): \`moduleName="note"\`, prefix \`not\` (Key files: \`notSubMenu.jsp\`, \`notNoteReg.jsp\`, \`notNoteList.jsp\`)
- 전자우편 (Email): \`moduleName="email"\`, prefix \`eml\` (Key files: \`emlSnbMenu.jsp\`, \`emlMailReg.jsp\`, \`emlMailList.jsp\`)
- 설문조사 (Survey): \`moduleName="survey"\`, prefix \`sur\` (Key files: \`surSurveyLeft.jsp\`, \`surSurveyRegWrite.jsp\`)
- 프로젝트 (Project): \`moduleName="project"\`, prefix \`prj\` (Key files: \`prjLeftView.jsp\`, \`prjTaskReg.jsp\`, \`prjTaskList.jsp\`)
- 파일함 (Filebox): \`moduleName="filebox"\`, prefix \`fbx\` (Key files: \`fbxLeft.jsp\`, \`fbxList.jsp\`, \`fbxUpload.jsp\`)
- 메모 (Memo): \`moduleName="memo"\`, prefix \`mmo\` (Key files: \`mmoMainLeft.jsp\`, \`mmoMemoList.jsp\`)
- 주소록 (Address): \`moduleName="addr"\`, prefix \`addr\` (Key files: \`addrLeft.jsp\`, \`addrInfoPage.jsp\`)
- 근태관리 (Attendance): \`moduleName="attend"\`, prefix \`atn\` (Key files: \`atnSideBar.jsp\`, \`atnMyAttendList.jsp\`)
- 조직도 공통 (Org Dialog): \`moduleName="org"\`, prefix \`org\` (Key files: \`orgDialog.jsp\`, \`orgTree.jsp\`)

### [Golden 4-Step Tool Execution Sequence]
1. **Step 1 [Find Trigger Button]**: Call \`findFiles({ moduleName: "...", keyword: "Left" })\` or \`searchCodeText({ keyword: "등록", moduleName: "...", fileType: "jsp" })\` -> inspect with \`readSourceSnippet\`.
2. **Step 2 [Find Form JSP]**: Call \`findFiles({ moduleName: "...", keyword: "Reg" })\` (or \`"Insert"\`, \`"Write"\`).
3. **Step 3 [Verify Core Fields]**: Call \`readSourceSnippet({ filePath: "...", startLine: 1, lineCount: 120 })\` to confirm exact IDs and line numbers.
4. **Step 4 [Verify Validation Alerts]**: Call \`extractAlertsAndValidation({ filePath: "...js" })\` to identify mandatory inputs.

### [Output Markdown Format (Must be written in Korean)]
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
          text: `[User Scenario Request]
"${prompt}"

[Reverse Engineering Instructions]
1. Locate the module's left sidebar JSP (*LeftView.jsp / *SideBar.jsp) and read the exact write/action button ID.
2. Locate the form/modal JSP (*Reg.jsp / *SimpleView.jsp / *DetailView.jsp) and read the exact IDs for title, body, and save/submit buttons with line numbers.
3. Never invent fake IDs. Use visible Korean text (:has-text('...')) or leave unknown selectors blank under '## 3. ⚠️ 사용자 확인/직접 입력 필요 항목'.
4. Write the final Action Spec Markdown entirely in Korean.`
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

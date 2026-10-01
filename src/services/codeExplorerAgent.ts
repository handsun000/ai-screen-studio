import { GoogleGenAI, Type } from "@google/genai";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";

dotenv.config();

const API_KEY = process.env.GEMINI_API_KEY || "";
const API_KEY_ALT = process.env.GEMINI_API_KEY_ALT || "";
const MODEL_CANDIDATES = [
  process.env.GEMINI_MODEL || "gemini-2.5-flash",
  "gemini-3.5-flash-lite",
  "gemini-flash-latest",
  "gemini-2.5-flash-lite",
  "gemini-3.5-flash"
];

export interface ActionSpecResult {
  actionSpecMarkdown: string;
  identifiedSelectors: Array<{ name: string; selector: string; description: string }>;
  validationAlerts: string[];
  recommendedSteps: string[];
}

/**
 * Stage 1: Autonomous Code Explorer Agent
 * Uses Gemini Function Calling to explore the target project's real source code,
 * locate actual DOM selectors, detect form validation constraints (alerts),
 * and output a rigorous Action Spec (기획 명세서).
 */
export async function exploreCodebaseForActionSpec(
  prompt: string,
  projectRoot: string,
  onProgress?: (message: string) => void
): Promise<ActionSpecResult> {
  const normalizedRoot = projectRoot.trim().replace(/\\/g, "/");

  onProgress?.(`🔍 [Code Explorer Agent] 대상 프로젝트 경로 탐색 준비: ${path.basename(normalizedRoot)}`);

  // --- Local Tool Implementations ---
  const toolExecutors = {
    /**
     * Search files matching module or keyword
     */
    findFiles: (args: { moduleName?: string; keyword?: string; fileType?: string }) => {
      const results: string[] = [];
      const moduleName = (args.moduleName || "").trim().toLowerCase();
      const keyword = (args.keyword || "").trim().toLowerCase();
      const fileType = (args.fileType || "all").trim().toLowerCase();

      // Priority search roots
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
            // grab 3 lines context
            const snippet = lines.slice(i, Math.min(lines.length, i + 3)).map((s) => s.trim()).join(" ");
            let comment = "";
            const commentMatch = snippet.match(/\/\*([^*]+)\*\//) || snippet.match(/\/\/(.+)$/);
            if (commentMatch) {
              comment = commentMatch[1].trim();
            }

            matches.push({
              line: i + 1,
              code: snippet.slice(0, 140),
              comment: comment || undefined
            });

            if (matches.length >= 15) break;
          }
        }

        return {
          filePath: args.filePath,
          totalValidationHits: matches.length,
          validationRules: matches
        };
      } catch (err: any) {
        return { error: `검증 규칙 추출 오류: ${err.message}` };
      }
    },

    /**
     * Powerful text search (grep) across JSP, JS, HTML source files.
     * Finds Korean labels (e.g. "일정등록", "일정 등록", "기안작성", "문서등록"), button IDs, or click event handlers.
     */
    searchCodeText: (args: { keyword: string; moduleName?: string; fileType?: string }) => {
      const rawKeyword = (args.keyword || "").trim();
      if (!rawKeyword) return { error: "검색할 keyword가 필요합니다." };

      const moduleName = (args.moduleName || "").trim().toLowerCase();
      const fileType = (args.fileType || "all").trim().toLowerCase();

      // Support whitespace-insensitive matching (e.g. "일정등록" matches "일정 등록")
      const regexPattern = rawKeyword.split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s*");
      let searchRegex: RegExp;
      try {
        searchRegex = new RegExp(regexPattern, "i");
      } catch {
        searchRegex = new RegExp(rawKeyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      }

      const candidateRoots: string[] = [];
      if (moduleName) {
        candidateRoots.push(
          path.join(normalizedRoot, "naon-module-web", "src", "main", "webapp", "jsp", "biz", "gw", moduleName),
          path.join(normalizedRoot, "naon-module-web", "src", "main", "webapp", "resources", "biz", "gw", moduleName),
          path.join(normalizedRoot, "src", "main", "webapp", "jsp", "biz", "gw", moduleName),
          path.join(normalizedRoot, "src", "main", "webapp", "resources", "biz", "gw", moduleName)
        );
      } else {
        candidateRoots.push(
          path.join(normalizedRoot, "naon-module-web", "src", "main", "webapp", "jsp", "biz", "gw"),
          path.join(normalizedRoot, "naon-module-web", "src", "main", "webapp", "resources", "biz", "gw"),
          path.join(normalizedRoot, "src")
        );
      }

      const matches: Array<{ file: string; line: number; snippet: string }> = [];

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
     * Search documentation (agyDocs, docs, etc.)
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

  // --- Tool Declarations for Gemini Function Calling ---
  const toolDeclarations = [
    {
      name: "searchCodeText",
      description: "Search for exact text, Korean labels (e.g. '일정등록', '기안작성', '새문서', '저장', '상신'), button IDs, or click event handlers ($('#reg_...').click) across JSP, JS, and HTML source files. Highly recommended as the 1st step to find the exact DOM selector of buttons and form fields!",
      parameters: {
        type: Type.OBJECT,
        properties: {
          keyword: { type: Type.STRING, description: "Text or label to search, e.g. '일정등록', '일정', '기안', 'save', 'write'" },
          moduleName: { type: Type.STRING, description: "Module name like 'schedule', 'app', 'doc', 'board'" },
          fileType: { type: Type.STRING, description: "File extension like 'jsp', 'js', or 'all'" }
        },
        required: ["keyword"]
      }
    },
    {
      name: "findFiles",
      description: "Search for source files (JSP, JS, TSX, HTML) in target project by module name (e.g. app, doc, board, schedule) or keyword (e.g. reg, write, view, list, left).",
      parameters: {
        type: Type.OBJECT,
        properties: {
          moduleName: { type: Type.STRING, description: "Module name like 'app', 'doc', 'board', 'work', 'schedule'" },
          keyword: { type: Type.STRING, description: "Filename keyword like 'write', 'reg', 'popup', 'view', 'list', 'left'" },
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

  const systemInstruction = `당신은 웹 애플리케이션의 소스코드를 직접 파고들어 분석하는 전문 'Code Explorer Agent'입니다.

[★ 최우선 탐색 원칙]
1. 반드시 searchCodeText 도구를 1순위로 실행하여 버튼의 실제 DOM ID와 이벤트 핸들러를 검색하세요!
   - 사용자가 요청한 버튼 라벨(예: '일정등록', '기안작성', '문서등록', '조직도', '상신')을 searchCodeText로 직접 검색하면 실제 JSP 파일의 <button id='...'> 및 JS의 $('#...').click() 핸들러가 단번에 발견됩니다.
2. [엔터프라이즈 사이드바 우선 탐색 원칙]
   - 엔터프라이즈 그룹웨어에서 모든 주요 기능의 '등록/작성' 버튼(예: 일정등록, 기안작성, 글작성 등)은 메인 콘텐츠가 아니라 [좌측 사이드바 (*LeftView.jsp, *Left.js)] 상단(.workset_btn, #reg_*_lefttop 등)에 있습니다!
   - 따라서 '등록', '작성' 버튼을 찾을 때는 반드시 *LeftView.jsp, *Left.js 또는 좌측 메뉴 파일을 먼저 확인하세요.
3. [★ 등록/작성 후 열리는 폼/팝업 화면 심층 추적 원칙 (Deep Drill-down)]
   - 등록/작성 버튼(예: #reg_shedule_lefttop)을 찾았다고 멈추지 마세요!
   - 그 버튼을 클릭했을 때 열리는 실제 등록 뷰 파일(예: *Insert*SimpleView.jsp, *Write*.jsp, 또는 insert/write/form 컴포넌트)을 findFiles나 searchCodeText로 찾아내어 반드시 readSourceSnippet으로 읽으세요!
   - 그 화면 소스 안에서 실제 쓰이는 3대 핵심 요소를 찾아내어 명세서에 기록하세요:
     1) 제목 필드 (예: <input id="subject" name="subject">)
     2) 내용/본문 필드 (예: <textarea id="cn">)
     3) 저장/등록 버튼 (예: <button id="savebtn">)
   - 이 3대 요소가 빠지면 브라우저 자동화가 팝업 안에서 무엇을 입력해야 할지 몰라 실패합니다.
4. [Hallucination(환각) 절대 금지!]
   - 소스코드 도구 실행 결과에서 직접 확인되지 않은 가상의 ID(예: scdMain_writeScheduleBtn 등 추측성 이름)를 절대로 지어내지 마세요!
   - 소스코드에서 발견된 실제 ID(#reg_shedule_lefttop 등)와 함께, 버튼 텍스트 기반 복합 셀렉터(예: "button#reg_shedule_lefttop, button:has-text('일정등록'), button:has-text('일정 등록')")를 결합하여 안정적인 선택자를 기술하세요.
5. [모달/다이얼로그 팝업 스코프 격리 원칙 (충돌 방지)]
   - 등록/작성 버튼을 누른 후 열리는 화면이 레이어 팝업(jQuery UI Dialog 등)인 경우, 팝업 내 입력 필드와 버튼 선택자에는 반드시 '.ui-dialog:visible', 소스코드의 '<form id="...">' 또는 ':visible'을 접두사로 명시하세요.
   - 예: '#reg_schedule_form #subject, .ui-dialog:visible #subject, #subject:visible'
   - [중요 금지] 'input[placeholder*="제목"]' 같은 모호하고 넓은 선택자는 상단 GNB 검색창(예: scdSearchBar_searchWord)과 매칭되어 다이얼로그 오버레이(ui-widget-overlay)에 가로막히는 타임아웃 오류를 유발하므로 단독으로 쓰지 마세요.
   - [중요 금지] 팝업이 열려 있는 상태에서 배경의 툴바(예: .fc-today-button 등 달력 버튼)를 클릭하려는 액션을 절대 넣지 마세요!
6. 폼 제출 시 발생하는 유효성 검사(alert/confirm 메시지)를 extractAlertsAndValidation으로 확인하여 필수 입력 항목을 명시하세요.

최종 응답에는 아래 구조의 Markdown을 반드시 포함하세요:
# [기획서] {기능명}
## 1. 대상 화면 및 경로
## 2. 식별된 핵심 DOM 셀렉터 (소스코드에서 실제 확인된 ID 및 Class)
## 3. 필수 입력값 및 유효성 검사(Alert) 방지 규칙
## 4. 정밀 조작 시퀀스 (1단계 ~ N단계)`;

  // Multi-turn ReAct Loop (Up to 5 turns)
  const contents: any[] = [
    {
      role: "user",
      parts: [
        {
          text: `사용자 요구사항: "${prompt}"\n\n타겟 프로젝트의 실제 소스코드를 도구로 직접 탐색하여 실제 DOM 셀렉터와 유효성 검사(alert) 규칙을 확인하고, 정밀한 화면 조작 기획서(Action Spec)를 작성해주세요.`
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

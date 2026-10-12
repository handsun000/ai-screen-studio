/**
 * Universal Video Tutorial Scenario Templates & Directing Framework
 * 
 * Target projects might NOT have pre-written scenario docs.
 * This framework provides Gemini with professional screen recording directing principles,
 * universal web patterns, and timing rules to generate flawless tutorials for ANY web app.
 */

export interface ScenarioTemplate {
  id: string;
  name: string;
  icon: string;
  description: string;
  promptTemplate: string;
  phases: string[];
}

export const UNIVERSAL_TUTORIAL_TEMPLATES: ScenarioTemplate[] = [
  {
    id: "create-and-submit",
    name: "신규 등록 및 폼 작성 (Create & Submit)",
    icon: "📝",
    description: "신규 데이터(문서/기안/게시글/일정/업무 등)를 표준 필수 4대 절차(분류/문서함 선택 -> 제목 입력 -> 본문 작성 -> 저장/상신)로 군더더기 없이 깔끔하게 작성 및 등록하는 엔터프라이즈 완결형 튜토리얼",
    promptTemplate: "【목표】: 신규 항목(문서, 기안, 일정, 게시글, 업무 등) 등록 및 저장 (유효성 검사 100% 충족)\n【진입 경로】: 메인 대시보드에서 해당 기능 메뉴로 이동\n【조작 순서】: [작성/등록] 버튼 클릭 -> [필수 1: 분류/문서함/캘린더/양식 선택] -> [필수 2: 제목/명칭 입력] -> [필수 3: 해당 시 조직도/결재선 지정] -> [필수 4: 본문 에디터 내용 작성] -> [저장/상신] 버튼 클릭 -> [확인 다이얼로그 승인]\n【결과 확인】: 등록 완료 알림창 확인 및 생성된 상세 화면/목록 확인",
    phases: [
      "1단계 [도입]: 메인 화면 전체 뷰 3초간 노출 (시청자 인지)",
      "2단계 [이동]: GNB/포탈 전체메뉴(btn_svc_open) 클릭 및 해당 기능 메뉴 진입",
      "3단계 [필수1-분류선택]: [작성/등록] 진입 후 대상 문서함/캘린더/분류/게시판/양식 선택 (유효성 alert 방지)",
      "4단계 [필수2-제목입력]: 제목 필드 포커스 및 설명 텍스트 타이핑",
      "5단계 [필수3-해당시기능]: 결재선/참석자 등 해당 기능의 필수 대상자 지정 (일반 문서/게시판은 생략)",
      "6단계 [필수4-본문작성]: 웹 에디터/본문 텍스트 작성 (iFrame 에디터 대응)",
      "7단계 [실행]: [저장/상신/등록] 버튼 클릭 후 확인 다이얼로그(Confirm) 승인",
      "8단계 [확인]: 등록 완료 알림 및 갱신된 상세/목록 화면 와이드 뷰 마무리"
    ]
  },
  {
    id: "search-and-view",
    name: "검색, 필터링 및 상세 조회 (Search & View)",
    icon: "🔍",
    description: "검색창 입력, 카테고리 필터링 및 검색 결과 상세 페이지를 확인하는 튜토리얼",
    promptTemplate: "【목표】: 키워드 검색 및 필터 조건을 적용하여 원하는 데이터 조회\n【진입 경로】: 검색창 또는 목록 페이지\n【조작 순서】: 검색창 클릭 -> 키워드 타이핑 -> 검색 버튼 클릭 -> 검색 결과 목록 확인 -> 특정 항목 클릭하여 상세 팝업/화면 열기\n【결과 확인】: 상세 내용 확인 후 닫기 또는 목록 복귀",
    phases: [
      "1단계 [도입]: 목록 화면 와이드 뷰 노출",
      "2단계 [입력]: 검색창/필터 선택 후 키워드 입력",
      "3단계 [검색]: 검색 실행 후 갱신된 결과 목록 확인 (2초 대기)",
      "4단계 [상세]: 특정 데이터 행/카드 클릭하여 상세 보기 진입",
      "5단계 [마무리]: 상세 내용 확인 후 닫기"
    ]
  },
  {
    id: "navigation-tour",
    name: "전체 메뉴 및 서비스 투어 (Navigation Tour)",
    icon: "🧭",
    description: "시스템의 주요 GNB 메뉴, 사이드바, 알림 및 핵심 대시보드를 둘러보는 온보딩 튜토리얼",
    promptTemplate: "【목표】: 시스템의 핵심 기능 메뉴들을 순차적으로 둘러보는 메뉴 투어\n【진입 경로】: 메인 포털 홈\n【조작 순서】: 주요 상단 메뉴 순차 클릭/호버 -> 전체메뉴 또는 사이드바 펼치기 -> 알림/프로필 레이어 확인\n【결과 확인】: 다시 홈 대시보드로 복귀하여 전체 조망",
    phases: [
      "1단계 [도입]: 메인 대시보드 3초간 와이드 뷰",
      "2단계 [순회]: 주요 메뉴 순차 이동 (각 화면마다 와이드 뷰 유지)",
      "3단계 [확장]: 전체 메뉴 레이어 또는 사이드 패널 토글",
      "4단계 [위젯]: 알림함 또는 사용자 프로필 영역 클릭 확인",
      "5단계 [복귀]: 홈 화면으로 복귀하며 마무리"
    ]
  },
  {
    id: "communication-chat",
    name: "소통 및 메시지 발송 (Communication & Chat)",
    icon: "💬",
    description: "메신저, 채팅, 이메일, 쪽지 또는 AI 챗봇과 대화/메시지를 주고받는 튜토리얼",
    promptTemplate: "【목표】: 대화 상대(동료/고객/AI)를 선택하고 메시지 전송\n【진입 경로】: 메신저/채팅/이메일 패널 열기\n【조작 순서】: 대화창 또는 새 메시지 버튼 클릭 -> 조직도 부서 트리에서 대화 상대 선택 (검색 절대 금지) -> 메시지 입력창에 내용 입력 -> [전송] 버튼 클릭\n【결과 확인】: 대화방에 메시지가 등록된 화면 확인",
    phases: [
      "1단계 [도입]: 메인 화면에서 메신저/채팅 아이콘으로 마우스 이동",
      "2단계 [진입]: 채팅 패널/새 창 열기 (1.5초 대기)",
      "3단계 [입력]: 대화 상대 선택 후 메시지 입력",
      "4단계 [전송]: 엔터 또는 전송 버튼 클릭",
      "5단계 [확인]: 전송된 말풍선/결과 확인"
    ]
  },
  {
    id: "update-and-manage",
    name: "정보 수정 및 상태 변경 (Edit & Manage)",
    icon: "⚙️",
    description: "기존 데이터의 상세 정보를 열어 내용을 수정하거나 진행 상태를 변경하는 튜토리얼",
    promptTemplate: "【목표】: 기존 등록 항목의 내용 수정 또는 진행 상태 변경\n【진입 경로】: 목록 화면에서 대상 항목 선택\n【조작 순서】: 수정할 항목 클릭 -> [수정] 버튼 클릭 -> 특정 필드 내용 변경 또는 상태 셀렉트박스 변경 -> [수정 완료] 클릭\n【결과 확인】: 변경 사항이 반영된 화면 확인",
    phases: [
      "1단계 [도입]: 대상 목록 화면 진입",
      "2단계 [선택]: 수정 대상 항목 클릭하여 상세 화면 진입",
      "3단계 [수정]: [수정] 모드 전환 후 특정 텍스트 또는 셀렉트 변경",
      "4단계 [저장]: [저장/완료] 버튼 클릭",
      "5단계 [확인]: 변경된 내용이 즉시 반영된 화면 확인"
    ]
  },
  {
    id: "auth-and-install",
    name: "로그인 및 시작 안내 (Auth & Onboarding)",
    icon: "🔑",
    description: "로그인 페이지 접속, 계정 로그인 및 필수 앱/클라이언트 설치 안내 튜토리얼",
    promptTemplate: "【목표】: 시스템 로그인 및 필수 다운로드/안내 확인\n【진입 경로】: 로그인 화면\n【조작 순서】: 아이디/비밀번호 입력 -> 로그인 버튼 클릭 -> 메인 화면 로딩 -> 프로그램 다운로드 또는 가이드 팝업 확인\n【결과 확인】: 메인 대시보드 안착",
    phases: [
      "1단계 [도입]: 로그인 화면 2.5초간 노출",
      "2단계 [입력]: 아이디 및 비밀번호 입력",
      "3단계 [로그인]: 로그인 버튼 클릭 후 풀스크린 유지 (화면 전환 인지)",
      "4단계 [안내]: 다운로드 버튼 또는 안내 레이어 확인",
      "5단계 [완료]: 메인 화면 전경 확인"
    ]
  }
];

/**
 * Master Video Directing Guidelines for Gemini AI Prompt Engineering
 */
export const MASTER_DIRECTING_GUIDELINES = `
# 🎬 Professional Screen Tutorial Directing & BrowsePlan Generation Guidelines

You are the world's foremost **Screen Tutorial Video Director and Playwright Browser Automation Architect**.
Even without pre-written manuals or specs for the target project, you strictly apply the **"Universal 5-Phase Video Directing Framework"**, the **"4 Universal Scenario Archetypes"**, and **"Robust Selector Heuristics"** to engineer studio-grade, human-like demonstration videos.

---

### [1] Universal 5-Phase Video Directing Framework

Every scenario MUST strictly follow this 5-phase visual pacing to maximize viewer comprehension:

1. **Phase 1: Visual Anchor & Landing**
   - At video start, insert a mandatory **2500ms ~ 3500ms wait** (\`"type": "wait", "ms": 3000\`).
   - Give viewers time to visually orient themselves on the portal dashboard before any mouse motion begins.
   - NEVER instantly jump, teleport the cursor, or zoom in at 0 seconds.

2. **Phase 2: Intentional Navigation (🚨 Hidden Portal Service Drawer Rule)**
   - **Enterprise Portal Standard Architecture**: In enterprise groupware and portal main dashboards, detailed business sub-modules (Approval, Documents, Board, Schedule, Resource Reservation, Attendance, Survey, Mail, Admin) are NOT directly exposed in the top navigation bar. Instead, they are housed inside the **[Portal Service Drawer] (\`button.btn_svc_open\`)**!
   - **MANDATORY 4-Step Navigation Sequence**:
     ① \`click\`: \`button.btn_svc_open:visible, button[title='포탈 전체메뉴'], .btn_svc_open:visible\` (Click top '포탈 전체메뉴' button to expand drawer)
     ② \`wait\`: \`1000ms ~ 1500ms\` (Wait for drawer expansion animation to finish)
     ③ \`click\`: \`#svc_box a:has-text("메뉴명"), a:has-text("메뉴명"):visible\` (Click target menu link inside the expanded drawer)
     ④ \`wait\`: \`2500ms ~ 3500ms\` (Wait for target page to fully load)
   - 🚨 **STRICT PROHIBITION**: NEVER attempt to click hidden menu links like \`a:has-text("일정관리")\` or \`#svc_lst a:has-text("문서관리")\` directly without first clicking \`button.btn_svc_open\`! Because they are initially hidden (\`display: none\`), Playwright will fail with a 100% element visibility timeout.
   - When navigating to a new module, ensure the action description includes keywords like "이동", "페이지", or "메뉴" so the camera maintains a steady wide view during transitions.

3. **Phase 3: Focused Interaction & Clean Motion Standards**
   - Move to form interaction or exploration within the loaded module.
   - **Single 'type' Action Rule**: A \`type\` action automatically moves the cursor to the input element, clicks to focus, and types. NEVER generate a redundant \`click\` action on the exact same input field immediately before a \`type\` action!
   - **No Meaningless Hover Wandering**: Strictly forbid random 'hover' actions over static headers, empty backgrounds, sidebars, or labels just to "look around". Hover ONLY when triggering dropdown menus or tooltips.
   - For inputs inside iframes (e.g., WYSIWYG editors, legacy forms), always specify the \`iframe\` attribute (e.g., \`iframe#subBody\`, \`iframe[name*='editor']\`).

4. **Phase 4: Action Execution & Contextual Scoping**
   - Trigger decisive buttons ([저장], [상신], [등록], [전송], [검색]).
   - After clicking decisive buttons, add a **1500ms ~ 2500ms wait** to capture immediate application feedback and visual transitions.

5. **Phase 5: Outcome Review & Wrap-up**
   - Confirm/Alert popups: Handle browser confirm dialogs and click popup OK/Close buttons.
   - **Crucial Page Refresh Buffer**: After closing submission popups, the main list or calendar automatically reloads. ALWAYS provide **4000ms ~ 5000ms loading wait** to prevent subsequent actions from failing against a white blank re-render!
   - **Verification Action Selector Prioritization**: If verifying a newly created item, ALWAYS prioritize exact text matching with the newly created title (\`:has-text('...')\`, e.g., \`a.fc-event:has-text('2026'), .fc-event-title:has-text('2026'), a.fc-event:last-child\`). NEVER place generic classes (\`.fc-event:visible\`, \`table tbody tr:first-child\`) ahead of text matching, or the cursor will mistakenly click an unrelated existing row or holiday.

---

### [2] Universal 4-Archetype Scenario Architecture Across ALL Modules

The user's prompt MUST be routed into one of the following 4 archetypes across ANY enterprise module (Electronic Approval, Document Management, Board, Schedule, Webmail, Resource Reservation, Attendance, Survey, Address Book, Admin). NEVER rigidly force a [Register ➔ Submit] form flow onto every request!

#### ① Archetype 1: Pure Exploration & Structure (EXPLORATION)
- **Intent Triggers**: "기본 구조", "구조", "둘러보기", "탐색", "화면 구성", "온보딩", "투어", "레이아웃", "메뉴 확인", "overview", "structure", "tour"
- 🚫 **STRICT PROHIBITION**: NEVER click [신규 등록], [작성], [기안], [저장]! Zero form inputs!
- 🎯 **Standard Directing Flow**:
  [Portal Main Dashboard Intro] ➔ [Open Portal Service Drawer & Navigate to Module] ➔ [Module Main Page Load] ➔ [Expand Sidebar Trees/Folders/Calendars & Sequentially Click Sub-nodes] ➔ [Switch View Modes (Table vs Split vs Calendar View) or Sorting/Filter Dropdowns] ➔ [Tour Main Content Widgets/Lists] ➔ [Summarize Module Structure & Outro]

#### ② Archetype 2: Pure Search & View (SEARCH_VIEW)
- **Intent Triggers**: "검색", "조회", "열람", "상세", "찾기", "확인", "search", "lookup", "view detail" (without explicit creation request)
- 🚫 **STRICT PROHIBITION**: NEVER insert dummy create/submit steps before searching!
- 🎯 **Standard Directing Flow**:
  [Portal Main Intro] ➔ [Navigate to Module] ➔ [Link Live Scraped Item ("useScraped": "auto", "dynamicStrategy": "first-row-title")] ➔ [Type Scraped Keyword into Content Toolbar Search Input] ➔ [Click Content Toolbar Search Button] ➔ [Inspect Filtered Search Results] ➔ [Click Filtered Item to Open Detail View] ➔ [Tour Detail Body/Attachments/Approval Line Tabs] ➔ [Click Back to List Button]

#### ③ Archetype 3: Create & Submit (CREATE_SUBMIT)
- **Intent Triggers**: "등록", "작성", "기안", "상신", "신청", "추가", "생성", "예약", "create", "register", "submit"
- 🎯 **Standard Directing Flow (Zero-Validation-Failure Policy)**:
  [Portal Main] ➔ [Navigate to Module] ➔ [Click New Write/Register/Draft Button] ➔ [Fulfill ALL Mandatory Module Prerequisites (select folder/calendar/form tree leaf node to prevent "Select container" alert)] ➔ [Focus & Type Title Field (prevents "Enter title" alert)] ➔ [Write Body Content in Web Editor] ➔ (Configure permissions/attendees ONLY if explicitly requested in user prompt) ➔ [Click Save/Submit Button with Modal Scope] ➔ [Accept Browser Confirm Dialog] ➔ [Confirm Completion Dialog & Wait 4000ms+ for List Reload]
- 🚫 **STRICT PROHIBITION (Lean Form Policy)**: NEVER invent unrequested advanced settings (expand advanced options, retention dropdown, security level radio, tags, document summary, notification toggles) that are not visible by default! Only include standard mandatory fields: [Container] -> [Title] -> [Body] -> [Submit].

#### ④ Archetype 4: Workflow & Management (WORKFLOW_MANAGE)
- **Intent Triggers**: "결재", "승인", "반려", "수정", "상태 변경", "권한 설정", "approve", "reject", "edit", "status"
- 🎯 **Standard Directing Flow**:
  [Navigate to Module] ➔ [Select Pending Approval / Target Item from List] ➔ [Inspect Detailed Document & Approval Line] ➔ [Click Approve/Reject or Edit Button] ➔ [Enter Approval Comments or Modify Options] ➔ [Click Final Confirm Button] ➔ [Verify State Transition in List]

---

### [3] Robust Selector Heuristics & Anti-Hallucination Rules

Even when target source code is incomplete, ensure 100% execution using multi-fallback selector chains:

1. **Atomic Interactive Selector Rule (CRITICAL for Mouse Precision)**
   - Mouse cursor and camera zoom positions are calculated from the bounding box center of the selector.
   - ❌ **STRICTLY FORBIDDEN (Wide Parent Container Selectors)**:
     \`div.btn_area\`, \`div.btn_box\`, \`form#reg_form\`, \`ul.menu_lst\`, \`tr.item\`, \`div#header\`, wide \`label\`
     (Clicking center of wide container clicks empty white space instead of the button!)
   - ✅ **MANDATORY (Target Actual Interactive Leaf Elements)**:
     - Buttons: \`button:has-text("저장")\`, \`button#reg_shedule_lefttop\`, \`button.btn_save\`, \`input[type='submit']\`
     - Links/Menus: \`a:has-text("일정관리")\`, \`a.menu_item\`, \`#svc_box a:has-text("일정관리")\`
     - Input fields: \`input#subject:visible\`, \`textarea#cn:visible\`
     - Checkboxes: \`label:has-text("예약사용")\`, \`input#scd_link_res_chk\`
     - Popups: \`.ui-dialog:visible button:has-text("확인")\`

2. **Disambiguation by Contextual Scope (Anti-Collision)**
   - In enterprise web apps, identical button texts ('저장', '등록', '확인', '닫기', '검색') coexist in header, sidebar, toolbar, and modals.
   - Always prefix with the specific container scope:
     - 🪟 Popup/Modal: \`.ui-dialog:visible button:has-text('저장'), .ui-dialog:visible #savebtn, .modal:visible button:has-text('확인')\`
     - 👈 Left Sidebar: \`#snb button:has-text('일정 등록'), #left button:has-text('등록'), aside button:has-text('글작성')\`
     - 🔝 Top Header/GNB: \`header button.btn_svc_open, .gnb button[title='포탈 전체메뉴']\`
     - 📄 Content/Toolbar: \`#content .btn_area button:has-text('등록'), .list_container button:has-text('삭제')\`

3. **Content Toolbar Search vs Top GNB Header & Sidebar Scope (CRITICAL)**
   - Top common header (\`header\`, \`#header\`, \`.gnb\`) has global portal search.
   - Left sidebar (\`#snb\`) has folder/tree search.
   - NEVER target GNB header or sidebar when searching content/article/document titles!
   - Content Search Input (\`type\`):
     \`input#atclList_searchWord:visible, input[id*='searchWord']:visible, .new_srch_bar input:visible, #content .srch_input input:visible, #content input[id*='search']:visible, #content input[placeholder*='검색']:visible\`
   - Content Search Button (\`click\`):
     \`button#atclList_srchBtn:visible, button[id*='srchBtn']:visible, button[id*='searchBtn']:visible, .new_srch_bar button:visible, #content .srch_input button:has(.ico_srch):visible, #content .srch_input button[title='검색']:visible, #content button[title='검색']:visible, #content button.btn_srch:visible\`

4. **Zero-Guessing Policy & Empty Selector Guidance**
   - 🚨 NEVER invent fake English IDs like \`#_USE_RESOURCE_\`, \`#_DOC_TITLE_\`, \`#_SUBJECT_\`, \`#_SAVE_BTN_\`, or unconfirmed IDs like \`#btn_orgUIselectDialog\`.
   - If an element's selector cannot be determined from code or text:
     1) Use exact visible Korean text matching: \`button:has-text("저장"):visible\`, \`button:has-text("문서 등록"):visible\`
     2) If still uncertain, set **\`"selector": ""\` (empty string)**!
     3) When leaving empty, explain in the root \`explanation\` field: "⚠️ [Step N: Target Button] selector is left empty for dashboard input." The dashboard UI highlights this action with a badge so the user can fill it in 1 second.

5. **Org Chart & Tree Selection Heuristics**
   - NEVER type fake employee names into search inputs in employee picker modals.
   - Always expand the department tree on the left (\`.dynatree-container li:first-child a.dynatree-title\`), then check the first employee in the right list (\`.lst_type1 li:first-child input[type='checkbox'], table tbody tr:first-child input[type='checkbox']\`), and click Confirm.
   - Do NOT invent arrow transfer buttons (\`btn_rgt\`, \`btn_add\`) unless confirmed in source code.

6. **Dynamic Live Data Linking (Method 2: Zero-Hallucinated-Data)**
   - NEVER hardcode fake article/doc titles like "2026학년도 대학 혁신지원사업...", "테스트 기안서", "김철수".
   - In \`type\` search actions, specify:
     • \`"useScraped": "auto"\`
     • \`"dynamicStrategy": "first-row-title"\` (or \`"first-row-user"\` for employee lookup)
     • \`"text": "실시간 실제 목록 데이터"\`
     • \`"description": "화면 목록의 실제 데이터로 검색어 자동 연동 입력"\`
   - Playwright runtime will automatically scrape the real text from the rendered list table and type it into the search box.
   - Follow up with \`useScraped: "auto"\` on the result click action to click the matching row.

7. **Modal Isolation Rule**
   - Once a modal dialog is open, all actions MUST target the modal interior (\`.ui-dialog:visible\`).
   - STRICT PROHIBITION: NEVER click background elements (calendar toolbar, GNB, sidebar) while a modal overlay is active! It will be blocked by the backdrop overlay (\`ui-widget-overlay\`).

8. **Strict Step Execution (No Optional Steps)**
   - Demonstrations require every action to be visually executed. Do NOT mark actions with \`"optional": true\` unless handling conditional system popups.

---

### [4] Korean Language UI Adaptation Directive (CRITICAL)

The target enterprise application and user interface operate in **Korean**.
- **Action \`description\` MUST be in natural, polite Korean** (e.g., \`"[포탈 전체메뉴] 버튼을 클릭하여 서비스 서랍을 펼칩니다."\`, \`"[문서 등록] 버튼을 클릭합니다."\`).
- **All text-matching selectors (\`:has-text('...')\`, \`button[title='...']\`, \`label:has-text('...')\`) MUST use exact Korean strings** (e.g., \`'포탈 전체메뉴'\`, \`'문서관리'\`, \`'문서 등록'\`, \`'저장'\`, \`'확인'\`, \`'기안'\`).
- The root **\`explanation\`** field MUST be in Korean.

`;

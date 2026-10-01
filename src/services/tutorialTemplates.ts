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
    description: "신규 데이터(문서/게시글/일정/상품/업무 등)를 작성하고 등록·상신하는 표준 튜토리얼",
    promptTemplate: "【목표】: 신규 항목(예: 기안 문서, 일정, 게시글, 회원 등) 등록 및 저장\n【진입 경로】: 메인 대시보드에서 해당 기능 메뉴로 이동\n【조작 순서】: [작성/등록] 버튼 클릭 -> 입력 폼(제목, 분류, 상세내용 등) 순차 입력 -> [저장/상신] 버튼 클릭\n【결과 확인】: 등록 완료 알림창 확인 및 생성된 상세 화면/목록 확인",
    phases: [
      "1단계 [도입]: 메인 화면 전체 뷰 3초간 노출 (시청자 인지)",
      "2단계 [이동]: GNB/사이드바 메뉴 클릭 및 등록 페이지 진입",
      "3단계 [조작]: [신규 등록] 버튼 클릭 후 입력 폼 필드 순차 입력",
      "4단계 [실행]: [저장/제출] 버튼 클릭 후 빠른 줌아웃",
      "5단계 [확인]: 등록 완료 팝업 또는 갱신된 목록 화면 확인"
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
    promptTemplate: "【목표】: 대화 상대(동료/고객/AI)를 선택하고 메시지 전송\n【진입 경로】: 메신저/채팅/이메일 패널 열기\n【조작 순서】: 대화창 또는 새 메시지 버튼 클릭 -> 상대방 검색/선택 -> 메시지 입력창에 내용 입력 -> [전송] 버튼 클릭\n【결과 확인】: 대화방에 메시지가 등록된 화면 확인",
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
# 🎬 전문 동영상 튜토리얼 연출 및 액션 플랜(BrowsePlan) 생성 표준 지침

당신은 전 세계 최고의 **스크린 튜토리얼 영상 감독이자 Playwright 브라우저 자동화 전문가**입니다.
타겟 프로젝트에 사전 작성된 시나리오 명세서나 매뉴얼이 없더라도, 당신은 다음 **"5단계 동영상 연출 표준 프레임워크"**와 **"지능형 UI 셀렉터 추론 원칙"**을 엄격히 적용하여 시청자가 감탄하는 고품질 데모 영상을 제작해야 합니다.

---

### [1] 5단계 동영상 튜토리얼 연출 프레임워크 (Universal 5-Phase Flow)
모든 시나리오는 반드시 시청자의 시각적 인지 흐름을 고려하여 다음 5단계로 구성하십시오:

1. **도입부 (Phase 1: Visual Anchor & Landing)**
   - 영상 시작 시 반드시 최소 **2.5초 ~ 3.5초간의 대기('wait')**를 두어 시청자가 "여기가 어디 화면인지" 전체 대시보드를 파악할 시간을 줍니다.
   - 갑자기 0초부터 마우스가 순간이동하거나 줌인이 들어가면 안 됩니다.

2. **메뉴 이동 (Phase 2: Intentional Navigation)**
   - 목표 화면으로 이동하기 위해 GNB, 사이드바, 또는 바로가기 메뉴를 클릭합니다.
   - **중요**: 메뉴 클릭으로 새 페이지나 대메뉴가 로딩될 때는, 카메라가 와이드 뷰를 유지할 수 있도록 description에 "이동", "페이지", "메뉴" 등의 키워드를 명시하고, 클릭 직후 **2.5초 ~ 4.0초간의 로딩 대기('wait')**를 부여하십시오.

3. **조작 및 폼 입력 (Phase 3: Focused Interaction)**
   - 본문 내 버튼 클릭(예: [신규 작성], [등록]) 후 폼 화면으로 이동합니다.
   - 입력 폼('type'):
     - 실제 텍스트가 타이핑되는 모습을 보여주기 위해 적절한 설명 텍스트를 입력합니다.
     - 각 타이핑 액션 사이에는 600ms~1000ms의 대기 또는 자연스러운 딜레이를 주어 시청자가 읽을 수 있게 합니다.
   - iFrame 내부 폼인 경우 반드시 'iframe' 필드를 지정합니다.

4. **결정적 액션/제출 (Phase 4: Action Execution)**
   - 폼 입력이 완료되면 [저장], [상신], [등록], [전송], [검색] 등 결정적 버튼을 클릭합니다.
   - 완료 클릭 직후 카메라는 결과 화면 전체를 보여주기 위해 빠르게 줌아웃되므로, 클릭 직후 **1.5초 ~ 2.5초 대기**를 둡니다.

5. **결과 확인 및 아웃트로 (Phase 5: Outcome & Wrap-up)**
   - 결과 팝업(Alert/Confirm)이 뜨면 확인/닫기를 누르고, 등록된 목록이나 완료된 화면을 **2.5초 ~ 3.5초간 와이드 뷰**로 비추며 편안하게 영상을 마무리합니다.

---

### [2] 지능형 UI 셀렉터 추론 원칙 (Robust Selector Heuristics)
타겟 프로젝트의 소스코드가 없거나 부분적인 경우에도 100% 작동하도록 다음과 같은 **다중 폴백 셀렉터 체인**을 구성하십시오:

1. **텍스트 매칭 기반 셀렉터 (가장 직관적이고 안정적)**:
   - 메뉴/버튼: \`button:has-text("기안"), a:has-text("결재"), .btn:has-text("등록")\`
   - CSS 셀렉터와 텍스트 매칭을 쉼표(,)로 결합:
     예: \`#svc_lst a:has-text("결재"), a:has-text("결재"):visible, [title*="결재"]\`
2. **입력 필드 추론**:
   - 제목 입력: \`input#_DOC_TITLE_, input[name*="title"], input[placeholder*="제목"], input[type="text"]:visible\`
   - 내용/본문: \`textarea, div[contenteditable="true"], iframe[name*="editor"]\`
   - 검색창: \`input[type="search"], input[name*="search"], input[placeholder*="검색"], .search_box input\`
3. **iFrame 감지 및 대응**:
   - 그룹웨어, 엔터프라이즈 포털, 에디터는 종종 iFrame을 사용합니다.
   - 전자결재/양식: \`iframe[name*="docBox"], iframe[src*="form"], iframe#subBody\`
   - 에디터: \`iframe[name*="editor"], iframe[src*="editor"]\`
4. **실패 방지 (Optional Flag)**:
   - 닫기 팝업, 안내 레이어, 첫 번째 항목 선택 등 화면 상태에 따라 존재하지 않을 수도 있는 단계는 반드시 \`"optional": true\`를 부여하십시오.

---

### [3] 시간 및 템포 규칙 (Timing Standards)
- 페이지 전체 이동 직후: \`3000ms ~ 4000ms\`
- 모달/레이어 팝업 열림: \`1500ms ~ 2000ms\`
- 입력 필드 클릭 및 타이핑: \`600ms ~ 1000ms\`
- 버튼 클릭 후 처리 대기: \`1500ms ~ 2500ms\`
- 영상 엔딩 마무리: \`3000ms\`
- 뷰포트: \`{ "width": 1920, "height": 1080 }\`
- 커서 딜레이: \`{ "delayMs": 800, "preClickRestMs": 180 }\`
`;

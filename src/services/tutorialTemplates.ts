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
    description: "신규 데이터(문서/기안/게시글/일정/업무 등)의 필수 입력(제목, 조직도/결재선 지정, 본문)을 충족하고 상신·저장하는 엔터프라이즈 표준 튜토리얼",
    promptTemplate: "【목표】: 신규 항목(기안 문서, 일정, 게시글, 업무 등) 등록 및 저장\n【진입 경로】: 메인 대시보드에서 해당 기능 메뉴로 이동\n【조작 순서】: [작성/등록] 버튼 클릭 -> [필수 1: 제목 입력] -> [필수 2: 결재선/조직도 팝업 열기 및 대상자 선택 적용] -> [필수 3: 본문 내용 작성] -> [저장/상신] 버튼 클릭\n【결과 확인】: 등록 완료 알림창 확인 및 생성된 상세 화면/목록 확인",
    phases: [
      "1단계 [도입]: 메인 화면 전체 뷰 3초간 노출 (시청자 인지)",
      "2단계 [이동]: GNB/사이드바 메뉴 클릭 및 등록 페이지 진입",
      "3단계 [필수1-제목]: [신규 등록] 버튼 클릭 후 제목 필드 포커스 및 타이핑",
      "4단계 [필수2-결재선]: 조직도/결재선 팝업 열기 -> 부서 트리 확장 -> 대상자 체크 및 적용",
      "5단계 [필수3-본문]: 본문 에디터 내용 작성",
      "6단계 [실행]: [저장/상신] 버튼 클릭 후 확인 다이얼로그 승인",
      "7단계 [확인]: 등록 완료 팝업 또는 갱신된 목록 화면 확인 (아웃트로)"
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

1. **텍스트 매칭 기반 셀렉터 (가장 직관적이고 안정적 - 1순위 사용)**:
   - 메뉴/버튼: \`button:has-text("기안"), a:has-text("결재"), .btn:has-text("등록"), button:has-text("저장"), button:has-text("확인")\`
   - 체크박스/라디오: 반드시 눈에 보이는 label 텍스트 매칭을 1순위로 사용하십시오:
     예: \`label:has-text("예약사용"), text="예약사용", label:has-text("동의"), input[type="checkbox"]\`
   - 팝업/모달 내 탭/카테고리: \`a:has-text("시설"), a:has-text("회의실"), li:has-text("시설") a\`
   - 팝업/모달 내 목록 첫 번째 항목: \`.ui-dialog:visible div[class*="lst"] > *:first-child, .ui-dialog:visible ul > li:first-child, .ui-dialog:visible tr:first-child\`
   - CSS 셀렉터와 텍스트 매칭을 쉼표(,)로 결합:
     예: \`#svc_lst a:has-text("결재"), a:has-text("결재"):visible, [title*="결재"]\`
2. **입력 필드 및 버튼 추론 (충돌 방지 원칙)**:
   - **[절대 금지: 임의의 가상 ID 생성 금지]**: \`#_USE_RESOURCE_\`, \`#_OPEN_RESOURCE_BTN_\`, \`#_SUBJECT_\`, \`#_CONTENTS_\`, \`#_SAVE_BTN_\` 같은 가상의 대문자 ID를 절대로 생성하지 마십시오. 실제 DOM에 존재하지 않아 100% 녹화가 중단됩니다. 실제 ID를 모르면 항상 한글 텍스트 매칭(\`:has-text(...)\`)과 표준 HTML 태그(\`input\`, \`textarea\`, \`button\`)를 사용하십시오!
   - **모달/레이어 팝업 내부 요소**: 팝업이나 다이얼로그 안의 요소는 반드시 \`.ui-dialog:visible\`, 특정 form id, 또는 \`:visible\`을 명시하십시오.
     예: \`.ui-dialog:visible #subject, #reg_schedule_form #subject, #subject:visible\`
   - **[주의 - 상단 검색창 충돌 방지]**: \`input[placeholder*="제목"]\` 같은 모호한 선택자는 상단 GNB 검색창(\`placeholder="제목, 내용, 첨부파일명"\`)과 매칭되어 다이얼로그 오버레이에 가로막히므로 단독으로 쓰지 마십시오.
   - 제목 입력: \`#subject:visible, input#subject, input[name*="subject"]:visible\`
   - 내용/본문: \`#cn:visible, textarea:visible, textarea[placeholder*="내용"], div[contenteditable="true"]\`
   - 검색창: \`input[type="search"], input[name*="search"], input[placeholder*="검색"], .search_box input\`
3. **iFrame 감지 및 대응**:
   - 그룹웨어, 엔터프라이즈 포털, 에디터는 종종 iFrame을 사용합니다.
   - 전자결재/양식: \`iframe[name*="docBox"], iframe[src*="form"], iframe#subBody\`
   - 에디터: \`iframe[name*="editor"], iframe[src*="editor"]\`
4. **실패 방지 (Optional Flag)**:
   - 닫기 팝업, 안내 레이어, 첫 번째 항목 선택, 확인 다이얼로그 등 화면 상태에 따라 존재하지 않을 수도 있는 단계는 반드시 \`"optional": true\`를 부여하십시오.
5. **모달 팝업과 배경 요소 철저 격리 (엄격 금지 규칙)**:
   - 등록/작성 버튼을 눌러 모달 대화상자(SimpleView, 레이어 팝업)가 열린 후에는, 반드시 팝업 내부의 제목(#subject), 내용(#cn), 저장(#savebtn)만을 조작하십시오.
   - [절대 금지] 모달 팝업이 열려 있는 상태에서 배경의 달력 툴바(\`.fc-today-button\`, \`.fc-button\`)나 메인 GNB 메뉴를 누르는 액션을 절대로 생성하지 마십시오! 모달 오버레이(ui-widget-overlay)에 가로막혀 브라우저 녹화가 100% 중단됩니다.

---

### [3] 시간 및 템포 규칙 (Timing Standards)
- 페이지 전체 이동 직후: \`3000ms ~ 4000ms\`
- 모달/레이어 팝업 열림: \`1500ms ~ 2000ms\`
- 입력 필드 클릭 및 타이핑: \`600ms ~ 1000ms\`
- 버튼 클릭 후 처리 대기: \`1500ms ~ 2500ms\`
- 영상 엔딩 마무리: \`3000ms\`
- 뷰포트: \`{ "width": 1920, "height": 1080 }\`
- 커서 딜레이: \`{ "delayMs": 800, "preClickRestMs": 180 }\`

---

### [4] 🚨 엔터프라이즈 업무 시스템 폼 작성 필수 원칙 (Enterprise Form Validation Rules)
전자결재, 문서관리, 게시판, 일정, 업무(스마트워크) 등 실제 업무 시스템의 폼 등록 시나리오를 작성할 때:
1. **절대 폼 진입 직후 저장/상신 버튼을 곧바로 누르지 마십시오.**
   (필수 입력값이 비어 있으면 자바스크립트 alert("제목을 입력하세요", "결재선을 지정하세요")에 걸려 자동화 녹화가 즉시 중단 및 실패합니다.)
2. **반드시 다음 5대 필수 시퀀스를 순서대로 모두 포함하십시오**:
   - **Step A. 제목(Subject) 입력**: 반드시 input selector와 의미 있는 텍스트(\`type\`) 액션을 배치하십시오. (iFrame 양식 내부일 경우 \`iframe\` 속성 필수 지정)
   - **Step B. 결재선 / 담당자 / 수신처 지정**:
     - 조직도 또는 결재선 버튼 클릭 (\`button:has(.ico_org)\`, \`button:has-text("결재선")\`, \`button:has-text("조직도")\` 등)
     - 팝업 로딩 대기 (\`wait: 2000ms\`)
     - 부서 트리 확장 또는 검색 (\`.dynatree-expander\`, \`.folder\`)
     - 대상자 체크박스 선택 (\`input[type="checkbox"]\`, \`.dynatree-checkbox\`)
     - [확인/적용] 버튼 클릭 (\`button:has-text("확인")\`)
   - **Step C. 본문 내용 작성**: 에디터 영역 클릭 또는 본문 텍스트 타이핑
   - **Step D. 최종 제출**: [상신], [저장], [등록] 버튼 클릭
   - **Step E. 확인 다이얼로그 승인**: "상신하시겠습니까?" 또는 "등록되었습니다" 알림창 처리
3. 폼 등록 시나리오는 최소 15~25단계 이상의 충실한 인터랙션 단계로 구성해야 실제 브라우저 자동화가 100% 성공합니다.
`;

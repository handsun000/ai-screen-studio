/**
 * Universal Video Tutorial Scenario Templates & Master Directing Framework
 *
 * Provides Gemini with professional screen recording directing principles,
 * universal enterprise groupware patterns, conditional targeting rules, and timing standards
 * to generate studio-grade demonstration videos for ANY web application.
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
    id: "gw-eap-draft",
    name: "전자결재 문서 기안 및 상신 (Approval Draft)",
    icon: "📑",
    description: "전자결재 양식 선택 -> 기록물철(문서보관함) 선택 -> 결재선/본문 작성 -> 결재상신으로 이어지는 엔터프라이즈 전자결재 완결형 튜토리얼",
    promptTemplate: "【목표】: 전자결재 신규 문서 기안 및 결재선 상신\n【진입 경로】: 포탈 전체메뉴(btn_svc_open) -> 전자결재 메뉴 이동\n【조작 순서】: [결재작성] 대버튼 클릭 -> 결재 양식 카드 선택 후 내부 [작성] 버튼 클릭 -> [기록물철/보관함 선택] 버튼 클릭 후 공용보관함 폴더 확장 및 선택 -> 제목 입력 -> 본문 작성 -> [결재상신] 버튼 클릭 -> 확인 승인\n【결과 확인】: 상신 완료 안내 및 기안문서함/결재현황 목록 확인",
    phases: [
      "1단계 [도입]: 포탈 메인 대시보드 3초간 노출",
      "2단계 [이동]: 포탈 전체메뉴(btn_svc_open) 클릭 -> 1200ms 대기 -> [전자결재] 메뉴 클릭 및 페이지 로딩 대기",
      "3단계 [양식선택]: 좌측 사이드바 [결재작성] 대버튼 클릭 -> 대상 결재양식 카드 선택 -> 카드 내부 [작성] 버튼 클릭",
      "4단계 [필수분류]: [기록물철] 선택 버튼 클릭 -> 다이얼로그 트리 펼침(.btn_fopn) 후 대상 보관함 선택 -> 확인",
      "5단계 [제목본문]: 제목 입력창에 기안 문서 제목 타이핑 및 본문 에디터 내용 작성",
      "6단계 [결재상신]: 상단 [결재상신] 버튼(._draftBtn) 클릭 후 확인 팝업 승인",
      "7단계 [완료확인]: 상신 완료 안내 및 목록 갱신 확인",
    ],
  },
  {
    id: "gw-eap-approve",
    name: "전자결재 문서 결재 승인/반려 처리 (Approval Review)",
    icon: "✅",
    description: "결재대기 문서 열람 -> 문서 내용 및 결재선 확인 -> [결재] 버튼 클릭 -> 결재 의견 작성 및 [승인] 완료 튜토리얼",
    promptTemplate: "【목표】: 전자결재 결재대기 문서 열람 및 결재 승인 처리\n【진입 경로】: 포탈 전체메뉴(btn_svc_open) -> 전자결재 메뉴 이동\n【조작 순서】: 결재대기/결재현황 목록에서 첫 번째 문서 클릭 -> 문서 상세 내용 확인 -> 상단 [결재] 버튼 클릭 -> 결재 팝업에서 결재의견(#eapApproval_opinCn) 입력 -> [승인](button._approve) 버튼 클릭\n【결과 확인】: 결재 완료 및 목록 상태 갱신 확인",
    phases: [
      "1단계 [도입]: 포탈 메인 대시보드 노출",
      "2단계 [이동]: 포탈 전체메뉴 -> [전자결재] 메뉴 진입",
      "3단계 [문서열람]: 목록에서 첫 번째 결재 문서 클릭하여 상세 뷰 오픈",
      "4단계 [결재팝업]: 상단 툴바 [결재] 버튼 클릭하여 결재 처리 다이얼로그 오픈",
      "5단계 [의견및승인]: 결재 의견(textarea#eapApproval_opinCn) 타이핑 후 [승인](button._approve) 클릭",
      "6단계 [결과확인]: 승인 처리 완료 후 목록 복귀",
    ],
  },
  {
    id: "gw-scd-register",
    name: "일정관리 새 일정 등록 (Schedule Register)",
    icon: "📅",
    description: "캘린더 진입 -> 일정 등록 레이어 오픈 -> 제목/시간/내용 입력 -> 저장 및 캘린더 반영 확인 튜토리얼",
    promptTemplate: "【목표】: 일정관리 신규 일정 등록 및 캘린더 확인\n【진입 경로】: 포탈 전체메뉴 -> 일정관리 메뉴 이동\n【조작 순서】: 좌측 [일정등록] 버튼(button#reg_shedule_lefttop) 클릭 -> 일정 제목 입력 -> 내용 입력 -> [저장] 버튼(#savebtn) 클릭\n【결과 확인】: 캘린더에 등록된 일정 블록 클릭하여 상세 확인 후 닫기",
    phases: [
      "1단계 [도입]: 메인 대시보드 3초간 와이드 뷰",
      "2단계 [이동]: 포탈 전체메뉴(btn_svc_open) 클릭 -> 1200ms 대기 -> [일정관리] 메뉴 클릭 및 페이지 로딩 대기",
      "3단계 [작성진입]: 좌측 [일정등록] 버튼(button#reg_shedule_lefttop) 클릭",
      "4단계 [정보입력]: 일정 제목 입력창(.ui-dialog:visible input#subject) 및 내용(textarea#cn) 타이핑",
      "5단계 [저장실행]: 하단 [저장] 버튼(.ui-dialog:visible button#savebtn) 클릭 후 캘린더 갱신 대기",
      "6단계 [등록확인]: 캘린더 화면에 생성된 일정 항목 클릭하여 상세 확인",
    ],
  },
  {
    id: "gw-rmg-reserve",
    name: "자원예약관리 회의실/시설 예약 신청 (Resource Reservation)",
    icon: "🏢",
    description: "자원예약관리 진입 -> [예약 신청] 클릭 -> 회의실/시설 자원 선택 -> 제목 및 신청사유 입력 -> 저장 튜토리얼",
    promptTemplate: "【목표】: 자원예약관리에서 회의실/공용자원 예약 신청\n【진입 경로】: 포탈 전체메뉴 -> 자원예약관리 메뉴 이동\n【조작 순서】: 좌측 [예약 신청] 버튼(button#rmgResSideBar_apply) 클릭 -> [자원 선택](button#resInsertDetailView_resSelect) 클릭하여 대상 회의실/자원 체크 후 [확인] -> 제목(input#subject) 및 신청사유(textarea#reqWhy) 입력 -> [저장](button#resInsertDetailView_saveBtn) 클릭\n【결과 확인】: 예약 신청 완료 및 내 예약 현황 확인",
    phases: [
      "1단계 [도입]: 포탈 메인 대시보드 노출",
      "2단계 [이동]: 포탈 전체메뉴 -> [자원예약관리] 진입",
      "3단계 [신청진입]: 좌측 [예약 신청](button#rmgResSideBar_apply) 클릭",
      "4단계 [자원선택]: [자원 선택] 팝업 오픈 -> 자원 항목 선택 후 [확인] 클릭",
      "5단계 [정보입력]: 예약 제목(input#subject) 및 신청사유(textarea#reqWhy) 작성",
      "6단계 [저장완료]: [저장](button#resInsertDetailView_saveBtn) 클릭 및 예약 반영 확인",
    ],
  },
  {
    id: "gw-brd-post",
    name: "게시판 새 공지 및 글 작성 (Board Post)",
    icon: "📢",
    description: "게시판 이동 -> [글작성] 클릭 -> 게시판 선택 -> 제목/본문 입력 -> 저장 및 게시글 상세 확인 튜토리얼",
    promptTemplate: "【목표】: 사내 게시판에 새 공지사항 및 게시글 작성\n【진입 경로】: 포탈 전체메뉴 -> 게시판 메뉴 이동\n【조작 순서】: 좌측 [글작성] 버튼(button#brdBoardLeft_writeBtn) 클릭 -> 게시판 선택 모달 트리 확장 후 말단 게시판 선택 및 확인 -> 제목 입력(input#brdAtclReg_subject) -> 본문 내용 작성 -> [저장] 버튼(button#brdAtclReg_save) 클릭\n【결과 확인】: 게시글 목록에 새 글 노출 확인",
    phases: [
      "1단계 [도입]: 포탈 메인 대시보드 3초간 노출",
      "2단계 [이동]: 포탈 전체메뉴(btn_svc_open) 클릭 -> 1200ms 대기 -> [게시판] 메뉴 클릭 및 페이지 로딩 대기",
      "3단계 [작성진입]: 좌측 [글작성] 버튼(#brdBoardLeft_writeBtn) 클릭 및 대상 게시판 선택",
      "4단계 [내용작성]: 제목 입력창(#brdAtclReg_subject)에 글 제목 타이핑 및 본문 작성",
      "5단계 [저장실행]: 상단 [저장] 버튼(#brdAtclReg_save) 클릭 후 확인 승인",
      "6단계 [목록확인]: 게시판 목록에 신규 등록된 글 확인",
    ],
  },
  {
    id: "gw-doc-register",
    name: "문서관리 새 문서 등록 (Document Register)",
    icon: "📂",
    description: "문서등록 버튼 -> 문서함 선택 대화상자에서 폴더 확장 및 말단 문서함 선택 -> 제목/본문 입력 -> 저장 튜토리얼",
    promptTemplate: "【목표】: 문서관리 공용 문서함에 신규 문서 등록\n【진입 경로】: 포탈 전체메뉴 -> 문서관리 메뉴 이동\n【조작 순서】: 좌측 [문서 등록] 버튼 클릭 -> [문서함 선택] 다이얼로그 트리 확장(.btn_fopn) 후 말단 문서함 선택 및 확인 -> 제목 입력(input#atclWrite_subject) -> 본문 내용 작성 -> [저장] 버튼 클릭\n【결과 확인】: 문서함 목록에 새 문서 등록 및 상세 조회 확인",
    phases: [
      "1단계 [도입]: 포탈 메인 대시보드 3초간 노출",
      "2단계 [이동]: 포탈 전체메뉴(btn_svc_open) 클릭 -> 1200ms 대기 -> [문서관리] 메뉴 클릭 및 페이지 로딩 대기",
      "3단계 [작성진입]: 좌측 [문서 등록] 버튼(#docMain_writeBtn) 클릭",
      "4단계 [문서함선택]: 문서함 선택 다이얼로그에서 트리 펼침(#docSelect_expandTree) 후 말단 문서함 선택 및 확인",
      "5단계 [정보입력]: 문서 제목 입력(input#atclWrite_subject) 및 본문 작성",
      "6단계 [저장실행]: [저장] 버튼(button._save) 클릭 후 완료 확인",
    ],
  },
  {
    id: "gw-wor-report",
    name: "업무보고 일일/주간 보고서 작성 (Work Report)",
    icon: "📊",
    description: "업무보고 진입 -> [보고 등록] 클릭 -> 보고함 선택 -> 제목 및 보고 내용 작성 -> 저장 튜토리얼",
    promptTemplate: "【목표】: 업무보고 모듈에서 신규 업무보고서 작성 및 제출\n【진입 경로】: 포탈 전체메뉴 -> 업무보고 메뉴 이동\n【조작 순서】: 좌측 [보고 등록](button#worSideBar_workReg) 클릭 -> 보고함 선택 후 [확인] -> 보고서 제목(input#worReportReg_subject) 입력 -> 보고 본문 내용 작성 -> [저장](button.worReportReg_save) 클릭\n【결과 확인】: 보고서 등록 완료 및 보고 목록 확인",
    phases: [
      "1단계 [도입]: 포탈 메인 대시보드 노출",
      "2단계 [이동]: 포탈 전체메뉴 -> [업무보고] 진입",
      "3단계 [작성진입]: 좌측 [보고 등록](button#worSideBar_workReg) 클릭 및 보고함 선택",
      "4단계 [내용작성]: 제목(input#worReportReg_subject) 및 보고 내용 작성",
      "5단계 [저장완료]: [저장](button.worReportReg_save) 클릭 및 목록 확인",
    ],
  },
  {
    id: "gw-eml-send",
    name: "전자우편 메일 작성 및 발송 (Webmail Send)",
    icon: "✉️",
    description: "메일쓰기 -> 받는 사람/제목/본문 작성 -> 발송 튜토리얼",
    promptTemplate: "【목표】: 전자우편 신규 메일 작성 및 수신자 발송\n【진입 경로】: 포탈 전체메뉴 -> 전자우편 메뉴 이동\n【조작 순서】: 좌측 [메일 쓰기] 버튼(button#emlList_goWriteEmail) 클릭 -> 받는 사람 지정 -> 제목 입력 -> 본문 작성 -> [보내기] 버튼(button._emlWriteConfirm_send) 클릭\n【결과 확인】: 발송 완료 메시지 확인",
    phases: [
      "1단계 [도입]: 메인 포탈 3초간 노출",
      "2단계 [이동]: 포탈 전체메뉴(btn_svc_open) 클릭 -> 1200ms 대기 -> [전자우편] 메뉴 클릭",
      "3단계 [작성진입]: [메일 쓰기] 버튼(#emlList_goWriteEmail) 클릭",
      "4단계 [내용작성]: 받는 사람, 제목(#emlWrite_subject) 및 본문 내용 입력",
      "5단계 [발송실행]: 상단 [보내기] 버튼(._emlWriteConfirm_send) 클릭",
      "6단계 [결과확인]: 발송 완료 후 목록 복귀",
    ],
  },
  {
    id: "gw-not-send",
    name: "사내쪽지 작성 및 발송 (Internal Note Send)",
    icon: "💌",
    description: "사내쪽지 진입 -> [쪽지 쓰기] 클릭 -> 조직도 수신자 선택 -> 제목/내용 입력 -> [보내기] 발송 튜토리얼",
    promptTemplate: "【목표】: 사내쪽지 작성 및 임직원 발송\n【진입 경로】: 포탈 전체메뉴 -> 사내쪽지 메뉴 이동\n【조작 순서】: 좌측 [쪽지 쓰기](button#notSubMenu_noteRegButton) 클릭 -> 주소록/조직도 버튼(button#notNoteReg_toAddressButton) 클릭하여 수신 사원 선택 후 확인 -> 제목(input#notNoteReg_subject) 및 쪽지 본문 작성 -> [보내기](button._notNoteReg_sendButton) 클릭\n【결과 확인】: 쪽지 발송 완료 및 보낸쪽지함 확인",
    phases: [
      "1단계 [도입]: 포탈 메인 노출",
      "2단계 [이동]: 포탈 전체메뉴 -> [사내쪽지] 메뉴 클릭",
      "3단계 [작성진입]: 좌측 [쪽지 쓰기](button#notSubMenu_noteRegButton) 클릭",
      "4단계 [수신자및내용]: 수신자 선택 후 제목(input#notNoteReg_subject) 및 본문(#notNoteReg_content) 작성",
      "5단계 [발송실행]: [보내기](button._notNoteReg_sendButton) 클릭 후 확인 승인",
    ],
  },
  {
    id: "gw-org-lookup",
    name: "조직도 임직원 검색 및 조회 (Org Chart Lookup)",
    icon: "👥",
    description: "조직도 팝업 열기 -> 부서 트리 확장 -> 사원 검색/선택 -> 사용자 상세 정보 조회 튜토리얼",
    promptTemplate: "【목표】: 조직도에서 부서 및 사원 검색 및 상세 정보 확인\n【진입 경로】: 메인 화면 조직도 아이콘/버튼 클릭\n【조작 순서】: 조직도 팝업 오픈 -> 부서 트리 전체 확장(#orgTree_btnExpandAll) -> 사원 목록에서 사원 선택 -> 상세 프로필 확인\n【결과 확인】: 사원 연락처 및 소속 정보 확인 후 닫기",
    phases: [
      "1단계 [도입]: 메인 화면 노출",
      "2단계 [팝업오픈]: 조직도 버튼 클릭하여 조직도 팝업 오픈",
      "3단계 [트리확장]: [전체 펼침] 버튼(#orgTree_btnExpandAll) 클릭하여 부서 구조 확인",
      "4단계 [사원선택]: 사원 목록에서 특정 사원 카드 클릭하여 상세 조회",
      "5단계 [마무리]: 조직도 창 닫기",
    ],
  },
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
      "8단계 [확인]: 등록 완료 알림 및 갱신된 상세/목록 화면 와이드 뷰 마무리",
    ],
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
      "5단계 [마무리]: 상세 내용 확인 후 닫기",
    ],
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
      "5단계 [복귀]: 홈 화면으로 복귀하며 마무리",
    ],
  },
  {
    id: "communication-chat",
    name: "소통 및 메시지 발송 (Communication & Chat)",
    icon: "💬",
    description: "메신저, 채팅, 이메일, 쪽지 또는 AI 챗봇과 대화/메시지를 주고받는 튜토리얼",
    promptTemplate: "【목표】: 대화 상대(동료/고객/AI)를 선택하고 메시지 전송\n【진입 경로】: 메신저/채팅/쪽지/이메일 패널 열기\n【조작 순서】: 새 메시지/쪽지 쓰기 버튼 클릭 -> (특정 수신자명이 지정된 경우 검색창으로 검색 후 선택, 미지정 시 조직도 목록에서 첫 번째 사원 카드 선택) -> 메시지 입력창에 내용 입력 -> [보내기/전송] 버튼 클릭\n【결과 확인】: 발송 완료 또는 대화방에 메시지가 등록된 화면 확인",
    phases: [
      "1단계 [도입]: 메인 화면에서 메신저/쪽지/메일 메뉴로 이동",
      "2단계 [진입]: 작성 화면/패널 열기 (1.5초 대기)",
      "3단계 [입력]: 수신 상대 선택 후 메시지 입력",
      "4단계 [전송]: 전송/보내기 버튼 클릭",
      "5단계 [확인]: 전송 결과 확인",
    ],
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
      "5단계 [확인]: 변경된 내용이 즉시 반영된 화면 확인",
    ],
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
      "5단계 [완료]: 메인 화면 전경 확인",
    ],
  },
];

/**
 * Master Video Directing Guidelines for Gemini AI Prompt Engineering (Single Source of Truth)
 */
export const MASTER_DIRECTING_GUIDELINES = `
# 🎬 Professional Screen Tutorial Directing & BrowsePlan Generation Guidelines (V3)

You are the Lead Screen Tutorial Video Director and Playwright Browser Automation Architect.
You strictly apply the **"Three Golden Canons of UI Automation"**, the **"Conditional Target Resolution Policy"**, the **"Universal 5-Phase Video Directing Framework"**, and the **"4 Universal Scenario Archetypes"** to produce studio-grade, zero-failure BrowsePlan JSON scenarios.

---

### 🚨 [1] The Three Golden Canons & Conditional Target Resolution

#### Canon 1. Structured Logical Action Conversion (검색·선택·복합 액션의 단계별 구조화)
- **Structured Search Workflow (CRITICAL)**:
  When the user specifies "Search for OOO" (e.g., "검색으로 회의록 검색", "test001 검색"), NEVER look for a static text node directly. You MUST plan the 5-step sequence:
  ① \`type\`: Locate the dedicated search input field (\`input#eapWorkSelect_searchWord:visible, input#atclList_searchWord:visible, input[id*='searchWord']:visible, .new_srch_bar input:visible\`) and type the exact keyword "OOO"
  ② \`wait\`: 800ms ~ 1200ms for input stabilization
  ③ \`click\`: Click the **adjacent search button immediately linked to this input** (\`button[id*='srchBtn']:visible, button[id*='searchBtn']:visible, button.btn_srch:visible\`)
  ④ \`wait\`: 1200ms ~ 1800ms for search results to render
  ⑤ \`click\`: Select the matching result card/row (\`:has-text('OOO')\`)
- **Structured Selection Workflow (CRITICAL)**:
  When the user specifies "Select XXX in Category/Folder/Dropdown" (e.g., "분류에 테스트 선택", "기록물철에 공용 선택"):
  ① \`click\`: Click the category dropdown, folder picker icon, or tree trigger button
  ② \`wait\`: 1000ms ~ 1500ms for options/tree dialog to open
  ③ (If inside a Dynatree modal): Click tree expander (\`.ui-dialog:visible .btn_fopn, .ui-dialog:visible .dynatree-expander\`) and wait 1000ms
  ④ \`click\`: Click the EXACT item matching 'XXX' (\`:has-text('XXX')\`, e.g. \`.ui-dialog:visible a.dynatree-title:has-text('XXX'):visible\`)
  ⑤ \`click\`: Click the confirmation [확인] button if in a dialog
- **Zero Step Dropping (복합 요구사항 누락 절대 금지)**:
  Translate EVERY detail requested by the user—such as Approval Line setup, specific user search, checkbox selection, Drag & Drop (\`"type": "dragAndDrop"\`, \`sourceSelector\`, \`targetSelector\`), tab switching, or post-submission verification—into concrete actions without omitting or abbreviating any step!

#### Canon 2. Precision Targeting & Relation-Based Proximity (다중 입력창 및 스코프 분리)
- **Adjacent Search Button Binding**:
  When multiple search bars coexist (GNB top search \`#homGwMain_aiSearchWord\`, sidebar tree search \`#snb .srch_bar\`, content toolbar search \`#content .srch_bar\`, modal search \`.ui-dialog:visible .srch_bar\`), ALWAYS scope both the input and the search button to the exact same container!
- **Contextual Scoping Prefix (Anti-Collision)**:
  Identical button labels ('저장', '등록', '작성', '확인', '닫기', '검색') coexist across layers. Always prefix with the container scope:
  • 🪟 Active Modal/Popup: \`.ui-dialog:visible \` (e.g., \`.ui-dialog:visible button._confirmBtn:visible, .ui-dialog:visible button:has-text('확인'):visible\`)
  • 👈 Left Sidebar (LNB): \`#snb \` (e.g., \`#snb button:has-text('등록'):visible\`)
  • 🔝 Top Header (GNB): \`header \` (e.g., \`button.btn_svc_open:visible\`)
  • 📄 Main Content Toolbar: \`#content \` or \`.new_srch_bar \`

#### Canon 3. Conditional Target Resolution Policy (명시적 타겟 vs 범용 시연 분기 — 자기모순 원천 해결)
Distinguish strictly between **Case A (Explicit Target Named in Prompt)** and **Case B (Generic Demo with No Specific Name)**:
- 🎯 **Case A — Explicit Target Specified (사용자가 특정 이름/대상을 명시한 경우: 예: 'test001', '회의록', '테스트', '전략기획팀')**:
  • 🚫 **STRICT BAN on \`:first-child\` / \`nth(0)\`**: NEVER use \`:first-child\` as a primary selector or fallback when a specific target name is given! Clicking an unrelated first item masks errors as false positives.
  • ALWAYS use exact text matching (\`:has-text('명시된이름')\`) or perform the 5-step search sequence first.
- 🌐 **Case B — Generic Demo (사용자가 특정 대상을 지정하지 않고 "문서 검색", "사원 1명 선택", "문서함 선택"만 요청한 경우)**:
  • 🚫 **STRICT BAN on Hallucinated Names**: NEVER invent fake titles or names ("2026학년도...", "김철수", "홍길동").
  • For List Search & View: Use Dynamic Live Data Scraping (\`"useScraped": "auto", "dynamicStrategy": "first-row-title"\`) so Playwright scrapes the actual first row from the live DB and searches for it.
  • For Generic Org/Tree/Card Picking: Selecting the first available leaf node or candidate card (\`.ui-dialog:visible label.user_info.chkbox, .ui-dialog:visible .dynatree-node:not(.dynatree-folder) a.dynatree-title:visible\`) is standard and expected.

---

### [2] Universal 5-Phase Video Directing Framework

1. **Phase 1: Visual Anchor & Landing**
   - Start with a mandatory **2500ms ~ 3500ms wait** (\`"type": "wait", "ms": 3000\`) so viewers can orient themselves on the landing screen.

2. **Phase 2: Intentional Navigation (🚨 Hidden Portal Service Drawer Rule)**
   - In enterprise portals, business modules (전자결재, 문서관리, 게시판, 일정관리, 자원예약관리, 업무보고, 스마트워크, 프로젝트, 설문조사, 파일함, 메모, 전자우편, 사내쪽지, 주소록, 근태관리) are inside the **[Portal Service Drawer] (\`button.btn_svc_open\`)**.
   - **Mandatory 4-Step Sequence**:
     ① \`click\`: \`button.btn_svc_open:visible, button[title='포탈 전체메뉴'], .btn_svc_open:visible\`
     ② \`wait\`: \`1200ms\` (drawer expansion animation)
     ③ \`click\`: \`#svc_box a:has-text('메뉴명'):visible, a:has-text('메뉴명'):visible\`
     ④ \`wait\`: \`3000ms\` (module page load)
   - 🚫 NEVER click hidden sub-menu links directly without opening \`button.btn_svc_open\` first!

3. **Phase 3: Focused Interaction & Clean Motion Standards**
   - **Single \`type\` Action Rule**: A \`type\` action automatically moves the cursor, clicks to focus, and types. NEVER generate a redundant \`click\` action on the same input field before \`type\`!
   - **No Aimless Hover Wandering**: Do NOT add random \`hover\` steps over headers, sidebars, or labels just to "look around". Hover ONLY when triggering dropdowns or tooltips.
   - **Precise Checkbox Selection**: When checking a user/item checkbox in a tree or table, target the actual checkbox or chkbox label (\`.ui-dialog:visible span.dynatree-checkbox:visible, .ui-dialog:visible label.user_info.chkbox:visible, input[type='checkbox']:visible\`), NOT a plain text link that opens a profile popup.
   - **Atomic Leaf Selector Rule**: NEVER target wide parent containers (\`div.btn_area\`, \`form#reg_form\`, \`tr\`). Always target the atomic interactive leaf element (\`button\`, \`a\`, \`input\`, \`textarea\`, \`select\`, \`label.chkbox\`).

4. **Phase 4: Action Execution**
   - Trigger decisive buttons ([저장], [결재상신], [보내기], [승인], [검색]) with proper container scope, followed by a **1500ms ~ 2500ms wait**.

5. **Phase 5: Outcome Review & Wrap-up**
   - Handle completion popups (\`.ui-dialog:visible button._confirmBtn:visible, .ui-dialog:visible button:has-text('확인'):visible\`) and allow **3500ms ~ 4500ms** for list/calendar reload.
   - When clicking a newly created item to verify, ALWAYS place \`:has-text('생성한제목')\` first before any generic row selector.

---

### [3] Universal 4-Archetype Scenario Routing

Classify the user's request into one of the 4 archetypes:

#### ① Archetype 1: Pure Exploration & Structure (\`EXPLORATION\`)
- **Triggers**: "기본 구조", "둘러보기", "탐색", "화면 구성", "투어", "메뉴 확인"
- 🚫 **Ban**: Zero form registrations or saves!
- **Flow**: [Portal Intro] ➔ [Open Drawer & Navigate] ➔ [Expand Sidebar Trees & Click Sub-folders] ➔ [Switch View Modes / Filters] ➔ [Outro]

#### ② Archetype 2: Pure Search & View (\`SEARCH_VIEW\`)
- **Triggers**: "검색", "조회", "열람", "상세", "찾기" (without creation request)
- 🚫 **Ban**: NEVER insert dummy registration steps before searching!
- **Flow**:
  - If no specific keyword is given by user: Use \`"useScraped": "auto", "dynamicStrategy": "first-row-title"\` on the content search \`type\` action -> click content search button -> click matching row (\`"useScraped": "auto"\`) -> inspect detail view.
  - If a specific keyword is given by user: Type that exact keyword into content search input -> click content search button -> click matching row (\`:has-text('키워드')\`).

#### ③ Archetype 3: Create & Submit (\`CREATE_SUBMIT\`)
- **Triggers**: "등록", "작성", "기안", "상신", "신청", "추가", "생성", "예약", "발송"
- 🚫 **Lean Form Policy**: Do NOT invent unrequested optional settings (보존기간, 보안등급, 태그, 알림 등) unless explicitly asked by the user.
- 📜 **Electronic Approval (전자결재 EAP) Special Workflows**:
  1) **3-Tier Form Entry (양식 선택 및 작성 진입)**:
     - Step 1: Click sidebar write button (\`#eapLeft_workWriteBtn:visible, #snb button:has-text('결재작성'):visible, #snb button:has-text('결재 작성'):visible\`)
     - Step 2: (If user asked to search template 'OOO'): Type 'OOO' in \`input#eapWorkSelect_searchWord:visible\` -> click \`#eapWorkSelect_searchBox button.btn_srch:visible\` -> wait 1200ms
     - Step 3: Click template card (\`ul.aw_ul li.aw_li:has-text('OOO') .app_work_box, ul.aw_ul li.aw_li:first-child .app_work_box\`)
     - Step 4: Click the small **[작성]** button inside the card (\`ul.aw_ul li.aw_li button.btn_write:visible, .app_work_box button:has-text('작성'):visible\`) -> wait 3500ms for form load!
  2) **Approval Line & Drag-and-Drop (결재선 지정 및 드래그 앤 드롭)**:
     - Click [결재선] tab (\`#eapDocReg_tabBox a:has-text('결재선'):visible\`) -> Click [결재선 선택] button (\`button#eapDocReg_lineSelBtn:visible\`)
     - Select department or search employee -> check employee checkbox -> click role button (\`.ui-dialog:visible #eapLineSelect_lineTrgtAdd button:has-text('합의'):visible\` or \`'결재'\`)
     - For Drag & Drop (\`"type": "dragAndDrop"\`):
       • \`sourceSelector\`: \`.ui-dialog:visible a.dynatree-title:has-text('사원명'):visible, .ui-dialog:visible .dynatree-node:has(a:has-text('사원명')) a.dynatree-title\`
       • \`targetSelector\`: \`#af_4, table#eapLineSelect_line td:nth-child(4) div.app_flow, .appline_flow table td:nth-child(4), #eapLineSelect_lineTrgtAdd button[data-app-type-ordr='4']\`
     - Click dialog confirm (\`.ui-dialog:visible button._confirmBtn:visible, .ui-dialog:visible button:has-text('확인'):visible\`)
- 🛡️ **2-Tier Shuttle & Picker Dialog Standard (권한/참석자/조직도/자원 중첩 모달)**:
  1) Click main form setting button (\`button:has-text('권한설정'):visible\`, \`button#resInsertDetailView_resSelect:visible\` 등)
  2) (If 2-tier outer layer opens): Click inner \`[추가]\` / \`[조직도]\` button (\`.ui-dialog:visible button:has-text('추가'):visible, .ui-dialog:visible button:has-text('조직도'):visible\`)
  3) Visually select target employee/resource card (\`.ui-dialog:visible label.user_info.chkbox, #selectList_list input[type='checkbox']:visible\`)
  4) Click transfer/add button if shuttle (\`.ui-dialog:visible button.drop_tgl:visible, .ui-dialog:visible button:has-text('추가'):visible, .ui-dialog:visible button:has-text('권한'):visible\`)
  5) Confirm inner picker modal (\`.ui-dialog:visible button._confirmBtn:visible, .ui-dialog:visible button:has-text('확인'):visible\`)
  6) (If 2-tier): Confirm outer setting modal (\`.ui-dialog:visible button:has-text('확인'):visible\`)

#### ④ Archetype 4: Workflow & Management (\`WORKFLOW_MANAGE\`)
- **Triggers**: "결재 승인", "반려", "보류", "수정", "상태 변경"
- **Flow**: [Navigate to Module] ➔ [Click Target Document/Item in List] ➔ [Click Approve/Reject/Edit Button (\`button._approveBtn\`, \`button:has-text('결재'):visible\`)] ➔ [Type Opinion (\`textarea#eapApproval_opinCn:visible\`) or Modify Fields] ➔ [Click Final Approve/Reject/Save (\`button._approve:visible\`, \`button._reject:visible\`)] ➔ [Verify Updated List]

---

### [4] Zero-Guessing Policy & Korean Localization Directive
- 🚫 **NEVER invent fake English IDs** (\`#_DOC_TITLE_\`, \`#btn_save_dialog\`, \`.app_line_table\`).
- Prefer verified selectors from **[NAONSOFT ENTERPRISE GROUPWARE KNOWLEDGE BASE V3]** and **[사전 시각 탐색 DOM 후보군]**.
- If a selector is truly unknown, set \`"selector": ""\` and mention it in \`explanation\`.
- All \`description\`, \`explanation\`, and \`:has-text('...')\` strings MUST be in accurate **Korean**.
`;

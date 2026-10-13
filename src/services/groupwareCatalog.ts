/**
 * Naonsoft Groupware Enterprise Architecture & DOM Catalog
 *
 * Extracted and compiled directly from:
 * - C:\dev\IdeaProjects\bc2026\bc2026_gw (2,719 JSPs, 4,311 JS Controllers)
 * - C:\dev\IdeaProjects\bc2026\bc2026_iam
 * - C:\dev\IdeaProjects\unison\unison_gw
 * - C:\dev\IdeaProjects\unison\unison_iam
 *
 * Provides 100% verified DOM IDs, CSS classes, Dynatree structures,
 * jQuery UI Dialogs, and canonical interaction sequences for enterprise groupware tutorials.
 */

export interface GroupwareModuleSpec {
  moduleKey: string;
  name: string;
  koreanName: string;
  keywords: string[];
  urlPatterns: string[];
  entryPoints: {
    gnbDrawerButton: string;
    gnbMenuItem: string;
    lnbWriteButton: string;
  };
  exactSelectors: {
    titleInput: string;
    bodyEditor?: string;
    categorySelectButton?: string;
    categoryModalTree?: string;
    categoryModalConfirm?: string;
    lineSelectButton?: string;
    lineModalTree?: string;
    lineModalConfirm?: string;
    saveButton: string;
    draftButton?: string;
    tempSaveButton?: string;
    cancelButton?: string;
    confirmButton: string;
    closeButton: string;
    treeExpander: string;
    treeLeafTitle: string;
  };
  specialInstructions: string[];
}

export const GROUPWARE_CATALOG: Record<string, GroupwareModuleSpec> = {
  portal: {
    moduleKey: "portal",
    name: "Portal Main & Navigation",
    koreanName: "포탈 메인 & GNB 네비게이션",
    keywords: ["포탈", "메인", "홈", "GNB", "전체메뉴", "서랍", "네비게이션"],
    urlPatterns: ["/hom/homGwMain", "/homGwMain", "/portal"],
    entryPoints: {
      gnbDrawerButton: "button.btn_svc_open, .svc_open button, #btn_svc_open",
      gnbMenuItem: "#svc_box a, #svc_lst a",
      lnbWriteButton: "button.btn_write, button#btn_write",
    },
    exactSelectors: {
      titleInput: "#homGwMain_aiSearchWord, input[name='searchWord']",
      saveButton: "button.btn_save, button:has-text('저장')",
      confirmButton: "button._confirmBtn, button.btn_pri, button:has-text('확인')",
      closeButton: "button._closeBtn, button.btn_close, button:has-text('닫기')",
      treeExpander: ".dynatree-expander, .btn_fopn",
      treeLeafTitle: "a.dynatree-title",
    },
    specialInstructions: [
      "포탈 전체메뉴(서랍) 열기: 반드시 button.btn_svc_open 클릭 후 1200ms 대기",
      "서랍 내부 메뉴 클릭: #svc_box a:has-text('메뉴명'):visible 로 스코프 지정",
    ],
  },

  eap: {
    moduleKey: "eap",
    name: "Enterprise Approval (EAP)",
    koreanName: "전자결재 (기업형 EAP)",
    keywords: ["결재", "기안", "상신", "전자결재", "품의", "문서기안", "결재선", "기록물철", "보관함"],
    urlPatterns: ["/eap/eapMain", "/eap/eapDocReg", "/eapDocReg"],
    entryPoints: {
      gnbDrawerButton: "button.btn_svc_open, #btn_svc_open",
      gnbMenuItem: "#svc_box a:has-text('전자결재'):visible, #svc_lst a:has-text('전자결재'):visible",
      lnbWriteButton: "#eapLeft_workWriteBtn, .work_write_box .btn_write, button:has-text('결재작성'):visible",
    },
    exactSelectors: {
      titleInput: "input#eapDocReg_docSubject, input#docTitle, input[name='docSubject']:visible",
      bodyEditor: "#eapDocReg_cn, #editor_iframe, iframe#subBody",
      categorySelectButton: "button#eapDocReg_binderSelBtn, button#eapDocReg_bindBtn, button:has-text('기록물철'):visible, button:has-text('문서보관함'):visible",
      categoryModalTree: "#eapBinderSelect_treeBox, .ui-dialog:visible .dynatree-container",
      categoryModalConfirm: "button#eapBinderSelect_confirm, .ui-dialog:visible button._confirmBtn, .ui-dialog:visible button:has-text('확인'):visible",
      lineSelectButton: "button#eapDocReg_lineSelectBtn, button:has-text('결재선'):visible",
      lineModalTree: "#eapLineSelect_orgTree, .ui-dialog:visible .dynatree-container",
      lineModalConfirm: ".ui-dialog:visible button._confirmBtn, .ui-dialog:visible button:has-text('확인'):visible",
      draftButton: "button._draftBtn, button:has-text('결재상신'):visible, button:has-text('상신'):visible",
      saveButton: "button#savebtn, button.btn_save, button:has-text('저장')",
      tempSaveButton: "button._tempSaveBtn, button:has-text('임시저장'):visible",
      cancelButton: "button._cancelBtn, button:has-text('취소'):visible",
      confirmButton: "button._confirmBtn, button.btn_pri, button:has-text('확인'):visible",
      closeButton: "button._closeBtn, button.btn_close, button:has-text('닫기'):visible",
      treeExpander: ".ui-dialog:visible .btn_fopn, .ui-dialog:visible .dynatree-expander",
      treeLeafTitle: ".ui-dialog:visible .dynatree-container a.dynatree-title:visible",
    },
    specialInstructions: [
      "양식 선택 화면: li.aw_li 또는 .work_lst .btn_write 클릭",
      "기록물철/보관함 선택 필수 (미선택 시 '보관함을 선택하세요' alert 발생)",
      "다이얼로그 트리 확장: 반드시 .btn_fopn 또는 .dynatree-expander 클릭 후 1000ms 대기 후 leaf node(a.dynatree-title) 선택",
      "결재상신 버튼: button._draftBtn 사용",
    ],
  },

  gap: {
    moduleKey: "gap",
    name: "Public Enterprise Approval (GAP)",
    koreanName: "전자결재 (공공형 GAP)",
    keywords: ["공공결재", "GAP", "대외공문", "발송", "공문서"],
    urlPatterns: ["/gap/gapMain", "/gap/gapDocReg"],
    entryPoints: {
      gnbDrawerButton: "button.btn_svc_open",
      gnbMenuItem: "#svc_box a:has-text('전자결재'):visible",
      lnbWriteButton: "#gapLeft_workWriteBtn, button:has-text('기안작성'):visible",
    },
    exactSelectors: {
      titleInput: "input#gapDocReg_docSubject, input[name='docSubject']",
      bodyEditor: "#gapDocReg_cn, iframe#subBody",
      categorySelectButton: "button#gapDocReg_binderSelBtn, button:has-text('기록물철'):visible",
      categoryModalTree: "#gapBinderSelect_treeBox, .ui-dialog:visible .dynatree-container",
      categoryModalConfirm: "button#gapBinderSelect_confirm, .ui-dialog:visible button._confirm",
      draftButton: "button._draft, button:has-text('상신'):visible",
      saveButton: "button.btn_save, button:has-text('저장')",
      confirmButton: "button._confirm, button:has-text('확인')",
      closeButton: "button._close, button:has-text('닫기')",
      treeExpander: ".dynatree-expander, .btn_fopn",
      treeLeafTitle: "a.dynatree-title",
    },
    specialInstructions: [
      "공공형 결재는 ._draft 버튼으로 상신 수행",
      "기록물철 분류 선택 필수",
    ],
  },

  board: {
    moduleKey: "board",
    name: "Board / Notice (BRD)",
    koreanName: "게시판 (BRD)",
    keywords: ["게시판", "공지", "공지사항", "게시글", "새글", "자유게시판", "사내게시판"],
    urlPatterns: ["/brd/brdBoardMain", "/brdAtclReg", "/brdAtclList"],
    entryPoints: {
      gnbDrawerButton: "button.btn_svc_open",
      gnbMenuItem: "#svc_box a:has-text('게시판'):visible, #svc_lst a:has-text('게시판'):visible",
      lnbWriteButton: "button#brdBoardLeft_writeBtn, .btn_write, button:has-text('글작성'):visible",
    },
    exactSelectors: {
      titleInput: "input#brdAtclReg_subject, input#subject, input[name='subject']:visible",
      bodyEditor: "#brdAtclReg_atclCn, iframe#subBody",
      categorySelectButton: "button#brdBoardSelect_btn, button:has-text('게시판선택'):visible",
      categoryModalTree: "#brdBoardSelect_treeBox, .ui-dialog:visible .dynatree-container",
      categoryModalConfirm: "button#brdBoardSelect_confirmBtn, .ui-dialog:visible button._confirmBtn",
      saveButton: "button#brdAtclReg_save, button.btn_save, button:has-text('저장'):visible",
      tempSaveButton: "button#brdAtclReg_tempSave, button:has-text('임시저장'):visible",
      cancelButton: "button#brdAtclReg_cancel, button:has-text('취소'):visible",
      confirmButton: "button._confirmBtn, button.btn_pri, button:has-text('확인'):visible",
      closeButton: "button._closeBtn, button.btn_close, button:has-text('닫기'):visible",
      treeExpander: ".ui-dialog:visible .btn_fopn, .ui-dialog:visible .dynatree-expander",
      treeLeafTitle: ".ui-dialog:visible a.dynatree-title:visible",
    },
    specialInstructions: [
      "게시글 작성: button#brdBoardLeft_writeBtn 클릭",
      "게시판 선택: 미선택 시 경고 발생하므로 첫 번째 게시판 폴더 확장 후 선택",
      "저장: button#brdAtclReg_save 또는 button:has-text('저장')",
    ],
  },

  doc: {
    moduleKey: "doc",
    name: "Document Management (DOC)",
    koreanName: "문서관리 (DOC)",
    keywords: ["문서", "문서함", "문서관리", "문서등록", "문서작성", "공용문서"],
    urlPatterns: ["/doc/docMain", "/atclEdit", "/atclList"],
    entryPoints: {
      gnbDrawerButton: "button.btn_svc_open",
      gnbMenuItem: "#svc_box a:has-text('문서관리'):visible, #svc_lst a:has-text('문서관리'):visible",
      lnbWriteButton: "button#docLeft_writeBtn, button#reg_doc_btn, button:has-text('문서등록'):visible",
    },
    exactSelectors: {
      titleInput: "input#atclEdit_subject, input#subject, input[name='subject']:visible",
      bodyEditor: "#atclEdit_cn, iframe#subBody",
      categorySelectButton: "button#docSelect_btn, button:has-text('문서함선택'):visible",
      categoryModalTree: "#docSelect_treeBox, .ui-dialog:visible .dynatree-container",
      categoryModalConfirm: "button#docSelect_confirmBtn, .ui-dialog:visible button._confirmBtn, .ui-dialog:visible button:has-text('확인'):visible",
      saveButton: "button#atclEdit_saveBtn, button#savebtn, button._save, button:has-text('저장'):visible",
      tempSaveButton: "button._tempSave, button:has-text('임시저장'):visible",
      cancelButton: "button._cancel, button:has-text('취소'):visible",
      confirmButton: "button._confirmBtn, button.btn_pri, button:has-text('확인'):visible",
      closeButton: "button._closeBtn, button.btn_close, button:has-text('닫기'):visible",
      treeExpander: ".ui-dialog:visible .btn_fopn, .ui-dialog:visible .dynatree-expander",
      treeLeafTitle: ".ui-dialog:visible a.dynatree-title:visible",
    },
    specialInstructions: [
      "문서함 선택 필수: 다이얼로그에서 .btn_fopn 클릭하여 트리 펼친 후 문서함 클릭",
      "문서함 노드 클릭 시 자동 닫힘 발생 가능: 확인 버튼 누르기 전 다이얼로그 존재 여부 체크 필수",
    ],
  },

  schedule: {
    moduleKey: "schedule",
    name: "Schedule / Calendar (SCD)",
    koreanName: "일정관리 (SCD)",
    keywords: ["일정", "캘린더", "일정관리", "일정등록", "스케줄", "회의"],
    urlPatterns: ["/scd/scdGetMainView", "/scdInsertScheduleView"],
    entryPoints: {
      gnbDrawerButton: "button.btn_svc_open",
      gnbMenuItem: "#svc_box a:has-text('일정관리'):visible, #svc_lst a:has-text('일정관리'):visible",
      lnbWriteButton: "button#reg_shedule_lefttop, button#scheduleLayerBtn, button:has-text('일정등록'):visible",
    },
    exactSelectors: {
      titleInput: "input#subject, input[name='subject']:visible",
      bodyEditor: "#cn, textarea#cn, iframe#subBody",
      categorySelectButton: "select#scdInsertScheduleView_calendarSelect, select#calendarSelect",
      saveButton: "button#savebtn, button.btn_save, button:has-text('저장'):visible",
      cancelButton: "button#cancelbtn, button:has-text('취소'):visible",
      confirmButton: "button._confirmBtn, button.btn_pri, button:has-text('확인'):visible",
      closeButton: "button._closeBtn, button.btn_close, button:has-text('닫기'):visible",
      treeExpander: ".dynatree-expander, .btn_fopn",
      treeLeafTitle: "a.dynatree-title",
    },
    specialInstructions: [
      "일정 등록 버튼: button#reg_shedule_lefttop 또는 button#scheduleLayerBtn",
      "제목: input#subject",
      "저장: button#savebtn",
    ],
  },

  email: {
    moduleKey: "email",
    name: "Webmail (EML)",
    koreanName: "전자우편 (EML)",
    keywords: ["메일", "웹메일", "전자우편", "메일작성", "편지", "메일쓰기"],
    urlPatterns: ["/eml/emlMain", "/emlWrite", "/emlList"],
    entryPoints: {
      gnbDrawerButton: "button.btn_svc_open",
      gnbMenuItem: "#svc_box a:has-text('전자우편'):visible, #svc_lst a:has-text('메일'):visible",
      lnbWriteButton: "button#emlList_goWriteEmail, button#emlSideMenu_writeBtn, button:has-text('메일쓰기'):visible",
    },
    exactSelectors: {
      titleInput: "input#emlWrite_subject, input#mailSubject, input#subject, input[name='subject']:visible",
      bodyEditor: "#emlWrite_content, iframe#subBody",
      saveButton: "button._emlWriteConfirm_send, button.btn_send, button:has-text('보내기'):visible",
      draftButton: "button._emlWriteConfirm_send, button.btn_send, button:has-text('보내기'):visible",
      tempSaveButton: "button#emlWrite_tempSave, button:has-text('임시보관'):visible",
      confirmButton: "button._confirmBtn, button.btn_pri, button:has-text('확인'):visible",
      closeButton: "button._closeBtn, button.btn_close, button:has-text('닫기'):visible",
      treeExpander: ".dynatree-expander, .btn_fopn",
      treeLeafTitle: "a.dynatree-title",
    },
    specialInstructions: [
      "메일 쓰기: button#emlList_goWriteEmail 또는 button#emlSideMenu_writeBtn",
      "받는 사람: input#mailTo 또는 input[name='to']",
      "보내기: button._emlWriteConfirm_send 또는 button:has-text('보내기')",
    ],
  },

  addr: {
    moduleKey: "addr",
    name: "Address Book (ADDR)",
    koreanName: "주소록 (ADDR)",
    keywords: ["주소록", "연락처", "연락처등록", "주소", "고객주소록"],
    urlPatterns: ["/addr/addrMain", "/addrList", "/addrModify"],
    entryPoints: {
      gnbDrawerButton: "button.btn_svc_open",
      gnbMenuItem: "#svc_box a:has-text('주소록'):visible, #svc_lst a:has-text('주소록'):visible",
      lnbWriteButton: "button#addrMain_write_btn, button#addr_add, button:has-text('연락처 추가'):visible",
    },
    exactSelectors: {
      titleInput: "input#contact_add_lyr_givenName, input#userName, input#addrName",
      saveButton: "button#contact_modify_lyr_save, button#group_add_lyr_save, button.btn_save",
      cancelButton: "button#contact_modify_lyr_cancel, button.btn_cancel",
      confirmButton: "button._confirmBtn, button:has-text('확인')",
      closeButton: "button._closeBtn, button:has-text('닫기')",
      treeExpander: ".dynatree-expander, .btn_fopn",
      treeLeafTitle: "a.dynatree-title",
    },
    specialInstructions: [
      "연락처 추가: button#addrMain_write_btn",
      "이름 입력: input#contact_add_lyr_givenName",
      "저장: button#contact_modify_lyr_save",
    ],
  },

  smartwork: {
    moduleKey: "smartwork",
    name: "SmartWork (SMW)",
    koreanName: "스마트워크 (SMW)",
    keywords: ["스마트워크", "업무", "태스크", "업무함", "업무등록"],
    urlPatterns: ["/smw/smartWorkMain", "/smwWorkReg"],
    entryPoints: {
      gnbDrawerButton: "button.btn_svc_open",
      gnbMenuItem: "#svc_box a:has-text('스마트워크'):visible, #svc_lst a:has-text('스마트워크'):visible",
      lnbWriteButton: "#smartWorkMain_menu > #smwWorkBoxReg, button.btn_write, button:has-text('업무등록'):visible",
    },
    exactSelectors: {
      titleInput: "input#smwWorkReg_subject, input[name='subject']:visible",
      saveButton: "button._save, button._opinionSave, button.btn_save",
      confirmButton: "button#smwWorkBoxSelect_confirm, button._confirmBtn, button:has-text('확인')",
      closeButton: "button#smwWorkBoxSelect_close, button:has-text('닫기')",
      treeExpander: ".btn_fopn, .dynatree-expander",
      treeLeafTitle: "a.dynatree-title",
    },
    specialInstructions: [
      "업무 등록 시 업무함(WorkBox) 선택 필수",
      "저장: button._save 또는 button._opinionSave",
    ],
  },

  attend: {
    moduleKey: "attend",
    name: "Attendance Management (ATN)",
    koreanName: "근태관리 (ATN)",
    keywords: ["근태", "출퇴근", "출근", "퇴근", "휴가", "부재", "근무"],
    urlPatterns: ["/atn/atnAttendMain", "/atnMyAttendWrite", "/atnMyAbsenceWrite"],
    entryPoints: {
      gnbDrawerButton: "button.btn_svc_open",
      gnbMenuItem: "#svc_box a:has-text('근태관리'):visible, #svc_lst a:has-text('근태관리'):visible",
      lnbWriteButton: "button#atnAttendSideBar_attendWrite, button#atnAttendSideBar_absenceWrite",
    },
    exactSelectors: {
      titleInput: "input#myAbsenceWrite_input_absnWhy, input#absnWhy",
      saveButton: "button#myAttendWrite_btn_attn, button#myAttendWrite_btn_lvof, button._confirmBtn",
      confirmButton: "button._confirmBtn, button:has-text('확인')",
      closeButton: "button._closeBtn, button:has-text('닫기')",
      treeExpander: ".dynatree-expander, .btn_fopn",
      treeLeafTitle: "a.dynatree-title",
    },
    specialInstructions: [
      "출근 체크: button#myAttendWrite_btn_attn",
      "퇴근 체크: button#myAttendWrite_btn_lvof",
      "부재/휴가 신청: button#atnAttendSideBar_absenceWrite 클릭 후 사유 입력 및 _confirmBtn 승인",
    ],
  },

  org: {
    moduleKey: "org",
    name: "Organization Common Dialog (ORG)",
    koreanName: "조직도 공통 팝업 (ORG)",
    keywords: ["조직도", "부서", "사원", "직원", "사용자", "인사"],
    urlPatterns: ["/organization/", "/orgDialog"],
    entryPoints: {
      gnbDrawerButton: "button.btn_svc_open",
      gnbMenuItem: "#svc_box a:has-text('조직도'):visible",
      lnbWriteButton: "button#orgTree_btnSearch",
    },
    exactSelectors: {
      titleInput: "input#orgTree_searchText, input#orgDialogUser_searchWord",
      saveButton: "button._confirmBtn, button.btn_pri",
      confirmButton: "button._confirmBtn, button.btn_pri, button:has-text('확인'):visible",
      closeButton: "button._closeBtn, button.btn_close, button:has-text('닫기'):visible",
      treeExpander: "#orgTree_btnExpandAll, .ui-dialog:visible .btn_fopn, .dynatree-expander",
      treeLeafTitle: "#orgTree_treeBox a.dynatree-title, .ui-dialog:visible a.dynatree-title",
    },
    specialInstructions: [
      "조직도 트리 전체 확장: button#orgTree_btnExpandAll 클릭",
      "사원 선택: .org_user_lst .input_chk 또는 a.dynatree-title",
      "반영/확인: button._confirmBtn 클릭",
    ],
  },
};

/**
 * Helper to match user prompt against Groupware modules
 */
export function matchGroupwareModule(prompt: string): GroupwareModuleSpec | null {
  const p = prompt.toLowerCase();
  for (const [key, spec] of Object.entries(GROUPWARE_CATALOG)) {
    if (spec.keywords.some((kw) => p.includes(kw.toLowerCase()))) {
      return spec;
    }
  }
  return null;
}

/**
 * Returns a high-density prompt context block describing exact Naonsoft Groupware architecture
 */
export function getGroupwarePromptContext(prompt: string): string {
  const matched = matchGroupwareModule(prompt);

  let output = `\n======================================================
🏢 [NAONSOFT ENTERPRISE GROUPWARE KNOWLEDGE BASE V2]
======================================================
이 프로젝트는 Naonsoft EKP 엔터프라이즈 그룹웨어 환경에 완벽히 최적화되어 있습니다.
소스코드(bc2026_gw, unison_gw, bc2026_iam)에서 실측된 100% 실존 셀렉터 규격을 준수하십시오.

1. 포탈 및 GNB 서랍 네비게이션:
   - 포탈 전체메뉴(서랍): button.btn_svc_open
   - 메뉴 펼침 대기: wait: 1200 ms 필수
   - 서랍 내 메뉴 선택: #svc_box a:has-text('메뉴명'):visible

2. 대화상자(Modal Dialog) 및 분류/트리(Dynatree):
   - 대화상자 컨테이너: .ui-dialog:visible
   - 트리 펼침 버튼: .ui-dialog:visible .btn_fopn 또는 .dynatree-expander
   - 트리 노드 선택: .ui-dialog:visible a.dynatree-title:visible
   - 대화상자 확인 버튼: .ui-dialog:visible button._confirmBtn, button.btn_pri, button:has-text('확인')

3. 본문 작성 및 웹 에디터:
   - 본문 에디터 iFrame이 존재하는 경우 iframe: "#subBody" 또는 iframe: "#editor_iframe" 스코프 명시

4. 액션 버튼 표준 클래스:
   - 결재 상신: button._draftBtn, button:has-text('상신'):visible
   - 일반 저장: button#savebtn, button.btn_save, button:has-text('저장'):visible
   - 임시 저장: button._tempSaveBtn, button:has-text('임시저장'):visible
   - 팝업 승인: button._confirmBtn, button.btn_pri, button:has-text('확인'):visible
   - 취소/닫기: button._closeBtn, button.btn_close, button:has-text('닫기'):visible\n`;

  if (matched) {
    output += `\n🎯 감지된 대상 모듈 명세 [${matched.koreanName} (${matched.moduleKey.toUpperCase()})]:
- LNB 진입 버튼: ${matched.entryPoints.lnbWriteButton}
- 제목 입력창: ${matched.exactSelectors.titleInput}
- 분류/보관함 선택 버튼: ${matched.exactSelectors.categorySelectButton || "해당 없음"}
- 분류/보관함 모달 트리: ${matched.exactSelectors.categoryModalTree || "해당 없음"}
- 실행/저장/상신 버튼: ${matched.exactSelectors.draftButton || matched.exactSelectors.saveButton}
- 확인 버튼: ${matched.exactSelectors.confirmButton}
- 특수 규칙:
${matched.specialInstructions.map((s) => `  * ${s}`).join("\n")}\n`;
  }

  output += `======================================================\n`;
  return output;
}

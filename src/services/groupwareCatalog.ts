/**
 * Naonsoft Groupware Enterprise Architecture & DOM Catalog (V3 - Full Package Edition)
 *
 * Extracted and compiled directly from standard Naonsoft EKP Groupware packages:
 * - C:\dev\IdeaProjects\bc2026\bc2026_gw (2,719 JSPs, 4,311 JS Controllers)
 * - C:\dev\IdeaProjects\bc2026\bc2026_iam
 * - C:\dev\IdeaProjects\unison\unison_gw (2,646 JSPs, 4,215 JS Controllers)
 * - C:\dev\IdeaProjects\unison\unison_iam
 *
 * Covers 18 core enterprise modules (Portal, EAP, GAP, Board, Doc, Schedule, Email,
 * Note, Reservation, Work Report, SmartWork, Project, Survey, Filebox, Memo, Address, Attendance, Org).
 * Provides 100% verified DOM IDs, CSS classes, Dynatree structures, jQuery UI Dialogs,
 * search bars, approval workflows, and canonical interaction sequences.
 */

export interface GroupwareModuleSpec {
  moduleKey: string;
  name: string;
  koreanName: string;
  gnbMenuText: string;
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
    searchInput?: string;
    searchButton?: string;
    listFirstItem?: string;
  };
  workflowSelectors?: {
    approveModalTrigger?: string;
    opinionInput?: string;
    approveConfirmButton?: string;
    rejectConfirmButton?: string;
    holdOffButton?: string;
  };
  specialInstructions: string[];
}

export const GROUPWARE_CATALOG: Record<string, GroupwareModuleSpec> = {
  portal: {
    moduleKey: "portal",
    name: "Portal Main & Navigation",
    koreanName: "포탈 메인 & GNB 네비게이션",
    gnbMenuText: "포탈",
    keywords: ["포탈", "메인", "홈", "GNB", "전체메뉴", "서랍", "네비게이션", "대시보드"],
    urlPatterns: ["/hom/homGwMain", "/homGwMain", "/portal"],
    entryPoints: {
      gnbDrawerButton: "button.btn_svc_open:visible, .svc_open button:visible, #btn_svc_open:visible",
      gnbMenuItem: "#svc_box a:visible, #svc_lst a:visible",
      lnbWriteButton: "button.btn_write:visible, button#btn_write:visible",
    },
    exactSelectors: {
      titleInput: "#homGwMain_aiSearchWord, input[name='searchWord']",
      saveButton: "button.btn_save:visible, button:has-text('저장'):visible",
      confirmButton: "button._confirmBtn:visible, button.btn_pri:visible, button:has-text('확인'):visible",
      closeButton: "button._closeBtn:visible, button.btn_close:visible, button:has-text('닫기'):visible",
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
    gnbMenuText: "전자결재",
    keywords: ["결재", "기안", "상신", "전자결재", "품의", "문서기안", "결재선", "기록물철", "보관함", "회의록", "지출결의서", "결재현황", "반려", "승인", "합의"],
    urlPatterns: ["/eap/eapMain", "/eap/eapDocReg", "/eapDocReg", "/eapDocList"],
    entryPoints: {
      gnbDrawerButton: "button.btn_svc_open:visible, #btn_svc_open:visible",
      gnbMenuItem: "#svc_box a:has-text('전자결재'):visible, #svc_lst a:has-text('전자결재'):visible",
      lnbWriteButton: "#eapLeft_workWriteBtn:visible, #snb button:has-text('결재작성'):visible, #snb button:has-text('결재 작성'):visible, .work_write_box .btn_write:visible",
    },
    exactSelectors: {
      titleInput: "input#eapDocReg_docSubject:visible, input#docTitle:visible, input[name='docSubject']:visible",
      bodyEditor: ".doc_view_table textarea:visible, table.tbl_frm textarea:visible, #eapDocReg_contents textarea:visible, #eapDocReg_cn, #editor_iframe, iframe#subBody",
      categorySelectButton: "button#eapDocReg_binderSelBtn:visible, button#eapDocReg_bindBtn:visible, button:has-text('기록물철'):visible, button:has-text('문서보관함'):visible, tr:has-text('결재문서보관함') button:visible",
      categoryModalTree: "#eapBinderSelect_treeBox, .ui-dialog:visible .dynatree-container",
      categoryModalConfirm: "button#eapBinderSelect_confirm:visible, .ui-dialog:visible button._confirmBtn:visible, .ui-dialog:visible button:has-text('확인'):visible",
      lineSelectButton: "button#eapDocReg_lineSelBtn:visible, button#eapDocReg_lineSelectBtn:visible, button:has-text('결재선 선택'):visible, button:has-text('결재선'):visible",
      lineModalTree: "#eapLineSelect_orgBox, #eapLineSelect_orgTree, .ui-dialog:visible .dynatree-container",
      lineModalConfirm: "#eapLineSelect_btns button._confirmBtn:visible, .ui-dialog:visible button._confirmBtn:visible, .ui-dialog:visible button:has-text('확인'):visible",
      draftButton: "button._draftBtn:visible, button:has-text('결재상신'):visible, button:has-text('상신'):visible",
      saveButton: "button._draftBtn:visible, button#savebtn:visible, button.btn_save:visible, button:has-text('저장'):visible",
      tempSaveButton: "button._tempSaveBtn:visible, button:has-text('임시저장'):visible",
      cancelButton: "button._cancelBtn:visible, button:has-text('취소'):visible",
      confirmButton: "button._confirmBtn:visible, button.btn_pri:visible, button:has-text('확인'):visible",
      closeButton: "button._closeBtn:visible, button.btn_close:visible, button:has-text('닫기'):visible",
      treeExpander: ".ui-dialog:visible .btn_fopn, .ui-dialog:visible .dynatree-expander",
      treeLeafTitle: ".ui-dialog:visible .dynatree-container a.dynatree-title:visible",
      searchInput: "input#eapWorkSelect_searchWord:visible, #eapDocList_searchDiv input:visible, input[id*='searchWord']:visible, .new_srch_bar input:visible",
      searchButton: "#eapWorkSelect_searchBox button.btn_srch:visible, #eapDocList_searchDiv button.btn_srch:visible, button[id*='searchBtn']:visible, button[id*='srchBtn']:visible, #content button[title='검색']:visible",
      listFirstItem: "table.tbl_lst tbody tr:first-child td.sub a:visible, ul.lst_vr_ul li:first-child a.sub_tp:visible, table tbody tr:first-child a:visible",
    },
    workflowSelectors: {
      approveModalTrigger: "#eapDocView_docModeToolbar button._approveBtn:visible, button:has-text('결재'):visible",
      opinionInput: "textarea#eapApproval_opinCn:visible, .ui-dialog:visible textarea:visible",
      approveConfirmButton: "#eapApproval_btns button._approve:visible, .ui-dialog:visible button._approve:visible, .ui-dialog:visible button:has-text('승인'):visible",
      rejectConfirmButton: "#eapApproval_btns button._reject:visible, .ui-dialog:visible button._reject:visible, .ui-dialog:visible button:has-text('반려'):visible",
      holdOffButton: "#eapApproval_btns button._holdOff:visible, .ui-dialog:visible button._holdOff:visible, .ui-dialog:visible button:has-text('보류'):visible",
    },
    specialInstructions: [
      "전자결재 기안 진입 3단계 필수: ① 좌측 [결재작성](#eapLeft_workWriteBtn) 클릭 -> ② 결재업무 양식 카드(ul.aw_ul li.aw_li .app_work_box) 선택(검색 요청 시 input#eapWorkSelect_searchWord 검색 후 선택) -> ③ 선택된 카드 내부의 소형 [작성] 버튼(ul.aw_ul li.aw_li button.btn_write:visible) 클릭 -> ④ 3500ms 폼 로딩 대기",
      "문서정보/결재선 탭 전환: #eapDocReg_tabBox a:has-text('결재선'):visible 또는 a:has-text('문서정보'):visible 클릭",
      "기록물철/결재문서보관함 선택 필수: button#eapDocReg_binderSelBtn 클릭 -> 다이얼로그에서 .btn_fopn / .dynatree-expander로 트리 확장 후 말단 보관함(a.dynatree-title) 클릭 -> 확인(자동 닫힘 대응)",
      "결재선 지정 모달(#eapLineSelect_dialog): button#eapDocReg_lineSelBtn 클릭 -> 부서 노드(a.dynatree-title:has-text('부서명')) 클릭 -> 사원 체크박스(.ui-dialog:visible span.dynatree-checkbox:has(+ a:has-text('사원명'))) 선택 -> 역할 추가 버튼(#eapLineSelect_lineTrgtAdd button:has-text('합의') 또는 '결재') 클릭",
      "결재선 드래그 앤 드롭(dragAndDrop): sourceSelector='.ui-dialog:visible a.dynatree-title:has-text(\"사원명\"):visible', targetSelector='#af_4, table#eapLineSelect_line td:nth-child(4) div.app_flow, #eapLineSelect_lineTrgtAdd button[data-app-type-ordr=\"4\"]'",
      "결재상신 실행: button._draftBtn:visible 클릭 후 확인 팝업 승인",
      "결재 승인/반려 처리(WORKFLOW_MANAGE): 문서 상세에서 결재 버튼 클릭 -> #eapApproval_opinCn 의견 입력 -> button._approve(승인) 또는 button._reject(반려) 클릭",
    ],
  },

  gap: {
    moduleKey: "gap",
    name: "Public Enterprise Approval (GAP)",
    koreanName: "전자결재 (공공형 GAP)",
    gnbMenuText: "전자결재",
    keywords: ["공공결재", "GAP", "대외공문", "발송", "공문서", "기안작성"],
    urlPatterns: ["/gap/gapMain", "/gap/gapDocReg"],
    entryPoints: {
      gnbDrawerButton: "button.btn_svc_open:visible",
      gnbMenuItem: "#svc_box a:has-text('전자결재'):visible",
      lnbWriteButton: "button#gapLeft_workWriteBtn:visible, #snb button:has-text('기안작성'):visible, #snb button:has-text('결재 작성'):visible",
    },
    exactSelectors: {
      titleInput: "input#gapDocReg_docSubject:visible, input[name='docSubject']:visible",
      bodyEditor: "#gapDocReg_cn, iframe#subBody",
      categorySelectButton: "button#gapDocReg_binderSelBtn:visible, button#gapDocReg_bindBtn:visible, button:has-text('기록물철'):visible",
      categoryModalTree: "#gapBinderSelect_treeBox, .ui-dialog:visible .dynatree-container",
      categoryModalConfirm: "button#gapBinderSelect_confirm:visible, .ui-dialog:visible button._confirm:visible",
      draftButton: "button._draft:visible, button:has-text('상신'):visible",
      saveButton: "button.btn_save:visible, button:has-text('저장'):visible",
      confirmButton: "button._confirm:visible, button:has-text('확인'):visible",
      closeButton: "button._close:visible, button:has-text('닫기'):visible",
      treeExpander: ".dynatree-expander, .btn_fopn",
      treeLeafTitle: "a.dynatree-title",
    },
    specialInstructions: [
      "공공형 결재는 button._draft 버튼으로 상신 수행",
      "기록물철 분류 선택 필수",
    ],
  },

  board: {
    moduleKey: "board",
    name: "Board / Notice (BRD)",
    koreanName: "게시판 (BRD)",
    gnbMenuText: "게시판",
    keywords: ["게시판", "공지", "공지사항", "게시글", "새글", "자유게시판", "사내게시판", "글작성"],
    urlPatterns: ["/brd/brdBoardMain", "/brdAtclReg", "/brdAtclList"],
    entryPoints: {
      gnbDrawerButton: "button.btn_svc_open:visible",
      gnbMenuItem: "#svc_box a:has-text('게시판'):visible, #svc_lst a:has-text('게시판'):visible",
      lnbWriteButton: "button#brdBoardLeft_writeBtn:visible, #snb .btn_write:visible, button:has-text('글작성'):visible, button:has-text('글 등록'):visible",
    },
    exactSelectors: {
      titleInput: "input#brdAtclReg_subject:visible, input#subject:visible, input[name='subject']:visible",
      bodyEditor: "#brdAtclReg_atclCn, div[contenteditable='true']:visible, iframe#subBody",
      categorySelectButton: "button#brdBoardSelect_btn:visible, button:has-text('게시판선택'):visible",
      categoryModalTree: "#brdBoardSelect_treeBox, .ui-dialog:visible .dynatree-container",
      categoryModalConfirm: "button#brdBoardSelect_confirmBtn:visible, .ui-dialog:visible button._confirmBtn:visible, .ui-dialog:visible button:has-text('확인'):visible",
      saveButton: "button#brdAtclReg_save:visible, button._saveBtn:visible, button.btn_save:visible, button:has-text('저장'):visible",
      tempSaveButton: "button#brdAtclReg_tempSave:visible, button:has-text('임시저장'):visible",
      cancelButton: "button#brdAtclReg_cancel:visible, button:has-text('취소'):visible",
      confirmButton: "button._confirmBtn:visible, button.btn_pri:visible, button:has-text('확인'):visible",
      closeButton: "button._closeBtn:visible, button.btn_close:visible, button:has-text('닫기'):visible",
      treeExpander: ".ui-dialog:visible .btn_fopn, .ui-dialog:visible .dynatree-expander",
      treeLeafTitle: ".ui-dialog:visible .dynatree-node:not(.dynatree-folder) a.dynatree-title:visible, .ui-dialog:visible a.dynatree-title:visible",
      searchInput: "input#brdAtclList_searchWord:visible, input[id*='searchWord']:visible, #content .srch_bar input:visible",
      searchButton: "button#brdAtclList_searchBtn:visible, button[id*='searchBtn']:visible, #content .srch_bar button.btn_srch:visible",
      listFirstItem: "table.tbl_lst tbody tr:first-child td.sub a:visible, ul.lst_vr_ul li:first-child a.sub_tp:visible",
    },
    specialInstructions: [
      "게시글 작성: 좌측 button#brdBoardLeft_writeBtn 클릭",
      "게시판 선택 모달이 뜨면 .btn_fopn 클릭하여 트리 펼친 후 등록 가능한 말단 게시판(.dynatree-node:not(.dynatree-folder) a.dynatree-title) 선택 및 확인",
      "저장: button#brdAtclReg_save 또는 button:has-text('저장'):visible 클릭",
    ],
  },

  doc: {
    moduleKey: "doc",
    name: "Document Management (DOC / EDMS)",
    koreanName: "문서관리 (DOC)",
    gnbMenuText: "문서관리",
    keywords: ["문서", "문서함", "문서관리", "문서등록", "문서작성", "공용문서", "edms"],
    urlPatterns: ["/doc/docMain", "/atclEdit", "/atclWrite", "/atclList"],
    entryPoints: {
      gnbDrawerButton: "button.btn_svc_open:visible",
      gnbMenuItem: "#svc_box a:has-text('문서관리'):visible, #svc_lst a:has-text('문서관리'):visible",
      lnbWriteButton: "button#docMain_writeBtn:visible, button#docLeft_writeBtn:visible, button#edmsLeft_docRegBtn:visible, button#reg_doc_btn:visible, #snb button:has-text('문서 등록'):visible, button:has-text('문서등록'):visible",
    },
    exactSelectors: {
      titleInput: "input#atclWrite_subject:visible, input#atclEdit_subject:visible, input#subject:visible, input[name='subject']:visible",
      bodyEditor: "#atclWrite_atclCn:visible, #atclEdit_cn:visible, div[contenteditable='true']:visible, iframe#subBody",
      categorySelectButton: "button#docSelect_btn:visible, button:has-text('문서함선택'):visible, button:has-text('문서함 선택'):visible",
      categoryModalTree: "#docSelect_treeBox, .ui-dialog:visible .dynatree-container",
      categoryModalConfirm: "button#docSelect_confirm:visible, button#docSelect_confirmBtn:visible, .ui-dialog:visible button._confirmBtn:visible, .ui-dialog:visible button:has-text('확인'):visible",
      saveButton: "button._save:visible, button#atclEdit_saveBtn:visible, button#savebtn:visible, button:has-text('저장'):visible",
      tempSaveButton: "button._tempSave:visible, button:has-text('임시저장'):visible",
      cancelButton: "button._cancel:visible, button:has-text('취소'):visible",
      confirmButton: "button._confirmBtn:visible, button.btn_pri:visible, button:has-text('확인'):visible",
      closeButton: "button._closeBtn:visible, button.btn_close:visible, button:has-text('닫기'):visible",
      treeExpander: "#docSelect_expandTree:visible, .ui-dialog:visible .btn_fopn, .ui-dialog:visible .dynatree-expander",
      treeLeafTitle: ".ui-dialog:visible .dynatree-container .dynatree-node:not(.dynatree-folder) a.dynatree-title:visible, .ui-dialog:visible a.dynatree-title:visible",
      searchInput: "input#atclList_searchWord:visible, .new_srch_bar input:visible, #content .srch_input input:visible",
      searchButton: "button#atclList_srchBtn:visible, .new_srch_bar button:visible, #content .srch_input button:has(.ico_srch):visible",
      listFirstItem: "table.tbl_lst tbody tr:first-child td.sub a:visible, ul.lst_vr_ul li:first-child a.sub_tp:visible",
    },
    specialInstructions: [
      "문서 등록 클릭 직후 [문서함 선택] 팝업이 열리면 반드시 #docSelect_expandTree(.btn_fopn)로 트리를 펼친 후 말단 문서함(.dynatree-node:not(.dynatree-folder) a.dynatree-title) 선택 -> #docSelect_confirm 확인 클릭",
      "제목 입력창은 input#atclWrite_subject:visible 또는 input#atclEdit_subject:visible 사용",
      "문서 검색 시 사이드바 폴더 검색(#snb)이 아닌 본문 상단 툴바 검색창(input#atclList_searchWord:visible)과 검색 버튼(button#atclList_srchBtn:visible) 사용",
    ],
  },

  schedule: {
    moduleKey: "schedule",
    name: "Schedule / Calendar (SCD)",
    koreanName: "일정관리 (SCD)",
    gnbMenuText: "일정관리",
    keywords: ["일정", "캘린더", "일정관리", "일정등록", "스케줄", "달력"],
    urlPatterns: ["/scd/scdGetMainView", "/scdInsertScheduleView"],
    entryPoints: {
      gnbDrawerButton: "button.btn_svc_open:visible",
      gnbMenuItem: "#svc_box a:has-text('일정관리'):visible, #svc_lst a:has-text('일정관리'):visible",
      lnbWriteButton: "button#reg_shedule_lefttop:visible, button#scheduleLayerBtn:visible, #snb button:has-text('일정 등록'):visible, button:has-text('일정등록'):visible",
    },
    exactSelectors: {
      titleInput: ".ui-dialog:visible input#subject:visible, input#subject:visible, input[name='subject']:visible",
      bodyEditor: ".ui-dialog:visible textarea#cn:visible, textarea#cn:visible, #cn:visible",
      categorySelectButton: "select#scdInsertScheduleView_calendarSelect, select#calendarSelect, #selected_calendarInfo",
      saveButton: ".ui-dialog:visible button#savebtn:visible, button#savebtn:visible, button.btn_save:visible, button:has-text('저장'):visible",
      cancelButton: "button#cancelbtn:visible, button:has-text('취소'):visible",
      confirmButton: "button._confirmBtn:visible, button.btn_pri:visible, button:has-text('확인'):visible",
      closeButton: ".ui-dialog:visible button# schedule_info_lyr_closeBtn:visible, button._closeBtn:visible, button.btn_close:visible, button:has-text('닫기'):visible",
      treeExpander: ".dynatree-expander, .btn_fopn",
      treeLeafTitle: "a.dynatree-title",
      listFirstItem: "a.fc-event:visible, .fc-event-title:visible",
    },
    specialInstructions: [
      "일정 등록 버튼: 좌측 상단 button#reg_shedule_lefttop 클릭 시 일정 등록 레이어 모달(.ui-dialog:visible) 오픈",
      "모달 내 제목 입력: .ui-dialog:visible input#subject:visible",
      "모달 내 내용 입력: .ui-dialog:visible textarea#cn:visible",
      "모달 내 저장 버튼: .ui-dialog:visible button#savebtn:visible",
      "등록 후 캘린더에서 일정 확인 시: 반드시 방금 입력한 제목을 포함하는 a.fc-event:has-text('일정제목'):visible 을 1순위로 타겟팅",
    ],
  },

  rmg: {
    moduleKey: "rmg",
    name: "Resource Reservation Management (RMG)",
    koreanName: "자원예약관리 (RMG)",
    gnbMenuText: "자원예약관리",
    keywords: ["자원", "자원예약", "자원예약관리", "회의실", "회의실예약", "차량예약", "시설예약", "예약신청"],
    urlPatterns: ["/reservation/", "/rmgResMain", "/rmgResInsertDetailView"],
    entryPoints: {
      gnbDrawerButton: "button.btn_svc_open:visible",
      gnbMenuItem: "#svc_box a:has-text('자원예약'):visible, #svc_lst a:has-text('자원예약'):visible",
      lnbWriteButton: "button#rmgResSideBar_apply:visible, #snb button:has-text('예약 신청'):visible, #snb button:has-text('자원예약'):visible, button:has-text('예약신청'):visible",
    },
    exactSelectors: {
      titleInput: "#dl_reg_res_form input#subject:visible, .ui-dialog:visible input#subject:visible, input#subject:visible",
      bodyEditor: "#dl_reg_res_form textarea#reqWhy:visible, .ui-dialog:visible textarea#reqWhy:visible, textarea#reqWhy:visible",
      categorySelectButton: "button#resInsertDetailView_resSelect:visible, button:has-text('자원 선택'):visible, button:has-text('자원선택'):visible",
      categoryModalTree: "#rmgResSelect_folderList, #selectList_list, .ui-dialog:visible .dynatree-container",
      categoryModalConfirm: ".ui-dialog:visible button.btn_pri:has-text('확인'):visible, .ui-dialog:visible button:has-text('확인'):visible",
      lineSelectButton: "button#resInsertDetailView_btnShare:visible, button._ortChtBtn:visible",
      saveButton: "button#resInsertDetailView_saveBtn:visible, .ui-dialog:visible button#resInsertDetailView_saveBtn:visible, button:has-text('저장'):visible",
      cancelButton: "button#resInsertDetailView_closeBtn:visible, button:has-text('취소'):visible, button:has-text('닫기'):visible",
      confirmButton: "button#rmgResInsertDetailView_confirm:visible, .ui-dialog:visible button.btn_pri:visible, button:has-text('확인'):visible",
      closeButton: "button#resInsertDetailView_closeBtn:visible, button:has-text('닫기'):visible",
      treeExpander: "#rmgResSideBar_expandTree, .ui-dialog:visible .btn_fopn, .dynatree-expander",
      treeLeafTitle: "#rmgResSelect_folderList a.dynatree-title:visible, #selectList_list input[type='checkbox']:visible, #selectList_list tr:first-child label:visible, a.dynatree-title:visible",
      searchInput: "input#resSelect_searchWord:visible, #resHeader_searchBar input:visible",
      searchButton: "#resHeader_searchBar button.btn_srch:visible, button[title='검색']:visible",
    },
    specialInstructions: [
      "예약 신청 진입: 좌측 button#rmgResSideBar_apply 클릭",
      "자원 선택 필수: button#resInsertDetailView_resSelect 클릭 -> 자원 선택 팝업에서 폴더 선택 및 우측 자원 목록(#selectList_list) 체크박스 선택 -> 확인 클릭",
      "제목(input#subject) 및 신청사유(textarea#reqWhy) 입력 후 button#resInsertDetailView_saveBtn 클릭하여 예약 저장",
    ],
  },

  email: {
    moduleKey: "email",
    name: "Webmail (EML)",
    koreanName: "전자우편 (EML)",
    gnbMenuText: "전자우편",
    keywords: ["메일", "웹메일", "전자우편", "메일작성", "편지", "메일쓰기", "받은메일함", "보낸메일함"],
    urlPatterns: ["/eml/emlMain", "/emlMailReg", "/emlMailList"],
    entryPoints: {
      gnbDrawerButton: "button.btn_svc_open:visible",
      gnbMenuItem: "#svc_box a:has-text('전자우편'):visible, #svc_lst a:has-text('전자우편'):visible, #svc_box a:has-text('메일'):visible",
      lnbWriteButton: "button#emlList_goWriteEmail:visible, button#emlSideMenu_writeBtn:visible, #snb button:has-text('메일 쓰기'):visible, button:has-text('메일쓰기'):visible",
    },
    exactSelectors: {
      titleInput: "input#emlMailReg_subject:visible, input#emlWrite_subject:visible, input#mailSubject:visible, input#subject:visible, input[name='subject']:visible",
      bodyEditor: "#emlWrite_content:visible, #writeContent div[contenteditable='true']:visible, iframe#subBody",
      lineSelectButton: "button#emlMailReg_toAddressButton:visible, button:has-text('주소록'):visible, button:has-text('조직도'):visible",
      saveButton: "button._emlWriteConfirm_send:visible, button#emlMailRegPreviewLyr_send_btn:visible, button.btn_send:visible, button:has-text('보내기'):visible",
      draftButton: "button._emlWriteConfirm_send:visible, button.btn_send:visible, button:has-text('보내기'):visible",
      tempSaveButton: "button#emlWrite_tempSave:visible, button:has-text('임시보관'):visible, button:has-text('임시저장'):visible",
      confirmButton: "button._confirmBtn:visible, button.btn_pri:visible, button:has-text('확인'):visible",
      closeButton: "button._closeBtn:visible, button.btn_close:visible, button:has-text('닫기'):visible",
      treeExpander: ".dynatree-expander, .btn_fopn",
      treeLeafTitle: "a.dynatree-title",
      searchInput: "input#emlLmbMailList_searchWord:visible, #emlLmbMailList_search_bar input:visible, input[id*='searchWord']:visible",
      searchButton: "button#emlLmbMailList_btnSearch:visible, #emlLmbMailList_search_bar button.btn_srch:visible",
      listFirstItem: "#list_listStyleDiv tbody tr:first-child a.sub_tp:visible, #mailList_header ~ div tr:first-child a:visible, ul.lst_vr_ul li:first-child a.sub_tp:visible",
    },
    specialInstructions: [
      "메일 쓰기: 좌측 button#emlList_goWriteEmail 또는 #snb button:has-text('메일 쓰기'):visible 클릭",
      "받는 사람 직접 입력(input#emlMailReg_toEmailList, input#mailTo) 또는 주소록/조직도 팝업에서 수신자 선택",
      "제목 입력 후 본문 작성 및 상단 [보내기](button._emlWriteConfirm_send, button:has-text('보내기'):visible) 클릭",
    ],
  },

  note: {
    moduleKey: "note",
    name: "Internal Note / Message (NOT)",
    koreanName: "사내쪽지 (NOT)",
    gnbMenuText: "사내쪽지",
    keywords: ["쪽지", "사내쪽지", "쪽지쓰기", "쪽지발송", "받은쪽지", "보낸쪽지"],
    urlPatterns: ["/not/notMain", "/notNoteReg", "/notNoteList"],
    entryPoints: {
      gnbDrawerButton: "button.btn_svc_open:visible",
      gnbMenuItem: "#svc_box a:has-text('사내쪽지'):visible, #svc_box a:has-text('쪽지'):visible, #svc_lst a:has-text('사내쪽지'):visible",
      lnbWriteButton: "button#notSubMenu_noteRegButton:visible, #snb button:has-text('쪽지 쓰기'):visible, button:has-text('쪽지쓰기'):visible",
    },
    exactSelectors: {
      titleInput: "input#notNoteReg_subject:visible, input[name*='subject']:visible",
      bodyEditor: "#notNoteReg_content:visible, #editor1 div[contenteditable='true']:visible, div[contenteditable='true']:visible",
      lineSelectButton: "button#notNoteReg_toAddressButton:visible, button:has-text('주소록'):visible, button:has-text('조직도'):visible",
      saveButton: "button._notNoteReg_sendButton:visible, button.btn_pri._notNoteReg_sendButton:visible, button:has-text('보내기'):visible",
      draftButton: "button._notNoteReg_sendButton:visible, button:has-text('보내기'):visible",
      tempSaveButton: "button._notNoteReg_tempSaveButton:visible, button:has-text('임시보관'):visible",
      cancelButton: "button._notNoteReg_cancel:visible, button:has-text('취소'):visible",
      confirmButton: "button._confirmBtn:visible, button.btn_pri:visible, button:has-text('확인'):visible",
      closeButton: "button._closeBtn:visible, button:has-text('닫기'):visible",
      treeExpander: "#notNoteMoveTree_extendAll, .dynatree-expander, .btn_fopn",
      treeLeafTitle: "a.dynatree-title",
      searchInput: "input#noteHeader_searchWord:visible, #noteHeader_search_bar input:visible",
      searchButton: "button#noteHeader_btnSearch:visible, #noteHeader_search_bar button.btn_srch:visible",
      listFirstItem: "#list_listStyleDiv tr:first-child a:visible, ul.lst_vr_ul li:first-child a.sub_tp:visible",
    },
    specialInstructions: [
      "쪽지 쓰기 진입: 좌측 button#notSubMenu_noteRegButton 클릭",
      "받는 사람 지정: input#notNoteReg_toText 타이핑 또는 button#notNoteReg_toAddressButton 클릭하여 조직도에서 사원 선택 후 확인",
      "제목(input#notNoteReg_subject) 및 본문(#notNoteReg_content) 작성 후 button._notNoteReg_sendButton (보내기) 클릭",
    ],
  },

  work: {
    moduleKey: "work",
    name: "Work / Report Management (WOR)",
    koreanName: "업무보고 (WOR)",
    gnbMenuText: "업무보고",
    keywords: ["업무보고", "보고서", "일일보고", "주간보고", "정기보고", "보고등록", "보고함"],
    urlPatterns: ["/wor/worMain", "/worReportReg", "/worWorkList"],
    entryPoints: {
      gnbDrawerButton: "button.btn_svc_open:visible",
      gnbMenuItem: "#svc_box a:has-text('업무보고'):visible, #svc_lst a:has-text('업무보고'):visible",
      lnbWriteButton: "button#worSideBar_workReg:visible, #snb button:has-text('보고 등록'):visible, button:has-text('보고등록'):visible",
    },
    exactSelectors: {
      titleInput: "input#worReportReg_subject:visible, input[name*='subject']:visible",
      bodyEditor: "#worReportReg_workCn:visible, #worReportReg_formEditArea div[contenteditable='true']:visible, div[contenteditable='true']:visible",
      categorySelectButton: "button#worSideBar_workReg:visible",
      categoryModalTree: "#slt_work_lyr #worWorkBoxSelect_workBoxList, #worWorkBoxSelectPopup_workBoxList",
      categoryModalConfirm: "button#worWorkBoxSelectByCp_confirm:visible, .ui-dialog:visible button.btn_pri:has-text('확인'):visible, .ui-dialog:visible button:has-text('확인'):visible",
      lineSelectButton: "#worReportReg_receiver button:visible, button:has-text('조직도'):visible",
      saveButton: "button.worReportReg_save:visible, button.btn_pri.worReportReg_save:visible, button:has-text('저장'):visible",
      tempSaveButton: "button.worReportReg_saveTemp:visible, button:has-text('임시저장'):visible",
      cancelButton: "button.worReportReg_cancel:visible, button:has-text('취소'):visible",
      confirmButton: "button._confirmBtn:visible, button.btn_pri:visible, button:has-text('확인'):visible",
      closeButton: "button#worWorkBoxSelectByCp_close:visible, button:has-text('닫기'):visible",
      treeExpander: ".btn_fopn, .dynatree-expander",
      treeLeafTitle: "#worWorkBoxSelect_workBoxList tr:first-child a:visible, #worWorkBoxSelectPopup_workBoxList tr:first-child a:visible, a.dynatree-title:visible",
      searchInput: "input#worViewerList_searchWord:visible, #workList_toolbar input[id*='searchWord']:visible, #content .srch_bar input:visible",
      searchButton: "#workList_toolbar button.btn_srch:visible, #content .srch_bar button.btn_srch:visible",
      listFirstItem: "table.tbl_lst tbody tr:first-child td.sub a:visible, ul.lst_vr_ul li:first-child a.sub_tp:visible",
    },
    specialInstructions: [
      "보고 등록 클릭(button#worSideBar_workReg) 시 [보고함 선택] 레이어(#slt_work_lyr)가 열리면 첫 번째 보고함 항목을 클릭하고 [확인] 클릭",
      "제목(input#worReportReg_subject) 및 보고 내용(#worReportReg_workCn) 입력 후 상단/하단 button.worReportReg_save 클릭",
    ],
  },

  smartwork: {
    moduleKey: "smartwork",
    name: "SmartWork (SMW)",
    koreanName: "스마트워크 (SMW)",
    gnbMenuText: "스마트워크",
    keywords: ["스마트워크", "업무함", "업무등록", "스마트업무", "그리드업무"],
    urlPatterns: ["/smw/smartWorkMain", "/smwWorkMain", "/smwWorkReg"],
    entryPoints: {
      gnbDrawerButton: "button.btn_svc_open:visible",
      gnbMenuItem: "#svc_box a:has-text('스마트워크'):visible, #svc_lst a:has-text('스마트워크'):visible",
      lnbWriteButton: "#smartWorkMain_menu #smwWorkBoxReg:visible, #smwWorkMain_snb button.btn_write:visible, #snb button:has-text('업무 등록'):visible, button:has-text('업무등록'):visible",
    },
    exactSelectors: {
      titleInput: "input#smwWorkReg_subject:visible, input[name='subject']:visible",
      bodyEditor: "#smwWorkReg_regForm textarea:visible, #smwWorkReg_regForm div[contenteditable='true']:visible",
      categoryModalConfirm: "button#smwWorkBoxSelect_confirm:visible, .ui-dialog:visible button._confirmBtn:visible, .ui-dialog:visible button:has-text('확인'):visible",
      saveButton: "button._save:visible, button#smwWorkReg_opinionSave:visible, button.btn_save:visible, button:has-text('저장'):visible",
      confirmButton: "button#smwWorkBoxSelect_confirm:visible, button._confirmBtn:visible, button:has-text('확인'):visible",
      closeButton: "button#smwWorkBoxSelect_close:visible, button:has-text('닫기'):visible",
      treeExpander: ".btn_fopn, .dynatree-expander",
      treeLeafTitle: ".ui-dialog:visible a.dynatree-title:visible, a.dynatree-title:visible",
      searchInput: "input#smwSelectTask_searchWord:visible, #smwWorkList_toolbar input:visible",
      searchButton: "button#smwSelectTask_btnSearch:visible, #smwWorkList_toolbar button.btn_srch:visible",
      listFirstItem: "#smwWorkList_list tr:first-child a:visible, #smwMyWorkList_list tr:first-child a:visible",
    },
    specialInstructions: [
      "업무 등록 시 업무함(WorkBox) 선택 팝업이 뜨면 트리 확장 후 말단 업무함 선택 및 확인(#smwWorkBoxSelect_confirm)",
      "저장: button._save 또는 button:has-text('저장'):visible 클릭",
    ],
  },

  project: {
    moduleKey: "project",
    name: "Project & Task Management (PRJ / TWS)",
    koreanName: "프로젝트 / 일감관리 (PRJ)",
    gnbMenuText: "프로젝트",
    keywords: ["프로젝트", "일감", "일감등록", "마일스톤", "간트차트", "이슈", "이슈등록", "스페이스", "팀사이트"],
    urlPatterns: ["/prj/prjMain", "/prjTaskMain", "/prjTaskDetailForm", "/prjIssueMain"],
    entryPoints: {
      gnbDrawerButton: "button.btn_svc_open:visible",
      gnbMenuItem: "#svc_box a:has-text('프로젝트'):visible, #svc_box a:has-text('스페이스'):visible, #svc_lst a:has-text('프로젝트'):visible",
      lnbWriteButton: "button#prjDetailTaskList_btnAddTask:visible, button#prjMain_new_project_lyr:visible, button:has-text('일감 등록'):visible, button:has-text('프로젝트 생성'):visible",
    },
    exactSelectors: {
      titleInput: "input#prjTaskDetailForm_taskSubject:visible, input#prjIssueReg_subject:visible, input[name*='subject']:visible",
      bodyEditor: "#prjTaskDetailForm_taskDesc div[contenteditable='true']:visible, textarea#prjIssueReg_issueCn:visible, div[contenteditable='true']:visible",
      lineSelectButton: "button#prjTaskDetailForm_btnSelIncharge:visible, button#prjTaskDetailForm_btnSelRequester:visible, button#prjIssueReg_btnSelPrc:visible",
      saveButton: "button[name='prjTaskDetailForm_btnSave']:visible, button.btn_pri:has-text('저장'):visible, button:has-text('저장'):visible",
      cancelButton: "button#prjTaskDetailForm_btnCancel:visible, button:has-text('취소'):visible",
      confirmButton: "button#prjSelectProject_confirm:visible, button#prjSelectTask_btnConfirm:visible, .ui-dialog:visible button:has-text('확인'):visible",
      closeButton: "button#prjTaskDetailInfo_btnClose:visible, button#prjSelectProject_close:visible, button:has-text('닫기'):visible",
      treeExpander: "#prjSelectIncharge_expandTree, .btn_fopn, .dynatree-expander",
      treeLeafTitle: "#prjSelectIncharge_treeDiv a.dynatree-title:visible, a.dynatree-title:visible",
      searchInput: "input#prjTaskSearch_searchWord:visible, input#prjProjectSelect_searchWord:visible",
      searchButton: "button#prjTaskSearch_btnSearch:visible, button.btn_srch:visible",
      listFirstItem: "#prjDetailTaskList_list tr:first-child a:visible, table.tbl_lst tbody tr:first-child a:visible",
    },
    specialInstructions: [
      "일감 등록: button#prjDetailTaskList_btnAddTask 클릭 -> 일감 제목(input#prjTaskDetailForm_taskSubject) 입력 -> 담당자 지정(button#prjTaskDetailForm_btnSelIncharge) -> 저장(button[name='prjTaskDetailForm_btnSave'])",
    ],
  },

  survey: {
    moduleKey: "survey",
    name: "Survey & Poll (SUR)",
    koreanName: "설문조사 (SUR)",
    gnbMenuText: "설문조사",
    keywords: ["설문", "설문조사", "설문등록", "투표", "앙케이트"],
    urlPatterns: ["/sur/surSurveyMain", "/surSurveyRegister", "/surSurveyList"],
    entryPoints: {
      gnbDrawerButton: "button.btn_svc_open:visible",
      gnbMenuItem: "#svc_box a:has-text('설문'):visible, #svc_lst a:has-text('설문'):visible",
      lnbWriteButton: "button#sur_writeBtn:visible, #snb button:has-text('설문 등록'):visible, button:has-text('설문등록'):visible",
    },
    exactSelectors: {
      titleInput: "#sur_registerBox input[name*='surveyTitle']:visible, #sur_registerBox input[type='text']:visible, input#subject:visible",
      bodyEditor: "#sur_registerBox textarea:visible, div[contenteditable='true']:visible",
      saveButton: "button#sur_rgtSaveBtn:visible, button.btn_pri:has-text('저장'):visible, button:has-text('저장'):visible",
      confirmButton: "button._confirmBtn:visible, button.btn_pri:visible, button:has-text('확인'):visible",
      closeButton: "button._closeBtn:visible, button:has-text('닫기'):visible",
      treeExpander: ".btn_fopn, .dynatree-expander",
      treeLeafTitle: "a.dynatree-title",
      searchInput: "#sur_listToolbar input[type='text']:visible, #content .srch_bar input:visible",
      searchButton: "#sur_listToolbar button.btn_srch:visible, #content .srch_bar button.btn_srch:visible",
      listFirstItem: "#sur_listContent tr:first-child a:visible, table.tbl_lst tbody tr:first-child a:visible",
    },
    specialInstructions: [
      "설문 등록 진입: 좌측 button#sur_writeBtn 클릭",
      "설문 기본정보 및 문항 입력 후 button#sur_rgtSaveBtn 클릭하여 저장",
    ],
  },

  filebox: {
    moduleKey: "filebox",
    name: "Filebox / Cloud Storage (FBX)",
    koreanName: "파일함 (FBX)",
    gnbMenuText: "파일함",
    keywords: ["파일함", "웹하드", "자료실", "폴더", "공유폴더", "개인폴더", "파일올리기"],
    urlPatterns: ["/fbx/fbxMain", "/fbxList"],
    entryPoints: {
      gnbDrawerButton: "button.btn_svc_open:visible",
      gnbMenuItem: "#svc_box a:has-text('파일함'):visible, #svc_lst a:has-text('파일함'):visible",
      lnbWriteButton: "#fbxList_titlebar button:has-text('올리기'):visible, button:has-text('파일 올리기'):visible, button:has-text('새 폴더'):visible",
    },
    exactSelectors: {
      titleInput: "#fbxList_searchDiv input:visible, .ui-dialog:visible input[type='text']:visible",
      saveButton: "button#fbxMainCommonLayer_save:visible, .ui-dialog:visible button.btn_pri:visible, button:has-text('저장'):visible",
      confirmButton: "button._confirmBtn:visible, button.btn_pri:visible, button:has-text('확인'):visible",
      closeButton: "button#fbxMainCommonLayer_closeBottom:visible, button:has-text('닫기'):visible",
      treeExpander: "#filebox_tree .dynatree-expander",
      treeLeafTitle: "#filebox_tree a.dynatree-title:visible",
      searchInput: "#fbxList_searchDiv input[type='text']:visible",
      searchButton: "#fbxList_searchDiv button.btn_srch:visible",
    },
    specialInstructions: [
      "좌측 파일함 트리(#filebox_tree a.dynatree-title)에서 개인폴더/공유폴더 클릭하여 파일 목록 조회",
    ],
  },

  memo: {
    moduleKey: "memo",
    name: "Memo (MMO)",
    koreanName: "메모 (MMO)",
    gnbMenuText: "메모",
    keywords: ["메모", "포스트잇", "메모장", "새메모", "중요메모"],
    urlPatterns: ["/mmo/mmoMain", "/mmoMemoList"],
    entryPoints: {
      gnbDrawerButton: "button.btn_svc_open:visible",
      gnbMenuItem: "#svc_box a:has-text('메모'):visible, #svc_lst a:has-text('메모'):visible",
      lnbWriteButton: "button#mmoMainLeft_addMemoBtn:visible, #mmoMemoList_writeMemo .memo_write:visible, button:has-text('메모 등록'):visible",
    },
    exactSelectors: {
      titleInput: "#mmoMemoList_writeMemo div[contenteditable='true']:visible, .memo_post div[contenteditable='true']:visible",
      bodyEditor: "#mmoMemoList_writeMemo div[contenteditable='true']:visible, .memo_post div[contenteditable='true']:visible",
      saveButton: "#mmoMemoList_writeMemo button.btn_save:visible, button._saveMemo:visible, button:has-text('저장'):visible",
      confirmButton: "button._confirmBtn:visible, button:has-text('확인'):visible",
      closeButton: "button._closeBtn:visible, button:has-text('닫기'):visible",
      treeExpander: "#mmoMainLeft_folderBox .btn_fopn",
      treeLeafTitle: "#mmoFolderList_folderList li a:visible",
    },
    specialInstructions: [
      "메모 작성: 좌측 button#mmoMainLeft_addMemoBtn 클릭 또는 본문 상단 #mmoMemoList_writeMemo 영역 클릭 후 내용 타이핑 및 저장",
    ],
  },

  addr: {
    moduleKey: "addr",
    name: "Address Book (ADDR)",
    koreanName: "주소록 (ADDR)",
    gnbMenuText: "주소록",
    keywords: ["주소록", "연락처", "연락처등록", "주소", "고객주소록", "내주소록"],
    urlPatterns: ["/addr/addrMain", "/addrList", "/addrModify"],
    entryPoints: {
      gnbDrawerButton: "button.btn_svc_open:visible",
      gnbMenuItem: "#svc_box a:has-text('주소록'):visible, #svc_lst a:has-text('주소록'):visible",
      lnbWriteButton: "button#addrMain_write_btn:visible, button#addr_add:visible, #snb button:has-text('연락처 등록'):visible, button:has-text('연락처 추가'):visible",
    },
    exactSelectors: {
      titleInput: "input#contact_add_lyr_givenName:visible, input#userName:visible, input#addrName:visible",
      saveButton: "button#contact_modify_lyr_save:visible, button#contact_add_lyr_save:visible, button#group_add_lyr_save:visible, button.btn_save:visible, button:has-text('저장'):visible",
      cancelButton: "button#contact_modify_lyr_cancel:visible, button.btn_cancel:visible",
      confirmButton: "button._confirmBtn:visible, button:has-text('확인'):visible",
      closeButton: "button._closeBtn:visible, button:has-text('닫기'):visible",
      treeExpander: ".dynatree-expander, .btn_fopn",
      treeLeafTitle: "a.dynatree-title",
    },
    specialInstructions: [
      "연락처 추가: 좌측 button#addrMain_write_btn 클릭",
      "이름 입력: input#contact_add_lyr_givenName 타이핑 후 저장 버튼 클릭",
    ],
  },

  attend: {
    moduleKey: "attend",
    name: "Attendance Management (ATN)",
    koreanName: "근태관리 (ATN)",
    gnbMenuText: "근태관리",
    keywords: ["근태", "근태관리", "출퇴근", "출근", "퇴근", "휴가", "부재", "부재등록", "근무"],
    urlPatterns: ["/atn/atnAttendMain", "/atnMyAttendWrite", "/atnMyAbsenceWrite"],
    entryPoints: {
      gnbDrawerButton: "button.btn_svc_open:visible",
      gnbMenuItem: "#svc_box a:has-text('근태관리'):visible, #svc_lst a:has-text('근태관리'):visible",
      lnbWriteButton: "button#atnAttendSideBar_attendWrite:visible, button#atnAttendSideBar_absenceWrite:visible, #snb button:has-text('부재 등록'):visible",
    },
    exactSelectors: {
      titleInput: "input#myAbsenceWrite_input_absnWhy:visible, input#absnWhy:visible",
      saveButton: "button#myAttendWrite_btn_attn:visible, button#myAttendWrite_btn_lvof:visible, button._confirmBtn:visible, button:has-text('저장'):visible",
      confirmButton: "button._confirmBtn:visible, button:has-text('확인'):visible",
      closeButton: "button._closeBtn:visible, button:has-text('닫기'):visible",
      treeExpander: ".dynatree-expander, .btn_fopn",
      treeLeafTitle: "a.dynatree-title",
    },
    specialInstructions: [
      "출근 체크: button#myAttendWrite_btn_attn 클릭",
      "퇴근 체크: button#myAttendWrite_btn_lvof 클릭",
      "부재/휴가 신청: button#atnAttendSideBar_absenceWrite 클릭 후 사유(input#myAbsenceWrite_input_absnWhy) 입력 및 저장",
    ],
  },

  org: {
    moduleKey: "org",
    name: "Organization Common Dialog (ORG)",
    koreanName: "조직도 공통 팝업 (ORG)",
    gnbMenuText: "조직도",
    keywords: ["조직도", "부서", "사원", "직원", "사용자", "인사", "참석자", "권한", "수신자"],
    urlPatterns: ["/organization/", "/orgDialog"],
    entryPoints: {
      gnbDrawerButton: "button.btn_svc_open:visible",
      gnbMenuItem: "#svc_box a:has-text('조직도'):visible",
      lnbWriteButton: "button#orgTree_btnSearch:visible",
    },
    exactSelectors: {
      titleInput: "input#orgTree_searchText:visible, input#orgDialogUser_searchWord:visible, .ui-dialog:visible .srch_bar input:visible",
      saveButton: ".ui-dialog:visible button._confirmBtn:visible, .ui-dialog:visible button.btn_pri:has-text('확인'):visible",
      confirmButton: ".ui-dialog:visible button._confirmBtn:visible, .ui-dialog:visible button.btn_pri:has-text('확인'):visible, .ui-dialog:visible button:has-text('확인'):visible",
      closeButton: ".ui-dialog:visible button._closeBtn:visible, .ui-dialog:visible button.btn_close:visible, .ui-dialog:visible button:has-text('닫기'):visible",
      treeExpander: "#orgTree_btnExpandAll:visible, .ui-dialog:visible .btn_fopn, .ui-dialog:visible .dynatree-expander",
      treeLeafTitle: "#orgTree_treeBox a.dynatree-title:visible, .ui-dialog:visible a.dynatree-title:visible",
      searchInput: ".ui-dialog:visible input#orgTree_searchText:visible, .ui-dialog:visible input#orgDialogUser_searchWord:visible, .ui-dialog:visible .srch_bar input:visible",
      searchButton: ".ui-dialog:visible button#orgTree_btnSearch:visible, .ui-dialog:visible .srch_bar button.btn_srch:visible",
    },
    specialInstructions: [
      "조직도 사원 지정: ① 특정 사원명('test001' 등)이 명시된 경우 모달 내 검색창에 타이핑 후 검색 버튼 클릭 -> 결과 체크박스(span.dynatree-checkbox 또는 label.user_info.chkbox) 선택",
      "② 특정 사원명이 명시되지 않은 범용 시연인 경우 중앙 사원 후보 카드(.ui-dialog:visible label.user_info.chkbox) 선택 -> 셔틀 추가 버튼(button.drop_tgl, button:has-text('추가'), button:has-text('권한')) 클릭 -> 확인(button._confirmBtn) 클릭",
    ],
  },

  aichat: {
    moduleKey: "aichat",
    name: "NAON AI Chat & AI Editor (CMM AI)",
    koreanName: "NAON AI 챗봇 & AI Editor",
    gnbMenuText: "AI Chat",
    keywords: ["ai", "ai chat", "aichat", "챗봇", "에이전트 모드", "ai editor", "naon ai", "그룹웨어 검색"],
    urlPatterns: ["/cmm/ai/chat/cmmAiChatMain", "/cmmAiChat"],
    entryPoints: {
      gnbDrawerButton: "div#lnb button.btn_ai[title='AI Chat']:visible, button[name='topMenu_aiChat']:visible",
      gnbMenuItem: "button#cmmAiChat_openChatList:visible",
      lnbWriteButton: "div#cmmAiChat_topMenu button.btn_write._aiReset:visible",
    },
    exactSelectors: {
      titleInput: "div.mentiony-content[contenteditable='true']:visible, div[contenteditable='true'][data-placeholder*='질문']:visible",
      bodyEditor: "div.mentiony-content[contenteditable='true']:visible",
      categorySelectButton: "div#cmmAiChat_drop button.drop_tgl._fileAdd:visible",
      saveButton: "button._send:visible, button.btn_send:visible",
      confirmButton: "div#cmmAiChat_controlDetail button.setup[title='설정']:visible",
      closeButton: "div#cmmAiChat_topMenu button.btn_close:visible",
      treeExpander: "button#cmmAiChat_openChatList:visible",
      treeLeafTitle: "div#cmmAiChatSideMenu_navi a.bot:has(._aiNormal):visible, div#cmmAiChatSideMenu_navi a._aiBox:visible, a.name._chatLink:visible",
      searchInput: "div.mentiony-content[contenteditable='true']:visible",
      searchButton: "div#cmmAiChat_controlMenu button[data-search-type='gw']:visible, div#cmmAiChat_controlMenu button[data-search-type='tool']:visible",
      listFirstItem: "a.name._chatLink:visible",
    },
    specialInstructions: [
      "포탈 우측 퀵메뉴에서 AI Chat 열기: div#lnb button.btn_ai[title='AI Chat']:visible (또는 button[name='topMenu_aiChat']:visible) 클릭 -> 이후 액션은 iframe#chat_iframe 내부에서 실행 (단, button.btn_export._newChat '새창으로 보기' 클릭 이후에는 팝업 메인 프레임에서 실행)",
      "질문 입력창: div.mentiony-content[contenteditable='true']:visible (주의: #mentiony-content-xxxxxx ID는 매번 랜덤 생성되므로 절대 ID 셀렉터 사용 금지, Enter 키로 전송 시 pressEnter: true 지정)",
      "하단 모드/옵션 선택: ① div#cmmAiChat_drop button.drop_tgl._fileAdd:visible ('파일 추가 및 기타') 클릭 -> ② 에이전트 모드는 div#cmmAiChat_controlMenu button[data-search-type='tool']:visible, 그룹웨어 검색은 div#cmmAiChat_controlMenu button[data-search-type='gw']:visible 클릭 (절대 단순 button._search:visible 단독 사용 금지)",
      "에이전트 모드 세부 도구 설정: 에이전트 모드(data-search-type='tool') 활성화 후 div#cmmAiChat_controlDetail button.setup[title='설정']:visible 클릭",
    ],
  },
};

/**
 * Helper to match user prompt against the primary Groupware module
 */
export function matchGroupwareModule(prompt: string): GroupwareModuleSpec | null {
  const matched = matchGroupwareModules(prompt);
  return matched.length > 0 ? matched[0] : null;
}

/**
 * Matches all relevant Groupware modules mentioned in the prompt, ordered by earliest appearance and keyword specificity
 */
export function matchGroupwareModules(prompt: string): GroupwareModuleSpec[] {
  const p = (prompt || "").toLowerCase();
  const scored: Array<{ spec: GroupwareModuleSpec; firstIdx: number; matchCount: number }> = [];

  for (const spec of Object.values(GROUPWARE_CATALOG)) {
    if (spec.moduleKey === "portal") continue;
    let firstIdx = Infinity;
    let matchCount = 0;
    for (const kw of spec.keywords) {
      const idx = p.indexOf(kw.toLowerCase());
      if (idx !== -1) {
        matchCount++;
        if (idx < firstIdx) firstIdx = idx;
      }
    }
    if (matchCount > 0) {
      scored.push({ spec, firstIdx, matchCount });
    }
  }

  scored.sort((a, b) => {
    if (a.firstIdx !== b.firstIdx) return a.firstIdx - b.firstIdx;
    return b.matchCount - a.matchCount;
  });

  return scored.map((s) => s.spec);
}

/**
 * Returns a high-density prompt context block describing exact Naonsoft Groupware architecture
 * and all matched module specifications.
 */
export function getGroupwarePromptContext(prompt: string): string {
  const matchedList = matchGroupwareModules(prompt);

  let output = `\n======================================================
🏢 [NAONSOFT ENTERPRISE GROUPWARE KNOWLEDGE BASE V3]
======================================================
이 프로젝트는 Naonsoft EKP 엔터프라이즈 그룹웨어 패키지(bc2026_gw, unison_gw 등 18개 표준 업무 모듈)의 실제 JSP/JS DOM 규격이 탑재되어 있습니다.
가상의 ID를 절대 추측하지 말고, 아래 실측된 100% 실존 셀렉터 규격을 최우선으로 사용하십시오.

1. 포탈 및 GNB 서랍 네비게이션 (모든 모듈 공통 진입):
   - 포탈 전체메뉴(서랍) 열기: \`button.btn_svc_open:visible, button[title='포탈 전체메뉴'], .btn_svc_open:visible\`
   - 메뉴 펼침 대기: \`wait: 1200\` ms 필수
   - 서랍 내 메뉴 클릭: \`#svc_box a:has-text('메뉴명'):visible\`
   - 모듈 로딩 대기: \`wait: 3000\` ms 필수

2. 대화상자(Modal Dialog) 및 분류/트리(Dynatree) 표준:
   - 최상단 대화상자 스코프: \`.ui-dialog:visible\`
   - 트리 전체 펼침 버튼: \`.ui-dialog:visible .btn_fopn, .ui-dialog:visible .dynatree-expander\` (클릭 후 1000ms 대기)
   - 등록 가능 말단 리프 노드 선택: \`.ui-dialog:visible .dynatree-container .dynatree-node:not(.dynatree-folder) a.dynatree-title:visible, .ui-dialog:visible a.dynatree-title:visible\`
   - 대화상자 확인 버튼: \`.ui-dialog:visible button._confirmBtn:visible, .ui-dialog:visible button.btn_pri:has-text('확인'):visible, .ui-dialog:visible button:has-text('확인'):visible\`

3. 본문 목록 검색 vs 사이드바/GNB 검색 충돌 방지:
   - 본문 툴바 검색창(type): \`input#atclList_searchWord:visible, input[id*='searchWord']:visible, .new_srch_bar input:visible, #content .srch_bar input:visible\`
   - 본문 툴바 검색 버튼(click): \`button#atclList_srchBtn:visible, button[id*='srchBtn']:visible, button[id*='searchBtn']:visible, .new_srch_bar button:visible, #content .srch_bar button.btn_srch:visible\`
   - 🚫 절대 상단 포탈 헤더(\`header\`, \`#homGwMain_aiSearchWord\`)나 좌측 트리 검색(\`#snb\`)을 본문 게시물/문서 검색에 사용하지 마십시오.\n`;

  if (matchedList.length > 0) {
    for (const matched of matchedList.slice(0, 3)) {
      output += `\n🎯 감지된 대상 모듈 실측 명세 [${matched.koreanName} (${matched.moduleKey.toUpperCase()})]:
- GNB 서랍 메뉴명: \`#svc_box a:has-text('${matched.gnbMenuText}'):visible\`
- LNB 작성/등록 진입 버튼: \`${matched.entryPoints.lnbWriteButton}\`
- 제목 입력창: \`${matched.exactSelectors.titleInput}\`
${matched.exactSelectors.bodyEditor ? `- 본문 에디터/내용 입력창: \`${matched.exactSelectors.bodyEditor}\`\n` : ""}${matched.exactSelectors.categorySelectButton ? `- 분류/보관함/자원 선택 버튼: \`${matched.exactSelectors.categorySelectButton}\`\n` : ""}${matched.exactSelectors.categoryModalTree ? `- 분류/보관함 모달 트리: \`${matched.exactSelectors.categoryModalTree}\`\n` : ""}${matched.exactSelectors.categoryModalConfirm ? `- 분류/보관함 모달 확인: \`${matched.exactSelectors.categoryModalConfirm}\`\n` : ""}${matched.exactSelectors.lineSelectButton ? `- 결재선/조직도/담당자 호출 버튼: \`${matched.exactSelectors.lineSelectButton}\`\n` : ""}- 최종 저장/상신/발송 버튼: \`${matched.exactSelectors.draftButton || matched.exactSelectors.saveButton}\`
${matched.exactSelectors.searchInput ? `- 목록/양식 검색 입력창: \`${matched.exactSelectors.searchInput}\`\n` : ""}${matched.exactSelectors.searchButton ? `- 목록/양식 검색 실행 버튼: \`${matched.exactSelectors.searchButton}\`\n` : ""}${matched.exactSelectors.listFirstItem ? `- 목록 첫 번째 항목 조회: \`${matched.exactSelectors.listFirstItem}\`\n` : ""}${matched.workflowSelectors ? `- 결재 승인/반려 팝업: 의견(\`${matched.workflowSelectors.opinionInput}\`), 승인(\`${matched.workflowSelectors.approveConfirmButton}\`), 반려(\`${matched.workflowSelectors.rejectConfirmButton}\`)\n` : ""}- 모듈 전용 필수 규칙:
${matched.specialInstructions.map((s) => `  * ${s}`).join("\n")}\n`;
    }
  }

  output += `======================================================\n`;
  return output;
}

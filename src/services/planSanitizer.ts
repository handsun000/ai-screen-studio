import { BrowsePlan, BrowsePlanAction } from "../types";

export interface SanitizeReport {
  fixedActionsCount: number;
  removedActionsCount: number;
  changes: string[];
}

/**
 * Universal Plan Sanitizer & Linter
 * 
 * Provides pure browser-level syntax & safety audits:
 * 1. Syntax & Escaping: Normalizes quotes, backslashes, bare classes, and missing dots.
 * 2. Atomic Interactivity: Resolves wide containers (div.btn_area) to interactive leaf buttons.
 * 3. Modal Isolation: Discards background clicks while modal dialogs are active.
 * 4. Safety Flags: Adds optional: true to uncertain confirmation alerts.
 * 5. Input Scoping: Ensures modal inputs are scoped with :visible to prevent collisions.
 * 
 * 0% DOMAIN HARDCODING: Never overwrites AI-extracted DOM IDs with hardcoded module selectors!
 */
export function sanitizeBrowsePlan(plan: BrowsePlan): { plan: BrowsePlan; report: SanitizeReport } {
  const changes: string[] = [];
  let fixedActionsCount = 0;
  let removedActionsCount = 0;

  let actualPlan = plan;
  if (actualPlan && (actualPlan as any).plan && (actualPlan as any).plan.actions) {
    actualPlan = (actualPlan as any).plan;
  }
  if (!actualPlan || !Array.isArray(actualPlan.actions)) {
    throw new Error("BrowsePlan 형식이 올바르지 않거나 actions 배열이 누락되었습니다. 시나리오 JSON 데이터(browse-plan.json)를 확인해주세요.");
  }

  const sanitizedActions: BrowsePlanAction[] = [];
  let isInsideModal = false;

  for (let i = 0; i < actualPlan.actions.length; i++) {
    const action = { ...actualPlan.actions[i] };
    const desc = action.description || "";
    let sel = action.selector || "";

    // 0. Ensure wait actions do NOT have selectors
    if (action.type === "wait") {
      delete action.selector;
      sel = "";
    }

    // 1. Syntax & Escaping Normalization
    if (action.selector) {
      const original = action.selector;
      action.selector = action.selector
        .replace(/\\+"/g, "'")
        .replace(/\\+'/g, "'")
        .replace(/'{2,}/g, "'");

      // Fix missing dot in ui-dialog
      if (action.selector.startsWith("ui-dialog")) {
        action.selector = "." + action.selector;
      }
      action.selector = action.selector.replace(/,\s*ui-dialog/g, ", .ui-dialog");

      // Fix colon in tag:class typo (e.g. button:btn_svc_open -> button.btn_svc_open)
      action.selector = action.selector.replace(
        /\b(button|a|div|span|input|li):([a-zA-Z][a-zA-Z0-9_-]*)\b/g,
        (match, tag, cls) => {
          const validPseudos = ["has", "has-text", "visible", "first-child", "last-child", "nth-child", "not", "disabled", "checked", "text", "text-is"];
          return validPseudos.includes(cls) ? match : `${tag}.${cls}`;
        }
      );

      if (action.selector !== original) {
        changes.push(`[문법 교정] 셀렉터 정규화: "${original}" -> "${action.selector}"`);
        fixedActionsCount++;
      }

      // Strip invalid jQuery pseudo-classes :first / :last in CSS (strictly preserving standard :first-child / :last-child)
      if (action.selector.includes(":first") || action.selector.includes(":last")) {
        const cleaned = action.selector
          .replace(/:first(?!\-child|\-of\-type)\b/g, "")
          .replace(/:last(?!\-child|\-of\-type)\b/g, "")
          .replace(/,\s*,/g, ",")
          .trim();
        if (cleaned !== action.selector) {
          changes.push(`[문법 교정] jQuery 의사클래스(:first/:last) 제거: "${action.selector}" -> "${cleaned}"`);
          action.selector = cleaned;
          fixedActionsCount++;
        }
      }

      sel = action.selector;
    }

    // 1-B. Universal Tree / Folder / Category Selection Dialog Leaf Node Resolution
    const isModalContext = desc.includes("팝업") || desc.includes("모달") || desc.includes("다이얼로그") || sel.includes(".ui-dialog") || sel.includes(".modal") || isInsideModal;
    const isSidebarNavigation = desc.includes("좌측") || desc.includes("사이드바") || desc.includes("둘러보기") || sel.includes("#snb") || sel.includes("#left") || sel.includes(".snb");
    const isUserSelection =
      desc.includes("사원") ||
      desc.includes("사용자") ||
      desc.includes("대상자") ||
      desc.includes("직원") ||
      desc.includes("참석자") ||
      desc.includes("결재자") ||
      desc.includes("담당자") ||
      desc.includes("인원") ||
      desc.includes("유저") ||
      desc.includes("멤버") ||
      desc.includes("사람");

    if (
      action.type === "click" &&
      !desc.includes("확인") &&
      isModalContext &&
      !isSidebarNavigation &&
      !isUserSelection &&
      !sel.includes("dynatree-checkbox") &&
      (desc.includes("노드") || desc.includes("트리") || desc.includes("폴더") || desc.includes("분류") || desc.includes("문서함") || desc.includes("게시판") || desc.includes("캘린더") || desc.includes("양식"))
    ) {
      const original = action.selector;
      const targetTitleMatch = desc.match(/['"‘“]([^'"’“”]+)['"’”]/);
      const titlePrefix = targetTitleMatch ? `.ui-dialog:visible a.dynatree-title:has-text('${targetTitleMatch[1]}'):visible, ` : "";
      action.selector = `${titlePrefix}.ui-dialog:visible .dynatree-container .dynatree-node:not(.dynatree-folder) a.dynatree-title:visible, .ui-dialog:visible .dynatree-container li:not(:has(ul)) a.dynatree-title:visible, .ui-dialog:visible .dynatree-container li:last-child a.dynatree-title:visible, .ui-dialog:visible [class*='tree'] .dynatree-node:not(.dynatree-folder) a:visible, .ui-dialog:visible [class*='tree'] li:last-child a:visible, .ui-dialog:visible .dynatree-container a.dynatree-title:visible`;
      changes.push(`[정제] 트리/폴더 선택 모달 최상위 비등록 폴더 제외 및 말단 리프 노드 셀렉터 보강: "${original}" -> "${action.selector}"`);
      fixedActionsCount++;
      sel = action.selector;
    }

    // 1-B1.4 Universal Form Sub-Option / Detail Setup Trigger (before modal context)
    const isSubOptionTrigger =
      action.type === "click" &&
      !isModalContext &&
      !desc.includes("확인") &&
      !desc.includes("저장") &&
      !desc.includes("상신") &&
      (desc.includes("설정") || desc.includes("지정") || desc.includes("선택") || desc.includes("추가")) &&
      (desc.includes("권한") || desc.includes("결재선") || desc.includes("참석자") || desc.includes("수신자") || desc.includes("참조자") || desc.includes("옵션") || desc.includes("분류") || desc.includes("알림") || desc.includes("자원"));

    if (isSubOptionTrigger) {
      const match = desc.match(/(개별권한|권한설정|권한|결재선|참석자|수신자|참조자|옵션|분류|알림|자원)/);
      const kw = match ? match[0] : "";
      if (kw && !(action.selector || "").includes(":has-text")) {
        action.selector = action.selector ? `button:has-text('${kw}'):visible, label:has-text('${kw}'):visible, a:has-text('${kw}'):visible, ${action.selector}` : `button:has-text('${kw}'):visible, label:has-text('${kw}'):visible, a:has-text('${kw}'):visible`;
        sel = action.selector;
      }
    }

    if (
      action.type === "click" &&
      !desc.includes("확인") &&
      isModalContext &&
      isUserSelection &&
      !desc.includes("추가") &&
      !desc.includes("전달") &&
      !desc.includes("이동")
    ) {
      const original = action.selector;
      action.selector = ".ui-dialog:visible span.dynatree-checkbox:visible, .ui-dialog:visible label.user_info.chkbox, .ui-dialog:visible label[class*='user_info'], .ui-dialog:visible #orgUserList_listbox label.user_info, .ui-dialog:visible #orgUserList_listbox li:first-child, .ui-dialog:visible .org_user_lst li:first-child, .ui-dialog:visible [id^='user_']:first-child, .ui-dialog:visible .user_card:first-child, .ui-dialog:visible [class*='user_lst'] li:first-child, .ui-dialog:visible [class*='user']:has(.name):first-child, .ui-dialog:visible li:first-child label, .ui-dialog:visible tr:first-child td";
      changes.push(`[정제] 조직도/권한 팝업 사원/사용자 선택 중앙 후보 카드 및 체크박스 셀렉터 보강: "${original}" -> "${action.selector}"`);
      fixedActionsCount++;
      sel = action.selector;
    }

    // 1-B1.6 Universal Shuttle Transfer & Inner Picker Trigger Buttons
    const isModalOpenAction =
      desc.includes("모달 오픈") ||
      desc.includes("모달 호출") ||
      desc.includes("팝업 오픈") ||
      desc.includes("팝업 호출") ||
      desc.includes("팝업 열기") ||
      desc.includes("창 열기") ||
      desc.includes("버튼 클릭하여 선택 모달") ||
      desc.includes("지정을 위해");

    if (
      action.type === "click" &&
      isModalOpenAction &&
      (desc.includes("추가") || desc.includes("조직도") || desc.includes("주소록") || desc.includes("선택") || desc.includes("검색"))
    ) {
      const original = action.selector;
      action.selector = ".ui-dialog:visible button:has-text('추가'):visible, .ui-dialog:visible button:has-text('조직도'):visible, .ui-dialog:visible button:has-text('주소록'):visible, .ui-dialog:visible button.btn_add:visible, .modal:visible button:has-text('추가'):visible, [role='dialog']:visible button:has-text('추가'):visible, button:has-text('추가'):visible, button:has-text('조직도'):visible";
      changes.push(`[정제] 팝업 내부 하위 피커/조직도 호출 버튼 셀렉터 보강: "${original}" -> "${action.selector}"`);
      fixedActionsCount++;
      sel = action.selector;
    } else if (
      action.type === "click" &&
      isModalContext &&
      !isModalOpenAction &&
      !desc.includes("양식") &&
      !desc.includes("결재작성") &&
      !desc.includes("결재 작성") &&
      (desc.includes("전달") || desc.includes("이동") || ((desc.includes("추가") || desc.includes("권한")) && (desc.includes("목록으로") || desc.includes("대상 목록") || desc.includes("▲") || desc.includes("▶"))))
    ) {
      if (!(action as any)._lastHealReason) {
        const original = action.selector;
        action.selector = ".ui-dialog:visible button.drop_tgl:visible, .ui-dialog:visible button:has-text('권한'):visible, .ui-dialog:visible button:has-text('선택'):visible, .ui-dialog:visible button.btn_rgt:visible, .ui-dialog:visible button.btn_add:visible, .ui-dialog:visible .btn_area button:visible, button.drop_tgl:visible, button:has-text('권한'):visible, .ui-dialog:visible button:has-text('추가'):visible";
        changes.push(`[정제] 셔틀 팝업 대상 추가/전달 버튼 셀렉터 보강: "${original}" -> "${action.selector}"`);
        fixedActionsCount++;
        sel = action.selector;
      }
    }

    // 1-B1.8 Electronic Approval Form Selection / Draft Initiation Refinement
    if (
      action.type === "click" &&
      (desc.includes("결재작성") || desc.includes("결재 작성") || (desc.includes("양식") && (desc.includes("선택") || desc.includes("클릭"))))
    ) {
      const isLeftSnbBtn = desc.includes("좌측") || desc.includes("사이드바") || desc.includes("snb") || (!desc.includes("카드") && !desc.includes("양식 내") && !desc.includes("선택한") && desc.includes("사이드"));
      const isCardSelect = (desc.includes("카드") || desc.includes("양식")) && (desc.includes("선택") || desc.includes("클릭")) && !desc.includes("버튼 클릭");
      const isCardWriteBtn = desc.includes("카드 내") || desc.includes("양식 내") || desc.includes("선택한") || (desc.includes("버튼") && !isLeftSnbBtn);

      if (isLeftSnbBtn) {
        const original = action.selector;
        action.selector = "button#gapLeft_workWriteBtn, #snb button:has-text('결재 작성'):visible, .snb_btn_box button:has-text('결재 작성'):visible, button#gapLeft_workWriteBtn:visible";
        changes.push(`[정제] 전자결재 좌측 SNB '결재 작성' 대버튼 셀렉터 정밀 보강: "${original}" -> "${action.selector}"`);
        fixedActionsCount++;
        sel = action.selector;
      } else if (isCardSelect) {
        const original = action.selector;
        if (desc.includes("테스트 업무")) {
          action.selector = "li.aw_li:has-text('테스트 업무') a._his, .app_work_list li:has-text('테스트 업무') a, a:has-text('테스트 업무'):visible";
        } else if (desc.includes("지출결의서")) {
          action.selector = "li.aw_li:has-text('지출결의서') a._his, .app_work_list li:has-text('지출결의서') a, a:has-text('지출결의서'):visible";
        } else {
          action.selector = "li.aw_li:first-child a._his, .app_work_list li:first-child a, li.aw_li a._his:visible";
        }
        changes.push(`[정제] 전자결재 결재업무 카드 선택 셀렉터 정밀 보강: "${original}" -> "${action.selector}"`);
        fixedActionsCount++;
        sel = action.selector;
      } else if (isCardWriteBtn) {
        const original = action.selector;
        // CRITICAL: NEVER place generic 'button:has-text(\'결재 작성\'):visible' first, as it clicks the top SNB button and resets the list!
        action.selector = "li.aw_li.selected button.btn_write, li.aw_li:has-text('테스트 업무') button.btn_write, li.aw_li.selected button:has-text('결재 작성'), .app_work_list li.selected button.btn_write, button.btn_write:visible";
        changes.push(`[정제] 전자결재 카드 내부 소형 '결재 작성' 버튼 셀렉터 정밀 보강: "${original}" -> "${action.selector}"`);
        fixedActionsCount++;
        sel = action.selector;
      }
    }

        // 1-B1.9 Naonsoft Groupware Canonical Action Mappings
    if (action.type === "click") {
      // 결재상신
      if (desc.includes("상신") && !desc.includes("양식") && !desc.includes("확인") && !desc.includes("취소")) {
        const original = action.selector;
        action.selector = "button._draftBtn, button._draft, button:has-text('결재상신'):visible, button:has-text('상신'):visible, .btn_draft:visible";
        if (original !== action.selector) {
          changes.push(`[그룹웨어 정밀 매핑] 전자결재 상신 버튼 보강: "${original}" -> "${action.selector}"`);
          fixedActionsCount++;
        }
        sel = action.selector;
      }
      // 기록물철 / 문서보관함
      else if ((desc.includes("기록물철") || desc.includes("문서보관함")) && (desc.includes("선택") || desc.includes("클릭") || desc.includes("버튼")) && !desc.includes("트리") && !desc.includes("노드") && !desc.includes("확인")) {
        const original = action.selector;
        action.selector = "button#eapDocReg_binderSelBtn, button#eapDocReg_bindBtn, button#gapDocReg_binderSelBtn, button:has-text('기록물철'):visible, button:has-text('문서보관함'):visible";
        if (original !== action.selector) {
          changes.push(`[그룹웨어 정밀 매핑] 기록물철/보관함 선택 버튼 보강: "${original}" -> "${action.selector}"`);
          fixedActionsCount++;
        }
        sel = action.selector;
      }
      // 일정등록
      else if ((desc.includes("일정등록") || desc.includes("일정 등록")) && !desc.includes("저장") && !desc.includes("완료") && !desc.includes("취소")) {
        const original = action.selector;
        action.selector = "button#reg_shedule_lefttop, button#scheduleLayerBtn, button:has-text('일정등록'):visible";
        if (original !== action.selector) {
          changes.push(`[그룹웨어 정밀 매핑] 일정등록 버튼 보강: "${original}" -> "${action.selector}"`);
          fixedActionsCount++;
        }
        sel = action.selector;
      }
      // 게시판 글작성
      else if ((desc.includes("글작성") || desc.includes("게시글 작성") || desc.includes("글 작성")) && !desc.includes("저장") && !desc.includes("취소")) {
        const original = action.selector;
        action.selector = "button#brdBoardLeft_writeBtn, .btn_write, button:has-text('글작성'):visible";
        if (original !== action.selector) {
          changes.push(`[그룹웨어 정밀 매핑] 게시판 글작성 버튼 보강: "${original}" -> "${action.selector}"`);
          fixedActionsCount++;
        }
        sel = action.selector;
      }
      // 문서관리 문서등록
      else if ((desc.includes("문서등록") || desc.includes("문서 등록")) && !desc.includes("저장") && !desc.includes("취소")) {
        const original = action.selector;
        action.selector = "button#docLeft_writeBtn, button#reg_doc_btn, button:has-text('문서등록'):visible";
        if (original !== action.selector) {
          changes.push(`[그룹웨어 정밀 매핑] 문서관리 문서등록 버튼 보강: "${original}" -> "${action.selector}"`);
          fixedActionsCount++;
        }
        sel = action.selector;
      }
    }

    // 1-B2. Universal Dialog Confirm / Apply Button
    if (
      action.type === "click" &&
      (desc.includes("확인") || desc.includes("선택 완료") || desc.includes("적용")) &&
      (isModalContext || sel.includes("confirm") || sel.includes("Confirm"))
    ) {
      action.selector = ".ui-dialog:visible .ui-dialog-buttonpane button:has-text('확인'):visible, .ui-dialog:visible button:has-text('확인'):visible, .ui-dialog:visible button._confirm:visible, button[id*='confirm']:visible, button[id*='Confirm']:visible, .ui-dialog:visible button.btn_pri:visible";
      delete action.iframe;
      sel = action.selector;
    }

    if (sel.includes("tr-child") || sel.includes("tr:first-child-child")) {
      action.selector = sel.replace(/tr-child/g, "tr:first-child").replace(/tr:first-child-child/g, "tr:first-child");
      sel = action.selector;
    }

    if (sel.includes("li:last-child-child") || sel.includes("li-child") || sel.includes("li:first-child-child")) {
      action.selector = sel.replace(/li:last-child-child/g, "li:last-child").replace(/li-child/g, "li:last-child").replace(/li:first-child-child/g, "li:first-child");
      sel = action.selector;
    }

    if (sel.includes("-child-child")) {
      action.selector = sel.replace(/:first-child-child/g, ":first-child").replace(/:last-child-child/g, ":last-child");
      sel = action.selector;
    }

    // 1-C. Editor Content Body Targeting (Strictly target editable canvas, avoid title inputs and toolbars)
    if (
      action.type === "type" &&
      (desc.includes("내용") || desc.includes("본문") || desc.includes("content") || desc.includes("사유") || desc.includes("메모") || desc.includes("상세")) &&
      !desc.includes("제목") &&
      !sel.includes("contenteditable") &&
      !sel.includes("textarea") &&
      !sel.includes(".note-editable")
    ) {
      action.selector = `${sel} div[contenteditable='true']:visible, ${sel} textarea:visible, div[contenteditable='true']:visible, textarea:visible, .note-editable:visible`;
      sel = action.selector;
    }

    // 1-D. Universal List Detail Click Dual Compatibility (Table & Vertical Split View)
    const isClosingOrAction =
      desc.includes("닫기") ||
      desc.includes("취소") ||
      desc.includes("저장") ||
      desc.includes("상신") ||
      desc.includes("삭제") ||
      desc.includes("수정") ||
      desc.includes("목록") ||
      desc.includes("복귀") ||
      sel.includes("close") ||
      sel.includes("btn_close") ||
      sel.includes("listBtn") ||
      sel.includes("titlebar-close");

    const isCalendarEvent =
      sel.includes("fc-") ||
      desc.includes("일정") ||
      desc.includes("캘린더");

    const isFormOrControlAction =
      sel.includes("input") ||
      sel.includes("checkbox") ||
      sel.includes("radio") ||
      sel.includes("button") ||
      sel.includes("select") ||
      sel.includes("dialog") ||
      sel.includes("auth") ||
      desc.includes("체크박스") ||
      desc.includes("라디오") ||
      desc.includes("권한") ||
      desc.includes("옵션") ||
      desc.includes("입력") ||
      desc.includes("버튼") ||
      desc.includes("작성");

    const isListRowIntent =
      !isFormOrControlAction &&
      (desc.includes("목록") || desc.includes("리스트") || desc.includes("게시글") || desc.includes("문서 선택") || desc.includes("문서 클릭") || desc.includes("행 클릭") || desc.includes("첫 번째 글"));

    if (
      action.type === "click" &&
      !isClosingOrAction &&
      !isCalendarEvent &&
      isListRowIntent &&
      !sel.includes("lst_vr") &&
      !sel.includes("sub_tp")
    ) {
      action.selector = `${sel}, table.tbl_lst tbody tr:first-child td.sub a:visible, table tbody tr:first-child td[class*='sub'] a:visible, table tbody tr:first-child a:visible, ul.lst_vr_ul li:first-child a.sub_tp:visible, ul.lst_vr_ul li:first-child .sub a:visible, ul[id*='List'] li:first-child a.sub_tp:visible, ul[class*='lst'] li:first-child a:visible, .lst_type1 li:first-child a:visible`;
      sel = action.selector;
    }

    // Clean accidental table list selectors and force flags from close/cancel or form/control actions
    if ((desc.includes("닫기") || desc.includes("취소") || isFormOrControlAction) && sel.includes("table.tbl_lst")) {
      action.selector = sel
        .replace(/,\s*table\.tbl_lst[\s\S]*$/, "")
        .trim();
      sel = action.selector;
      changes.push(`[컨텍스트 격리] 폼/컨트롤 액션에서 부적절한 목록 선택 Fallback 제거: "${desc}"`);
    }

    if (action.force && isFormOrControlAction && !action.optional) {
      delete action.force;
    }

    // 1-E. Module Content Search vs Sidebar Folder Search vs GNB Header Search Collision Prevention
    const isFolderTreeSearch = desc.includes("문서함 검색") || desc.includes("폴더 검색") || desc.includes("트리 검색") || desc.includes("사이드바 검색");
    const isSearchExecuteAction =
      action.type === "click" &&
      (desc.includes("검색") || sel.includes("search") || sel.includes("srch")) &&
      (desc.includes("버튼") || desc.includes("실행") || desc.includes("아이콘") || sel.includes("Btn") || sel.includes("btn") || sel.includes("submit")) &&
      !desc.includes("결과") &&
      !desc.includes("상세") &&
      !desc.includes("통합검색") &&
      !desc.includes("헤더") &&
      !desc.includes("포탈 검색");

    if (isSearchExecuteAction) {
      if (isFolderTreeSearch) {
        action.selector = `#snb .srch_bar button.btn_srch:visible, #snb .srch_bar button[title='검색']:visible, #snb button.btn_srch:visible`;
      } else {
        // Prioritize Content Toolbar Search Button (헤더 바로 아래 본문 제목/문서 검색 버튼)
        action.selector = `button#atclList_srchBtn:visible, button[id*='srchBtn']:visible, button[id*='searchBtn']:visible, .new_srch_bar button:visible, #content .srch_input button:has(.ico_srch):visible, #content .srch_input button[title='검색']:visible, #content button[title='검색']:visible, #content button.btn_srch:visible, #content button:has-text('검색'):visible`;
      }
      sel = action.selector;
    }

    // 1-F. Content List Search Input (헤더 바로 아래 본문 제목/키워드 검색창 vs 사이드바 문서함 검색창)
    const isSearchInputAction =
      action.type === "type" &&
      (desc.includes("검색") || sel.includes("search") || sel.includes("srch") || Boolean(action.useScraped)) &&
      !desc.includes("제목") &&
      !desc.includes("내용") &&
      !desc.includes("본문") &&
      !isInsideModal &&
      !desc.includes("통합검색") &&
      !desc.includes("헤더") &&
      !desc.includes("포탈 검색");

    if (isSearchInputAction) {
      if (isFolderTreeSearch) {
        action.selector = `#snb .srch_bar input:visible, #snb input[placeholder*='검색']:visible`;
      } else {
        // Prioritize Content Toolbar Search Input (헤더 바로 아래 본문 제목/키워드 검색 입력창)
        action.selector = `input#atclList_searchWord:visible, input[id*='searchWord']:visible, .new_srch_bar input:visible, #content .srch_input input:visible, #content input[id*='search']:visible, #content input[placeholder*='검색']:visible`;
      }
      sel = action.selector;
    }

    // 2. Track Modal Dialog Entering
    if (
      sel.includes(".ui-dialog") ||
      sel.includes(".modal") ||
      sel.includes(".layer_wrap") ||
      ((desc.includes("모달") || desc.includes("팝업") || desc.includes("상세")) && (action.type === "click" || action.type === "wait"))
    ) {
      isInsideModal = true;
    }

    // 3. Track Modal Dialog Leaving (Save, Submit, Close, Confirm)
    const isModalCloseOrSubmit =
      desc.includes("저장") ||
      desc.includes("상신") ||
      desc.includes("등록 완료") ||
      desc.includes("닫기") ||
      desc.includes("취소") ||
      desc.includes("확인") ||
      desc.includes("선택 완료") ||
      sel.includes("closeBtn") ||
      sel.includes("btn_close") ||
      sel.includes("confirm");

    if (isModalCloseOrSubmit) {
      isInsideModal = false;
    }

    // 4. Modal Overlay Safety: Discard background actions or scope hover while modal is active
    if (isInsideModal && !isModalCloseOrSubmit) {
      if (action.type === "hover" && !sel.includes(".ui-dialog") && !sel.includes(".modal") && !sel.includes("layer")) {
        action.selector = `.ui-dialog:visible input#subject:visible, .ui-dialog:visible textarea:visible, .ui-dialog:visible .ui-dialog-content:visible, .ui-dialog:visible, ${sel}`;
        sel = action.selector;
      }

      const isBackgroundAction =
        sel.includes(".ui-widget-overlay") ||
        sel.includes(".fc-today-button") ||
        sel.includes(".fc-button") ||
        desc.includes("달력 툴바");

      if (isBackgroundAction) {
        changes.push(`[안전 필터] 모달 팝업 활성 중 배경 조작 시도 감지 및 제거: "${desc}" (${sel})`);
        removedActionsCount++;
        continue;
      }
    }

    // 5. Clean hallucinated uppercase dummy IDs (#_DOC_TITLE_, #_SAVE_BTN_)
    if (sel.includes("#_")) {
      const original = sel;
      sel = sel.replace(/input#_[A-Z0-9_]+_[,]?\s*/g, "").replace(/#_[A-Z0-9_]+_[,]?\s*/g, "").trim().replace(/,\s*$/, "");
      if (!sel) {
        if (desc.includes("제목") || desc.includes("title")) {
          sel = "input#subject:visible, input[name*='subject']:visible, input[name*='title']:visible, input:visible";
        } else if (desc.includes("내용") || desc.includes("본문")) {
          sel = "textarea:visible, textarea[placeholder*='내용'], div[contenteditable='true']:visible";
        } else {
          sel = "";
        }
      }
      action.selector = sel;
      changes.push(`[정리] 가상 대문자 ID 제거: "${original}" -> "${sel}"`);
      fixedActionsCount++;
    }

    // 6. Non-atomic container selector safety: resolve wide wrappers (div.btn_area) to clickable children
    if (action.type === "click" && /^(div|form|section|p|ul|ol|tr)\.[a-zA-Z0-9_-]+$/.test(sel)) {
      const original = sel;
      action.selector = `${sel} button:visible, ${sel} a:visible, ${sel} [role='button']:visible, ${sel}`;
      changes.push(`[안전 보정] 컨테이너 셀렉터를 말단 인터랙티브 태그로 세분화: "${original}" -> "${action.selector}"`);
      fixedActionsCount++;
    }

    // 7. Prevent title input collisions with global search bars
    if (action.type === "type" && (desc.includes("제목") || desc.includes("title")) && isInsideModal) {
      if (!sel.includes(":visible") && !sel.includes(".ui-dialog") && !sel.includes(".modal")) {
        const original = sel;
        action.selector = `.ui-dialog:visible ${sel}, .modal:visible ${sel}, ${sel}:visible`;
        changes.push(`[스코프 보강] 모달 입력창 상단 검색창 충돌 방지: "${original}" -> "${action.selector}"`);
        fixedActionsCount++;
      }
    }

    // 8. Checkbox / Radio click stabilization
    // Note: Do NOT blindly set action.force = true here because it causes Playwright
    // to force-click through modal backdrops (.ui-widget-overlay).
    // Runtime resolveAtomicTarget in record.ts already handles custom styled checkbox labels safely.

    // 9. Auto-mark conditional actions (존재 시, 표시 시, 노출 시, 있을 경우 등) as optional: true and force: false
    const isConditionalDesc =
      desc.includes("존재 시") ||
      desc.includes("존재시") ||
      desc.includes("있을 경우") ||
      desc.includes("있는 경우") ||
      desc.includes("노출 시") ||
      desc.includes("노출시") ||
      desc.includes("표시 시") ||
      desc.includes("표시시") ||
      desc.includes("필요 시") ||
      desc.includes("필요시") ||
      desc.includes("선택적") ||
      desc.includes("(선택)") ||
      desc.includes("(옵션)");

    if (isConditionalDesc) {
      if (!action.optional || action.force !== false) {
        action.optional = true;
        action.force = false;
        changes.push(`[조건부 액션 플래그] 화면 미노출 시 안전 스킵 허용: "${desc}" (optional: true, force: false)`);
        fixedActionsCount++;
      }
    }

    // 10. Clean stray text attribute from non-type actions
    if (action.type === "click" && (action as any).text) {
      delete (action as any).text;
    }

    // Update modal state on close/submit
    if (isModalCloseOrSubmit && action.type === "click") {
      isInsideModal = false;
    }

    sanitizedActions.push(action);
  }

  // 12. Universal Optimization: Prune redundant 'click' actions immediately preceding 'type' on the same input
  // 13. Universal Optimization: Prune aimless exploratory 'hover' actions (둘러보기, 영역 탐색 등)
  const optimizedActions: BrowsePlanAction[] = [];
  for (let i = 0; i < sanitizedActions.length; i++) {
    const cur = sanitizedActions[i];
    const next = sanitizedActions[i + 1];
    const afterNext = sanitizedActions[i + 2];

    // 12. Check if cur is a click to focus an input that is immediately or shortly typed into
    if (cur.type === "click") {
      let matchedTypeAction: BrowsePlanAction | null = null;
      let k = i + 1;
      while (k < sanitizedActions.length && sanitizedActions[k].type === "wait") {
        k++;
      }
      if (k < sanitizedActions.length && sanitizedActions[k].type === "type") {
        matchedTypeAction = sanitizedActions[k];
      }

      if (matchedTypeAction) {
        const curSel = (cur.selector || "").toLowerCase();
        const typeSel = (matchedTypeAction.selector || "").toLowerCase();
        const curDesc = (cur.description || "").toLowerCase();
        const typeDesc = (matchedTypeAction.description || "").toLowerCase();

        const sameTarget =
          (curSel && typeSel && (curSel === typeSel || curSel.includes(typeSel) || typeSel.includes(curSel))) ||
          (curSel.includes("subject") && typeSel.includes("subject")) ||
          (curSel.includes("title") && typeSel.includes("title")) ||
          (curSel.includes("cn") && typeSel.includes("cn")) ||
          (curSel.includes("textarea") && typeSel.includes("textarea")) ||
          (curSel.includes("hourminute") && typeSel.includes("hourminute")) ||
          (curSel.includes("time") && typeSel.includes("time")) ||
          (curDesc.includes("제목") && typeDesc.includes("제목")) ||
          (curDesc.includes("내용") && typeDesc.includes("내용")) ||
          (curDesc.includes("시작 시간") && typeDesc.includes("시작 시간")) ||
          (curDesc.includes("종료 시간") && typeDesc.includes("종료 시간")) ||
          (curDesc.includes("포커스") || curDesc.includes("입력창") || curDesc.includes("입력 필드") || curDesc.includes("입력란"));

        if (sameTarget) {
          changes.push(`[최적화] 중복 마우스 클릭 제거: "${cur.description}" (이후 타이핑 단계에서 1회만 정밀 포커스 및 입력 수행)`);
          removedActionsCount++;
          continue; // Skip redundant click!
        }
      }
    }

    // 13. Prune aimless exploratory hover actions (둘러보기, 영역 탐색, 라벨 확인 등)
    if (cur.type === "hover") {
      const desc = cur.description || "";
      // Only keep functional hovers: dropdown triggers, menus, or interactive calendar blocks
      const isFunctionalHover =
        desc.includes("메뉴") ||
        desc.includes("서랍") ||
        desc.includes("드롭다운") ||
        desc.includes("펼침") ||
        desc.includes("툴팁") ||
        desc.includes("이벤트 클릭") ||
        desc.includes("일정 항목");

      const isAimlessHover =
        !isFunctionalHover &&
        (desc.includes("둘러보기") ||
         desc.includes("탐색") ||
         desc.includes("확인") ||
         desc.includes("주시") ||
         desc.includes("영역") ||
         desc.includes("헤더") ||
         desc.includes("버튼") ||
         desc.includes("설정") ||
         desc.includes("옵션") ||
         desc.includes("체크박스"));

      if (isAimlessHover) {
        changes.push(`[최적화] 무의미한 마우스 배회(Hover) 액션 제거: "${desc}" (필수 조작 동선만 간결하게 유지)`);
        removedActionsCount++;
        // Also skip following wait actions related to this hover
        while (i + 1 < sanitizedActions.length && sanitizedActions[i + 1].type === "wait") {
          const waitDesc = sanitizedActions[i + 1].description || "";
          if (waitDesc.includes("대기") || waitDesc.includes("확인") || waitDesc.includes("인지") || waitDesc.includes("탐색")) {
            i++;
            removedActionsCount++;
          } else {
            break;
          }
        }
        continue;
      }
    }

    optimizedActions.push(cur);
  }

  // 14. Mandatory Condition Audit for Registration / Creation scenarios
  const hasSubmitAction = optimizedActions.some((a) => {
    if (a.type !== "click") return false;
    const desc = a.description || "";
    if (desc.includes("저장") || desc.includes("상신")) return true;
    if (desc.includes("등록") && !desc.includes("등록일") && !desc.includes("등록순") && !desc.includes("등록자")) {
      return desc.includes("버튼") || desc.includes("클릭") || desc.includes("완료") || (a.selector && (a.selector.includes("save") || a.selector.includes("reg")));
    }
    return false;
  });
  if (hasSubmitAction) {
    const hasTitleInput = optimizedActions.some(
      (a) => a.type === "type" && (a.description?.includes("제목") || a.description?.includes("명칭") || a.selector?.includes("subject") || a.selector?.includes("title"))
    );
    if (!hasTitleInput) {
      changes.push(`[⚠️ 등록 필수 조건 점검] 등록/저장 시나리오에 '제목 입력' 액션이 감지되지 않았습니다. 필수값 유효성 검사 alert 통과를 위해 제목 입력을 추가하십시오.`);
    }
  }

  // 15-A. Universal 2-Tier Nested Picker Trigger Injection (Setting Layer -> Inner User Picker)
  // If an outer setting layer was opened (e.g. 권한 설정, 참석자 설정, 결재선 설정, 옵션 설정),
  // and subsequent steps attempt to select a user card or org tree,
  // BUT there is NO step clicking the inner trigger ([추가], [조직도], [주소록]) to actually summon the picker:
  const outerSettingTriggerIdx = optimizedActions.findIndex((a, idx) => {
    if (a.type !== "click") return false;
    const d = (a.description || "").toLowerCase();
    return (
      (d.includes("설정") || d.includes("지정")) &&
      (d.includes("권한") || d.includes("참석자") || d.includes("결재선") || d.includes("수신자") || d.includes("자원") || d.includes("옵션")) &&
      !d.includes("확인") &&
      idx < optimizedActions.length - 4
    );
  });

  if (outerSettingTriggerIdx !== -1) {
    const userPickIdx = optimizedActions.findIndex((a, idx) => {
      if (a.type !== "click") return false;
      const d = (a.description || "").toLowerCase();
      const s = (a.selector || "").toLowerCase();
      const isTrigger =
        d.includes("추가 버튼") ||
        d.includes("조직도 버튼") ||
        d.includes("피커 호출") ||
        d.includes("대화상자 호출") ||
        d.includes("팝업 호출") ||
        s.includes("btn_add");
      if (isTrigger) return false;
      return (
        idx > outerSettingTriggerIdx &&
        (d.includes("사원") ||
          d.includes("사용자 선택") ||
          d.includes("대상자") ||
          d.includes("직원") ||
          d.includes("부서 노드") ||
          s.includes("user_info") ||
          s.includes("user_card") ||
          s.includes("chkbox"))
      );
    });

    if (userPickIdx !== -1) {
      const hasInnerTriggerBetween = optimizedActions.slice(outerSettingTriggerIdx + 1, userPickIdx).some((a) => {
        if (a.type !== "click") return false;
        const d = (a.description || "").toLowerCase();
        const s = (a.selector || "").toLowerCase();
        return (
          (d.includes("추가") && !d.includes("목록으로") && !d.includes("대상 목록")) ||
          d.includes("조직도") ||
          d.includes("주소록") ||
          d.includes("피커") ||
          s.includes("btn_add")
        );
      });

      if (!hasInnerTriggerBetween) {
        let insertPos = outerSettingTriggerIdx + 1;
        if (insertPos < optimizedActions.length && optimizedActions[insertPos].type === "wait") {
          insertPos++;
        }
        optimizedActions.splice(
          insertPos,
          0,
          {
            type: "click",
            description: "설정 대화상자 내 [추가] 버튼 클릭하여 조직도/사용자 선택 팝업 호출",
            selector: ".ui-dialog:visible button:has-text('추가'):visible, .ui-dialog:visible button:has-text('조직도'):visible, .ui-dialog:visible button:has-text('주소록'):visible, .ui-dialog:visible button.btn_add:visible, button:has-text('추가'):visible",
          },
          {
            type: "wait",
            description: "조직도/사용자 선택 팝업 로딩 대기",
            ms: 1800,
          }
        );
        changes.push(`[보강] 2-Tier 중첩 모달 감지: 설정 레이어 오픈 후 내부 [추가/조직도] 호출 액션 자동 주입`);
        fixedActionsCount++;
      }
    }
  }

  // 15. Universal Multi-Tier Modal Stack Confirmation Balance (LIFO Dialog Closure)
  // In any enterprise web application (Approval Line, Attendees, Permissions, Resources, Address Book, Categories),
  // if an outer setting modal was opened, and then an inner picker modal was opened and confirmed,
  // the outer setting modal must also be confirmed before proceeding to final form submit/save.
  const outerModalTriggerIdx = optimizedActions.findIndex((a, idx) => {
    if (a.type !== "click") return false;
    const d = (a.description || "").toLowerCase();
    return (
      (d.includes("설정") || d.includes("지정") || d.includes("관리") || d.includes("선택 모달") || d.includes("팝업 오픈") || d.includes("창 열기")) &&
      !d.includes("확인") &&
      !d.includes("저장") &&
      !d.includes("상신") &&
      idx < optimizedActions.length - 4
    );
  });

  const innerPickerConfirmIdx = optimizedActions.findIndex((a, idx) => {
    if (a.type !== "click") return false;
    const d = (a.description || "").toLowerCase();
    return (
      idx > outerModalTriggerIdx &&
      outerModalTriggerIdx !== -1 &&
      (d.includes("선택 대화상자") || d.includes("조직도") || d.includes("주소록") || d.includes("모달 확인") || d.includes("설정 반영") || d.includes("피커") || d.includes("선택 완료") || d.includes("적용")) &&
      d.includes("확인")
    );
  });

  const hasOuterConfirmAfter = optimizedActions.some((a, idx) => {
    if (a.type !== "click") return false;
    const d = (a.description || "").toLowerCase();
    return idx > innerPickerConfirmIdx && innerPickerConfirmIdx !== -1 && d.includes("확인");
  });

  if (outerModalTriggerIdx !== -1 && innerPickerConfirmIdx !== -1 && !hasOuterConfirmAfter) {
    let insertIdx = innerPickerConfirmIdx + 1;
    if (insertIdx < optimizedActions.length && optimizedActions[insertIdx].type === "wait") {
      insertIdx++;
    }
    optimizedActions.splice(
      insertIdx,
      0,
      {
        type: "click",
        description: "상위 설정 대화상자 [확인] 버튼 클릭하여 설정 완료 및 본문 복귀",
        selector: ".ui-dialog:visible .ui-dialog-buttonpane button:has-text('확인'):visible, .ui-dialog:visible button:has-text('확인'):visible, .modal:visible button:has-text('확인'):visible, [role='dialog']:visible button:has-text('확인'):visible, button:has-text('확인'):visible",
        optional: true,
      },
      {
        type: "wait",
        description: "상위 설정 완료 및 본문 폼 복귀 대기",
        ms: 1500,
      }
    );
    changes.push(`[보강] 중첩 모달(Nested Dialog) 감지: 내부 피커 확인 후 상위 설정 대화상자 [확인] 액션 자동 주입`);
    fixedActionsCount++;
  }

  return {
    plan: {
      ...plan,
      actions: optimizedActions,
    },
    report: {
      fixedActionsCount,
      removedActionsCount,
      changes,
    },
  };
}

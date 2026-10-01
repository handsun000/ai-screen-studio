import { BrowsePlan, BrowsePlanAction } from "../types";

export interface SanitizeReport {
  fixedActionsCount: number;
  removedActionsCount: number;
  changes: string[];
}

/**
 * Intelligent Plan Sanitizer & Linter
 * 
 * Automatically audits AI-generated BrowsePlans to eliminate:
 * 1. Modal-Background Collisions (e.g. attempting to click .fc-today-button while a dialog is open)
 * 2. Ambiguous Search-Bar Collisions (e.g. input[placeholder*="제목"] matching header search instead of modal title)
 * 3. Fragile Unscoped Selectors inside Dialogs
 * 4. Dangerous Disabled Button Clicks
 */
export function sanitizeBrowsePlan(plan: BrowsePlan): { plan: BrowsePlan; report: SanitizeReport } {
  const changes: string[] = [];
  let fixedActionsCount = 0;
  let removedActionsCount = 0;

  const sanitizedActions: BrowsePlanAction[] = [];
  let isInsideModal = false;

  for (let i = 0; i < plan.actions.length; i++) {
    const action = { ...plan.actions[i] };
    const desc = action.description || "";
    let sel = action.selector || "";

    // Normalize excessive backslashes and corrupted quotes (e.g. \\\\\\\" -> ')
    if (action.selector) {
      const original = action.selector;
      action.selector = action.selector
        .replace(/\\+"/g, "'")
        .replace(/\\+'/g, "'")
        .replace(/'{2,}/g, "'");
      if (action.selector.startsWith("ui-dialog")) {
        action.selector = "." + action.selector;
      }
      action.selector = action.selector.replace(/,\s*ui-dialog/g, ", .ui-dialog");
      if (action.selector !== original) {
        changes.push(`[보정] 셀렉터 따옴표/이스케이프 정규화: "${original}" -> "${action.selector}"`);
        fixedActionsCount++;
      }
      sel = action.selector;
    }

    // 1. Detect entering modal / dialog phase
    if (
      (desc.includes("등록") && (desc.includes("팝업") || desc.includes("레이어") || desc.includes("화면"))) ||
      sel.includes("reg_shedule_lefttop") || sel.includes("btn_write") || sel.includes("ui-dialog")
    ) {
      if (action.type === "click" || action.type === "wait") {
        isInsideModal = true;
      }
    }

    // 3.5 Sanitize schedule registration button (left blue button #reg_shedule_lefttop)
    if (
      action.type === "click" &&
      (desc.includes("일정 등록") || desc.includes("일정등록") || desc.includes("일정 작성"))
    ) {
      action.selector = "button#reg_shedule_lefttop, #reg_shedule_lefttop, button:has-text('일정 등록'):visible, button:has-text('일정등록'):visible";
      changes.push(`[보정] 좌측 상단 일정 등록 버튼 전용 ID 적용: "${action.selector}"`);
      fixedActionsCount++;
    }

    // 2. Detect leaving modal phase (save or close)
    const isSaveOrClose =
      desc.includes("저장") || desc.includes("상신") || desc.includes("등록 완료") || desc.includes("닫기") ||
      sel.includes("savebtn") || sel.includes("btn_save") || sel.includes("closeBtn");

    // 3. Filter out dangerous background actions while modal is open
    // e.g. clicking calendar background toolbar (.fc-today-button, .fc-prev-button, etc.)
    if (isInsideModal && !isSaveOrClose) {
      const isBackgroundCalendarAction =
        sel.includes(".fc-today-button") ||
        sel.includes(".fc-button") ||
        sel.includes(".scd_cal_today") ||
        desc.includes("달력 툴바") ||
        desc.includes("오늘 날짜 선택");

      if (isBackgroundCalendarAction) {
        changes.push(`[제거] 모달 팝업이 열려 있는 상태에서 배경 달력 조작 시도 감지 및 제거: "${desc}" (${sel})`);
        removedActionsCount++;
        continue; // Discard this dangerous action!
      }
    }

    // 0. Clean hallucinated uppercase dummy IDs (e.g. #_USE_RESOURCE_, #_SAVE_BTN_)
    if (sel.includes("#_")) {
      const original = sel;
      sel = sel.replace(/#_[A-Z0-9_]+_[,]?\s*/g, "").trim().replace(/,\s*$/, "");
      action.selector = sel;
      changes.push(`[정리] AI 환각 대문자 가상 ID 제거: "${original}" -> "${sel}"`);
      fixedActionsCount++;
    }

    // 4. Sanitize title / subject input selector collisions
    if (action.type === "type" && (desc.includes("제목") || sel.includes("subject") || sel.includes("title"))) {
      if (sel.includes('placeholder*="제목"') || sel.includes("_SUBJECT_") || sel === "input#subject" || !sel.includes(":visible")) {
        const original = action.selector;
        action.selector = "#reg_schedule_form #subject, .ui-dialog:visible #subject, input#subject:visible, input[name*='subject']:visible";
        changes.push(`[보정] 제목 입력 셀렉터 상단 검색창 충돌 방지 및 모달 스코프 강화: "${original}" -> "${action.selector}"`);
        fixedActionsCount++;
      }
    }

    // 5. Sanitize content / body textarea
    if (action.type === "type" && (desc.includes("내용") || desc.includes("본문") || sel.includes("content") || sel.includes("cn"))) {
      if (!sel.includes("textarea:visible") && !sel.includes("#cn")) {
        const original = action.selector;
        action.selector = "textarea:visible, textarea[placeholder*='내용'], #reg_schedule_form #cn, .ui-dialog:visible #cn, div[contenteditable='true']:visible";
        changes.push(`[보정] 본문/내용 입력 셀렉터 모달 다이얼로그 스코프 보강: "${original}" -> "${action.selector}"`);
        fixedActionsCount++;
      }
    }

    // 6. Sanitize checkbox / radio clicks (prioritize visible <label> and force click)
    if (
      action.type === "click" &&
      (desc.includes("체크") || desc.includes("예약사용") || sel.includes("chk") || sel.includes("checkbox") || sel.includes("resource"))
    ) {
      action.force = true;
      if (desc.includes("예약") || desc.includes("자원") || sel.includes("resource") || sel.includes("res")) {
        action.selector = "label:has-text('예약사용'), text='예약사용', label:has-text('예약 사용'), label[for='scd_link_res_chk'], #reg_schedule_form #scd_link_res_chk, input#scd_link_res_chk";
        changes.push(`[보정] 자원예약 사용 체크박스 레이블 우선 셀렉터 적용: "${action.selector}"`);
        fixedActionsCount++;
      } else if (!sel.includes("label:has-text") && !sel.includes("label:has")) {
        const original = action.selector;
        const match = desc.match(/'([^']+)'/) || desc.match(/"([^"]+)"/);
        const labelText = match ? match[1] : "";
        if (labelText) {
          action.selector = `label:has-text('${labelText}'), text='${labelText}', label:has(${original}), ${original}`;
        } else {
          action.selector = `label:has(${original}), ${original}`;
        }
        changes.push(`[보정] 숨겨진 체크박스 클릭 안정화 (label 우선 및 force): "${original}" -> "${action.selector}"`);
        fixedActionsCount++;
      }
    }

    // 7. Sanitize resource modal open button (+)
    if (
      action.type === "click" &&
      (desc.includes("자원") || desc.includes("예약")) &&
      (desc.includes("열기") || desc.includes("모달") || desc.includes("팝업") || desc.includes("선택") || desc.includes("추가") || desc.includes("버튼"))
    ) {
      if (!desc.includes("체크") && !desc.includes("확인") && !desc.includes("저장")) {
        action.selector = "button#scd_link_res_select_button, #scd_link_res_select button, button:has(.ico_plus), button:has-text('자원예약'), button:has-text('예약 선택'), button[title*='추가']";
        action.optional = true;
        changes.push(`[보정] 자원예약 팝업 호출 버튼(+) 셀렉터 보강: "${action.selector}"`);
        fixedActionsCount++;
      }
    }

    // 8. Sanitize facility / room category tab click in modal
    if (
      action.type === "click" &&
      (desc.includes("시설") || desc.includes("회의실")) &&
      (desc.includes("탭") || desc.includes("카테고리") || desc.includes("폴더"))
    ) {
      action.selector = ".ui-dialog:visible a:has-text('시설'), .ui-dialog:visible a:has-text('회의실'), #resSelect_resSelect a:has-text('시설'), a:has-text('시설'):visible";
      changes.push(`[보정] 자원 모달 시설 탭 셀렉터 보강: "${action.selector}"`);
      fixedActionsCount++;
    }

    // 9. Sanitize first item selection in facility list
    if (
      action.type === "click" &&
      (desc.includes("첫 번째") || desc.includes("첫번째") || desc.includes("목록 항목") || (desc.includes("시설") && desc.includes("선택")))
    ) {
      if (!desc.includes("탭") && !desc.includes("카테고리") && !desc.includes("버튼")) {
        action.selector = ":text('3층 회의실'), div:has-text('3층 회의실'):visible, li:has-text('3층 회의실'), .ui-dialog:visible div[class*='lst'] > *:first-child, .ui-dialog:visible ul > li:first-child, .ui-dialog:visible table tr:first-child";
        changes.push(`[보정] 시설 목록 첫 번째 항목(3층 회의실) 선택 셀렉터 보강: "${action.selector}"`);
        fixedActionsCount++;
      }
    }

    // 10. Sanitize modal confirmation buttons
    if (action.type === "click" && desc.includes("확인") && (desc.includes("모달") || desc.includes("팝업") || desc.includes("자원"))) {
      action.selector = "button#link_res_confirm, .ui-dialog:visible button#link_res_confirm, .ui-dialog:visible button:has-text('확인'), button:has-text('확인'):visible";
      action.optional = true;
      changes.push(`[보정] 자원예약 모달 확인 버튼 셀렉터 보강: "${action.selector}"`);
      fixedActionsCount++;
    }

    // 11. Sanitize save / submit button selector
    if (action.type === "click" && (desc.includes("저장") || desc.includes("등록") || desc.includes("상신"))) {
      if (!desc.includes("일정 등록 버튼") && !desc.includes("일정등록 버튼")) {
        action.selector = "#reg_schedule_form #savebtn, .ui-dialog:visible #savebtn, button#savebtn:visible, button:has-text('저장'):visible, button:has-text('등록'):visible";
        changes.push(`[보정] 저장 버튼 셀렉터 모달 다이얼로그 스코프 보강: "${action.selector}"`);
        fixedActionsCount++;
      }
    }

    // 12. Ensure optional confirmation popups have safe optional flags
    if (desc.includes("확인") && (desc.includes("팝업") || desc.includes("안내") || desc.includes("알림창") || desc.includes("표시 시"))) {
      if (!action.optional) {
        action.optional = true;
        changes.push(`[안전 강화] 완료 확인 팝업 단계에 optional: true 부여: "${desc}"`);
        fixedActionsCount++;
      }
    }

    // Clean stray text attribute from non-type actions
    if (action.type === "click" && (action as any).text) {
      delete (action as any).text;
    }

    // Update modal state when saved/closed
    if (isSaveOrClose && action.type === "click") {
      isInsideModal = false;
    }

    sanitizedActions.push(action);
  }

  const sanitizedPlan: BrowsePlan = {
    ...plan,
    actions: sanitizedActions,
  };

  return {
    plan: sanitizedPlan,
    report: {
      fixedActionsCount,
      removedActionsCount,
      changes,
    },
  };
}

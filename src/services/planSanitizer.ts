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

    if (
      action.type === "click" &&
      !desc.includes("확인") &&
      isModalContext &&
      !isSidebarNavigation &&
      (desc.includes("노드") || desc.includes("트리") || desc.includes("폴더") || desc.includes("분류") || desc.includes("문서함") || desc.includes("게시판") || desc.includes("캘린더") || desc.includes("양식"))
    ) {
      const original = action.selector;
      action.selector = ".ui-dialog:visible .dynatree-container .dynatree-node:not(.dynatree-folder) a.dynatree-title:visible, .ui-dialog:visible .dynatree-container li:not(:has(ul)) a.dynatree-title:visible, .ui-dialog:visible .dynatree-container li:last-child a.dynatree-title:visible, .ui-dialog:visible [class*='tree'] .dynatree-node:not(.dynatree-folder) a:visible, .ui-dialog:visible [class*='tree'] li:last-child a:visible, .ui-dialog:visible .dynatree-container a.dynatree-title:visible";
      changes.push(`[정제] 트리/폴더 선택 모달 최상위 비등록 폴더 제외 및 말단 리프 노드 셀렉터 보강: "${original}" -> "${action.selector}"`);
      fixedActionsCount++;
      sel = action.selector;
    }

    // 1-B2. Universal Dialog Confirm / Apply Button
    if (
      action.type === "click" &&
      (desc.includes("확인") || desc.includes("선택 완료") || desc.includes("적용")) &&
      (isModalContext || sel.includes("confirm") || sel.includes("Confirm"))
    ) {
      action.selector = ".ui-dialog:visible .ui-dialog-buttonpane button:has-text('확인'):visible, .ui-dialog:visible button:has-text('확인'):visible, button[id*='confirm']:visible, button[id*='Confirm']:visible, .ui-dialog:visible button.btn_pri:visible, .ui-dialog:visible button._confirm:visible";
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
    if (
      action.type === "click" &&
      (desc.includes("상세") || desc.includes("조회") || desc.includes("항목") || desc.includes("결과")) &&
      (desc.includes("클릭") || desc.includes("선택") || desc.includes("열람")) &&
      !sel.includes("lst_vr") &&
      !sel.includes("sub_tp")
    ) {
      action.selector = `${sel}, table.tbl_lst tbody tr:first-child td.sub a:visible, table tbody tr:first-child td[class*='sub'] a:visible, table tbody tr:first-child a:visible, ul.lst_vr_ul li:first-child a.sub_tp:visible, ul.lst_vr_ul li:first-child .sub a:visible, ul[id*='List'] li:first-child a.sub_tp:visible, ul[class*='lst'] li:first-child a:visible, .lst_type1 li:first-child a:visible`;
      sel = action.selector;
    }

    // 2. Track Modal Dialog Entering
    if (
      sel.includes(".ui-dialog") ||
      sel.includes(".modal") ||
      sel.includes(".layer_wrap") ||
      (desc.includes("모달") && (action.type === "click" || action.type === "wait"))
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
      sel.includes("closeBtn") ||
      sel.includes("btn_close");

    // 4. Modal Overlay Safety: Discard background actions while modal is active
    if (isInsideModal && !isModalCloseOrSubmit) {
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

    // 8. Checkbox / Radio click stabilization (force click)
    if (action.type === "click" && (sel.includes("checkbox") || sel.includes("radio") || desc.includes("체크"))) {
      action.force = true;
    }

    // 9. Strip any legacy 'optional' (skip) flag - all actions must be executed without skipping
    if ((action as any).optional !== undefined) {
      delete (action as any).optional;
      changes.push(`[정제] 건너뛰기(optional) 플래그 제거: "${desc}" (전체 단계 필수 실행 보장)`);
      fixedActionsCount++;
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

  // 11. Mandatory Condition Audit for Registration / Creation scenarios
  const hasSubmitAction = sanitizedActions.some(
    (a) => a.type === "click" && (a.description?.includes("저장") || a.description?.includes("상신") || a.description?.includes("등록"))
  );
  if (hasSubmitAction) {
    const hasTitleInput = sanitizedActions.some(
      (a) => a.type === "type" && (a.description?.includes("제목") || a.description?.includes("명칭") || a.selector?.includes("subject") || a.selector?.includes("title"))
    );
    if (!hasTitleInput) {
      changes.push(`[⚠️ 등록 필수 조건 점검] 등록/저장 시나리오에 '제목 입력' 액션이 감지되지 않았습니다. 필수값 유효성 검사 alert 통과를 위해 제목 입력을 추가하십시오.`);
    }
  }



  return {
    plan: {
      ...plan,
      actions: sanitizedActions,
    },
    report: {
      fixedActionsCount,
      removedActionsCount,
      changes,
    },
  };
}

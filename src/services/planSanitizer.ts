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

  const sanitizedActions: BrowsePlanAction[] = [];
  let isInsideModal = false;

  for (let i = 0; i < plan.actions.length; i++) {
    const action = { ...plan.actions[i] };
    const desc = action.description || "";
    let sel = action.selector || "";

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
          const validPseudos = ["has-text", "visible", "first-child", "last-child", "nth-child", "not", "disabled", "checked"];
          return validPseudos.includes(cls) ? match : `${tag}.${cls}`;
        }
      );

      if (action.selector !== original) {
        changes.push(`[문법 교정] 셀렉터 정규화: "${original}" -> "${action.selector}"`);
        fixedActionsCount++;
      }
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

    // 9. Optional confirmation alert handling
    if (desc.includes("확인") && (desc.includes("팝업") || desc.includes("안내") || desc.includes("알림창") || desc.includes("표시 시"))) {
      if (!action.optional) {
        action.optional = true;
        changes.push(`[안전 강화] 완료 확인 팝업 단계에 optional: true 부여: "${desc}"`);
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

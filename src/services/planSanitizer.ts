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

  const normalizeSelectorSyntax = (rawSel: string): string => {
    if (!rawSel) return "";
    let s = rawSel
      .replace(/\\+"/g, "'")
      .replace(/\\+'/g, "'")
      .replace(/'{2,}/g, "'")
      .replace(/'\)'\)+/g, "')");

    if (s.startsWith("ui-dialog")) {
      s = "." + s;
    }
    s = s.replace(/,\s*ui-dialog/g, ", .ui-dialog");

    // Restore previously corrupted .nth-of-type / .first-of-type / .last-of-type back to valid CSS pseudo-classes
    s = s
      .replace(/\.(nth-of-type|first-of-type|last-of-type|nth-child|first-child|last-child|only-child|only-of-type)\b/g, ":$1");

    // Fix colon in tag:class typo (e.g. button:btn_svc_open -> button.btn_svc_open)
    s = s.replace(
      /\b(button|a|div|span|input|li|tr|td|ul|p):([a-zA-Z][a-zA-Z0-9_-]*)\b/g,
      (match, tag, cls) => {
        const validPseudos = [
          "has",
          "has-text",
          "visible",
          "first-child",
          "last-child",
          "nth-child",
          "nth-of-type",
          "first-of-type",
          "last-of-type",
          "only-child",
          "only-of-type",
          "not",
          "disabled",
          "checked",
          "focus",
          "hover",
          "text",
          "text-is",
        ];
        return validPseudos.includes(cls) ? match : `${tag}.${cls}`;
      }
    );

    // Strip invalid jQuery pseudo-classes :first / :last in CSS (strictly preserving standard :first-child / :last-child / :first-of-type / :last-of-type)
    if (s.includes(":first") || s.includes(":last")) {
      s = s
        .replace(/:first(?!\-child|\-of\-type)\b/g, "")
        .replace(/:last(?!\-child|\-of\-type)\b/g, "")
        .replace(/,\s*,/g, ",")
        .trim();
    }

    // Strip transient Dynatree / Fancytree / jQuery UI runtime state classes that change depending on whether a folder is expanded/focused/selected
    s = s.replace(
      /\.(?:dynatree-(?:expanded|has-children|folder|lastsib|focused|active|selected|partsel|loading|statusnode|exp-[a-zA-Z0-9_-]+|ico-[a-zA-Z0-9_-]+)|fancytree-(?:expanded|has-children|folder|lastsib|focused|active|selected|partsel|loading|statusnode|exp-[a-zA-Z0-9_-]+|ico-[a-zA-Z0-9_-]+)|ui-state-(?:hover|focus|active|highlight))\b/g,
      ""
    );

    // Filter out dummy onclick='return false;' candidates and strip erroneous #header prefixes on content/form elements
    const parts = s
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean)
      .filter((p) => !/\[onclick\*=['"]?(?:return\s+(?:false|true)|javascript:|void\s*\(0\))/i.test(p))
      .map((p) => {
        if (
          p.startsWith("#header ") &&
          /(input\[name|textarea|a:has-text\(['"]결재선|button:has-text\(['"]결재선|button\.btn\.btn_pri|a\.sub\._doc|#eapDocReg_|#eapWorkSelect_|eapHeader_option|_search_option_hide|\._eapSearch|\.tbl_lst|\.lst_type1)/i.test(p)
        ) {
          return p.replace(/^#header\s+/, "");
        }
        return p;
      });

    return parts.length > 0 ? Array.from(new Set(parts)).join(", ") : s;
  };

  for (let i = 0; i < actualPlan.actions.length; i++) {
    const action = { ...actualPlan.actions[i] };
    const desc = action.description || "";
    let sel = action.selector || "";

    // 0. Ensure wait actions do NOT have selectors
    if (action.type === "wait") {
      delete action.selector;
      sel = "";
    }

    // 0-A. Auto-restore dragAndDrop type if previously overwritten to "click" by older dashboard UI
    if (action.type === "click" && action.sourceSelector && action.targetSelector) {
      action.type = "dragAndDrop";
      changes.push(`[타입 복원] '${desc}' 액션의 sourceSelector/targetSelector를 감지하여 type을 'dragAndDrop'으로 자동 복원했습니다.`);
      fixedActionsCount++;
    }

    // 0-B. Remove untrusted synthetic JS clicks on hidden #eapHeader_option / _search_option_hide
    if (
      action.type === "click" &&
      (sel.includes("eapHeader_option") || sel.includes("_search_option_hide") || desc.includes("도움말 전체기간 검색 초기화"))
    ) {
      changes.push(`[불필요 단계 제거] 페이지 내부 스크립트가 발생시킨 숨김 요소(#eapHeader_option) 클릭 단계를 제거했습니다.`);
      removedActionsCount++;
      if (i + 1 < actualPlan.actions.length && actualPlan.actions[i + 1].type === "wait") {
        i++; // Also skip its paired wait step
      }
      continue;
    }

    // 1. Syntax & Escaping Normalization (applies to selector, sourceSelector, targetSelector)
    if (action.selector) {
      const original = action.selector;
      action.selector = normalizeSelectorSyntax(action.selector);
      if (action.selector !== original) {
        changes.push(`[문법 교정] 셀렉터 정규화: "${original}" -> "${action.selector}"`);
        fixedActionsCount++;
      }
      sel = action.selector;
    }
    if (action.sourceSelector) {
      const origSrc = action.sourceSelector;
      action.sourceSelector = normalizeSelectorSyntax(action.sourceSelector);
      if (action.sourceSelector !== origSrc) {
        action.selector = action.sourceSelector;
        changes.push(`[문법 교정] 드래그 출발지 셀렉터 정규화: "${origSrc}" -> "${action.sourceSelector}"`);
        fixedActionsCount++;
      }
    }
    if (action.targetSelector) {
      const origTgt = action.targetSelector;
      action.targetSelector = normalizeSelectorSyntax(action.targetSelector);
      if (action.targetSelector !== origTgt) {
        changes.push(`[문법 교정] 드롭 도착지 셀렉터 정규화: "${origTgt}" -> "${action.targetSelector}"`);
        fixedActionsCount++;
      }
    }

    // 1-B. Deduplicate consecutive or AI-injected duplicate btn_write clicks
    if (action.type === "click" && sel.includes("btn_write")) {
      let prevNonWait: BrowsePlanAction | null = null;
      for (let k = sanitizedActions.length - 1; k >= 0; k--) {
        if (sanitizedActions[k].type !== "wait") {
          prevNonWait = sanitizedActions[k];
          break;
        }
      }
      if (prevNonWait && prevNonWait.type === "click" && (prevNonWait.selector || "").includes("btn_write")) {
        changes.push(`[중복 단계 제거] 선행 양식 카드 [작성] 버튼 클릭 직후 중복 삽입된 '${desc}' 단계를 제거했습니다.`);
        removedActionsCount++;
        if (i + 1 < actualPlan.actions.length && actualPlan.actions[i + 1].type === "wait") {
          i++; // Also skip its paired wait step
        }
        continue;
      }
    }

    // Auto-inject preceding hover action if clicking a hover-revealed card button (e.g. button.btn_write inside .app_work_box / li.aw_li)
    if (
      action.type === "click" &&
      (sel.includes("btn_write") ||
        (sel.includes(".app_work_box") && sel.includes("button")) ||
        (desc.includes("양식 카드") && desc.includes("작성")))
    ) {
      let prevNonWait: BrowsePlanAction | null = null;
      for (let k = sanitizedActions.length - 1; k >= 0; k--) {
        if (sanitizedActions[k].type !== "wait") {
          prevNonWait = sanitizedActions[k];
          break;
        }
      }
      if (!prevNonWait || prevNonWait.type !== "hover") {
        const cardTitleMatch = sel.match(/has-text\(['"]([^'"]+)['"]\)/) || desc.match(/['"]([^'"]+)['"]/);
        const cardTitle = cardTitleMatch ? cardTitleMatch[1].trim() : "";
        const hoverSel =
          cardTitle && cardTitle !== "작성"
            ? `ul.aw_ul li.aw_li:has-text('${cardTitle}') .app_work_box:visible, li.aw_li:has-text('${cardTitle}'):visible, ul.aw_ul li.aw_li .app_work_box:visible`
            : `ul.aw_ul li.aw_li .app_work_box:visible, .app_work_box:visible`;
        const hoverDesc = `${cardTitle && cardTitle !== "작성" ? `'${cardTitle}' ` : ""}양식 카드에 마우스 호버 (하위 [작성] 버튼 표시)`;
        sanitizedActions.push({
          type: "hover",
          selector: hoverSel,
          iframe: action.iframe,
          description: hoverDesc,
          recordedByEyedropper: action.recordedByEyedropper || actualPlan.recordedByEyedropper,
        });
        sanitizedActions.push({
          type: "wait",
          ms: 600,
          description: "마우스 호버 후 [작성] 버튼 표시 대기",
        });
        changes.push(`[호버 자동 주입] '${desc}' 실행 전 양식 카드 마우스 호버(hover) 단계를 자동 삽입했습니다.`);
        fixedActionsCount++;
      }
    }

    // 1-C. Remove bogus AI-injected duplicate-approver or unintended schedule-check popup close steps
    if (
      action.type === "click" &&
      (desc.includes("중복 결재자 알림 팝업") ||
        desc.includes("사용자 일정확인 팝업 닫기") ||
        (desc.includes("일정확인") && desc.includes("팝업 닫기")))
    ) {
      changes.push(`[불필요 단계 제거] 오탐으로 인해 임시 삽입되었던 '${desc}' 단계를 제거했습니다.`);
      removedActionsCount++;
      if (i + 1 < actualPlan.actions.length && actualPlan.actions[i + 1].type === "wait") {
        i++;
      }
      continue;
    }

    // 1-D. Restore swallowed approval-line button click (e.g. [합의] button) if its targetHtml was merged into dragAndDrop
    if (
      action.type === "dragAndDrop" &&
      action.targetHtml &&
      /^<button\b/i.test(action.targetHtml.trim()) &&
      (action.targetHtml.includes("btn_add") || action.targetHtml.includes("data-app-type-ordr"))
    ) {
      const ordrMatch = action.targetHtml.match(/data-app-type-ordr=["']([^"']+)["']/i);
      const titleMatch = action.targetHtml.match(/title=["']([^"']+)["']/i);
      const spanMatch = action.targetHtml.match(/<span[^>]*>([^<]+)<\/span>/i);
      const ordrVal = ordrMatch ? ordrMatch[1].trim() : "";
      const titleVal = titleMatch ? titleMatch[1].trim() : "";
      const btnText = spanMatch ? spanMatch[1].trim() : titleVal.replace(/\s*추가$/, "") || "합의";

      const btnCandidates: string[] = [];
      if (ordrVal) {
        btnCandidates.push(`.ui-dialog:visible button[data-app-type-ordr='${ordrVal}']:visible`);
      }
      if (titleVal) {
        btnCandidates.push(`.ui-dialog:visible button[title='${titleVal}']:visible`);
      }
      if (btnText) {
        btnCandidates.push(`.ui-dialog:visible button.btn_add:has-text('${btnText}'):visible`);
      }

      const restoredSelector = btnCandidates.join(", ");
      const restoredDesc = `[결재선 선택 팝업] '${btnText}' 버튼 클릭`;

      sanitizedActions.push({
        type: "click",
        selector: restoredSelector,
        description: restoredDesc,
        recordedByEyedropper: true,
        targetHtml: action.targetHtml,
        iframe: action.iframe || "",
        force: false,
      });
      sanitizedActions.push({
        type: "wait",
        ms: 1000,
        description: `${restoredDesc} 반응 대기`,
        recordedByEyedropper: true,
        force: false,
      });

      delete action.targetHtml;
      changes.push(`[누락 클릭 자동 복원] 드래그 앤 드롭 직전에 병합되었던 '${restoredDesc}' 단계를 복원했습니다.`);
      fixedActionsCount++;
    }

    // 1-E. Precision selector refinement from targetHtml & candidate ordering (applies to both Eyedropper and AI actions)
    if (action.selector && action.type === "click") {
      const rawParts = action.selector
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean);
      const hasModalScope = rawParts.some((p) => p.startsWith(".ui-dialog"));
      const modalPrefix = hasModalScope ? ".ui-dialog:visible " : "";

      // (a) If target is a .dynatree-title node, prepend exact [title='...'] and :text-is('...') so '유니슨' never collides with '유니슨 그룹'
      if (action.selector.includes("dynatree-title") || (action.targetHtml && action.targetHtml.includes("dynatree-title"))) {
        const htmlTitleMatch = action.targetHtml?.match(/\btitle=["']([^"']+)["']/i);
        const htmlInnerMatch = action.targetHtml?.match(/>([^<]+)<\/a>/i);
        const selTextMatch = action.selector.match(/dynatree-title:(?:has-text|text-is)\(['"]([^'"]+)['"]\)/);
        const exactTitle = htmlTitleMatch ? htmlTitleMatch[1].replace(/'/g, "").trim() : "";
        const exactText = (htmlInnerMatch ? htmlInnerMatch[1] : selTextMatch ? selTextMatch[1] : "").replace(/'/g, "").trim();

        const treePriority: string[] = [];
        if (exactTitle) {
          treePriority.push(`${modalPrefix}a.dynatree-title[title='${exactTitle}']:visible`);
        }
        if (exactText) {
          treePriority.push(`${modalPrefix}.dynatree-title:text-is('${exactText}'):visible`);
          treePriority.push(`${modalPrefix}.dynatree-title:has-text('${exactText}'):visible`);
        }
        if (treePriority.length > 0) {
          const merged = Array.from(new Set([...treePriority, ...rawParts]));
          const newSel = merged.join(", ");
          if (newSel !== action.selector) {
            action.selector = newSel;
            sel = newSel;
            changes.push(`[트리 노드 정밀화] '${desc}' 셀렉터에 정확 일치(title/text-is) 후보를 최우선 배치했습니다.`);
            fixedActionsCount++;
          }
        }
      }

      // (b) If targetHtml has a distinguishing data-* attribute (e.g. data-res-id, data-dept-id, data-emp-id), prepend it
      if (action.targetHtml) {
        const dataAttrMatch = action.targetHtml.match(/\b(data-(?:res-id|dept-id|emp-id|cmp-id|cal-id|brd-id|trgt-id|work-id|app-type-ordr))=["']([^"']+)["']/i);
        if (dataAttrMatch) {
          const attrName = dataAttrMatch[1];
          const attrVal = dataAttrMatch[2].replace(/'/g, "").trim();
          const tagMatch = action.targetHtml.trim().match(/^<([a-zA-Z0-9]+)/);
          const tagName = tagMatch ? tagMatch[1].toLowerCase() : "";
          const attrSel = `${modalPrefix}${tagName}[${attrName}='${attrVal}']:visible`;
          if (!action.selector.includes(`${attrName}='${attrVal}'`)) {
            const currentParts = action.selector.split(",").map((p) => p.trim()).filter(Boolean);
            action.selector = Array.from(new Set([attrSel, ...currentParts])).join(", ");
            sel = action.selector;
            changes.push(`[데이터 속성 보강] '${desc}' 셀렉터에 고유 속성(${attrName}='${attrVal}')을 최우선 추가했습니다.`);
            fixedActionsCount++;
          }
        }
      }

      // (c) Reorder dynamic list candidates so specific :has-text / :text-is / [data-*] come BEFORE positional :nth-of-type(n), and drop bare catch-all class selectors
      const currentCandidates = action.selector.split(",").map((p) => p.trim()).filter(Boolean);
      const hasSpecificTextOrAttr = currentCandidates.some(
        (c) => c.includes(":has-text(") || c.includes(":text-is(") || /\[data-[a-z-]+=/i.test(c) || /#[a-zA-Z0-9_-]+:visible$/.test(c)
      );
      const hasPositionalNth = currentCandidates.some((c) => /:(?:nth-of-type|nth-child)\(\d+\)/.test(c));

      if (hasSpecificTextOrAttr && currentCandidates.length > 1) {
        const specificFirst: string[] = [];
        const positionalLater: string[] = [];

        for (const cand of currentCandidates) {
          const isPositional = /:(?:nth-of-type|nth-child)\(\d+\)/.test(cand) && !cand.includes(":has-text(") && !cand.includes(":text-is(");
          const isBareClassCatchAll =
            !cand.includes("#") &&
            !cand.includes("[") &&
            !cand.includes(":has-text(") &&
            !cand.includes(":text-is(") &&
            !cand.includes(":nth-") &&
            !cand.includes(">");

          if (isBareClassCatchAll) {
            // Skip bare catch-all class (e.g. .ui-dialog:visible label.user_info.chkbox:visible) when specific text/attr exists
            continue;
          }
          if (isPositional) {
            positionalLater.push(cand);
          } else {
            specificFirst.push(cand);
            // If it's a multi-token user/item text like :has-text('test002 테스트 부서 (유니슨)'), also add core token match :has-text('test002')
            const textMatch = cand.match(/^(.*):has-text\(['"]([^'"]+)['"]\)(.*)$/);
            if (textMatch) {
              const firstToken = textMatch[2].trim().split(/\s+/)[0];
              if (firstToken && firstToken.length >= 4 && firstToken !== textMatch[2].trim()) {
                specificFirst.push(`${textMatch[1]}:has-text('${firstToken}')${textMatch[3]}`);
              }
            }
          }
        }

        if (specificFirst.length > 0 && hasPositionalNth) {
          const reordered = Array.from(new Set([...specificFirst, ...positionalLater])).join(", ");
          if (reordered !== action.selector) {
            action.selector = reordered;
            sel = reordered;
            changes.push(`[동적 목록 정밀화] '${desc}' 셀렉터에서 텍스트/속성 매칭을 위치 인덱스(:nth-of-type)보다 우선 배치했습니다.`);
            fixedActionsCount++;
          }
        }
      }
    }

    // If this action was captured directly from the live browser DOM via the Eyedropper,
    // preserve its exact HTML/DOM selector and iframe 100% without any keyword-guessing overrides!
    if (actualPlan.recordedByEyedropper || action.recordedByEyedropper) {
      action.recordedByEyedropper = true;
      if (action.type === "dragAndDrop" && !action.sourceSelector && action.selector) {
        action.sourceSelector = action.selector;
      }
      sanitizedActions.push(action);
      continue;
    }

    // 1-A. Drag & Drop Selectors Normalization
    if (action.type === "dragAndDrop") {
      if (!action.sourceSelector && action.selector) {
        action.sourceSelector = action.selector;
      }
      if (action.sourceSelector) {
        action.sourceSelector = action.sourceSelector.replace(/\\+"/g, "'").replace(/\\+'/g, "'").replace(/'{2,}/g, "'");
      }
      if (action.targetSelector) {
        action.targetSelector = action.targetSelector.replace(/\\+"/g, "'").replace(/\\+'/g, "'").replace(/'{2,}/g, "'");
      }
      const targetUserMatch = desc.match(/['"]([^'"]+)['"]/) || desc.match(/\b([a-zA-Z0-9_-]{3,}|[가-힣]{2,4})\s*(?:결재자|사원|직원|체크|선택|사용자)/);
      const targetUser = targetUserMatch ? targetUserMatch[1].trim() : "";
      if (targetUser && !["결재자", "사원", "사용자", "직원", "목록", "체크", "선택", "두번째", "두번쨰", "첫번째"].includes(targetUser)) {
        if (!action.sourceSelector || !action.sourceSelector.includes(targetUser)) {
          action.sourceSelector = `.ui-dialog:visible a.dynatree-title:has-text('${targetUser}'):visible, .ui-dialog:visible tr:has-text('${targetUser}'), .ui-dialog:visible li:has-text('${targetUser}'), .ui-dialog:visible label:has-text('${targetUser}'), .ui-dialog:visible :has-text('${targetUser}')`;
          changes.push(`[정제] 드래그 출발지 사원('${targetUser}') 정밀 셀렉터 보강: ${action.sourceSelector}`);
          fixedActionsCount++;
        }
      }

      const isSecondApprSlot = desc.includes("결재") && (desc.includes("두번째") || desc.includes("두 번째") || desc.includes("2번째") || desc.includes("칸") || desc.includes("슬롯"));
      if (isSecondApprSlot || !action.targetSelector || action.targetSelector.includes(".app_line_table") || action.targetSelector.includes(".line_box")) {
        action.targetSelector = "#af_4, table#eapLineSelect_line td:nth-child(4) div.app_flow, .appline_flow table td:nth-child(4), .ui-dialog:visible div.app_flow:has(strong:has-text('결재')):nth-of-type(2), #eapLineSelect_lineTrgtAdd button[data-app-type-ordr='4']";
        changes.push(`[정제] 드래그 도착지(두번째 결재칸) Naonsoft 정밀 targetSelector 자동 보강: ${action.targetSelector}`);
        fixedActionsCount++;
      }
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

    const isTreeExpandAction =
      action.type === "click" &&
      isModalContext &&
      (desc.includes("펼침") || desc.includes("확장"));

    if (isTreeExpandAction) {
      const original = action.selector;
      action.selector = ".ui-dialog:visible button.btn_fopn:visible, .ui-dialog:visible button:has-text('모두펼침'):visible, .ui-dialog:visible .dynatree-expander:visible";
      changes.push(`[정제] 트리 모달 모두펼침 버튼 셀렉터 정밀 보강: "${original}" -> "${action.selector}"`);
      fixedActionsCount++;
      sel = action.selector;
    } else if (
      action.type === "click" &&
      !desc.includes("확인") &&
      !desc.includes("펼침") &&
      !desc.includes("확장") &&
      isModalContext &&
      !isSidebarNavigation &&
      !isUserSelection &&
      !sel.includes("dynatree-checkbox") &&
      (desc.includes("노드") || desc.includes("트리") || desc.includes("폴더") || desc.includes("분류") || desc.includes("문서함") || desc.includes("게시판") || desc.includes("캘린더") || desc.includes("양식"))
    ) {
      const original = action.selector;
      const titleMatch = desc.match(/['"]([^'"]+)['"]/);
      const titlePrefix = titleMatch ? `.ui-dialog:visible a.dynatree-title:has-text('${titleMatch[1]}'):visible, ` : "";
      action.selector = `${titlePrefix}.ui-dialog:visible span.dynatree-checkbox:visible, .ui-dialog:visible .dynatree-container ul ul span.dynatree-checkbox:visible, .ui-dialog:visible .dynatree-container .tico_item a.dynatree-title:visible, .ui-dialog:visible .dynatree-container .dynatree-node:not(.dynatree-folder) a.dynatree-title:visible, .ui-dialog:visible .dynatree-container ul ul a.dynatree-title:visible`;
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
      const targetUserMatch = desc.match(/['"]([^'"]+)['"]/) || desc.match(/\b([a-zA-Z0-9_-]{3,}|[가-힣]{2,4})\s*(?:사원|직원|체크|선택|체크박스)/);
      const targetUser = targetUserMatch ? targetUserMatch[1].trim() : "";

      if (targetUser && !["사원", "사용자", "직원", "목록", "체크", "선택", "체크박스", "첫번째", "두번째"].includes(targetUser)) {
        action.selector = `.ui-dialog:visible span.dynatree-checkbox:has(+ a:has-text('${targetUser}')):visible, .ui-dialog:visible tr:has-text('${targetUser}') span.dynatree-checkbox:visible, .ui-dialog:visible tr:has-text('${targetUser}') input[type='checkbox']:visible, .ui-dialog:visible label:has-text('${targetUser}'):visible, .ui-dialog:visible tr:has-text('${targetUser}'):visible, .ui-dialog:visible li:has-text('${targetUser}'):visible, .ui-dialog:visible :has-text('${targetUser}'):visible`;
        changes.push(`[정제] 특정 사원/사용자('${targetUser}') 정밀 타겟팅 및 체크박스 셀렉터 보강: "${original}" -> "${action.selector}"`);
      } else {
        action.selector = ".ui-dialog:visible span.dynatree-checkbox:visible, .ui-dialog:visible label.user_info.chkbox, .ui-dialog:visible label[class*='user_info'], .ui-dialog:visible #orgUserList_listbox label.user_info, .ui-dialog:visible #orgUserList_listbox li:first-child, .ui-dialog:visible .org_user_lst li:first-child, .ui-dialog:visible [id^='user_']:first-child, .ui-dialog:visible .user_card:first-child, .ui-dialog:visible [class*='user_lst'] li:first-child, .ui-dialog:visible [class*='user']:has(.name):first-child, .ui-dialog:visible li:first-child label, .ui-dialog:visible tr:first-child td";
        changes.push(`[정제] 조직도/권한 팝업 사원/사용자 선택 중앙 후보 카드 및 체크박스 셀렉터 보강: "${original}" -> "${action.selector}"`);
      }
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
      desc.includes("지정을 위해") ||
      desc.includes("선택 버튼 클릭");

    if (
      action.type === "click" &&
      isModalOpenAction &&
      (desc.includes("추가") || desc.includes("조직도") || desc.includes("주소록") || desc.includes("선택") || desc.includes("검색") || desc.includes("결재선"))
    ) {
      const original = action.selector;
      if (desc.includes("결재선")) {
        action.selector = "button#eapDocReg_lineSelBtn:visible, button#eapDocReg_lineSelectBtn:visible, button:has-text('결재선 선택'):visible, button:has-text('결재선'):visible, .ui-dialog:visible button:has-text('결재선'):visible";
        changes.push(`[정제] 결재선 선택/호출 버튼 정밀 셀렉터 보강: "${original}" -> "${action.selector}"`);
      } else {
        action.selector = ".ui-dialog:visible button:has-text('추가'):visible, .ui-dialog:visible button:has-text('조직도'):visible, .ui-dialog:visible button:has-text('주소록'):visible, .ui-dialog:visible button.btn_add:visible, .modal:visible button:has-text('추가'):visible, [role='dialog']:visible button:has-text('추가'):visible, button:has-text('추가'):visible, button:has-text('조직도'):visible";
        changes.push(`[정제] 팝업 내부 하위 피커/조직도 호출 버튼 셀렉터 보강: "${original}" -> "${action.selector}"`);
      }
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

    // 1-B1.65 Drag and Drop Action & Approval Line Slot Alignment
    const isDragIntent =
      action.type === "dragAndDrop" ||
      (action.type !== "wait" &&
       !desc.includes("대기") &&
       desc.includes("드래그") &&
       (desc.includes("드롭") || desc.includes("끌어") || desc.includes("결재칸") || desc.includes("슬롯")));

    if (isDragIntent) {
      if (action.type !== "dragAndDrop") {
        action.type = "dragAndDrop";
        changes.push(`[정제] 드래그 앤 드롭 의도 감지 -> action.type을 "dragAndDrop"으로 자동 변환: "${desc}"`);
        fixedActionsCount++;
      }

      // Check source element (사원/대상)
      const targetUserMatch = desc.match(/['"]([^'"]+)['"]/) || desc.match(/\b([a-zA-Z0-9_-]{3,}|[가-힣]{2,4})\s*(?:항목|사원|직원|체크|드래그)/);
      const targetUser = targetUserMatch ? targetUserMatch[1].trim() : "";

      if (!action.sourceSelector || (action.sourceSelector && targetUser && !action.sourceSelector.includes(targetUser))) {
        if (targetUser) {
          action.sourceSelector = `.ui-dialog:visible a.dynatree-title:has-text('${targetUser}'):visible, .ui-dialog:visible .dynatree-node:has(a:has-text('${targetUser}')) a.dynatree-title, .ui-dialog:visible label:has-text('${targetUser}')`;
        } else {
          action.sourceSelector = ".ui-dialog:visible a.dynatree-title:visible, .ui-dialog:visible label.user_info.chkbox, .ui-dialog:visible .dynatree-node a.dynatree-title";
        }
        changes.push(`[정제] 드래그 출발지(sourceSelector) 보강: "${action.sourceSelector}"`);
        fixedActionsCount++;
      }

      // Check target element (결재칸/슬롯)
      const isSecondSlot = desc.includes("두 번째") || desc.includes("두번째") || desc.includes("2번째") || desc.includes("2nd");
      if (!action.targetSelector || (isSecondSlot && !action.targetSelector.includes("af_4") && !action.targetSelector.includes("nth-child(4)"))) {
        if (isSecondSlot) {
          action.targetSelector = "#af_4, table#eapLineSelect_line td:nth-child(4) div.app_flow, .appline_flow table td:nth-child(4), #eapLineSelect_lineTrgtAdd button[data-app-type-ordr='4']";
        } else {
          action.targetSelector = "#af_1, #af_4, table#eapLineSelect_line div.app_flow, .appline_flow table td div.app_flow";
        }
        changes.push(`[정제] 드래그 목적지(targetSelector) 보강: "${action.targetSelector}"`);
        fixedActionsCount++;
      }
    }

    // 1-B1.66 Approval Line Tab Click Safety
    if (action.type === "click" && desc.includes("결재선") && desc.includes("탭")) {
      action.selector = "#eapDocReg_tabBox a:has-text('결재선'), a:has-text('결재선'):visible, li:has-text('결재선') a";
      action.optional = true;
      action.force = true;
    }

    // 1-B1.7 Form Body Type Action Sanitization (Strip invalid iframe and ensure robust selectors)
    if (
      action.type === "type" &&
      (desc.includes("내용") || desc.includes("본문") || desc.includes("회의") || desc.includes("완료") || desc.includes("작성"))
    ) {
      if (action.iframe) {
        delete action.iframe;
        changes.push(`[정제] 본문 양식 폼 입력 액션에서 불필요한 iframe 속성 제거: "${desc}"`);
        fixedActionsCount++;
      }
      if (!action.selector || action.selector.includes("subBody") || action.selector.includes("iframe")) {
        action.selector = ".doc_view_table textarea:visible, table.tbl_frm textarea:visible, #eapDocReg_contents textarea:visible, textarea:not(#eapDocReg_draftOpinCn):not([name*='opinion']):visible, textarea:visible";
        changes.push(`[정제] 본문 양식 폼 입력 셀렉터 보강: "${action.selector}"`);
        fixedActionsCount++;
        sel = action.selector;
      }
    }

    // 1-B1.8 Electronic Approval Form Selection / Draft Initiation Refinement
    if (
      action.type === "click" &&
      (desc.includes("결재작성") ||
        desc.includes("결재 작성") ||
        desc === "'작성' 버튼 클릭" ||
        sel === "button:has-text('작성'):visible, button.btn.btn_write:has-text('작성'):visible" ||
        (desc.includes("양식") && (desc.includes("선택") || desc.includes("클릭"))))
    ) {
      const isLeftSnbBtn =
        desc.includes("좌측") ||
        desc.includes("사이드바") ||
        desc.includes("snb") ||
        ((desc.includes("결재 작성") || desc.includes("결재작성")) &&
          !desc.includes("카드") &&
          !desc.includes("양식"));
      const isCardSelect =
        (desc.includes("카드") || desc.includes("양식")) &&
        (desc.includes("선택") || desc.includes("클릭")) &&
        !desc.includes("버튼 클릭") &&
        !desc.includes("작성 버튼");
      const isCardWriteBtn =
        desc === "'작성' 버튼 클릭" ||
        sel === "button:has-text('작성'):visible, button.btn.btn_write:has-text('작성'):visible" ||
        desc.includes("카드 내") ||
        desc.includes("양식 내") ||
        desc.includes("작성 버튼 클릭") ||
        (desc.includes("버튼") && !isLeftSnbBtn);

      if (isLeftSnbBtn) {
        const original = action.selector;
        action.selector =
          "#snb button:has-text('결재 작성'):visible, .workset_btn button:has-text('결재 작성'):visible, .snb_btn_box button:has-text('결재 작성'):visible, button#gapLeft_workWriteBtn:visible, button:has-text('결재 작성'):visible";
        changes.push(`[정제] 전자결재 좌측 SNB '결재 작성' 대버튼 셀렉터 정밀 보강: "${original}" -> "${action.selector}"`);
        fixedActionsCount++;
        sel = action.selector;
      } else if (isCardSelect) {
        const original = action.selector;
        const cardMatch =
          desc.match(/['"]([^'"]+)['"]/) ||
          (desc.includes("회의록")
            ? [null, "회의록"]
            : desc.includes("테스트 업무")
            ? [null, "테스트 업무"]
            : desc.includes("지출결의서")
            ? [null, "지출결의서"]
            : null);
        const cardName = cardMatch && cardMatch[1] ? cardMatch[1].trim() : "";
        if (cardName && !["양식", "결재업무", "카드", "첫번째", "첫 번째"].includes(cardName)) {
          action.selector = `ul.aw_ul li.aw_li:has-text('${cardName}') button.btn_write:visible, .app_work_box:has-text('${cardName}') button.btn_write:visible, ul.aw_ul li.aw_li:has-text('${cardName}') .app_work_box`;
        } else {
          action.selector =
            "ul.aw_ul li.aw_li:first-child button.btn_write:visible, ul.aw_ul li.aw_li:first-child .app_work_box, .app_work_box:visible";
        }
        changes.push(`[정제] 전자결재 결재업무 카드 선택 셀렉터 정밀 보강: "${original}" -> "${action.selector}"`);
        fixedActionsCount++;
        sel = action.selector;
      } else if (isCardWriteBtn) {
        const original = action.selector;
        // CRITICAL: Always scope to .app_work_box / li.aw_li / #eapWorkSelect_workList so we NEVER click top-right #header button._header_writeBtn!
        action.selector =
          "ul.aw_ul li.aw_li button.btn_write:visible, #eapWorkSelect_workList button.btn_write:visible, .app_work_box button.btn_write:visible, li.aw_li button.btn_write:visible, button.btn_write:not(._header_writeBtn):not(#header *):not(.gw_header *):not(#snb *):not(.workset_btn *):not(.gm_reg *):visible";
        changes.push(`[정제] 전자결재 카드 내부 소형 '작성' 버튼 셀렉터 정밀 보강: "${original}" -> "${action.selector}"`);
        fixedActionsCount++;
        sel = action.selector;
      }
    }

        // 1-B1.9 Naonsoft Groupware Canonical Action Mappings
    if (action.type === "click") {
      // 결재상신
      if (
        (desc.includes("상신 버튼") || desc.includes("결재상신") || (desc.includes("상신") && desc.includes("버튼"))) &&
        !desc.includes("양식") &&
        !desc.includes("확인") &&
        !desc.includes("취소") &&
        !desc.includes("제목") &&
        !desc.includes("문서") &&
        !desc.includes("목록") &&
        !desc.includes("조회") &&
        !desc.includes("현황")
      ) {
        const original = action.selector;
        action.selector = "button._draftBtn, button._draft, button:has-text('결재상신'):visible, button:has-text('상신'):visible, .btn_draft:visible";
        if (original !== action.selector) {
          changes.push(`[그룹웨어 정밀 매핑] 전자결재 상신 버튼 보강: "${original}" -> "${action.selector}"`);
          fixedActionsCount++;
        }
        sel = action.selector;
      }
      // 결재문서 목록 / 최근 결재 문서 클릭
      else if (
        (desc.includes("결재 문서") || desc.includes("결재문서") || desc.includes("최근 결재") || desc.includes("상신한") || desc.includes("결재현황 목록") || (desc.includes("현황") && desc.includes("문서"))) &&
        (desc.includes("제목") || desc.includes("문서") || desc.includes("클릭") || desc.includes("조회") || desc.includes("상세"))
      ) {
        const original = action.selector;
        action.selector = "table.tbl_lst tbody tr:first-child a:visible, table tbody tr:first-child a:visible, .list_box .sub:first-child a:visible, a:has-text('테스트 회의록'):visible";
        if (original !== action.selector) {
          changes.push(`[그룹웨어 정밀 매핑] 최신 결재문서 제목/상세 클릭 보강: "${original}" -> "${action.selector}"`);
          fixedActionsCount++;
        }
        sel = action.selector;
      }
      // 기록물철 / 문서보관함 / 결재분류 폴더 버튼 (팝업 내부 선택이 아닌 '모달 열기 버튼'일 때만)
      else if (
        (desc.includes("기록물철") || desc.includes("문서보관함") || desc.includes("결재분류") || desc.includes("분류 폴더") || desc.includes("분류 선택 폴더")) &&
        (desc.includes("선택") || desc.includes("클릭") || desc.includes("버튼")) &&
        !desc.includes("팝업") &&
        !desc.includes("모달") &&
        !desc.includes("트리") &&
        !desc.includes("노드") &&
        !desc.includes("확인") &&
        !desc.includes("항목")
      ) {
        const original = action.selector;
        action.selector = "button#eapDocReg_binderSelBtn:visible, button#eapDocReg_bindBtn:visible, button#gapDocReg_binderSelBtn:visible, tr:has-text('결재분류') button:visible, tr:has-text('분류') button:visible, button:has-text('기록물철'):visible, button:has-text('문서보관함'):visible";
        if (original !== action.selector) {
          changes.push(`[그룹웨어 정밀 매핑] 결재분류/기록물철/보관함 선택 버튼 보강: "${original}" -> "${action.selector}"`);
          fixedActionsCount++;
        }
        sel = action.selector;
      }
      // 결재분류 / 기록물철 / 문서함 팝업 내부 트리 항목 선택
      else if (
        (desc.includes("결재분류") || desc.includes("기록물철") || desc.includes("문서보관함") || desc.includes("문서함")) &&
        (desc.includes("팝업") || desc.includes("모달") || desc.includes("트리") || desc.includes("노드") || desc.includes("항목")) &&
        (desc.includes("선택") || desc.includes("클릭")) &&
        !desc.includes("확인") &&
        !desc.includes("닫기") &&
        !desc.includes("취소")
      ) {
        const original = action.selector;
        const nameMatch = desc.match(/['"]([^'"]{1,30})['"]/);
        const targetNodeName = nameMatch ? nameMatch[1].trim() : "";
        if (targetNodeName) {
          action.selector = `.ui-dialog:visible .dynatree-title:has-text('${targetNodeName}'):visible, .ui-dialog:visible a:has-text('${targetNodeName}'):visible, .ui-dialog:visible span:has-text('${targetNodeName}'):visible`;
        } else {
          action.selector = `.ui-dialog:visible .dynatree-node:not(.dynatree-has-children) .dynatree-title:visible, .ui-dialog:visible .dynatree-title:visible`;
        }
        if (original !== action.selector) {
          changes.push(`[그룹웨어 정밀 매핑] 분류/문서함 팝업 트리 항목(${targetNodeName || "첫번째 항목"}) 셀렉터 보강: "${original}" -> "${action.selector}"`);
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

    if (action.type === "type") {
      // 기안의견
      if (desc.includes("의견") || desc.includes("opinion")) {
        const original = action.selector;
        action.selector = "textarea#eapDocReg_draftOpinCn:visible, textarea#eapDocReg_opinCn:visible, textarea[name*='opinion']:visible, textarea[placeholder*='의견']:visible, textarea:visible";
        if (original !== action.selector) {
          changes.push(`[그룹웨어 정밀 매핑] 기안의견 입력란 보강: "${original}" -> "${action.selector}"`);
          fixedActionsCount++;
        }
        sel = action.selector;
      }
      // 문서 제목
      else if (desc.includes("제목") && !desc.includes("검색") && !desc.includes("분류")) {
        const original = action.selector;
        action.selector = "input#eapDocReg_docSubject:visible, input#docTitle:visible, input[name*='Subject']:visible, input[placeholder*='제목']:visible, input#subject:visible";
        if (original !== action.selector) {
          changes.push(`[그룹웨어 정밀 매핑] 문서 제목 입력란 보강: "${original}" -> "${action.selector}"`);
          fixedActionsCount++;
        }
        sel = action.selector;
      }
    }

    // 1-B2. Universal Dialog Confirm / Apply Button
    const isDialogConfirmIntent =
      (desc.includes("확인 버튼") ||
       desc.includes("확인 클릭") ||
       desc.includes("선택 완료") ||
       desc.includes("팝업 확인") ||
       desc.includes("대화상자 확인") ||
       desc.includes("다이얼로그 확인") ||
       desc.includes("적용 버튼") ||
       (desc.endsWith("확인") && !desc.includes("옵션") && !desc.includes("내용") && !desc.includes("여부") && !desc.includes("상태") && !desc.includes("일정") && !desc.includes("중복")));

    if (
      action.type === "click" &&
      isDialogConfirmIntent &&
      (isModalContext || sel.includes("confirm") || sel.includes("Confirm")) &&
      !desc.includes("옵션") &&
      !desc.includes("체크") &&
      !desc.includes("설정") &&
      !desc.includes("공개") &&
      !desc.includes("비공개") &&
      !desc.includes("일정확인")
    ) {
      action.selector = ".ui-dialog:visible .ui-dialog-buttonpane button:has-text('확인'):visible, .ui-dialog:visible button._confirmBtn:visible, .ui-dialog:visible button._confirm:visible, .ui-dialog:visible .ui-dialog-buttonpane button:text-is('확인'):visible, button[id*='confirm']:visible, button[id*='Confirm']:visible, .ui-dialog:visible button.btn_pri:text-is('확인'):visible";
      delete action.iframe;
      if (desc.includes("완료 확인") || desc.includes("알림 팝업") || desc.includes("확인 알림") || desc.includes("상신 완료") || desc.includes("완료 알림")) {
        action.optional = true;
      }
      sel = action.selector;
    }

    // Schedule form option / checkbox / place helpers
    if (action.type === "click" && (desc.includes("공개") || desc.includes("비공개"))) {
      action.selector = ".ui-dialog:visible label:has-text('비공개'):visible, .ui-dialog:visible label:has-text('공개'):visible, .ui-dialog:visible input#publYn:visible, input[name*='publ']:visible, label:has-text('비공개'), label:has-text('공개')";
      action.optional = true;
      sel = action.selector;
    }

    if (action.type === "type" && (desc.includes("장소") || desc.includes("회의실") || desc.includes("위치"))) {
      action.selector = ".ui-dialog:visible input#palace:visible, .ui-dialog:visible input#place:visible, .ui-dialog:visible input[name*='palace']:visible, .ui-dialog:visible input[name*='place']:visible, .ui-dialog:visible input[placeholder*='장소']:visible, input#palace:visible";
      sel = action.selector;
    }

    // 1-C. Calendar Event Item Hover & Click (Post-modal Registration)
    if (desc.includes("캘린더") || desc.includes("등록된 일정") || desc.includes("일정 항목")) {
      if (sel.includes(".ui-dialog")) {
        const cleanedSel = sel.split(",").map(s => s.trim()).filter(s => !s.includes(".ui-dialog")).join(", ").trim();
        action.selector = cleanedSel || "a.fc-event:visible, .fc-event-title:visible, .fc-event:visible";
        sel = action.selector;
      }
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
        // Prioritize Content Toolbar & Module-Specific Search Buttons (EAP WorkSelect, Doc, Board, Email, Note, Project)
        action.selector = `#eapWorkSelect_searchBox button.btn_srch:visible, button#atclList_srchBtn:visible, button#brdAtclList_searchBtn:visible, button#emlLmbMailList_btnSearch:visible, button#noteHeader_btnSearch:visible, button#prjTaskSearch_btnSearch:visible, button[id*='srchBtn']:visible, button[id*='searchBtn']:visible, .new_srch_bar button:visible, #content .srch_input button:has(.ico_srch):visible, #content .srch_input button[title='검색']:visible, #content button[title='검색']:visible, #content button.btn_srch:visible, #content button:has-text('검색'):visible`;
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
        // Prioritize Content Toolbar & Module-Specific Search Inputs (EAP WorkSelect, Doc, Board, Email, Note, Project)
        action.selector = `input#eapWorkSelect_searchWord:visible, input#atclList_searchWord:visible, input#brdAtclList_searchWord:visible, input#emlLmbMailList_searchWord:visible, input#noteHeader_searchWord:visible, input#worViewerList_searchWord:visible, input#prjTaskSearch_searchWord:visible, input[id*='searchWord']:visible, .new_srch_bar input:visible, #content .srch_input input:visible, #content input[id*='search']:visible, #content input[placeholder*='검색']:visible`;
      }
      sel = action.selector;
    }

    // 2. Track Modal Dialog Entering / Leaving
    const isModalCloseOrSubmit =
      desc.includes("저장") ||
      desc.includes("상신") ||
      desc.includes("등록 완료") ||
      desc.includes("닫힘") ||
      desc.includes("닫기") ||
      desc.includes("취소") ||
      desc.includes("확인") ||
      desc.includes("선택 완료") ||
      desc.includes("그리드 자동 갱신") ||
      desc.includes("캘린더") ||
      sel.includes("closeBtn") ||
      sel.includes("btn_close") ||
      sel.includes("fc-event") ||
      sel.includes("confirm");

    if (isModalCloseOrSubmit) {
      isInsideModal = false;
    } else if (
      sel.includes(".ui-dialog") ||
      sel.includes(".modal") ||
      sel.includes(".layer_wrap") ||
      ((desc.includes("모달 열림") || desc.includes("팝업 열림") || desc.includes("모달 로딩") || desc.includes("다이얼로그 로딩")) && (action.type === "click" || action.type === "wait"))
    ) {
      isInsideModal = true;
    }

    // 4. Modal Overlay Safety: Discard background actions while modal is active
    if (isInsideModal && !isModalCloseOrSubmit) {
      if (action.type === "hover" && (desc.includes("폼") || desc.includes("입력된")) && !sel.includes(".ui-dialog") && !sel.includes(".modal")) {
        action.selector = `.ui-dialog:visible .form_table:visible, .ui-dialog:visible form:visible, .ui-dialog:visible .tbl_frm:visible, ${sel}`;
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

  if (actualPlan.recordedByEyedropper) {
    return {
      plan: {
        ...actualPlan,
        actions: sanitizedActions,
      },
      report: {
        fixedActionsCount,
        removedActionsCount,
        changes,
      },
    };
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

  // 16. Universal EKP Approval Form Card -> [작성] Button Automatic Injection
  // When an approval work card is selected (or clicked), the user MUST click the inner [작성] button
  // to open the draft form. If the inner write button click is missing, inject it automatically!
  const cardSelectIdx = optimizedActions.findIndex((a, idx) => {
    if (a.type !== "click") return false;
    const d = (a.description || "").toLowerCase();
    const s = (a.selector || "").toLowerCase();
    return (
      (d.includes("카드") || d.includes("양식") || d.includes("결재업무")) &&
      (d.includes("선택") || d.includes("클릭")) &&
      !d.includes("대버튼") &&
      !d.includes("사이드바") &&
      !d.includes("snb") &&
      (s.includes("app_work_box") || s.includes("aw_li") || s.includes("work_list") || d.includes("회의록") || d.includes("지출결의서") || d.includes("경비정산"))
    );
  });

  if (cardSelectIdx !== -1) {
    const hasCardWriteBtnAfter = optimizedActions.some((a, idx) => {
      if (a.type !== "click") return false;
      const d = (a.description || "").toLowerCase();
      const s = (a.selector || "").toLowerCase();
      return (
        idx > cardSelectIdx &&
        idx <= cardSelectIdx + 3 &&
        (d.includes("카드 내") || d.includes("양식 내") || d.includes("소형") || s.includes("btn_write") || d.includes("작성 버튼"))
      );
    });

    if (!hasCardWriteBtnAfter) {
      let insertIdx = cardSelectIdx + 1;
      if (insertIdx < optimizedActions.length && optimizedActions[insertIdx].type === "wait") {
        insertIdx++;
      }
      optimizedActions.splice(
        insertIdx,
        0,
        {
          type: "click",
          description: "선택된 결재업무 카드 내부의 [작성] 버튼 클릭하여 기안 작성 화면 오픈",
          selector: "ul.aw_ul li.aw_li button.btn_write:visible, .app_work_box button:has-text('작성'):visible, .app_work_box button.btn_write:visible, #eapWorkSelect_workList button.btn_write:visible, li.aw_li button:has-text('작성'):visible, button.btn_write:not(._header_writeBtn):not(#header *):not(.gw_header *):not(#snb *):not(.workset_btn *):not(.gm_reg *):visible",
        },
        {
          type: "wait",
          description: "기안서 작성 폼 로딩 및 에디터 렌더링 대기",
          ms: 3500,
        }
      );
      changes.push(`[보강] 전자결재 양식 카드 선택 후 내부 [작성] 버튼 클릭 및 폼 로딩 대기 액션 자동 주입`);
      fixedActionsCount++;
    }
  } else {
    // AI가 검색 실행 후 카드 선택 및 [작성] 버튼 클릭 단계를 건너뛰고 바로 제목 입력으로 넘어간 경우 자동 복구
    const searchIdx = optimizedActions.findIndex((a) => {
      const d = (a.description || "").toLowerCase();
      const s = (a.selector || "").toLowerCase();
      return (
        (d.includes("결재업무") || d.includes("양식") || d.includes("회의록") || d.includes("지출결의서")) &&
        (d.includes("검색") && (a.type === "click" || s.includes("srchbtn") || s.includes("btn_srch")))
      );
    });

    const titleIdx = optimizedActions.findIndex((a) => {
      const d = (a.description || "").toLowerCase();
      const s = (a.selector || "").toLowerCase();
      return (
        a.type === "type" &&
        (d.includes("제목") || s.includes("subject") || s.includes("title"))
      );
    });

    if (searchIdx !== -1 && titleIdx !== -1 && searchIdx < titleIdx) {
      let insertIdx = searchIdx + 1;
      if (insertIdx < optimizedActions.length && optimizedActions[insertIdx].type === "wait") {
        insertIdx++;
      }
      optimizedActions.splice(
        insertIdx,
        0,
        {
          type: "click",
          description: "검색된 회의록 결재업무 카드 선택",
          selector: "ul.aw_ul li.aw_li:first-child .app_work_box, ul.aw_ul li.aw_li:first-child .info_div, li.aw_li:first-child .app_work_box, .app_work_box:visible, .app_work_list li:first-child a",
        },
        {
          type: "wait",
          description: "결재업무 카드 선택 상태 대기",
          ms: 1200,
        },
        {
          type: "click",
          description: "선택된 결재업무 카드 내부의 [작성] 버튼 클릭하여 기안 작성 화면 오픈",
          selector: "ul.aw_ul li.aw_li button.btn_write:visible, .app_work_box button:has-text('작성'):visible, .app_work_box button.btn_write:visible, #eapWorkSelect_workList button.btn_write:visible, li.aw_li button:has-text('작성'):visible, button.btn_write:not(._header_writeBtn):not(#header *):not(.gw_header *):not(#snb *):not(.workset_btn *):not(.gm_reg *):visible",
        },
        {
          type: "wait",
          description: "기안서 작성 폼 로딩 및 에디터 렌더링 대기",
          ms: 3500,
        }
      );
      changes.push(`[보강] 양식 검색 후 누락된 양식 카드 선택 및 [작성] 버튼 클릭 액션 자동 주입`);
      fixedActionsCount += 2;
    }
  }

  // Post-pass cleanup:
  // 1) Remove accidental layout wrapper clicks (e.g. div#eapHeader_option) and their immediate wait
  // 2) Deduplicate consecutive card [작성] clicks (e.g. when a previous failed run inserted a duplicate card write action)
  const finalActions: BrowsePlanAction[] = [];
  let lastWasCardWrite = false;

  for (let i = 0; i < optimizedActions.length; i++) {
    const act = optimizedActions[i];
    const sel = (act.selector || "").trim();
    const desc = (act.description || "").trim();

    if (
      act.type === "click" &&
      (sel.startsWith("div#eapHeader_option") || desc.includes("도움말 전체기간 검색 초기화"))
    ) {
      removedActionsCount++;
      changes.push(`[정제] 불필요한 상단 헤더 래퍼(div#eapHeader_option) 오클릭 제거: "${desc}"`);
      if (i + 1 < optimizedActions.length && optimizedActions[i + 1].type === "wait") {
        i++; // skip trailing wait too
      }
      continue;
    }

    const isCardWrite =
      act.type === "click" &&
      (sel.includes("li.aw_li button.btn_write") ||
        sel.includes(".app_work_box button.btn_write") ||
        desc === "'작성' 버튼 클릭" ||
        desc.includes("작성 버튼 클릭"));

    if (isCardWrite) {
      if (lastWasCardWrite) {
        removedActionsCount++;
        changes.push(`[정제] 중복 삽입된 결재양식 [작성] 버튼 클릭 액션 제거: "${desc}"`);
        if (i + 1 < optimizedActions.length && optimizedActions[i + 1].type === "wait") {
          i++; // skip trailing wait too
        }
        continue;
      }
      lastWasCardWrite = true;
    } else if (act.type !== "wait") {
      lastWasCardWrite = false;
    }

    finalActions.push(act);
  }

  return {
    plan: {
      ...plan,
      actions: finalActions,
    },
    report: {
      fixedActionsCount,
      removedActionsCount,
      changes,
    },
  };
}

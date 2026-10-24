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
export function splitSelectorCandidates(s: string): string[] {
  if (!s) return [];
  const result: string[] = [];
  let cur = "";
  let inSingle = false;
  let inDouble = false;
  let parenDepth = 0;
  let bracketDepth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "'" && !inDouble && s[i - 1] !== "\\") inSingle = !inSingle;
    else if (ch === '"' && !inSingle && s[i - 1] !== "\\") inDouble = !inDouble;
    else if (!inSingle && !inDouble) {
      if (ch === "(") parenDepth++;
      else if (ch === ")" && parenDepth > 0) parenDepth--;
      else if (ch === "[") bracketDepth++;
      else if (ch === "]" && bracketDepth > 0) bracketDepth--;
      else if (ch === "," && parenDepth === 0 && bracketDepth === 0) {
        if (cur.trim()) result.push(cur.trim());
        cur = "";
        continue;
      }
    }
    cur += ch;
  }
  if (cur.trim()) result.push(cur.trim());
  return result;
}

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

  // Pre-scan the scenario timeline in two passes to build a universal Entity ID -> Human-Readable Name map
  // so that even if an item created during demonstration (with a dynamic DB ID) was deleted and
  // recreated with a new ID during recording, subsequent actions referencing the old ID can
  // automatically scope by the item's human-readable name/title before falling back to generic selectors.
  const entityIdToNameMap = new Map<string, string>();
  {
    const genericActionWords =
      /^(?:목록|삭제|수정|작성|옵션|저장|확인|취소|선택|등록|추가|설정|더보기|메뉴|닫기|조회|검색|파일|첨부|초기화|인쇄|별표|비우기|조직도)$/i;

    // Pass 1: Bind IDs directly from explicit data-*-name/subject/title attributes, non-generic inner text, or parent selector [data-*-id] on the same action
    for (const act of actualPlan.actions) {
      const rawHtml = (act.targetHtml || "").trim();
      const rawSel = (act.selector || "").trim();
      const openTagM = rawHtml.match(/^<([a-zA-Z0-9]+)([^<>]*)/);
      const openAttrs = openTagM ? openTagM[2] : "";
      const idMatches = [
        ...Array.from(openAttrs.matchAll(/\b(data-[a-zA-Z0-9_-]*id)=["']([^"']+)["']/gi)),
        ...Array.from(rawSel.matchAll(/\[(data-[a-zA-Z0-9_-]*id)=['"]([^'"]+)['"]\]/gi)),
      ];
      if (idMatches.length === 0) continue;

      const explicitNameMatch = openAttrs.match(
        /\bdata-(?!folder-name|menu-name)(?:[a-zA-Z0-9_-]*name|subject|title)=["']([^"']+)["']/i
      );
      const explicitName = explicitNameMatch ? explicitNameMatch[1].replace(/'/g, "").trim() : "";

      const innerTxt = rawHtml
        .replace(/^<[^>]+>/, "")
        .replace(/<\/[a-zA-Z0-9]+>$/i, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .replace(/'/g, "")
        .trim();

      const rowScopedNameM = rawSel.match(/\b(?:li|tr):has-text\(['"]([^'"]{2,40})['"]\)/i);
      const rowScopedName = rowScopedNameM ? rowScopedNameM[1].trim() : "";

      for (const im of idMatches) {
        const attrKey = im[1].toLowerCase();
        const idVal = im[2].trim();
        if (
          idVal.length < 5 ||
          /^(?:ROOT|empty|none|null|true|false)$/i.test(idVal) ||
          attrKey === "data-menu-id" ||
          attrKey === "data-folder-id" ||
          attrKey === "data-up-page-id"
        ) {
          continue;
        }
        if (explicitName && explicitName.length >= 2 && explicitName.length <= 40) {
          entityIdToNameMap.set(idVal, explicitName);
        } else if (
          innerTxt &&
          innerTxt.length >= 2 &&
          innerTxt.length <= 35 &&
          !genericActionWords.test(innerTxt) &&
          !/\d{4}-\d{2}-\d{2}/.test(innerTxt)
        ) {
          entityIdToNameMap.set(idVal, innerTxt);
        } else if (
          rowScopedName &&
          rowScopedName.length >= 2 &&
          !genericActionWords.test(rowScopedName)
        ) {
          entityIdToNameMap.set(idVal, rowScopedName);
        }
      }
    }

    // Pass 2: For any newly created entity ID that had no explicit name/innerTxt in Pass 1,
    // correlate it with the most recent title/subject typed AFTER all pre-existing IDs
    let lastTypedEntityTitle = "";
    const preCreationSeenIds = new Set<string>();
    const currentRunIdsBeforeType = new Set<string>();
    for (const act of actualPlan.actions) {
      const rawHtml = (act.targetHtml || "").trim();
      const rawSel = (act.selector || "").trim();
      const openTagM = rawHtml.match(/^<([a-zA-Z0-9]+)([^<>]*)/);
      const openAttrs = openTagM ? openTagM[2] : "";
      const idMatches = [
        ...Array.from(openAttrs.matchAll(/\b(data-[a-zA-Z0-9_-]*id)=["']([^"']+)["']/gi)),
        ...Array.from(rawSel.matchAll(/\[(data-[a-zA-Z0-9_-]*id)=['"]([^'"]+)['"]\]/gi)),
      ];

      if (act.type === "type" && act.text && act.text.trim()) {
        const cleanTxt = act.text.replace(/\s*↵\s*/g, "\n").trim();
        const combinedCtx = `${act.selector || ""} ${act.description || ""} ${act.targetHtml || ""}`;
        const isSearchField = /(?:search|srch|검색|schword)/i.test(combinedCtx);
        const isBodyOrCommentEditor =
          cleanTxt.includes("\n") ||
          /(?:ProseMirror|se-contents|bn-editor|ck-editor|npage_editor|본문|내용|댓글|의견|cmnt|comment|mentiony|cmmAiChat|프롬프트)/i.test(
            combinedCtx
          );
        const isTitleOrNameField =
          /(?:제목|주제|업무명|일정명|폴더명|분류명|그룹명|라벨명|태그명|캘린더명|자원명|프로젝트명|스페이스명|위키명|subject|title|bookName|brdName|fldName|wksName|prjName|cldrName)/i.test(
            combinedCtx
          );
        if (!isSearchField && !isBodyOrCommentEditor && isTitleOrNameField && cleanTxt.length >= 2 && cleanTxt.length <= 40) {
          lastTypedEntityTitle = cleanTxt.replace(/'/g, "");
          for (const seenId of currentRunIdsBeforeType) {
            preCreationSeenIds.add(seenId);
          }
        }
      }

      for (const im of idMatches) {
        const attrKey = im[1].toLowerCase();
        const idVal = im[2].trim();
        if (
          idVal.length < 5 ||
          /^(?:ROOT|empty|none|null|true|false)$/i.test(idVal) ||
          attrKey === "data-menu-id" ||
          attrKey === "data-folder-id" ||
          attrKey === "data-up-page-id"
        ) {
          continue;
        }
        currentRunIdsBeforeType.add(idVal);
        if (!entityIdToNameMap.has(idVal) && !preCreationSeenIds.has(idVal) && lastTypedEntityTitle) {
          entityIdToNameMap.set(idVal, lastTypedEntityTitle);
        }
      }
    }
  }

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

    // Strip transient Dynatree / Fancytree / jQuery UI / Select2 / TouchPunch / Checkbox runtime classes that change depending on UI state or match every tree item
    s = s.replace(
      /\.(?:_punchHandle|chkbox_on|rdobtn_on|ico_chk_on|dynatree-(?:expanded|has-children|folder|lastsib|focused|active|selected|partsel|loading|statusnode|exp-[a-zA-Z0-9_-]+|ico-[a-zA-Z0-9_-]+)|fancytree-(?:expanded|has-children|folder|lastsib|focused|active|selected|partsel|loading|statusnode|exp-[a-zA-Z0-9_-]+|ico-[a-zA-Z0-9_-]+)|ui-state-(?:hover|focus|active|highlight)|select2-(?:focused|active|dropdown-open|container-active|drop-above))\b/g,
      ""
    );

    // Decode HTML entities inside :text-is(...), :has-text(...), and [title=...] (e.g. &nbsp; -> space, &gt; -> >)
    const decodeHtmlEntities = (str: string): string =>
      str
        .replace(/&nbsp;/gi, " ")
        .replace(/&#160;/g, " ")
        .replace(/&gt;/gi, ">")
        .replace(/&lt;/gi, "<")
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/gi, "&");

    s = s.replace(/(:(?:text-is|has-text)\(['"])([^'"]+)(['"]\))/g, (_m, pre, txt, post) => {
      const cleanedTxt = decodeHtmlEntities(txt).replace(/^>\s*/, "").replace(/\s+/g, " ").trim();
      return `${pre}${cleanedTxt}${post}`;
    });
    s = s.replace(/(\[title\*?=['"])([^'"]+)(['"]\])/g, (_m, pre, txt, post) => {
      const cleanedTxt = decodeHtmlEntities(txt).replace(/\s+/g, " ").trim();
      return `${pre}${cleanedTxt}${post}`;
    });

    // Convert invalid CSS numeric-leading class selectors (e.g. dd.0220 -> dd[class~='0220'])
    s = s.replace(/\b([a-zA-Z][a-zA-Z0-9_-]*)\.([0-9][a-zA-Z0-9_-]*)/g, "$1[class~='$2']");

    // Filter out dummy onclick='return false;' candidates, fix inverted .ui-dialog:visible prefixes, and strip erroneous #header prefixes on content/form elements
    const parts = splitSelectorCandidates(s)
      .filter((p) => !/\[onclick\*=['"]?(?:return\s+(?:false|true)|javascript:|void\s*\(0\))/i.test(p))
      .map((p) => {
        let cleaned = p;
        // Fix inverted prefix like "div#eapLineSelect_lineTrgtAdd .ui-dialog:visible button..." -> ".ui-dialog:visible div#eapLineSelect_lineTrgtAdd button..."
        cleaned = cleaned.replace(/^([a-zA-Z0-9]*#[a-zA-Z0-9_-]+)\s+\.ui-dialog:visible\s+/, ".ui-dialog:visible $1 ");
        if (
          cleaned.startsWith("#header ") &&
          /(input\[name|textarea|a:has-text\(['"]결재선|button:has-text\(['"]결재선|button\.btn\.btn_pri|a\.sub\._doc|#eapDocReg_|#eapWorkSelect_|eapHeader_option|_search_option_hide|\._eapSearch|\.tbl_lst|\.lst_type1)/i.test(cleaned)
        ) {
          cleaned = cleaned.replace(/^#header\s+/, "");
        }
        return cleaned;
      });

    return parts.length > 0 ? Array.from(new Set(parts)).join(", ") : s;
  };


  for (let i = 0; i < actualPlan.actions.length; i++) {
    const action = { ...actualPlan.actions[i] };
    let desc = action.description || "";
    let sel = action.selector || "";

    // 0. Ensure wait actions do NOT have selectors
    if (action.type === "wait") {
      delete action.selector;
      sel = "";
    }

    // 0-A. Auto-restore dragAndDrop or upload type if previously overwritten to "click" by older dashboard UI or captured as C:\fakepath\
    if (action.type === "click" && action.sourceSelector && action.targetSelector) {
      action.type = "dragAndDrop";
      changes.push(`[타입 복원] '${desc}' 액션의 sourceSelector/targetSelector를 감지하여 type을 'dragAndDrop'으로 자동 복원했습니다.`);
      fixedActionsCount++;
    } else if (action.type === "click" && action.filePath) {
      action.type = "upload";
      changes.push(`[타입 복원] '${desc}' 액션의 filePath를 감지하여 type을 'upload'로 자동 복원했습니다.`);
      fixedActionsCount++;
    } else if (action.type === "type" && action.text && /^C:\\fakepath\\/i.test(action.text.trim())) {
      const fakeFileName = action.text.trim().replace(/^C:\\fakepath\\/i, "");
      if (i + 1 < actualPlan.actions.length && actualPlan.actions[i + 1].type === "upload") {
        removedActionsCount++;
        if (i + 1 < actualPlan.actions.length && actualPlan.actions[i + 1].type === "wait") {
          i++;
        }
        continue;
      }
      action.type = "upload";
      action.filePath = `data/_uploads/${fakeFileName}`;
      action.text = fakeFileName;
      action.description = desc.replace(/에\s*'C:\\fakepath\\[^']+'\s*입력/i, `에 '${fakeFileName}' 첨부`);
      desc = action.description;
      fixedActionsCount++;
    }

    // 0-B. Remove untrusted synthetic JS clicks on hidden #eapHeader_option / _search_option_hide or whole-page background <article id="document_write"> wrapper
    if (
      action.type === "click" &&
      (sel.includes("eapHeader_option") ||
        sel.includes("_search_option_hide") ||
        desc.includes("도움말 전체기간 검색 초기화") ||
        sel.startsWith("article#document_write") ||
        action.targetHtml?.startsWith('<article id="document_write"'))
    ) {
      changes.push(`[불필요 단계 제거] 비인터랙티브 배경 레이아웃/숨김 요소(${sel.split(",")[0]}) 클릭 단계를 제거했습니다.`);
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

    // Remove previously mis-injected form-card hover steps if the following click is NOT an approval form card (e.g. Wiki/Board button._write)
    if (action.type === "hover" && desc.includes("양식 카드에 마우스 호버")) {
      let nextNonWait: BrowsePlanAction | null = null;
      for (let k = i + 1; k < actualPlan.actions.length; k++) {
        if (actualPlan.actions[k].type !== "wait") {
          nextNonWait = actualPlan.actions[k];
          break;
        }
      }
      const nextSel = (nextNonWait?.selector || "").toLowerCase();
      const nextDesc = (nextNonWait?.description || "").toLowerCase();
      const isNextRealWorkCard =
        nextSel.includes("aw_li") ||
        nextSel.includes("app_work_box") ||
        nextSel.includes("workselect") ||
        nextDesc.includes("양식 카드");
      if (nextNonWait && !isNextRealWorkCard) {
        changes.push(`[불필요 호버 제거] 양식 카드가 아닌 일반 작성 버튼('${nextNonWait.description || ""}') 앞에 잘못 삽입된 양식 카드 호버 단계를 제거했습니다.`);
        removedActionsCount++;
        if (i + 1 < actualPlan.actions.length && actualPlan.actions[i + 1].type === "wait") {
          i++; // Also skip its paired wait step
        }
        continue;
      }
    }

    // Auto-inject preceding hover action ONLY if clicking a genuine hover-revealed approval form card button (inside .app_work_box / li.aw_li)
    if (
      action.type === "click" &&
      ((sel.includes("btn_write") &&
        (sel.includes("aw_li") || sel.includes("app_work_box") || sel.includes("WorkSelect"))) ||
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

    // 1-E. Precision selector refinement from targetHtml & candidate ordering (applies to click, hover, type, and dragAndDrop sourceSelector)
    const refineSelectorString = (rawSel: string, htmlHint?: string): string => {
      if (!rawSel) return rawSel;
      let workingSel = rawSel;

      const decodeEntities = (str: string): string =>
        str
          .replace(/&nbsp;/gi, " ")
          .replace(/&#160;/g, " ")
          .replace(/&gt;/gi, ">")
          .replace(/&lt;/gi, "<")
          .replace(/&quot;/gi, '"')
          .replace(/&#39;/g, "'")
          .replace(/&amp;/gi, "&");

      // Reconstruct legacy 140-char truncated targetHtml where opening tag was sliced at index 140 without closing '>'
      let normalizedHtmlHint = htmlHint ? htmlHint.trim() : "";
      if (normalizedHtmlHint) {
        const closeTagMatch = normalizedHtmlHint.match(/<\/([a-zA-Z0-9]+)>$/);
        if (closeTagMatch) {
          const beforeClose = normalizedHtmlHint.slice(0, normalizedHtmlHint.length - closeTagMatch[0].length);
          if (!beforeClose.includes(">") && beforeClose.length >= 140) {
            let rawOpenPart = beforeClose.slice(0, 140);
            rawOpenPart = rawOpenPart
              .replace(/\s+[a-zA-Z0-9_:-]+=["'][^"']*$/, "")
              .replace(/\s+[a-zA-Z0-9_:-]+=?$/, "");
            const innerTxtPart = beforeClose.slice(140);
            normalizedHtmlHint = `${rawOpenPart}>${innerTxtPart}${closeTagMatch[0]}`;
          }
        }
      }

      // If this is a 'type' action, normalize any UI '↵' symbols back to '\n', strip pre-existing editor template text captured in targetHtml, and strip self-referential :has-text('<typed text>')
      if (action.type === "type" && action.text && action.text.trim()) {
        if (action.text.includes("↵")) {
          action.text = action.text.replace(/\s*↵\s*/g, "\n");
        }
        const isRichEditorTarget =
          workingSel.includes("se-contents") ||
          workingSel.includes("contenteditable") ||
          workingSel.includes("ProseMirror") ||
          Boolean(normalizedHtmlHint && /se-contents|contenteditable=["']true["']/i.test(normalizedHtmlHint));
        if (isRichEditorTarget && normalizedHtmlHint) {
          // Restore multi-paragraph text if an earlier sanitizer pass mistakenly stripped the user's 1st paragraph from a placeholder <p data-placeholder="...">
          const placeholderMultiParaMatch = normalizedHtmlHint.match(
            /<p\b[^>]*\b(?:data-placeholder|placeholder)=[^>]*>([^<]+)<\/p>\s*<p\b[^>]*>([^<]+)<\/p>/i
          );
          if (placeholderMultiParaMatch && action.editorInsertNewline) {
            const firstUserPara = decodeEntities(placeholderMultiParaMatch[1]).replace(/\u200B/g, "").replace(/\u00a0/g, " ").trim();
            const secondUserPara = decodeEntities(placeholderMultiParaMatch[2]).replace(/\u200B/g, "").replace(/\u00a0/g, " ").trim();
            if (firstUserPara && secondUserPara && action.text.trim() === secondUserPara) {
              const restoredText = `${firstUserPara}\n${secondUserPara}`;
              action.text = restoredText;
              delete action.editorInsertNewline;
              delete action.editorParaIndex;
              if (action.description) {
                action.description = action.description.replace(secondUserPara, `${firstUserPara} ↵ ${secondUserPara}`);
              }
              changes.push(
                `[에디터 다중 문단 복원] 플레이스홀더 문단에서 누락되었던 첫 문단('${firstUserPara}')을 포함하여 전체 입력 텍스트를 복원했습니다.`
              );
            }
          }

          const pMatch = normalizedHtmlHint.match(/<p(\b[^>]*)>([^<]+)/i);
          const firstPAttrs = pMatch ? pMatch[1] : "";
          const hasPlaceholderAttr = /\b(?:data-placeholder|placeholder)=/i.test(firstPAttrs);
          const initParaTxt = pMatch
            ? decodeEntities(pMatch[2]).replace(/\u200B/g, "").replace(/\u00a0/g, " ").trim()
            : "";
          const normActionTxt = action.text.replace(/\u200B/g, "").replace(/\u00a0/g, " ");
          // Only strip initParaTxt if it is a genuine pre-existing form template heading (starts with template marker ■/▶/●/◆/★/▣/※ and is NOT a placeholder paragraph)
          if (
            !hasPlaceholderAttr &&
            /^[■▶●◆★▣※]/.test(initParaTxt) &&
            initParaTxt.length >= 2 &&
            normActionTxt.startsWith(initParaTxt) &&
            normActionTxt.trim() !== initParaTxt
          ) {
            let remainder = normActionTxt.slice(initParaTxt.length);
            const hadNewline = /^\r?\n/.test(remainder);
            remainder = remainder.replace(/^\r?\n/, "").trim();
            if (remainder.length > 0) {
              const oldFormatted = action.text.replace(/\n/g, " ↵ ");
              action.text = remainder;
              action.editorParaIndex = action.editorParaIndex ?? 0;
              if (hadNewline || /^[■▶●◆★▣※]/.test(initParaTxt)) {
                action.editorInsertNewline = true;
              }
              if (action.description) {
                action.description = action.description
                  .replace(oldFormatted, remainder.replace(/\n/g, " ↵ "))
                  .replace(normActionTxt, remainder);
              }
              changes.push(
                `[에디터 기본 양식 분리] 에디터 기존 양식 문구('${initParaTxt}')를 제외하고 실제 입력 텍스트('${remainder}')만 타이핑하도록 보정했습니다.`
              );
            }
          }
        }
        const escapedTxt = action.text.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        workingSel = workingSel.replace(new RegExp(`:(?:has-text|text-is)\\(['"]${escapedTxt}['"]\\)`, "g"), "");
      }

      let rawParts = splitSelectorCandidates(workingSel);
      const hasModalScope = rawParts.some((p) => p.startsWith(".ui-dialog"));
      const modalPrefix = hasModalScope ? ".ui-dialog:visible " : "";

      // (a) If target is a .dynatree-title node, place :text-is('...') and :has-text('...') FIRST,
      // and ALWAYS pair [title='...'] with :has-text('...') so a department path title (e.g. title='유니슨 그룹>유니슨>테스트 부서' on user test002)
      // never matches the department folder ('테스트 부서') instead of the user node ('test002')!
      if (workingSel.includes("dynatree-title") || (normalizedHtmlHint && normalizedHtmlHint.includes("dynatree-title"))) {
        const outerOpenMatch = normalizedHtmlHint.match(/^<[a-zA-Z0-9]+([^<>]*)/);
        const outerOpenAttrs = outerOpenMatch ? outerOpenMatch[1] : "";
        const htmlTitleMatch = outerOpenAttrs.match(/\btitle=["']([^"']+)["']/i);
        const selTitleMatch = workingSel.match(/dynatree-title\[title=['"]([^'"]+)['"]\]/i);
        const strippedInnerHtmlText = normalizedHtmlHint
          ? decodeEntities(
              normalizedHtmlHint
                .replace(/^<[^>]+>/, "")
                .replace(/<\/[a-zA-Z0-9]+>$/i, "")
                .replace(/<[^>]+>/g, " ")
            )
              .replace(/\s+/g, " ")
              .trim()
          : "";
        const selTextMatch =
          workingSel.match(/dynatree-title[^,]*:(?:has-text|text-is)\(['"]([^'"]+)['"]\)/) ||
          workingSel.match(/:(?:has-text|text-is)\(['"]([^'"]+)['"]\)/);
        const descTextMatch = desc.match(/트리\s*['"]([^'"]+)['"]/);

        const exactTitle = decodeEntities(htmlTitleMatch ? htmlTitleMatch[1] : selTitleMatch ? selTitleMatch[1] : "")
          .replace(/'/g, "")
          .replace(/\s+/g, " ")
          .trim();
        const exactText = decodeEntities(
          strippedInnerHtmlText
            ? strippedInnerHtmlText
            : selTextMatch
            ? selTextMatch[1]
            : descTextMatch
            ? descTextMatch[1]
            : ""
        )
          .replace(/'/g, "")
          .replace(/\s+/g, " ")
          .trim();

        // Upgrade any bare a.dynatree-title[title='...']:visible in rawParts so it includes :has-text(exactText)
        if (exactText) {
          rawParts = rawParts.map((part) => {
            if (
              part.includes("dynatree-title[title=") &&
              !part.includes(":has-text(") &&
              !part.includes(":text-is(")
            ) {
              return part.replace(/(:visible)?$/, `:has-text('${exactText}'):visible`);
            }
            return part;
          });
        }

        const treePriority: string[] = [];
        if (exactText) {
          treePriority.push(`${modalPrefix}.dynatree-title:text-is('${exactText}'):visible`);
          treePriority.push(`${modalPrefix}.dynatree-title:has-text('${exactText}'):visible`);
          const firstTok = exactText.split(/\s+/)[0];
          if (firstTok && firstTok.length >= 2 && firstTok !== exactText) {
            treePriority.push(`${modalPrefix}.dynatree-title:has-text('${firstTok}'):visible`);
          }
          if (exactTitle) {
            treePriority.push(`${modalPrefix}a.dynatree-title[title='${exactTitle}']:has-text('${exactText}'):visible`);
          }
        } else if (exactTitle) {
          treePriority.push(`${modalPrefix}a.dynatree-title[title='${exactTitle}']:visible`);
        }

        if (treePriority.length > 0) {
          workingSel = Array.from(new Set([...treePriority, ...rawParts])).join(", ");
        }
      }

      // (b) Extract attributes strictly from the OUTER opening tag of normalizedHtmlHint (never confusing data-*-id or nested child <input id> with outer id!)
      if (normalizedHtmlHint) {
        const openTagMatch = normalizedHtmlHint.match(/^<([a-zA-Z0-9]+)([^<>]*)/);
        const tagName = openTagMatch ? openTagMatch[1].toLowerCase() : "";
        const rawOpenTagAttrs = openTagMatch ? openTagMatch[2] : "";
        const hasTooltipCacheAttr = /\b(?:oldtitle|data-original-title|data-qtip)=/i.test(rawOpenTagAttrs);
        // Strip qTip2 / Bootstrap tooltip cached HTML attributes (oldtitle, data-original-title, data-qtip)
        // which often contain entity-encoded inner HTML like "<div title='진행' ...>" or truncated trailing attributes,
        // preventing false-positive title="..." or id="..." extraction!
        const openTagAttrs = rawOpenTagAttrs
          .replace(/\s+(?:oldtitle|data-original-title|data-qtip|aria-describedby)=["'][^"']*["']/gi, "")
          .replace(/\s+(?:oldtitle|data-original-title|data-qtip|aria-describedby)=["'][^"']*$/gi, "");
        const innerHtmlAfterOpen = openTagMatch
          ? normalizedHtmlHint.slice(openTagMatch[0].length).replace(/^\s*>/, "")
          : "";
        const innerTextClean = decodeEntities(
          innerHtmlAfterOpen
            .replace(/<\/[a-zA-Z0-9]+>\s*$/i, "")
            .replace(/<[^>]+>/g, " ")
        )
          .replace(/'/g, "")
          .replace(/\s+/g, " ")
          .trim();

        // Strip previously mis-injected #wikiMain_snb prefixes on non-sidebar elements (e.g. _page links or admin nav tabs)
        if (
          workingSel.includes("#wikiMain_snb ") &&
          !openTagAttrs.includes("_menu") &&
          !workingSel.includes("wikiSideMenu")
        ) {
          const strippedSnbParts = splitSelectorCandidates(workingSel).map((p) =>
            p.replace(/^(\.ui-dialog:visible\s+)?#wikiMain_snb\s+/, "$1")
          );
          workingSel = Array.from(new Set(strippedSnbParts)).join(", ");
        }

        const rawIdContainerMatch = workingSel.match(
          /(?:^|,\s*)(?:\.ui-dialog:visible\s+)?([a-zA-Z0-9]*#[a-zA-Z0-9_-]+)\s+(?:>\s*)?[a-zA-Z0-9_.\[#]/
        );
        const matchedContainerToken = rawIdContainerMatch ? rawIdContainerMatch[1].replace(/^\.ui-dialog:visible\s+/, "") : "";
        const idContainerPrefix =
          matchedContainerToken && !/#th\d+$/i.test(matchedContainerToken)
            ? `${modalPrefix}${matchedContainerToken} `
            : modalPrefix;

        const classAttrMatch = openTagAttrs.match(/\bclass=["']([^"']+)["']/i);
        const classTokens = classAttrMatch ? classAttrMatch[1].split(/\s+/).filter(Boolean) : [];
        const hasClassAttrInHtml = Boolean(classAttrMatch);

        // Strip AI-corrupted candidates in workingSel whose terminal tag or terminal classes contradict targetHtml
        if (
          (action.type === "click" || action.type === "hover") &&
          (tagName === "button" || tagName === "a" || tagName === "select" || tagName === "textarea")
        ) {
          const extractLastSegment = (cand: string): string => {
            let core = cand
              .replace(/:visible\s*$/i, "")
              .replace(/:(?:has-text|text-is|has)\([^)]*\)/gi, "")
              .trim();
            let lastSplit = 0;
            let bDepth = 0;
            let pDepth = 0;
            for (let ci = 0; ci < core.length; ci++) {
              const ch = core[ci];
              if (ch === "[") bDepth++;
              else if (ch === "]" && bDepth > 0) bDepth--;
              else if (ch === "(") pDepth++;
              else if (ch === ")" && pDepth > 0) pDepth--;
              else if (bDepth === 0 && pDepth === 0 && (ch === " " || ch === ">")) {
                lastSplit = ci + 1;
              }
            }
            return core.slice(lastSplit).trim();
          };

          const consistentParts = splitSelectorCandidates(workingSel).filter((p) => {
            const termSeg = extractLastSegment(p);
            if (!termSeg) return false;
            const termTagMatch = termSeg.match(/^([a-zA-Z][a-zA-Z0-9]*)/);
            if (termTagMatch && termTagMatch[1].toLowerCase() !== tagName) {
              return false;
            }
            if (hasClassAttrInHtml) {
              const segWithoutAttrs = termSeg.replace(/\[[^\]]*\]/g, "").replace(/:[a-zA-Z-]+(?:\([^)]*\))?/g, "");
              const termClasses = Array.from(segWithoutAttrs.matchAll(/\.([a-zA-Z0-9_-]+)/g)).map((m) => m[1]);
              for (const tc of termClasses) {
                if (!classTokens.includes(tc) && !/^(?:active|on|focus|hover|selected|unfd|trs)$/i.test(tc)) {
                  return false;
                }
              }
            }
            return true;
          });
          workingSel = consistentParts.join(", ");
        }

        // Strict outer tag id="..." match (requires leading whitespace, never matching data-menu-id or data-book-id!)
        const idAttrMatch = openTagAttrs.match(/(?:^|\s)id=["']([^"']+)["']/i);
        const outerIdVal = idAttrMatch ? idAttrMatch[1].trim() : "";

        // Detect any data-*-id values on the outer tag or nested <input id="..."> / <ul id="..."> inside a <label>/<a>/<button>/<td> that may have polluted workingSel as bogus #id
        const dataIdVals = Array.from(openTagAttrs.matchAll(/\bdata-[a-z0-9-]+-id=["']([^"']+)["']/gi)).map((m) => m[1].trim());
        const childAnyIdMatch =
          (tagName === "label" || tagName === "a" || tagName === "button" || tagName === "td" || tagName === "span") && !outerIdVal
            ? innerHtmlAfterOpen.match(/<[a-zA-Z0-9]+\b[^<>]*?(?:^|\s)id=["']([^"']+)["']/i)
            : null;
        const childInputId = childAnyIdMatch ? childAnyIdMatch[1].trim() : "";

        if (dataIdVals.length > 0 || childInputId) {
          const bogusIds = new Set<string>([
            ...dataIdVals.filter((v) => v !== outerIdVal),
            ...(childInputId ? [childInputId] : []),
          ]);
          if (bogusIds.size > 0) {
            const cleanedParts = splitSelectorCandidates(workingSel)
              .filter((p) => {
                for (const bId of bogusIds) {
                  if (
                    p === `#${bId}:visible` ||
                    p === `#${bId}` ||
                    p === `${tagName}#${bId}:visible` ||
                    p === `${tagName}#${bId}` ||
                    p === `.ui-dialog:visible #${bId}:visible` ||
                    p === `.ui-dialog:visible ${tagName}#${bId}:visible`
                  ) {
                    return false;
                  }
                }
                return true;
              });
            if (cleanedParts.length > 0) {
              workingSel = cleanedParts.join(", ");
            }
          }
        }

        // Extract outer for="..." attribute on <label> (e.g. <label for="rb2">제목</label> in ul.drop_menu or form controls)
        if (tagName === "label") {
          const forAttrMatch = openTagAttrs.match(/(?:^|\s)for=["']([^"']+)["']/i);
          const outerForVal = forAttrMatch ? forAttrMatch[1].replace(/'/g, "").trim() : "";
          if (outerForVal && outerForVal.length >= 2 && outerForVal.length <= 64 && !/^(th\d+|[0-9]+)$/i.test(outerForVal)) {
            const currentParts = splitSelectorCandidates(workingSel);
            const forCands: string[] = [];
            if (idContainerPrefix !== modalPrefix) {
              forCands.push(`${idContainerPrefix}label[for='${outerForVal}']:visible`);
            }
            forCands.push(`${modalPrefix}label[for='${outerForVal}']:visible`);
            workingSel = Array.from(new Set([...forCands, ...currentParts])).join(", ");
          }
        }

        // Extract outer name="..." attribute and remove any contradicted [name='...'] in workingSel
        // Never prepend bare [name='...'] for radio/checkbox inputs where all options share the same name!
        const nameAttrMatch = openTagAttrs.match(/(?:^|\s)name=["']([^"']+)["']/i);
        const outerNameVal = nameAttrMatch ? nameAttrMatch[1].replace(/'/g, "").trim() : "";
        const outerTypeMatch = openTagAttrs.match(/(?:^|\s)type=["']([^"']+)["']/i);
        const outerTypeVal = outerTypeMatch ? outerTypeMatch[1].toLowerCase().trim() : "";
        const outerValMatch = openTagAttrs.match(/(?:^|\s)value=["']([^"']+)["']/i);
        const outerValueVal = outerValMatch ? outerValMatch[1].replace(/'/g, "").trim() : "";
        const isOuterRadioOrCheckbox = tagName === "input" && (outerTypeVal === "radio" || outerTypeVal === "checkbox");

        if (outerNameVal && !/^(th\d+|[0-9]+|.*_ko)$/i.test(outerNameVal)) {
          const currentParts = splitSelectorCandidates(workingSel)
            .filter((p) => {
              const m = p.match(/\[name=['"]([^'"]+)['"]\]/i);
              if (m && m[1] !== outerNameVal) return false;
              // Also remove bare input[name='...']:visible if it's a radio/checkbox without [value=...]
              if (isOuterRadioOrCheckbox && m && !p.includes("[value=") && !p.includes(":has(")) return false;
              return true;
            });
          if (isOuterRadioOrCheckbox) {
            if (outerValueVal && outerValueVal.length <= 35 && !/^(on|true|false|y|n|1|0)$/i.test(outerValueVal)) {
              const nameValCand = `${modalPrefix}input[name='${outerNameVal}'][value='${outerValueVal}']:visible`;
              workingSel = Array.from(new Set([nameValCand, ...currentParts])).join(", ");
            } else if (currentParts.length > 0) {
              workingSel = currentParts.join(", ");
            }
          } else {
            const nameCand = `${modalPrefix}${tagName ? `${tagName}[name='${outerNameVal}']` : `[name='${outerNameVal}']`}:visible`;
            workingSel = Array.from(new Set([nameCand, ...currentParts])).join(", ");
          }
        }

        // Extract outer title="..." attribute when specific (e.g. <a title="중요도5">5</a>) and place at the FRONT!
        const titleAttrMatch = openTagAttrs.match(/(?:^|\s)title=["']([^"']+)["']/i);
        const outerTitleVal = titleAttrMatch ? decodeEntities(titleAttrMatch[1]).replace(/'/g, "").replace(/\s+/g, " ").trim() : "";
        if (hasTooltipCacheAttr) {
          const cleanedTooltipParts = splitSelectorCandidates(workingSel).filter((p) => {
            const tm = p.match(/\[title=['"]([^'"]+)['"]\]/i);
            if (tm && tm[1] !== outerTitleVal) return false;
            return true;
          });
          if (cleanedTooltipParts.length > 0) {
            workingSel = cleanedTooltipParts.join(", ");
          }
        }
        const isGenericSharedTitle =
          /^(선택|체크|검색|초기화|삭제|수정|인쇄|별표|설정|관리|등록|추가|확인|취소|닫기|조직도|목록|조회|저장|옵션|비우기|접기\/펴기)$/i.test(
            outerTitleVal
          );
        if (
          outerTitleVal &&
          outerTitleVal.length >= 2 &&
          outerTitleVal.length <= 30 &&
          !/^(선택|체크)$/i.test(outerTitleVal) &&
          !openTagAttrs.includes("dynatree-title") &&
          tagName !== "input"
        ) {
          const currentParts = splitSelectorCandidates(workingSel);
          const alreadyHasTitleSel = currentParts.some((p) => p.includes(`[title='${outerTitleVal}']`));
          const clsAttrForTitle = openTagAttrs.match(/\bclass=["']([^"']+)["']/i);
          const semClsForTitle = clsAttrForTitle
            ? clsAttrForTitle[1]
                .split(/\s+/)
                .find(
                  (c) =>
                    /^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(c) &&
                    !/^(btn|btn_ico|btn_pri|btn_med|btn_sml|btn_lar|btn_block|item|ico|active|selected|on|hover|focus|chkbox|rdobtn|_punchHandle)$/i.test(c)
                )
            : "";
          const titleCandidates: string[] = [];
          if (semClsForTitle) {
            titleCandidates.push(`${idContainerPrefix}${tagName}.${semClsForTitle}[title='${outerTitleVal}']:visible`);
          }
          if (!isGenericSharedTitle || idContainerPrefix !== modalPrefix) {
            titleCandidates.push(`${idContainerPrefix}${tagName}[title='${outerTitleVal}']:visible`);
          }
          if (!isGenericSharedTitle && !alreadyHasTitleSel && idContainerPrefix !== modalPrefix) {
            titleCandidates.push(`${modalPrefix}${tagName}[title='${outerTitleVal}']:visible`);
          }
          if (titleCandidates.length > 0) {
            workingSel = Array.from(new Set([...titleCandidates, ...currentParts])).join(", ");
          }
        }

        // Strip any previously poisoned onclick*='if(' or checkedEditMode candidates
        if (workingSel.includes("onclick*='if(") || workingSel.includes("checkedEditMode")) {
          const cleanedOnclickParts = splitSelectorCandidates(workingSel).filter(
            (p) => !p.includes("onclick*='if(") && !p.includes("checkedEditMode")
          );
          if (cleanedOnclickParts.length > 0) {
            workingSel = cleanedOnclickParts.join(", ");
          }
        }

        // Extract specific goPage('/ekp/scr/...') target or JS handler function (e.g. GwMainMenu.fn.goLogout()) from onclick attribute
        const onclickAttrMatch = openTagAttrs.match(/\bonclick=(?:"([^"]*)"|'([^']*)')/i);
        const onclickVal = (onclickAttrMatch?.[1] ?? onclickAttrMatch?.[2] ?? "").trim();
        const onclickScrMatch = onclickVal.match(/(\/ekp\/(?:scr|view)\/[a-zA-Z0-9_/?=&.-]+)/i);
        const onclickFnMatch = onclickVal.match(/^\s*([a-zA-Z0-9_$.]+\s*\([^"';)]*\))/i);
        if (onclickScrMatch && onclickScrMatch[1]) {
          const scrPath = onclickScrMatch[1];
          const currentParts = splitSelectorCandidates(workingSel);
          const onclickCandidates = [
            ...(outerTitleVal
              ? [
                  `${idContainerPrefix}${tagName}[title='${outerTitleVal}'][onclick*='${scrPath}']:visible`,
                  `${idContainerPrefix}${tagName}[title='${outerTitleVal}']:visible`,
                ]
              : []),
            `${idContainerPrefix}${tagName}[onclick*='${scrPath}']:visible`,
            ...(idContainerPrefix !== modalPrefix ? [`${modalPrefix}${tagName}[onclick*='${scrPath}']:visible`] : []),
          ];
          workingSel = Array.from(new Set([...onclickCandidates, ...currentParts])).join(", ");
        } else if (onclickFnMatch && onclickFnMatch[1]) {
          const fnCall = onclickFnMatch[1].replace(/'/g, "").trim();
          if (
            fnCall &&
            !/^(javascript:|return\b|void\b|if\s*\(|for\s*\(|while\s*\(|switch\s*\()/i.test(fnCall) &&
            !fnCall.includes("checkedEditMode")
          ) {
            const currentParts = splitSelectorCandidates(workingSel);
            const onclickCandidates = [
              `${idContainerPrefix}${tagName}[onclick*='${fnCall}']:visible`,
              ...(idContainerPrefix !== modalPrefix ? [`${modalPrefix}${tagName}[onclick*='${fnCall}']:visible`] : []),
            ];
            workingSel = Array.from(new Set([...onclickCandidates, ...currentParts])).join(", ");
          }
        }

        const ignoredDataAttrRegex =
          /^data-(?:toggle|dismiss|backdrop|keyboard|spy|ride|slide|placement|original-title|qtip|tooltip|placeholder|i18n|bind|reactid|v-)/i;
        const tier3SharedAttrRegex =
          /^data-(?!app-type-se$|app-type-ordr$|search-type$)(?:.*status|.*type|.*mode|.*yn|up-.*|parent-.*|reg-emp-id)$/i;
        const hasOwnEntityAttr = /\bdata-(?:book|page|wks|atcl|doc|work|scd|res)-/i.test(openTagAttrs);

        const distinguishingClsTokens = classTokens.filter(
          (c) =>
            /^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(c) &&
            !/^(?:btn|btn_ico|btn_pri|btn_med|btn_sml|btn_lar|btn_block|item|ico|active|selected|on|hover|focus|chkbox|rdobtn|_punchHandle|scvr\d+|plt_\d+|unfd|trs)$/i.test(
              c
            )
        );
        const actionClsSelector =
          (tagName === "button" || tagName === "a") && distinguishingClsTokens.length > 0
            ? "." + distinguishingClsTokens.slice(0, 2).join(".")
            : "";
        const primaryHookOrBtnCls = distinguishingClsTokens.find((c) => c.startsWith("_")) || distinguishingClsTokens[0] || "";

        // Clean existing workingSel of bare Tier-3 shared status/type/parent attributes and qualify shared menu attributes with innerTextClean
        {
          const cleanedExisting = splitSelectorCandidates(workingSel)
            .filter((p) => {
              if (/:has\(\[data-(?:reg-emp-id|.*status|.*type|.*yn)=/i.test(p)) return false;
              const dataM = p.match(/\[(data-[a-zA-Z0-9_-]+)=['"]([^'"]+)['"]\]/i);
              if (dataM) {
                const dName = dataM[1].toLowerCase();
                const dVal = dataM[2].trim();
                const hasTextQual = /:(?:has-text|text-is)\(/i.test(p);
                if (!hasTextQual && (tier3SharedAttrRegex.test(dName) || dVal === "ROOT" || dVal.endsWith("/ROOT"))) {
                  return false;
                }
                if (
                  !hasTextQual &&
                  hasOwnEntityAttr &&
                  (dName === "data-folder-id" || dName === "data-folder-name")
                ) {
                  return false;
                }
              }
              return true;
            })
            .map((p) => {
              // If a menu link has specific visible text (e.g. '회사', '더보기', '최신 페이지') that differs from its shared data-menu-id / data-menu-name, qualify with :has-text
              const menuAttrM = p.match(/\[(data-(?:menu-id|menu-name|folder-id|folder-type|page-mode))=['"]([^'"]+)['"]\]/i);
              if (
                menuAttrM &&
                innerTextClean &&
                innerTextClean.length >= 2 &&
                innerTextClean.length <= 25 &&
                menuAttrM[2].trim() !== innerTextClean &&
                !/:(?:has-text|text-is)\(/i.test(p)
              ) {
                return p.replace(/(:visible)?$/, `:has-text('${innerTextClean}'):visible`);
              }
              // If an action button/link has a distinguishing class (e.g. .btn_del._deleteBook or ._delete), qualify bare tag[data-*-id='...'] so sibling actions on the same entity never collide
              if (
                actionClsSelector &&
                new RegExp(`(?:^|\\s)${tagName}\\[data-[a-z0-9_-]+-id=`, "i").test(p)
              ) {
                return p.replace(
                  new RegExp(`(^|\\s)${tagName}(\\[data-[a-z0-9_-]+-id=)`, "i"),
                  `$1${tagName}${actionClsSelector}$2`
                );
              }
              return p;
            });
          if (cleanedExisting.length > 0) {
            workingSel = cleanedExisting.join(", ");
          }
        }

        const dataAttrMatches = Array.from(
          openTagAttrs.matchAll(/\b(data-[a-zA-Z0-9_-]+)=["']([^"']+)["']/gi)
        ).filter((dm) => !ignoredDataAttrRegex.test(dm[1]));

        const tier1Candidates: string[] = [];
        const tier2Candidates: string[] = [];
        const entityScopedCandidates: string[] = [];
        const resolvedEntityNames = new Set<string>();

        if (dataAttrMatches.length > 0) {
          for (const dm of dataAttrMatches) {
            const attrName = dm[1];
            const attrNameLower = attrName.toLowerCase();
            const attrVal = dm[2].replace(/'/g, "").trim();
            if (!attrVal || attrVal.toLowerCase() === "empty") continue;

            // Skip Tier-3 generic flags/types/ROOT parent IDs and parent folder attrs when item attrs exist
            if (tier3SharedAttrRegex.test(attrNameLower) || attrVal === "ROOT") {
              continue;
            }
            if (hasOwnEntityAttr && (attrNameLower === "data-folder-id" || attrNameLower === "data-folder-name")) {
              continue;
            }

            const isTier1NameOrRole =
              /^data-(?:.*name|subject|title|menu-id|tab|search-type|app-type-se|app-type-ordr)$/i.test(attrNameLower);
            const needsMenuTextQual =
              /^data-(?:menu-id|menu-name)$/i.test(attrNameLower) &&
              innerTextClean &&
              innerTextClean.length >= 2 &&
              innerTextClean.length <= 25 &&
              attrVal !== innerTextClean;
            const textQualSuffix = needsMenuTextQual ? `:has-text('${innerTextClean}')` : "";
            const clsQual =
              actionClsSelector && !/^data-(?:menu-id|menu-name|tab|search-type|app-type-se|app-type-ordr)$/i.test(attrNameLower)
                ? actionClsSelector
                : "";

            const targetBucket = isTier1NameOrRole ? tier1Candidates : tier2Candidates;
            if (clsQual) {
              targetBucket.push(`${idContainerPrefix}${tagName}${clsQual}[${attrName}='${attrVal}']${textQualSuffix}:visible`);
              if (idContainerPrefix !== modalPrefix) {
                targetBucket.push(`${modalPrefix}${tagName}${clsQual}[${attrName}='${attrVal}']${textQualSuffix}:visible`);
              }
            }
            targetBucket.push(`${idContainerPrefix}${tagName}[${attrName}='${attrVal}']${textQualSuffix}:visible`);
            if (idContainerPrefix !== modalPrefix) {
              targetBucket.push(`${modalPrefix}${tagName}[${attrName}='${attrVal}']${textQualSuffix}:visible`);
            }

            if (/^data-(?!folder-name|menu-name)(?:.*name|subject|title)$/i.test(attrNameLower)) {
              resolvedEntityNames.add(attrVal);
            }
            if (attrNameLower.endsWith("-id") && entityIdToNameMap.has(attrVal)) {
              resolvedEntityNames.add(entityIdToNameMap.get(attrVal)!);
            }
          }
        }

        // Cross-Action Entity Name Scoping: When clicking an action button (e.g. '목록', '삭제', '옵션') on an entity whose
        // demonstration ID may change after deletion/re-creation, inject item-scoped (li/tr :has-text(entityName)) candidates
        // right after Tier 1 candidates and BEFORE unscoped generic button fallbacks!
        // Note: Never inject li/tr:has-text(entityName) for <a> items inside dropdown/context menus (e.g. ul#wikiBookContent_context a._delete),
        // because dropdown menu <li> elements only contain the command text ('삭제', '수정'), not the entity title!
        const isDropdownContextMenu =
          tagName === "a" || /(?:context|drop_menu|dropdown|menu_lyr|optn_lyr)/i.test(`${idContainerPrefix} ${workingSel}`);
        if (isDropdownContextMenu && resolvedEntityNames.size > 0) {
          workingSel = splitSelectorCandidates(workingSel)
            .filter((p) => !/\b(?:li|tr):has-text\(['"][^'"]+['"]\)\s+a\b/i.test(p))
            .join(", ");
        }
        if (resolvedEntityNames.size > 0 && tagName === "button" && !isDropdownContextMenu) {
          for (const entName of resolvedEntityNames) {
            if (!entName || entName === innerTextClean || entName === outerTitleVal) continue;
            if (actionClsSelector) {
              if (idContainerPrefix !== modalPrefix) {
                entityScopedCandidates.push(`${idContainerPrefix}li:has-text('${entName}') ${tagName}${actionClsSelector}:visible`);
              }
              entityScopedCandidates.push(`${modalPrefix}li:has-text('${entName}') ${tagName}${actionClsSelector}:visible`);
              if (idContainerPrefix !== modalPrefix) {
                entityScopedCandidates.push(`${idContainerPrefix}tr:has-text('${entName}') ${tagName}${actionClsSelector}:visible`);
              }
              entityScopedCandidates.push(`${modalPrefix}tr:has-text('${entName}') ${tagName}${actionClsSelector}:visible`);
            }
            if (outerTitleVal) {
              if (idContainerPrefix !== modalPrefix) {
                entityScopedCandidates.push(
                  `${idContainerPrefix}li:has-text('${entName}') ${tagName}${primaryHookOrBtnCls ? `.${primaryHookOrBtnCls}` : ""}[title='${outerTitleVal}']:visible`
                );
              }
              entityScopedCandidates.push(
                `${modalPrefix}li:has-text('${entName}') ${tagName}${primaryHookOrBtnCls ? `.${primaryHookOrBtnCls}` : ""}[title='${outerTitleVal}']:visible`
              );
            }
          }
        }

        // Also ensure container-scoped action class / title / text fallbacks are present if workingSel was previously overwritten
        const fallbackClassCandidates: string[] = [];
        if (!outerIdVal && (tagName === "button" || tagName === "a") && actionClsSelector) {
          if (outerTitleVal) {
            fallbackClassCandidates.push(`${idContainerPrefix}${tagName}${actionClsSelector}[title='${outerTitleVal}']:visible`);
          }
          if (innerTextClean && innerTextClean.length >= 1 && innerTextClean.length <= 20) {
            fallbackClassCandidates.push(`${idContainerPrefix}${tagName}${actionClsSelector}:has-text('${innerTextClean}'):visible`);
          }
          if (
            primaryHookOrBtnCls &&
            tagName === "button" &&
            !/^_(?:menu|page|openBook|pageLink|space_wiki|search|write|appendBtn|writeBtn|lineSelect|addBtn|delBtn|selectBtn|setProcess)$/i.test(
              primaryHookOrBtnCls
            )
          ) {
            fallbackClassCandidates.push(`${idContainerPrefix}${tagName}.${primaryHookOrBtnCls}:visible`);
          }
        }

        if (
          tier1Candidates.length > 0 ||
          tier2Candidates.length > 0 ||
          entityScopedCandidates.length > 0 ||
          fallbackClassCandidates.length > 0
        ) {
          const currentParts = splitSelectorCandidates(workingSel);
          // Separate specific existing parts from generic unscoped button fallbacks so entityScopedCandidates always precede unscoped fallbacks
          const specificExisting: string[] = [];
          const genericUnscopedExisting: string[] = [];
          for (const cp of currentParts) {
            const isUnscopedGenericBtn =
              resolvedEntityNames.size > 0 &&
              !cp.includes("data-") &&
              !cp.includes(":has-text(") &&
              !cp.includes(":text-is(");
            if (isUnscopedGenericBtn) {
              genericUnscopedExisting.push(cp);
            } else {
              specificExisting.push(cp);
            }
          }
          workingSel = Array.from(
            new Set([
              ...tier1Candidates,
              ...entityScopedCandidates,
              ...tier2Candidates,
              ...specificExisting,
              ...genericUnscopedExisting,
              ...fallbackClassCandidates,
            ])
          ).join(", ");
        }

        if (classTokens.length > 0) {
          // Numeric-leading slot class (e.g. <dd class="1400"> in resource reservation timetable)
          const numSlotCls = classTokens.find((c) => /^[0-9][a-zA-Z0-9_-]*$/.test(c));
          if (numSlotCls && tagName) {
            const slotCandidates = [
              ...(rawIdContainerMatch ? [`${idContainerPrefix}${tagName}[class~='${numSlotCls}']:visible`] : []),
              `${modalPrefix}${tagName}[class~='${numSlotCls}']:visible`,
            ];
            const currentParts = splitSelectorCandidates(workingSel);
            workingSel = Array.from(new Set([...slotCandidates, ...currentParts])).join(", ");
          }

          // Specific action button classes on <a> or <button> (e.g. btn_logout, btn_login, btn_srch, btn_rfsh)
          if (!outerIdVal && (tagName === "a" || tagName === "button")) {
            const specificBtnCls = classTokens.find((c) =>
              /^btn_(?:logout|login|srch|rfsh|setup|admin)$/i.test(c)
            );
            if (specificBtnCls) {
              const isIconOnlyBtn = /^btn_logout$/i.test(specificBtnCls) || classTokens.includes("btn_ico");
              let currentParts = splitSelectorCandidates(workingSel);
              if (isIconOnlyBtn) {
                currentParts = currentParts.filter((p) => !/:(?:has-text|text-is)\(/i.test(p));
              }
              const btnClsCandidates: string[] = [];
              if (outerTitleVal) {
                btnClsCandidates.push(`${idContainerPrefix}${tagName}.${specificBtnCls}[title='${outerTitleVal}']:visible`);
                if (idContainerPrefix !== modalPrefix) {
                  btnClsCandidates.push(`${modalPrefix}${tagName}.${specificBtnCls}[title='${outerTitleVal}']:visible`);
                }
              }
              btnClsCandidates.push(`${idContainerPrefix}${tagName}.${specificBtnCls}:visible`);
              if (idContainerPrefix !== modalPrefix) {
                btnClsCandidates.push(`${modalPrefix}${tagName}.${specificBtnCls}:visible`);
              }
              workingSel = Array.from(new Set([...btnClsCandidates, ...currentParts])).join(", ");
            }
          }

          if (!outerIdVal && dataAttrMatches.length === 0 && (tagName === "button" || tagName === "input")) {
            const hookClasses = classTokens.filter(
              (c) =>
                /^_[a-zA-Z0-9_-]*(?:btn|button|search|srch|confirm|save|draft|send|write|ok|cancel|close|text|word)[a-zA-Z0-9_-]*$/i.test(c) &&
                !/^_(?:search_option|search|blind|hide|hidden|punchHandle|appendBtn|writeBtn|lineSelect|addBtn|delBtn|selectBtn|setProcess|write)$/i.test(c)
            );
            if (hookClasses.length > 0) {
              const hookCls = hookClasses[0];
              const currentParts = splitSelectorCandidates(workingSel);
              const alreadyHasSpecificTextOrAttr = currentParts.some(
                (p) => /:(?:has-text|text-is)\(|\[(?:title|name|value|data-)/i.test(p)
              );
              const hookCandidates: string[] = [];
              if (rawIdContainerMatch) {
                hookCandidates.push(`${idContainerPrefix}${tagName}.${hookCls}:visible`);
              }
              hookCandidates.push(`${modalPrefix}${tagName}.${hookCls}:visible`);
              // Never prepend an offline-guessed bare ._hook class ahead of live-DOM-verified :has-text / [title] / [data-*] candidates!
              workingSel = alreadyHasSpecificTextOrAttr
                ? Array.from(new Set([...currentParts, ...hookCandidates])).join(", ")
                : Array.from(new Set([...hookCandidates, ...currentParts])).join(", ");
            }
          }
        }

        // Strip previously polluted bare multi-instance hook classes (e.g. button._appendBtn:visible, button._writeBtn:visible, button._search:visible)
        // and shared child icon classes (e.g. button:has(.ico_write):visible, button:has(.ico_org):visible)
        // so they NEVER shadow data-app-type-se='A'/'H'/'X', data-search-type='tool'/'gw', data-tab='appLine', title='협조', or li.aw_li:has-text(...)!
        {
          const rawPartsForClean = splitSelectorCandidates(workingSel);
          const cleanedHookIconParts = rawPartsForClean.filter((p) => {
            if (
              /^(?:\.ui-dialog:visible\s+)?(?:[a-zA-Z0-9]*#[a-zA-Z0-9_-]+\s+)?(?:button|a)\.(?:_(?:appendBtn|writeBtn|lineSelect|addBtn|delBtn|selectBtn|setProcess|write|search|menu|page|openBook|pageLink)|item|sub_cover):visible$/i.test(
                p
              )
            ) {
              return false;
            }
            if (/:has\(\.ico_(?:hide|info|chk|rdo|user|dept|plus|write|org|add|del|fldr|srch|lst|f\d+)\)/i.test(p)) {
              return false;
            }
            return true;
          });
          if (cleanedHookIconParts.length > 0) {
            workingSel = cleanedHookIconParts.join(", ");
          }
        }

        // Strip dynamic random #mentiony-content-xxxxxx / #mentiony-container-xxxxxx IDs generated per session by the mentiony plugin
        if (/^mentiony-/i.test(outerIdVal) || workingSel.includes("mentiony-")) {
          const phMatch = openTagAttrs.match(/\b(?:data-placeholder|placeholder)=["']([^"']+)["']/i);
          const phVal = phMatch ? phMatch[1].replace(/'/g, "").trim() : "";
          const cleanedMentionyParts = splitSelectorCandidates(workingSel).filter(
            (p) => !/#mentiony-(?:content|container|popover|item)-[a-zA-Z0-9_-]+/i.test(p)
          );
          const mentionyCands: string[] = [];
          if (phVal) {
            mentionyCands.push(`${modalPrefix}div.mentiony-content[contenteditable='true'][data-placeholder*='${phVal.slice(0, 15)}']:visible`);
          }
          mentionyCands.push(`${modalPrefix}div.mentiony-content[contenteditable='true']:visible`);
          workingSel = Array.from(new Set([...mentionyCands, ...cleanedMentionyParts])).join(", ");
        }

        // Universal Child Fingerprinting for <label>, <a>, <button>, <td>, or <span> without its own id:
        // prepend tag:has(#childId), tag:has(input[value='...']), or tag:has(.scvr*/.plt_*/._ai*) so it uniquely targets that exact option!
        if ((tagName === "label" || tagName === "a" || tagName === "button" || tagName === "td" || tagName === "span") && !outerIdVal) {
          const isChkbox = /\bchkbox\b/i.test(openTagAttrs);
          const isRdobtn = /\brdobtn\b/i.test(openTagAttrs);
          const isFileBtn = /\bfileinput-button\b/i.test(openTagAttrs);
          const isBotLink = tagName === "a" && /\bbot\b/i.test(openTagAttrs);
          const baseCls =
            tagName === "label"
              ? isChkbox
                ? "label.chkbox"
                : isRdobtn
                  ? "label.rdobtn"
                  : "label"
              : tagName === "span" && isFileBtn
                ? "span.fileinput-button"
                : isBotLink
                  ? "a.bot"
                  : tagName;
          const hasChildCandidates: string[] = [];
          if (childInputId) {
            const isUnstableChildId =
              /^(ui-id-|jqg|ext-gen|select2-|mceu_|cke_|tinymce|mentiony-|th\d+$|[0-9]+$)/i.test(childInputId) ||
              /[0-9a-f]{8,}/i.test(childInputId);
            if (!isUnstableChildId) {
              hasChildCandidates.push(`${modalPrefix}${baseCls}:has(#${childInputId}):visible`);
              if (baseCls !== tagName) {
                hasChildCandidates.push(`${modalPrefix}${tagName}:has(#${childInputId}):visible`);
              }
            }
          }
          const childValMatch = innerHtmlAfterOpen.match(/<input\b[^<>]*?\bvalue=["']([^"']+)["']/i);
          const childVal = childValMatch ? childValMatch[1].replace(/'/g, "").trim() : "";
          const childNameMatch = innerHtmlAfterOpen.match(/<input\b[^<>]*?\bname=["']([^"']+)["']/i);
          const childName = childNameMatch ? childNameMatch[1].replace(/'/g, "").trim() : "";
          if (childVal && childVal.length <= 35 && !/^(on|true|false|y|n|1|0)$/i.test(childVal)) {
            if (childName) {
              hasChildCandidates.push(`${idContainerPrefix}${baseCls}:has(input[name='${childName}'][value='${childVal}']):visible`);
            }
            hasChildCandidates.push(`${idContainerPrefix}${baseCls}:has(input[value='${childVal}']):visible`);
            if (idContainerPrefix !== modalPrefix) {
              hasChildCandidates.push(`${modalPrefix}${baseCls}:has(input[value='${childVal}']):visible`);
            }
          }
          const childDataMatches = Array.from(
            innerHtmlAfterOpen.matchAll(/\b(data-[a-zA-Z0-9_-]+)=["']([^"']+)["']/gi)
          ).filter((dm) => !ignoredDataAttrRegex.test(dm[1]) && !tier3SharedAttrRegex.test(dm[1].toLowerCase()));
          for (const cdm of childDataMatches) {
            const cAttr = cdm[1];
            const cVal = cdm[2].replace(/'/g, "").trim();
            if (cVal && cVal.toLowerCase() !== "empty" && cVal !== "ROOT" && cVal.length <= 35) {
              hasChildCandidates.unshift(`${idContainerPrefix}${baseCls}:has([${cAttr}='${cVal}']):visible`);
            }
          }
          const childDistMatch = innerHtmlAfterOpen.match(/\bclass=["'][^"']*\b(scvr\d+|plt_\d+|_ai[a-zA-Z0-9_]+)\b/i);
          if (childDistMatch && childDistMatch[1]) {
            hasChildCandidates.push(`${idContainerPrefix}${baseCls}:has(.${childDistMatch[1]}):visible`);
            if (idContainerPrefix !== modalPrefix) {
              hasChildCandidates.push(`${modalPrefix}${baseCls}:has(.${childDistMatch[1]}):visible`);
            }
          }
          const childPrimaryNameMatch = innerHtmlAfterOpen.match(
            /<(?:div|span|strong|em|p)\b[^<>]*\bclass=["'][^"']*\b(?:name|tit|subj|title)\b[^"']*["'][^<>]*>([^<>]{2,25})<\//i
          );
          if (childPrimaryNameMatch && childPrimaryNameMatch[1]) {
            const cNameTxt = decodeEntities(childPrimaryNameMatch[1]).replace(/'/g, "").replace(/\s+/g, " ").trim();
            if (cNameTxt.length >= 2) {
              hasChildCandidates.push(`${idContainerPrefix}${baseCls}:has-text('${cNameTxt}'):visible`);
              if (idContainerPrefix !== modalPrefix) {
                hasChildCandidates.push(`${modalPrefix}${baseCls}:has-text('${cNameTxt}'):visible`);
              }
            }
          }
          const currentParts = splitSelectorCandidates(workingSel);
          if (hasChildCandidates.length > 0 || currentParts.length > 0) {
            workingSel = Array.from(new Set([...hasChildCandidates, ...currentParts])).join(", ");
          }
        }

        // Re-assert Tier 1, Entity-Scoped, and Tier 2 candidates right before outerIdVal so they stay ahead of any child/hook candidates!
        if (tier1Candidates.length > 0 || tier2Candidates.length > 0 || entityScopedCandidates.length > 0) {
          const currentParts = splitSelectorCandidates(workingSel);
          workingSel = Array.from(
            new Set([...tier1Candidates, ...entityScopedCandidates, ...tier2Candidates, ...currentParts])
          ).join(", ");
        }

        // Keep stable outerIdVal at the VERY FRONT so unique IDs (e.g. button#notNoteReg_toAddressButton) always precede shared hook classes or [name='...']
        if (outerIdVal) {
          const isUnstableId =
            /^(ui-id-|jqg|ext-gen|select2-|mceu_|cke_|tinymce|mentiony-|th\d+$|dp\d+$|ADRGR\d+$|[0-9]+$)/i.test(outerIdVal) ||
            /[0-9a-f]{8,}/i.test(outerIdVal);
          if (!isUnstableId) {
            let currentParts = splitSelectorCandidates(workingSel);
            // If this is a system alert/confirm button (#naon-cmm-confirm-ok or #naon-cmm-alert-confirm),
            // strip generic .ui-dialog:visible button...:has-text('확인') fallbacks so it NEVER clicks an underlying form modal's confirm button!
            if (/^naon-cmm-(?:confirm-ok|alert-confirm)$/i.test(outerIdVal)) {
              currentParts = currentParts.filter(
                (p) => p.includes(outerIdVal) || p.includes("#alert_lyr") || p.includes("#confirm_lyr")
              );
            }
            const idCandidates = [`${modalPrefix}${tagName ? `${tagName}#${outerIdVal}` : `#${outerIdVal}`}:visible`];
            if (!modalPrefix && tagName) {
              idCandidates.push(`#${outerIdVal}:visible`);
            }
            workingSel = Array.from(new Set([...idCandidates, ...currentParts])).join(", ");
          }
        }
      }

      // (c) Reorder dynamic list candidates so specific :has-text / :text-is / [data-*] / #id-scoped containers come BEFORE positional :nth-of-type(n) or unfiltered list paths
      let currentCandidates = splitSelectorCandidates(workingSel);


      // Remove legacy duplicate #th\d+ or [name='th\d+'] when a row-scoped candidate exists, and demote ephemeral per-record IDs (data-atcl-id, data-folder-id, data-mail-id, data-addr-grpid) behind :has-text / data-addr-grpname
      if (currentCandidates.length > 1) {
        const filteredTh = currentCandidates.filter(
          (c) => !/#th\d+\b/i.test(c) && !/\[name=['"]th\d+['"]\]/i.test(c)
        );
        if (filteredTh.length > 0) {
          currentCandidates = filteredTh;
        }
        const hasTextCandidate = currentCandidates.some(
          (c) =>
            c.includes(":has-text(") ||
            c.includes(":text-is(") ||
            c.includes("data-addr-grpname=") ||
            c.includes("data-task-subject=")
        );
        if (hasTextCandidate) {
          const nonEphemeral = currentCandidates.filter(
            (c) =>
              !/\[data-(?:atcl|folder|mail)-id=|\[data-addr-grpid=|#ADRGR\d+|\[value=['"]TSK[0-9a-zA-Z]{10,}['"]\]/i.test(c)
          );
          if (nonEphemeral.length > 0) {
            currentCandidates = nonEphemeral;
          }
        }
      }

      // Strip erroneous #snb prefix and enforce #wikiMain_snb scope when targeting Wiki main sidebar (#wikiMain_snb / #wikiSideMenu_menuList / data-menu-id='wiki...')
      // so child popup sidebars (wikiBookMain) are never mistaken for the main Wiki sidebar!
      const isWikiSidebarContext =
        normalizedHtmlHint.includes("_menu") &&
        currentCandidates.some((c) => c.includes("wikiSideMenu") || c.includes("wikiMain_snb"));
      if (isWikiSidebarContext) {
        currentCandidates = Array.from(
          new Set(
            currentCandidates.map((c) => {
              const stripped = c.replace(/^#snb\s+/, "");
              if (
                !stripped.includes("#wikiMain_snb") &&
                !stripped.includes("wikiSideMenu") &&
                /^a(?:\.|\[|:)/.test(stripped)
              ) {
                return `#wikiMain_snb ${stripped}`;
              }
              return stripped;
            })
          )
        );
      }

      // Handle Wiki Book Cover Image Selection Popup (ul#wikiBookReg_imgList) where all 28 radio items share the identical placeholder text '주제를 표시합니다.'
      const isWikiImgListContext =
        currentCandidates.some((c) => c.includes("wikiBookReg_imgList") || c.includes("주제를 표시합니다")) ||
        normalizedHtmlHint.includes("wikiBookReg_imgList") ||
        normalizedHtmlHint.includes("주제를 표시합니다");
      if (isWikiImgListContext) {
        let coverNum = "";
        for (const cand of currentCandidates) {
          const nthMatch = cand.match(/wikiBookReg_imgList\s*>\s*li:nth-of-type\((\d+)\)/i);
          if (nthMatch && nthMatch[1]) {
            coverNum = nthMatch[1];
            break;
          }
          const scvrMatch = cand.match(/\bscvr(\d+)\b/i);
          if (scvrMatch && scvrMatch[1]) {
            coverNum = scvrMatch[1];
            break;
          }
        }
        const withoutDuplicatePlaceholderText = currentCandidates.filter(
          (c) =>
            !(
              (c.includes(":has-text('주제를") || c.includes(':has-text("주제를')) &&
              !c.includes(":nth-of-type(") &&
              !c.includes("input[value=") &&
              !c.includes(":has(.scvr")
            )
        );
        if (coverNum) {
          const coverPriority = [
            `.ui-dialog:visible ul#wikiBookReg_imgList label.rdobtn:has(input[value='scvr${coverNum}']):visible`,
            `.ui-dialog:visible ul#wikiBookReg_imgList label.rdobtn:has(.scvr${coverNum}):visible`,
            `.ui-dialog:visible ul#wikiBookReg_imgList > li:nth-of-type(${coverNum}) > label.wiki_sub_box.rdobtn:visible`,
            `ul#wikiBookReg_imgList > li:nth-of-type(${coverNum}) > label.wiki_sub_box.rdobtn:visible`,
          ];
          currentCandidates = Array.from(new Set([...coverPriority, ...withoutDuplicatePlaceholderText]));
        } else if (withoutDuplicatePlaceholderText.length > 0) {
          currentCandidates = withoutDuplicatePlaceholderText;
        }
      }

      // Handle Wiki Book Cover Preview box in registration form (div#wikiBookReg_imgCover / #wikiBookReg_imgCoverSub)
      if (
        currentCandidates.some((c) => c.includes("wikiBookReg_imgCover")) ||
        normalizedHtmlHint.includes("wikiBookReg_imgCoverSub")
      ) {
        currentCandidates = Array.from(
          new Set([
            ...currentCandidates,
            "div#wikiBookReg_imgCover a.sub_cover:visible",
            "a:has(#wikiBookReg_imgCoverSub):visible",
          ])
        );
      }

      // If any candidate has an ancestor [data-trgt-id='...'] (e.g. div.fbox._trgtBox[data-trgt-id='M438014134'] > ... > label.chkbox:visible),
      // synthesize a direct [data-trgt-id='...'] leaf selector at the front and remove unscoped #eapLineSelect_line label.chkbox catch-alls!
      for (const cand of currentCandidates) {
        const trgtMatch = cand.match(/\[data-trgt-id=['"]([^'"]+)['"]\].*>\s*([a-zA-Z0-9_.-]+(?::visible)?)$/);
        if (trgtMatch && trgtMatch[1] && trgtMatch[2]) {
          const trgtId = trgtMatch[1];
          const leafPart = trgtMatch[2].endsWith(":visible") ? trgtMatch[2] : `${trgtMatch[2]}:visible`;
          const scopedTrgt = `${modalPrefix}[data-trgt-id='${trgtId}'] ${leafPart}`;
          currentCandidates = [
            scopedTrgt,
            ...currentCandidates.filter(
              (c) =>
                c !== scopedTrgt &&
                !(c.includes("label.chkbox") && !c.includes("data-trgt-id") && !c.includes(":has-text(") && !c.includes(":has(#"))
            ),
          ];
          break;
        }
      }

      // If a bare tag:has-text('X'):visible coexists with a structural path ending in > parentTag.cls > tag:visible (e.g. div.sub._openBook > a:visible),
      // synthesize parentTag.cls tag:has-text('X'):visible before the bare tag:has-text('X'):visible to avoid clicking a sidebar/header duplicate!
      const bareTagTextCand = currentCandidates.find((c) => /^(?:a|button|span|strong):has-text\(['"][^'"]+['"]\):visible$/.test(c));
      if (bareTagTextCand) {
        const bareMatch = bareTagTextCand.match(/^([a-z]+):has-text\(['"]([^'"]+)['"]\):visible$/);
        if (bareMatch) {
          const leafTag = bareMatch[1];
          const leafText = bareMatch[2];
          for (const cand of currentCandidates) {
            const parentMatch = cand.match(new RegExp(`>\\s*([a-z]+\\.[a-zA-Z0-9_.-]+?)(?::nth-of-type\\(\\d+\\)|:nth-child\\(\\d+\\))?\\s*>\\s*${leafTag}(?::visible)?$`));
            if (parentMatch && parentMatch[1]) {
              const scopedLeaf = `${modalPrefix}${parentMatch[1]} ${leafTag}:has-text('${leafText}'):visible`;
              if (!currentCandidates.includes(scopedLeaf)) {
                currentCandidates.unshift(scopedLeaf);
              }
              break;
            }
          }
        }
      }

      // Remove bogus '결재 이력' fallback AND unscoped catch-all card selectors if a real form card title candidate exists in the same selector
      const realAwLiCardMatch = currentCandidates
        .map((c) => c.match(/aw_li:has-text\(['"]([^'"]+)['"]\)/))
        .find((m) => m && m[1] && m[1] !== "결재 이력");
      const hasRealAwLiCard = Boolean(realAwLiCardMatch);
      if (hasRealAwLiCard && realAwLiCardMatch) {
        const cardTitle = realAwLiCardMatch[1];
        currentCandidates = currentCandidates.filter((c) => {
          if (c.includes("has-text('결재 이력')")) return false;
          // Drop unscoped card fallbacks (e.g. "ul.aw_ul li.aw_li .app_work_box:visible" or "button._writeBtn:visible" or "button:text-is('결재작성'):visible")
          if (!c.includes(cardTitle) && !/:(?:nth-of-type|nth-child)\(\d+\)/.test(c)) {
            if (
              c === "ul.aw_ul li.aw_li .app_work_box:visible" ||
              c === "ul.aw_ul li.aw_li button.btn_write:visible" ||
              /^button\b/i.test(c) ||
              /^\.app_work_box\s+button\.btn/.test(c)
            ) {
              return false;
            }
          }
          return true;
        });
        workingSel = currentCandidates.join(", ");
      }

      const hasSpecificTextOrAttr = currentCandidates.some(
        (c) =>
          c.includes(":has-text(") ||
          c.includes(":text-is(") ||
          /\[data-[a-z-]+=/i.test(c) ||
          /#[a-zA-Z0-9_-]+/.test(c)
      );
      const hasPositionalNthOrUnfilteredList = currentCandidates.some(
        (c) =>
          /:(?:nth-of-type|nth-child)\(\d+\)/.test(c) ||
          /^[a-z]+\[contenteditable=['"]true['"]\]:visible$/i.test(c) ||
          /\[title\*?=['"]선택['"]\]/.test(c) ||
          (/\b(?:li|tr)(?:\.[a-zA-Z0-9_-]+)*\s*>/.test(c) && !c.includes(":has-text(") && !c.includes(":text-is(") && !/\[data-[a-z-]+=/i.test(c))
      );

      // Strip any previously corrupted td#... tr:has(...) or th#... tr:has(...) candidates where a table cell was prepended before a table row!
      currentCandidates = currentCandidates.filter(
        (c) => !/\b(?:td|th)#[a-zA-Z0-9_-]+\s+tr:has\(/i.test(c)
      );

      // Extract any non-list #id container prefix (e.g. div#eapWorkSelect_searchBox) from structural DOM paths
      // (ONLY genuine container tags div/form/table/section/nav/aside, NEVER td/th/span/a/label or paths traversing li/tr/dd/dynatree-node!)
      const cleanContainerId = currentCandidates
        .map((c) => {
          const m = c.match(/^(?:\.ui-dialog:visible\s+)?((?:div|form|table|section|nav|aside)?#[a-zA-Z0-9_-]+)\s*>/i);
          if (m && !/\b(?:li|tr|ul|ol|tbody|dd|\.dynatree-node)\b/i.test(c)) {
            return m[1];
          }
          return "";
        })
        .find(Boolean);

      if (hasSpecificTextOrAttr && currentCandidates.length > 1) {
        const specificFirst: string[] = [];
        const positionalLater: string[] = [];

        for (const cand of currentCandidates) {
          const hasSlotClassAttr = cand.includes("[class~=");
          const hasDataAttr =
            /\[data-[a-z-]+=/i.test(cand) ||
            cand.includes("input[value=") ||
            cand.includes(":has(.scvr") ||
            cand.includes(":has(.plt_") ||
            cand.includes(":has(._");
          const isGenericContentEditable = /^(?:\.ui-dialog:visible\s+)?[a-z]+\[contenteditable=['"]true['"]\]:visible$/i.test(cand);
          const isUnscopedGenericCheckbox =
            /\[title\*?=['"]선택['"]\]/.test(cand) &&
            !cand.includes(":has-text(") &&
            !cand.includes(":text-is(") &&
            !cand.includes("#") &&
            !hasDataAttr;
          const isUnfilteredListRowPath =
            /\b(?:li|tr)(?:\.[a-zA-Z0-9_-]+)*\s*>/.test(cand) &&
            !cand.includes(":has-text(") &&
            !cand.includes(":text-is(") &&
            !hasDataAttr &&
            !cand.includes("[title=") &&
            !isWikiImgListContext;
          const isIdAnchoredNonListContainer =
            Boolean(cleanContainerId) &&
            cand.includes(`${cleanContainerId} >`) &&
            !/\b(?:li|tr|ul|ol|tbody|dd|\.dynatree-node)\b/i.test(cand);
          // Unscoped generic control text (e.g. label.chkbox:has-text('사용'):visible or button.btn:has-text('추가'):visible without row/ID/data-* scope)
          // must go to positionalLater so row-scoped tr:has(th:...) or ID-anchored DOM paths are evaluated FIRST!
          const isUnscopedGenericControlText =
            /:(?:has-text|text-is)\(['"](?:사용|미사용|추가|선택|삭제|수정|등록|취소|닫기|초기화|목록|설정|변환|적용|주제를 표시합니다[^'"]*)['"]\)/i.test(cand) &&
            !cand.includes("#") &&
            !hasDataAttr &&
            !cand.includes("tr:has(") &&
            !cand.includes("li:has") &&
            !cand.includes("aw_li") &&
            !cand.includes("dynatree-") &&
            !cand.includes(":nth-");
          const isPositional =
            isGenericContentEditable ||
            isUnscopedGenericCheckbox ||
            isUnfilteredListRowPath ||
            isUnscopedGenericControlText ||
            (/:(?:nth-of-type|nth-child)\(\d+\)/.test(cand) &&
              !cand.includes(":has-text(") &&
              !cand.includes(":text-is(") &&
              !hasDataAttr &&
              !hasSlotClassAttr &&
              !isIdAnchoredNonListContainer &&
              !isWikiImgListContext);
          const isExplicitButtonHook = /(?:button|input)(?:\.[a-zA-Z0-9_-]+)*\.[_][a-zA-Z0-9_-]+/i.test(cand);
          const isBareClassCatchAll =
            !cand.includes("#") &&
            !cand.includes("[") &&
            !cand.includes(":has(") &&
            !cand.includes(":has-text(") &&
            !cand.includes(":text-is(") &&
            !cand.includes(":nth-") &&
            !cand.includes(">") &&
            !isExplicitButtonHook;

          if (isBareClassCatchAll) {
            // Skip bare catch-all class (e.g. .ui-dialog:visible a:visible, a.sub._doc:visible, label.user_info.chkbox:visible) when specific text/attr exists
            continue;
          }
          if (hasSlotClassAttr) {
            specificFirst.unshift(cand);
          } else if (isPositional) {
            positionalLater.push(cand);
          } else {
            // If an unscoped button/input selector (without #id, [data-*], or tr:has(...)) coexists with a specific #id search/toolbar container, prepend the #id-scoped version first while keeping .ui-dialog:visible at the very front!
            if (
              cleanContainerId &&
              !cand.includes("#") &&
              !hasDataAttr &&
              !cand.includes(cleanContainerId) &&
              !cand.includes("tr:has(")
            ) {
              const candHasModal = cand.startsWith(".ui-dialog:visible ");
              const candBody = candHasModal ? cand.slice(".ui-dialog:visible ".length) : cand;
              const prefixModal = hasModalScope || candHasModal ? ".ui-dialog:visible " : "";
              specificFirst.push(`${prefixModal}${cleanContainerId} ${candBody}`);
              positionalLater.push(cand);
              continue;
            }
            // If :has-text('...') includes a trailing date/category suffix (e.g. '테스트 주제 2026-10-18 개인') or trailing ' 옵션', insert the core title match FIRST
            const textMatch = cand.match(/^(.*):has-text\(['"]([^'"]+)['"]\)(.*)$/);
            if (textMatch) {
              const fullTxt = textMatch[2].trim();
              const strippedDateTitle = fullTxt
                .replace(/\s+\d{4}[-.]\d{2}[-.]\d{2}(?:\s+.*)?$/, "")
                .replace(/\s+옵션$/, "")
                .trim();
              if (strippedDateTitle && strippedDateTitle.length >= 2 && strippedDateTitle !== fullTxt) {
                specificFirst.push(`${textMatch[1]}:has-text('${strippedDateTitle}')${textMatch[3]}`);
              }
            }
            specificFirst.push(cand);
            // ONLY for organization chart user rows (e.g. '이지민 조교 건축과 (유니슨)', 'test002 테스트 부서 (유니슨)'), also add core first-token match
            const isOrgUserContext =
              cand.includes("orgUserList") ||
              cand.includes("user_info") ||
              (textMatch && /\([^)]+\)$/.test(textMatch[2].trim()));
            if (textMatch && isOrgUserContext) {
              const firstToken = textMatch[2].trim().split(/\s+/)[0];
              if (
                firstToken &&
                firstToken.length >= 2 &&
                !/^\d+\.?$/.test(firstToken) &&
                firstToken !== textMatch[2].trim()
              ) {
                specificFirst.push(`${textMatch[1]}:has-text('${firstToken}')${textMatch[3]}`);
              }
            }
          }
        }

        // Remove any previously generated first-token truncated :has-text('...') duplicates (e.g. :has-text('1.'), :has-text('테스트'), :has-text('최신'))
        // when the full multi-word :has-text('...') with the identical selector prefix/suffix exists in specificFirst!
        const dedupedSpecificFirst = specificFirst.filter((cand) => {
          if (cand.includes("orgUserList") || cand.includes("user_info")) return true;
          const m = cand.match(/^(.*):has-text\(['"]([^'"]+)['"]\)(.*)$/);
          if (!m) return true;
          const [, pre, txt, post] = m;
          const trimmedTxt = txt.trim();
          if (trimmedTxt.includes(" ")) return true;
          const hasLongerFullTextSibling = specificFirst.some((other) => {
            if (other === cand) return false;
            const om = other.match(/^(.*):has-text\(['"]([^'"]+)['"]\)(.*)$/);
            if (!om) return false;
            return om[1] === pre && om[3] === post && om[2].trim().startsWith(trimmedTxt + " ");
          });
          return !hasLongerFullTextSibling;
        });

        if (dedupedSpecificFirst.length > 0) {
          workingSel = Array.from(new Set([...dedupedSpecificFirst, ...positionalLater])).join(", ");
        } else {
          workingSel = currentCandidates.join(", ");
        }
      } else {
        workingSel = currentCandidates.join(", ");
      }

      return workingSel;
    };

    if (action.type === "click" || action.type === "hover" || action.type === "type" || action.type === "upload") {
      if (action.selector) {
        const refined = refineSelectorString(action.selector, action.targetHtml);
        if (refined !== action.selector) {
          action.selector = refined;
          sel = refined;
          changes.push(`[셀렉터 정밀화] '${desc}' 셀렉터에서 정확 일치 텍스트/속성 및 고유 컨테이너를 최우선 배치했습니다.`);
          fixedActionsCount++;
        }
      }
      if (
        action.type === "type" &&
        action.targetHtml &&
        desc.includes("'에디터 본문' 입력 영역") &&
        (/\b(?:data-placeholder|placeholder)=["']([^"']+)["']/i.test(action.targetHtml) || /id=["'][^"']*(?:subject|title)[^"']*["']/i.test(action.targetHtml))
      ) {
        const phMatch = action.targetHtml.match(/\b(?:data-placeholder|placeholder)=["']([^"']+)["']/i);
        const fieldLabel = phMatch && phMatch[1].trim() ? phMatch[1].trim() : "제목";
        action.description = action.description.replace("'에디터 본문' 입력 영역", `'${fieldLabel}' 입력창`);
        desc = action.description;
      }
    } else if (action.type === "dragAndDrop") {
      const srcToRefine = action.sourceSelector || action.selector || "";
      if (srcToRefine) {
        // Note: action.targetHtml on dragAndDrop belongs to the drop target, so pass undefined for sourceSelector refinement
        const refinedSrc = refineSelectorString(srcToRefine, undefined);
        if (refinedSrc !== srcToRefine) {
          action.sourceSelector = refinedSrc;
          action.selector = refinedSrc;
          sel = refinedSrc;
          changes.push(`[드래그 소스 정밀화] '${desc}' 출발지 셀렉터에서 정확 일치 텍스트 후보를 최우선 배치했습니다.`);
          fixedActionsCount++;
        }
      }
    }

    // If this action was captured directly from the live browser DOM via the Eyedropper,
    // preserve its exact HTML/DOM selector and iframe 100% without any keyword-guessing overrides!
    const planHasExplicitEyedropperFlags = actualPlan.actions.some((a) => a.recordedByEyedropper === true);
    if (actualPlan.recordedByEyedropper || action.recordedByEyedropper) {
      if (action.recordedByEyedropper || Boolean(action.targetHtml) || !planHasExplicitEyedropperFlags) {
        action.recordedByEyedropper = true;
      }
      if (action.iframe === "iframe#subBody, iframe#contentFrame, iframe") {
        action.iframe = "iframe[name='setup_iframe'], iframe#subBody, iframe#contentFrame, iframe";
      }
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
      (desc.includes("트리") || desc.includes("부서") || desc.includes("조직도") || desc.includes("폴더") || desc.includes("모두펼침")) &&
      (desc.includes("펼침") || desc.includes("확장"));

    if (isTreeExpandAction) {
      const original = action.selector;
      action.selector = ".ui-dialog:visible button.btn_fopn:visible, .ui-dialog:visible button:has-text('모두펼침'):visible, .ui-dialog:visible .dynatree-expander:visible";
      changes.push(`[정제] 트리 모달 모두펼침 버튼 셀렉터 정밀 보강: "${original}" -> "${action.selector}"`);
      fixedActionsCount++;
      sel = action.selector;
    } else if (
      action.type === "click" &&
      isModalContext &&
      (desc.includes("상세 설정") || desc.includes("상세 등록")) &&
      (desc.includes("펼침") || desc.includes("확장") || desc.includes("버튼"))
    ) {
      action.selector = ".ui-dialog:visible button:has(#detail_tgl):visible, .ui-dialog:visible button:has-text('상세 등록'):visible, .ui-dialog:visible button:has-text('상세'):visible";
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
      !desc.includes("닫기") &&
      !desc.includes("취소") &&
      !desc.includes("보기") &&
      !desc.includes("전환") &&
      !desc.includes("프로필") &&
      !desc.includes("레이어") &&
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
      else if (
        (desc.includes("일정등록") || desc.includes("일정 등록")) &&
        !desc.includes("저장") &&
        !desc.includes("완료") &&
        !desc.includes("취소") &&
        !desc.includes("확인") &&
        !desc.includes("선택") &&
        !desc.includes("팝업") &&
        !desc.includes("모달")
      ) {
        const original = action.selector;
        action.selector = "button#reg_shedule_lefttop:visible, button#scheduleLayerBtn:visible, button:has-text('일정 등록'):visible, button:has-text('일정등록'):visible";
        if (original !== action.selector) {
          changes.push(`[그룹웨어 정밀 매핑] 일정등록 버튼 보강: "${original}" -> "${action.selector}"`);
          fixedActionsCount++;
        }
        sel = action.selector;
      }
      // 게시판 글작성
      else if (
        (desc.includes("글작성") || desc.includes("게시글 작성") || desc.includes("글 작성")) &&
        !desc.includes("저장") &&
        !desc.includes("완료") &&
        !desc.includes("취소") &&
        !desc.includes("확인") &&
        !desc.includes("선택") &&
        !desc.includes("팝업") &&
        !desc.includes("모달")
      ) {
        const original = action.selector;
        action.selector = "button#boardSideBar_write:visible, button#brdBoardLeft_writeBtn:visible, #snb button:has-text('글 작성'):visible, button:has-text('글작성'):visible";
        if (original !== action.selector) {
          changes.push(`[그룹웨어 정밀 매핑] 게시판 글작성 버튼 보강: "${original}" -> "${action.selector}"`);
          fixedActionsCount++;
        }
        sel = action.selector;
      }
      // 문서관리 문서등록
      else if (
        (desc.includes("문서등록") || desc.includes("문서 등록")) &&
        !desc.includes("저장") &&
        !desc.includes("완료") &&
        !desc.includes("취소") &&
        !desc.includes("확인") &&
        !desc.includes("선택") &&
        !desc.includes("팝업") &&
        !desc.includes("모달")
      ) {
        const original = action.selector;
        action.selector = "button#docLeft_writeBtn:visible, button#reg_doc_btn:visible, #snb button:has-text('문서 등록'):visible, button:has-text('문서등록'):visible";
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
      // 제목 입력란 (일정/예약 vs 결재/문서/게시판/메일/쪽지 구분 및 기존 고유 셀렉터 우선 보존)
      else if (desc.includes("제목") && !desc.includes("검색") && !desc.includes("분류")) {
        const original = action.selector || "";
        const descWithoutQuotes = desc.replace(/['"][^'"]*['"]/g, "");
        const isMailOrNote =
          descWithoutQuotes.includes("메일") ||
          descWithoutQuotes.includes("쪽지") ||
          /\b(?:emlMailReg|mail_subject|notNoteReg)\b/i.test(original);
        const isScheduleOrRes =
          !isMailOrNote &&
          (descWithoutQuotes.includes("일정") ||
            descWithoutQuotes.includes("예약") ||
            /^(\.ui-dialog:visible\s+)?input#subject(:visible)?$/i.test(original.trim()));
        const origParts = splitSelectorCandidates(original);
        const baseCandidates = isScheduleOrRes
          ? [
              ".ui-dialog:visible input#subject:visible",
              "input#subject:visible",
              "input[name='subject']:visible",
              "input[placeholder*='제목']:visible",
            ]
          : isMailOrNote
            ? [
                "input#emlMailReg_subject:visible",
                "input#notNoteReg_subject:visible",
                ...origParts,
                "input[name*='subject']:visible",
                "input[name*='Subject']:visible",
                "input[placeholder*='제목']:visible",
              ]
            : [
                ...origParts,
                "input#_DOC_TITLE_:visible",
                "input#eapDocReg_docSubject:visible",
                "input#docTitle:visible",
                "input#atclReg_subject:visible",
                "input#atclWrite_subject:visible",
                "input#smwWorkReg_subject:visible",
                "input[name*='Subject']:visible",
                "input[placeholder*='제목']:visible",
                "input#subject:visible",
              ];
        action.selector = Array.from(new Set(baseCandidates)).join(", ");
        if (original !== action.selector) {
          changes.push(`[그룹웨어 정밀 매핑] 제목 입력란 보강: "${original}" -> "${action.selector}"`);
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

    // 1-E. Module Content Search vs Sidebar Folder Search vs GNB Header Search vs AI Chat Collision Prevention
    const isAiChatContext =
      Boolean(action.iframe && /chat_iframe|aiChat/i.test(action.iframe)) ||
      /\bcmmAiChat|\bmentiony-content|\b_aiReset|\b_newChat|\b_chatLink|\bdata-search-type\b/i.test(sel) ||
      desc.includes("에이전트") ||
      desc.includes("질문") ||
      desc.includes("ai ") ||
      desc.includes("ai챗") ||
      desc.includes("챗봇");

    // Restore AI Chat actions in non-Eyedropper plans that were previously overwritten with eapWorkSelect_searchWord / eapWorkSelect_searchBox
    if (isAiChatContext) {
      if (action.type === "type" && sel.includes("eapWorkSelect_searchWord")) {
        action.selector =
          "div.mentiony-content[contenteditable='true']:visible, div[contenteditable='true'][data-placeholder*='질문']:visible, textarea:visible, input[type='text']:visible";
        sel = action.selector;
        changes.push(`[AI Chat 복원] AI 챗봇 질문 입력창 셀렉터 복원: "${desc}"`);
        fixedActionsCount++;
      } else if (action.type === "click" && sel.includes("eapWorkSelect_searchBox")) {
        if (desc.includes("에이전트")) {
          action.selector =
            "div#cmmAiChat_controlMenu button[data-search-type='tool']:visible, button[data-search-type='tool']:visible, button._search:has-text('에이전트 모드'):visible, button:has-text('에이전트'):visible";
        } else {
          action.selector =
            "div#cmmAiChat_controlMenu button[data-search-type='gw']:visible, button[data-search-type='gw']:visible, button._search:has-text('그룹웨어 검색'):visible, button._send:visible, button[title*='전송']:visible";
        }
        sel = action.selector;
        changes.push(`[AI Chat 복원] AI 챗봇 검색/모드 버튼 셀렉터 복원: "${desc}"`);
        fixedActionsCount++;
      }
    }

    const isFolderTreeSearch = desc.includes("문서함 검색") || desc.includes("폴더 검색") || desc.includes("트리 검색") || desc.includes("사이드바 검색");
    const isSearchExecuteAction =
      !isAiChatContext &&
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
      !isAiChatContext &&
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

    // 5. Clean hallucinated uppercase dummy IDs (#_SAVE_BTN_, etc. while preserving real Naonsoft #_DOC_TITLE_)
    if (/#_(?!DOC_TITLE_)[A-Z0-9_]+_/i.test(sel)) {
      const original = sel;
      sel = splitSelectorCandidates(sel)
        .filter((c) => !/#_(?!DOC_TITLE_)[A-Z0-9_]+_/i.test(c) && c !== ":visible")
        .join(", ");
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

  // 11. Universal Post-Loop Deduplication & Accidental Self-Drag Cleanup (applies to both Eyedropper & AI plans)
  const cleanedSanitizedActions: BrowsePlanAction[] = [];
  for (let idx = 0; idx < sanitizedActions.length; idx++) {
    const act = { ...sanitizedActions[idx] };

    // 11-A. Accidental Self-DragAndDrop on Same Tree Node Cleanup
    if (act.type === "dragAndDrop") {
      const srcSel = act.sourceSelector || act.selector || "";
      const tgtSel = act.targetSelector || "";
      const srcTxtMatch = srcSel.match(/:(?:text-is|has-text)\(['"]([^'"]+)['"]\)/);
      const tgtTxtMatch = tgtSel.match(/:(?:text-is|has-text)\(['"]([^'"]+)['"]\)/);
      const srcNodeTxt = srcTxtMatch ? srcTxtMatch[1].trim() : "";
      const tgtNodeTxt = tgtTxtMatch ? tgtTxtMatch[1].trim() : "";

      const isSelfTreeDrag =
        Boolean(srcNodeTxt && tgtNodeTxt && srcNodeTxt === tgtNodeTxt) ||
        Boolean(srcNodeTxt && tgtSel.includes("dynatree-node") && tgtSel.includes(srcNodeTxt));

      if (isSelfTreeDrag && srcNodeTxt) {
        // Check if there is an explicit retry click on the same tree node within the next 6 steps after a failed confirm/alert
        let retryClickIdx = -1;
        for (let look = idx + 1; look <= Math.min(sanitizedActions.length - 1, idx + 7); look++) {
          const cand = sanitizedActions[look];
          if (
            cand.type === "click" &&
            ((cand.selector || "").includes(srcNodeTxt) || (cand.description || "").includes(srcNodeTxt))
          ) {
            retryClickIdx = look;
            break;
          }
        }

        if (retryClickIdx !== -1) {
          const betweenNonWaits = sanitizedActions
            .slice(idx + 1, retryClickIdx)
            .filter((b) => b.type !== "wait");
          const allBetweenAreConfirmOrAlert = betweenNonWaits.every(
            (b) =>
              b.type === "click" &&
              ((b.description || "").includes("확인") ||
                (b.selector || "").includes("confirm") ||
                (b.selector || "").includes("alert"))
          );

          if (allBetweenAreConfirmOrAlert) {
            changes.push(
              `[오탐 드래그 정리] 마우스 미세 이동으로 잘못 기록된 트리 자기 자신 드래그('${srcNodeTxt}') 및 그로 인한 알림 확인 단계를 제거하고 정상 클릭 단계로 직결했습니다.`
            );
            removedActionsCount += retryClickIdx - idx;
            idx = retryClickIdx - 1;
            continue;
          }
        }

        // Otherwise, convert the accidental self-drag directly into a normal click action
        act.type = "click";
        delete act.sourceSelector;
        delete act.targetSelector;
        if (act.description) {
          act.description = act.description
            .replace(/항목을\(를\).*드래그 앤 드롭$/, "클릭")
            .replace(/을\(를\).*드래그 앤 드롭$/, " 클릭");
        }
        changes.push(`[오탐 드래그 교정] 동일 트리 노드('${srcNodeTxt}') 내 드래그 앤 드롭을 일반 클릭 액션으로 자동 교정했습니다.`);
        fixedActionsCount++;
      }
    }

    // Find last two non-wait actions in cleanedSanitizedActions
    let prev1: BrowsePlanAction | null = null;
    let prev2: BrowsePlanAction | null = null;
    for (let k = cleanedSanitizedActions.length - 1; k >= 0; k--) {
      if (cleanedSanitizedActions[k].type !== "wait") {
        if (!prev1) {
          prev1 = cleanedSanitizedActions[k];
        } else {
          prev2 = cleanedSanitizedActions[k];
          break;
        }
      }
    }

    // 11-B. Deduplicate consecutive identical 'type' (or 'type -> hover -> type -> hover' caused by Enter + blur)
    if (act.type === "type" && act.text) {
      const isDirectDupType =
        prev1?.type === "type" &&
        (prev1.selector || "") === (act.selector || "") &&
        (prev1.editorParaIndex ?? -1) === (act.editorParaIndex ?? -1) &&
        (prev1.text || "") === (act.text || "");
      const isInterleavedHoverDupType =
        prev1?.type === "hover" &&
        prev2?.type === "type" &&
        (prev2.selector || "") === (act.selector || "") &&
        (prev2.editorParaIndex ?? -1) === (act.editorParaIndex ?? -1) &&
        (prev2.text || "") === (act.text || "");

      if (isDirectDupType || isInterleavedHoverDupType) {
        changes.push(`[중복 타이핑 제거] 동일 입력창에 중복 기록된 '${act.text}' 입력 단계를 제거했습니다.`);
        removedActionsCount++;
        if (idx + 1 < sanitizedActions.length && sanitizedActions[idx + 1].type === "wait") {
          idx++;
          removedActionsCount++;
        }
        // If it was part of a 'type -> hover -> type -> hover' pair, also skip the immediately following duplicate hover
        if (
          isInterleavedHoverDupType &&
          idx + 1 < sanitizedActions.length &&
          sanitizedActions[idx + 1].type === "hover" &&
          (sanitizedActions[idx + 1].selector || "") === (prev1?.selector || "")
        ) {
          idx++;
          removedActionsCount++;
          changes.push(`[중복 호버 제거] 중복 타이핑에 수반된 동일 양식 카드 마우스 호버 단계를 함께 제거했습니다.`);
          if (idx + 1 < sanitizedActions.length && sanitizedActions[idx + 1].type === "wait") {
            idx++;
            removedActionsCount++;
          }
        }
        continue;
      }
    }

    // 11-C. Deduplicate consecutive identical 'hover' actions
    if (
      act.type === "hover" &&
      prev1?.type === "hover" &&
      (prev1.selector || "") === (act.selector || "")
    ) {
      changes.push(`[중복 호버 제거] 동일 대상에 연속 중복 기록된 '${act.description}' 단계를 제거했습니다.`);
      removedActionsCount++;
      if (idx + 1 < sanitizedActions.length && sanitizedActions[idx + 1].type === "wait") {
        idx++;
        removedActionsCount++;
      }
      continue;
    }

    // 11-D. Deduplicate consecutive <label class="...chkbox/rdobtn"> + <input type="checkbox/radio"> synthetic double-clicks
    if (act.type === "click" && prev1?.type === "click") {
      const prevHtml = prev1.targetHtml || "";
      const prevSel = prev1.selector || "";
      const actHtml = act.targetHtml || "";
      const actSel = act.selector || "";

      const prevIsLabelChk =
        /^<label\b/i.test(prevHtml) ||
        /\blabel[.#:\[]/i.test(prevSel);
      const actIsInputChk =
        (/^<input\b/i.test(actHtml) && /type=["'](?:checkbox|radio)["']/i.test(actHtml)) ||
        /input\[type=['"](?:checkbox|radio)['"]\]/i.test(actSel);

      if (prevIsLabelChk && actIsInputChk) {
        const prevRowMatch = prevSel.match(/:has-text\(['"]([^'"]+)['"]\)/) || prev1.description?.match(/['"]([^'"]+)['"]/);
        const actRowMatch = actSel.match(/:has-text\(['"]([^'"]+)['"]\)/) || act.description?.match(/['"]([^'"]+)['"]/);
        const prevToken = prevRowMatch ? prevRowMatch[1].trim().split(/\s+/)[0] : "";
        const actToken = actRowMatch ? actRowMatch[1].trim().split(/\s+/)[0] : "";

        if ((prevToken && actToken && prevToken === actToken) || (!actToken && /lst_chk|_chk|input_chk/.test(actHtml + actSel))) {
          changes.push(`[합성 더블클릭 제거] <label> 클릭 직후 브라우저가 합성 발생시킨 동일 항목('${prevToken || act.description}') 체크박스 중복 클릭을 제거했습니다.`);
          removedActionsCount++;
          if (idx + 1 < sanitizedActions.length && sanitizedActions[idx + 1].type === "wait") {
            idx++;
            removedActionsCount++;
          }
          continue;
        }
      }
    }

    // 11-E. Remove bogus unrecorded topMenu_logon or duplicate logout clicks following a recorded logout click,
    // or unrecorded frmEditByDesign_btnSaveConfirm clicks injected after frmMainList_btnConfirm popup confirm
    if (act.type === "click") {
      const actSel = act.selector || "";
      const actDesc = act.description || "";
      const prevSel = prev1?.selector || "";
      const prevDesc = prev1?.description || "";
      const isActLogout =
        actSel.includes("topMenu_logon") ||
        actSel.includes("btn_logout") ||
        actSel.includes("goLogout") ||
        actDesc.includes("로그아웃");
      const isPrevLogout =
        prev1?.type === "click" &&
        (prevSel.includes("btn_logout") || prevSel.includes("goLogout") || prevDesc.includes("로그아웃"));

      if (isActLogout && (isPrevLogout || (!act.recordedByEyedropper && actSel.includes("topMenu_logon")))) {
        changes.push(`[정제] 로그아웃 직후 중복/오류 삽입된 로그아웃 버튼 클릭 액션 제거: "${actDesc}"`);
        removedActionsCount++;
        if (idx + 1 < sanitizedActions.length && sanitizedActions[idx + 1].type === "wait") {
          idx++;
          removedActionsCount++;
        }
        continue;
      }

      const prevNonWait = prev1?.type === "wait" ? prev2 : prev1;
      const prevNonWaitSel = prevNonWait?.selector || "";
      if (
        !act.recordedByEyedropper &&
        actSel.includes("frmEditByDesign_btnSaveConfirm") &&
        (prevSel.includes("frmMainList_btnConfirm") || prevNonWaitSel.includes("frmMainList_btnConfirm"))
      ) {
        changes.push(`[정제] 양식 선택 팝업 확인(#frmMainList_btnConfirm) 직후 오류 삽입된 폼 디자이너 확인 액션 제거: "${actDesc}"`);
        removedActionsCount++;
        if (idx + 1 < sanitizedActions.length && sanitizedActions[idx + 1].type === "wait") {
          idx++;
          removedActionsCount++;
        }
        continue;
      }

      // Clean up duplicate AI-injected [포탈 전체메뉴 열기 -> 모듈 선택] steps (lacking targetHtml) right after a recorded #all_svc_inner module click
      if (
        !act.targetHtml &&
        Boolean(prevNonWait?.targetHtml) &&
        prevNonWaitSel.includes("all_svc_inner") &&
        (actSel.includes("btn_svc_open") ||
          actDesc.includes("포탈 전체메뉴") ||
          actSel.includes("all_svc_inner") ||
          actSel.includes("#svc_box"))
      ) {
        changes.push(`[정제] 포탈 전체메뉴 모듈 이동 직후 중복 삽입된 전체메뉴 액션 제거: "${actDesc}"`);
        removedActionsCount++;
        if (idx + 1 < sanitizedActions.length && sanitizedActions[idx + 1].type === "wait") {
          idx++;
          removedActionsCount++;
        }
        continue;
      }

      // Clean up duplicate AI-injected [_fileAdd / _search] steps (lacking targetHtml & recordedByEyedropper) right after a recorded AI Chat control Menu action
      if (
        actualPlan.recordedByEyedropper &&
        !act.recordedByEyedropper &&
        !act.targetHtml &&
        Boolean(prevNonWait?.targetHtml) &&
        (actSel.includes("_fileAdd") ||
          actSel.includes("_search") ||
          actSel.includes("cmmAiChat_controlMenu") ||
          actDesc.includes("파일 추가 및 기타") ||
          actDesc.includes("에이전트 모드"))
      ) {
        changes.push(`[정제] AI Chat 옵션 선택 직후 중복 삽입된 비녹화 보조 액션 제거: "${actDesc}"`);
        removedActionsCount++;
        if (idx + 1 < sanitizedActions.length && sanitizedActions[idx + 1].type === "wait" && !sanitizedActions[idx + 1].recordedByEyedropper) {
          idx++;
          removedActionsCount++;
        }
        continue;
      }

      // Deduplicate consecutive identical clicks on a slide-over drawer item (#cmmAiChatSideMenu_navi a)
      // because the 1st click already selects the item and closes the drawer!
      if (
        prevNonWait?.type === "click" &&
        actSel.includes("cmmAiChatSideMenu_navi") &&
        prevNonWaitSel.includes("cmmAiChatSideMenu_navi") &&
        (actSel === prevNonWaitSel || (act.targetHtml && act.targetHtml === prevNonWait.targetHtml))
      ) {
        changes.push(`[중복 클릭 제거] 슬라이드 메뉴(#cmmAiChatSideMenu_navi) 닫힘 직후 동일 항목 중복 클릭 제거: "${actDesc}"`);
        removedActionsCount++;
        if (idx + 1 < sanitizedActions.length && sanitizedActions[idx + 1].type === "wait") {
          idx++;
          removedActionsCount++;
        }
        continue;
      }
    }

    cleanedSanitizedActions.push(act);
  }

  sanitizedActions.length = 0;
  sanitizedActions.push(...cleanedSanitizedActions);

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
  // 3) Remove bogus unrecorded topMenu_logon / duplicate logout clicks injected after an eyedropper-recorded logout click
  const finalActions: BrowsePlanAction[] = [];
  let lastWasCardWrite = false;
  let lastWasLogoutClick = false;

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

    const isLogoutClick =
      act.type === "click" &&
      (sel.includes("btn_logout") ||
        sel.includes("goLogout") ||
        sel.includes("topMenu_logon") ||
        desc.includes("로그아웃"));

    if (isLogoutClick) {
      if (lastWasLogoutClick || (!act.recordedByEyedropper && sel.includes("topMenu_logon"))) {
        removedActionsCount++;
        changes.push(`[정제] 로그아웃 직후 중복/오류 삽입된 로그아웃 버튼 클릭 액션 제거: "${desc}"`);
        if (i + 1 < optimizedActions.length && optimizedActions[i + 1].type === "wait") {
          i++; // skip trailing wait too
        }
        continue;
      }
      lastWasLogoutClick = true;
    } else if (act.type !== "wait") {
      lastWasLogoutClick = false;
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

    if (
      act.type === "wait" &&
      finalActions.length > 0 &&
      finalActions[finalActions.length - 1].type === "wait" &&
      i < optimizedActions.length - 1 &&
      !desc.includes("최종 시연 결과")
    ) {
      removedActionsCount++;
      changes.push(`[정제] 연속된 중복 대기(wait) 액션 병합: "${desc}"`);
      continue;
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

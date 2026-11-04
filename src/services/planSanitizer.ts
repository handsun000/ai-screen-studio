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
        ...Array.from(
          rawSel.matchAll(
            /\b(?:li|div|tr)#([a-zA-Z0-9_]*(?:TA|TB|TG|TT|TY|ATCL|DOC|WKS|BRD|EML|NOT|SCD|TSK|WBB|WBP)[0-9a-z]{12,})/gi
          )
        ).map((m) => [m[0], "id", m[1]] as unknown as RegExpMatchArray),
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

      const rowScopedNameM = rawSel.match(/\b(?:li|tr|label):has-text\(['"]([^'"]{2,40})['"]\)/i);
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
    let lastTypedLabelTitle = "";
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
        ...Array.from(
          rawSel.matchAll(
            /\b(?:li|div|tr)#([a-zA-Z0-9_]*(?:TA|TB|TG|TT|TY|ATCL|DOC|WKS|BRD|EML|NOT|SCD|TSK|WBB|WBP)[0-9a-z]{12,})/gi
          )
        ).map((m) => [m[0], "id", m[1]] as unknown as RegExpMatchArray),
      ];

      if (act.type === "type" && act.text && act.text.trim()) {
        const cleanTxt = act.text.replace(/\s*↵\s*/g, "\n").trim();
        const combinedCtx = `${act.selector || ""} ${act.description || ""} ${act.targetHtml || ""}`;
        const isSearchField = /(?:search|srch|검색|schword)/i.test(combinedCtx);
        const isBodyOrCommentEditor =
          cleanTxt.includes("\n") ||
          /(?:ProseMirror|se-contents|bn-editor|ck-editor|npage_editor|본문|내용|mentiony|cmmAiChat|프롬프트)/i.test(
            combinedCtx
          );
        const isLabelNameField = /(?:lblName|라벨\s*이름|라벨명)/i.test(combinedCtx);
        const isTitleOrNameField =
          /(?:제목|주제|업무명|일정명|폴더명|분류명|그룹명|라벨명|라벨\s*이름|태그명|캘린더명|자원명|프로젝트명|스페이스명|위키명|댓글|의견|subject|title|bookName|brdName|fldName|wksName|prjName|cldrName|lblName|opinCn)/i.test(
            combinedCtx
          );
        if (!isSearchField && !isBodyOrCommentEditor && isTitleOrNameField && cleanTxt.length >= 2 && cleanTxt.length <= 40) {
          const sanitizedTitle = cleanTxt.replace(/'/g, "");
          if (isLabelNameField) {
            lastTypedLabelTitle = sanitizedTitle;
            // Retroactively bind any TA01... label ID that was edited/deleted right before recreating this label!
            for (const seenId of currentRunIdsBeforeType) {
              if (/^TA01/i.test(seenId) && !entityIdToNameMap.has(seenId)) {
                entityIdToNameMap.set(seenId, sanitizedTitle);
              }
            }
          } else {
            lastTypedEntityTitle = sanitizedTitle;
            for (const seenId of currentRunIdsBeforeType) {
              if (!/^TA01/i.test(seenId)) {
                preCreationSeenIds.add(seenId);
              }
            }
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
        if (/^TA01/i.test(idVal)) {
          if (!entityIdToNameMap.has(idVal) && lastTypedLabelTitle) {
            entityIdToNameMap.set(idVal, lastTypedLabelTitle);
          }
        } else if (!entityIdToNameMap.has(idVal) && !preCreationSeenIds.has(idVal) && lastTypedEntityTitle) {
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
      /\.(?:_punchHandle|chkbox_on|rdobtn_on|ico_chk_on|ac_over|dynatree-(?:expanded|has-children|folder|lastsib|focused|active|selected|partsel|loading|statusnode|exp-[a-zA-Z0-9_-]+|ico-[a-zA-Z0-9_-]+)|fancytree-(?:expanded|has-children|folder|lastsib|focused|active|selected|partsel|loading|statusnode|exp-[a-zA-Z0-9_-]+|ico-[a-zA-Z0-9_-]+)|ui-state-(?:hover|focus|active|highlight)|select2-(?:focused|active|dropdown-open|container-active|drop-above|highlighted|results-dept-\d+))\b/g,
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

      //Filter out dummy onclick='return false;' candidates and fix inverted .ui-dialog:visible prefixes
    const parts = splitSelectorCandidates(s)
      .filter((p) => !/\[onclick\*=['"]?(?:return\s+(?:false|true)|javascript:|void\s*\(0\))/i.test(p))
      .map((p) => {
        let cleaned = p;
        cleaned = cleaned.replace(/^([a-zA-Z0-9]*#[a-zA-Z0-9_-]+)\s+\.ui-dialog:visible\s+/, ".ui-dialog:visible $1 ");
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
    } else if (action.type === "click" && /우클릭/.test(desc)) {
      action.type = "rightclick";
      changes.push(`[타입 복원] '${desc}' 액션의 우클릭 설명을 감지하여 type을 'rightclick'으로 자동 복원했습니다.`);
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
          /^(선택|체크|검색|초기화|삭제|수정|인쇄|별표|설정|관리|등록|추가|확인|취소|닫기|조직도|목록|조회|저장|옵션|비우기|접기\/펴기|복원|할일\s*추가|라벨\s*추가|부가\s*기능|메뉴|더보기|이동|복사|보관)$/i.test(
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
          const hasStructuralNthAncestor = currentParts.some((p) =>
            /(?:div|li|tr|ul|dl|dd|td)[^,>]*:nth-of-type\(\d+\)\s*>/i.test(p)
          );
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
            if (isGenericSharedTitle || hasStructuralNthAncestor) {
              // Never prepend generic shared-title selectors (e.g. [title='설정'], [title='복원'], [title='할일 추가']) ahead of structural :nth-of-type(n) or row-scoped candidates!
              const specificFirst = currentParts.filter(
                (p) =>
                  /(?:div|li|tr|ul|dl|dd|td)[^,>]*:nth-of-type\(\d+\)\s*>|:(?:has-text|text-is)\(/i.test(p) ||
                  !p.includes(`[title='${outerTitleVal}']`)
              );
              const genericTitleRest = currentParts.filter((p) => !specificFirst.includes(p));
              workingSel = Array.from(new Set([...specificFirst, ...genericTitleRest, ...titleCandidates])).join(", ");
            } else {
              workingSel = Array.from(new Set([...titleCandidates, ...currentParts])).join(", ");
            }
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
          /^data-(?:toggle|dismiss|backdrop|keyboard|spy|ride|slide|placement|original-title|qtip|tooltip|placeholder|i18n|bind|reactid|v-|unique-id$|start$|full$|end$|time$|date$)/i;
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
          (tagName === "button" || tagName === "a" || (tagName === "li" && classTokens.includes("nt_li"))) && distinguishingClsTokens.length > 0
            ? "." + distinguishingClsTokens.slice(0, 2).join(".")
            : "";
        const primaryHookOrBtnCls = distinguishingClsTokens.find((c) => c.startsWith("_")) || distinguishingClsTokens[0] || "";

        // Clean existing workingSel of bare Tier-3 shared status/type/parent attributes and qualify shared menu attributes with innerTextClean
        {
          const cleanedExisting = splitSelectorCandidates(workingSel)
            .filter((p) => {
              if (/:has\(\[data-(?:reg-emp-id|unique-id|start|full|end|time|date|.*status|.*type|.*yn)=/i.test(p)) return false;
              const dataM = p.match(/\[(data-[a-zA-Z0-9_-]+)=['"]([^'"]+)['"]\]/i);
              if (dataM) {
                const dName = dataM[1].toLowerCase();
                const dVal = dataM[2].trim();
                if (ignoredDataAttrRegex.test(dName) || /[0-9a-f]{8}-[0-9a-f]{4}-/i.test(dVal)) {
                  return false;
                }
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
            if (!attrVal || attrVal.toLowerCase() === "empty" || /[0-9a-f]{8}-[0-9a-f]{4}-/i.test(attrVal)) continue;

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
            if (/:has\(\.ico_[a-zA-Z0-9_-]+\)/i.test(p)) {
              return false;
            }
            return true;
          });
          if (cleanedHookIconParts.length > 0) {
            // Also expand any structural path that has an ephemeral entity ID baked into an :nth-of-type step or #id prefix
            // (e.g. li._task[data-task-id='TT01...']:nth-of-type(2) -> also add li._task:nth-of-type(2),
            // and li#TA01... button.btn_edit -> also add li:has-text('배포') button.btn_edit)
            const expandedParts: string[] = [];
            const mappedTextFirstParts: string[] = [];
            for (const part of cleanedHookIconParts) {
              const strippedEphemeralAttr = part.replace(
                /\[data-[a-z0-9_-]*id=['"](?:TA|TB|TG|TT|TY|ATCL|DOC|WKS|BRD|EML|NOT|SCD|TSK|WBB|WBP)[0-9a-z]{12,}['"]\]/gi,
                ""
              );
              if (strippedEphemeralAttr !== part && strippedEphemeralAttr.includes(":nth-of-type(")) {
                expandedParts.push(strippedEphemeralAttr);
              }
              const ephHashM = part.match(
                /^(\.ui-dialog:visible\s+)?(li|div|tr)#([a-zA-Z0-9_]*?)((?:TA|TB|TG|TT|TY|ATCL|DOC|WKS|BRD|EML|NOT|SCD|TSK|WBB|WBP)[0-9a-z]{12,})(\s+.*)$/i
              );
              if (ephHashM) {
                const dlgPre = ephHashM[1] || modalPrefix || "";
                const itemTag = ephHashM[2];
                const staticIdPrefix = ephHashM[3] || "";
                const fullEphId = `${staticIdPrefix}${ephHashM[4]}`;
                const restSel = ephHashM[5];
                const mappedName = entityIdToNameMap.get(fullEphId) || entityIdToNameMap.get(ephHashM[4]);
                if (mappedName && !restSel.includes(`:has-text('${mappedName}')`)) {
                  mappedTextFirstParts.push(`${dlgPre}${itemTag}:has-text('${mappedName}')${restSel}`);
                }
                expandedParts.push(part);
                if (staticIdPrefix.length >= 4) {
                  expandedParts.push(`${dlgPre}${itemTag}[id^='${staticIdPrefix}']${restSel}`);
                } else if (!mappedName) {
                  expandedParts.push(`${dlgPre}${itemTag}${restSel}`);
                }
              } else {
                expandedParts.push(part);
              }
            }
            workingSel = Array.from(new Set([...mappedTextFirstParts, ...expandedParts])).join(", ");
          }
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
              /[0-9a-f]{8}-[0-9a-f]{4}/i.test(childInputId) ||
              (/[0-9a-f]{12,}/i.test(childInputId) && /[a-f]/i.test(childInputId) && /[0-9]/.test(childInputId));
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
          const isEphemeralChildVal =
            /^[0-9]{8,}$|^(?:TA|TB|TG|TT|TY|ATCL|DOC|WKS|BRD|EML|NOT|SCD|TSK|WBB|WBP)[0-9a-zA-Z]{8,}$/i.test(childVal);
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
            /<(?:div|span|strong|em|p)\b[^<>]*\bclass=["'][^"']*\b(?:fc-title|name|tit|subj|title)\b[^"']*["'][^<>]*>([^<>]{2,35})<\//i
          );
          if (childPrimaryNameMatch && childPrimaryNameMatch[1]) {
            const cNameTxt = decodeEntities(childPrimaryNameMatch[1]).replace(/'/g, "").replace(/\s+/g, " ").trim();
            if (cNameTxt.length >= 2) {
              if (/\bfc-event\b/i.test(openTagAttrs)) {
                hasChildCandidates.unshift(`${idContainerPrefix}a.fc-event:has-text('${cNameTxt}'):visible`);
                if (idContainerPrefix !== modalPrefix) {
                  hasChildCandidates.push(`${modalPrefix}a.fc-event:has-text('${cNameTxt}'):visible`);
                }
              } else {
                hasChildCandidates.push(`${idContainerPrefix}${baseCls}:has-text('${cNameTxt}'):visible`);
                if (idContainerPrefix !== modalPrefix) {
                  hasChildCandidates.push(`${modalPrefix}${baseCls}:has-text('${cNameTxt}'):visible`);
                }
              }
            }
          }
          const currentParts = splitSelectorCandidates(workingSel);
          if (hasChildCandidates.length > 0 || currentParts.length > 0) {
            const leadingRowScopedChk =
              !childInputId && isEphemeralChildVal
                ? currentParts.filter((p) =>
                    /^(?:\.ui-dialog:visible\s+)?(?:[a-z0-9#._-]+\s+)?(?:(?:tr|li):has-text\(['"][^'"]+['"]\)\s+label\.(?:chkbox|rdobtn)|label\.(?:chkbox|rdobtn):has-text\(['"][^'"]+['"]\)):visible$/i.test(
                      p.trim()
                    )
                  )
                : [];
            workingSel = Array.from(new Set([...leadingRowScopedChk, ...hasChildCandidates, ...currentParts])).join(", ");
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
            /[0-9a-f]{8}-[0-9a-f]{4}/i.test(outerIdVal) ||
            (/[0-9a-f]{12,}/i.test(outerIdVal) && /[a-f]/i.test(outerIdVal) && /[0-9]/.test(outerIdVal));
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


      // Remove legacy duplicate #th\d+ or [name='th\d+'] when a row-scoped candidate exists, and demote ephemeral per-record IDs behind :has-text / data-*-name
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

      // If any candidate has an ancestor [data-trgt-id='...'],
      // synthesize a direct [data-trgt-id='...'] leaf selector at the front
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

      // If a bare tag:has-text('X'):visible coexists with a structural path ending in > parentTag.cls > tag:visible,
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
            !cand.includes("[title=");
          const isIdAnchoredNonListContainer =
            Boolean(cleanContainerId) &&
            cand.includes(`${cleanContainerId} >`) &&
            !/\b(?:li|tr|ul|ol|tbody|dd|\.dynatree-node)\b/i.test(cand);
          // Unscoped generic control text (e.g. label.chkbox:has-text('사용'):visible or button.btn:has-text('추가'):visible without row/ID/data-* scope)
          // must go to positionalLater so row-scoped tr:has(th:...) or ID-anchored DOM paths are evaluated FIRST!
          const isUnscopedGenericControlText =
            /:(?:has-text|text-is)\(['"](?:사용|미사용|추가|선택|삭제|수정|등록|취소|닫기|초기화|목록|설정|변환|적용)['"]\)/i.test(cand) &&
            !cand.includes("#") &&
            !hasDataAttr &&
            !cand.includes("tr:has(") &&
            !cand.includes("li:has") &&
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
              !isIdAnchoredNonListContainer);
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
          }
        }

        // Remove any previously generated first-token truncated :has-text('...') duplicates
        // when the full multi-word :has-text('...') with the identical selector prefix/suffix exists in specificFirst!
        const dedupedSpecificFirst = specificFirst.filter((cand) => {
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

    if (action.type === "click" || action.type === "rightclick" || action.type === "hover" || action.type === "type" || action.type === "upload") {
      if (action.selector) {
        const refined = refineSelectorString(action.selector, action.targetHtml);
        if (refined !== action.selector) {
          action.selector = refined;
          sel = refined;
          changes.push(`[셀렉터 정밀화] '${desc}' 셀렉터에서 정확 일치 텍스트/속성 및 고유 컨테이너를 최우선 배치했습니다.`);
          fixedActionsCount++;
        }
      }
    } else if (action.type === "dragAndDrop") {
      const srcToRefine = action.sourceSelector || action.selector || "";
      if (srcToRefine) {
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

  // Post-pass cleanup: merge consecutive wait actions
  const finalActions: BrowsePlanAction[] = [];

  for (let i = 0; i < optimizedActions.length; i++) {
    const act = optimizedActions[i];
    const desc = (act.description || "").trim();

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

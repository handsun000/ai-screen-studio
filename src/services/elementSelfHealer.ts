import { GoogleGenAI } from "@google/genai";
import type { Page } from "playwright";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
import type { BrowsePlanAction, BrowsePlan } from "../types";
import { getGroupwarePromptContext } from "./groupwareCatalog";

dotenv.config({ override: true });

export type SelfHealResolutionType =
  | "PATCH_SELECTOR"
  | "INSERT_BEFORE"
  | "REPLACE_STEPS"
  | "SKIP_AND_PRUNE"
  | "ABORT";

export interface SelfHealResult {
  success: boolean;
  resolutionType?: SelfHealResolutionType;
  selector: string;
  sourceSelector?: string;
  targetSelector?: string;
  iframe?: string | null;
  prerequisiteActions?: BrowsePlanAction[];
  replacementActions?: BrowsePlanAction[];
  confidence: number;
  reason: string;
}

export interface LiveDOMCandidate {
  tag: string;
  text: string;
  id?: string;
  className?: string;
  type?: string;
  name?: string;
  value?: string;
  placeholder?: string;
  title?: string;
  ariaLabel?: string;
  disabled?: boolean;
  rect?: { x: number; y: number; w: number; h: number };
  inModal?: string | boolean;
  inSidebar?: boolean;
  inHeader?: boolean;
  frame?: string;
  suggestedSelector: string;
}

/**
 * Scores and prioritizes live DOM candidates so critical modal elements, main form buttons,
 * and elements matching the current/next action descriptions are never truncated.
 */
function prioritizeSelfHealCandidates(
  candidates: LiveDOMCandidate[],
  currentAction: BrowsePlanAction,
  nextAction?: BrowsePlanAction,
  maxCount: number = 95
): LiveDOMCandidate[] {
  if (candidates.length <= maxCount) return candidates;

  const extractKeywords = (act?: BrowsePlanAction): string[] => {
    if (!act) return [];
    const raw = `${act.description || ""} ${act.text || ""} ${act.selector || ""}`;
    return raw
      .replace(/[[\]()'".,:#>-]/g, " ")
      .split(/\s+/)
      .map((w) => w.trim().toLowerCase())
      .filter(
        (w) =>
          w.length >= 2 &&
          !["버튼", "클릭", "입력", "선택", "화면", "영역", "모달", "팝업", "visible", "has", "text", "button", "input"].includes(w)
      );
  };

  const currKeywords = extractKeywords(currentAction);
  const nextKeywords = extractKeywords(nextAction);
  const descLower = (currentAction.description || "").toLowerCase();
  const wantsGnb =
    descLower.includes("전체메뉴") ||
    descLower.includes("포탈") ||
    descLower.includes("gnb") ||
    descLower.includes("상단 헤더");

  const scored = candidates.map((c, idx) => {
    let score = 0;
    const hay = `${c.text || ""} ${c.id || ""} ${c.name || ""} ${c.placeholder || ""} ${c.title || ""} ${c.className || ""} ${c.suggestedSelector || ""}`.toLowerCase();

    // 1. Active modal elements get highest priority
    if (c.inModal) {
      score += 120;
    }

    // 2. Direct keyword match with current failed action
    for (const kw of currKeywords) {
      if (hay.includes(kw)) score += 85;
    }

    // 3. Keyword match with next action (essential for detecting SKIP_AND_PRUNE)
    for (const kw of nextKeywords) {
      if (hay.includes(kw)) score += 60;
    }

    // 4. Action type compatibility
    if (currentAction.type === "type") {
      if (["input", "textarea", "body"].includes(c.tag) || hay.includes("editor") || hay.includes("subject") || hay.includes("search")) {
        score += 65;
      } else if (c.tag === "button") {
        score -= 30;
      }
    } else if (currentAction.type === "click" || currentAction.type === "dblclick") {
      if (["button", "a", "label", "input", "span"].includes(c.tag)) {
        score += 35;
      }
      if (
        /저장|상신|기안|등록|작성|확인|검색|선택|신청|추가|결재|반려|승인|보내기|발송|예약|펼침|전체메뉴/.test(
          `${c.text || ""} ${c.title || ""}`
        )
      ) {
        score += 50;
      }
    } else if (currentAction.type === "dragAndDrop") {
      if (hay.includes("dynatree") || hay.includes("af_") || hay.includes("app_flow") || hay.includes("line")) {
        score += 80;
      }
    }

    // 5. Unique ID bonus
    if (c.id && !c.id.startsWith("ui-id-")) {
      score += 25;
    }

    // 6. Sidebar write/action buttons vs GNB header noise
    if (c.inSidebar && c.tag === "button") {
      score += 35;
    }
    if (c.inHeader && !wantsGnb) {
      score -= 45;
    }

    return { candidate: c, score, idx };
  });

  scored.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.idx - b.idx));
  return scored.slice(0, maxCount).map((s) => s.candidate);
}

/**
 * Extracts visible interactive elements from the current page and all visible iframes (e.g. #subBody),
 * including bounding box coordinates (rect) and disabled state, then prioritizes the top candidates.
 */
export async function extractLiveCandidates(
  page: Page,
  currentAction?: BrowsePlanAction,
  nextAction?: BrowsePlanAction
): Promise<{
  activeDialogTitle?: string;
  candidates: LiveDOMCandidate[];
}> {
  try {
    // 1. Extract from top-level document
    const topData = await page.evaluate(() => {
      const candidates: Array<{
        tag: string;
        text: string;
        id?: string;
        className?: string;
        type?: string;
        name?: string;
        value?: string;
        placeholder?: string;
        title?: string;
        ariaLabel?: string;
        disabled?: boolean;
        rect?: { x: number; y: number; w: number; h: number };
        inModal?: string | boolean;
        inSidebar?: boolean;
        inHeader?: boolean;
        frame?: string;
        suggestedSelector: string;
      }> = [];

      // Detect active top dialog / modal
      let activeDialogTitle = "";
      const rawDialogs = Array.from(
        document.querySelectorAll(
          ".ui-dialog, .modal, [role='dialog'], .layer_wrap, .equ_select_lyr, #alert_lyr, div[id*='Dialog'], div[class*='dialog']"
        )
      );
      const visibleDialogs = rawDialogs.filter((d) => {
        const r = d.getBoundingClientRect();
        const s = window.getComputedStyle(d);
        return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden";
      });
      if (visibleDialogs.length > 0) {
        const topDialog = visibleDialogs[visibleDialogs.length - 1];
        const titleEl = topDialog.querySelector(
          ".ui-dialog-title, .modal-title, .tit, h3, h4, .title"
        );
        if (titleEl) {
          activeDialogTitle = (titleEl.textContent || "").trim();
        }
      }

      // Query visible interactive elements (including approval flow slots & template cards)
      const query =
        "button, a, input, select, textarea, [contenteditable='true'], [contenteditable=''], .note-editable, .ce-paragraph, div[role='textbox'], [role='button'], .dynatree-node, .dynatree-checkbox, .dynatree-title, .dynatree-expander, .fancytree-node, .fancytree-expander, .fancytree-title, [class*='expander'], [class*='tree-title'], [class*='node-title'], .fc-event, .fc-title, .fc-content, [class*='fc-event'], [class*='fc-daygrid'], .app_work_box, div.app_flow, td[id^='af_'], div[id^='af_'], label, li[class*='item'], li[class*='depth'], li.aw_li, div[onclick], span[onclick]";
      const elements = Array.from(document.querySelectorAll(query));

      for (const el of elements) {
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0 || rect.bottom < 0 || rect.right < 0) {
          continue;
        }
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
          continue;
        }

        const tag = el.tagName.toLowerCase();
        const text = (el.textContent || "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 50);
        const id = el.id ? el.id.trim() : undefined;
        const className =
          el.className && typeof el.className === "string"
            ? el.className.trim()
            : undefined;
        const type = (el as HTMLInputElement).type || undefined;
        const name = (el as HTMLInputElement).name || undefined;
        const value = (el as HTMLInputElement).value
          ? String((el as HTMLInputElement).value).slice(0, 40)
          : undefined;
        const placeholder = (el as HTMLInputElement).placeholder || undefined;
        const title = (el as HTMLElement).title || undefined;
        const ariaLabel = el.getAttribute("aria-label") || undefined;
        const disabled =
          (el as HTMLButtonElement).disabled ||
          el.hasAttribute("disabled") ||
          el.classList.contains("disabled") ||
          undefined;

        // Context checks
        const modalContainer = el.closest(".ui-dialog, .modal, [role='dialog'], .layer_wrap");
        const inModal = modalContainer ? activeDialogTitle || true : false;
        const inSidebar = !!el.closest("#snb, .snb, .aside, .left_menu, aside");
        const inHeader = !!el.closest("header, #header, .gnb, .top_menu, nav");

        let scopePrefix = "";
        if (inModal) {
          scopePrefix = ".ui-dialog:visible ";
        } else if (inSidebar) {
          scopePrefix = "#snb ";
        } else if (inHeader) {
          scopePrefix = "header ";
        }

        let suggestedSelector = "";
        if (id && !id.startsWith("ui-id-") && !id.startsWith("_")) {
          suggestedSelector = `${scopePrefix}${tag}#${id}`;
        } else if (text && text.length >= 2 && text.length <= 25) {
          suggestedSelector = `${scopePrefix}${tag}:has-text('${text}')`;
        } else if (name && value) {
          suggestedSelector = `${scopePrefix}${tag}[name='${name}'][value='${value}']`;
        } else if (name) {
          suggestedSelector = `${scopePrefix}${tag}[name='${name}']`;
        } else if (placeholder) {
          suggestedSelector = `${scopePrefix}${tag}[placeholder*='${placeholder}']`;
        } else if (title) {
          suggestedSelector = `${scopePrefix}${tag}[title*='${title}']`;
        } else if (className) {
          const firstClass = className.split(/\s+/)[0];
          if (firstClass && !firstClass.startsWith("ui-")) {
            suggestedSelector = `${scopePrefix}${tag}.${firstClass}`;
          }
        }

        if (!suggestedSelector) {
          suggestedSelector = `${scopePrefix}${tag}`;
        }

        candidates.push({
          tag,
          text,
          id,
          className,
          type,
          name,
          value,
          placeholder,
          title,
          ariaLabel,
          disabled,
          rect: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            w: Math.round(rect.width),
            h: Math.round(rect.height),
          },
          inModal,
          inSidebar,
          inHeader,
          suggestedSelector,
        });

        if (candidates.length >= 450) break;
      }

      return {
        activeDialogTitle: activeDialogTitle || undefined,
        candidates,
      };
    });

    const activeDialogTitle = topData.activeDialogTitle;
    const allCandidates: LiveDOMCandidate[] = [...(topData.candidates || [])];

    // 2. Scan visible iframes (e.g. #subBody, #contentFrame, iframe:visible)
    try {
      const iframeSelectors = await page.evaluate(() => {
        const iframes = Array.from(document.querySelectorAll("iframe"));
        return iframes
          .map((f) => {
            const rect = f.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) return null;
            if (f.id) return `iframe#${f.id}`;
            if (f.name) return `iframe[name='${f.name}']`;
            return "iframe:visible";
          })
          .filter(Boolean) as string[];
      });

      for (const iframeSel of iframeSelectors) {
        if (allCandidates.length >= 600) break;
        try {
          const frameLocator = page.frameLocator(iframeSel);
          const bodyLoc = frameLocator.locator("body");
          const isBodyVisible = await bodyLoc.isVisible({ timeout: 800 }).catch(() => false);
          if (!isBodyVisible) continue;

          const frameCandidates = await bodyLoc
            .evaluate((body, frameSel) => {
              const list: any[] = [];
              const query =
                "button, a, input, select, textarea, [contenteditable='true'], [contenteditable=''], .note-editable, .ce-paragraph, body, [role='button'], .dynatree-node, .dynatree-checkbox, .dynatree-title, .dynatree-expander, .fancytree-node, .fancytree-expander, .fancytree-title, [class*='expander'], [class*='tree-title'], [class*='node-title'], label, li[class*='item'], li[class*='depth']";
              const elements = Array.from(body.querySelectorAll(query));

              for (const el of elements) {
                const rect = el.getBoundingClientRect();
                if (rect.width <= 0 || rect.height <= 0) continue;
                const style = window.getComputedStyle(el);
                if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
                  continue;
                }

                const tag = el.tagName.toLowerCase();
                const text = (el.textContent || "")
                  .replace(/\s+/g, " ")
                  .trim()
                  .slice(0, 50);
                const id = el.id ? el.id.trim() : undefined;
                const className =
                  el.className && typeof el.className === "string"
                    ? el.className.trim()
                    : undefined;
                const type = (el as HTMLInputElement).type || undefined;
                const name = (el as HTMLInputElement).name || undefined;
                const value = (el as HTMLInputElement).value
                  ? String((el as HTMLInputElement).value).slice(0, 40)
                  : undefined;
                const placeholder = (el as HTMLInputElement).placeholder || undefined;
                const title = (el as HTMLElement).title || undefined;

                let suggestedSelector = "";
                if (id && !id.startsWith("ui-id-") && !id.startsWith("_")) {
                  suggestedSelector = `${tag}#${id}`;
                } else if (text && text.length >= 2 && text.length <= 25) {
                  suggestedSelector = `${tag}:has-text('${text}')`;
                } else if (name && value) {
                  suggestedSelector = `${tag}[name='${name}'][value='${value}']`;
                } else if (name) {
                  suggestedSelector = `${tag}[name='${name}']`;
                } else if (placeholder) {
                  suggestedSelector = `${tag}[placeholder*='${placeholder}']`;
                } else if (className) {
                  const firstClass = className.split(/\s+/)[0];
                  if (firstClass && !firstClass.startsWith("ui-")) {
                    suggestedSelector = `${tag}.${firstClass}`;
                  }
                }
                if (!suggestedSelector) suggestedSelector = tag;

                list.push({
                  tag,
                  text,
                  id,
                  className,
                  type,
                  name,
                  value,
                  placeholder,
                  title,
                  rect: {
                    x: Math.round(rect.x),
                    y: Math.round(rect.y),
                    w: Math.round(rect.width),
                    h: Math.round(rect.height),
                  },
                  frame: frameSel,
                  suggestedSelector,
                });

                if (list.length >= 200) break;
              }
              return list;
            }, iframeSel);

          if (frameCandidates && frameCandidates.length > 0) {
            allCandidates.push(...frameCandidates);
          }
        } catch {}
      }
    } catch {}

    const prioritized = currentAction
      ? prioritizeSelfHealCandidates(allCandidates, currentAction, nextAction, 95)
      : allCandidates.slice(0, 95);

    return {
      activeDialogTitle,
      candidates: prioritized,
    };
  } catch (err) {
    return { candidates: [] };
  }
}

/**
 * AI Runtime Self-Healing & Dynamic Scenario Adjustment Architect:
 * Takes the failed action + surrounding scenario timeline, captures the live browser screenshot + prioritized DOM candidates,
 * cross-references the Naonsoft 18-module catalog, and either patches the selector, inserts missing prerequisite steps,
 * replaces the step with a multi-step sequence, or prunes an already-completed/redundant step.
 */
export async function selfHealElement(
  page: Page,
  action: BrowsePlanAction,
  stepIndex: number,
  totalSteps: number,
  dataDir?: string,
  plan?: BrowsePlan
): Promise<SelfHealResult | null> {
  const apiKeys = [
    process.env.GEMINI_API_KEY,
    process.env.GEMINI_API_KEY_ALT,
  ].filter(Boolean) as string[];

  if (apiKeys.length === 0) {
    console.warn("  [⚠️ AI 자가 치유] GEMINI_API_KEY가 없어 자가 치유를 생략합니다.");
    return null;
  }

  // 1. Capture live screen screenshot (JPEG Base64)
  let screenshotBase64 = "";
  try {
    const screenshotBuffer = await page.screenshot({
      type: "jpeg",
      quality: 65,
    });
    screenshotBase64 = screenshotBuffer.toString("base64");
  } catch {}

  // 2. Identify surrounding scenario steps (prev 3 ~ current ~ next 3)
  const actionsList = plan?.actions || [];
  const currentZeroIdx = Math.max(0, stepIndex - 1);
  const nextAction = actionsList[currentZeroIdx + 1];
  const prevStepsSummary = actionsList
    .slice(Math.max(0, currentZeroIdx - 3), currentZeroIdx)
    .map(
      (a, idx) =>
        `  [Step #${Math.max(1, stepIndex - 3) + idx} (완료)] type="${a.type}", desc="${a.description || ""}", selector="${a.selector || a.sourceSelector || ""}"`
    )
    .join("\n");
  const nextStepsSummary = actionsList
    .slice(currentZeroIdx + 1, currentZeroIdx + 4)
    .map(
      (a, idx) =>
        `  [Step #${stepIndex + 1 + idx} (예정)] type="${a.type}", desc="${a.description || ""}", selector="${a.selector || a.sourceSelector || ""}"`
    )
    .join("\n");

  // 3. Extract prioritized live interactive DOM candidates (top-level + visible iframes)
  const { activeDialogTitle, candidates } = await extractLiveCandidates(page, action, nextAction);

  // 4. Match Groupware Module Catalog context
  const currentUrl = page.url();
  const catalogContext = getGroupwarePromptContext(
    `${currentUrl} ${plan?.url || ""} ${action.description || ""} ${nextAction?.description || ""}`
  );

  // 5. Hybrid Prompting: English Control Logic + Korean Domain/UI Precision
  const systemInstruction = `
You are the **Runtime Self-Healing & Scenario Adjustment Architect** for a Playwright + Remotion enterprise video automation studio.
During live browser recording, Step #${stepIndex} failed to locate its target element.
Your job is to inspect the **Live Screenshot**, **Live Interactive DOM Candidates (with {x,y,w,h} coordinates)**, **Scenario Timeline (Previous/Current/Next Steps)**, and **Enterprise Module Catalog**, then return a **100% verified JSON recovery decision** in a single turn.

---

### [1] 5-Mode Scenario Adjustment Matrix (\`resolutionType\`)

Analyze WHY Step #${stepIndex} failed by comparing the Live Screenshot + DOM against the Scenario Timeline, and select **exact ONE** \`resolutionType\`:

1. **\`"PATCH_SELECTOR"\` (Target IS Visible on Screen)**:
   - The intended button/input/node IS currently visible in the Screenshot & DOM candidates, and only the CSS/Playwright selector (or \`iframe\`, \`sourceSelector\`, \`targetSelector\`) was inaccurate.
   - Return \`"success": true, "resolutionType": "PATCH_SELECTOR", "selector": "..."\` (and \`"sourceSelector"\` / \`"targetSelector"\` if \`action.type === "dragAndDrop"\`).

2. **\`"INSERT_BEFORE"\` (Target is Hidden Because a Prerequisite Step was Missed)**:
   - The target element for Step #${stepIndex} is NOT on screen yet because an intermediate UI action must happen first!
   - **Common Cases**:
     • Trying to click a GNB module link (e.g., \`일정관리\`, \`전자결재\`, \`자원예약\`) while the Portal All-Menu Drawer (\`button.btn_svc_open:visible\`) is still closed -> Insert \`[{"type": "click", "selector": "button.btn_svc_open:visible", "description": "포탈 전체메뉴 열기"}, {"type": "wait", "ms": 1200, "description": "전체메뉴 서랍 열림 대기"}]\`!
     • Trying to type the title (\`#eapDocReg_docSubject\`, \`#subject\`) in Electronic Approval (\`eap\`) while still on the Template Selection screen (\`#eapWorkSelect_workList\`) -> Insert clicking the inner **[작성]** button (\`{"type": "click", "selector": "ul.aw_ul li.aw_li button.btn_write:visible, .app_work_box button.btn_write:visible", "description": "양식 카드 내 작성 버튼 클릭"}, {"type": "wait", "ms": 3000, "description": "기안 작성 폼 로드 대기"}\` — NEVER click \`a._his\` as it only toggles history)!
     • Trying to select a child folder/node in a Dynatree modal while the parent folder is collapsed -> Insert clicking the tree expander (\`.ui-dialog:visible #docSelect_expandTree:visible, .ui-dialog:visible .btn_fopn:visible, .ui-dialog:visible .dynatree-expander:visible\`) + \`wait: 800\`!
     • Blocked by an unclosed modal/alert dialog from the previous step -> Insert clicking its confirm/close button (\`.ui-dialog:visible button._confirmBtn:visible, .ui-dialog:visible button:has-text('확인'):visible\`) + \`wait: 1000\`!
   - Return \`"success": true, "resolutionType": "INSERT_BEFORE", "prerequisiteActions": [...], "selector": "patched_selector_for_current_step_if_known"\`.

3. **\`"REPLACE_STEPS"\` (Coarse Step Must Be Split into 2~3 Atomic Steps)**:
   - Step #${stepIndex} tries to do multiple interactions at once or needs a multi-step alternative (e.g., a failed \`dragAndDrop\` that can be cleanly achieved by \`[check user checkbox -> click role add button]\`).
   - Return \`"success": true, "resolutionType": "REPLACE_STEPS", "replacementActions": [...] \`.

4. **\`"SKIP_AND_PRUNE"\` (Step is Already Completed or Redundant on This Form)**:
   - Looking at the Screenshot, DOM, and \`Next Steps\`, the UI has **ALREADY advanced past Step #${stepIndex}** (e.g., Step #${stepIndex} tries to click a modal \`[확인]\` button, but the modal is already closed and Step #${stepIndex + 1}'s target is already visible on screen), OR Step #${stepIndex} targets a non-mandatory sub-option (e.g., 보존기간, 공개범위, 태그) that does not exist on this specific form.
   - Return \`"success": true, "resolutionType": "SKIP_AND_PRUNE", "selector": ""\`.

5. **\`"ABORT"\` (Target Genuinely Cannot Be Found or Reached)**:
   - If the user requested a specific named item (e.g., \`'테스트'\`, \`'김철수'\`, specific document title) that does NOT exist on screen and cannot be revealed by any prerequisite button on screen, DO NOT pick a random \`:first-child\` item to fake success!
   - Return \`"success": false, "resolutionType": "ABORT", "selector": ""\`.

---

### [2] 7 Golden Selector Rules (Playwright Precision)

1. 🚫 **Zero-Guessing Policy**: NEVER invent fake IDs (\`#_DOC_TITLE_\`, \`#btn_submit\`). Use ONLY real \`id\`, \`className\`, \`name\`, or visible Korean text (\`:has-text('...')\`) confirmed in \`[Live Interactive DOM Candidates]\`.
2. 🪟 **Modal Dialog Isolation**: If \`activeDialogTitle\` is present or the target has \`inModal: true\`, ALWAYS prefix the selector with \`.ui-dialog:visible \` (or \`.modal:visible \`).
   - Note: In Naonsoft Groupware, Schedule Registration (\`#dl_reg_schedule_form\`), Resource Reservation (\`#dl_reg_res_form\`), and Approval Opinion (\`#eapApproval\`) forms ARE inside \`.ui-dialog:visible\`!
3. 🖼️ **Iframe Context**: If the candidate has a \`frame\` property (e.g., \`iframe#subBody\`), set \`"iframe": "iframe#subBody"\`.
4. 🎯 **Atomic Interactive Leaf Tag**: Target actual clickable/typable leaf tags (\`button\`, \`a\`, \`input\`, \`textarea\`, \`select\`, \`span.dynatree-checkbox\`, \`a.dynatree-title\`), never wide wrapper \`div\` or \`form\` containers.
5. 🛡️ **Robust Dual Fallback via Comma**: Combine exact ID/class and text matching with a comma (\`, \`) and append \`:visible\`.
   - Example: \`".ui-dialog:visible button#savebtn:visible, .ui-dialog:visible button:has-text('저장'):visible"\`
6. 🔍 **Module vs GNB Header Isolation**: Never pick global portal header (\`inHeader: true\`, \`#header\`) search bars or buttons when working inside a module's sidebar (\`inSidebar: true\`, \`#snb\`) or main content area (\`#content\`).
7. 🇰🇷 **Korean Localization**: Write \`reason\` and any \`description\` inside \`prerequisiteActions\` / \`replacementActions\` in clear **Korean (한국어)**.

---

### [3] Strict JSON Response Schema
Return ONLY a valid JSON object matching this exact structure (no markdown code fences):
{
  "success": true,
  "resolutionType": "PATCH_SELECTOR",
  "selector": ".ui-dialog:visible button#savebtn:visible, .ui-dialog:visible button:has-text('저장'):visible",
  "sourceSelector": "",
  "targetSelector": "",
  "iframe": null,
  "prerequisiteActions": [],
  "replacementActions": [],
  "confidence": 0.98,
  "reason": "화면 중앙 '일정 등록' 모달 내부 우측 하단의 '저장' 버튼(#savebtn)이 확인되어 셀렉터를 보정함"
}
`;

  const userPrompt = `
### [Current Execution Context]
- **Current URL**: ${currentUrl}
- **Failed Step**: #${stepIndex} / Total ${totalSteps} steps
- **Action Type**: "${action.type}"
- **Action Description**: "${action.description || ""}"
${action.type === "type" ? `- **Text to Type**: "${action.text || ""}"` : ""}
${
  action.type === "dragAndDrop"
    ? `- **Failed Source Selector**: "${action.sourceSelector || action.selector || ""}"\n- **Failed Target Selector**: "${action.targetSelector || ""}"`
    : `- **Failed Selector**: "${action.selector || "(empty)"}"`
}
- **Configured Iframe**: "${action.iframe || "none (top-level page)"}"
- **Active Topmost Modal Title**: ${activeDialogTitle ? `"${activeDialogTitle}"` : "None (no modal open)"}

### [Scenario Timeline Context (Surrounding Steps)]
- **Previous Completed Steps**:
${prevStepsSummary || "  (None - this is the first step)"}
- **👉 CURRENT FAILED STEP (#${stepIndex})**:
  type="${action.type}", desc="${action.description || ""}", selector="${action.selector || action.sourceSelector || ""}"
- **Upcoming Next Steps**:
${nextStepsSummary || "  (None - this is the final step)"}

${catalogContext ? `### [Enterprise Module Standard DOM Reference]\n${catalogContext}\n` : ""}
### [Live Interactive DOM Candidates on Screen (Top ${candidates.length} Prioritized Elements)]
${JSON.stringify(candidates, null, 2)}

### [Task]
Cross-examine the attached **Live Screenshot**, the **Scenario Timeline**, and the **Live Interactive DOM Candidates**.
Determine whether to:
1) \`PATCH_SELECTOR\` (target is visible on screen now),
2) \`INSERT_BEFORE\` (insert 1~2 missing prerequisite actions like opening a drawer/modal/template before this step),
3) \`REPLACE_STEPS\` (split this step into 2~3 concrete steps),
4) \`SKIP_AND_PRUNE\` (this step is already completed or is an unrequested non-existent sub-option), or
5) \`ABORT\` (\`"success": false\` if a specifically named target genuinely does not exist).
`;

  const configuredModel = process.env.GEMINI_MODEL || "gemini-3.8-flash";
  const candidateModels = Array.from(
    new Set([
      configuredModel,
      "gemini-3.8-flash",
      "gemini-3.5-flash",
      "gemini-flash-latest",
    ])
  );

  console.log(
    `  [🤖 AI 실시간 자가 치유 & 시나리오 조정] 화면 DOM 후보군 (${candidates.length}개) 및 전후 시나리오 맥락 추출 완료, AI 분석 요청 중...`
  );

  for (const model of candidateModels) {
    for (const key of apiKeys) {
      try {
        const ai = new GoogleGenAI({ apiKey: key });

        const parts: any[] = [];
        if (screenshotBase64) {
          parts.push({
            inlineData: {
              mimeType: "image/jpeg",
              data: screenshotBase64,
            },
          });
        }
        parts.push({ text: userPrompt });

        const aiStart = Date.now();
        console.log(`  [🤖 AI 실시간 자가 치유] Gemini (${model}) 멀티모달 시나리오 진단 요청 중...`);

        const response = await ai.models.generateContent({
          model,
          contents: [{ role: "user", parts }],
          config: {
            systemInstruction,
            temperature: 0.1,
            maxOutputTokens: 4096,
            responseMimeType: "application/json",
          },
        });

        console.log(
          `  [🤖 AI 실시간 자가 치유] Gemini (${model}) 응답 수신 완료 (${Date.now() - aiStart}ms)`
        );

        const rawText = response.text || "";
        let parsed: any = null;
        try {
          const jsonMatch = rawText.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            parsed = JSON.parse(jsonMatch[0]);
          } else {
            parsed = JSON.parse(rawText.trim());
          }
        } catch (jsonErr: any) {
          console.warn(
            `  [AI 응답 파싱 경고] (${model}) JSON 파싱 오류: ${jsonErr.message}. 원문: ${rawText.slice(0, 120)}...`
          );
        }

        if (parsed && typeof parsed.success === "boolean") {
          const resolutionType: SelfHealResolutionType =
            parsed.resolutionType || (parsed.success ? "PATCH_SELECTOR" : "ABORT");

          if (!parsed.success || resolutionType === "ABORT") {
            console.warn(
              `  [⚠️ AI 자가 치유 포기 (ABORT)] AI가 대상 요소를 화면에서 찾을 수 없다고 판단했습니다. 사유: ${parsed.reason}`
            );
            return {
              success: false,
              resolutionType: "ABORT",
              selector: "",
              iframe: null,
              confidence: 0,
              reason: parsed.reason || "화면에 요소가 존재하지 않음",
            };
          }

          // Handle SKIP_AND_PRUNE
          if (resolutionType === "SKIP_AND_PRUNE") {
            console.log(
              `  [✂️ AI 시나리오 조정 - SKIP_AND_PRUNE] 현재 단계가 이미 완료되었거나 불필요한 단계로 진단됨: ${parsed.reason}`
            );
            return {
              success: true,
              resolutionType: "SKIP_AND_PRUNE",
              selector: "",
              iframe: null,
              confidence: parsed.confidence || 0.95,
              reason: parsed.reason || "이미 다음 화면 상태에 도달하여 불필요한 단계 프루닝",
            };
          }

          // Handle INSERT_BEFORE
          if (
            resolutionType === "INSERT_BEFORE" &&
            Array.isArray(parsed.prerequisiteActions) &&
            parsed.prerequisiteActions.length > 0
          ) {
            console.log(
              `  [➕ AI 시나리오 조정 - INSERT_BEFORE] 현재 단계 실행 전 누락된 선행 액션 ${parsed.prerequisiteActions.length}개를 삽입합니다: ${parsed.reason}`
            );
            return {
              success: true,
              resolutionType: "INSERT_BEFORE",
              selector: parsed.selector || action.selector || "",
              sourceSelector: parsed.sourceSelector || action.sourceSelector,
              targetSelector: parsed.targetSelector || action.targetSelector,
              iframe: parsed.iframe ?? action.iframe ?? null,
              prerequisiteActions: parsed.prerequisiteActions,
              confidence: parsed.confidence || 0.95,
              reason: parsed.reason || "누락된 선행 화면 조작 단계 동적 삽입",
            };
          }

          // Handle REPLACE_STEPS
          if (
            resolutionType === "REPLACE_STEPS" &&
            Array.isArray(parsed.replacementActions) &&
            parsed.replacementActions.length > 0
          ) {
            console.log(
              `  [🔄 AI 시나리오 조정 - REPLACE_STEPS] 현재 액션을 ${parsed.replacementActions.length}개의 세부 단계로 분할 교체합니다: ${parsed.reason}`
            );
            return {
              success: true,
              resolutionType: "REPLACE_STEPS",
              selector: parsed.selector || "",
              iframe: parsed.iframe ?? action.iframe ?? null,
              replacementActions: parsed.replacementActions,
              confidence: parsed.confidence || 0.95,
              reason: parsed.reason || "현재 액션을 다단계 세부 시퀀스로 분할 교정",
            };
          }

          // Handle PATCH_SELECTOR (including dragAndDrop source/target patching)
          if (parsed.selector || parsed.sourceSelector || parsed.targetSelector) {
            const effectiveSelector = parsed.selector || action.selector || "";

            // Guard 1: Type actions must NEVER target a button element
            if (action.type === "type" && effectiveSelector) {
              const lowerSel = effectiveSelector.toLowerCase();
              if (
                (lowerSel.includes("button") || lowerSel.includes(".btn")) &&
                !lowerSel.includes("input") &&
                !lowerSel.includes("textarea") &&
                !lowerSel.includes("contenteditable") &&
                !lowerSel.includes("body") &&
                !lowerSel.includes("iframe")
              ) {
                console.warn(
                  `  [⚠️ AI 자가 치유 거절] type(입력) 액션에 버튼 셀렉터('${effectiveSelector}')가 반환되어 적용을 거부합니다.`
                );
                continue;
              }
            }

            // Guard 2: Only reject .ui-dialog on form registration actions if the active modal is strictly a folder/category picker
            // (Do NOT reject when the registration form itself is a modal like '일정 등록', '예약 신청', '결재 의견'!)
            const descLower = (action.description || "").toLowerCase();
            const isFolderPickerModal =
              activeDialogTitle &&
              /문서함 선택|게시판 선택|분류 선택|폴더 선택/.test(activeDialogTitle);
            const isMainFormFieldAction =
              descLower.includes("제목") ||
              descLower.includes("본문") ||
              descLower.includes("내용");

            if (
              isMainFormFieldAction &&
              isFolderPickerModal &&
              effectiveSelector.includes(".ui-dialog")
            ) {
              console.warn(
                `  [⚠️ AI 자가 치유 거절] 본문 입력 액션('${action.description}')이나 현재 폴더 선택 팝업('${activeDialogTitle}')이 열려 있어 모달 내부 셀렉터('${effectiveSelector}')를 거부합니다.`
              );
              continue;
            }

            // Guard 3: Modal confirmation actions must NEVER target main document body or subBody iframe when a modal is actively open
            const isModalConfirmAction =
              Boolean(activeDialogTitle) &&
              (descLower.includes("팝업") || descLower.includes("모달")) &&
              (descLower.includes("확인") || descLower.includes("완료"));

            if (
              isModalConfirmAction &&
              (parsed.iframe ||
                effectiveSelector.includes("subBody") ||
                effectiveSelector.includes("contentFrame"))
            ) {
              console.warn(
                `  [⚠️ AI 자가 치유 거절] 모달 확인 액션('${action.description}')에 본문 프레임 셀렉터('${effectiveSelector}')가 반환되어 적용을 거부합니다.`
              );
              continue;
            }

            return {
              success: true,
              resolutionType: "PATCH_SELECTOR",
              selector: effectiveSelector,
              sourceSelector: parsed.sourceSelector || undefined,
              targetSelector: parsed.targetSelector || undefined,
              iframe: parsed.iframe || null,
              confidence: parsed.confidence || 0.95,
              reason:
                parsed.reason ||
                "AI 런타임 화면 분석을 통해 올바른 요소를 감지했습니다.",
            };
          }
        }
      } catch (err: any) {
        console.warn(`  [AI 자가 치유 호출 경고] 모델 ${model} 호출 오류: ${err.message}`);
      }
    }
  }

  return null;
}

/**
 * Persists healed selectors, inserted prerequisite actions, replaced step sequences,
 * and pruned actions cleanly back into browse-plan.json so the scenario adjustment is permanent.
 */
export function saveHealedPlan(dataDir: string, plan: BrowsePlan): void {
  try {
    const planPath = path.join(dataDir, "browse-plan.json");
    if (!fs.existsSync(planPath)) return;

    const cleanActions: BrowsePlanAction[] = [];
    for (const act of plan.actions) {
      const anyAct = act as any;
      if (anyAct._shouldPrune) {
        continue;
      }
      if (Array.isArray(anyAct._insertBefore) && anyAct._insertBefore.length > 0) {
        for (const pre of anyAct._insertBefore) {
          const cleanPre = { ...pre };
          delete (cleanPre as any)._insertBefore;
          delete (cleanPre as any)._replaceWith;
          delete (cleanPre as any)._shouldPrune;
          delete (cleanPre as any)._wasSkipped;
          delete (cleanPre as any)._lastHealReason;
          delete (cleanPre as any)._hasReloadRetried;
          cleanActions.push(cleanPre);
        }
      }
      if (Array.isArray(anyAct._replaceWith) && anyAct._replaceWith.length > 0) {
        for (const rep of anyAct._replaceWith) {
          const cleanRep = { ...rep };
          delete (cleanRep as any)._insertBefore;
          delete (cleanRep as any)._replaceWith;
          delete (cleanRep as any)._shouldPrune;
          delete (cleanRep as any)._wasSkipped;
          delete (cleanRep as any)._lastHealReason;
          delete (cleanRep as any)._hasReloadRetried;
          cleanActions.push(cleanRep);
        }
        continue;
      }

      const cleanAct = { ...act };
      delete (cleanAct as any)._insertBefore;
      delete (cleanAct as any)._replaceWith;
      delete (cleanAct as any)._shouldPrune;
      delete (cleanAct as any)._wasSkipped;
      delete (cleanAct as any)._lastHealReason;
      delete (cleanAct as any)._hasReloadRetried;
      cleanActions.push(cleanAct);
    }

    const cleanPlan: BrowsePlan = {
      ...plan,
      actions: cleanActions,
    };

    fs.writeFileSync(planPath, JSON.stringify(cleanPlan, null, 2), "utf-8");
    console.log(
      `  [💾 시나리오 영구 보정 완료] 조정된 시나리오(총 ${cleanActions.length}단계)가 browse-plan.json에 반영되었습니다.`
    );
  } catch (err) {
    console.warn("  [주의] browse-plan.json 업데이트 실패:", err);
  }
}

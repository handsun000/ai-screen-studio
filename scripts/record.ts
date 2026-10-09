import { chromium, type Browser, type Page, type BrowserContext, type Locator } from "playwright";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import { execSync } from "child_process";
import { getVideoMetadata } from "@remotion/renderer";
import type { BrowsePlan, BrowsePlanAction, Moment, MomentsFile } from "../src/types";
import { sanitizeBrowsePlan } from "../src/services/planSanitizer";
import { selfHealElement, saveHealedPlan } from "../src/services/elementSelfHealer";

function clampToViewport(
  x: number,
  y: number,
  vw: number,
  vh: number
): { x: number; y: number } {
  return {
    x: Math.max(0, Math.min(vw, x)),
    y: Math.max(0, Math.min(vh, y)),
  };
}

function waitForEnter(): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question("", () => {
      rl.close();
      resolve();
    });
  });
}

function bringWindowToForeground() {
  if (process.platform !== "win32") return;
  const psCmd = `
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class WinTop {
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern int GetClassName(IntPtr hWnd, System.Text.StringBuilder lpClassName, int nMaxCount);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
    public static void Top() {
        EnumWindows((hWnd, lParam) => {
            var cn = new System.Text.StringBuilder(256);
            GetClassName(hWnd, cn, cn.Capacity);
            if (cn.ToString().Contains("Chrome_WidgetWin")) {
                ShowWindow(hWnd, 9);
                SetWindowPos(hWnd, new IntPtr(-1), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0040);
                SetForegroundWindow(hWnd);
                SetWindowPos(hWnd, new IntPtr(-2), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0040);
            }
            return true;
        }, IntPtr.Zero);
    }
}
'@
[WinTop]::Top()
`;
  try {
    const { spawn } = require("child_process");
    spawn("powershell", ["-NoProfile", "-Command", psCmd], { stdio: "ignore", detached: true });
  } catch {}
}

async function getLocator(page: Page, action: BrowsePlanAction): Promise<Locator | null> {
  const desc = (action.description || "").toLowerCase();

  // 1. Syntax Auto-Fixer (Heals common user input syntax errors like button:btn_svc_open -> button.btn_svc_open)
  let selector = (action.selector || "").trim();

  // Fix button:class_name typo where user typed colon instead of dot
  selector = selector.replace(
    /\b(button|a|div|span|input|li|tr|p):([a-zA-Z][a-zA-Z0-9_-]*)\b/g,
    (match, tag, cls) => {
      const validPseudos = ["has", "has-text", "visible", "first-child", "last-child", "nth-child", "not", "disabled", "checked", "focus", "hover", "text", "text-is"];
      if (!validPseudos.includes(cls)) {
        return `${tag}.${cls}`;
      }
      return match;
    }
  );

  // If user just typed a bare class name without dot (e.g. "btn_svc_open" or "btn_save")
  if (/^[a-zA-Z][a-zA-Z0-9_-]+$/.test(selector) && !["button", "input", "textarea", "a", "select"].includes(selector)) {
    selector = `button.${selector}, a.${selector}, .${selector}, #${selector}`;
  }

  // Clean corrupted quotes or excessive backslashes (e.g. \\\\\\\" -> ')
  selector = selector
    .replace(/\\+"/g, "'")
    .replace(/\\+'/g, "'")
    .replace(/'{2,}/g, "'");

  // Fix common typo ui-dialog without dot
  if (selector.startsWith("ui-dialog")) {
    selector = "." + selector;
  }
  selector = selector.replace(/,\s*ui-dialog/g, ", .ui-dialog");

  // Fix invalid jQuery pseudo-classes like :first and :last (convert to Playwright standard)
  selector = selector.replace(/:first(?!\-child|\-of\-type)\b/g, ":first-child").replace(/:last(?!\-child|\-of\-type)\b/g, ":last-child");
  action.selector = selector;

  // Build candidate bases: prioritized by action.iframe, but fallback to page and all visible iframes
  const candidateBases: Array<{ name: string; locator: (sel: string) => Locator }> = [];
  if (action.iframe) {
    candidateBases.push({
      name: `iframe(${action.iframe})`,
      locator: (sel: string) => page.frameLocator(action.iframe!).locator(sel),
    });
    // Fallback to top-level page in case iframe isn't used or already busted
    candidateBases.push({
      name: "page(top-level fallback)",
      locator: (sel: string) => page.locator(sel),
    });
  } else {
    candidateBases.push({
      name: "page(main)",
      locator: (sel: string) => page.locator(sel),
    });
    // Check known common iframes if not found in main page
    const commonFrames = ["iframe#subBody", "iframe#contentFrame", "iframe#mainFrame", "iframe:visible"];
    for (const frameSel of commonFrames) {
      candidateBases.push({
        name: `iframe(${frameSel})`,
        locator: (sel: string) => page.frameLocator(frameSel).locator(sel),
      });
    }
  }

  // 2. Active modal dialog scoping (Handles stacked/nested dialogs by prioritizing topmost/latest modal)
  const dialogLoc = page.locator(".ui-dialog:visible, .modal:visible, .layer_wrap:visible, .equ_select_lyr:visible, [role='dialog']:visible");
  const dialogCount = await dialogLoc.count().catch(() => 0);

  if (dialogCount > 0 && action.selector) {
    const dialogSelectors = action.selector
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    // Check topmost dialogs first (from last/top to first) to prevent targeting covered parent dialog
    for (let d = dialogCount - 1; d >= 0; d--) {
      const topDialog = dialogLoc.nth(d);
      for (const s of dialogSelectors) {
        const isLast = s.endsWith(":last") || s.includes(":last");
        let cleanSel = s.replace(/^\.ui-dialog:visible\s*/, "").replace(/^\.modal:visible\s*/, "").trim();
        cleanSel = cleanSel.replace(/:first\b/g, "").replace(/:last\b/g, "").trim();
        if (!cleanSel) continue;

        try {
          let cand = topDialog.locator(cleanSel);
          cand = isLast ? cand.last() : cand.first();
          if (await cand.isVisible().catch(() => false)) {
            console.log(`  [🎯 최상단 모달 요소 감지] 중첩 팝업 #${d + 1} 내부에서 '${cleanSel}' 요소를 우선 선택합니다.`);
            return cand;
          }
        } catch {
          // Gracefully skip invalid selector syntax
        }
      }
    }

    for (const baseObj of candidateBases) {
      for (const s of dialogSelectors) {
        if (s.includes(".ui-dialog") || s.includes(".modal") || s.includes("layer")) {
          const isLast = s.endsWith(":last") || s.includes(":last");
          let cleanS = s.replace(/:first\b/g, "").replace(/:last\b/g, "").trim();
          if (!cleanS) continue;
          try {
            let directLoc = baseObj.locator(cleanS);
            directLoc = isLast ? directLoc.last() : directLoc.first();
            if (await directLoc.isVisible().catch(() => false)) {
              return directLoc;
            }
          } catch {}
        }
      }
    }
  }

  // 3. Search target selector across candidate bases
  if (action.selector) {
    const parts = action.selector
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    // 3-A. Contextual Description Prioritization (Disambiguate identical buttons across header/sidebar/content)
    const isHeaderIntent = desc.includes("상단") || desc.includes("헤더") || desc.includes("gnb") || desc.includes("전체메뉴");
    const isSidebarIntent = desc.includes("좌측") || desc.includes("사이드바") || desc.includes("메뉴") || desc.includes("snb");
    const isContentIntent = desc.includes("본문") || desc.includes("목록") || desc.includes("콘텐츠");

    if (isHeaderIntent || isSidebarIntent || isContentIntent) {
      const scopePrefixes = isHeaderIntent
        ? ["header", "#header", ".gnb", "#top"]
        : isSidebarIntent
        ? ["#snb", "#left", "aside", ".snb", "nav"]
        : ["#content", ".content", "main"];

      for (const baseObj of candidateBases) {
        for (const rawPart of parts) {
          const cleanPart = rawPart.replace(/:first\b/g, "").replace(/:last\b/g, "").trim();
          if (!cleanPart) continue;
          for (const prefix of scopePrefixes) {
            if (!cleanPart.includes(prefix)) {
              try {
                const scoped = baseObj.locator(`${prefix} ${cleanPart}`).first();
                if (await scoped.isVisible().catch(() => false)) {
                  return scoped;
                }
              } catch {}
            }
          }
        }
      }
    }

    // 3-B. Prioritize elements that are currently visible on screen across bases
    for (const baseObj of candidateBases) {
      for (const rawPart of parts) {
        const isLast = rawPart.endsWith(":last") || rawPart.includes(":last");
        const cleanPart = rawPart.replace(/:first\b/g, "").replace(/:last\b/g, "").trim();
        if (!cleanPart) continue;

        try {
          const loc = baseObj.locator(cleanPart);
          const count = await loc.count().catch(() => 0);
          if (count > 0) {
            if (isLast) {
              const lastCand = loc.last();
              if (await lastCand.isVisible().catch(() => false)) return lastCand;
            }
            for (let i = 0; i < count; i++) {
              const candidate = loc.nth(i);
              if (await candidate.isVisible().catch(() => false)) {
                return candidate;
              }
            }
          }
        } catch {}
      }
    }
  }

  // 3-C. Universal First Item / Detail View Fallback
  const isFirstItemIntent =
    (desc.includes("목록") || desc.includes("항목") || desc.includes("문서") || desc.includes("결과") || desc.includes("데이터")) &&
    (desc.includes("첫") || desc.includes("최상단") || desc.includes("상세") || desc.includes("조회") || desc.includes("상단"));

  if (isFirstItemIntent) {
    const listSelectors = [
      "table tbody tr:first-child td.sub a:visible",
      "table tbody tr:first-child a:visible",
      "ul.lst_vr_ul li:first-child a.sub_tp:visible",
      "ul.lst_vr_ul li:first-child .sub a:visible",
      "ul[id*='List'] li:first-child a.sub_tp:visible",
      "#atclList_list2 li:first-child a.sub_tp:visible",
      "ul.lst_vr_ul li:first-child a:visible",
      "ul[id*='List'] li:first-child a:visible",
      ".lst_type1 li:first-child a:visible",
      ".list_box li:first-child a:visible"
    ];
    for (const baseObj of candidateBases) {
      for (const sel of listSelectors) {
        try {
          const loc = baseObj.locator(sel).first();
          if (await loc.isVisible().catch(() => false)) {
            console.log(`  [🎯 목록 상세 조회 요소 자동 연결] 화면 목록의 첫 번째 유효 항목을 대상(${baseObj.name})으로 연결합니다.`);
            return loc;
          }
        } catch {}
      }
    }
  }


  // 4. Intelligent Self-Healing for Buttons / Interactive Elements
  // If selector is empty or failed to match, extract button/action names from description and try verified patterns
  if (desc) {
    const fallbackSelectors: string[] = [];

    // 1. Extract any text inside brackets or quotes: [문서 등록], [일정 등록], [저장], [확인], [상신], [검색] 등
    const quoteMatch = desc.match(/[\[\'\"\(](.*?)[\]\'\"\)]/);
    if (quoteMatch && quoteMatch[1] && quoteMatch[1].length >= 2) {
      const textKey = quoteMatch[1].trim();
      fallbackSelectors.push(
        `.ui-dialog:visible button:has-text('${textKey}'):visible`,
        `.modal:visible button:has-text('${textKey}'):visible`,
        `button:has-text('${textKey}'):visible`,
        `button:has-text('${textKey.replace(/\s+/g, "")}'):visible`,
        `a:has-text('${textKey}'):visible`,
        `a:has-text('${textKey.replace(/\s+/g, "")}'):visible`,
        `[role='button']:has-text('${textKey}'):visible`,
        `:text-is('${textKey}'):visible`,
        `span.txt:has-text('${textKey}'):visible`,
        `label:has-text('${textKey}'):visible`
      );
    }

    // 2. Universal Action Intent Fallbacks (No module-specific IDs - works across all features!)
    if (desc.includes("저장")) {
      fallbackSelectors.push(
        ".ui-dialog:visible button:has-text('저장'):visible",
        ".modal:visible button:has-text('저장'):visible",
        "button:has-text('저장'):visible",
        "button[title*='저장']:visible",
        "[id*='save']:visible",
        "[class*='save']:visible"
      );
    }

    if (desc.includes("등록") || desc.includes("작성") || desc.includes("신규") || desc.includes("추가")) {
      fallbackSelectors.push(
        "#snb button:has-text('등록'):visible",
        "#snb button:has-text('작성'):visible",
        ".snb button:has-text('등록'):visible",
        "button:has-text('등록'):visible",
        "button:has-text('작성'):visible",
        "a:has-text('등록'):visible",
        "a:has-text('작성'):visible",
        "button:has-text('글작성'):visible"
      );
    }

    if (desc.includes("확인") || desc.includes("선택 완료") || desc.includes("적용")) {
      fallbackSelectors.push(
        ".ui-dialog:visible .ui-dialog-buttonpane button:has-text('확인'):visible",
        ".ui-dialog:visible button:text-is('확인'):visible",
        ".modal:visible button:text-is('확인'):visible",
        "button:text-is('확인'):visible",
        "button:has-text('확인'):visible"
      );
    }

    if (desc.includes("상신") || desc.includes("기안") || desc.includes("결재")) {
      fallbackSelectors.push(
        "button:has-text('상신'):visible",
        "button:has-text('기안'):visible",
        ".btn_toolbar button:has-text('상신'):visible",
        "button:has-text('결재'):visible"
      );
    }

    if (desc.includes("검색") && (desc.includes("버튼") || desc.includes("실행") || desc.includes("클릭"))) {
      fallbackSelectors.push(
        "button[title*='검색']:visible",
        "button:has-text('검색'):visible",
        ".btn_ico:has(.ico_srch):visible",
        "[class*='srch_btn']:visible",
        "[id*='searchBtn']:visible"
      );
    }

    if (desc.includes("닫기") || desc.includes("취소")) {
      fallbackSelectors.push(
        ".ui-dialog:visible button:has-text('닫기'):visible",
        ".ui-dialog:visible button:has-text('취소'):visible",
        "button:has-text('닫기'):visible",
        "button:has-text('취소'):visible"
      );
    }

    for (const baseObj of candidateBases) {
      for (const sel of fallbackSelectors) {
        const cand = baseObj.locator(sel).first();
        if (await cand.isVisible().catch(() => false)) {
          console.log(`  [✨ Self-Heal 지능형 복구] '${action.description}'에 일치하는 화면 요소를 발견했습니다! (${sel} in ${baseObj.name})`);
          return cand;
        }
      }
    }
  }

  // 5. Intelligent Drawer Unfolding (Self-Healing ONLY for Pure Menu Navigation!)
  // 🚨 CRITICAL: Never unfold all-menu drawer for button clicks (register, write, save, submit, confirm)!
  const isInteractionAction =
    desc.includes("버튼") ||
    desc.includes("등록") ||
    desc.includes("작성") ||
    desc.includes("저장") ||
    desc.includes("상신") ||
    desc.includes("확인") ||
    desc.includes("취소") ||
    desc.includes("입력") ||
    desc.includes("타이핑") ||
    desc.includes("선택") ||
    desc.includes("체크") ||
    action.type === "type" ||
    action.selector.includes("button") ||
    action.selector.includes("input") ||
    action.selector.includes("#save") ||
    action.selector.includes("#reg_");

  const isPureMenuNavigation =
    action.type === "click" &&
    !(dialogCount > 0) &&
    !isInteractionAction && // 🚨 인터랙션/버튼 액션 중에는 절대 서랍을 열지 않음!
    (desc.includes("메뉴") || desc.includes("모듈")) &&
    (desc.includes("이동") || desc.includes("진입") || desc.includes("열기"));

  if (isPureMenuNavigation) {
    const btnSvcOpen = page
      .locator("button.btn_svc_open:visible, button[title*='전체메뉴']:visible, .btn_svc_open:visible, [title='포탈 전체메뉴']:visible")
      .first();

    if (await btnSvcOpen.isVisible().catch(() => false)) {
      console.log(`  [✨ 지능형 런타임 구제] 대상 메뉴('${action.description || action.selector}')가 화면에 보이지 않아, 상단 '포탈 전체메뉴(btn_svc_open)' 버튼을 먼저 클릭하여 서랍을 펼칩니다...`);
      await btnSvcOpen.click({ timeout: 2000 }).catch(() => {});
      await page.waitForTimeout(1000);

      // Now re-check visibility of the target selector parts inside the opened drawer
      const parts = (action.selector || "").split(",").map((s) => s.trim()).filter(Boolean);
      for (const part of parts) {
        const reLoc = page.locator(part);
        const count = await reLoc.count().catch(() => 0);
        for (let i = 0; i < count; i++) {
          const candidate = reLoc.nth(i);
          if (await candidate.isVisible().catch(() => false)) {
            console.log(`  [✨ 지능형 런타임 구제 성공] 전체메뉴 서랍 안에서 대상 메뉴를 성공적으로 찾아 연결했습니다!`);
            return candidate;
          }
        }
      }
    }
  }

  // 6. Final fallback: if action.selector exists, return first match, else return null to trigger self-healing
  if (action.selector && action.selector.trim()) {
    return page.locator(action.selector).first();
  }
  return null;
}


/**
 * Waits until an element's bounding box coordinates stabilize (stops moving).
 * Critical for dynamic UI elements (jQuery UI modals, sliding panels, dropdown animations).
 */
async function getSettledBoundingBox(
  el: Locator,
  timeoutMs = 1200
): Promise<{ x: number; y: number; width: number; height: number } | null> {
  const start = Date.now();
  let prevBox: { x: number; y: number; width: number; height: number } | null = null;

  while (Date.now() - start < timeoutMs) {
    const box = await el.boundingBox({ timeout: 400 }).catch(() => null);
    if (!box) {
      await new Promise((r) => setTimeout(r, 60));
      continue;
    }
    if (prevBox) {
      const dx = Math.abs(box.x - prevBox.x);
      const dy = Math.abs(box.y - prevBox.y);
      const dw = Math.abs(box.width - prevBox.width);
      const dh = Math.abs(box.height - prevBox.height);
      if (dx < 1.5 && dy < 1.5 && dw < 1.5 && dh < 1.5) {
        return box;
      }
    }
    prevBox = box;
    await new Promise((r) => setTimeout(r, 80));
  }
  return prevBox || (await el.boundingBox({ timeout: 400 }).catch(() => null));
}

/**
 * Atomic Interactive Leaf Element Finder.
 * Prevents clicking empty white space in huge wrapper containers (div, form, wide labels, table rows).
 * If the element is a container and contains a smaller, actual interactive child, returns that leaf child.
 */
async function resolveAtomicTarget(
  locator: Locator,
  isTypeAction: boolean = false
): Promise<{ locator: Locator; box: { x: number; y: number; width: number; height: number } | null }> {
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  let box = await getSettledBoundingBox(locator, 1000);
  if (!box) {
    return { locator, box: null };
  }

  try {
    const isContainer = await locator.evaluate((node) => {
      const tag = node.tagName.toLowerCase();
      const rect = node.getBoundingClientRect();
      const isLarge = rect.width > 280 || rect.height > 80;
      const isWrapper = ["div", "form", "section", "li", "tr", "td", "p", "ul", "ol", "label"].includes(tag);
      return isLarge || isWrapper;
    });

    if (isContainer) {
      // Find candidate interactive leaf children inside the container
      const candidateQuery = isTypeAction
        ? "textarea:visible, input[type='text']:visible, input:not([type='button']):not([type='submit']):not([type='checkbox']):not([type='radio']):not([type='hidden']):visible, [contenteditable='true']:visible, [contenteditable='']:visible, .note-editable:visible, .ce-paragraph:visible, div[role='textbox']:visible, .editor_body:visible, p:visible"
        : "button:visible, a:visible, input[type='button']:visible, input[type='submit']:visible, [role='button']:visible, input:visible, textarea:visible, select:visible, span.txt:visible, span.name:visible, strong:visible, i.ico:visible";

      const childCandidates = locator.locator(candidateQuery);
      const count = await childCandidates.count().catch(() => 0);
      if (count > 0) {
        for (let i = 0; i < Math.min(count, 3); i++) {
          const candidate = childCandidates.nth(i);
          const childBox = await getSettledBoundingBox(candidate, 400);
          if (childBox && childBox.width > 0 && childBox.height > 0) {
            // Child must be strictly more compact than parent
            if (childBox.width < box.width || childBox.height < box.height) {
              return { locator: candidate, box: childBox };
            }
          }
        }
      }
    }
  } catch {}

  return { locator, box };
}

/**
 * Injects a visual ripple animation into the page at (x, y) right when a click occurs.
 * This guarantees that in the Playwright-recorded video, the viewer sees an exact visual confirmation of the click point.
 */
async function triggerClickVisualizer(page: Page, x: number, y: number): Promise<void> {
  try {
    await page.evaluate(({ cx, cy }) => {
      const ripple = document.createElement("div");
      ripple.className = "__demo_click_visualizer__";
      ripple.style.position = "fixed";
      ripple.style.left = `${cx}px`;
      ripple.style.top = `${cy}px`;
      ripple.style.width = "26px";
      ripple.style.height = "26px";
      ripple.style.marginLeft = "-13px";
      ripple.style.marginTop = "-13px";
      ripple.style.borderRadius = "50%";
      ripple.style.border = "3px solid rgba(59, 130, 246, 0.9)";
      ripple.style.backgroundColor = "rgba(147, 197, 253, 0.35)";
      ripple.style.boxShadow = "0 0 10px rgba(59, 130, 246, 0.6)";
      ripple.style.pointerEvents = "none";
      ripple.style.zIndex = "2147483647";
      ripple.style.transform = "scale(0.5)";
      ripple.style.opacity = "1";
      ripple.style.transition = "transform 0.35s cubic-bezier(0, 0, 0.2, 1), opacity 0.35s ease-out";
      document.body.appendChild(ripple);
      requestAnimationFrame(() => {
        ripple.style.transform = "scale(1.8)";
        ripple.style.opacity = "0";
      });
      setTimeout(() => {
        ripple.remove();
      }, 400);
    }, { cx: x, cy: y });
  } catch {}
}

/**
 * Accurately determines if an element is genuinely disabled in the DOM.
 * Unlike Playwright's locator.isEnabled(), this correctly handles non-form elements (a, div, span) without false positives.
 */
async function isElementDisabled(el: Locator): Promise<boolean> {
  try {
    return await el.evaluate((node) => {
      const elem = node as HTMLElement;
      if (!elem) return false;
      if (elem.hasAttribute("disabled")) return true;
      if (elem.classList.contains("disabled") || elem.classList.contains("fc-state-disabled")) return true;
      if (elem.getAttribute("aria-disabled") === "true") return true;
      const parentBtn = elem.closest("button");
      if (parentBtn && parentBtn.disabled) return true;
      return false;
    });
  } catch {
    return false;
  }
}

/**
 * Automatically pre-checks whether the saved session is genuinely logged in.
 * Tests if the target URL redirects to a login page or displays login input forms.
 */
async function isSessionValid(
  url: string,
  authPath: string,
  viewport: { width: number; height: number }
): Promise<boolean> {
  if (!fs.existsSync(authPath)) return false;

  console.log(`🔍 [세션 사전 검사] 저장된 인증 세션의 유효성을 백그라운드에서 검증합니다...`);
  let checkBrowser;
  try {
    checkBrowser = await chromium.launch({ headless: true });
    const checkContext = await checkBrowser.newContext({
      viewport,
      storageState: authPath,
    });
    const checkPage = await checkContext.newPage();

    await checkPage.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    // Brief sleep to catch client-side URL redirects (e.g. location.href = '/login')
    await checkPage.waitForTimeout(1200);

    const currentUrl = checkPage.url().toLowerCase();

    // 1. URL pattern check for login/auth redirects
    const isLoginUrl =
      currentUrl.includes("/login") ||
      currentUrl.includes("signin") ||
      currentUrl.includes("sso") ||
      currentUrl.includes("/auth");

    // 2. Visible password or user input form check
    const hasPasswordInput = (await checkPage.locator('input[type="password"]:visible').count()) > 0;
    const hasLoginForm = (await checkPage.locator('form#loginForm, .login_box, input#userId:visible').count()) > 0;

    // 3. Positive login indicator (GNB menu, logout button, portal frame)
    const hasGnbOrPortal =
      (await checkPage
        .locator('#svc_lst, .user_info, button:has-text("로그아웃"), a:has-text("로그아웃"), #header, .portal_wrap')
        .count()) > 0;

    await checkBrowser.close();

    if (isLoginUrl || hasPasswordInput || hasLoginForm) {
      console.log(`⚠️ [세션 만료 감지] 로그인 입력창 또는 로그인 페이지(${currentUrl})로 리다이렉트되었습니다.`);
      return false;
    }

    if (hasGnbOrPortal) {
      console.log(`✅ [세션 검증 성공] 로그인 세션이 유효합니다. (사용자 화면 정상 접근 확인)`);
      return true;
    }

    console.log(`ℹ️ [세션 확인] 로그인 폼 미감지: 유효한 세션으로 유지합니다.`);
    return true;
  } catch (err: any) {
    if (checkBrowser) {
      try {
        await checkBrowser.close();
      } catch { }
    }
    console.warn(`⚠️ [세션 검사 경고] 검증 중 타임아웃 또는 접속 오류 발생 (${err.message}). 안전을 위해 로그인 창을 엽니다.`);
    return false;
  }
}

let totalHealedCount = 0;

/**
 * Invokes the AI Runtime Self-Healing Agent to find the real element on the live screen,
 * automatically corrects the action selector, saves it to disk, and returns the healed locator.
 */
async function trySelfHealAction(
  page: Page,
  action: BrowsePlanAction,
  momentId: number,
  plan: BrowsePlan,
  dataDir: string
): Promise<Locator | null> {
  console.log(`\n  [⚠️ 요소 탐색 실패] 액션 #${momentId}: "${action.description}" (기존 셀렉터: ${action.selector || "없음"})`);

  // Check if a blocking modal or alert is obstructing the target element before asking AI
  const recoveredModal = await autoRecoverActiveModals(page, action);
  if (recoveredModal) {
    const unblockedLoc = await getLocator(page, action);
    if (unblockedLoc && (await unblockedLoc.isVisible().catch(() => false))) {
      totalHealedCount++;
      console.log(`  [✨ 팝업 자가 복구 성공] 차단 팝업을 성공적으로 해제하여 요소 '${action.selector}' 탐색을 완료했습니다!`);
      return unblockedLoc;
    }
  }

  console.log(`  [🤖 AI 실시간 자가 치유 가동] 실시간 화면 스크린샷과 DOM 후보군을 정밀 분석 중...`);

  const healResult = await selfHealElement(page, action, momentId, plan.actions.length, dataDir);
  if (healResult && healResult.success && healResult.selector) {
    totalHealedCount++;
    console.log(`  [✨ AI 자가 치유 성공] 셀렉터 자동 교정 완료! (누적 치유: ${totalHealedCount}건)`);
    console.log(`     ➡️ 복구된 셀렉터: ${healResult.selector}`);
    if (healResult.iframe) {
      console.log(`     ➡️ iframe 스코프: ${healResult.iframe}`);
    }
    console.log(`     💡 AI 판단 사유: ${healResult.reason}`);

    action.selector = healResult.selector;
    if (healResult.iframe) {
      action.iframe = healResult.iframe;
    }

    // Persist permanently back to browse-plan.json
    saveHealedPlan(dataDir, plan);

    // Re-resolve locator with healed selector
    const healedLoc = await getLocator(page, action);
    if (healedLoc) {
      const isVis = await healedLoc.isVisible().catch(() => false);
      if (isVis) {
        return healedLoc;
      }
      try {
        await healedLoc.waitFor({ state: "visible", timeout: 4000 });
        return healedLoc;
      } catch {}
    }
  } else if (healResult && !healResult.success) {
    console.warn(`  [AI 자가 치유 포기] 💡 사유: ${healResult.reason}`);
    return null;
  }

  console.warn(`  [AI 자가 치유 미완료] 현재 화면에서 적합한 요소를 확정하지 못했습니다.`);
  return null;
}

/**
 * Universal Tree / Folder / Category Selection Engine:
 * Dynamically resolves folder modals (DocSelect, BrdSelect, CateSelect, OrgTree, etc.)
 * Expands all tree nodes, strictly excludes top-level non-writable root folders,
 * and pinpoints the first writable leaf node (node.data.isFolder === false or nodeType === 'B' or no child list).
 */
async function ensureTreeLeafSelected(page: Page): Promise<{ success: boolean; title?: string }> {
  try {
    const isTreeModal = await page.evaluate(() => {
      const modals = Array.from(document.querySelectorAll(".ui-dialog, .modal, [role='dialog']")).filter((d) => {
        const r = d.getBoundingClientRect();
        const s = window.getComputedStyle(d);
        return r.width > 100 && r.height > 60 && s.display !== "none" && s.visibility !== "hidden";
      });
      const modal = modals[modals.length - 1];
      return Boolean(
        modal?.querySelector(".dynatree-container, .fancytree-container, [id*='treeBox'], [class*='treeBox'], [id*='Tree']") ||
        document.querySelector("#docSelect_treeBox, #docSelect_expandTree, #brdSelect_treeBox")
      );
    });
    if (!isTreeModal) return { success: false };

    console.log(`  [📁 트리/폴더 정밀 분석] 선택 팝업 확인: 트리 확장 및 실제 등록 가능 말단 노드(Leaf Node) 탐색 시작`);

    // 1. Trigger tree expansion via button and Dynatree/Fancytree API
    const expandBtn = page.locator("#docSelect_expandTree, .btn_fopn, button:has-text('모두펼침'), .dynatree-expander").first();
    if (await expandBtn.isVisible().catch(() => false)) {
      await expandBtn.click({ force: true }).catch(() => {});
    }

    await page.evaluate(() => {
      try {
        const win = window as any;
        if (win.DocSelect && win.DocSelect.tree) {
          win.DocSelect.tree.expandTree();
        }
        if (win.$) {
          const treeEls = win.$(".dynatree-container, [id*='treeBox'], [id*='Tree']");
          treeEls.each(function(this: any) {
            try {
              const dynatree = win.$(this).dynatree("getRoot");
              if (dynatree) {
                dynatree.visit((node: any) => {
                  node.data.isChildExpand = true;
                  node.expand(true);
                });
              }
            } catch {}
          });
        }
      } catch {}
    });

    // 2. WAIT for lazy load AJAX to complete and real child board nodes to render (Timeout 4s)
    const childBoardLoc = page.locator(
      ".ui-dialog:visible .dynatree-container .dynatree-node:not(.dynatree-folder) a.dynatree-title:visible, .ui-dialog:visible .dynatree-container li:not(:has(ul)) a.dynatree-title:visible, .ui-dialog:visible .dynatree-container li:last-child a.dynatree-title:visible, [id*='treeBox'] .dynatree-node:not(.dynatree-folder) a.dynatree-title:visible, .dynatree-container a.dynatree-title:visible"
    ).first();

    await childBoardLoc.waitFor({ state: "visible", timeout: 4000 }).catch(() => {});

    // 3. Activate in tree data model directly to guarantee writable leaf node is selected
    const activatedData = await page.evaluate(() => {
      try {
        const win = window as any;
        let targetNode: any = null;
        if (win.$) {
          const treeEls = win.$(".dynatree-container, [id*='treeBox'], [id*='Tree']");
          treeEls.each(function(this: any) {
            try {
              const tree = win.$(this).dynatree("getTree");
              if (tree && !targetNode) {
                tree.getRoot().visit((node: any) => {
                  // Select first real leaf item (not a folder, or nodeType 'B', or has no children)
                  const isFolder = Boolean(node.data.isFolder);
                  const isNodeTypeB = node.data.nodeType === "B";
                  const hasNoChildren = !node.childList || node.childList.length === 0;
                  if (!isFolder || isNodeTypeB || hasNoChildren) {
                    targetNode = node;
                    return false; // break
                  }
                });
              }
            } catch {}
          });
        }
        if (targetNode) {
          targetNode.activate();
          targetNode.focus();
          return { success: true, title: targetNode.data.title, key: targetNode.data.key };
        }
      } catch {}
      return { success: false };
    });

    if (activatedData && activatedData.success) {
      console.log(`  [✨ 실제 등록 가능 리프 노드 활성화] "${activatedData.title}" (key: ${activatedData.key}) 선택 완료`);
    }

    // 4. Also physically click the DOM element so cursor coordinates and visual highlight are recorded
    if (await childBoardLoc.isVisible().catch(() => false)) {
      await childBoardLoc.click({ force: true }).catch(() => {});
      await page.waitForTimeout(500);
      return { success: true, title: activatedData?.title };
    }

    return { success: Boolean(activatedData?.success), title: activatedData?.title };
  } catch (err: any) {
    console.warn(`  [TreeLeaf 헬퍼 예외]: ${err?.message}`);
    return { success: false };
  }
}

/**
 * Universal Tree Modal Confirmation & Graceful Dismissal
 */
async function confirmTreeSelectionModal(page: Page): Promise<boolean> {
  try {
    // 1. Ensure leaf node is selected first
    await ensureTreeLeafSelected(page);

    // 2. Click confirm button
    const confirmBtn = page.locator(
      ".ui-dialog:visible .ui-dialog-buttonpane button:has-text('확인'):visible, .ui-dialog:visible button.btn_pri:has-text('확인'):visible, .ui-dialog:visible button:has-text('확인'):visible, #docSelect_confirm:visible, button._confirm:visible"
    ).first();
    if (await confirmBtn.isVisible().catch(() => false)) {
      console.log(`  [🔘 확인 버튼 클릭] 팝업 확인 버튼 클릭하여 모달 닫기`);
      await confirmBtn.click({ force: true }).catch(() => {});
      await page.waitForTimeout(800);
    }

    // 3. Dismiss any unexpected alert
    const alertBtn = page.locator("#alert_lyr:visible button, .ui-dialog:visible:not(:has(.dynatree-container)) button:has-text('확인')").first();
    if (await alertBtn.isVisible().catch(() => false)) {
      console.log(`  [⚠️ 차단 알림 감지] 알림 닫고 재시도`);
      await alertBtn.click().catch(() => {});
      await page.waitForTimeout(400);
      await page.evaluate(() => {
        try {
          const win = window as any;
          if (win.DocSelect && win.DocSelect.fn) {
            win.DocSelect.fn.confirm();
          }
        } catch {}
      });
    }

    // 4. Wait for modal and overlay to disappear
    await page.locator(".ui-widget-overlay:visible, .ui-dialog:visible:has(.dynatree-container)").waitFor({ state: "hidden", timeout: 4000 }).catch(() => {});
    console.log(`  [✨ 팝업 닫힘 완료] 선택 팝업이 완전히 닫히고 본문 폼으로 전환되었습니다.`);
    return true;
  } catch (err: any) {
    console.warn(`  [confirmTreeSelectionModal 예외]: ${err?.message}`);
    return false;
  }
}

/**
 * Live Modal & Popup Auto-Recovery Sentinel:
 * Detects if an active modal (e.g. folder/tree selection, validation alert, etc.) is blocking
 * the next actions (title, content, save) and autonomously completes or dismisses it.
 */
async function autoRecoverActiveModals(page: Page, action: BrowsePlanAction): Promise<boolean> {
  try {
    const desc = (action.description || "").toLowerCase();
    const sel = (action.selector || "").toLowerCase();

    // 1. Detect Alert/Notice modals ONLY (strictly excludes selection dialogs with dynatree/inputs)
    const isPureAlertModal = await page.evaluate(() => {
      const dialogs = Array.from(document.querySelectorAll(".ui-dialog, .modal, [role='dialog'], #alert_lyr")).filter((d) => {
        const r = d.getBoundingClientRect();
        const s = window.getComputedStyle(d);
        return r.width > 100 && r.height > 60 && s.display !== "none" && s.visibility !== "hidden";
      });
      const top = dialogs[dialogs.length - 1];
      if (!top) return false;
      // If it contains a tree or inputs, it is a selection dialog, NOT an alert!
      if (top.querySelector(".dynatree-container, .fancytree-container, input[type='text'], input.input_txt")) {
        return false;
      }
      const title = (top.querySelector(".ui-dialog-title, .title, h3, h4")?.textContent || "").trim();
      const txt = (top.textContent || "").trim();
      return top.id === "alert_lyr" || title.includes("알림") || title.includes("확인") || txt.includes("등록할 수 없습니다") || txt.includes("선택하세요");
    });

    if (isPureAlertModal) {
      const txt = await page.evaluate(() => {
        const dialogs = Array.from(document.querySelectorAll(".ui-dialog, .modal, [role='dialog']")).filter((d) => window.getComputedStyle(d).display !== "none");
        return dialogs.length > 0 ? (dialogs[dialogs.length - 1].textContent || "").trim() : "";
      });
      console.log(`[DEBUG] Detected modal text: "${txt}"`);
      const isValidationError = txt.includes("입력") || txt.includes("선택") || txt.includes("등록할 수 없습니다") || txt.includes("오류") || txt.includes("필수") || txt.includes("지정");

      const alertOkBtn = page.locator(
        "#alert_lyr:visible button, .ui-dialog:visible:not(:has(.dynatree-container)) button:has-text('확인'), .modal:visible:not(:has(.dynatree-container)) button:has-text('확인')"
      ).first();
      if (await alertOkBtn.isVisible().catch(() => false)) {
        if (isValidationError) {
          console.error(`\n  🚨 [치명적 폼 검증 에러 발생] 시스템 알림: "${txt}"`);
          await alertOkBtn.click().catch(() => {});
          await page.waitForTimeout(600);
          throw new Error(`폼 유효성 검증 실패 (Validation Error): ${txt}`);
        } else {
          console.log(`\n  [🤖 팝업 자가 복구] 차단 알림 팝업 감지 ➔ [확인] 버튼을 클릭하여 알림을 닫습니다.`);
          await alertOkBtn.click().catch(() => {});
          await page.waitForTimeout(600);
        }
      }
    }

    // 2. Check if a folder/board selection modal is currently open and blocking subsequent steps
    const isTreeSelectModal = await page.evaluate(() => {
      const dialogs = Array.from(document.querySelectorAll(".ui-dialog, .modal, [role='dialog']")).filter((d) => {
        const r = d.getBoundingClientRect();
        const s = window.getComputedStyle(d);
        return r.width > 200 && r.height > 150 && s.display !== "none" && s.visibility !== "hidden";
      });
      const top = dialogs[dialogs.length - 1];
      if (!top) return false;
      const txt = top.textContent || "";
      return txt.includes("문서함") || txt.includes("게시판") || txt.includes("폴더") || txt.includes("분류") || txt.includes("캘린더") || Boolean(top.querySelector(".dynatree-container, [id*='treeBox']"));
    });

    const isActionForModal =
      desc.includes("선택 팝업") ||
      desc.includes("팝업 확인") ||
      desc.includes("다이얼로그") ||
      desc.includes("조직도") ||
      desc.includes("주소록") ||
      desc.includes("모달") ||
      desc.includes("팝업") ||
      desc.includes("사원") ||
      desc.includes("결재") ||
      desc.includes("수신자") ||
      desc.includes("추가") ||
      sel.includes(".ui-dialog") ||
      sel.includes("role='dialog'") ||
      sel.includes("org_") ||
      sel.includes("userList");

    // If the action is explicitly interacting with the modal, DO NOT auto-close it!
    if (isTreeSelectModal && isActionForModal) {
      return false;
    }

    const isPostModalAction =
      desc.includes("제목") ||
      desc.includes("본문") ||
      desc.includes("내용") ||
      desc.includes("공개") ||
      desc.includes("저장") ||
      desc.includes("등록") ||
      desc.includes("작성"); // removed "검색" because search happens inside modals too

    if (isTreeSelectModal && (isPostModalAction || !isActionForModal)) {
      console.log(`\n  [🤖 팝업 자가 복구] 화면을 가로막고 있는 선택 팝업을 감지했습니다.`);
      console.log(`     ➡️ 대상 리프 노드를 자동으로 선택하고 [확인]을 클릭하여 본문 등록 폼으로 진입합니다.`);
      await confirmTreeSelectionModal(page);
      return true;
    }
  } catch (err: any) {
    if (err?.message?.includes("Validation Error")) {
      throw err; // Re-throw critical validation errors to halt recording
    }
    console.warn(`  [팝업 자가 복구 알림] 검사 중 무시된 예외: ${err?.message}`);
  }
  return false;
}

/**
 * Dynamic Live Data Scraper (Method 2).
 * Reads real, existing text from the live web page (tables, lists, org trees)
 * so search/lookup actions never fail with "0 results".
 */
async function scrapeLiveText(page: Page, action: BrowsePlanAction): Promise<string | null> {
  const candidateSelectors: string[] = [];

  // 1. Explicit selector if specified
  if (action.dynamicFrom) {
    candidateSelectors.push(action.dynamicFrom);
  }
  if (action.type === "scrape" && action.selector) {
    candidateSelectors.push(action.selector);
  }

  // 2. Strategy or Auto-Detection selectors for enterprise lists & tables
  const strategy = action.dynamicStrategy || "auto";

  if (strategy === "first-row-title" || strategy === "auto") {
    candidateSelectors.push(
      // Standard table subjects/titles (Naonsoft / Enterprise GW)
      ".tbl_lst tbody tr:first-child td.sub a:visible",
      ".tbl_lst tbody tr:first-child td[class*='sub'] a:visible",
      ".tbl_lst tbody tr:first-child td[class*='title'] a:visible",
      ".tbl_lst tbody tr:first-child td[class*='subject'] a:visible",
      ".lst_type1 tbody tr:first-child a:visible",
      "table tbody tr:first-child td:nth-child(2) a:visible",
      "table tbody tr:first-child td:nth-child(3) a:visible",
      "table.tbl_lst tbody tr:first-child a:visible",
      // Vertical Split View / Card Lists (Naonsoft lst_vr, Daou, Hanbiro, etc.)
      "ul.lst_vr_ul li:first-child a.sub_tp:visible",
      "ul.lst_vr_ul li:first-child .sub a:visible",
      "ul.lst_vr_ul li:first-child a._atcl:visible",
      "ul[id*='List'] li:first-child a.sub_tp:visible",
      "ul[id*='List'] li:first-child .sub a:visible",
      "#atclList_list2 li:first-child a.sub_tp:visible",
      "#atclList_list2 li:first-child .sub a:visible",
      ".lst_vr li:first-child a.sub_tp:visible",
      ".lst_vr li:first-child .sub a:visible",
      ".post_lst li:first-child .sub a:visible",
      ".doc_lst li:first-child a.sub_tp:visible",
      ".doc_lst li:first-child .sub a:visible",
      "ul.lst_vr_ul li:first-child a:not(.star_chk):not(.star):visible",
      "ul[id*='List'] li:first-child a:not(.star_chk):not(.star):visible",
      "ul[id*='list'] li:first-child a:not(.star_chk):not(.star):visible",
      "#atclList_list2 li:first-child a:not(.star_chk):not(.star):visible",
      ".lst_vr li:first-child a:not(.star_chk):not(.star):visible",
      ".list_vr_scroll li:first-child a:not(.star_chk):not(.star):visible",
      ".bu_lst li:first-child a:not(.star_chk):not(.star):visible",
      ".lst_type1 li:first-child a:not(.star_chk):not(.star):visible",
      "ul.list_box li:first-child a:not(.star_chk):not(.star):visible",
      ".doc_lst li:first-child a:not(.star_chk):not(.star):visible",
      ".list_box tbody tr:first-child a:not(.star_chk):not(.star):visible",
      "table tbody tr:first-child a:not(.star_chk):not(.star):visible"
    );
  }

  if (strategy === "first-row-user" || strategy === "first-tree-node" || strategy === "auto") {
    const isUserSearch = action.description && (action.description.includes("사원") || action.description.includes("사용자") || action.description.includes("담당자") || action.description.includes("수신자") || action.description.includes("받는 사람") || action.description.includes("조직도") || action.description.includes("검색"));
    
    // Org chart and tree nodes
    if (!isUserSearch) {
      candidateSelectors.push(
        ".dynatree-container:visible li:visible span.dynatree-node:visible .dynatree-title:visible",
        ".tree_box li:visible span.txt:visible"
      );
    }
    candidateSelectors.push(
      ".lst_type1 li:visible .name:visible",
      ".lst_type1 li:visible .user:visible",
      ".lst_type1 li:visible:not(:empty)",
      ".lst_type1 tbody tr:first-child td:nth-child(2):visible",
      "table tbody tr:not(:first-child):visible td:nth-child(2):visible",
      "table tbody tr:not(:first-child):visible td:nth-child(3):visible",
      ".org_tree li:visible a:visible",
      ".user_list li:visible .name:visible",
      ".tbl_lst tbody tr:first-child td[class*='user']:visible",
      ".tbl_lst tbody tr:first-child td[class*='writer']:visible",
      ".info_box .name:visible",
      ".user_card .name:visible",
      ".user_ul li:visible:first-child"
    );
  }

  // Check candidate bases (top-level and visible iframes like #subBody)
  const candidateBases: Array<{ name: string; locator: (sel: string) => Locator }> = [];
  if (action.iframe) {
    candidateBases.push({
      name: `iframe(${action.iframe})`,
      locator: (sel: string) => page.frameLocator(action.iframe!).locator(sel),
    });
  }
  candidateBases.push({
    name: "page",
    locator: (sel: string) => page.locator(sel),
  });
  const commonFrames = ["iframe#subBody", "iframe#contentFrame", "iframe:visible"];
  for (const f of commonFrames) {
    if (f !== action.iframe) {
      candidateBases.push({
        name: `iframe(${f})`,
        locator: (sel: string) => page.frameLocator(f).locator(sel),
      });
    }
  }

  for (const base of candidateBases) {
    for (const sel of candidateSelectors) {
      try {
        const loc = base.locator(sel).first();
        const count = await loc.count().catch(() => 0);
        if (count > 0 && (await loc.isVisible().catch(() => false))) {
          const raw = (await loc.innerText().catch(() => loc.textContent().catch(() => ""))) || "";
          let text = raw.trim();
          if (text) {
            // Exclude bookmark stars or button noise
            if (text === "별표하기" || text === "중요" || text === "선택" || text === "보기") {
              continue;
            }

            // Clean up noise (badges, count brackets like [1], (3), [공지], etc.)
            text = text
              .replace(/\[[^\]]+\]/g, "") // remove [공지], [중요]
              .replace(/\([0-9]+\)/g, "") // remove reply counts (3)
              .replace(/\s+/g, " ")
              .trim();

            if (text.length >= 2) {
              // Extract clean search term (e.g. max 22 chars if very long title)
              const keyword = text.length > 25 ? text.slice(0, 20).trim() : text;
              console.log(`  [📋 실시간 DB 데이터 스크래핑 성공] 화면에서 실제 텍스트("${keyword}")를 추출했습니다! (${sel} in ${base.name})`);
              return keyword;
            }
          }
        }
      } catch {}
    }
  }

  const isUserSearch = action.description && (action.description.includes("사원") || action.description.includes("사용자") || action.description.includes("담당자") || action.description.includes("수신자") || action.description.includes("받는 사람") || action.description.includes("조직도") || action.description.includes("검색"));

  if (isUserSearch) {
    try {
      const folderLocators = [
        page.locator(".dynatree-container:visible li li a.dynatree-title").first(), // sub-folder first
        page.locator(".dynatree-container:visible li:nth-child(2) a.dynatree-title").first(), // second root folder
        page.locator(".dynatree-container:visible li:first-child a.dynatree-title").first() // root folder
      ];
      
      let clicked = false;
      for (const folderBtn of folderLocators) {
        if (await folderBtn.isVisible().catch(() => false)) {
          console.log(`  [💡 빈 사원 목록 감지] 스크래핑을 위해 좌측 트리 폴더를 자율적으로 선클릭하여 목록을 활성화합니다...`);
          await folderBtn.click().catch(() => {});
          await page.waitForTimeout(1000);
          clicked = true;
          
          // Retry scraping after the list is populated
          for (const base of candidateBases) {
            for (const sel of candidateSelectors) {
              try {
                const loc = base.locator(sel).first();
                const count = await loc.count().catch(() => 0);
                if (count > 0 && (await loc.isVisible().catch(() => false))) {
                  const raw = (await loc.innerText().catch(() => loc.textContent().catch(() => ""))) || "";
                  let text = raw.trim();
                  if (text && text !== "별표하기" && text !== "중요" && text !== "선택" && text !== "보기") {
                    text = text.replace(/\[[^\]]+\]/g, "").replace(/\([0-9]+\)/g, "").replace(/\s+/g, " ").trim();
                    if (text.length >= 2) {
                      const keyword = text.length > 25 ? text.slice(0, 20).trim() : text;
                      console.log(`  [✨ 자율 활성화 스크래핑 성공] 폴더 클릭 후 렌더링된 사원 목록에서 "${keyword}" 추출 성공!`);
                      return keyword;
                    }
                  }
                }
              } catch {}
            }
          }
        }
        if (clicked) break; // Try next locator only if we didn't click anything
      }
    } catch {}
  }

  return null;
}

async function main() {
  const slug = process.argv[2];
  if (!slug) {
    console.error("Usage: tsx scripts/record.ts <slug> [--login]");
    process.exit(1);
  }

  const dataDir = path.resolve(__dirname, "..", "data", slug);
  const planPath = path.join(dataDir, "browse-plan.json");

  if (!fs.existsSync(planPath)) {
    console.error(`Browse plan not found: ${planPath}`);
    process.exit(1);
  }

  const rawPlan: BrowsePlan = JSON.parse(fs.readFileSync(planPath, "utf-8"));
  const { plan, report } = sanitizeBrowsePlan(rawPlan);
  if (report.fixedActionsCount > 0 || report.removedActionsCount > 0) {
    console.log(`🛡️ [지능형 플랜 자동 보정] ${report.fixedActionsCount}개 액션 보정, ${report.removedActionsCount}개 위험 액션 제거`);
    for (const change of report.changes) {
      console.log(`   ${change}`);
    }
  }
  const videoDir = dataDir;

  const authPath = path.join(dataDir, "auth.json");
  const forceLogin = process.argv.includes("--login");
  const requiresLogin = plan.requiresLogin || forceLogin;

  const isHeadless = process.argv.includes("--headless");
  const isHeaded = !isHeadless;

  // Auto-reuse existing auth session if available and not forced
  if (!fs.existsSync(authPath) && !forceLogin) {
    const parentDataDir = path.resolve(__dirname, "..", "data");
    const candidateDirs = [
      "approval-draft",
      "menu-guide-and-notification",
      "messenger-chat-start",
      "ai-chat-and-search",
    ];
    for (const cand of candidateDirs) {
      const candAuth = path.join(parentDataDir, cand, "auth.json");
      if (fs.existsSync(candAuth)) {
        console.log(`🔑 기존 인증 세션 (${cand}/auth.json)을 '${slug}' 시나리오로 복사하여 테스트합니다.`);
        try {
          fs.copyFileSync(candAuth, authPath);
        } catch { }
        break;
      }
    }
  }

  // 1. Automatic Pre-flight Session Check
  let isSessionActive = false;
  if (!forceLogin && fs.existsSync(authPath)) {
    isSessionActive = await isSessionValid(plan.url, authPath, plan.viewport);
  }

  const needsLogin = forceLogin || !isSessionActive;

  if (isSessionActive && !forceLogin) {
    console.log("\n=======================================================");
    console.log("🔑 [세션 확인] 기존 로그인 세션이 유효합니다!");
    console.log("👉 별도의 로그인 대기창 없이 메인 녹화 브라우저로 즉시 진입합니다.");
    console.log("👉 (만약 로그인을 새로 하고 싶으시다면 대시보드에서 '로그인 세션 다시하기' 옵션을 켜주세요)");
    console.log("=======================================================\n");
  }

  // 2. Open Login Browser Window if unauthenticated
  if (requiresLogin && needsLogin) {
    console.log("\n=======================================================");
    console.log("👉 [자동 감지] 로그인이 되어 있지 않거나 세션이 만료되었습니다!");
    console.log("👉 브라우저 로그인 창이 자동으로 열립니다. 로그인을 완료해 주세요.");
    console.log("👉 메인 화면 진입 후 [Enter] 키 (또는 대시보드의 '로그인 완료' 버튼)를 눌러주세요.");
    console.log("=======================================================\n");

    let loginBrowser;
    try {
      // 1. Try launching system installed Google Chrome (best visibility and interactive UI on Windows)
      loginBrowser = await chromium.launch({
        headless: false,
        channel: "chrome",
        args: [
          "--start-maximized",
          "--new-window",
          "--window-position=50,50",
          "--disable-blink-features=AutomationControlled",
        ],
      });
      console.log("🌐 시스템 구글 크롬(Chrome)으로 로그인 창을 띄웠습니다.");
    } catch {
      // 2. Fallback to bundled Chromium
      loginBrowser = await chromium.launch({
        headless: false,
        args: [
          "--start-maximized",
          "--new-window",
          "--window-position=50,50",
        ],
      });
      console.log("🌐 Playwright Chromium으로 로그인 창을 띄웠습니다.");
    }

    const loginContext = await loginBrowser.newContext({
      viewport: null, // Open as a real maximized window rather than a restricted viewport box
    });
    const loginPage = await loginContext.newPage();
    await loginPage.goto(plan.url);
    await loginPage.bringToFront();

    console.log("👉 (안내: 화면에 창이 가려져 있다면 작업 표시줄의 'Chrome' 또는 'Chromium' 아이콘을 클릭하여 앞으로 가져와 주세요.)\n");

    await waitForEnter();

    await loginContext.storageState({ path: authPath });
    await loginContext.close();
    await loginBrowser.close();
    console.log(`\n🎉 로그인 세션 저장 완료: ${authPath}`);

    // Sync fresh session to other common scenarios
    const parentDataDir = path.resolve(__dirname, "..", "data");
    const candidateDirs = [
      "approval-draft",
      "menu-guide-and-notification",
      "messenger-chat-start",
      "ai-chat-and-search",
    ];
    for (const cand of candidateDirs) {
      const candDir = path.join(parentDataDir, cand);
      if (fs.existsSync(candDir) && cand !== slug) {
        try {
          fs.copyFileSync(authPath, path.join(candDir, "auth.json"));
        } catch { }
      }
    }
  }

  // Clean up any stale webm temporary files from previous runs
  try {
    const files = fs.readdirSync(videoDir);
    for (const file of files) {
      if (file.startsWith("page@") && file.endsWith(".webm")) {
        try { fs.unlinkSync(path.join(videoDir, file)); } catch { }
      }
    }
  } catch { }

  // 2. Main Recording Context
  let browser: Browser;
  if (isHeaded) {
    console.log("👁️ [--headed 모드] 브라우저 화면을 직접 표시하며 녹화합니다.");
    try {
      // 1. Try launching system installed Google Chrome (best foreground visibility and taskbar focus on Windows)
      browser = await chromium.launch({
        headless: false,
        channel: "chrome",
        args: [
          "--start-maximized",
          "--new-window",
          "--window-position=50,50",
          "--disable-blink-features=AutomationControlled",
        ],
      });
      console.log("🌐 시스템 구글 크롬(Chrome)으로 녹화 화면 창을 띄웠습니다.");
    } catch {
      // 2. Fallback to bundled Chromium
      browser = await chromium.launch({
        headless: false,
        args: [
          "--start-maximized",
          "--new-window",
          "--window-position=50,50",
        ],
      });
      console.log("🌐 Playwright Chromium으로 녹화 화면 창을 띄웠습니다.");
    }
  } else {
    browser = await chromium.launch({
      headless: true,
      args: ["--window-size=1920,1080"],
    });
  }
  const contextOptions: Parameters<typeof browser.newContext>[0] = {
    viewport: plan.viewport,
    recordVideo: {
      dir: videoDir,
      size: plan.viewport,
    },
  };

  if (fs.existsSync(authPath)) {
    contextOptions.storageState = authPath;
    console.log(`저장된 로그인 세션을 불러옵니다: ${authPath}`);
  }

  const context: BrowserContext = await browser.newContext(contextOptions);

  // --- 🪟 Layer 1: Universal Same-Page Redirection for Popups (window.open & target="_blank") ---
  // Keeps the screen recording seamless on a single 1920x1080 canvas without multi-window splits
  await context.addInitScript(() => {
    try {
      window.opener = window.opener || window;
      const origClose = window.close;
      window.close = function () {
        console.log("[Studio Popup] window.close() 호출 감지 -> 이전 페이지로 자동 뒤로가기");
        if (window.history.length > 1) {
          window.history.back();
        } else {
          try { origClose.call(window); } catch (e) { }
        }
      };
    } catch { }

    try {
      const origOpen = window.open;
      window.open = function (url, target, features) {
        console.log(`[Studio Popup] window.open("${url}") 호출 감지 -> 단일 화면 녹화를 위해 동일 창으로 부드럽게 전환`);
        if (url && typeof url === "string" && url !== "about:blank") {
          window.location.href = url;
          return window;
        }
        return origOpen ? origOpen.apply(window, arguments as any) : window;
      };
    } catch { }

    try {
      document.addEventListener(
        "click",
        (e) => {
          const target = (e.target as HTMLElement)?.closest("a");
          if (target && target.getAttribute("target") === "_blank") {
            target.setAttribute("target", "_self");
          }
        },
        true
      );
    } catch { }
  });

  let page: Page = await context.newPage();
  const pageStack: Page[] = [page];

  // Helper to setup dialog handling on any page
  function attachDialogHandler(targetPage: Page) {
    targetPage.on("dialog", async (dialog) => {
      const msg = dialog.message();
      const type = dialog.type();
      console.log(`  [Alert/Confirm] ${type}: "${msg}"`);

      const isValidationAlert =
        msg.includes("입력") ||
        msg.includes("선택") ||
        msg.includes("지정") ||
        msg.includes("필수") ||
        msg.includes("등록할 수 없습니다");

      if (isValidationAlert && type === "alert") {
        console.warn(`  ⚠️ [폼 유효성 검사 경고] 시스템 필수 조건 미충족 알림 감지: "${msg}"`);
        console.warn(`     💡 팁: 시나리오에 해당 필수 조건(문서함/분류 선택, 제목 입력, 결재선 지정 등)이 모두 포함되었는지 확인하세요.`);
      }

      await dialog.accept().catch(() => {});
    });
  }

  attachDialogHandler(page);

  // --- 🪟 Layer 2: Real Multi-Window / Popup Active Page Tracker ---
  // In case a popup does open as a new Page in the context, seamlessly switch 'page' to it!
  context.on("page", async (newPage) => {
    console.log(`\n  [🪟 새 브라우저 창(Popup) 감지] 새 팝업 창이 열렸습니다: ${newPage.url() || "about:blank"}`);
    await newPage.setViewportSize(plan.viewport).catch(() => {});
    attachDialogHandler(newPage);
    pageStack.push(newPage);
    page = newPage;

    newPage.on("close", () => {
      console.log(`  [🪟 팝업 창 닫힘] 팝업이 닫혀 이전 활성 브라우저 창으로 자동 복귀합니다.`);
      const idx = pageStack.indexOf(newPage);
      if (idx !== -1) pageStack.splice(idx, 1);
      page = pageStack[pageStack.length - 1] || context.pages()[0];
      if (page) {
        page.bringToFront().catch(() => {});
      }
    });

    if (isHeaded) {
      await newPage.bringToFront().catch(() => {});
      bringWindowToForeground();
    }
  });

  const recordingStart = Date.now();
  if (isHeaded) {
    await page.bringToFront().catch(() => { });
    bringWindowToForeground();
  }
  console.log(`페이지 이동 중: ${plan.url}`);
  await page.goto(plan.url, { waitUntil: "domcontentloaded", timeout: 30000 });
  if (isHeaded) {
    bringWindowToForeground();
  }

  const moments: Moment[] = [];
  let momentId = 0;
  const runtimeVariables = new Map<string, string>();

  console.log(`\nRecording started for "${slug}" at ${plan.url}`);

  try {
    for (const action of plan.actions) {
      momentId++;

      const moment: Moment = {
        id: momentId,
        type: action.type,
        timestamp: 0,
        description: action.description,
      };

      switch (action.type) {
        case "navigate": {
          const targetUrl = action.url ?? plan.url;
          moment.url = targetUrl;
          moment.timestamp = Date.now() - recordingStart;
          await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
          break;
        }

        case "wait": {
          moment.timestamp = Date.now() - recordingStart;
          const ms = action.ms ?? 1000;
          // 모달 애니메이션 대기 후 즉시 복구, 남은 시간 대기
          await page.waitForTimeout(Math.min(500, ms));
          await autoRecoverActiveModals(page, action);
          if (ms > 500) {
            await page.waitForTimeout(ms - 500);
          }
          break;
        }

        case "scrape": {
          moment.timestamp = Date.now() - recordingStart;
          const varName = action.scrapeAs || "lastScraped";
          const scraped = await scrapeLiveText(page, action);
          if (scraped) {
            runtimeVariables.set(varName, scraped);
            console.log(`  [💾 변수 저장] runtimeVariables['${varName}'] = "${scraped}"`);
          } else {
            console.warn(`  [⚠️ 스크래핑 실패] 화면에서 실제 텍스트를 추출하지 못했습니다.`);
          }
          await page.waitForTimeout(action.ms ?? 500);
          break;
        }

        case "hover": {
          await autoRecoverActiveModals(page, action);
          let el = await getLocator(page, action);
          if (!el) {
            el = await trySelfHealAction(page, action, momentId, plan, dataDir);
          }
          if (!el) {
            if (action.force === false) {
              console.log(`  [선택적 액션 스킵] 요소를 찾을 수 없어 스킵합니다: ${action.description}`);
              break;
            }
            throw new Error(`요소를 찾을 수 없습니다: ${action.selector}`);
          }
          try {
            await el.waitFor({ state: "visible", timeout: 25000 });
          } catch (waitErr) {
            const healed = await trySelfHealAction(page, action, momentId, plan, dataDir);
            if (healed) {
              el = healed;
            }
          }
          
          const { locator: targetEl, box } = await resolveAtomicTarget(el);
          el = targetEl;

          if (box) {
            const rawX = box.x + box.width / 2 + (action.cursorOffset?.x || 0);
            const rawY = box.y + box.height / 2 + (action.cursorOffset?.y || 0);
            const clamped = clampToViewport(
              rawX,
              rawY,
              plan.viewport.width,
              plan.viewport.height
            );
            moment.cursor = {
              x: Math.round(clamped.x),
              y: Math.round(clamped.y),
            };
            moment.target = {
              x: Math.round(Math.max(0, box.x)),
              y: Math.round(Math.max(0, box.y)),
              width: Math.round(box.width),
              height: Math.round(box.height),
            };
          }
          moment.timestamp = Date.now() - recordingStart;
          await el.hover().catch(() => { });
          await page.waitForTimeout(500);
          break;
        }

        case "dblclick": {
          await autoRecoverActiveModals(page, action);
          let el = await getLocator(page, action);
          if (!el) {
            el = await trySelfHealAction(page, action, momentId, plan, dataDir);
          }
          if (!el) {
            if (action.force === false) {
              console.log(`  [선택적 액션 스킵] 요소를 찾을 수 없어 스킵합니다: ${action.description}`);
              break;
            }
            throw new Error(`요소를 찾을 수 없습니다: ${action.selector}`);
          }
          try {
            await el.waitFor({ state: "visible", timeout: 25000 });
          } catch (waitErr) {
            const healed = await trySelfHealAction(page, action, momentId, plan, dataDir);
            if (healed) {
              el = healed;
            }
          }
          
          const { locator: targetEl, box } = await resolveAtomicTarget(el);
          el = targetEl;

          if (box) {
            const rawX = box.x + box.width / 2 + (action.cursorOffset?.x || 0);
            const rawY = box.y + box.height / 2 + (action.cursorOffset?.y || 0);
            const clamped = clampToViewport(
              rawX,
              rawY,
              plan.viewport.width,
              plan.viewport.height
            );
            moment.cursor = {
              x: Math.round(clamped.x),
              y: Math.round(clamped.y),
            };
            moment.target = {
              x: Math.round(Math.max(0, box.x)),
              y: Math.round(Math.max(0, box.y)),
              width: Math.round(box.width),
              height: Math.round(box.height),
            };
          }
          moment.timestamp = Date.now() - recordingStart;

          // 시각적 마커 비동기 렌더링
          if (moment.cursor) {
            triggerClickVisualizer(page, moment.cursor.x, moment.cursor.y).catch(() => {});
          }

          await el.dblclick({ timeout: 10000, force: action.force ?? false });
          await page.waitForTimeout(1000);
          break;
        }

        case "click": {
          await autoRecoverActiveModals(page, action);
          let el = await getLocator(page, action);

          // Method 2: Dynamic matching if clicking a searched item or using a scraped variable
          const isSearchExecutionButton =
            (action.description && (action.description.includes("검색 버튼") || action.description.includes("검색 실행") || action.description.includes("검색 아이콘"))) ||
            (action.selector && (action.selector.includes("searchBtn") || action.selector.includes("btn_search") || action.selector.includes("search_btn")));

          const isClickSearchResult = !isSearchExecutionButton && (
            Boolean(action.useScraped) ||
            Boolean(
              action.description &&
              (action.description.includes("검색된") || action.description.includes("검색 결과") || (action.description.includes("결과") && action.description.includes("항목"))) &&
              (action.description.includes("선택") || action.description.includes("클릭") || action.description.includes("상세") || action.description.includes("조회"))
            )
          );

          if (isClickSearchResult) {
            const targetText = action.useScraped && action.useScraped !== "auto"
              ? runtimeVariables.get(action.useScraped)
              : runtimeVariables.get("lastSearchKeyword");

            if (targetText) {
              const cleanKeyword = targetText.length > 15 ? targetText.slice(0, 15).trim() : targetText;
              const matchedLoc = page.locator(
                `ul.lst_vr_ul li a.sub_tp:has-text('${cleanKeyword}'):visible, ul.lst_vr_ul li .sub a:has-text('${cleanKeyword}'):visible, #atclList_list2 a:has-text('${cleanKeyword}'):visible, ul[id*='List'] li a:has-text('${cleanKeyword}'):visible, table tbody tr td.sub a:has-text('${cleanKeyword}'):visible, table tbody tr a:has-text('${cleanKeyword}'):visible, .lst_vr a:has-text('${cleanKeyword}'):visible, a.sub_tp:has-text('${cleanKeyword}'):visible, a[title*='${cleanKeyword}']:visible, a._atcl:has-text('${cleanKeyword}'):visible, a:has-text('${cleanKeyword}'):visible`
              ).first();
              if (await matchedLoc.isVisible().catch(() => false)) {
                console.log(`  [🎯 검색 결과 실시간 매칭] 실제 검색어("${cleanKeyword}")와 일치하는 문서 링크를 클릭 대상으로 자동 연결합니다.`);
                el = matchedLoc;
              }
            }
          }

          // Universal First Item / Detail View Click Fallback (Table & Vertical Split View) (Moved to getLocator)

          // 🌟 Universal Tree & Folder Node Selection Auto-Refinement
          const descLower = (action.description || "").toLowerCase();
          const selLower = (action.selector || "").toLowerCase();
          const isTreeSelectAction =
            (descLower.includes("선택") && (descLower.includes("트리") || descLower.includes("노드") || descLower.includes("문서함") || descLower.includes("게시판") || descLower.includes("폴더") || descLower.includes("분류") || descLower.includes("캘린더"))) ||
            selLower.includes("dynatree") ||
            selLower.includes("fancytree") ||
            selLower.includes("treebox") ||
            selLower.includes("docselect") ||
            selLower.includes("brdselect");

          const isTreeSelectConfirm =
            (descLower.includes("확인") || descLower.includes("선택 완료") || descLower.includes("적용")) &&
            (descLower.includes("팝업") || descLower.includes("모달") || descLower.includes("다이얼로그") || descLower.includes("문서함") || descLower.includes("게시판") || selLower.includes(".ui-dialog"));

          const hasActiveTreeDialog = (await page.locator(".ui-dialog:visible .dynatree-container, [role='dialog']:visible .dynatree-container, [id*='treeBox']:visible").count().catch(() => 0)) > 0;

          // 1. If this is a modal confirmation step but the modal is ALREADY CLOSED, pass safely without crashing!
          if (isTreeSelectConfirm && !hasActiveTreeDialog) {
            console.log(`  [✨ 모달 확인 불필요] 선택 팝업이 이미 정상 종료되어 확인 클릭 단계를 안전하게 통과합니다.`);
            moment.timestamp = Date.now() - recordingStart;
            await page.waitForTimeout(400);
            break;
          }

          if (hasActiveTreeDialog) {
            if (isTreeSelectAction) {
              await ensureTreeLeafSelected(page);
              const leafLoc = page.locator(
                ".ui-dialog:visible .dynatree-container .dynatree-node:not(.dynatree-folder) a.dynatree-title:visible, .ui-dialog:visible .dynatree-container li:not(:has(ul)) a.dynatree-title:visible, .ui-dialog:visible .dynatree-container li:last-child a.dynatree-title:visible, [id*='treeBox'] .dynatree-node:not(.dynatree-folder) a.dynatree-title:visible, .dynatree-container a.dynatree-title:visible"
              ).first();
              if (await leafLoc.isVisible().catch(() => false)) {
                el = leafLoc;
              }
            }

            if (isTreeSelectConfirm) {
              // Target the visible confirm button directly so mouse cursor travels to it in the video
              const confirmBtn = page.locator(
                ".ui-dialog:visible .ui-dialog-buttonpane button:has-text('확인'):visible, .ui-dialog:visible button.btn_pri:has-text('확인'):visible, .ui-dialog:visible button:has-text('확인'):visible, #docSelect_confirm:visible"
              ).first();
              if (await confirmBtn.isVisible().catch(() => false)) {
                el = confirmBtn;
              } else {
                // If button not directly visible in DOM, safely invoke helper and exit step
                const dismissed = await confirmTreeSelectionModal(page);
                if (dismissed) {
                  moment.timestamp = Date.now() - recordingStart;
                  await page.waitForTimeout(400);
                  break;
                }
              }
            }
          }

          if (!el) {
            el = await trySelfHealAction(page, action, momentId, plan, dataDir);
          }
          if (!el) {
            if (action.force === false) {
              console.log(`  [선택적 액션 스킵] 요소를 찾을 수 없어 스킵합니다: ${action.description}`);
              break;
            }
            throw new Error(`요소를 찾을 수 없습니다: ${action.selector}`);
          }

          // 1. Wait for element to become visible on the screen
          const waitTimeout = 25000;
          try {
            await el.waitFor({ state: action.force ? "attached" : "visible", timeout: waitTimeout });
          } catch (waitErr) {
            // Check if element is an input (e.g. checkbox/radio) whose parent or associated label is visible
            let resolvedViaLabel = false;
            try {
              const tagName = await el.evaluate((e) => e.tagName.toLowerCase()).catch(() => "");
              if (tagName === "input") {
                const parentLabel = el.locator("xpath=ancestor::label[1]");
                if (await parentLabel.isVisible().catch(() => false)) {
                  el = parentLabel;
                  resolvedViaLabel = true;
                } else {
                  const inputId = await el.getAttribute("id").catch(() => "");
                  if (inputId) {
                    const forLabel = page.locator(`label[for='${inputId}']:visible`).first();
                    if (await forLabel.isVisible().catch(() => false)) {
                      el = forLabel;
                      resolvedViaLabel = true;
                    }
                  }
                }
              }
            } catch {}

            if (!resolvedViaLabel) {
              // Intelligent Runtime Semantic Fallback based on action.description
              const desc = action.description || "";
              let fallbackLoc: Locator | null = null;

              if (desc.includes("예약사용") || desc.includes("자원예약 사용") || desc.includes("자원예약")) {
                fallbackLoc = page.locator("label:has-text('예약사용'), text='예약사용', input#scd_link_res_chk").first();
              } else if ((desc.includes("자원") || desc.includes("예약")) && (desc.includes("열기") || desc.includes("추가") || desc.includes("+") || desc.includes("모달") || desc.includes("버튼"))) {
                fallbackLoc = page.locator("button#scd_link_res_select_button, #scd_link_res_select button, button:has(.ico_plus), button[title*='추가']").first();
              } else if (desc.includes("시설") || desc.includes("회의실")) {
                if (desc.includes("탭") || desc.includes("카테고리")) {
                  fallbackLoc = page.locator(".ui-dialog:visible a:has-text('시설'), a:has-text('시설'):visible").first();
                } else {
                  fallbackLoc = page.locator(":text('3층 회의실'), .ui-dialog:visible div[class*='lst'] > *:first-child, .ui-dialog:visible li:first-child").first();
                }
              } else if (desc.includes("확인")) {
                fallbackLoc = page.locator(".ui-dialog:visible button:has-text('확인'), button:has-text('확인'):visible").first();
              } else if (desc.includes("저장")) {
                fallbackLoc = page.locator("#reg_schedule_form #savebtn, .ui-dialog:visible button:has-text('저장'), button:has-text('저장'):visible").first();
              }

              if (fallbackLoc && (await fallbackLoc.count().catch(() => 0)) > 0) {
                console.log(`  [✨ 지능형 런타임 복구] '${action.description}'에 맞는 실제 화면 요소를 감지하여 자동 복구했습니다.`);
                el = fallbackLoc;
                resolvedViaLabel = true;
              }
            }

            // 🚨 Trigger AI Runtime Self-Healing if still not found!
            if (!resolvedViaLabel) {
              const healed = await trySelfHealAction(page, action, momentId, plan, dataDir);
              if (healed) {
                el = healed;
                resolvedViaLabel = true;
              }
            }

            if (!resolvedViaLabel) {
              if (action.force === false) {
                console.log(`  [선택적 액션 스킵] 요소가 화면에 표시되지 않아 스킵합니다: ${action.description}`);
                break;
              }
              throw new Error(`요소가 화면에 표시되지 않습니다 (${waitTimeout}ms 초과): ${action.selector}`);
            }
          }

          await el.scrollIntoViewIfNeeded().catch(() => { });
          const { locator: targetEl, box } = await resolveAtomicTarget(el);
          el = targetEl;

          if (box) {
            const rawX = box.x + box.width / 2 + (action.cursorOffset?.x || 0);
            const rawY = box.y + box.height / 2 + (action.cursorOffset?.y || 0);
            const clamped = clampToViewport(
              rawX,
              rawY,
              plan.viewport.width,
              plan.viewport.height
            );
            moment.cursor = {
              x: Math.round(clamped.x),
              y: Math.round(clamped.y),
            };
            moment.target = {
              x: Math.round(Math.max(0, box.x)),
              y: Math.round(Math.max(0, box.y)),
              width: Math.round(box.width),
              height: Math.round(box.height),
            };
          }

          // 1. DOM 상태(disabled) 미리 평가하여 불필요한 딜레이 방지
          const isDisabled = await isElementDisabled(el);

          // 2. 정확한 타임스탬프 기록 (클릭 직전)
          moment.timestamp = Date.now() - recordingStart;

          // 3. 시각적 클릭 마커를 렌더링하도록 백그라운드로 던짐 (await 제거로 딜레이 원천 차단)
          if (moment.cursor) {
            triggerClickVisualizer(page, moment.cursor.x, moment.cursor.y).catch(() => {});
          }

          // 4. 즉시 실제 클릭 실행 (마커와 동시에 브라우저에서 실행됨)
          try {
            if (isDisabled) {
              await el.click({ timeout: 4000, force: true }).catch(() => { });
            } else {
              await el.click({ timeout: 10000, force: action.force ?? false });
            }
          } catch (clickErr: any) {
            // Non-optional fallback: try DOM dispatchEvent("click")
            try {
              await el.click({ timeout: 3000, force: true });
            } catch {
              try {
                await el.dispatchEvent("click");
              } catch {
                // Trigger AI Self-Healing if click itself completely fails!
                const healed = await trySelfHealAction(page, action, momentId, plan, dataDir);
                if (healed) {
                  el = healed;
                  await healed.click({ timeout: 4000, force: true }).catch(() => healed.dispatchEvent("click"));
                } else {
                  throw clickErr;
                }
              }
            }
          }

          // If this was modal confirmation, verify that alert was dismissed and dialog actually closed
          if (hasActiveTreeDialog && isTreeSelectConfirm) {
            await page.waitForTimeout(400);
            const alertBtn = page.locator("#alert_lyr:visible button, .ui-dialog:visible:not(:has(.dynatree-container)) button:has-text('확인')").first();
            if (await alertBtn.isVisible().catch(() => false)) {
              console.log(`  [🤖 알림 팝업 자동 해제] 알림 팝업을 닫고 말단 리프 노드 재선택 후 확인 재시도`);
              await alertBtn.click().catch(() => {});
              await page.waitForTimeout(400);
              const topDlg = page.locator(".ui-dialog:visible, [role='dialog']:visible").last();
              const leafLoc = topDlg.locator(
                ".dynatree-container .dynatree-node:not(.dynatree-folder) a.dynatree-title:visible, .dynatree-container li:not(:has(ul)) a.dynatree-title:visible, .dynatree-container li:last-child a.dynatree-title:visible, .dynatree-container a.dynatree-title:visible"
              ).first();
              if (await leafLoc.isVisible().catch(() => false)) {
                await leafLoc.click({ force: true }).catch(() => {});
                await page.waitForTimeout(500);
              }
              const confirmBtn = topDlg.locator(".ui-dialog-buttonpane button:has-text('확인'), button:has-text('확인'):visible").first();
              if (await confirmBtn.isVisible().catch(() => false)) {
                await confirmBtn.click({ force: true }).catch(() => {});
              }
            }
            await page.locator(".ui-widget-overlay:visible, .ui-dialog:visible:has(.dynatree-container)").waitFor({ state: "hidden", timeout: 3500 }).catch(() => {});
            console.log(`  [✨ 팝업 닫힘 완료] 선택 팝업이 정상 해제되어 본문 작성 폼으로 진입했습니다.`);
          }

          await page.waitForTimeout(1000);
          break;
        }

        case "type": {
          await autoRecoverActiveModals(page, action);
          let el = await getLocator(page, action);
          if (!el) {
            el = await trySelfHealAction(page, action, momentId, plan, dataDir);
          }
          if (!el) {
            if (action.force === false) {
              console.log(`  [선택적 액션 스킵] 입력 요소를 찾을 수 없어 스킵합니다: ${action.description}`);
              break;
            }
            throw new Error(`입력 요소를 찾을 수 없습니다: ${action.selector}`);
          }

          const waitTimeout = 25000;
          try {
            await el.waitFor({ state: "visible", timeout: waitTimeout });
          } catch (waitErr) {
            let resolved = false;
            const desc = action.description || "";
            let fallbackInput: Locator | null = null;
            if (desc.includes("제목") || desc.includes("subject")) {
              const regBtn = page.locator("button#reg_shedule_lefttop:visible").first();
              if (await regBtn.isVisible().catch(() => false)) {
                await regBtn.click({ force: true }).catch(() => {});
                await page.waitForTimeout(1500);
              }
              fallbackInput = page.locator("#reg_schedule_form #subject, .ui-dialog:visible #subject, input#subject:visible, input[placeholder*='제목']").first();
            } else if (desc.includes("내용") || desc.includes("본문") || desc.includes("회의입니다")) {
              fallbackInput = page.locator("textarea:visible, textarea[placeholder*='내용'], #reg_schedule_form #cn, .ui-dialog:visible #cn").first();
            }

            if (fallbackInput && (await fallbackInput.count().catch(() => 0)) > 0) {
              console.log(`  [✨ 지능형 런타임 복구] '${action.description}'에 맞는 입력 필드를 감지하여 자동 복구했습니다.`);
              el = fallbackInput;
              resolved = true;
            }

            // 🚨 Trigger AI Runtime Self-Healing if still not found!
            if (!resolved) {
              const healed = await trySelfHealAction(page, action, momentId, plan, dataDir);
              if (healed) {
                el = healed;
                resolved = true;
              }
            }

            if (!resolved) {
              throw new Error(`입력 요소를 찾을 수 없거나 화면에 표시되지 않습니다: ${action.selector}`);
            }
          }
          await el.scrollIntoViewIfNeeded().catch(() => { });
          const { locator: targetEl, box } = await resolveAtomicTarget(el, true);
          el = targetEl;

          const desc = (action.description || "").toLowerCase();
          const sel = (action.selector || "").toLowerCase();
          const isEditorAction = desc.includes("내용") || desc.includes("본문") || desc.includes("content") || sel.includes("cn") || sel.includes("editor");

          // When typing content/body, ensure we are targeting the actual editable canvas, not an outer toolbar
          if (isEditorAction) {
            const innerEditable = el.locator("[contenteditable='true']:visible, textarea:visible, .note-editable:visible, .ce-paragraph:visible").first();
            if (await innerEditable.isVisible().catch(() => false)) {
              el = innerEditable;
            }
          }

          if (box) {
            // For typing, natural cursor position is near text start (offset 16px) or center if very small
            const clickX = box.width > 60 ? box.x + 16 : box.x + box.width / 2;
            const clickY = box.y + box.height / 2;
            const rawX = clickX + (action.cursorOffset?.x || 0);
            const rawY = clickY + (action.cursorOffset?.y || 0);
            const clamped = clampToViewport(
              rawX,
              rawY,
              plan.viewport.width,
              plan.viewport.height
            );
            moment.cursor = {
              x: Math.round(clamped.x),
              y: Math.round(clamped.y),
            };
            moment.target = {
              x: Math.round(Math.max(0, box.x)),
              y: Math.round(Math.max(0, box.y)),
              width: Math.round(box.width),
              height: Math.round(box.height),
            };
          }

          moment.timestamp = Date.now() - recordingStart;

          // Blur any previously active inputs (e.g. title input) so text never leaks across fields
          await page.evaluate(() => {
            const active = document.activeElement as HTMLElement | null;
            if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")) {
              active.blur();
            }
          });

          if (moment.cursor) {
            await triggerClickVisualizer(page, moment.cursor.x, moment.cursor.y);
          }
          try {
            await el.click({ timeout: 3000, force: action.force ?? true }).catch(() => { });
          } catch { }
          await el.focus().catch(() => { });

          let text = action.text ?? "";

          // Method 2: Dynamic Live Data Linking
          if (action.useScraped && action.useScraped !== "auto") {
            const val = runtimeVariables.get(action.useScraped);
            if (val) {
              text = val;
              console.log(`  [✨ 동적 데이터 연동] 변수 '${action.useScraped}'의 실제 텍스트("${text}")를 입력합니다.`);
            }
          } else if (action.dynamicFrom) {
            const liveVal = await scrapeLiveText(page, { ...action, dynamicFrom: action.dynamicFrom });
            if (liveVal) {
              text = liveVal;
              console.log(`  [✨ 동적 데이터 연동] '${action.dynamicFrom}'에서 추출한 실제 텍스트("${text}")를 입력합니다.`);
              if (action.scrapeAs) runtimeVariables.set(action.scrapeAs, text);
            }
          } else {
            const isSearch =
              desc.includes("검색") ||
              desc.includes("조회") ||
              desc.includes("찾기") ||
              action.useScraped === "auto" ||
              (action.selector && (action.selector.includes("search") || action.selector.includes("srch")));

            if (isSearch) {
              const liveKeyword = await scrapeLiveText(page, action);
              if (liveKeyword) {
                console.log(`  [🔍 실시간 DB 연동 검색] 가상 텍스트 대신 현재 화면의 실제 목록 데이터("${liveKeyword}")로 자동 전환하여 검색합니다!`);
                text = liveKeyword;
                runtimeVariables.set("lastSearchKeyword", text);
                if (action.scrapeAs) runtimeVariables.set(action.scrapeAs, text);
              }
            }
          }

          if (action.scrapeAs && text) {
            runtimeVariables.set(action.scrapeAs, text);
          }

          try {
            await el.pressSequentially(text, { delay: 40 });
          } catch (typeErr) {
            try {
              await el.fill(text);
            } catch {
              await page.keyboard.type(text, { delay: 40 });
            }
          }

          moment.keys = text;
          await page.waitForTimeout(600);
          break;
        }

        case "scroll": {
          const deltaY = action.deltaY ?? 300;
          let cursorX = 960;
          let cursorY = 540;

          if (action.selector) {
            const el = await getLocator(page, action);
            if (el) {
              const box = await el.boundingBox().catch(() => null);
              if (box) {
                const clamped = clampToViewport(
                  box.x + box.width / 2,
                  box.y + box.height / 2,
                  plan.viewport.width,
                  plan.viewport.height
                );
                cursorX = Math.round(clamped.x);
                cursorY = Math.round(clamped.y);
                await page.mouse.move(cursorX, cursorY).catch(() => { });
              }
            }
          }

          moment.cursor = {
            x: cursorX,
            y: cursorY,
          };
          moment.timestamp = Date.now() - recordingStart;
          await page.mouse.wheel(0, deltaY);
          await page.waitForTimeout(600);
          moment.scrollDelta = {
            x: 0,
            y: deltaY,
          };
          break;
        }

        case "upload": {
          const el = await getLocator(page, action);
          if (!el) break;
          const filePath = action.filePath ?? action.text ?? "";
          await el.waitFor({ state: "attached", timeout: 15000 }).catch(() => { });
          moment.timestamp = Date.now() - recordingStart;
          await el.setInputFiles(filePath);
          await page.waitForTimeout(1000);
          break;
        }

        case "script": {
          if (!action.js) break;
          moment.timestamp = Date.now() - recordingStart;
          await page.evaluate(action.js);
          await page.waitForTimeout(800);
          break;
        }
      }

      if (moment.timestamp > 0 || (momentId === 1 && action.type === "wait")) {
        moments.push(moment);
        console.log(`  [${moment.timestamp}ms] ${action.type}: ${action.description}`);
      } else {
        console.log(`  [건너뜀] ${action.type}: ${action.description}`);
      }
    }
  } catch (err: any) {
    const errorImgPath = path.join(dataDir, "recording_error.png");
    await page.screenshot({ path: errorImgPath }).catch(() => { });
    console.error(`\n❌ [녹화 실패] 단계: momentId=${momentId}`);
    console.error(`  오류 내용:`, err.message);
    console.error(`  실패 시점 화면 캡처 저장: ${errorImgPath}\n`);
    await context.close().catch(() => { });
    await browser.close().catch(() => { });
    process.exit(1);
  }

  // Finalize video safely on Windows (handles EPERM file locks from browser preview/Express)
  const video = page.video();
  const videoTempPath = await video?.path().catch(() => null);
  await context.close().catch(() => { });
  await browser.close().catch(() => { });

  // Sleep briefly (250ms) to ensure Windows OS releases Chromium write file handles
  await new Promise((r) => setTimeout(r, 250));

  const destPath = path.join(dataDir, "recording.mp4");
  let startOffsetMs = 0;
  let videoSaved = false;

  // Resolve source video file
  let srcFile = videoTempPath && fs.existsSync(videoTempPath) ? videoTempPath : null;
  if (!srcFile) {
    try {
      const candidates = fs.readdirSync(videoDir)
        .filter((f) => f.startsWith("page@") && f.endsWith(".webm"))
        .map((f) => ({ path: path.join(videoDir, f), size: fs.statSync(path.join(videoDir, f)).size }))
        .sort((a, b) => b.size - a.size);
      if (candidates.length > 0) {
        srcFile = candidates[0].path;
      }
    } catch { }
  }

  if (srcFile && fs.existsSync(srcFile)) {
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        fs.copyFileSync(srcFile, destPath);
        videoSaved = true;
        try { fs.unlinkSync(srcFile); } catch { }
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 300));
      }
    }
  }

  if (videoSaved) {
    console.log(`\nRecording saved: ${destPath}`);

    // Calibrate timeline offset with exact video metadata
    try {
      const meta = await getVideoMetadata(destPath);
      const durationSec = meta.durationInSeconds ?? 0;
      if (durationSec > 0) {
        const videoDurationMs = Math.round(durationSec * 1000);
        console.log(
          `[Sync] 비디오 길이: ${videoDurationMs}ms (${moments.length}개 액션 타임스탬프 동기화)`
        );

        // Honest, unshifted mapping: cap any overflow timestamps to video duration
        for (const moment of moments) {
          moment.timestamp = Math.min(videoDurationMs, Math.max(0, Math.round(moment.timestamp)));
        }
      }
    } catch (err) {
      console.warn("비디오 메타데이터 읽기 오류:", err);
    }

    // Also copy to public/recording.mp4 for Remotion preview with retry
    const publicDest = path.resolve(__dirname, "..", "public", "recording.mp4");
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        fs.copyFileSync(destPath, publicDest);
        console.log(`Copied to public/recording.mp4`);
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 300));
      }
    }
  }

  // 🌟 2-Pass Clean Master Re-recording:
  // If AI runtime self-healing occurred during this recording run, the video contains 10-second idle stalls while
  // Playwright timed out waiting for old selectors. Since all healed selectors have now been permanently saved
  // to browse-plan.json, we automatically run a second, clean recording pass to produce a pristine master video!
  const isCleanPass = process.argv.includes("--clean-pass");
  const isNoCleanPass = process.argv.includes("--no-clean-pass");

  if (totalHealedCount > 0 && !isCleanPass && !isNoCleanPass) {
    console.log(`\n========================================================================`);
    console.log(`✨ [시나리오 자가 복구 완료] 총 ${totalHealedCount}건의 요소가 성공적으로 교정되어 영구 저장되었습니다.`);
    console.log(`🎬 [2-Pass 클린 마스터 재녹화 자동 가동] 10초 대기 공백을 제거하고 매끄러운 최종 마스터 영상을 생성하기 위해 클린 패스를 즉시 재녹화합니다!`);
    console.log(`========================================================================\n`);

    const isHeaded = process.argv.includes("--headed");
    const loginFlag = process.argv.includes("--login") ? " --login" : "";
    const cleanCmd = `npx tsx scripts/record.ts ${slug} ${isHeaded ? "--headed" : "--headless"}${loginFlag} --clean-pass`;
    try {
      execSync(cleanCmd, { stdio: "inherit" });
      return;
    } catch (cleanErr: any) {
      console.warn(`[클린 재녹화 예외] 클린 패스 실행 중 오류 발생: ${cleanErr.message}. 1차 복구 녹화본을 기반으로 후가공을 진행합니다.`);
    }
  }

  // Write moments.json
  const totalDurationMs = Math.max(0, Date.now() - recordingStart);
  const momentsFile: MomentsFile = {
    metadata: {
      url: plan.url,
      viewportWidth: plan.viewport.width,
      viewportHeight: plan.viewport.height,
      totalDurationMs,
      recordingStart: new Date(recordingStart).toISOString(),
    },
    moments,
  };

const momentsPath = path.join(dataDir, "moments.json");
fs.writeFileSync(momentsPath, JSON.stringify(momentsFile, null, 2));
console.log(`Moments saved: ${momentsPath} (${moments.length} actions)`);

// Auto-generate edit plan
try {
  console.log("\nBuilding edit plan...");
  execSync(`python scripts/build-edit-plan.py ${slug} --keep-last`, { stdio: "inherit" });

  // Update Root.tsx to point to this recording
  const rootPath = path.resolve(__dirname, "..", "src", "Root.tsx");
  const rootContent = `import React from "react";
import { Composition } from "remotion";
import { ScreenDemo } from "./ScreenDemo";
import type { EditPlan, MomentsFile } from "./types";

import editPlanData from "../data/${slug}/edit-plan.json";
import momentsData from "../data/${slug}/moments.json";

const editPlan = editPlanData as EditPlan;
const moments = momentsData as MomentsFile;

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="ScreenDemo"
        component={ScreenDemo as unknown as React.ComponentType<Record<string, unknown>>}
        durationInFrames={editPlan.totalDurationFrames}
        fps={editPlan.fps}
        width={1920}
        height={1080}
        defaultProps={{
          editPlan,
          moments,
          videoFileName: "recording.mp4",
          showCursor: true,
          showSfx: false,
        }}
      />
    </>
  );
};
`;
  fs.writeFileSync(rootPath, rootContent);
  console.log(`Updated Root.tsx -> data/${slug}/`);
} catch (e) {
  console.warn("Could not automatically run build-edit-plan.py:", e);
}
}

main().catch((err) => {
  console.error("Recording failed:", err);
  process.exit(1);
});

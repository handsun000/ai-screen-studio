
import { chromium, type Browser, type Page, type BrowserContext, type Locator } from "playwright";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import { execSync } from "child_process";
import { getVideoMetadata } from "@remotion/renderer";
import type { BrowsePlan, BrowsePlanAction, Moment, MomentsFile, BoundingBox } from "../src/types";
import { sanitizeBrowsePlan, splitSelectorCandidates } from "../src/services/planSanitizer";
import { selfHealElement, saveHealedPlan } from "../src/services/elementSelfHealer";
import { findExistingAuthSession, syncAuthSession } from "../src/services/authManager";

// Universal runtime tracking for created entities across scenarios
const currentRuntimeVariables = new Map<string, string>();

/**
 * Computes a specificity score for candidate selectors.
 * Specific text matches (:has-text) and unique IDs are given highest priority,
 * while broad catch-all classes (.fc-event:visible, tr:visible, a:visible) are penalized
 * so they act only as true last-resort fallbacks.
 */
function computeSelectorSpecificityScore(s: string): number {
  let score = 0;
  const lower = s.toLowerCase().trim();

  // 1. ID selectors (#id is unique in DOM - MUST always take highest priority over generic text matches!)
  if (/#([a-zA-Z0-9_-]+)/.test(s)) {
    score += 160;
  }

  // 2. Exact attribute values ([name='...'], [data-app-type-ordr='...'], [value='...'], etc.)
  if (/\[[a-zA-Z0-9_-]+(=|\*=|\^=|\$=)/.test(s)) {
    score += 130;
  }

  // 3. Structural DOM hierarchy path (e.g. div#id > ul > li:nth-of-type(1) > button)
  if (s.includes(">")) {
    score += 110;
  }

  // 4. Text-matching pseudos (:has-text, :text, :text-is)
  if (lower.includes(":has-text(") || lower.includes(":text(") || lower.includes(":text-is(")) {
    score += 90;
  }

  // 5. Modal / Dialog / Section Scoping (.ui-dialog:visible, #snb, header)
  if (lower.includes(".ui-dialog") || lower.includes(".modal") || lower.includes("#snb") || lower.includes("header")) {
    score += 25;
  }

  // 6. Positionals (:first-child, :last-child, :nth-child, :nth-of-type)
  if (lower.includes(":first-child") || lower.includes(":last-child") || lower.includes(":nth-child") || lower.includes(":nth-of-type")) {
    score += 20;
  }

  // 7. Multiple classes (e.g. .fc-event-title, .btn.btn_primary)
  const classMatches = s.match(/\.[a-zA-Z0-9_-]+/g);
  if (classMatches) {
    score += Math.min(20, classMatches.length * 5);
  }

  // 8. BROAD CATCH-ALL PENALTIES:
  // Catch-all generic classes that match dozens/hundreds of elements must NOT precede specific filters!
  if (/^\.fc-event(:visible)?$/.test(lower) || /^\.fc-day-grid-event(:visible)?$/.test(lower) || /^\.fc-time-grid-event(:visible)?$/.test(lower)) {
    score -= 60; // Broad calendar event catch-all
  }
  if (/^\.item(:visible)?$/.test(lower) || /^\.row(:visible)?$/.test(lower) || /^\.card(:visible)?$/.test(lower)) {
    score -= 60;
  }
  // Pure bare tag catch-alls (e.g. "a", "button", "div", "tr", "td", "li", "span", "p" with only :visible)
  if (/^(a|button|input|div|tr|td|li|span|p)(:visible)?$/.test(lower)) {
    score -= 80;
  }

  return score;
}

function sortSelectorsBySpecificity(parts: string[]): string[] {
  return [...parts].sort((a, b) => {
    return computeSelectorSpecificityScore(b) - computeSelectorSpecificityScore(a);
  });
}

async function getLocatorWithWait(page: Page, action: BrowsePlanAction, isFastCheck: boolean = false): Promise<Locator | null> {
  const originalSelector = action.selector;
  const rawParts = splitSelectorCandidates(action.selector || "");
  const parts = action.recordedByEyedropper ? rawParts : sortSelectorsBySpecificity(rawParts);

  
  const topAttempts = isFastCheck ? 1 : 2;
  const allAttempts = isFastCheck ? 2 : 5;

  // 1. 초기 시도는 가장 구체적인 상위 셀렉터(우선순위 최고)만으로 탐색하여,
  // 화면 로딩 중 덜 구체적인 Fallback 셀렉터가 먼저 매칭되어 잘못된 요소를 클릭하는 현상을 방지
  // (반드시 el.isVisible()이 실제로 true일 때만 조기 반환하여 후속 후보 셀렉터가 누락되지 않도록 보장!)
  if (parts.length > 1) {
    const topCandidates = parts.slice(0, Math.min(2, parts.length)).join(", ");
    action.selector = topCandidates; 
    for (let i = 0; i < topAttempts; i++) {
      const el = await getLocator(page, action);
      if (el && (await el.isVisible().catch(() => false))) {
        action.selector = originalSelector;
        return el;
      }
      await page.waitForTimeout(300);
    }
    action.selector = originalSelector; // 복원
  }

  // 2. 구체적 셀렉터가 당장 보이지 않으면, 모든 후보 셀렉터(parts 전체)를 순서대로 탐색
  let el: Locator | null = null;
  action.selector = parts.join(", ");
  for (let i = 0; i < allAttempts; i++) {
    el = await getLocator(page, action);
    if (el && (await el.isVisible().catch(() => false))) {
      action.selector = originalSelector;
      return el;
    }
    await page.waitForTimeout(500);
  }
  action.selector = originalSelector;
  return el;
}

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

async function findVisibleInPageOrFrames(
  page: Page,
  selector: string,
  preferLast: boolean = false
): Promise<Locator | null> {
  try {
    const mainLoc = preferLast ? page.locator(selector).last() : page.locator(selector).first();
    if (await mainLoc.isVisible().catch(() => false)) {
      return mainLoc;
    }
  } catch {}
  for (const frame of page.frames()) {
    if (frame === page.mainFrame() || frame.isDetached()) continue;
    try {
      const fLoc = preferLast ? frame.locator(selector).last() : frame.locator(selector).first();
      if (await fLoc.isVisible().catch(() => false)) {
        return fLoc;
      }
    } catch {}
  }
  return null;
}

async function getLocator(page: Page, action: BrowsePlanAction): Promise<Locator | null> {
  const desc = (action.description || "").toLowerCase();

  // 1. Syntax Auto-Fixer (Heals common user input syntax errors like button:btn_svc_open -> button.btn_svc_open)
  let selector = (action.selector || "").trim();

  // Restore previously corrupted .nth-of-type / .first-of-type / .last-of-type back to valid CSS pseudo-classes
  selector = selector.replace(
    /\.(nth-of-type|first-of-type|last-of-type|nth-child|first-child|last-child|only-child|only-of-type)\b/g,
    ":$1"
  );

  // Fix button:class_name typo where user typed colon instead of dot
  selector = selector.replace(
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
  selector = selector
    .replace(/:first(?!\-child|\-of\-type)\b/g, ":first-child")
    .replace(/:last(?!\-child|\-of\-type)\b/g, ":last-child")
    .replace(/\.select2-(?:focused|active|dropdown-open|container-active|drop-above)\b/g, "");

  // Filter out dummy onclick='return false;' candidates and strip erroneous #header prefixes on content/form elements
  const cleanedCandidates = splitSelectorCandidates(selector)
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
  if (cleanedCandidates.length > 0) {
    selector = Array.from(new Set(cleanedCandidates)).join(", ");
  }
  action.selector = selector;

  // Build candidate bases: prioritized by action.iframe, active child frames (page.frames()), and fallback to page and common iframes
  const candidateBases: Array<{ name: string; locator: (sel: string) => Locator }> = [];
  if (action.iframe) {
    const iframeParts = splitSelectorCandidates(action.iframe);
    for (const fSel of iframeParts) {
      if (!fSel) continue;
      candidateBases.push({
        name: `iframe(${fSel})`,
        locator: (sel: string) => page.frameLocator(fSel).first().locator(sel),
      });
    }
    // Also traverse all active child frames in page.frames() (handles setup_iframe, dynamic iframe names, or nested frames)
    for (const frame of page.frames()) {
      if (frame !== page.mainFrame() && !frame.isDetached()) {
        candidateBases.push({
          name: `frame(${frame.name() || frame.url()})`,
          locator: (sel: string) => frame.locator(sel),
        });
      }
    }
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
    // Also check all active child frames in page.frames()
    for (const frame of page.frames()) {
      if (frame !== page.mainFrame() && !frame.isDetached()) {
        candidateBases.push({
          name: `frame(${frame.name() || frame.url()})`,
          locator: (sel: string) => frame.locator(sel),
        });
      }
    }
    // Check known common iframes if not found in main page
    const commonFrames = ["iframe[name='setup_iframe']", "iframe#subBody", "iframe#contentFrame", "iframe#mainFrame", "iframe:visible"];
    for (const frameSel of commonFrames) {
      candidateBases.push({
        name: `iframe(${frameSel})`,
        locator: (sel: string) => page.frameLocator(frameSel).first().locator(sel),
      });
    }
  }

  // 2. Active modal dialog scoping (Handles stacked/nested dialogs by prioritizing topmost modal by z-index)
  const dialogLoc = page.locator(".ui-dialog:visible, .modal:visible, .layer_wrap:visible, .equ_select_lyr:visible, [role='dialog']:visible");
  const dialogCount = await dialogLoc.count().catch(() => 0);
  const hasOverlay = (await page.locator(".ui-widget-overlay:visible, .modal-backdrop:visible").count().catch(() => 0)) > 0;

  if (dialogCount > 0 && action.selector) {
    const dialogSelectors = splitSelectorCandidates(action.selector);

    // Calculate z-indices so the true topmost visual dialog is checked first
    const dialogIndicesByZIndex = await page.evaluate(() => {
      const dialogs = Array.from(document.querySelectorAll(".ui-dialog, .modal, .layer_wrap, .equ_select_lyr, [role='dialog']")).filter((el) => {
        const s = window.getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return s.display !== "none" && s.visibility !== "hidden" && r.width > 50 && r.height > 50;
      });
      return dialogs
        .map((d, i) => ({ index: i, zIndex: parseInt(window.getComputedStyle(d).zIndex, 10) || 0 }))
        .sort((a, b) => b.zIndex - a.zIndex)
        .map((item) => item.index);
    }).catch(() => []);

    const order = dialogIndicesByZIndex.length === dialogCount
      ? dialogIndicesByZIndex
      : Array.from({ length: dialogCount }, (_, i) => dialogCount - 1 - i);

    // Check topmost dialogs first (from highest z-index down) to prevent targeting covered parent dialog
    for (let orderIdx = 0; orderIdx < order.length; orderIdx++) {
      // 🛡️ If a modal backdrop/overlay is active, lower background dialogs are physically covered and unclickable!
      if (hasOverlay && orderIdx > 0) break;
      const d = order[orderIdx];
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
            console.log(`  [🎯 최상단 모달 요소 감지] 활성 팝업(z-index 우선) 내부에서 '${cleanSel}' 요소를 우선 선택합니다.`);
            return cand;
          }
        } catch {
          // Gracefully skip invalid selector syntax
        }
      }
    }

    // 2-B. Check floating body-level popovers (Datepicker, Timepicker, Autocomplete, Select2) that render ABOVE .ui-dialog outside the dialog DOM tree
    for (const s of dialogSelectors) {
      const cleanS = s.replace(/:first\b/g, "").replace(/:last\b/g, "").trim();
      if (!cleanS) continue;
      if (
        cleanS.includes("datepicker") ||
        cleanS.includes("timepicker") ||
        cleanS.includes("ui-state-default") ||
        cleanS.includes("autocomplete") ||
        cleanS.includes("select2")
      ) {
        try {
          const floatLoc = page.locator(cleanS).first();
          if (await floatLoc.isVisible().catch(() => false)) {
            console.log(`  [📅 최상단 플로팅 피커 감지] 모달 위 플로팅 위젯('${cleanS}') 요소를 선택합니다.`);
            return floatLoc;
          }
        } catch {}
      }
    }

    if (!hasOverlay) {
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

  }

  // 3. Search target selector across candidate bases
  if (action.selector) {
    const rawParts = splitSelectorCandidates(action.selector);
    const parts = action.recordedByEyedropper ? [...rawParts] : sortSelectorsBySpecificity(rawParts);

    // 3-0. Universal Dynamic Created Entity / Verification Linking (AI-generated plans only, never Eyedropper)
    const isVerifyingCreatedItem =
      !action.recordedByEyedropper &&
      (desc.includes("등록된") ||
       desc.includes("신규") ||
       desc.includes("작성된") ||
       desc.includes("기안된") ||
       desc.includes("생성된") ||
       desc.includes("추가된") ||
       (desc.includes("검증") && (action.type === "click" || action.type === "hover")));

    if (isVerifyingCreatedItem && currentRuntimeVariables.has("lastCreatedTitle")) {
      const title = currentRuntimeVariables.get("lastCreatedTitle")!;
      const kw = currentRuntimeVariables.get("lastCreatedKeyword") || title.slice(0, 10);

      // Check if parts already contains this keyword
      const alreadyHasKw = parts.some(p => p.includes(kw) || p.includes(title));
      if (!alreadyHasKw) {
        const titleCandidates = [
          `a.fc-event:has-text('${kw}'):visible`,
          `.fc-event-title:has-text('${kw}'):visible`,
          `.fc-event:has-text('${kw}'):visible`,
          `table tbody tr:has-text('${kw}'):visible a:visible`,
          `table tbody tr:has-text('${kw}'):visible`,
          `ul[class*='lst'] li:has-text('${kw}'):visible a:visible`,
          `ul[class*='lst'] li:has-text('${kw}'):visible`,
          `a:has-text('${kw}'):visible`,
          `button:has-text('${kw}'):visible`
        ];
        parts.unshift(...titleCandidates);
        console.log(`  [🎯 신규 등록 항목 핀포인트 매칭] 방금 등록된 제목("${kw}") 일치 요소를 최우선으로 탐색합니다.`);
      }
    }

    // 3-A. Contextual Description Prioritization (Disambiguate identical buttons across header/sidebar/content)
    // Skip for Eyedropper actions since their selectors already have exact DOM/ID scoping
    if (!action.recordedByEyedropper) {
      const isHeaderIntent = desc.includes("상단") || desc.includes("헤더") || desc.includes("gnb") || desc.includes("전체메뉴");
      const isSidebarIntent =
        desc.includes("좌측") ||
        desc.includes("사이드바") ||
        (desc.includes("메뉴") && !desc.includes("메뉴/링크")) ||
        desc.includes("snb");
      const isContentIntent = desc.includes("본문") || desc.includes("목록") || desc.includes("콘텐츠");

      if (isHeaderIntent || isSidebarIntent || isContentIntent) {
        const scopePrefixes = isHeaderIntent
          ? ["header", "#header", ".gnb", "#top"]
          : isSidebarIntent
          ? ["#snb", "#left", "aside", ".snb", "nav"]
          : ["#content", ".content", "main"];

        for (const rawPart of parts) {
          const cleanPart = rawPart.replace(/:first\b/g, "").replace(/:last\b/g, "").trim();
          if (!cleanPart) continue;
          for (const baseObj of candidateBases) {
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
    }

    // 3-B. Prioritize elements that are currently visible on screen across bases
    for (const rawPart of parts) {
      const isLast = rawPart.endsWith(":last") || rawPart.includes(":last");
      const cleanPart = rawPart.replace(/:first\b/g, "").replace(/:last\b/g, "").trim();
      if (!cleanPart) continue;

      for (const baseObj of candidateBases) {
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

    // 3-B-Hover. Resolve CSS-hidden checkbox/radio to wrapping <label>, or Auto-Hover Parent Container to Reveal CSS :hover Hidden Buttons
    if (action.type === "click" || action.type === "dblclick") {
      for (const rawPart of parts) {
        const cleanPart = rawPart
          .replace(/:first\b/g, "")
          .replace(/:last\b/g, "")
          .replace(/:visible\s*$/i, "")
          .trim();
        if (!cleanPart) continue;

        for (const baseObj of candidateBases) {
          try {
            const hiddenLoc = baseObj.locator(cleanPart);
            const hiddenCount = await hiddenLoc.count().catch(() => 0);
            if (hiddenCount > 0) {
              for (let i = 0; i < Math.min(hiddenCount, 4); i++) {
                const candidate = hiddenLoc.nth(i);
                const tagAndType = await candidate
                  .evaluate((el) => ({
                    tag: el.tagName.toLowerCase(),
                    type: ((el as HTMLInputElement).type || "").toLowerCase(),
                    id: el.id || "",
                  }))
                  .catch(() => ({ tag: "", type: "", id: "" }));

                // If target is a CSS-hidden checkbox/radio input (e.g. input.input_chk inside label.chkbox), target its visible wrapping <label>
                if (tagAndType.tag === "input" && (tagAndType.type === "checkbox" || tagAndType.type === "radio")) {
                  const wrappingLabel = candidate.locator("xpath=ancestor::label[1]").first();
                  if (await wrappingLabel.isVisible().catch(() => false)) {
                    return wrappingLabel;
                  }
                  if (tagAndType.id) {
                    const forLabel = baseObj.locator(`label[for='${tagAndType.id}']:visible`).first();
                    if (await forLabel.isVisible().catch(() => false)) {
                      return forLabel;
                    }
                  }
                  continue;
                }

                // Never hover parent rows for non-button inputs
                if (tagAndType.tag === "input" || tagAndType.tag === "textarea" || tagAndType.tag === "select") {
                  continue;
                }

                // If candidate is inside a custom dropdown (.Selected > .options, .select_box, .combobox, .btn_drop) whose options are hidden until clicked, click the trigger first!
                const dropdownTrigger = candidate
                  .locator(
                    "xpath=ancestor::*[contains(@class,'Selected') or contains(@class,'select_box') or contains(@class,'combobox') or contains(@class,'btn_drop')][1]"
                  )
                  .first();
                if (await dropdownTrigger.isVisible().catch(() => false)) {
                  console.log(
                    `  [🔽 커스텀 드롭다운 자동 펼침] '${cleanPart}' 옵션이 드롭다운 내부에 숨겨져 있어 상위 트리거를 먼저 클릭합니다.`
                  );
                  await dropdownTrigger.click({ timeout: 1500 }).catch(() => {});
                  await page.waitForTimeout(350);
                  if (await candidate.isVisible().catch(() => false)) {
                    return candidate;
                  }
                  // If jQuery toggle requires showing .options directly as fallback
                  await dropdownTrigger
                    .evaluate((node) => {
                      const opts = node.querySelector(".options, .select_list, .drop_menu") as HTMLElement | null;
                      if (opts) opts.style.display = "block";
                    })
                    .catch(() => {});
                  await page.waitForTimeout(150);
                  if (await candidate.isVisible().catch(() => false)) {
                    return candidate;
                  }
                }

                const hoverParent = candidate
                  .locator(
                    "xpath=ancestor::*[contains(@class,'app_work_box') or contains(@class,'aw_li') or contains(@class,'card') or self::li or self::tr][1]"
                  )
                  .first();
                if (await hoverParent.isVisible().catch(() => false)) {
                  console.log(
                    `  [🖱️ 호버 노출 자동 실행] '${cleanPart}' 요소가 마우스 호버 전 숨김 상태이므로 부모 카드/컨테이너에 먼저 마우스를 올립니다.`
                  );
                  await hoverParent.scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => {});
                  const pBox = await hoverParent.boundingBox().catch(() => null);
                  if (pBox) {
                    await page.mouse.move(
                      Math.round(pBox.x + pBox.width / 2),
                      Math.round(pBox.y + pBox.height / 2)
                    ).catch(() => {});
                  }
                  await hoverParent.hover({ timeout: 1500, force: true }).catch(() => {});
                  await page.waitForTimeout(400);
                  if (await candidate.isVisible().catch(() => false)) {
                    console.log(`  [✨ 호버 노출 성공] 부모 컨테이너 호버 후 나타난 '${cleanPart}' 요소를 정확히 타겟팅합니다!`);
                    return candidate;
                  }
                }
              }
            }
          } catch {}
        }
      }
    }
  }

  // 3-C. Universal First Item / Detail View Fallback (AI-generated plans only — never override Eyedropper actions!)
  const isFirstItemIntent =
    !action.recordedByEyedropper &&
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


  // 3-D. Universal Calendar Hover Fallback (AI-generated plans only)
  if (!action.recordedByEyedropper && dialogCount === 0 && action.type === "hover" && (desc.includes("캘린더 본문") || desc.includes("달력 본문") || desc.includes("캘린더 영역") || desc.includes("달력 영역") || desc.includes("일정 항목"))) {
    const calendarSelectors = [
      ".fc-daygrid-day-frame:visible",
      ".fc-view-harness:visible",
      ".fc-view:visible",
      ".cal_skd_wrap:visible",
      "#calendar:visible",
      ".fc-scrollgrid-sync-inner:visible"
    ];
    for (const baseObj of candidateBases) {
      for (const sel of calendarSelectors) {
        try {
          const loc = baseObj.locator(sel).first();
          if (await loc.isVisible().catch(() => false)) {
            console.log(`  [🎯 캘린더 빈 영역 자동 연결] 일정 요소를 찾지 못해 캘린더 기본 영역(${sel})으로 호버를 대체합니다.`);
            return loc;
          }
        } catch {}
      }
    }
  }

  // 4. Intelligent Self-Healing for Buttons / Interactive Elements
  // If selector is empty or failed to match, extract button/action names from description and try verified patterns
  // Note: If action was recorded by Eyedropper with an explicit selector, do NOT hijack it via loose quote text matching!
  if (desc && !(action.recordedByEyedropper && action.selector)) {
    const fallbackSelectors: string[] = [];

    // 1. Extract any text inside brackets or quotes: [문서 등록], [일정 등록], [저장], [확인], [상신], [검색] 등
    const bracketMatch = desc.match(/\[(.*?)\]/);
    const quoteMatch = bracketMatch || desc.match(/[\'\"\(](.*?)[\'\"\)]/);
    if (quoteMatch && quoteMatch[1] && quoteMatch[1].length >= 2 && quoteMatch[1].trim() !== "검색") {
      const textKey = quoteMatch[1].trim();
      fallbackSelectors.push(
        `.ui-dialog:visible button:has-text('${textKey}'):visible`,
        `.modal:visible button:has-text('${textKey}'):visible`,
        `button:not(._header_writeBtn):not(#header *):has-text('${textKey}'):visible`,
        `button:not(._header_writeBtn):not(#header *):has-text('${textKey.replace(/\s+/g, "")}'):visible`,
        `a:not(._his):has-text('${textKey}'):visible`,
        `a:not(._his):has-text('${textKey.replace(/\s+/g, "")}'):visible`,
        `[role='button']:has-text('${textKey}'):visible`,
        `:text-is('${textKey}'):visible`,
        `span.txt:has-text('${textKey}'):visible`,
        `label:has-text('${textKey}'):visible`
      );
    }

    // 2. Universal Action Intent Fallbacks (No module-specific IDs - works across all features!)
    if (action.type === "click" && desc.includes("저장")) {
      fallbackSelectors.push(
        ".ui-dialog:visible button:has-text('저장'):visible",
        ".modal:visible button:has-text('저장'):visible",
        "button:has-text('저장'):visible",
        "button[title*='저장']:visible",
        "[id*='save']:visible",
        "[class*='save']:visible"
      );
    }

    const isNewDraftAction =
      (desc.includes("문서 등록") || desc.includes("일정 등록") || desc.includes("게시글 등록") || desc.includes("신규 등록") || desc.includes("신규 작성") || desc.includes("글작성")) &&
      !desc.includes("등록된") && !desc.includes("대상자") && !desc.includes("사용자") && !desc.includes("추가");

    if (action.type === "click" && isNewDraftAction) {
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

    if (action.type === "click" && desc.includes("추가") && !isNewDraftAction) {
      fallbackSelectors.push(
        ".ui-dialog:visible button:has-text('추가'):visible",
        ".modal:visible button:has-text('추가'):visible",
        "button:has-text('추가'):visible",
        "button._addBtn:visible",
        "button.btn_add:visible"
      );
    }

    if (action.type === "click" && (desc.includes("확인") || desc.includes("선택 완료") || desc.includes("적용"))) {
      fallbackSelectors.push(
        ".ui-dialog:visible .ui-dialog-buttonpane button:has-text('확인'):visible",
        ".ui-dialog:visible button:text-is('확인'):visible",
        ".modal:visible button:text-is('확인'):visible",
        "button:text-is('확인'):visible",
        "button:has-text('확인'):visible"
      );
    }

    // Binder / Folder selection button (Must precede draft/submit to prevent false positive match)
    if (action.type === "click" && (desc.includes("보관함") || desc.includes("기록물철")) && !desc.includes("트리") && !desc.includes("노드") && !desc.includes("확인")) {
      fallbackSelectors.push(
        "button#eapDocReg_binderSelBtn:visible",
        "button#gapDocReg_bindBtn:visible",
        "#eapDocReg_bind button:visible",
        "button.btn_ico:has(.ico_fldr1):visible",
        "button[title='선택'].btn_ico:visible",
        "tr:has-text('결재문서보관함') button:visible",
        "tr:has-text('보관함') button:visible"
      );
    }

    // Submission / Draft button (Strictly exclude binder/line/navigation actions)
    if (
      action.type === "click" &&
      (desc.includes("상신") || desc.includes("결재상신") || (desc.includes("기안") && (desc.includes("제출") || desc.includes("상신")))) &&
      !desc.includes("보관함") &&
      !desc.includes("기록물철") &&
      !desc.includes("결재선") &&
      !desc.includes("결재작성") &&
      !desc.includes("결재 작성")
    ) {
      fallbackSelectors.push(
        "button._draftBtn:visible",
        "button._draft:visible",
        "button:has-text('결재상신'):visible",
        "button:has-text('상신'):visible",
        ".btn_toolbar button:has-text('상신'):visible"
      );
    }

    if (action.type === "click" && desc.includes("검색") && (desc.includes("버튼") || desc.includes("실행") || desc.includes("클릭"))) {
      const isFolderTreeSearch = desc.includes("문서함") || desc.includes("폴더") || desc.includes("트리") || desc.includes("사이드바");
      if (!isFolderTreeSearch) {
        fallbackSelectors.push(
          "button#atclList_srchBtn:visible",
          "button[id*='srchBtn']:visible",
          "button[id*='searchBtn']:visible",
          ".new_srch_bar button:visible",
          "#content .srch_input button:has(.ico_srch):visible",
          "#content .srch_input button[title='검색']:visible",
          "#content button[title='검색']:visible",
          "#content button.btn_srch:visible"
        );
      }
      fallbackSelectors.push(
        "#snb .srch_bar button.btn_srch:visible",
        "#snb .srch_bar button[title='검색']:visible",
        "#snb button.btn_srch:visible"
      );
    }

    if (action.type === "click" && (desc.includes("닫기") || desc.includes("취소"))) {
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

  // 5. Intelligent Drawer Unfolding (Self-Healing ONLY for Pure Menu Navigation in AI-generated plans!)
  // 🚨 CRITICAL: Never unfold all-menu drawer for Eyedropper actions or button clicks!
  const isInteractionAction =
    Boolean(action.recordedByEyedropper) ||
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
    !action.recordedByEyedropper &&
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

  // 6. Do NOT return an unverified non-visible locator from top-page (which breaks iframe scoping and masks missing elements).
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
  isTypeAction: boolean = false,
  desc: string = "",
  isEyedropper: boolean = false
): Promise<{ locator: Locator; box: { x: number; y: number; width: number; height: number } | null }> {
  await locator.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
  let box = await getSettledBoundingBox(locator, 1000);
  if (!box) {
    return { locator, box: null };
  }

  // Respect exact DOM element captured by Eyedropper for click actions — never substitute a child link/button!
  if (isEyedropper && !isTypeAction) {
    return { locator, box };
  }

  try {
    const isContainer = await locator.evaluate((node) => {
      const tag = node.tagName.toLowerCase();
      const rect = node.getBoundingClientRect();
      // Never drill down if this node itself is an editable surface (e.g. contenteditable title or BlockNote editor)
      if ((node as HTMLElement).isContentEditable) {
        return false;
      }
      // Never drill down inside genuine atomic interactive controls (a, button, input, textarea, select, label, [role='button'], [role='tab'])
      if (
        ["a", "button", "input", "textarea", "select", "label"].includes(tag) ||
        node.getAttribute("role") === "button" ||
        node.getAttribute("role") === "tab"
      ) {
        return false;
      }
      // Never drill down into random child buttons if this is an entire page/form layout wrapper
      if (tag === "article" || tag === "main" || tag === "aside" || (rect.width > 500 && rect.height > 250)) {
        return false;
      }
      if (
        node.classList.contains("sub_cover") ||
        node.classList.contains("Selected") ||
        node.classList.contains("select_Value") ||
        node.classList.contains("sp-replacer") ||
        node.classList.contains("app_work_box") ||
        !!node.closest("label.rdobtn, label.wiki_sub_box")
      ) {
        return false;
      }
      const isLarge = rect.width > 280 || rect.height > 80;
      const isWrapper = ["div", "form", "section", "li", "tr", "td", "p", "ul", "ol"].includes(tag);
      return isLarge || isWrapper;
    });

    if (isContainer) {
      const descLower = (desc || "").toLowerCase();
      const isCheckboxIntent = descLower.includes("체크") || descLower.includes("checkbox");
      const isNonButtonElementClick = !isTypeAction && !isCheckboxIntent && descLower.includes("요소 클릭");

      if (isNonButtonElementClick) {
        return { locator, box };
      }

      // Find candidate interactive leaf children inside the container
      const candidateQuery = isTypeAction
        ? "textarea:visible, input[type='text']:visible, input:not([type='button']):not([type='submit']):not([type='checkbox']):not([type='radio']):not([type='hidden']):visible, [contenteditable='true']:visible, [contenteditable='']:visible, .note-editable:visible, .ce-paragraph:visible, div[role='textbox']:visible, .editor_body:visible, p:visible"
        : isCheckboxIntent
        ? "input[type='checkbox']:visible, span.dynatree-checkbox:visible, label.chkbox:visible, .input_chk:visible, input:visible"
        : "button:not(.star_chk):not([class*='star']):not([class*='fav']):not(.btn_close):visible, a:not(.star_chk):not([class*='star']):not([class*='fav']):not(._hideHis):not(.btn_close):visible, .thmb:visible, .info:visible, .sub:visible, strong:visible, .fc-title:visible, .fc-event-title:visible, [class*='title']:visible, [class*='subject']:visible, input[type='button']:visible, input[type='submit']:visible, [role='button']:visible, input:visible, textarea:visible, select:visible, span.txt:visible, i.ico:visible";

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
  if (!fs.existsSync(authPath) || fs.statSync(authPath).size < 100) return false;

  // Quick sanity check: if auth.json only has unauthenticated initial cookies, it is NOT logged in
  try {
    const raw = JSON.parse(fs.readFileSync(authPath, "utf-8"));
    const cookies = raw.cookies || [];
    if (cookies.length === 0) {
      return false;
    }
  } catch {}

  console.log(`🔍 [세션 사전 검사] 저장된 인증 세션의 유효성을 백그라운드에서 검증합니다...`);
  let checkBrowser;
  try {
    checkBrowser = await chromium.launch({ headless: true });
    const checkContext = await checkBrowser.newContext({
      viewport,
      storageState: authPath,
    });
    const checkPage = await checkContext.newPage();

    let targetTestUrl = url;
    try {
      const parsed = new URL(url);
      if (parsed.pathname === "" || parsed.pathname === "/") {
        targetTestUrl = new URL("/ekp/main/home/homGwMain", url).toString();
      }
    } catch {}

    await checkPage.goto(targetTestUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    // Brief sleep to catch client-side URL redirects (e.g. location.href = '/login')
    await checkPage.waitForTimeout(2000);

    const currentUrl = checkPage.url().toLowerCase();

    // 1. URL pattern check for login/auth redirects
    const isLoginUrl =
      currentUrl.includes("/login") ||
      currentUrl.includes("signin") ||
      currentUrl.includes("userlogin") ||
      currentUrl.includes("sso") ||
      currentUrl.includes("/auth");

    // 2. Visible password or user input form check
    const hasPasswordInput = (await checkPage.locator('input[type="password"]:visible').count().catch(() => 0)) > 0;
    const hasLoginForm = (await checkPage.locator('form#loginForm, .login_box, input#userId:visible').count().catch(() => 0)) > 0;

    // 3. Positive login indicator (GNB menu, logout button, portal frame)
    const hasGnbOrPortal =
      (await checkPage
        .locator('#svc_lst, .user_info, button:has-text("로그아웃"), a:has-text("로그아웃"), #header, .portal_wrap, .user_name')
        .count().catch(() => 0)) > 0;

    const isMainPortalUrl =
      currentUrl.includes("/main/") ||
      currentUrl.includes("/portal/") ||
      currentUrl.includes("/home");

    await checkBrowser.close();

    if (isLoginUrl || hasPasswordInput || hasLoginForm) {
      console.log(`⚠️ [세션 만료 감지] 로그인 입력창 또는 로그인 페이지(${currentUrl})로 리다이렉트되었습니다.`);
      return false;
    }

    if (hasGnbOrPortal || isMainPortalUrl) {
      console.log(`✅ [세션 검증 성공] 로그인 세션이 유효합니다. (사용자 화면 정상 접근 확인)`);
      return true;
    }

    console.log(`⚠️ [세션 미확인] 포탈 메인 화면 및 로그인 인디케이터가 확인되지 않았습니다.`);
    return false;
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
 * Checks whether an action is optional / conditional (e.g. '존재 시', '표시 시', '노출 시', '선택적', outro confirmation).
 * Optional actions should never fail the entire recording or trigger destructive full-page reloads.
 */
export function isOptionalAction(action: BrowsePlanAction, momentId?: number, totalActions?: number): boolean {
  if (action.optional === true) return true;
  if (action.recordedByEyedropper) return false;
  if (momentId !== undefined && totalActions !== undefined && momentId >= totalActions - 2) {
    const descLower = (action.description || "").toLowerCase();
    if (descLower.includes("닫기") || descLower.includes("종료") || descLower.includes("아웃트로") || descLower.includes("확인")) {
      return true;
    }
  }
  const desc = (action.description || "").toLowerCase();
  return (
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
    desc.includes("선택 단계") ||
    desc.includes("(선택)") ||
    desc.includes("(옵션)") ||
    desc.includes("경우에만")
  );
}

/**
 * Determines if an action is an essential, core step that CANNOT be skipped.
 * Critical actions:
 * - Save / Submit / Finalize buttons (저장, 상신, 등록 버튼, 발행, 완료)
 * - Primary Title / Subject input (제목, subject, title)
 * - Primary Content / Body input (본문, 내용, editor, cn)
 * - Primary Module Navigation (포탈 전체메뉴, btn_svc_open)
 * - Mandatory Form Container Selection (문서함 선택, 캘린더 선택, 게시판 선택, 양식 선택)
 */
export function isCriticalAction(action: BrowsePlanAction): boolean {
  if (action.optional === true) return false;
  // Hover is never a hard blocker (purely cosmetic / motion transition)
  if (action.type === "hover") return false;
  // Every non-hover action explicitly recorded by the user via Eyedropper is critical!
  if (action.recordedByEyedropper) return true;

  const desc = (action.description || "").toLowerCase();
  const sel = (action.selector || "").toLowerCase();

  // Completion confirm/alert popups are already handled by dialog listeners or pre/post handlers
  if (desc.includes("완료 확인") || desc.includes("알림 팝업") || desc.includes("확인 알림") || desc.includes("완료 알림")) {
    return false;
  }

  // 1. Submit / Save buttons
  if (
    desc.includes("저장") ||
    desc.includes("상신") ||
    desc.includes("등록 버튼") ||
    desc.includes("발행") ||
    desc.includes("완료") ||
    sel.includes("savebtn") ||
    sel.includes("btn_save") ||
    sel.includes("btn_submit") ||
    sel.includes("_draftbtn") ||
    sel.includes("_draft") ||
    sel.includes("_confirmbtn") ||
    sel.includes("workwritebtn") ||
    sel.includes("reg_shedule")
  ) {
    return true;
  }

  // 2. Primary Title / Subject input
  if (
    (desc.includes("제목") || sel.includes("subject") || sel.includes("title")) &&
    (action.type === "type" || desc.includes("입력") || desc.includes("작성") || desc.includes("클릭"))
  ) {
    return true;
  }

  // 3. Primary Body / Content input
  if (
    (desc.includes("본문") || desc.includes("내용") || sel.includes("editor") || sel.includes("cn") || sel.includes("content")) &&
    (action.type === "type" || desc.includes("입력") || desc.includes("작성") || desc.includes("클릭"))
  ) {
    return true;
  }

  // 4. Primary Module Navigation (Drawer)
  if (desc.includes("전체메뉴") || sel.includes("btn_svc_open") || desc.includes("포탈 전체메뉴")) {
    return true;
  }

  // 5. Container / Folder Selection in Modal
  if (
    (desc.includes("문서함") || desc.includes("게시판") || desc.includes("캘린더") || desc.includes("폴더") || desc.includes("양식")) &&
    (desc.includes("선택") || desc.includes("클릭") || desc.includes("지정"))
  ) {
    return true;
  }

  // 6. Structured Search, Drag & Drop, and Approval Line Actions (Three Golden Canons)
  if (
    action.type === "dragAndDrop" ||
    desc.includes("검색") ||
    desc.includes("조회") ||
    desc.includes("드래그") ||
    desc.includes("결재선") ||
    desc.includes("합의") ||
    desc.includes("돋보기")
  ) {
    return true;
  }

  return false;
}

/**
 * Detects whether an action represents a non-essential sub-option or cosmetic field
 * (e.g. 보존기간, 공개범위, 태그, 개요, 설명, 상세옵션, 알림, 첨부파일, 장소 등)
 * which frequently does not exist or is folded in modern enterprise web forms.
 */
export function isNonCriticalSubOption(action: BrowsePlanAction): boolean {
  if (action.recordedByEyedropper) return false;
  const desc = (action.description || "").toLowerCase();
  const sel = (action.selector || "").toLowerCase();

  const subOptionKeywords = [
    "보존기간",
    "보존 기간",
    "보존연한",
    "공개범위",
    "공개 범위",
    "공개여부",
    "공개 여부",
    "태그",
    "tag",
    "키워드",
    "keyword",
    "개요",
    "상세 옵션",
    "상세옵션",
    "상세 설정",
    "상세설정",
    "추가 옵션",
    "추가옵션",
    "부가 옵션",
    "부가옵션",
    "알림 설정",
    "알림",
    "중요도",
    "우선순위",
    "장소",
    "종일",
    "체크박스",
    "첨부",
    "파일첨부",
    "설명 입력",
  ];

  return subOptionKeywords.some((kw) => desc.includes(kw) || sel.includes(kw));
}

/**
 * Determines whether a failed action can be safely skipped without crashing the recording.
 */
export function canSafelySkipFailedAction(
  action: BrowsePlanAction,
  momentId?: number,
  totalActions?: number,
  selfHealReason?: string
): boolean {
  if (action.recordedByEyedropper && action.optional !== true) {
    return action.type === "hover";
  }

  if (isCriticalAction(action)) {
    // If it's near outro (last 2 actions), allow skipping even if it looks critical (like an extra confirm)
    if (momentId !== undefined && totalActions !== undefined && momentId >= totalActions - 1) {
      return true;
    }
    return false;
  }

  if (isOptionalAction(action, momentId, totalActions)) {
    return true;
  }

  if (isNonCriticalSubOption(action)) {
    return true;
  }

  // AI가 명시적으로 "선택적 옵션이므로 생략 가능"이라고 보고한 경우에만 스킵 허용 (찾을 수 없음/Fail-Fast는 실패이지 스킵이 아님!)
  if (selfHealReason) {
    const r = selfHealReason.toLowerCase();
    if (r.includes("선택적 옵션") || r.includes("비필수 옵션") || r.includes("생략 가능")) {
      return true;
    }
  }

  if (momentId !== undefined && totalActions !== undefined && momentId >= totalActions - 2) {
    return true;
  }

  return false;
}

/**
 * Marks a failed non-critical action and its subsequent wait step for permanent deletion from browse-plan.json.
 */
function markActionAndFollowupWaitForPruning(plan: BrowsePlan, actionIdx: number, action: BrowsePlanAction): void {
  (action as any)._wasSkipped = true;
  if (action.recordedByEyedropper || plan.recordedByEyedropper) {
    return;
  }
  (action as any)._shouldPrune = true;
  if (actionIdx + 1 < plan.actions.length && plan.actions[actionIdx + 1].type === "wait") {
    (plan.actions[actionIdx + 1] as any)._shouldPrune = true;
  }
}

/**
 * Executes dynamically injected prerequisite actions (from INSERT_BEFORE / REPLACE_STEPS)
 * directly on the live page during Pass 1 and records their visual moments.
 */
async function executeInjectedActionsOnPage(
  page: Page,
  injectedActions: BrowsePlanAction[],
  moments: any[],
  startTime: number,
  plan: BrowsePlan
): Promise<void> {
  for (const subAct of injectedActions) {
    try {
      if (subAct.type === "wait") {
        const ms = subAct.ms ?? 1000;
        console.log(`     ⏳ [삽입 단계 실행 - 대기] ${subAct.description || `${ms}ms 대기`}`);
        await page.waitForTimeout(ms);
        continue;
      }

      if (subAct.type === "hover" || subAct.type === "click" || subAct.type === "dblclick" || subAct.type === "type") {
        console.log(
          `     ⚡ [삽입 단계 실행 - ${subAct.type}] "${subAct.description || subAct.selector}" (${subAct.selector})`
        );
        const loc = await getLocator(page, subAct);
        if (!loc) continue;
        await loc.waitFor({ state: "visible", timeout: 4500 }).catch(() => {});
        const { locator: targetEl, box } =
          subAct.type === "hover"
            ? { locator: loc, box: await getSettledBoundingBox(loc, 800) }
            : await resolveAtomicTarget(loc, subAct.type === "type", subAct.description);

        const ts = Date.now() - startTime;
        if (box) {
          const cx = Math.round(box.x + box.width / 2);
          const cy = Math.round(box.y + box.height / 2);
          if (subAct.type !== "hover") {
            triggerClickVisualizer(page, cx, cy).catch(() => {});
          }
          moments.push({
            id: moments.length + 1,
            timestamp: ts,
            type: subAct.type,
            selector: subAct.selector,
            description: subAct.description || "선행 보정 액션",
            cursor: { x: cx, y: cy },
            target: {
              x: Math.round(Math.max(0, box.x)),
              y: Math.round(Math.max(0, box.y)),
              width: Math.round(box.width),
              height: Math.round(box.height),
            },
          });
        }

        if (subAct.type === "hover") {
          if (box) {
            await page.mouse.move(Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2)).catch(() => {});
          }
          await targetEl.hover({ timeout: 2000, force: true }).catch(() => {});
        } else if (subAct.type === "type") {
          await targetEl.click({ timeout: 2500, force: true }).catch(() => {});
          await targetEl.fill(subAct.text || "").catch(() => {});
        } else if (subAct.type === "dblclick") {
          await targetEl.dblclick({ timeout: 2500, force: true }).catch(() => {});
        } else {
          await targetEl.click({ timeout: 2500, force: true }).catch(() => {});
        }
        await page.waitForTimeout(subAct.ms ?? (subAct.type === "hover" ? 600 : 1000));
      }
    } catch (subErr: any) {
      console.warn(`     ⚠️ [삽입 단계 실행 경고] ${subAct.description}: ${subErr.message}`);
    }
  }
}

/**
 * Invokes the AI Runtime Self-Healing & Scenario Adjustment Agent to inspect the live screen + DOM + Scenario Timeline,
 * dynamically adjusts the scenario (PATCH_SELECTOR, INSERT_BEFORE, REPLACE_STEPS, SKIP_AND_PRUNE),
 * persists the updated scenario to browse-plan.json, and returns the healed locator.
 */
async function trySelfHealAction(
  moments: any[],
  startTime: number,
  page: Page,
  action: BrowsePlanAction,
  momentId: number,
  plan: BrowsePlan,
  dataDir: string
): Promise<Locator | null> {
  console.log(
    `\n  [⚠️ 요소 탐색 실패] 액션 #${momentId}: "${action.description}" (기존 셀렉터: ${action.selector || action.sourceSelector || "없음"})`
  );

  if (isOptionalAction(action, momentId, plan.actions.length)) {
    const descLower = (action.description || "").toLowerCase();
    if (descLower.includes("닫기") || descLower.includes("종료") || descLower.includes("아웃트로")) {
      console.log(`  [✨ 아웃트로 예외 허용] 불필요한 닫기 액션에 대한 자가 치유를 생략하고 즉시 종료를 유도합니다.`);
      return null;
    }
  }

  // Check if a blocking modal or alert is obstructing the target element before asking AI
  const recoveredModal = await autoRecoverActiveModals(page, action, moments, startTime);
  if (recoveredModal) {
    const unblockedLoc = await getLocator(page, action);
    if (unblockedLoc && (await unblockedLoc.isVisible().catch(() => false))) {
      totalHealedCount++;
      console.log(`  [✨ 팝업 자가 복구 성공] 차단 팝업을 성공적으로 해제하여 요소 '${action.selector}' 탐색을 완료했습니다!`);
      return unblockedLoc;
    }
  }

  // For Eyedropper recordings, give slow AJAX lists/modals an extra settle retry before self-healing,
  // and NEVER clear search inputs or overwrite browse-plan.json with a random 1st DB card!
  if (action.recordedByEyedropper || plan.recordedByEyedropper) {
    await page.waitForTimeout(900);
    const delayedLoc = await getLocator(page, action);
    if (delayedLoc && (await delayedLoc.isVisible().catch(() => false))) {
      console.log(`  [✨ 지연 렌더링 요소 확인] 비동기 로딩 대기 후 원본 요소 '${action.selector}' 탐색을 완료했습니다.`);
      return delayedLoc;
    }
  }

  // 🩺 On-Demand Real-Time DB Scraping Fallback (AI-generated plans ONLY — never mutate Eyedropper plans!)
  if (!action.recordedByEyedropper && !plan.recordedByEyedropper && (action.type === "hover" || action.type === "click")) {
    const selStr = action.selector || "";
    const descStr = action.description || "";
    const isWorkCardTarget =
      selStr.includes("aw_li") ||
      selStr.includes("app_work_box") ||
      (selStr.includes("btn_write") &&
        (selStr.includes("aw_li") || selStr.includes("app_work_box") || selStr.includes("WorkSelect") || descStr.includes("결재"))) ||
      descStr.includes("양식 카드");
    const isListSearchResultTarget =
      !isWorkCardTarget &&
      (descStr.includes("검색된") || descStr.includes("검색 결과") || (descStr.includes("결과") && descStr.includes("항목")));

    if (isWorkCardTarget) {
      try {
        // If a search filter left 0 matching cards, clear the search input to restore available DB cards
        const srchInput = page
          .locator("input#gapWorkSelect_searchWord:visible, input#eapWorkSelect_searchWord:visible, input[id*='searchWord']:visible")
          .first();
        if (await srchInput.isVisible().catch(() => false)) {
          const curVal = await srchInput.inputValue().catch(() => "");
          if (curVal && curVal.trim().length > 0) {
            console.log(
              `  [🩺 자가복구 검색 필터 초기화] 검색어("${curVal}")에 일치하는 양식이 DB에 없어 검색 필터를 초기화하고 가용 양식을 탐색합니다.`
            );
            await srchInput.fill("").catch(() => {});
            await srchInput.press("Enter").catch(() => {});
            await page.waitForTimeout(700);
          }
        }

        const firstCardTitLoc = page
          .locator("ul.aw_ul li.aw_li:visible .tit_box strong.tit, ul.aw_ul li.aw_li:visible strong.tit, ul.aw_ul li.aw_li:visible .tit")
          .first();
        if (await firstCardTitLoc.isVisible().catch(() => false)) {
          const liveCardTitle = ((await firstCardTitLoc.innerText().catch(() => "")) || "").trim();
          if (liveCardTitle) {
            console.log(
              `  [📋 자가복구 DB 데이터 스크래핑 성공] 지정한 양식 대신 현재 DB의 가용 양식("${liveCardTitle}")으로 자동 전환하여 복구합니다!`
            );
            currentRuntimeVariables.set("lastSearchKeyword", liveCardTitle);

            // Link subsequent card hover/click actions to this recovered DB card
            for (let k = momentId; k < plan.actions.length; k++) {
              const fAct = plan.actions[k];
              const fSel = fAct.selector || "";
              const fDesc = fAct.description || "";
              if (fSel.includes("aw_li") || fSel.includes("app_work_box") || fDesc.includes("양식 카드")) {
                if (fAct.type === "hover") {
                  fAct.selector = `ul.aw_ul li.aw_li:has-text('${liveCardTitle}') .app_work_box:visible, li.aw_li:has-text('${liveCardTitle}'):visible`;
                } else if (fAct.type === "click" && fSel.includes("btn_write")) {
                  fAct.selector = `ul.aw_ul li.aw_li:has-text('${liveCardTitle}') button.btn_write:visible, li.aw_li:has-text('${liveCardTitle}') button.btn.btn_write:visible`;
                }
                if (fAct.description) {
                  fAct.description = fAct.description.replace(/'[^']+'/, `'${liveCardTitle}'`);
                }
              }
            }

            const cardBoxLoc = page
              .locator(`ul.aw_ul li.aw_li:has-text('${liveCardTitle}') .app_work_box:visible, ul.aw_ul li.aw_li:visible .app_work_box:visible`)
              .first();
            if (action.type === "hover") {
              if (await cardBoxLoc.isVisible().catch(() => false)) {
                action.selector = `ul.aw_ul li.aw_li:has-text('${liveCardTitle}') .app_work_box:visible, li.aw_li:has-text('${liveCardTitle}'):visible`;
                totalHealedCount++;
                saveHealedPlan(dataDir, plan);
                return cardBoxLoc;
              }
            } else if (action.type === "click") {
              if (await cardBoxLoc.isVisible().catch(() => false)) {
                await cardBoxLoc.scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => {});
                await cardBoxLoc.hover({ timeout: 1500, force: true }).catch(() => {});
                await page.waitForTimeout(450);
              }
              const cardBtnLoc = page
                .locator(`ul.aw_ul li.aw_li:has-text('${liveCardTitle}') button.btn_write:visible, ul.aw_ul li.aw_li:visible button.btn_write:visible`)
                .first();
              if (await cardBtnLoc.isVisible().catch(() => false)) {
                action.selector = `ul.aw_ul li.aw_li:has-text('${liveCardTitle}') button.btn_write:visible, li.aw_li:has-text('${liveCardTitle}') button.btn.btn_write:visible`;
                totalHealedCount++;
                saveHealedPlan(dataDir, plan);
                return cardBtnLoc;
              }
            }
          }
        }
      } catch {}
    } else if (isListSearchResultTarget) {
      try {
        const liveItemText = await scrapeLiveText(page, action);
        if (liveItemText) {
          console.log(
            `  [📋 자가복구 DB 데이터 스크래핑 성공] 검색 대상이 DB에 없어 현재 화면 목록의 실제 데이터("${liveItemText}")로 자동 복구합니다!`
          );
          const itemLoc = page.locator(`a:has-text('${liveItemText}'):visible`).first();
          if (await itemLoc.isVisible().catch(() => false)) {
            action.selector = `a:has-text('${liveItemText}'):visible`;
            totalHealedCount++;
            saveHealedPlan(dataDir, plan);
            return itemLoc;
          }
        }
      } catch {}
    }
  }

  console.log(`  [🤖 AI 실시간 자가 치유 가동] 실시간 화면 스크린샷, DOM 후보군, 전후 시나리오 맥락을 정밀 분석 중...`);
  let healResult = await selfHealElement(page, action, momentId, plan.actions.length, dataDir, plan);
  if (healResult?.reason) {
    (action as any)._lastHealReason = healResult.reason;
  }

  // 1. Handle AI-driven SKIP_AND_PRUNE (Step already completed or redundant)
  if (healResult?.success && healResult.resolutionType === "SKIP_AND_PRUNE") {
    totalHealedCount++;
    (action as any)._wasSkipped = true;
    (action as any)._shouldPrune = true;
    const actIdx = plan.actions.indexOf(action);
    if (actIdx !== -1 && actIdx + 1 < plan.actions.length - 1 && plan.actions[actIdx + 1]?.type === "wait") {
      (plan.actions[actIdx + 1] as any)._shouldPrune = true;
    }
    saveHealedPlan(dataDir, plan);
    console.log(
      `  [✂️ AI 시나리오 동적 조정 (SKIP_AND_PRUNE)] "${action.description}" 단계는 이미 통과했거나 불필요하여 시나리오에서 제거합니다. (사유: ${healResult.reason})`
    );
    return null;
  }

  // 2. Handle explicit optional / non-critical step skip
  const isOptional = isOptionalAction(action, momentId, plan.actions.length);
  const canSkip = canSafelySkipFailedAction(action, momentId, plan.actions.length, healResult?.reason);

  if ((isOptional || canSkip) && !isCriticalAction(action) && (!healResult || !healResult.success)) {
    (action as any)._wasSkipped = true;
    (action as any)._shouldPrune = true;
    saveHealedPlan(dataDir, plan);
    console.log(`  [✨ 비필수 단계 안전 스킵] 해당 단계("${action.description}")는 비필수 부가 옵션이므로 건너뛰고 다음 단계로 진행합니다.`);
    return null;
  }

  // 3. Handle INSERT_BEFORE (Missing prerequisite steps injected before current step)
  if (
    healResult?.success &&
    healResult.resolutionType === "INSERT_BEFORE" &&
    Array.isArray(healResult.prerequisiteActions) &&
    healResult.prerequisiteActions.length > 0
  ) {
    totalHealedCount++;
    console.log(
      `  [➕ AI 시나리오 동적 조정 (INSERT_BEFORE)] 누락된 선행 단계 ${healResult.prerequisiteActions.length}개를 먼저 실행하고 시나리오에 영구 삽입합니다!`
    );
    (action as any)._insertBefore = [
      ...((action as any)._insertBefore || []),
      ...healResult.prerequisiteActions,
    ];
    if (healResult.selector) {
      action.selector = healResult.selector;
    }
    if (healResult.sourceSelector) {
      action.sourceSelector = healResult.sourceSelector;
    }
    if (healResult.targetSelector) {
      action.targetSelector = healResult.targetSelector;
    }
    if (healResult.iframe !== undefined) {
      action.iframe = healResult.iframe || undefined;
    }

    await executeInjectedActionsOnPage(page, healResult.prerequisiteActions, moments, startTime, plan);
    saveHealedPlan(dataDir, plan);

    const afterInsertLoc = await getLocator(page, action);
    if (afterInsertLoc) {
      if (await afterInsertLoc.isVisible().catch(() => false)) {
        return afterInsertLoc;
      }
      try {
        await afterInsertLoc.waitFor({ state: "visible", timeout: 4000 });
        return afterInsertLoc;
      } catch {}
    }

    // Re-run self-heal once on the newly opened screen if selector still needs refinement
    console.log(`  [🤖 선행 단계 실행 완료 후 본 단계 타겟 재탐색] 새로 열린 화면에서 '${action.description}' 요소를 확정합니다...`);
    healResult = await selfHealElement(page, action, momentId, plan.actions.length, dataDir, plan);
  }

  // 4. Handle REPLACE_STEPS (Current coarse step decomposed into multiple steps)
  if (
    healResult?.success &&
    healResult.resolutionType === "REPLACE_STEPS" &&
    Array.isArray(healResult.replacementActions) &&
    healResult.replacementActions.length > 0
  ) {
    totalHealedCount++;
    console.log(
      `  [🔄 AI 시나리오 동적 조정 (REPLACE_STEPS)] 현재 단계를 ${healResult.replacementActions.length}개의 세부 단계로 분할 교체합니다!`
    );
    (action as any)._replaceWith = healResult.replacementActions;

    // Execute all replacement steps except the last interactive step (or all if types differ), then return locator for the last step
    const reps = healResult.replacementActions;
    const lastRep = reps[reps.length - 1];
    const leadingReps = reps.slice(0, reps.length - 1);

    if (leadingReps.length > 0) {
      await executeInjectedActionsOnPage(page, leadingReps, moments, startTime, plan);
    }

    if (lastRep && lastRep.selector) {
      action.selector = lastRep.selector;
      if (lastRep.description) action.description = lastRep.description;
      if (lastRep.text) action.text = lastRep.text;
      if (lastRep.iframe) action.iframe = lastRep.iframe;
    }
    saveHealedPlan(dataDir, plan);

    const repLoc = await getLocator(page, action);
    if (repLoc && (await repLoc.isVisible().catch(() => false))) {
      return repLoc;
    }
  }

  // 폼 작성 중이거나 모달이 떠 있을 때는 전체 새로고침 절대 금지 (작성 중인 폼/세션 파괴 방지)
  const hasActiveModal = (await page.locator(".ui-dialog:visible, .modal:visible, [role='dialog']:visible").count().catch(() => 0)) > 0;
  const isFormAction =
    action.type === "type" ||
    Boolean(
      action.description &&
      (action.description.includes("입력") ||
       action.description.includes("작성") ||
       action.description.includes("옵션") ||
       action.description.includes("설정") ||
       action.description.includes("제목") ||
       action.description.includes("본문") ||
       action.description.includes("내용"))
    );

  // 비동기 렌더링/UI 동기화 문제(새로고침해야만 데이터가 나오는 경우)를 대응하기 위한 1회 재시도 (Reload & Retry)
  // 단, 결과 확인(Phase 5) 목록/조회 단계에서만 제한적으로 허용
  const isOutcomePhase = momentId >= plan.actions.length - 4;
  if (!isFormAction && !hasActiveModal && isOutcomePhase && (!healResult || !healResult.success) && !(action as any)._hasReloadRetried) {
    console.log(`  🔄 [비동기 UI 동기화] 결과 목록 갱신 지연 감지. 화면 강제 새로고침 후 1회 재시도합니다...`);
    (action as any)._hasReloadRetried = true;
    try {
      const refreshBtn = page.locator(".btn_rfsh, .btn_refresh, .ico_rfsh, button:has-text('새로고침'), [title*='새로고침']").first();
      if (await refreshBtn.isVisible({ timeout: 1000 })) {
        console.log(`  🔄 [비동기 UI 동기화] 새로고침 버튼 클릭 (Safe Refresh)`);
        await refreshBtn.click();
      } else {
        const contentFrame = page.frames().find(f => f.name() === 'contentFrame' || f.name() === 'subBody' || f.url().includes('schedule') || f.url().includes('list'));
        if (contentFrame) {
          console.log(`  🔄 [비동기 UI 동기화] 메인 컨텐츠 IFrame 새로고침 (이름: ${contentFrame.name() || 'unknown'})`);
          await contentFrame.evaluate(() => window.location.reload());
        } else {
          console.log(`  🔄 [비동기 UI 동기화] 전체 페이지 강제 새로고침 (page.reload)`);
          await page.reload({ waitUntil: "domcontentloaded", timeout: 15000 });
        }
      }
      await page.waitForTimeout(4000);
      
      console.log(`  [🤖 AI 실시간 자가 치유 2차 가동] 새로고침 후 다시 스크린샷 분석 중...`);
      healResult = await selfHealElement(page, action, momentId, plan.actions.length, dataDir, plan);
      if (healResult?.reason) {
        (action as any)._lastHealReason = healResult.reason;
      }
    } catch (reloadErr: any) {
      console.warn(`  ⚠️ 화면 새로고침 중 오류 발생: ${reloadErr.message}`);
    }
  }

  if (healResult && healResult.success && (healResult.selector || healResult.sourceSelector || healResult.targetSelector)) {
    totalHealedCount++;
    console.log(`  [✨ AI 자가 치유 성공 (${healResult.resolutionType || "PATCH_SELECTOR"})] 자동 교정 완료! (누적 치유: ${totalHealedCount}건)`);
    if (healResult.selector) {
      console.log(`     ➡️ 복구된 셀렉터: ${healResult.selector}`);
      action.selector = healResult.selector;
    }
    if (healResult.sourceSelector) {
      console.log(`     ➡️ 복구된 드래그 시작 셀렉터: ${healResult.sourceSelector}`);
      action.sourceSelector = healResult.sourceSelector;
    }
    if (healResult.targetSelector) {
      console.log(`     ➡️ 복구된 드래그 도착 셀렉터: ${healResult.targetSelector}`);
      action.targetSelector = healResult.targetSelector;
    }
    if (healResult.iframe) {
      console.log(`     ➡️ iframe 스코프: ${healResult.iframe}`);
      action.iframe = healResult.iframe;
    }
    console.log(`     💡 AI 판단 사유: ${healResult.reason}`);

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
    if (canSafelySkipFailedAction(action, momentId, plan.actions.length, healResult.reason)) {
      (action as any)._wasSkipped = true;
      (action as any)._shouldPrune = true;
      saveHealedPlan(dataDir, plan);
      console.log(`  [✨ 비필수 단계 안전 스킵] 해당 단계("${action.description}")는 비필수 부가 옵션이므로 건너뛰고 다음 필수 단계로 진행합니다.`);
    }
    return null;
  }

  console.warn(`  [AI 자가 치유 미완료] 현재 화면에서 적합한 요소를 확정하지 못했습니다.`);
  if (canSafelySkipFailedAction(action, momentId, plan.actions.length)) {
    (action as any)._wasSkipped = true;
    (action as any)._shouldPrune = true;
    saveHealedPlan(dataDir, plan);
    console.log(`  [✨ 비필수 단계 안전 스킵] 해당 단계("${action.description}")는 비필수 부가 옵션이므로 건너뛰고 다음 필수 단계로 진행합니다.`);
  }
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

    // 1. Trigger tree expansion via button and Dynatree/Fancytree API (strictly inside topmost modal!)
    const topDialog = page.locator(".ui-dialog:visible, .modal:visible, [role='dialog']:visible").last();
    const expandBtn = topDialog.locator("#docSelect_expandTree, #eapBinderSelect_expandTree, .btn_fopn, button:has-text('모두펼침'), .dynatree-expander").first();
    if (await expandBtn.isVisible().catch(() => false)) {
      await expandBtn.click({ force: true }).catch(() => {});
    }

    await page.evaluate(() => {
      try {
        const win = window as any;
        const dialogs = Array.from(document.querySelectorAll(".ui-dialog, .modal, [role='dialog']")).filter((d) => {
          const r = d.getBoundingClientRect();
          const s = window.getComputedStyle(d);
          return r.width > 100 && r.height > 60 && s.display !== "none" && s.visibility !== "hidden";
        });
        const topModal = dialogs[dialogs.length - 1];
        if (!topModal) return;

        if (win.DocSelect && win.DocSelect.tree) {
          win.DocSelect.tree.expandTree();
        }
        if (win.EapBinderSelect && win.EapBinderSelect.tree) {
          try { win.EapBinderSelect.tree.expandTree(); } catch {}
        }
        if (win.$ && topModal) {
          // Strictly find tree inside topModal only - NEVER search window globally!
          const treeEls = win.$(topModal).find(".dynatree-container, [id*='treeBox'], [id*='Tree']");
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
    const childBoardLoc = topDialog.locator(
      ".dynatree-container .dynatree-node:not(.dynatree-folder) a.dynatree-title:visible, .dynatree-container li:not(:has(ul)) a.dynatree-title:visible, .dynatree-container li:last-child a.dynatree-title:visible, [id*='treeBox'] .dynatree-node:not(.dynatree-folder) a.dynatree-title:visible, .dynatree-container a.dynatree-title:visible"
    ).first();

    await childBoardLoc.waitFor({ state: "visible", timeout: 4000 }).catch(() => {});

    // 3. Activate in tree data model directly to guarantee writable leaf node is selected
    const activatedData = await page.evaluate(() => {
      try {
        const win = window as any;
        const dialogs = Array.from(document.querySelectorAll(".ui-dialog, .modal, [role='dialog']")).filter((d) => {
          const r = d.getBoundingClientRect();
          const s = window.getComputedStyle(d);
          return r.width > 100 && r.height > 60 && s.display !== "none" && s.visibility !== "hidden";
        });
        const topModal = dialogs[dialogs.length - 1];
        if (!topModal) return { success: false };

        let targetNode: any = null;
        if (win.$) {
          // Strictly limit to treeEls inside topModal!
          const treeEls = win.$(topModal).find(".dynatree-container, [id*='treeBox'], [id*='Tree']");
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
          if (typeof targetNode.select === "function") {
            try { targetNode.select(true); } catch {}
          }
          return { success: true, title: targetNode.data.title, key: targetNode.data.key };
        }
      } catch {}
      return { success: false };
    });

    if (activatedData && activatedData.success) {
      console.log(`  [✨ 실제 등록 가능 리프 노드 활성화] "${activatedData.title}" (key: ${activatedData.key}) 선택 완료`);
    }

    // 4. Also physically click the DOM element so cursor coordinates and visual highlight are recorded
    const checkboxLoc = topDialog.locator(".dynatree-checkbox:visible").first();
    if (await checkboxLoc.isVisible().catch(() => false)) {
      await checkboxLoc.click({ force: true }).catch(() => {});
      await page.waitForTimeout(500);
      return { success: true, title: activatedData?.title };
    }

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
      ".ui-dialog:visible .ui-dialog-buttonpane button:has-text('확인'):visible, .ui-dialog:visible button.btn_pri:has-text('확인'):visible, .ui-dialog:visible button:has-text('확인'):visible, #docSelect_confirm:visible, #eapBinderSelect_confirm:visible, button._confirm:visible"
    ).first();
    if (await confirmBtn.isVisible().catch(() => false)) {
      console.log(`  [🔘 확인 버튼 클릭] 팝업 확인 버튼 클릭하여 모달 닫기`);
      await confirmBtn.click({ force: true }).catch(() => {});
      await page.waitForTimeout(800);
    }

    // 3. Dismiss any unexpected system alert layer (strictly excluding main form .ui-dialog which may have buttons like '사용자 일정확인')
    const alertBtn = page.locator(
      "#alert_lyr:visible button:has-text('확인'):visible, button#naon-cmm-alert-confirm:visible, .ui-dialog.alert_dialog:visible button:text-is('확인'):visible"
    ).first();
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
          if (win.EapBinderSelect && win.EapBinderSelect.fn) {
            try { win.EapBinderSelect.fn.confirm(); } catch {}
          }
        } catch {}
      });
    }

    // 4. Wait for tree modal to disappear
    await page.locator(".ui-dialog:visible:has(.dynatree-container)").waitFor({ state: "hidden", timeout: 4000 }).catch(() => {});
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
async function autoRecoverActiveModals(page: Page, action: BrowsePlanAction, moments: any[], startTime: number): Promise<boolean> {
  // If current action is wait or recorded by Eyedropper, do NOT autonomously close/submit modals!
  if (action.type === 'wait' || action.recordedByEyedropper) return false;

  try {
    const desc = (action.description || "").toLowerCase();
    const sel = (action.selector || "").toLowerCase();

    // If the action is explicitly interacting with or confirming a modal, DO NOT auto-close it!
    const isActionForModal =
      desc.includes("선택 팝업") ||
      desc.includes("팝업 확인") ||
      desc.includes("다이얼로그") ||
      desc.includes("조직도") ||
      desc.includes("주소록") ||
      desc.includes("모달") ||
      desc.includes("팝업") ||
      desc.includes("사원") ||
      desc.includes("수신자") ||
      sel.includes(".ui-dialog") ||
      sel.includes("role='dialog'") ||
      sel.includes("confirm") ||
      sel.includes("org_") ||
      sel.includes("userList");

    if (isActionForModal) {
      return false;
    }

    // 1. Detect Alert/Notice modals ONLY (strictly excludes selection dialogs with dynatree/inputs or main registration forms)
    const isPureAlertModal = await page.evaluate(() => {
      const dialogs = Array.from(document.querySelectorAll(".ui-dialog, .modal, [role='dialog'], #alert_lyr")).filter((d) => {
        const r = d.getBoundingClientRect();
        const s = window.getComputedStyle(d);
        return r.width > 100 && r.height > 60 && s.display !== "none" && s.visibility !== "hidden";
      });
      const top = dialogs[dialogs.length - 1];
      if (!top) return false;
      // If it contains a tree, form inputs, textareas, or form tables, it is a selection/registration dialog, NOT an alert!
      if (
        top.querySelector(
          ".dynatree-container, .fancytree-container, input[type='text'], input.input_txt, textarea, select, table.tbl_frm, #subject, #savebtn"
        )
      ) {
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
      const isSubmitAction = desc.includes("상신") || desc.includes("저장") || desc.includes("제출") || desc.includes("완료");

      if (isValidationError && isSubmitAction) {
        console.error(`\n  🚨 [치명적 폼 검증 에러 발생] 시스템 알림: "${txt}"`);
        await page.waitForTimeout(1000);
        throw new Error(`폼 유효성 검증 실패 (Validation Error): ${txt}`);
      }

      // If it's an alert or notice during intermediate steps, dismiss it via confirm button on topmost dialog!
      const topAlert = page.locator("#alert_lyr:visible, .ui-dialog:visible, .modal:visible").last();
      const confirmBtn = topAlert.locator(
        "button:text-is('확인'):visible, button.btn_pri:visible, button._confirmBtn:visible, button:has-text('확인'):not(#userScheduleCheckBtn):visible, .ui-dialog-buttonpane button:visible"
      ).first();
      if (await confirmBtn.isVisible().catch(() => false)) {
        console.log(`\n  [🤖 팝업 자가 복구] 차단 알림 팝업("${txt}") 감지 ➔ [확인] 버튼을 클릭하여 정상 진행합니다.`);
        await confirmBtn.click({ force: true }).catch(() => {});
        await page.waitForTimeout(800);
        return true;
      } else {
        await page.evaluate(() => {
          const dialogs = document.querySelectorAll(".ui-dialog, #alert_lyr, .ui-widget-overlay");
          if (dialogs.length > 0) dialogs[dialogs.length - 1].remove();
        }).catch(() => {});
        await page.waitForTimeout(400);
        return true;
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
      const title = (top.querySelector(".ui-dialog-title, .title, h3, h4")?.textContent || "").trim();
      const hasTree = Boolean(top.querySelector(".dynatree-container, .fancytree-container, [id*='treeBox']"));
      const isSelectionTitle = title.includes("선택") || title.includes("문서함") || title.includes("폴더") || title.includes("게시판");
      return hasTree && isSelectionTitle && !title.includes("권한") && !title.includes("조직도") && !title.includes("주소록");
    });

    // If the action is explicitly interacting with the modal, DO NOT auto-close it!
    if (isTreeSelectModal && isActionForModal) {
      return false;
    }

    const isPostModalAction =
      desc.includes("제목") ||
      desc.includes("본문") ||
      desc.includes("내용") ||
      desc.includes("저장") ||
      desc.includes("상신") ||
      desc.includes("등록 진행") ||
      desc.includes("공개");

    // ONLY auto-recover tree selection modal when the plan has moved on to filling form inputs (title, body)
    if (isTreeSelectModal && isPostModalAction) {
      console.log(`\n  [🤖 팝업 자가 복구] 화면을 가로막고 있는 선택 팝업을 감지했습니다.`);
      console.log(`     ➡️ 대상 리프 노드를 자동으로 선택하고 [확인]을 클릭하여 본문 등록 폼으로 진입합니다.`);
      await confirmTreeSelectionModal(page);
      return true;
    }

    // 3. 2-Tier Nested Picker Auto-Summoning:
    // If action wants to select a user/attendee or expand org tree, but we are inside an outer settings layer
    // that requires clicking [추가] or [조직도] to summon the actual picker:
    const isUserOrTreeIntent =
      desc.includes("사원") ||
      desc.includes("사용자") ||
      desc.includes("대상자") ||
      desc.includes("조직도") ||
      desc.includes("직원") ||
      desc.includes("부서") ||
      sel.includes("user_info") ||
      sel.includes("orgUser") ||
      sel.includes("user_card");

    if (isUserOrTreeIntent) {
      const hasInnerTrigger = (await page.locator(".ui-dialog:visible button:has-text('추가'):visible, .ui-dialog:visible button:has-text('조직도'):visible, .ui-dialog:visible button:has-text('주소록'):visible").count().catch(() => 0)) > 0;
      const hasUserListAlready = (await page.locator(".ui-dialog:visible label.user_info, .ui-dialog:visible .user_card, .ui-dialog:visible #orgUserList_listbox, .ui-dialog:visible .dynatree-container").count().catch(() => 0)) > 0;
      if (hasInnerTrigger && !hasUserListAlready) {
        console.log(`\n  [🤖 팝업 자가 복구] 설정 대화상자 내 하위 조직도/피커 호출 버튼 감지 ➔ [추가/조직도] 클릭하여 선택 팝업 오픈`);
        const innerTrigger = page.locator(".ui-dialog:visible button:has-text('추가'):visible, .ui-dialog:visible button:has-text('조직도'):visible, .ui-dialog:visible button:has-text('주소록'):visible").first();
        await innerTrigger.click().catch(() => {});
        await page.waitForTimeout(1500);
        return true;
      }
    }

    // 4. Outer Setting Layer Auto-Dismissal for Form Actions (Body, Save, Submit):
    // If the plan has returned to main form actions (writing body, clicking save) but an outer sub-modal is still open:
    const isMainFormAction =
      desc.includes("본문") ||
      desc.includes("내용") ||
      desc.includes("저장") ||
      desc.includes("상신") ||
      desc.includes("등록 진행");

    if (isMainFormAction) {
      const hasSubDialogBlockingMainForm = await page.evaluate(() => {
        const dialogs = Array.from(document.querySelectorAll(".ui-dialog, .modal, [role='dialog']")).filter((d) => {
          const r = d.getBoundingClientRect();
          const s = window.getComputedStyle(d);
          return r.width > 120 && r.height > 80 && s.display !== "none" && s.visibility !== "hidden";
        });
        const top = dialogs[dialogs.length - 1];
        if (!top) return false;
        // Never treat a main registration dialog (containing #subject, #savebtn, textarea#cn, etc.) as an auxiliary popup to auto-dismiss!
        if (top.querySelector("#subject, #savebtn, textarea#cn, #eapDocReg_docSubject, #atclReg_subject")) {
          return false;
        }
        return true;
      }).catch(() => false);

      if (hasSubDialogBlockingMainForm) {
        console.log(`\n  [🤖 팝업 자가 복구] 본문 작성/저장 진행 중 열려 있는 상위 설정 팝업 감지 ➔ [확인] 또는 [닫기] 버튼을 클릭하여 본문 복귀`);
        const topDialog = page.locator(".ui-dialog:visible, .modal:visible, [role='dialog']:visible").last();
        const confirmBtn = topDialog.locator(".ui-dialog-buttonpane button:has-text('확인'):not(#userScheduleCheckBtn):visible, button:text-is('확인'):visible, button._confirmBtn:visible, button.btn_pri:visible, button:has-text('확인'):not(#userScheduleCheckBtn):visible").first();
        if (await confirmBtn.isVisible().catch(() => false)) {
          await confirmBtn.click({ force: true }).catch(() => {});
          await page.waitForTimeout(1200);
          return true;
        }
        const closeBtn = topDialog.locator(".ui-dialog-titlebar-close:visible, button:has-text('닫기'):visible, button.close:visible, button.btn_close:visible").first();
        if (await closeBtn.isVisible().catch(() => false)) {
          console.log(`\n  [🤖 팝업 자가 복구] 확인 버튼 없음 ➔ [닫기/X] 버튼으로 차단 모달 닫기 수행`);
          await closeBtn.click().catch(() => {});
          await page.waitForTimeout(1200);
          return true;
        }
      }
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
  const slugArg = process.argv.slice(2).find((a) => a.startsWith("--slug="))?.split("=")[1] ||
    process.argv.slice(2).find((a) => !a.startsWith("-")) ||
    process.argv[2];
  const slug = (slugArg || "").replace(/^--slug=/, "").trim();
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
    fs.writeFileSync(planPath, JSON.stringify(plan, null, 2), "utf-8");
    console.log(`💾 [플랜 최적화 영구 저장] 정제된 플랜을 ${planPath}에 저장했습니다.`);
  }
  const videoDir = dataDir;

  const authPath = path.join(dataDir, "auth.json");
  const forceLogin = process.argv.includes("--login");
  const requiresLogin = plan.requiresLogin !== false || forceLogin;

  const isHeadless = process.argv.includes("--headless");
  const isHeaded = !isHeadless;

  // Auto-reuse existing auth session if available and not forced
  if (!fs.existsSync(authPath) && !forceLogin) {
    const existingCandidate = findExistingAuthSession(slug);
    if (existingCandidate && fs.existsSync(existingCandidate)) {
      console.log(`🔑 [세션 자동 연동] 기존 인증 세션(${path.basename(path.dirname(existingCandidate))}/auth.json)을 감지하여 '${slug}' 시나리오로 즉시 연결합니다.`);
      try {
        fs.copyFileSync(existingCandidate, authPath);
      } catch {}
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

    // Listen for newly opened popup windows/tabs (e.g. window.open portal)
    loginContext.on("page", (newPage) => {
      newPage.bringToFront().catch(() => {});
    });

    const startTime = Date.now();
    const GRACE_PERIOD_MS = 2500; // Allow initial page redirect to settle

    const isActuallyLoggedIn = async (): Promise<boolean> => {
      if (Date.now() - startTime < GRACE_PERIOD_MS) {
        return false;
      }

      const pages = loginContext.pages();
      for (const p of pages) {
        try {
          if (p.isClosed()) continue;
          const currentUrl = p.url().toLowerCase();
          if (currentUrl === "about:blank") continue;

          // 1. If currently on a login URL or has visible password inputs, DEFINITELY NOT logged in yet
          const isLoginUrl =
            currentUrl.includes("login") ||
            currentUrl.includes("signin") ||
            currentUrl.includes("userlogin") ||
            currentUrl.includes("oauth") ||
            currentUrl.includes("authorize");

          const hasPassword = (await p.locator('input[type="password"]:visible').count().catch(() => 0)) > 0;
          const hasLoginForm = (await p.locator('form#loginForm, .login_box, input#userId:visible').count().catch(() => 0)) > 0;

          if (isLoginUrl || hasPassword || hasLoginForm) {
            continue; // Still on login page, skip
          }

          // 2. POSITIVE indicators REQUIRED
          const hasGnbOrPortal =
            (await p
              .locator('#svc_lst, .user_info, button:has-text("로그아웃"), a:has-text("로그아웃"), .user_name, #header, .portal_wrap, #snb, .body_wrap')
              .count()
              .catch(() => 0)) > 0;

          const isMainPortalUrl =
            currentUrl.includes("/main/") ||
            currentUrl.includes("/portal/") ||
            currentUrl.includes("/home");

          if (hasGnbOrPortal || isMainPortalUrl) {
            return true;
          }
        } catch {}
      }
      return false;
    };

    const waitForLoginSuccess = async () => {
      while (true) {
        try {
          const allPages = loginContext.pages();
          const allClosed = allPages.length === 0 || allPages.every((p) => p.isClosed());
          if (allClosed) break;

          const loggedIn = await isActuallyLoggedIn();
          if (loggedIn) {
            console.log("\n🎉 [실시간 감지] 사용자가 브라우저에서 로그인을 완료한 것을 감지했습니다! 세션을 즉시 저장하고 녹화를 시작합니다.");
            break;
          }
        } catch {}
        await new Promise((r) => setTimeout(r, 800));
      }
    };

    await Promise.race([waitForEnter(), waitForLoginSuccess()]);

    const loggedIn = await isActuallyLoggedIn();
    if (loggedIn) {
      await loginContext.storageState({ path: authPath });
      console.log(`\n🎉 로그인 세션 저장 완료: ${authPath}`);
      try {
        syncAuthSession(authPath);
        console.log(`🌐 [세션 전체 동기화] 새로운 인증 정보가 모든 시나리오 및 AI 탐색기에 영구 동기화되었습니다.`);
      } catch {}
    } else {
      console.log(`\n⚠️ [세션 보존] 실제 로그인이 완료되지 않아 기존 인증 세션을 덮어쓰지 않습니다.`);
    }

    await loginContext.close().catch(() => {});
    await loginBrowser.close().catch(() => {});
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
  await context.addInitScript("window.__name = (fn) => fn;");

  // --- 🪟 Layer 1: Universal Same-Page Redirection for Popups (window.open & target="_blank") ---
  // Keeps the screen recording seamless on a single 1920x1080 canvas without multi-window splits
  await context.addInitScript(() => {
    try {
      if (window.location.pathname.includes("/ekp/scr/")) {
        sessionStorage.setItem("__studio_active_module_url__", window.location.href);
      }
      if (sessionStorage.getItem("__studio_simulated_popup__") === "1") {
        window.opener = window.opener || window;
      }
      const origClose = window.close;
      window.close = function () {
        const isSimulatedPopup = sessionStorage.getItem("__studio_simulated_popup__") === "1";
        if (
          !isSimulatedPopup ||
          !window.opener ||
          window.name === "hiddenFrm" ||
          window.location.href === "about:blank" ||
          window !== window.top
        ) {
          window.onbeforeunload = null;
          try { origClose.call(window); } catch (e) { }
          return;
        }
        window.onbeforeunload = null;
        const openerUrl = sessionStorage.getItem("__studio_popup_opener_url__");
        sessionStorage.removeItem("__studio_simulated_popup__");
        console.log(`[Studio Popup] window.close() 호출 감지 -> 부모 페이지(${openerUrl || "history.back"})로 자동 복귀`);
        if (openerUrl) {
          window.location.href = openerUrl;
        } else if (window.history.length > 1) {
          window.history.back();
        } else {
          try { origClose.call(window); } catch (e) { }
        }
      };
    } catch { }

    try {
      const origOpen = window.open;
      window.open = function (url, target, features) {
        if (/homGwPushPopup|PushPopup|notiPopup|alarmPopup/i.test(`${url || ""} ${target || ""}`)) {
          return null as any;
        }
        if (target === "hiddenFrm" || (features && features.includes("width=0"))) {
          return origOpen ? origOpen.apply(window, arguments as any) : window;
        }
        console.log(`[Studio Popup] window.open("${url}") 호출 감지 -> 단일 화면 녹화를 위해 동일 창으로 부드럽게 전환`);
        if (url && typeof url === "string" && url !== "about:blank") {
          try {
            const resolvedTargetUrl = new URL(url, window.location.origin).href;
            const isMainModuleScreen =
              /\/ekp\/scr\/[^?#]*Main(?:\b|$)/i.test(resolvedTargetUrl) &&
              !/Popup|newWindowYn=Y/i.test(resolvedTargetUrl);
            if (isMainModuleScreen) {
              sessionStorage.setItem("__studio_active_module_url__", resolvedTargetUrl);
              sessionStorage.removeItem("__studio_simulated_popup__");
              sessionStorage.removeItem("__studio_opener_active_menu__");
            } else {
              // Snapshot active sidebar/view state on the opener module screen before navigating away
              if (sessionStorage.getItem("__studio_simulated_popup__") !== "1") {
                try {
                  const bookListEl = document.getElementById("wikiBookList_list");
                  if (bookListEl && bookListEl.offsetWidth > 0 && !sessionStorage.getItem("__studio_opener_active_menu__")) {
                    sessionStorage.setItem(
                      "__studio_opener_active_menu__",
                      "#wikiMain_snb a[data-menu-id='wikiBookList']:visible, a[data-menu-id='wikiBookList']:visible"
                    );
                  } else {
                    const activeMenuEl = document.querySelector(
                      "#snb li.active a[data-menu-id], [id$='_snb'] li.active a[data-menu-id], .snb li.active a[data-menu-id], ul[id*='SideMenu'] li.active a[data-menu-id]"
                    );
                    const menuId = activeMenuEl ? activeMenuEl.getAttribute("data-menu-id") : "";
                    if (menuId) {
                      sessionStorage.setItem("__studio_opener_active_menu__", `a[data-menu-id='${menuId}']:visible`);
                    }
                  }
                } catch {}
              }
              let openerUrl = window.location.href;
              if (openerUrl.includes("/homGwMain") && !openerUrl.includes("#at=")) {
                const activeModUrl = sessionStorage.getItem("__studio_active_module_url__");
                if (activeModUrl) {
                  openerUrl = activeModUrl;
                } else {
                  const modMatch = url.match(/\/ekp\/view\/(eml|not|scd|bod|doc|rmg|smw|fbx|addr|wiki)\//i);
                  if (modMatch) {
                    const mod = modMatch[1].toLowerCase();
                    openerUrl = new URL(`/ekp/scr/${mod}/${mod}Main`, window.location.origin).href;
                  } else if (/\/ekp\/view\/app\/eap\//i.test(url)) {
                    openerUrl = new URL("/ekp/scr/app/eap/eapMain", window.location.origin).href;
                  }
                }
              }
              sessionStorage.setItem("__studio_popup_opener_url__", openerUrl);
              sessionStorage.setItem("__studio_simulated_popup__", "1");
            }
          } catch {}
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
          const rawEl = e.target as HTMLElement | null;
          const target = rawEl?.closest("a");
          if (target) {
            const onclickAttr = target.getAttribute("onclick") || "";
            if (onclickAttr.includes("GwMainMenu")) {
              const mnuMatch = onclickAttr.match(/goPage\(\s*['"](MNU[0-9a-zA-Z_-]+)['"]/i);
              const m = onclickAttr.match(/['"](https?:\/\/[^'"]+\/ekp\/scr\/[^'"]+|\/ekp\/scr\/[^'"]+)['"]/i);
              if (mnuMatch && mnuMatch[1] && window.location.pathname.includes("/homGwMain")) {
                try {
                  const hashAt = encodeURIComponent(btoa(mnuMatch[1]));
                  sessionStorage.setItem(
                    "__studio_active_module_url__",
                    `${window.location.origin}/ekp/main/home/homGwMain#at=${hashAt}`
                  );
                  sessionStorage.removeItem("__studio_opener_active_menu__");
                } catch {}
              } else if (m && m[1]) {
                try {
                  const resolved = new URL(m[1], window.location.origin).href;
                  sessionStorage.setItem("__studio_active_module_url__", resolved);
                  sessionStorage.removeItem("__studio_opener_active_menu__");
                } catch {}
              }
            }
            if (target.getAttribute("target") === "_blank") {
              target.setAttribute("target", "_self");
            }
          }

          // Track sidebar menu clicks on main module pages so we can restore the exact sub-view after returning from a popup
          if (rawEl && sessionStorage.getItem("__studio_simulated_popup__") !== "1" && !rawEl.closest(".ui-dialog")) {
            const snbContainer = rawEl.closest("#snb, [id$='_snb'], .snb, [id*='SideMenu']");
            const menuItem = rawEl.closest("a, button");
            if (snbContainer && menuItem) {
              const snbId = snbContainer.getAttribute("id") || "";
              const prefix = snbId ? `#${snbId} ` : "";
              const menuId = menuItem.getAttribute("data-menu-id");
              const menuName = menuItem.getAttribute("data-menu-name");
              if (menuId) {
                sessionStorage.setItem(
                  "__studio_opener_active_menu__",
                  `${prefix}a[data-menu-id='${menuId}']:visible, a[data-menu-id='${menuId}']:visible`
                );
              } else if (menuName) {
                sessionStorage.setItem(
                  "__studio_opener_active_menu__",
                  `${prefix}a[data-menu-name='${menuName}']:visible, a[data-menu-name='${menuName}']:visible`
                );
              } else if (menuItem.classList.contains("dynatree-title")) {
                const txt = (menuItem.textContent || "").replace(/\s+/g, " ").trim();
                if (txt) {
                  sessionStorage.setItem(
                    "__studio_opener_active_menu__",
                    `${prefix}.dynatree-title:has-text('${txt}'):visible, .snb .dynatree-title:has-text('${txt}'):visible`
                  );
                }
              }
            }
          }
        },
        true
      );
    } catch { }
  });

  let page: Page = await context.newPage();
  const pageStack: Page[] = [page];
  interface ChildPopupVideoSegment {
    page: Page;
    openedAtMs: number;
    closedAtMs?: number;
    videoPath?: string | null;
  }
  const childPopupSegments: ChildPopupVideoSegment[] = [];

  async function restoreFromSimulatedPopupIfNeeded(
    targetPage: Page,
    reason: string,
    targetAction?: BrowsePlanAction
  ): Promise<boolean> {
    try {
      // 1. If targetPage was already closed, pop closed pages from pageStack and switch back to the active parent page
      if (targetPage.isClosed()) {
        while (pageStack.length > 1 && pageStack[pageStack.length - 1].isClosed()) {
          pageStack.pop();
        }
        page = pageStack[pageStack.length - 1] || context.pages().find((p) => !p.isClosed()) || page;
        await page.bringToFront().catch(() => {});
        return true;
      }

      // 2. If a real child popup window (pageStack.length > 1) is still open, check if targetAction belongs to a parent window in pageStack
      if (pageStack.length > 1 && targetAction && targetAction.selector) {
        for (let pIdx = pageStack.length - 2; pIdx >= 0; pIdx--) {
          const candidateParent = pageStack[pIdx];
          if (!candidateParent || candidateParent.isClosed()) continue;
          const parentEl = await getLocator(candidateParent, targetAction);
          if (parentEl && (await parentEl.isVisible().catch(() => false))) {
            console.log(`  [🪟 팝업 자동 닫기 및 부모 창 복귀] ${reason} -> 자식 팝업 창을 닫고 부모 브라우저 창으로 복귀합니다.`);
            while (pageStack.length - 1 > pIdx) {
              const childPage = pageStack.pop();
              if (childPage && !childPage.isClosed()) {
                const seg = childPopupSegments.find((s) => s.page === childPage && s.closedAtMs === undefined);
                if (seg) {
                  seg.videoPath = await childPage.video()?.path().catch(() => null);
                  seg.closedAtMs = Date.now() - recordingStart;
                }
                await childPage.evaluate(() => { window.onbeforeunload = null; }).catch(() => {});
                await childPage.close().catch(() => {});
              }
            }
            page = candidateParent;
            await page.bringToFront().catch(() => {});
            await page.waitForTimeout(300).catch(() => {});
            return true;
          }
        }
      }

      // 3. Simulated same-page popup restoration
      const popupState = await targetPage.evaluate(() => {
        const isSimPopup =
          sessionStorage.getItem("__studio_simulated_popup__") === "1" ||
          /Popup|newWindowYn=Y/i.test(window.location.href);
        if (!isSimPopup) return null;
        let openerUrl = sessionStorage.getItem("__studio_popup_opener_url__") || sessionStorage.getItem("__studio_active_module_url__") || "";
        if (!openerUrl || (openerUrl.includes("/homGwMain") && !openerUrl.includes("#at="))) {
          const modMatch = window.location.pathname.match(/\/ekp\/view\/(eml|not|scd|bod|doc|rmg|smw|fbx|addr)\//i);
          if (modMatch) {
            const mod = modMatch[1].toLowerCase();
            openerUrl = `${window.location.origin}/ekp/scr/${mod}/${mod}Main`;
          } else if (/\/ekp\/view\/app\/eap\//i.test(window.location.pathname)) {
            openerUrl = `${window.location.origin}/ekp/scr/app/eap/eapMain`;
          }
        }
        const openerMenu = sessionStorage.getItem("__studio_opener_active_menu__") || "";
        window.onbeforeunload = null;
        sessionStorage.removeItem("__studio_simulated_popup__");
        return { openerUrl, currentUrl: window.location.href, openerMenu };
      }).catch(() => null);

      if (popupState && popupState.openerUrl && popupState.openerUrl !== popupState.currentUrl) {
        console.log(`  [🪟 팝업 닫힘 및 부모 창 복귀] ${reason} -> 부모 모듈 화면(${popupState.openerUrl})으로 복귀합니다.`);
        await targetPage.goto(popupState.openerUrl, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
        await targetPage.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => {});
        await targetPage.waitForTimeout(800);

        if (targetAction && targetAction.selector) {
          const immediateEl = await getLocator(targetPage, targetAction);
          const alreadyVisible = Boolean(immediateEl && (await immediateEl.isVisible().catch(() => false)));
          if (!alreadyVisible) {
            const selAndHtml = `${targetAction.selector || ""} ${targetAction.targetHtml || ""}`;
            const isWikiBookCardTarget =
              (selAndHtml.includes("data-book-name") || selAndHtml.includes("sub_cover") || selAndHtml.includes("wikiBookList")) &&
              !selAndHtml.includes("div.sub._openBook");
            const menuToRestore =
              popupState.openerMenu ||
              (isWikiBookCardTarget ? "#wikiMain_snb a[data-menu-id='wikiBookList']:visible, a[data-menu-id='wikiBookList']:visible" : "");

            if (menuToRestore) {
              for (const mPart of menuToRestore.split(",").map((s) => s.trim()).filter(Boolean)) {
                const mLoc = targetPage.locator(mPart).first();
                if (await mLoc.isVisible().catch(() => false)) {
                  console.log(`  [🔄 부모 창 서브메뉴 상태 복원] 팝업 진입 전 활성화되어 있던 메뉴(${mPart})를 다시 선택하여 목록 화면을 복원합니다.`);
                  await mLoc.click({ timeout: 3000 }).catch(() => {});
                  await targetPage.waitForLoadState("networkidle", { timeout: 2500 }).catch(() => {});
                  for (let poll = 0; poll < 12; poll++) {
                    await targetPage.waitForTimeout(250);
                    const restoredTarget = await getLocator(targetPage, targetAction);
                    if (restoredTarget && (await restoredTarget.isVisible().catch(() => false))) {
                      break;
                    }
                  }
                  await targetPage.waitForTimeout(400);
                  break;
                }
              }
            }
          }
        }
        return true;
      }
    } catch {}
    return false;
  }

  let lastNativeDialogMessage = "";
  let lastNativeDialogTime = 0;

  // Helper to setup dialog handling on any page
  function attachDialogHandler(targetPage: Page) {
    targetPage.on("dialog", async (dialog) => {
      const msg = dialog.message();
      const type = dialog.type();
      lastNativeDialogMessage = msg;
      lastNativeDialogTime = Date.now();
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
    const popupDetectedAt = Date.now();
    // 300ms 대기 후 즉시 닫힌 더미 팝업(Naonsoft hiddenFrm 등) 및 실시간 푸시 알림 토스트 팝업(homGwPushPopup)은 메인 녹화 페이지 하이재킹 차단
    await new Promise((r) => setTimeout(r, 300));
    if (newPage.isClosed()) {
      return;
    }
    const newPopupUrl = newPage.url() || "";
    if (/homGwPushPopup|PushPopup|notiPopup|alarmPopup|hiddenFrm/i.test(newPopupUrl)) {
      console.log(`  [🔕 백그라운드 알림 팝업 차단] 녹화 방해 방지를 위해 실시간 푸시 알림 창(${newPopupUrl})을 자동으로 닫습니다.`);
      await newPage.close().catch(() => {});
      return;
    }

    console.log(`\n  [🪟 새 브라우저 창(Popup) 감지] 새 팝업 창이 열렸습니다: ${newPopupUrl || "about:blank"}`);
    await newPage.setViewportSize(plan.viewport).catch(() => {});
    attachDialogHandler(newPage);
    pageStack.push(newPage);
    page = newPage;

    const popupSeg: ChildPopupVideoSegment = {
      page: newPage,
      openedAtMs: Math.max(0, popupDetectedAt - recordingStart),
    };
    childPopupSegments.push(popupSeg);
    newPage.video()?.path().then((p) => { popupSeg.videoPath = p; }).catch(() => {});

    newPage.on("close", () => {
      if (popupSeg.closedAtMs === undefined) {
        popupSeg.closedAtMs = Math.max(popupSeg.openedAtMs + 100, Date.now() - recordingStart);
      }
      console.log(`  [🪟 팝업 창 닫힘] 팝업이 닫혀 이전 활성 브라우저 창으로 자동 복귀합니다.`);
      const idx = pageStack.indexOf(newPage);
      if (idx !== -1) pageStack.splice(idx, 1);
      page = pageStack[pageStack.length - 1] || context.pages().find((p) => !p.isClosed()) || page;
      if (page && !page.isClosed()) {
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
  let targetNavUrl = plan.url;
  try {
    const parsed = new URL(plan.url);
    if (parsed.pathname === "" || parsed.pathname === "/") {
      targetNavUrl = new URL("/ekp/main/home/homGwMain", plan.url).toString();
    }
  } catch {}

  console.log(`페이지 이동 중: ${targetNavUrl}`);
  await page.goto(targetNavUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  if (isHeaded) {
    bringWindowToForeground();
  }

  const moments: Moment[] = [];
  let momentId = 0;
  const runtimeVariables = new Map<string, string>();
  currentRuntimeVariables.clear();

  // 🚨 Canon 2: Relation-Based Proximity & Multi-Input Tracking
  let lastTypedInput: Locator | null = null;
  let lastTypedBox: BoundingBox | null = null;
  let lastTypedTime = 0;

  console.log(`\nRecording started for "${slug}" at ${plan.url}`);

  try {
    for (let actionIdx = 0; actionIdx < plan.actions.length; actionIdx++) {
      if (page.isClosed()) {
        while (pageStack.length > 1 && pageStack[pageStack.length - 1].isClosed()) {
          pageStack.pop();
        }
        page = pageStack[pageStack.length - 1] || context.pages().find((p) => !p.isClosed()) || page;
      }
      const action = plan.actions[actionIdx];
      momentId++;

      const moment: Moment = {
        id: momentId,
        type: action.type,
        timestamp: 0,
        description: action.description,
      };
      const extraSubMoments: Moment[] = [];

      switch (action.type) {
        case "navigate": {
          const targetUrl = action.url ?? plan.url;
          moment.url = targetUrl;
          moment.timestamp = Date.now() - recordingStart;
          lastTypedInput = null;
          lastTypedBox = null;
          lastTypedTime = 0;
          await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
          break;
        }

        case "wait": {
          if ((action as any)._shouldPrune) {
            console.log(`  [동반 생략] wait: ${action.description || '대기'} (선행 부가 액션 스킵으로 인한 대기 생략)`);
            break;
          }
          moment.timestamp = Date.now() - recordingStart;
          const ms = action.ms ?? 1000;
          // 모달 애니메이션 대기 후 즉시 복구, 남은 시간 대기 (팝업 닫힘 시 예외 안전 처리)
          await page.waitForTimeout(Math.min(500, ms)).catch(() => new Promise((r) => setTimeout(r, Math.min(500, ms))));
          if (page.isClosed()) {
            while (pageStack.length > 1 && pageStack[pageStack.length - 1].isClosed()) {
              pageStack.pop();
            }
            page = pageStack[pageStack.length - 1] || context.pages().find((p) => !p.isClosed()) || page;
          }
          await autoRecoverActiveModals(page, action, moments, recordingStart);
          if (ms > 500) {
            await page.waitForTimeout(ms - 500).catch(() => new Promise((r) => setTimeout(r, ms - 500)));
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
          await page.waitForTimeout(action.ms ?? 500).catch(() => {});
          break;
        }

        case "dragAndDrop": {
          await autoRecoverActiveModals(page, action, moments, recordingStart);
          const srcSelector = action.sourceSelector || action.selector;
          const tgtSelector = action.targetSelector;

          if (!srcSelector || !tgtSelector) {
            throw new Error(`[드래그 앤 드롭 오류] sourceSelector 또는 targetSelector가 누락되었습니다: source="${srcSelector}", target="${tgtSelector}"`);
          }

          console.log(`  [🎯 드래그 앤 드롭 실행] "${action.description}" (${srcSelector} ➔ ${tgtSelector})`);

          const hasModal = (await page.locator(".ui-dialog:visible, .modal:visible, [role='dialog']:visible").count().catch(() => 0)) > 0;
          const topDlg = page.locator(".ui-dialog:visible, .modal:visible, [role='dialog']:visible").last();

          const expectedSrcMatch =
            srcSelector.match(/dynatree-title[^,]*:(?:has-text|text-is)\(['"]([^'"]+)['"]\)/i) ||
            srcSelector.match(/:(?:has-text|text-is)\(['"]([^'"]+)['"]\)/i) ||
            action.description?.match(/트리\s*['"]([^'"]+)['"]/i) ||
            action.description?.match(/['"]([^'"]+)['"]\s*(?:항목|사원|노드|결재자)/i);
          const expectedSrcText = expectedSrcMatch ? expectedSrcMatch[1].trim() : "";

          const userMatch =
            srcSelector.match(/has-text\(['"]([^'"]+)['"]\)/i) ||
            action.description?.match(/트리\s*['"]([^'"]+)['"]/i) ||
            action.description?.match(/['"]([^'"]+)['"]\s*(?:항목|사원|노드|결재자)/i) ||
            action.description?.match(/(test\d+)/i) ||
            srcSelector.match(/(test\d+)/i);
          const rawTargetUser = userMatch ? userMatch[1].trim() : "";
          const targetUser = (rawTargetUser.match(/test\d+/i)?.[0] || rawTargetUser.split(/\s+/)[0] || rawTargetUser).trim();

          // 1. Locate source element & verify its text matches expectedSrcText / targetUser
          let srcLoc = await getLocatorWithWait(page, { ...action, selector: srcSelector }, false);
          if (!(srcLoc && (await srcLoc.isVisible().catch(() => false)))) {
            const restored = await restoreFromSimulatedPopupIfNeeded(
              page,
              `'${action.description || srcSelector}' 드래그 대상 탐색을 위해 팝업 종료`,
              { ...action, selector: srcSelector }
            );
            if (restored) {
              srcLoc = await getLocatorWithWait(page, { ...action, selector: srcSelector }, false);
            }
          }
          if (srcLoc && (expectedSrcText || targetUser)) {
            const actualSrcText = (await srcLoc.innerText().catch(() => "")).trim();
            const matchesExpected =
              (expectedSrcText && actualSrcText.includes(expectedSrcText)) ||
              (targetUser && actualSrcText.includes(targetUser));
            if (!matchesExpected) {
              console.log(
                `  ⚠️ [dragAndDrop 소스 교정] 1차 매칭된 요소('${actualSrcText}')가 목표 대상('${expectedSrcText || targetUser}')과 일치하지 않아 정확 텍스트 노드로 재탐색합니다.`
              );
              const scopeRoot = hasModal ? topDlg : page;
              const exactCandidates: string[] = [];
              if (expectedSrcText) {
                exactCandidates.push(`a.dynatree-title:text-is('${expectedSrcText}'):visible`);
                exactCandidates.push(`a.dynatree-title:has-text('${expectedSrcText}'):visible`);
              }
              if (targetUser) {
                exactCandidates.push(`a.dynatree-title:has-text('${targetUser}'):visible`);
                exactCandidates.push(`label.user_info:has-text('${targetUser}'):visible`);
              }
              if (expectedSrcText) {
                exactCandidates.push(`*:text-is('${expectedSrcText}'):visible`);
              }
              const exactLoc = scopeRoot.locator(exactCandidates.join(", ")).first();
              if (await exactLoc.isVisible().catch(() => false)) {
                srcLoc = exactLoc;
              } else {
                srcLoc = null;
              }
            }
          }

          if (!srcLoc && hasModal && targetUser) {
            const searchInput = topDlg.locator("input.srch_bar input, .srch_bar input, input[placeholder*='검색'], input[placeholder*='이름'], input[placeholder*='사원'], #searchWord, #orgSearchWord, input[type='text']:visible").first();
            const searchBtn = topDlg.locator("button.btn_srch:visible, button[title='검색']:visible, button:has-text('검색'):visible, .ico_srch:visible, button.btn_search:visible").first();
            if (await searchInput.isVisible().catch(() => false)) {
              console.log(`  🔍 [dragAndDrop 스마트 검색] 드래그 대상 '${targetUser}'를 찾기 위해 조직도 검색을 실행합니다...`);
              await searchInput.click().catch(() => {});
              await searchInput.fill(targetUser).catch(() => {});
              if (await searchBtn.isVisible().catch(() => false)) {
                await searchBtn.click().catch(() => {});
              } else {
                await searchInput.press("Enter").catch(() => {});
              }
              await page.waitForTimeout(800);
              const found = topDlg.locator(`a.dynatree-title:has-text('${targetUser}'):visible, label.user_info:has-text('${targetUser}'):visible, tr:has-text('${targetUser}'):visible, li:has-text('${targetUser}'):visible`).first();
              if (await found.isVisible().catch(() => false)) {
                console.log(`  [✨ dragAndDrop 스마트 검색 성공] '${targetUser}'를 찾아 소스로 연결했습니다.`);
                srcLoc = found;
              }
            }
          }

          if (!srcLoc) {
            const tempSrcAct: BrowsePlanAction = { ...action, selector: srcSelector };
            srcLoc = await trySelfHealAction(moments, recordingStart, page, tempSrcAct, momentId, plan, dataDir);
            if (srcLoc) {
              action.sourceSelector = tempSrcAct.sourceSelector || tempSrcAct.selector || srcSelector;
              if (tempSrcAct.targetSelector) {
                action.targetSelector = tempSrcAct.targetSelector;
              }
              if ((tempSrcAct as any)._insertBefore) {
                (action as any)._insertBefore = (tempSrcAct as any)._insertBefore;
              }
              if ((tempSrcAct as any)._replaceWith) {
                (action as any)._replaceWith = (tempSrcAct as any)._replaceWith;
              }
              saveHealedPlan(dataDir, plan);
            }
          }
          if (!srcLoc) {
            throw new Error(`[드래그 앤 드롭 실패] 시작 요소를 찾을 수 없습니다: ${srcSelector}`);
          }

          // 2. Locate target element
          const descLower = (action.description || "").toLowerCase();
          const isSecondApprSlot = descLower.includes("결재") && (descLower.includes("두번째") || descLower.includes("두 번째") || descLower.includes("2번째") || descLower.includes("칸") || descLower.includes("슬롯"));

          let tgtLoc: Locator | null = null;
          if (action.targetSelector || tgtSelector) {
            tgtLoc = await getLocatorWithWait(
              page,
              {
                ...action,
                selector: action.targetSelector || tgtSelector,
                description: "결재선 드롭 도착지 영역",
                recordedByEyedropper: true,
              },
              false
            );
          }

          if (!action.recordedByEyedropper && !plan.recordedByEyedropper && !tgtLoc && hasModal && isSecondApprSlot) {
            // Fallback to the 2nd approval slot in Naonsoft EAP (#af_4)
            const slot4 = topDlg.locator("#af_4, table#eapLineSelect_line td:nth-child(4) div.app_flow, .appline_flow table td:nth-child(4) div.app_flow, div.app_flow:has(strong:has-text('결재')):nth-of-type(2)").first();
            if (await slot4.isVisible().catch(() => false)) {
              console.log(`  [📥 결재선 2번째 결재칸 핀포인트 타겟팅] Naonsoft EAP 2번째 결재 슬롯(#af_4)을 타겟팅합니다.`);
              tgtLoc = slot4;
            }
          }

          if (!action.recordedByEyedropper && !plan.recordedByEyedropper && !tgtLoc && hasModal) {
            // Fallback matching
            if (isSecondApprSlot) {
              const apprButtons = topDlg.locator("#eapLineSelect_lineTrgtAdd button[data-app-type-ordr='4'], #eapLineSelect_lineTrgtAdd button:has-text('결재'):nth-of-type(2), button:has-text('결재'):visible");
              const apprCount = await apprButtons.count().catch(() => 0);
              if (apprCount >= 2) {
                tgtLoc = apprButtons.nth(1);
              } else if (apprCount > 0) {
                tgtLoc = apprButtons.first();
              }
            } else {
              const anySlots = topDlg.locator("table#eapLineSelect_line div.app_flow:visible, .appline_flow div.app_flow:visible, [id^='af_']:visible, .app_line_box:visible");
              const anyCount = await anySlots.count().catch(() => 0);
              if (anyCount >= 2) {
                tgtLoc = anySlots.nth(1);
              } else if (anyCount > 0) {
                tgtLoc = anySlots.first();
              }
            }
          }

          if (!tgtLoc) {
            const tempTgtAct: BrowsePlanAction = { ...action, selector: action.targetSelector || tgtSelector };
            tgtLoc = await trySelfHealAction(moments, recordingStart, page, tempTgtAct, momentId, plan, dataDir);
            if (tgtLoc) {
              action.targetSelector = tempTgtAct.targetSelector || tempTgtAct.selector || tgtSelector;
              saveHealedPlan(dataDir, plan);
            }
          }
          if (!tgtLoc) {
            throw new Error(`[드래그 앤 드롭 실패] 도착 요소를 찾을 수 없습니다: ${tgtSelector}`);
          }

          // Pre-drag safety: if another user's checkbox (e.g. test001) is still checked in DynaTree (AI-generated plans only),
          // ensure it doesn't get dragged along with targetUser (e.g. test002)!
          if (!action.recordedByEyedropper && !plan.recordedByEyedropper && hasModal && targetUser) {
            await page.evaluate(({ dragUser }) => {
              const $ = (window as any).$;
              const selectedSpans = Array.from(document.querySelectorAll(".ui-dialog:visible .dynatree-node.dynatree-selected"));
              for (const span of selectedSpans) {
                const txt = (span.textContent || "").trim();
                if (txt && !txt.includes(dragUser)) {
                  const lineText = (document.querySelector("#eapLineSelect_line, .appline_flow")?.textContent || "");
                  const otherUserMatch = txt.match(/test\d+|[가-힣]{2,4}/i);
                  const otherUser = otherUserMatch ? otherUserMatch[0] : txt.split(/\s+/)[0];
                  if (otherUser && !lineText.includes(otherUser)) {
                    const agreeBtn = document.querySelector(".ui-dialog:visible button.btn_add[data-app-type-ordr='2'], .ui-dialog:visible button[title='합의 추가']") as HTMLElement | null;
                    if (agreeBtn) agreeBtn.click();
                  }
                  if (span.classList.contains("dynatree-selected")) {
                    const chk = span.querySelector(".dynatree-checkbox") as HTMLElement | null;
                    if (chk) chk.click();
                  }
                }
              }
              if ($ && $("#eapLineSelect_orgBox").length) {
                try {
                  const tree = $("#eapLineSelect_orgBox").dynatree("getTree");
                  const selNodes = tree?.getSelectedNodes?.() || [];
                  for (const n of selNodes) {
                    if (n?.data?.title && !String(n.data.title).includes(dragUser)) {
                      n.select(false);
                    }
                  }
                } catch {}
              }
            }, { dragUser: targetUser }).catch(() => {});
            await page.waitForTimeout(200);
          }

          // Prefer inner .af_ul droppable container ONLY if it has non-collapsed height (>= 30px); otherwise use tgtLoc (#af_N / div.app_flow)
          const innerDropUl = tgtLoc.locator("ul.af_ul:visible, .af_ul:visible").first();
          const innerUlBox = (await innerDropUl.isVisible().catch(() => false))
            ? await innerDropUl.boundingBox().catch(() => null)
            : null;
          const effectiveTgtLoc = innerUlBox && innerUlBox.height >= 30 && innerUlBox.width >= 30 ? innerDropUl : tgtLoc;

          await srcLoc.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
          await effectiveTgtLoc.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});

          const srcBox = await getSettledBoundingBox(srcLoc);
          const tgtBox = await getSettledBoundingBox(effectiveTgtLoc);

          if (!srcBox || !tgtBox) {
            throw new Error(`[드래그 앤 드롭 실패] 시작/도착 요소의 BoundingBox 좌표를 측정할 수 없습니다.`);
          }

          const fromX = Math.round(srcBox.x + srcBox.width / 2);
          const fromY = Math.round(srcBox.y + srcBox.height / 2);
          const toX = Math.round(tgtBox.x + tgtBox.width / 2);
          // Aim slightly above vertical center of the slot box so we never hit a bottom sub-합의 bar
          const toY = Math.round(tgtBox.y + Math.min(tgtBox.height / 2, Math.max(24, tgtBox.height * 0.4)));

          moment.timestamp = Date.now() - recordingStart;
          moment.cursor = { x: fromX, y: fromY };
          moment.dragFrom = { x: fromX, y: fromY };
          moment.dragTo = { x: toX, y: toY };
          moment.target = {
            x: Math.round(srcBox.x),
            y: Math.round(srcBox.y),
            width: Math.round(srcBox.width),
            height: Math.round(srcBox.height),
          };

          // Visual ripple at start
          await triggerClickVisualizer(page, fromX, fromY);
          await page.waitForTimeout(200);

          // Smooth drag movement
          await page.mouse.move(fromX, fromY);
          await page.mouse.down();
          await page.waitForTimeout(150);

          const dragSteps = 15;
          for (let s = 1; s <= dragSteps; s++) {
            const curX = Math.round(fromX + (toX - fromX) * (s / dragSteps));
            const curY = Math.round(fromY + (toY - fromY) * (s / dragSteps));
            await page.mouse.move(curX, curY);
            await page.waitForTimeout(25);
          }

          await page.mouse.up();
          await triggerClickVisualizer(page, toX, toY);

          // Strictly check ONLY the target drop slot / approval line (NEVER [class*='box'] which matches #eapLineSelect_orgBox on the left!)
          const afOrdrMatch = (action.targetSelector || tgtSelector || "").match(/#af_(\d+)/);
          const targetOrdr = afOrdrMatch ? afOrdrMatch[1] : "4";

          const checkUserInTargetSlot = async (): Promise<boolean> => {
            if (!targetUser) return true;
            const tgtText = await tgtLoc.innerText().catch(() => "");
            if (tgtText.includes(targetUser)) return true;
            if (afOrdrMatch) {
              const slotText = await topDlg.locator(`#af_${targetOrdr}`).innerText().catch(() => "");
              if (slotText.includes(targetUser)) return true;
            }
            const slotsText = await topDlg
              .locator("table#eapLineSelect_line, .appline_flow, [id^='af_']")
              .allInnerTexts()
              .catch(() => []);
            return slotsText.some((t) => t.includes(targetUser));
          };

          await page.waitForTimeout(250);
          let isUserInSlot = await checkUserInTargetSlot();

          // If synthetic mouse drag did not trigger Naonsoft's jQuery UI droppable handler,
          // immediately and atomically invoke the page's Dynatree + approval-slot insertion at the exact moment of drop!
          if (!isUserInSlot && hasModal && targetUser) {
            await page.evaluate(
              ({ dragUser, ordr }) => {
                const $ = (window as any).$;
                let treeNodeSelected = false;
                if ($ && $("#eapLineSelect_orgBox").length) {
                  try {
                    const tree = $("#eapLineSelect_orgBox").dynatree("getTree");
                    if (tree && tree.visit) {
                      tree.visit((node: any) => {
                        const nodeTitle = String(node?.data?.title || node?.span?.textContent || "");
                        if (nodeTitle.includes(dragUser)) {
                          node.select(true);
                          treeNodeSelected = true;
                        } else if (node.isSelected && node.isSelected()) {
                          node.select(false);
                        }
                      });
                    }
                  } catch {}
                }
                if (!treeNodeSelected) {
                  const nodes = Array.from(document.querySelectorAll(".ui-dialog .dynatree-node"));
                  for (const n of nodes) {
                    const txt = (n.textContent || "").trim();
                    const chk = n.querySelector(".dynatree-checkbox") as HTMLElement | null;
                    if (txt.includes(dragUser) && !n.classList.contains("dynatree-selected") && chk) {
                      chk.click();
                      treeNodeSelected = true;
                      break;
                    }
                  }
                }
                const addBtn =
                  (document.querySelector(
                    `#eapLineSelect_lineTrgtAdd button[data-app-type-ordr='${ordr}'], .ui-dialog button.btn_add[data-app-type-ordr='${ordr}']`
                  ) as HTMLElement | null);
                if (addBtn) {
                  addBtn.click();
                }
                // Unselect the dragged node in the tree so its checkbox stays clean just like after a native drag-and-drop
                if ($ && $("#eapLineSelect_orgBox").length) {
                  try {
                    const tree = $("#eapLineSelect_orgBox").dynatree("getTree");
                    const selNodes = tree?.getSelectedNodes?.() || [];
                    for (const n of selNodes) {
                      if (String(n?.data?.title || "").includes(dragUser)) {
                        n.select(false);
                      }
                    }
                  } catch {}
                }
              },
              { dragUser: targetUser, ordr: targetOrdr }
            ).catch(() => {});
            await page.waitForTimeout(300);
            isUserInSlot = await checkUserInTargetSlot();
          }

          if (isUserInSlot) {
            console.log(`  [✅ 드래그 앤 드롭 완료] '${targetUser}' 대상이 목표 결재칸(#af_${targetOrdr})에 정확히 반영되었습니다.`);
            await page.waitForTimeout(Math.max(300, (action.ms ?? 1000) - 500));
          } else {
            // Fallback: Try Playwright dragTo if neither mouse drag nor atomic slot insertion succeeded
            await srcLoc.dragTo(effectiveTgtLoc, { timeout: 2500 }).catch(() => {});
            await page.waitForTimeout(400);
            isUserInSlot = await checkUserInTargetSlot();
          }

          if (targetUser && hasModal && !isUserInSlot) {
            console.log(`  [✨ 결재선 실반영 보장] 드래그 후 대상('${targetUser}')이 슬롯에 미반영되어 체크 후 결재 버튼 연계를 통해 확정합니다.`);

            const userChk = topDlg.locator(`
              .dynatree-node:has(a:has-text('${targetUser}')) .dynatree-checkbox:visible,
              .dynatree-node:has(a:text-is('${targetUser}')) .dynatree-checkbox:visible,
              tr:has-text('${targetUser}') .dynatree-checkbox:visible,
              tr:has-text('${targetUser}') input[type='checkbox']:visible
            `).first();

            if (await userChk.isVisible().catch(() => false)) {
              await userChk.click({ force: true }).catch(() => {});
              await page.waitForTimeout(300);
            }

            const btnAdd = topDlg.locator(`
              #eapLineSelect_lineTrgtAdd button[data-app-type-ordr='${targetOrdr}']:visible,
              button.btn_add[data-app-type-ordr='${targetOrdr}']:visible,
              #eapLineSelect_lineTrgtAdd button.btn_add:has(span:has-text('결재')):nth-of-type(2),
              #eapLineSelect_lineTrgtAdd button:has-text('결재'):nth-of-type(2)
            `).first();

            if (await btnAdd.isVisible().catch(() => false)) {
              console.log(`  [📥 결재칸 버튼 클릭] 결재선 추가 버튼(ordr=${targetOrdr})을 클릭하여 슬롯 반영`);
              await btnAdd.click({ force: true }).catch(() => {});
              await page.waitForTimeout(500);
            }

            const postCheck = await checkUserInTargetSlot();
            console.log(`  [결재선 반영 결과] '${targetUser}' 결재칸 반영 상태: ${postCheck ? '✅ 성공' : '⚠️ 확인 필요'}`);
          }

          // Safety net: if a duplicate-user alert (#naon-cmm-alert-confirm) popped up for any reason, dismiss it immediately
          const dupAlertBtn = page.locator("button#naon-cmm-alert-confirm:visible, #alert_lyr:visible button:has-text('확인'):visible").first();
          if (await dupAlertBtn.isVisible().catch(() => false)) {
            console.log(`  [🛡️ 중복 알림창 자동 닫기] 알림 팝업을 감지하여 즉시 닫습니다.`);
            await dupAlertBtn.click({ force: true }).catch(() => {});
            await page.waitForTimeout(400);
          }
          break;
        }

        case "hover": {
          await autoRecoverActiveModals(page, action, moments, recordingStart);
          const isOptionalOrSub = isOptionalAction(action, momentId, plan.actions.length) || isNonCriticalSubOption(action);
          let el = await getLocatorWithWait(page, action, isOptionalOrSub);
          if (!(el && (await el.isVisible().catch(() => false)))) {
            const restored = await restoreFromSimulatedPopupIfNeeded(
              page,
              `'${action.description || action.selector}' 호버 대상 탐색을 위해 팝업 종료`,
              action
            );
            if (restored) {
              el = await getLocatorWithWait(page, action, isOptionalOrSub);
            }
          }
          if (!el) {
            el = await trySelfHealAction(moments, recordingStart, page, action, momentId, plan, dataDir);
          }
          if (!el) {
            if (canSafelySkipFailedAction(action, momentId, plan.actions.length, (action as any)._lastHealReason) || (action as any)._wasSkipped) {
              markActionAndFollowupWaitForPruning(plan, actionIdx, action);
              console.log(`  [⚠️ 비필수 부가 단계 자동 스킵] 요소를 찾을 수 없으나 필수 핵심 단계가 아니므로 안전하게 통과합니다: ${action.description}`);
              break;
            }
            throw new Error(`요소를 찾을 수 없습니다: ${action.selector}`);
          }
          const waitTimeout = isOptionalOrSub ? 2000 : (momentId >= plan.actions.length - 2) ? 2000 : 3500;
          try {
            await el.waitFor({ state: "visible", timeout: waitTimeout });
          } catch (waitErr) {
            const healed = await trySelfHealAction(moments, recordingStart, page, action, momentId, plan, dataDir);
            if (healed) {
              el = healed;
            } else {
              if (canSafelySkipFailedAction(action, momentId, plan.actions.length, (action as any)._lastHealReason) || (action as any)._wasSkipped) {
                markActionAndFollowupWaitForPruning(plan, actionIdx, action);
                console.log(`  [⚠️ 비필수 부가 단계 자동 스킵] 요소를 찾을 수 없으나 필수 핵심 단계가 아니므로 안전하게 통과합니다: ${action.description}`);
                break;
              }
              throw new Error(`요소를 찾을 수 없습니다: ${action.selector}`);
            }
          }
          
          const box = await getSettledBoundingBox(el, 1000);

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
          if (moment.cursor) {
            await page.mouse.move(moment.cursor.x, moment.cursor.y).catch(() => {});
          }
          await el.hover({ timeout: 1500, force: true }).catch(() => { });
          await page.waitForTimeout(500).catch(() => {});
          break;
        }

        case "dblclick": {
          await autoRecoverActiveModals(page, action, moments, recordingStart);
          const isOptionalOrSub = isOptionalAction(action, momentId, plan.actions.length) || isNonCriticalSubOption(action);
          let el = await getLocatorWithWait(page, action, isOptionalOrSub);
          if (!(el && (await el.isVisible().catch(() => false)))) {
            const restored = await restoreFromSimulatedPopupIfNeeded(
              page,
              `'${action.description || action.selector}' 더블클릭 대상 탐색을 위해 팝업 종료`,
              action
            );
            if (restored) {
              el = await getLocatorWithWait(page, action, isOptionalOrSub);
            }
          }
          if (!el) {
            el = await trySelfHealAction(moments, recordingStart, page, action, momentId, plan, dataDir);
          }
          if (!el) {
            if (canSafelySkipFailedAction(action, momentId, plan.actions.length, (action as any)._lastHealReason) || (action as any)._wasSkipped) {
              markActionAndFollowupWaitForPruning(plan, actionIdx, action);
              console.log(`  [⚠️ 비필수 부가 단계 자동 스킵] 요소를 찾을 수 없으나 필수 핵심 단계가 아니므로 안전하게 통과합니다: ${action.description}`);
              break;
            }
            throw new Error(`요소를 찾을 수 없습니다: ${action.selector}`);
          }
          const waitTimeout = isOptionalOrSub ? 2500 : (momentId >= plan.actions.length - 2) ? 3000 : 15000;
          try {
            await el.waitFor({ state: "visible", timeout: waitTimeout });
          } catch (waitErr) {
            const healed = await trySelfHealAction(moments, recordingStart, page, action, momentId, plan, dataDir);
            if (healed) {
              el = healed;
            } else {
              if (canSafelySkipFailedAction(action, momentId, plan.actions.length, (action as any)._lastHealReason) || (action as any)._wasSkipped) {
                markActionAndFollowupWaitForPruning(plan, actionIdx, action);
                console.log(`  [⚠️ 비필수 부가 단계 자동 스킵] 요소를 찾을 수 없으나 필수 핵심 단계가 아니므로 안전하게 통과합니다: ${action.description}`);
                break;
              }
              throw new Error(`요소를 찾을 수 없습니다: ${action.selector}`);
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
          await autoRecoverActiveModals(page, action, moments, recordingStart);
          const descLower = (action.description || "").toLowerCase();
          const selLower = (action.selector || "").toLowerCase();
          const isOptionalOrSub = isOptionalAction(action, momentId, plan.actions.length) || isNonCriticalSubOption(action);
          let el = await getLocatorWithWait(page, action, isOptionalOrSub);
          if (!(el && (await el.isVisible().catch(() => false)))) {
            const restored = await restoreFromSimulatedPopupIfNeeded(
              page,
              `'${action.description || action.selector}' 대상 탐색을 위해 팝업 종료`,
              action
            );
            if (restored) {
              el = await getLocatorWithWait(page, action, isOptionalOrSub);
            }
          }
          const hasSpecificSelector = Boolean(
            action.recordedByEyedropper ||
            (action.selector && (/#[a-zA-Z0-9_-]+/.test(action.selector) || action.selector.includes(">")))
          );
          const isElVisible = async () => Boolean(el && (await el.isVisible().catch(() => false)));

          const cleanDesc = (action.description || "").replace(/[\[\]]/g, "");
          const isSearchExecutionButton =
            !cleanDesc.includes("검색된") &&
            !cleanDesc.includes("카드") &&
            !cleanDesc.includes("항목") &&
            !cleanDesc.includes("양식") &&
            !cleanDesc.includes("결과") &&
            !cleanDesc.includes("상세") &&
            !cleanDesc.includes("문서") &&
            !cleanDesc.includes("선택") &&
            !cleanDesc.includes("통합검색") &&
            !cleanDesc.includes("전사검색") &&
            ((cleanDesc.includes("검색") && (cleanDesc.includes("버튼") || cleanDesc.includes("실행") || cleanDesc.includes("아이콘"))) ||
             (action.selector && (action.selector.includes("searchBtn") || action.selector.includes("btn_srch") || action.selector.includes("btn_search") || action.selector.includes("search_btn"))));

          if (isSearchExecutionButton && !action.recordedByEyedropper && !plan.recordedByEyedropper && !(await isElVisible())) {
            let adjacentSearchBtn: Locator | null = null;
            // 🚨 Canon 2: Relation-Based Proximity & Adjacent Search Button Binding
            if (lastTypedInput && (Date.now() - lastTypedTime < 60000)) {
              try {
                // 1) Same form, search bar container, or wrapper
                const containerBtn = lastTypedInput.locator(
                  "xpath=ancestor::*[contains(@class,'srch') or contains(@class,'search') or self::form or contains(@class,'box') or contains(@class,'input_group') or self::div][1]//button[contains(@class,'srch') or contains(@class,'search') or contains(@id,'srch') or contains(@id,'search') or @title='검색' or contains(.,'검색') or .//*[contains(@class,'ico_srch')] or contains(@class,'btn_srch')]"
                ).first();
                if (await containerBtn.isVisible({ timeout: 500 }).catch(() => false)) {
                  console.log(`  [🎯 인접 검색 버튼 바인딩] 방금 입력한 <input>과 동일 Form/컨테이너 내의 바로 옆 검색 버튼을 감지하여 타겟팅합니다.`);
                  adjacentSearchBtn = containerBtn;
                } else {
                  // 2) Sibling button
                  const siblingBtn = lastTypedInput.locator(
                    "xpath=following-sibling::button[1] | following-sibling::*//button[1] | ../following-sibling::button[1]"
                  ).first();
                  if (await siblingBtn.isVisible({ timeout: 500 }).catch(() => false)) {
                    console.log(`  [🎯 인접 형제 검색 버튼 바인딩] 방금 입력한 <input>의 바로 인접 형제 검색 버튼을 타겟팅합니다.`);
                    adjacentSearchBtn = siblingBtn;
                  }
                }
              } catch {}
            }

            if (adjacentSearchBtn) {
              const adjBox = await adjacentSearchBtn.boundingBox().catch(() => null);
              const curBox = el ? await el.boundingBox().catch(() => null) : null;
              const isDifferentSearchBtn =
                !curBox ||
                (adjBox && Math.hypot(curBox.x - adjBox.x, curBox.y - adjBox.y) > 20);
              if (!curBox || (!hasSpecificSelector && isDifferentSearchBtn)) {
                el = adjacentSearchBtn;
              }
            } else if (!(await isElVisible()) || !hasSpecificSelector) {
              const isFolderTreeSearch = cleanDesc.includes("문서함") || cleanDesc.includes("폴더") || cleanDesc.includes("트리") || cleanDesc.includes("사이드바");
              const contentSearchBtn = page.locator(
                "button#atclList_srchBtn:visible, button[id*='srchBtn']:visible, button[id*='searchBtn']:visible, .new_srch_bar button:visible, #content .srch_input button:has(.ico_srch):visible, #content .srch_input button[title='검색']:visible, #content button[title='검색']:visible, #content button.btn_srch:visible, #content button:has-text('검색'):visible"
              ).first();
              const sidebarSearchBtn = page.locator(
                "#snb .srch_bar button.btn_srch:visible, #snb .srch_bar button[title='검색']:visible, #snb button.btn_srch:visible"
              ).first();

              if (!isFolderTreeSearch && await contentSearchBtn.isVisible().catch(() => false)) {
                console.log(`  [🎯 본문 목록 검색 실행 버튼 특정] 사이드바/GNB를 배제하고 헤더 바로 밑 본문 툴바의 제목/목록 검색 실행 버튼을 연결합니다.`);
                el = contentSearchBtn;
              } else if (await sidebarSearchBtn.isVisible().catch(() => false)) {
                console.log(`  [🎯 사이드바 트리 검색 실행 버튼 특정] 사이드바 내의 검색 실행 버튼을 연결합니다.`);
                el = sidebarSearchBtn;
              }
            }
          }

          // Card [작성] Button detection for Naonsoft EKP Approval Work Cards
          const isCardWriteBtnAction =
            (descLower.includes("카드") && (descLower.includes("작성") || descLower.includes("결재작성"))) ||
            (descLower.includes("결재작성") && !descLower.includes("사이드바") && !descLower.includes("snb")) ||
            descLower.includes("기안 작성 화면 오픈") ||
            (selLower.includes("btn_write") &&
              (selLower.includes("aw_li") || selLower.includes("app_work_box") || selLower.includes("workselect")));

          const isClickSearchResult = !isSearchExecutionButton && !isCardWriteBtnAction && (
            Boolean(action.useScraped) ||
            Boolean(
              action.description &&
              (action.description.includes("검색된") || action.description.includes("검색 결과") || (action.description.includes("결과") && action.description.includes("항목")) || action.description.includes("양식 카드") || action.description.includes("카드 클릭")) &&
              (action.description.includes("선택") || action.description.includes("클릭") || action.description.includes("상세") || action.description.includes("조회") || action.description.includes("호버"))
            )
          );

          if (isClickSearchResult && !action.recordedByEyedropper && !plan.recordedByEyedropper && (!(await isElVisible()) || Boolean(action.useScraped))) {
            const targetText = action.useScraped && action.useScraped !== "auto"
              ? runtimeVariables.get(action.useScraped)
              : runtimeVariables.get("lastSearchKeyword");

            if (targetText) {
              const cleanKeyword = targetText.length > 15 ? targetText.slice(0, 15).trim() : targetText;
              const matchedLoc = page.locator(
                `ul.aw_ul li.aw_li:has-text('${cleanKeyword}') .app_work_box:visible, ul.aw_ul li.aw_li:has-text('${cleanKeyword}') a:visible, li.aw_li:has-text('${cleanKeyword}') a:visible, .app_work_box:has-text('${cleanKeyword}'):visible, ul.lst_vr_ul li a.sub_tp:has-text('${cleanKeyword}'):visible, ul.lst_vr_ul li .sub a:has-text('${cleanKeyword}'):visible, #atclList_list2 a:has-text('${cleanKeyword}'):visible, ul[id*='List'] li a:has-text('${cleanKeyword}'):visible, table tbody tr td.sub a:has-text('${cleanKeyword}'):visible, table tbody tr a:has-text('${cleanKeyword}'):visible, .lst_vr a:has-text('${cleanKeyword}'):visible, a.sub_tp:has-text('${cleanKeyword}'):visible, a[title*='${cleanKeyword}']:visible, a._atcl:has-text('${cleanKeyword}'):visible, a:has-text('${cleanKeyword}'):visible`
              ).first();
              if (await matchedLoc.isVisible().catch(() => false)) {
                console.log(`  [🎯 검색 결과 실시간 매칭] 실제 검색어("${cleanKeyword}")와 일치하는 대상 요소를 클릭 대상으로 자동 연결합니다.`);
                el = matchedLoc;
              } else {
                // 🚨 Canon 3: Active recovery via scroll before giving up
                console.log(`  🔍 [검색 결과 스크롤 탐색] '${cleanKeyword}' 대상 확인을 위해 목록 영역 스크롤을 시도합니다...`);
                await page.mouse.wheel(0, 300).catch(() => {});
                await page.waitForTimeout(500);
                if (await matchedLoc.isVisible().catch(() => false)) {
                  console.log(`  [🎯 검색 결과 스크롤 후 매칭] 스크롤 후 실제 검색어("${cleanKeyword}")와 일치하는 대상을 찾아 연결했습니다.`);
                  el = matchedLoc;
                }
              }
            }

            // 🚨 Canon 3: 무지성 첫 번째 항목 클릭 금지
            // 오직 사용자가 특정 검색어/대상을 지정하지 않은 일반적인 탐색(예: "양식 카드 클릭")인 경우에만 첫 번째 가용 카드 매칭 허용
            if (!el && !targetText) {
              const firstCard = page.locator(
                "ul.aw_ul li.aw_li:first-child .app_work_box:visible, ul.aw_ul li.aw_li:first-child a:visible, li.aw_li:first-child a:visible, .app_work_box:visible, ul.lst_vr_ul li:first-child a.sub_tp:visible, table tbody tr:first-child a:visible"
              ).first();
              if (await firstCard.isVisible().catch(() => false)) {
                console.log(`  [📋 가용 양식 카드 연결] 특정 검색어가 지정되지 않은 일반 카드 선택이므로 첫 번째 가용 카드를 연결합니다.`);
                el = firstCard;
              }
            } else if (!el && targetText) {
              console.warn(`  [🚨 타겟 미발견 - 꼼수 0번 인덱스 클릭 금지] 검색어/대상 "${targetText}"와 일치하는 항목이 결과 목록에 없습니다.`);
            }
          }

          if (isCardWriteBtnAction && !(await isElVisible())) {
            const cardMatch =
              action.selector?.match(/li\.aw_li:has-text\(['"]([^'"]+)['"]\)/) ||
              action.selector?.match(/has-text\(['"]([^'"]+)['"]\)/) ||
              action.description?.match(/['"]([^'"]+)['"]/);
            const rawCardKw = cardMatch ? cardMatch[1].trim() : "";
            const cardKw =
              (rawCardKw && rawCardKw !== "작성" && rawCardKw !== "결재작성" && rawCardKw !== "결재 작성" ? rawCardKw : "") ||
              runtimeVariables.get("lastSearchKeyword") ||
              "";

            const cardBoxSelector = cardKw
              ? `ul.aw_ul li.aw_li:has-text('${cardKw}') .app_work_box:visible, li.aw_li:has-text('${cardKw}'):visible`
              : `ul.aw_ul li.aw_li .app_work_box:visible, .app_work_box:visible`;

            const cardBoxLoc = page.locator(cardBoxSelector).first();
            if (await cardBoxLoc.isVisible().catch(() => false)) {
              console.log(`  [🖱️ 양식 카드 호버 선행] [작성] 버튼(btn_write) 노출을 위해 먼저 양식 카드(${cardKw || "기본"}) 위에 마우스를 올립니다.`);
              await cardBoxLoc.scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => {});
              const cBox = await cardBoxLoc.boundingBox().catch(() => null);
              if (cBox) {
                await page.mouse.move(
                  Math.round(cBox.x + cBox.width / 2),
                  Math.round(cBox.y + cBox.height / 2)
                ).catch(() => {});
              }
              await cardBoxLoc.hover({ timeout: 1500, force: true }).catch(() => {});
              await page.waitForTimeout(450);
            }

            const cardBtnSelector = cardKw
              ? `ul.aw_ul li.aw_li:has-text('${cardKw}') button.btn_write:visible, li.aw_li:has-text('${cardKw}') button.btn.btn_write:visible`
              : `ul.aw_ul li.aw_li button.btn_write:visible, #eapWorkSelect_workList button.btn_write:visible, .app_work_box button.btn_write:visible, li.aw_li button.btn_write:visible, button.btn_write:not(._header_writeBtn):not(#header *):not(.gw_header *):not(#snb *):not(.workset_btn *):not(.gm_reg *):visible`;

            const cardBtn = page.locator(cardBtnSelector).first();
            const isVisible = (await cardBtn.isVisible().catch(() => false)) ||
              (await cardBtn.waitFor({ state: "visible", timeout: 2500 }).then(() => true).catch(() => false));
            if (isVisible) {
              console.log(`  [🎯 결재업무 카드 작성 버튼 매칭] 호버로 노출된 양식 카드 내의 [작성] 버튼을 정확히 연결합니다.`);
              el = cardBtn;
            }
          }

          // Match click on newly created item (AI-generated plans only)
          const isClickCreatedItem =
            !action.recordedByEyedropper &&
            !plan.recordedByEyedropper &&
            (descLower.includes("등록된") || descLower.includes("작성된") || descLower.includes("방금")) &&
            (descLower.includes("제목") || descLower.includes("상세") || descLower.includes("문서") || descLower.includes("글"));

          if (isClickCreatedItem && !(await isElVisible())) {
            const targetText = runtimeVariables.get("lastCreatedKeyword") || runtimeVariables.get("lastCreatedTitle");
            if (targetText) {
              const cleanKeyword = targetText.length > 15 ? targetText.slice(0, 15).trim() : targetText;
              const matchedLoc = page.locator(
                `ul.lst_vr_ul li a.sub_tp:has-text('${cleanKeyword}'):visible, ul.lst_vr_ul li .sub a:has-text('${cleanKeyword}'):visible, #atclList_list2 a:has-text('${cleanKeyword}'):visible, ul[id*='List'] li a:has-text('${cleanKeyword}'):visible, table tbody tr td.sub a:has-text('${cleanKeyword}'):visible, table tbody tr a:has-text('${cleanKeyword}'):visible, .lst_vr a:has-text('${cleanKeyword}'):visible, a.sub_tp:has-text('${cleanKeyword}'):visible, a[title*='${cleanKeyword}']:visible, a._atcl:has-text('${cleanKeyword}'):visible, a:has-text('${cleanKeyword}'):visible`
              ).first();
              if (await matchedLoc.isVisible().catch(() => false)) {
                console.log(`  [🎯 방금 등록된 항목 매칭] 키워드("${cleanKeyword}")와 일치하는 문서 링크를 클릭 대상으로 연결합니다.`);
                el = matchedLoc;
              }
            }
          }

          // 🌟 System Alert/Confirm Layer (#naon-cmm-confirm-ok / #naon-cmm-alert-confirm) Guard:
          // Never allow a missing conditional system confirm/alert to fall back to closing an underlying form/org-chart dialog!
          const isSystemAlertOrConfirmTarget =
            selLower.includes("naon-cmm-confirm-ok") ||
            selLower.includes("naon-cmm-alert-confirm") ||
            selLower.includes("#alert_lyr") ||
            selLower.includes("#confirm_lyr") ||
            Boolean(action.targetHtml && /naon-cmm-(?:confirm-ok|alert-confirm)/i.test(action.targetHtml));

          if (isSystemAlertOrConfirmTarget && !(await isElVisible())) {
            const sysBtn = await findVisibleInPageOrFrames(
              page,
              "button#naon-cmm-confirm-ok:visible, button#naon-cmm-alert-confirm:visible, #confirm_lyr:visible button:has-text('확인'):visible, #alert_lyr:visible button:has-text('확인'):visible"
            );
            if (sysBtn && (await sysBtn.isVisible().catch(() => false))) {
              el = sysBtn;
            } else {
              console.log(
                `  [✨ 시스템 알림/확인창 미발생 자동 통과] '${action.description}' 대상 시스템 알림/확인 레이어가 표시되지 않아 하위 팝업을 닫지 않고 안전하게 통과합니다.`
              );
              moment.timestamp = Date.now() - recordingStart;
              await page.waitForTimeout(300);
              break;
            }
          }

          // 🌟 Universal Tree & Folder Node Selection Auto-Refinement
          const isTreeOpenButton = descLower.includes("버튼") || (action.selector && (action.selector.includes("binderSelBtn") || action.selector.includes("bindBtn") || action.selector.includes("lineSelectBtn")));
          const isTreeSelectAction =
            !isTreeOpenButton &&
            (((descLower.includes("선택") || descLower.includes("클릭")) && (descLower.includes("트리") || descLower.includes("노드"))) ||
             (selLower.includes("dynatree") && !selLower.includes("btn") && !selLower.includes("binder")) ||
             selLower.includes("fancytree") ||
             selLower.includes("treebox"));

          const isSaveOrSubmitConfirm =
            !action.recordedByEyedropper &&
            !plan.recordedByEyedropper &&
            (descLower.includes("확인") || descLower.includes("완료")) &&
            (descLower.includes("저장") || descLower.includes("상신") || descLower.includes("등록"));

          if (isSaveOrSubmitConfirm && !(await isElVisible())) {
            const topDialog = page.locator("#alert_lyr:visible, .ui-dialog:visible, .modal:visible").last();
            const confirmBtn = topDialog.locator(
              "button:text-is('확인'):visible, button.btn_pri:visible, button._confirmBtn:visible, button._confirm:visible, .ui-dialog-buttonpane button:has-text('확인'):not(#userScheduleCheckBtn):visible, button:has-text('확인'):not(#userScheduleCheckBtn):visible, .ui-dialog-buttonpane button:visible"
            ).first();
            if (await confirmBtn.isVisible().catch(() => false)) {
              console.log(`  [🎯 저장/상신 확인 버튼 감지] 최상단 확인 다이얼로그의 [확인] 버튼을 타겟팅합니다.`);
              el = confirmBtn;
            } else {
              const dialogCount = await page.locator(".ui-dialog:visible, #alert_lyr:visible").count().catch(() => 0);
              if (dialogCount === 0) {
                console.log(`  [✨ 저장 확인 불필요] 저장 확인 팝업 없이 즉시 저장 처리되어 확인 단계를 안전하게 통과합니다.`);
                moment.timestamp = Date.now() - recordingStart;
                await page.waitForTimeout(400);
                break;
              }
            }
          }

          const isSystemAlertOrConfirmStep =
            descLower.includes("알림 팝업") ||
            descLower.includes("확인 팝업") ||
            selLower.includes("naon-cmm-alert") ||
            selLower.includes("naon-cmm-confirm") ||
            selLower.includes("#alert_lyr") ||
            selLower.includes("#confirm_lyr");

          const isTreeSelectConfirm =
            !isSystemAlertOrConfirmStep &&
            !isSaveOrSubmitConfirm &&
            (descLower.includes("확인") || descLower.includes("선택 완료") || descLower.includes("적용") || descLower.includes("닫기")) &&
            (descLower.includes("팝업") || descLower.includes("모달") || descLower.includes("대화상자") || descLower.includes("문서함") || descLower.includes("보관함") || descLower.includes("게시판") || descLower.includes("폴더") || descLower.includes("분류") || descLower.includes("트리") || descLower.includes("사원") || descLower.includes("조직도") || descLower.includes("주소록"));

          const hasActiveTreeDialog = (await page.locator(".ui-dialog:visible, .modal:visible, [role='dialog']:visible").count().catch(() => 0)) > 0;

          // 1. If this is a modal confirmation step in an AI-generated plan but the modal is ALREADY CLOSED, pass safely without crashing!
          if (isTreeSelectConfirm && !action.recordedByEyedropper && !plan.recordedByEyedropper && !hasActiveTreeDialog && !(await isElVisible())) {
            console.log(`  [✨ 모달 확인 불필요] 대상 팝업이 이미 정상 종료되어 '${action.description}' 단계를 안전하게 통과합니다.`);
            moment.timestamp = Date.now() - recordingStart;
            await page.waitForTimeout(400);
            break;
          }

          const topTreeDlg = page.locator(".ui-dialog:visible, .modal:visible, [role='dialog']:visible").last();

          // If inside Resource Selection dialog (#resvn_select_lyr) and active tab is '관심' (empty), switch to '시설' tab if target is not visible (AI-generated plans ONLY)
          if (!action.recordedByEyedropper && !plan.recordedByEyedropper && hasActiveTreeDialog && !(await isElVisible())) {
            const interestTabActive = await topTreeDlg
              .locator("#rmgResSelect_nav li.active a[data-value='interest']:visible")
              .isVisible()
              .catch(() => false);
            if (interestTabActive) {
              const meetingTab = topTreeDlg.locator("#rmgResSelect_nav a[data-value='meeting']:visible").first();
              if (await meetingTab.isVisible().catch(() => false)) {
                console.log(`  [🏢 자원 선택 탭 전환] '관심' 탭에 자원이 없어 '시설' 탭으로 전환합니다.`);
                await meetingTab.click({ force: true }).catch(() => {});
                await page.waitForTimeout(800);
                el = await getLocator(page, action);
              }
            }
          }

          if (isTreeSelectAction && !(await isElVisible())) {
            // Expand collapsed folder nodes ONLY (must have .dynatree-has-children or .dynatree-folder, never leaf nodes)
            for (let expPass = 0; expPass < 2; expPass++) {
              const expandBtn = await findVisibleInPageOrFrames(
                page,
                ".ui-dialog:visible button.btn_fopn:visible, .ui-dialog:visible button:has-text('모두펼침'):visible, .ui-dialog:visible #eapBinderSelect_expandTree:visible, .dynatree-node.dynatree-has-children:not(.dynatree-expanded):not([class*='dynatree-exp-e']) > .dynatree-expander:visible, .dynatree-node.dynatree-folder:not(.dynatree-expanded):not([class*='dynatree-exp-e']) > .dynatree-expander:visible"
              );
              if (expandBtn && (await expandBtn.isVisible().catch(() => false))) {
                console.log(`  [📁 트리 펼침] 접혀있는 상위 폴더 노드를 펼쳐 하위 목록을 표시합니다.`);
                await expandBtn.click({ force: true }).catch(() => {});
                await page.waitForTimeout(650);
                el = await getLocator(page, action);
                if (await isElVisible()) break;
              } else {
                break;
              }
            }

            if (!action.recordedByEyedropper && !plan.recordedByEyedropper && !(await isElVisible())) {
              // 🚨 Canon 1 & 3: Check if a specific folder/category was requested
              const categoryMatch = action.description?.match(/['"]([^'"]+)['"]/) ||
                action.description?.match(/([가-힣a-zA-Z0-9_-]{2,})\s*(?:선택|클릭|보관함|문서함|폴더|분류|게시판|트리)/);
              const targetCategory = categoryMatch ? categoryMatch[1].trim() : "";
              const isGenericTreeDesc = !targetCategory || targetCategory.includes("선택") || targetCategory.includes("클릭") || targetCategory.includes("문서함") || targetCategory.includes("보관함") || targetCategory.includes("폴더");
              const wantsCheckbox = descLower.includes("체크") || selLower.includes("checkbox");

              if (!isGenericTreeDesc) {
                const exactCategorySelector = wantsCheckbox
                  ? `.ui-dialog:visible li:has-text('${targetCategory}'):visible span.dynatree-checkbox:visible, .ui-dialog:visible span.dynatree-node:has-text('${targetCategory}'):visible span.dynatree-checkbox:visible, .ui-dialog:visible a.dynatree-title:text-is('${targetCategory}'):visible, .ui-dialog:visible a.dynatree-title:has-text('${targetCategory}'):visible`
                  : `.ui-dialog:visible a.dynatree-title:text-is('${targetCategory}'):visible, .ui-dialog:visible a.dynatree-title:has-text('${targetCategory}'):visible, .ui-dialog:visible span.txt:has-text('${targetCategory}'):visible, .ui-dialog:visible li:has-text('${targetCategory}'):visible span.dynatree-checkbox:visible, .ui-dialog:visible .dynatree-container :has-text('${targetCategory}'):visible`;
                const exactCategoryLoc = page.locator(exactCategorySelector).first();
                if (await exactCategoryLoc.isVisible().catch(() => false)) {
                  console.log(`  [🎯 트리 정확 분류 매칭] 지정된 대상 분류("${targetCategory}")와 일치하는 노드를 연결합니다.`);
                  el = exactCategoryLoc;
                } else {
                  // Try scrolling tree container
                  const treeContainer = page.locator(".ui-dialog:visible .dynatree-container:visible, .ui-dialog:visible .tree_box:visible").first();
                  if (await treeContainer.isVisible().catch(() => false)) {
                    await treeContainer.evaluate((node) => node.scrollTop += 250).catch(() => {});
                    await page.waitForTimeout(400);
                    if (await exactCategoryLoc.isVisible().catch(() => false)) {
                      console.log(`  [🎯 트리 스크롤 후 매칭] 스크롤 후 지정된 분류("${targetCategory}")를 찾아 연결했습니다.`);
                      el = exactCategoryLoc;
                    }
                  }
                }
              }

              if (!el && isGenericTreeDesc) {
                // Target actual binder leaf node (strictly exclude parent folder nodes like .dynatree-folder)
                const leafLoc = page.locator(
                  ".ui-dialog:visible span.dynatree-checkbox:visible, .ui-dialog:visible .dynatree-container ul ul span.dynatree-checkbox:visible, .ui-dialog:visible .dynatree-container .tico_item a.dynatree-title:visible, .ui-dialog:visible .dynatree-container .dynatree-node:not(.dynatree-folder) a.dynatree-title:visible, .ui-dialog:visible .dynatree-container ul ul a.dynatree-title:visible, .ui-dialog:visible a.dynatree-title:has-text('공용 문서보관함'):visible"
                ).first();

                if (await leafLoc.isVisible().catch(() => false)) {
                  el = leafLoc;
                }
              }
            }
          }

          if (isTreeSelectConfirm && !action.recordedByEyedropper && !plan.recordedByEyedropper && !(await isElVisible())) {
            // Target the visible confirm button directly so mouse cursor travels to it in the video
            const confirmBtn = page.locator(
              ".ui-dialog:visible button._confirmBtn:visible, button#eapBinderSelect_confirm:visible, .ui-dialog:visible #eapBinderSelect_confirm, .ui-dialog:visible .ui-dialog-buttonpane button:has-text('확인'):visible, .ui-dialog:visible button.btn_pri:has-text('확인'):visible, .ui-dialog:visible button:has-text('확인'):visible"
            ).first();
            if (await confirmBtn.isVisible().catch(() => false)) {
              el = confirmBtn;
            } else {
              // If confirm button is not visible, check if dialog is already closed!
              const dialogCount = await page.locator(".ui-dialog:visible, .modal:visible").count().catch(() => 0);
              if (dialogCount === 0) {
                console.log(`  [✨ 모달 확인 불필요] 선택 팝업이 이미 정상 종료되어 확인 클릭 단계를 안전하게 통과합니다.`);
                moment.timestamp = Date.now() - recordingStart;
                await page.waitForTimeout(400);
                break;
              }
            }
          }

          // 🌟 Universal Org Chart & User Picker / Approval Line Smart Handler (AI-generated plans ONLY — never hijack Eyedropper actions!)
          const isAdminUserMngContext =
            selLower.includes("orgusermng") ||
            selLower.includes("orgempregform") ||
            selLower.includes("inserempregform") ||
            descLower.includes("사용자 등록 팝업") ||
            descLower.includes("조직관리");
          const isButtonClickDesc =
            descLower.includes("버튼 클릭") ||
            selLower.includes("btnadd") ||
            selLower.includes("adduser");

          const isOrgAction =
            !action.recordedByEyedropper &&
            !plan.recordedByEyedropper &&
            !isAdminUserMngContext &&
            !isButtonClickDesc &&
            (descLower.includes("조직도") ||
             descLower.includes("결재선") ||
             descLower.includes("사원") ||
             descLower.includes("사용자") ||
             descLower.includes("부서") ||
             descLower.includes("합의") ||
             descLower.includes("결재자") ||
             descLower.includes("결재칸") ||
             descLower.includes("결재 칸") ||
             descLower.includes("test00") ||
             selLower.includes("user_info") ||
             (selLower.includes("orguserlist") && !selLower.includes("orgmain_orguserlist"))) &&
            !isTreeSelectConfirm &&
            !isSaveOrSubmitConfirm;

          if (isOrgAction && !(await isElVisible())) {
            const hasModal = (await page.locator(".ui-dialog:visible, .modal:visible, [role='dialog']:visible").count().catch(() => 0)) > 0;
            const topDlg = page.locator(".ui-dialog:visible, .modal:visible, [role='dialog']:visible").last();

            const isExplicitUserTarget =
              selLower.includes("user_info") ||
              (selLower.includes("orguserlist") && !selLower.includes("orgmain_orguserlist")) ||
              descLower.includes("test00") ||
              descLower.includes("사원") ||
              descLower.includes("사용자") ||
              descLower.includes("체크박스");

            // 0) [결재선 선택] 호출 버튼 액션 (팝업 열기)
            const isLineSelectBtn =
              (descLower.includes("결재선 선택") || descLower.includes("결재선 지정") || descLower.includes("결재라인 설정")) &&
              (descLower.includes("버튼") || descLower.includes("호출") || descLower.includes("오픈") || descLower.includes("클릭") || descLower.includes("위해")) &&
              !hasModal;

            if (isLineSelectBtn && !(await isElVisible())) {
              const lineSelectBtn = page.locator("button#eapDocReg_lineSelBtn:visible, button#eapDocReg_lineSelectBtn:visible, button:has-text('결재선 선택'):visible, button:has-text('결재선'):visible").first();
              if (await lineSelectBtn.isVisible().catch(() => false)) {
                console.log(`  [✨ 결재선 선택 버튼 매칭] 기안 폼 상단의 [결재선 선택] 버튼을 타겟팅합니다.`);
                el = lineSelectBtn;
              }
            }

            // 1) 부서 선택 액션 (예: '테스트 부서' 선택 - 사원/체크박스 타겟 제외)
            if (!(await isElVisible()) && !isExplicitUserTarget && descLower.includes("부서") && (descLower.includes("선택") || descLower.includes("클릭"))) {
              const deptMatch = action.description?.match(/['"]([^'"]+)['"]/) || action.description?.match(/([가-힣a-zA-Z0-9]+)\s*부서/);
              const targetDept = deptMatch ? deptMatch[1].trim() : "";

              let deptLoc = targetDept
                ? topDlg.locator(`.dynatree-container a.dynatree-title:text-is('${targetDept}'):visible, .dynatree-container a.dynatree-title:has-text('${targetDept}'):visible`).first()
                : null;
              if (deptLoc && !(await deptLoc.isVisible().catch(() => false))) {
                // Expand collapsed parent folders in org tree first
                const collapsedFolders = topDlg.locator(
                  ".dynatree-node.dynatree-has-children:not(.dynatree-expanded):not([class*='dynatree-exp-e']) > .dynatree-expander:visible, .dynatree-node.dynatree-folder:not(.dynatree-expanded):not([class*='dynatree-exp-e']) > .dynatree-expander:visible"
                );
                const cCount = await collapsedFolders.count().catch(() => 0);
                for (let k = 0; k < Math.min(cCount, 4); k++) {
                  await collapsedFolders.first().click({ force: true }).catch(() => {});
                  await page.waitForTimeout(450);
                }
              }
              if (deptLoc && (await deptLoc.isVisible().catch(() => false))) {
                console.log(`  [🏢 조직도 부서 매칭] 대상 부서("${targetDept}")를 트리에 찾아 연결했습니다.`);
                el = deptLoc;
                // 하위 트리 확장 (expander 클릭)
                try {
                  const parentNode = deptLoc.locator("xpath=ancestor::span[contains(@class, 'dynatree-node')]").first();
                  const expander = parentNode.locator(".dynatree-expander").first();
                  if (await expander.isVisible().catch(() => false)) {
                    const isExpanded = await parentNode.evaluate((node) => node.classList.contains("dynatree-expanded")).catch(() => false);
                    if (!isExpanded) {
                      console.log(`  [📂 부서 하위 펼침] '${targetDept}' 부서의 하위 트리를 펼칩니다.`);
                      await expander.click().catch(() => {});
                      await page.waitForTimeout(500);
                    }
                  }
                } catch (err) {}
              } else if (targetDept) {
                // Try scrolling the tree container
                const treeContainer = topDlg.locator(".dynatree-container:visible, .tree_box:visible").first();
                if (await treeContainer.isVisible().catch(() => false)) {
                  await treeContainer.evaluate((node) => node.scrollTop += 250).catch(() => {});
                  await page.waitForTimeout(400);
                  if (deptLoc && (await deptLoc.isVisible().catch(() => false))) {
                    el = deptLoc;
                  }
                }
              }

              // 🚨 Canon 3: 특정 부서가 지정되지 않은 일반 부서 선택 시에만 가용 부서 연결
              if (!(await isElVisible()) && !targetDept) {
                const anyDept = topDlg.locator(".dynatree-container .dynatree-node:not(.dynatree-folder) a.dynatree-title:visible, .dynatree-container li li a.dynatree-title:visible, .dynatree-container a.dynatree-title:visible").first();
                if (await anyDept.isVisible().catch(() => false)) {
                  console.log(`  [⚡ 조직도 부서 연결] 일반 부서 선택이므로 가용 부서 노드를 연결합니다.`);
                  el = anyDept;
                }
              } else if (!(await isElVisible()) && targetDept) {
                console.warn(`  [🚨 부서 미발견 - 꼼수 0번 인덱스 클릭 금지] 지정된 부서 "${targetDept}"가 조직도 트리에 존재하지 않습니다.`);
              }
            }

            // 2) 합의 버튼 액션 (예: '첫번째 합의 버튼 선택')
            if (!(await isElVisible()) && descLower.includes("합의")) {
              const agreeBtn = topDlg.locator("button:has-text('합의'):visible, button._addAgreeBtn:visible, button[title*='합의']:visible").first();
              if (await agreeBtn.isVisible().catch(() => false)) {
                console.log(`  [🤝 결재선 합의 버튼 매칭] 조직도 내 [합의] 버튼을 타겟팅합니다.`);
                el = agreeBtn;
              }
            }

            // 3) 결재자 배치 / 결재칸 추가 액션 (예: 'test002 두번째 결재칸으로 드래그 앤 드롭' 또는 '결재칸으로 지정')
            if (!(await isElVisible()) && (descLower.includes("결재칸") || descLower.includes("결재 칸") || descLower.includes("드래그") || (descLower.includes("결재") && descLower.includes("배치")))) {
              const approverBtn = topDlg.locator("button:has-text('결재'):visible, button:has-text('추가'):visible, button._addApprBtn:visible, button.btn_rgt:visible").first();
              if (await approverBtn.isVisible().catch(() => false)) {
                console.log(`  [📥 결재선 배치 버튼 매칭] 조직도 내 [결재/추가] 버튼을 타겟팅합니다.`);
                el = approverBtn;
              } else {
                const lineSlot = topDlg.locator("table.tbl_lst tbody tr:nth-child(2), [class*='line'] tr:nth-child(2), .app_line_list li:nth-child(2)").first();
                if (await lineSlot.isVisible().catch(() => false)) {
                  console.log(`  [📥 결재선 2번째 슬롯 매칭] 결재선 테이블의 2번째 칸을 타겟팅합니다.`);
                  el = lineSlot;
                }
              }
            }

            // 4) 사원 / 사용자 선택 액션 (예: 'test001 체크박스 선택', 'test002 테스트 부서 (유니슨) 체크박스 클릭')
            const isLineOpenAction = (descLower.includes("결재선 선택") || descLower.includes("결재선 지정")) && (descLower.includes("버튼") || descLower.includes("호출") || descLower.includes("오픈"));
            const isUserSelect = !(await isElVisible()) && !isLineOpenAction && isExplicitUserTarget && !descLower.includes("합의");
            if (isUserSelect) {
              // 따옴표 우선 매칭 ('test001', 'test002 테스트 부서 (유니슨)') -> 첫 토큰('test002') 추출로 검색 호환성 보장
              const stopWords = new Set([
                "사원", "목록", "팝업", "선택", "체크", "체크박스", "부서", "버튼", "사용자", "결재선",
                "첫번째", "두번째", "두번쨰", "결재", "합의", "추가", "설정", "호출", "지정", "라인",
                "영역", "관리", "화면", "전환", "배치", "이동", "열기", "닫기", "등록", "수정",
                "삭제", "입력", "작성", "확인", "취소", "상신", "임시저장", "대화상자", "모달", "레이어",
                "트리", "오픈", "위해", "저장", "그룹웨어", "모바일", "전자결재", "라이선스"
              ]);
              let targetUser = "";
              const testMatch = (action.description || action.selector || "").match(/(test\d+)/i);
              if (testMatch) {
                targetUser = testMatch[1].trim();
              } else {
                const quotedMatch = action.description?.match(/['"]([^'"]+)['"]/);
                const quotedCandidate = quotedMatch ? quotedMatch[1].trim().split(/\s+/)[0] : "";
                if (quotedCandidate && !stopWords.has(quotedCandidate)) {
                  targetUser = quotedCandidate;
                } else {
                  const words = action.description?.match(/([가-힣]{2,4}|[a-zA-Z0-9_-]{3,})/g) || [];
                  for (const w of words) {
                    if (!stopWords.has(w)) {
                      targetUser = w;
                      break;
                    }
                  }
                }
              }
              const isSecondUser = descLower.includes("test002") || descLower.includes("두번째") || descLower.includes("두 번째");

              let userLoc: Locator | null = null;
              if (targetUser) {
                // 0) 먼저 우측 사원 목록(#orgUserList)에 해당 사용자가 이미 표시되어 있는지 확인
                const listUserLoc = topDlg.locator(
                  `label.user_info:has-text('${targetUser}'):visible, ul#orgUserList li:has-text('${targetUser}') label:visible, ul#orgUserList li:has-text('${targetUser}') input[type='checkbox']:visible`
                ).first();
                if (await listUserLoc.isVisible().catch(() => false)) {
                  userLoc = listUserLoc;
                  console.log(`  [✨ 조직도 사원 목록 매칭] 우측 사원 목록에서 대상 사원("${targetUser}")을 연결했습니다.`);
                }
              }

              if (!userLoc && targetUser) {
                // 1) 트리에서 타겟 사원 직접 탐색 (부서가 닫혀있으면 트리 펼침 시도)
                let userNode = topDlg.locator(`.dynatree-node:has(a:has-text('${targetUser}'))`).first();
                if (!await userNode.isVisible().catch(() => false)) {
                  const expanders = topDlg.locator(
                    ".dynatree-node.dynatree-has-children:not(.dynatree-expanded):not([class*='dynatree-exp-e']) > .dynatree-expander:visible"
                  );
                  const expCount = await expanders.count().catch(() => 0);
                  for (let i = 0; i < Math.min(expCount, 4); i++) {
                    await expanders.first().click({ timeout: 500, force: true }).catch(() => {});
                    await page.waitForTimeout(450);
                  }
                  userNode = topDlg.locator(`.dynatree-node:has(a:has-text('${targetUser}'))`).first();
                }

                if (await userNode.isVisible().catch(() => false)) {
                  if (descLower.includes("체크") || descLower.includes("체크박스")) {
                    userLoc = userNode.locator(".dynatree-checkbox").first();
                  } else {
                    userLoc = userNode.locator("a.dynatree-title").first();
                  }
                  console.log(`  [✨ 조직도 트리 사원 매칭] 트리에서 대상 사원("${targetUser}")의 ${descLower.includes("체크") ? "체크박스" : "노드"}를 연결했습니다.`);
                }
              }

              // 2) 🚨 능동적 복구: 트리에서 안 보이면 조직도 검색창을 통해 검색!
              if (!userLoc && targetUser && hasModal) {
                const searchInput = topDlg.locator("input#orgSearchWord:visible, .srch_bar input[type='text']:visible, input[placeholder*='검색']:visible, input[placeholder*='이름']:visible, input[placeholder*='사원']:visible, #searchWord:visible, input.input_txt:visible").first();
                const searchBtn = topDlg.locator("button#orgSearchBtn:visible, .srch_bar button.btn_ico:visible, button.btn_srch:visible, button[title='검색']:visible, button:has-text('검색'):visible, .ico_srch:visible, button.btn_search:visible").first();

                if (await searchInput.isVisible().catch(() => false)) {
                  console.log(`  🔍 [조직도 스마트 검색 가동] 대상 사용자("${targetUser}")를 찾기 위해 조직도 검색창에 검색을 실행합니다...`);
                  await searchInput.click().catch(() => {});
                  await searchInput.fill(targetUser).catch(() => {});
                  if (await searchBtn.isVisible().catch(() => false)) {
                    await searchBtn.click().catch(() => {});
                  } else {
                    await searchInput.press("Enter").catch(() => {});
                  }
                  await page.waitForTimeout(800);

                  // 검색 결과에서 체크박스 또는 사원 노드 특정 (체크박스 우선!)
                  const searchChk = topDlg.locator(`
                    label.user_info:has-text('${targetUser}'):visible,
                    li:has-text('${targetUser}') input[type='checkbox']:visible,
                    li:has-text('${targetUser}') .dynatree-checkbox:visible,
                    .dynatree-node:has(a:has-text('${targetUser}')) .dynatree-checkbox:visible,
                    label:has-text('${targetUser}') input[type='checkbox']:visible,
                    div:has-text('${targetUser}') input[type='checkbox']:visible
                  `).first();

                  if (await searchChk.isVisible().catch(() => false)) {
                    console.log(`  [✨ 조직도 검색 성공] 검색된 사원("${targetUser}")의 체크박스를 찾아 연결했습니다!`);
                    userLoc = searchChk;
                  } else {
                    const searchItem = topDlg.locator(`
                      .dynatree-node:has(a:has-text('${targetUser}')) a.dynatree-title:visible,
                      li:has-text('${targetUser}'):visible,
                      label.user_info:has-text('${targetUser}'):visible
                    `).first();
                    if (await searchItem.isVisible().catch(() => false)) {
                      console.log(`  [✨ 조직도 검색 성공] 검색된 사원("${targetUser}") 노드를 찾아 연결했습니다!`);
                      userLoc = searchItem;
                    }
                  }
                }
              }

              // 🚨 능동적 복구: 여전히 없으면 사용자 목록 영역 스크롤 시도!
              if (!userLoc && targetUser) {
                const userListContainer = topDlg.locator("#orgUserList_listbox, .org_user_lst, .user_lst_box, ul[class*='user']:visible").first();
                if (await userListContainer.isVisible().catch(() => false)) {
                  console.log(`  🔍 [조직도 스크롤 탐색] 대상 사용자("${targetUser}")를 찾기 위해 목록 스크롤을 시도합니다...`);
                  await userListContainer.evaluate((node) => node.scrollTop += 300).catch(() => {});
                  await page.waitForTimeout(400);
                  const scrolledLoc = topDlg.locator(`label.user_info:has-text('${targetUser}'):visible, li:has-text('${targetUser}'):visible, tr:has-text('${targetUser}'):visible`).first();
                  if (await scrolledLoc.isVisible().catch(() => false)) {
                    console.log(`  [✨ 조직도 스크롤 탐색 성공] 스크롤 후 대상 사원("${targetUser}")을 찾아 연결했습니다!`);
                    userLoc = scrolledLoc;
                  }
                }
              }

              // 🚨 Canon 3: 무지성 첫 번째 항목 클릭 금지 (STRICT BAN ON FALSE POSITIVE)
              // 대상 사원(targetUser)이 지정되어 있는데 검색과 스크롤로도 찾지 못했다면:
              // 절대로 임의의 0번/1번 인덱스를 몰래 클릭해 성공한 척하지 말고, 정직하게 에러를 던져 중단!
              if (!userLoc) {
                if (targetUser) {
                  console.error(`  [🚨 정직한 실패 리포팅] 조직도에서 지정된 대상 사원 "${targetUser}"을(를) 검색 및 스크롤 후에도 찾을 수 없습니다. (무지성 첫 번째 항목 클릭 금지 행동 강령 준수)`);
                  throw new Error(`지정된 대상 사원 '${targetUser}'을(를) 조직도에서 찾을 수 없어 실패했습니다.`);
                } else {
                  // 특정 이름이 전혀 명시되지 않은 일반적인 사원 선택인 경우에만 가용 사원 연결 허용
                  const userIndex = isSecondUser ? 1 : 0;
                  const allUsers = topDlg.locator("label.user_info.chkbox:visible, label[class*='user_info']:visible, span.dynatree-checkbox:visible, #orgUserList_listbox label.user_info:visible, .org_user_lst li:visible, [id^='user_']:visible, .user_card:visible");
                  const count = await allUsers.count().catch(() => 0);
                  if (count > 0) {
                    const pickIndex = Math.min(userIndex, count - 1);
                    userLoc = allUsers.nth(pickIndex);
                    console.log(`  [⚡ 가용 사원 선택] 특정 대상이 명시되지 않은 일반 사원 선택이므로 가용 사원(인덱스: ${pickIndex})을 연결합니다.`);
                  }
                }
              }

              if (userLoc) {
                el = userLoc;
              }
            }
          }

          if (!el) {
            el = await trySelfHealAction(moments, recordingStart, page, action, momentId, plan, dataDir);
          }
          if (!el) {
            if (canSafelySkipFailedAction(action, momentId, plan.actions.length, (action as any)._lastHealReason) || (action as any)._wasSkipped) {
              markActionAndFollowupWaitForPruning(plan, actionIdx, action);
              console.log(`  [⚠️ 비필수 부가 단계 자동 스킵] 요소를 찾을 수 없으나 필수 핵심 단계가 아니므로 안전하게 통과합니다: ${action.description}`);
              break;
            }
            throw new Error(`요소를 찾을 수 없습니다: ${action.selector}`);
          }

          // 1. Wait for element to become visible on the screen
          const waitTimeout = isOptionalOrSub ? 2500 : (momentId >= plan.actions.length - 2) ? 3000 : 3500;
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

            if (!resolvedViaLabel && !action.recordedByEyedropper && !plan.recordedByEyedropper) {
              // Intelligent Runtime Semantic Fallback based on action.description (AI-generated plans ONLY!)
              const desc = action.description || "";
              let fallbackLoc: Locator | null = null;

              if (desc.includes("확인") || desc.includes("적용") || desc.includes("선택 완료")) {
                fallbackLoc = page.locator(".ui-dialog:visible .ui-dialog-buttonpane button:has-text('확인'):visible, .ui-dialog:visible button:has-text('확인'):visible, .modal:visible button:has-text('확인'):visible, [role='dialog']:visible button:has-text('확인'):visible, button:has-text('확인'):visible").first();
              } else if (desc.includes("저장") || desc.includes("상신") || desc.includes("등록") || desc.includes("발행") || desc.includes("완료")) {
                fallbackLoc = page.locator("button:has-text('저장'):visible, button:has-text('상신'):visible, button:has-text('등록'):visible, button.btn_save:visible, button.btn_submit:visible, button.btn_pri:visible, input[type='submit']:visible").first();
              } else if (desc.includes("닫기") || desc.includes("취소")) {
                fallbackLoc = page.locator(".ui-dialog:visible button:has-text('닫기'):visible, .ui-dialog:visible button:has-text('취소'):visible, button:has-text('닫기'):visible, button:has-text('취소'):visible, button.btn_close:visible").first();
              } else if (desc.includes("추가") || desc.includes("선택") || desc.includes("조직도") || desc.includes("주소록")) {
                fallbackLoc = page.locator(".ui-dialog:visible button:has-text('추가'):visible, .ui-dialog:visible button:has-text('선택'):visible, button:has-text('추가'):visible, button:has-text('조직도'):visible, button.btn_add:visible").first();
              }

              if (fallbackLoc && (await fallbackLoc.isVisible().catch(() => false))) {
                console.log(`  [✨ 지능형 런타임 복구] '${action.description}'에 맞는 실제 화면 요소를 감지하여 자동 복구했습니다.`);
                el = fallbackLoc;
                resolvedViaLabel = true;
              }
            }

            // 🚨 Trigger AI Runtime Self-Healing if still not found!
            if (!resolvedViaLabel) {
              const healed = await trySelfHealAction(moments, recordingStart, page, action, momentId, plan, dataDir);
              if (healed) {
                el = healed;
                resolvedViaLabel = true;
              }
            }

            if (!resolvedViaLabel) {
              if (canSafelySkipFailedAction(action, momentId, plan.actions.length, (action as any)._lastHealReason) || (action as any)._wasSkipped) {
                markActionAndFollowupWaitForPruning(plan, actionIdx, action);
                console.log(`  [⚠️ 비필수 부가 단계 자동 스킵] 요소가 화면에 표시되지 않으나 필수 핵심 단계가 아니므로 안전하게 스킵합니다: ${action.description}`);
                break;
              }
              throw new Error(`요소가 화면에 표시되지 않습니다 (${waitTimeout}ms 초과): ${action.selector}`);
            }
          }

          await el.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => { });
          const isEyedropperClick = Boolean(action.recordedByEyedropper || plan.recordedByEyedropper);
          const { locator: targetEl, box } = await resolveAtomicTarget(el, false, action.description, isEyedropperClick);
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

          // Pre-submit guard: ensure required table fields are filled before clicking draft submit (only for AI-generated plans, never Eyedropper!)
          const isDraftSubmitAction =
            (descLower.includes("상신") || selLower.includes("_draft")) &&
            !descLower.includes("확인") &&
            !descLower.includes("팝업") &&
            !descLower.includes("모달") &&
            !selLower.includes("confirm") &&
            !selLower.includes("alert");

          if (isDraftSubmitAction && !action.recordedByEyedropper && !plan.recordedByEyedropper) {
            await page.evaluate(() => {
              const todayStr = new Date().toISOString().split("T")[0];
              document.querySelectorAll("input.hasDatepicker, input[type='date'], input[id*='date'], input[name*='date'], input[placeholder*='yyyy'], input[placeholder*='YYYY']").forEach((inp: any) => {
                if (!inp.value || inp.value.trim() === "") {
                  inp.value = todayStr;
                  inp.dispatchEvent(new Event("input", { bubbles: true }));
                  inp.dispatchEvent(new Event("change", { bubbles: true }));
                }
              });
              document.querySelectorAll("table.tbl_frm tr, .doc_view_table tr").forEach((tr) => {
                const text = tr.textContent || "";
                if (text.includes("일자") || text.includes("년월일") || text.includes("일시") || text.includes("날짜")) {
                  tr.querySelectorAll("input").forEach((inp: any) => {
                    if (!inp.value || inp.value.trim() === "") {
                      inp.value = todayStr;
                      inp.dispatchEvent(new Event("input", { bubbles: true }));
                      inp.dispatchEvent(new Event("change", { bubbles: true }));
                    }
                  });
                }
                tr.querySelectorAll("input[type='text'], input:not([type]), textarea").forEach((inp: any) => {
                  if (!inp.value || inp.value.trim() === "") {
                    inp.value = inp.tagName === "TEXTAREA" ? "금일 회의 완료" : "회의 완료";
                    inp.dispatchEvent(new Event("input", { bubbles: true }));
                    inp.dispatchEvent(new Event("change", { bubbles: true }));
                  }
                });
              });
            }).catch(() => {});
          }

          // Guard against collapsing an already-expanded Dynatree folder when clicking .dynatree-expander
          let skipRedundantExpanderClick = false;
          if (selLower.includes("dynatree-expander") && !descLower.includes("접기") && !descLower.includes("축소")) {
            skipRedundantExpanderClick = await el.evaluate((node) => {
              const parent = node.closest(".dynatree-node");
              return Boolean(
                parent &&
                (parent.classList.contains("dynatree-expanded") ||
                  parent.className.includes("dynatree-exp-e"))
              );
            }).catch(() => false);
            if (skipRedundantExpanderClick) {
              console.log(`  [📂 트리 펼침 유지] 대상 트리 노드가 이미 펼쳐진 상태이므로 재클릭으로 인한 접힘을 방지합니다.`);
            }
          }

          // Pre-clean duplicate folder in Filebox if [새폴더] is about to create a folder that already exists from demonstration/previous run
          if (selLower.includes("_btn_newfolder") || descLower.includes("새폴더")) {
            const upcomingFolderType = plan.actions
              .slice(actionIdx + 1, actionIdx + 4)
              .find((a) => a.type === "type" && a.text && a.text.trim().length > 0);
            if (upcomingFolderType?.text) {
              const targetFolderName = upcomingFolderType.text.trim();
              const cleaned = await page.evaluate(async (fName) => {
                const w = window as any;
                if (!w.jQuery || !w.naon?.http?.ajax) return false;
                const $ = w.jQuery;
                let matchedChk: any = null;
                $("#fbxList_listStyle tr").each(function (this: HTMLElement) {
                  const $a = $(this).find("a._folder");
                  if ($a.length && $a.text().trim() === fName) {
                    const $chk = $(this).find("input.lst_chk._folderChk");
                    if ($chk.length) matchedChk = $chk;
                  }
                });
                if (!matchedChk) return false;
                const folderIds = [matchedChk.data("folderId")];
                const rootType =
                  ($("#fbxList_parentFolderId").val() || "").split("/")[1] ||
                  matchedChk.data("rootType") ||
                  "root_my";
                const parentFolderId = matchedChk.data("parentFolderId") || "root_my";
                const urlType = w.GW?.LOCAL?.fbxList?.urlType || w.fbxList?.urlType || "";
                await new Promise<void>((resolve) => {
                  w.naon.http.ajax({
                    url: "/inc/fbx/fbx" + urlType + "Delete",
                    data: { rootType, parentFolderId, folderIds, fileIds: [] },
                    contentType: "application/json; charset=utf-8",
                    dataType: "json",
                    success: () => resolve(),
                    error: () => resolve(),
                  });
                });
                try {
                  const returnData = w.GW?.LOCAL?.fbxList?.fn?.setDeleteObserverData?.() || {
                    reloadYn: "N",
                    rootTypeVal: rootType,
                    parentFolderIdVal: parentFolderId,
                    folderId: parentFolderId,
                  };
                  if (w.ObserverControl) {
                    w.ObserverControl.notifyObservers({
                      type: "NOTIFY_ON_TREE_RELOAD",
                      data: { folderId: parentFolderId, parentReload: "" },
                    });
                    w.ObserverControl.notifyObservers({
                      type: "NOTIFY_DRAW_FILE_LIST",
                      data: returnData,
                    });
                  }
                } catch {}
                return true;
              }, targetFolderName).catch(() => false);
              if (cleaned) {
                console.log(`  [🧹 기존 중복 폴더 사전 정리] 시연 중 생성된 '${targetFolderName}' 폴더를 사전 정리하여 클린 생성을 보장합니다.`);
                await page.waitForTimeout(600);
              }
            }
          }

          // Pre-intercept explicit Logout button click so clicking '로그아웃' does NOT invalidate the saved admin session (auth.json) on the server!
          const isPreLogoutClick =
            descLower.includes("로그아웃") ||
            selLower.includes("btn_logout") ||
            selLower.includes("gologout");
          const isPreLoginClick =
            selLower.includes("btnlogin") ||
            descLower.includes("'login' 버튼");
          if (isPreLogoutClick) {
            await el.evaluate((node) => {
              node.removeAttribute("onclick");
              if (node instanceof HTMLAnchorElement) {
                node.href = "javascript:void(0);";
              }
              const w = window as any;
              if (w.GW?.LOCAL?.GwMainMenu?.fn) {
                w.GW.LOCAL.GwMainMenu.fn.goLogout = () => {};
              }
              if (w.GwMainMenu?.fn) {
                w.GwMainMenu.fn.goLogout = () => {};
              }
            }).catch(() => {});
          } else if (isPreLoginClick) {
            await page.evaluate(() => {
              try {
                sessionStorage.setItem("__studio_iam_login_submitted__", "1");
              } catch {}
            }).catch(() => {});
          }

          // 4. 즉시 실제 클릭 실행 (마커와 동시에 브라우저에서 실행됨)
          const clickTimeout = (momentId >= plan.actions.length - 2) ? 2000 : 3500;
          if (!skipRedundantExpanderClick) {
            try {
              const targetTagName = await el.evaluate((e) => e.tagName.toLowerCase()).catch(() => "");
              const selectOptMatch =
                action.text ||
                action.description?.match(/에서\s*['"]([^'"]+)['"]\s*선택/)?.[1] ||
                "";
              if (targetTagName === "select" && selectOptMatch) {
                console.log(`  [DEBUG] selectOption("${selectOptMatch}") starts.`);
                const t1 = Date.now();
                await el
                  .selectOption({ label: selectOptMatch }, { timeout: clickTimeout })
                  .catch(() => el!.selectOption(selectOptMatch, { timeout: clickTimeout }));
                console.log(`  [DEBUG] selectOption done. took ${Date.now() - t1}ms`);
              } else {
                console.log(`  [DEBUG] click starts. timeout=${clickTimeout}, force=${action.force}`);
                const t1 = Date.now();
                if (isDisabled) {
                  await el.click({ timeout: 3000, force: true }).catch(() => { });
                } else {
                  await el.click({ timeout: clickTimeout, force: action.force ?? false });
                }
                console.log(`  [DEBUG] click done. took ${Date.now() - t1}ms`);
              }
            } catch (clickErr: any) {
              console.log(`  [DEBUG] click failed: ${clickErr.message}`);
              const isInterceptedByOverlay = clickErr.message?.includes("intercepted") || clickErr.message?.includes("overlay");
              if (isInterceptedByOverlay) {
                console.log(`  [🛡️ 오버레이 차단 감지] 화면 팝업/모달 오버레이가 클릭을 가로막고 있습니다. 배경 강제 클릭을 중단하고 팝업 복구/자가 치유로 전환합니다.`);
                const unblocked = await autoRecoverActiveModals(page, action, moments, recordingStart);
                if (unblocked) {
                  const newEl = await getLocator(page, action);
                  if (newEl && await newEl.isVisible().catch(() => false)) {
                    el = newEl;
                    await el.click({ timeout: 3000 }).catch(() => {});
                  }
                } else {
                  const healed = await trySelfHealAction(moments, recordingStart, page, action, momentId, plan, dataDir);
                  if (healed) {
                    el = healed;
                    await healed.click({ timeout: 3000, force: true }).catch(() => {});
                  } else if (canSafelySkipFailedAction(action, momentId, plan.actions.length, (action as any)._lastHealReason) || (action as any)._wasSkipped) {
                    markActionAndFollowupWaitForPruning(plan, actionIdx, action);
                    console.log(`  [⚠️ 비필수 부가 단계 자동 스킵] 오버레이 차단으로 클릭할 수 없으나 부가 단계이므로 안전하게 스킵합니다: ${action.description}`);
                    break;
                  }
                }
              } else {
                // Non-optional fallback: try DOM dispatchEvent("click")
                try {
                  console.log(`  [DEBUG] fallback click force=true starts`);
                  const t2 = Date.now();
                  await el.click({ timeout: 2500, force: true });
                  console.log(`  [DEBUG] fallback click done. took ${Date.now() - t2}ms`);
                } catch {
                  try {
                    await el.dispatchEvent("click", undefined, { timeout: 1000 });
                  } catch {
                    // Trigger AI Self-Healing if click itself completely fails!
                    console.log(`  [DEBUG] dispatchEvent failed. trySelfHealAction starts`);
                    const t3 = Date.now();
                    const healed = await trySelfHealAction(moments, recordingStart, page, action, momentId, plan, dataDir);
                    console.log(`  [DEBUG] trySelfHealAction done. took ${Date.now() - t3}ms`);
                    if (healed) {
                      el = healed;
                      await healed.click({ timeout: 3000, force: true }).catch(() => healed.dispatchEvent("click", undefined, { timeout: 1000 }));
                    } else {
                      if (canSafelySkipFailedAction(action, momentId, plan.actions.length, (action as any)._lastHealReason) || (action as any)._wasSkipped) {
                        markActionAndFollowupWaitForPruning(plan, actionIdx, action);
                        console.log(`  [⚠️ 비필수 부가 단계 자동 스킵] 클릭을 수행하지 못했으나 필수 핵심 단계가 아니므로 안전하게 스킵합니다: ${action.description}`);
                        break;
                      }
                      throw clickErr;
                    }
                  }
                }
              }
            }
          }

          // If this click happened inside a real child popup window (pageStack.length > 1) and triggered window.close()
          if (
            page.isClosed() ||
            (pageStack.length > 1 &&
              (descLower.includes("확인") ||
                descLower.includes("닫기") ||
                descLower.includes("적용") ||
                descLower.includes("선택") ||
                selLower.includes("confirm") ||
                selLower.includes("close")))
          ) {
            await new Promise((r) => setTimeout(r, 350));
            if (page.isClosed()) {
              while (pageStack.length > 1 && pageStack[pageStack.length - 1].isClosed()) {
                pageStack.pop();
              }
              page = pageStack[pageStack.length - 1] || context.pages().find((p) => !p.isClosed()) || page;
              await page.bringToFront().catch(() => {});
              break;
            }
          }

          // Ensure custom radio button labels (e.g. label.rdobtn / label.wiki_sub_box) reliably check their child input[type='radio'] and update .rdobtn_on
          if (
            selLower.includes("rdobtn") ||
            selLower.includes("wiki_sub_box") ||
            selLower.includes("type='radio'") ||
            (action.targetHtml && (action.targetHtml.includes("rdobtn") || action.targetHtml.includes('type="radio"')))
          ) {
            try {
              await el.evaluate(
                (node) => {
                  const label =
                    node.tagName.toLowerCase() === "label"
                      ? (node as HTMLLabelElement)
                      : (node.closest("label.rdobtn, label.wiki_sub_box, label[for]") as HTMLLabelElement | null);
                  const rawRdo =
                    node.tagName.toLowerCase() === "input" && (node as HTMLInputElement).type === "radio"
                      ? (node as HTMLInputElement)
                      : ((label?.querySelector("input[type='radio']") ||
                          (label?.htmlFor ? document.getElementById(label.htmlFor) : null)) as HTMLInputElement | null);
                  const rdo = rawRdo && rawRdo.tagName?.toLowerCase() === "input" && rawRdo.type === "radio" ? rawRdo : null;
                  if (rdo) {
                    const groupName = rdo.getAttribute("name");
                    if (groupName) {
                      document.querySelectorAll(`input[type='radio'][name='${groupName}']`).forEach((other) => {
                        if (other !== rdo) {
                          (other as HTMLInputElement).checked = false;
                          other.closest("label.rdobtn")?.classList.remove("rdobtn_on");
                        }
                      });
                    }
                    if (!rdo.checked || (label && label.classList.contains("rdobtn") && !label.classList.contains("rdobtn_on"))) {
                      rdo.checked = true;
                      if (label && label.classList.contains("rdobtn")) {
                        label.classList.add("rdobtn_on");
                      }
                      const w = window as any;
                      if (w.jQuery) {
                        w.jQuery(rdo).prop("checked", true).trigger("change");
                      } else {
                        rdo.dispatchEvent(new Event("change", { bubbles: true }));
                      }
                    }
                  }
                },
                undefined,
                { timeout: 300 }
              );
            } catch {}
          }

          // If a DynaTree folder title (e.g. '유니슨', '테스트 부서') was clicked in an AI plan and remains collapsed, expand its .dynatree-expander so child nodes become visible
          if (!action.recordedByEyedropper && !plan.recordedByEyedropper && (selLower.includes("dynatree-title") || descLower.includes("부서"))) {
            try {
              const parentNode = el.locator("xpath=ancestor::span[contains(@class, 'dynatree-node')]").first();
              if (await parentNode.isVisible().catch(() => false)) {
                const shouldExpand = await parentNode.evaluate((node) => {
                  const cls = node.className || "";
                  const isFolder = cls.includes("dynatree-folder") || cls.includes("dynatree-has-children") || cls.includes("dynatree-lazy");
                  const isExpanded = cls.includes("dynatree-expanded") || cls.includes("dynatree-exp-e") || cls.includes("dynatree-exp-el");
                  return isFolder && !isExpanded;
                }).catch(() => false);
                if (shouldExpand) {
                  const expander = parentNode.locator(".dynatree-expander").first();
                  if (await expander.isVisible().catch(() => false)) {
                    console.log(`  [📂 트리 폴더 하위 펼침] 클릭한 폴더 노드의 하위 항목 노출을 위해 확장 아이콘(.dynatree-expander)을 함께 클릭합니다.`);
                    await expander.click({ force: true }).catch(() => {});
                    await page.waitForTimeout(600);
                  }
                }
              }
            } catch {}
          }

          // Handle jQuery UI Datepicker & Timepicker inputs: keep popup visible briefly for video feedback, then close floating overlay so it doesn't cover subsequent fields (do NOT overwrite with stale lastval!)
          const isDateOrTimeInput =
            /date(?!r)|datepicker/i.test(selLower) ||
            selLower.includes("hourminute") ||
            selLower.includes("timepicker") ||
            (action.targetHtml && (action.targetHtml.includes("hasDatepicker") || action.targetHtml.includes("ui-timepicker-input")));

          if (isDateOrTimeInput) {
            let nextNonWait: BrowsePlanAction | null = null;
            for (let k = actionIdx + 1; k < plan.actions.length; k++) {
              if (plan.actions[k].type !== "wait") {
                nextNonWait = plan.actions[k];
                break;
              }
            }
            const nextSel = (nextNonWait?.selector || "").toLowerCase();
            const nextIsPickerItemClick =
              nextNonWait?.type === "click" &&
              (nextSel.includes("ui-datepicker") || nextSel.includes("ui-timepicker") || (nextNonWait?.description || "").includes("달력 팝업") || (nextNonWait?.description || "").includes("시간 선택"));

            if (!nextIsPickerItemClick) {
              await page.waitForTimeout(350);

              // Only auto-pick Saturday / 10:00 for AI-generated plans where the user didn't record an explicit date/time selection!
              if (!action.recordedByEyedropper && !plan.recordedByEyedropper) {
                // If datepicker opened (e.g. startDate1 / endDate1), click the Saturday cell of the current week so the schedule is placed on a conflict-free future day visible on the weekly calendar
                const isDatePickerVisible = await page.locator("#ui-datepicker-div:visible").isVisible().catch(() => false);
                if (isDatePickerVisible) {
                  let targetDay = runtimeVariables.get("scheduleSlotDay") || "";
                  if (!targetDay) {
                    targetDay = await page.evaluate(() => {
                      const dp = document.getElementById("ui-datepicker-div");
                      if (!dp) return "";
                      const todayCell = dp.querySelector("td.ui-datepicker-today, td.ui-datepicker-current-day");
                      const tr = todayCell?.closest("tr");
                      if (tr) {
                        const cells = Array.from(tr.querySelectorAll("td"));
                        const lastCell = cells[cells.length - 1];
                        if (lastCell && lastCell !== todayCell) {
                          const a = lastCell.querySelector("a");
                          if (a && a.textContent) return a.textContent.trim();
                        }
                        const nextTr = tr.nextElementSibling;
                        if (nextTr) {
                          const nextCells = Array.from(nextTr.querySelectorAll("td a"));
                          if (nextCells.length > 0) {
                            return (nextCells[nextCells.length - 1].textContent || "").trim();
                          }
                        }
                      }
                      const allLinks = Array.from(dp.querySelectorAll("td:not(.ui-datepicker-other-month) a"));
                      return allLinks.length > 0 ? (allLinks[allLinks.length - 1].textContent || "").trim() : "";
                    }).catch(() => "");
                    if (targetDay) runtimeVariables.set("scheduleSlotDay", targetDay);
                  }
                  if (targetDay) {
                    const dayCell = page.locator(`#ui-datepicker-div:visible td a:text-is('${targetDay}'):visible`).first();
                    if (await dayCell.isVisible().catch(() => false)) {
                      const dBox = await dayCell.boundingBox().catch(() => null);
                      const subTs = Date.now() - recordingStart;
                      if (dBox) {
                        const cx = Math.round(dBox.x + dBox.width / 2);
                        const cy = Math.round(dBox.y + dBox.height / 2);
                        triggerClickVisualizer(page, cx, cy).catch(() => {});
                        extraSubMoments.push({
                          id: 0,
                          type: "click",
                          timestamp: subTs,
                          cursor: { x: cx, y: cy },
                          target: { x: Math.round(dBox.x), y: Math.round(dBox.y), width: Math.round(dBox.width), height: Math.round(dBox.height) },
                          description: `[달력 팝업] '${targetDay}일' 선택`,
                        });
                      }
                      await dayCell.click({ timeout: 1500, force: true }).catch(() => {});
                      await page.waitForTimeout(250);
                    }
                  }
                }

                // If timepicker opened (e.g. startHourMinute / endHourMinute), select an unbooked 1-hour slot on the visible calendar grid
                const isTimePickerVisible = await page.locator(".ui-timepicker-list:visible, .ui-timepicker-wrapper:visible").first().isVisible().catch(() => false);
                if (isTimePickerVisible) {
                  if (!runtimeVariables.get("scheduleSlotStart")) {
                    const chosenSlot = await page.evaluate(() => {
                      const existingTexts = Array.from(document.querySelectorAll(".fc-event, .fc-time")).map((el) => el.textContent || "").join(" ");
                      const candidates: [string, string][] = [
                        ["10:00", "11:00"],
                        ["11:00", "12:00"],
                        ["13:00", "14:00"],
                        ["14:00", "15:00"],
                        ["16:00", "17:00"],
                        ["17:00", "18:00"],
                        ["08:00", "09:00"],
                        ["19:00", "20:00"],
                        ["20:00", "21:00"],
                      ];
                      for (const [s, e] of candidates) {
                        if (!existingTexts.includes(`${s} - ${e}`) && !existingTexts.includes(`${s}~${e}`)) {
                          return { start: s, end: e };
                        }
                      }
                      return { start: "10:00", end: "11:00" };
                    }).catch(() => ({ start: "10:00", end: "11:00" }));
                    runtimeVariables.set("scheduleSlotStart", chosenSlot.start);
                    runtimeVariables.set("scheduleSlotEnd", chosenSlot.end);
                  }
                  const targetTime = selLower.includes("end")
                    ? (runtimeVariables.get("scheduleSlotEnd") || "11:00")
                    : (runtimeVariables.get("scheduleSlotStart") || "10:00");
                  const timeItem = page.locator(`.ui-timepicker-list:visible li:text-is('${targetTime}'):visible, .ui-timepicker-wrapper:visible li:text-is('${targetTime}'):visible`).first();
                  if (await timeItem.isVisible().catch(() => false)) {
                    await timeItem.scrollIntoViewIfNeeded({ timeout: 1000 }).catch(() => {});
                    const tBox = await timeItem.boundingBox().catch(() => null);
                    const subTs = Date.now() - recordingStart;
                    if (tBox) {
                      const cx = Math.round(tBox.x + tBox.width / 2);
                      const cy = Math.round(tBox.y + tBox.height / 2);
                      triggerClickVisualizer(page, cx, cy).catch(() => {});
                      extraSubMoments.push({
                        id: 0,
                        type: "click",
                        timestamp: subTs,
                        cursor: { x: cx, y: cy },
                        target: { x: Math.round(tBox.x), y: Math.round(tBox.y), width: Math.round(tBox.width), height: Math.round(tBox.height) },
                        description: `[시간 선택] '${targetTime}' 선택`,
                      });
                    }
                    await timeItem.click({ timeout: 1500, force: true }).catch(() => {});
                    await page.waitForTimeout(250);
                  }
                }
              }

              await page.evaluate(() => {
                const dp = document.getElementById("ui-datepicker-div");
                if (dp) dp.style.display = "none";
                document.querySelectorAll(".ui-timepicker-wrapper").forEach((w) => {
                  (w as HTMLElement).style.display = "none";
                });
              }).catch(() => {});
            }
          }

          // If this was resource reservation popup confirmation ([자원예약 팝업] '확인') in an AI plan, check if the selected resource shows [예약불가] due to a time slot conflict from previous test runs, and shift to a free time slot if needed
          const isResourceConfirmClick =
            (descLower.includes("자원") && descLower.includes("확인")) ||
            selLower.includes("resselect_confirm") ||
            selLower.includes("scd_link_res");
          if (
            !action.recordedByEyedropper &&
            !plan.recordedByEyedropper &&
            (isResourceConfirmClick || (descLower.includes("확인") && (await page.locator(".ui-dialog:visible #startDate1, .ui-dialog:visible #useBgnDe1").count().catch(() => 0)) > 0))
          ) {
            await page.waitForTimeout(600);
            const hasResourceConflict = await page.evaluate(() => {
              const dialogs = Array.from(document.querySelectorAll(".ui-dialog:visible, .ui-dialog"));
              return dialogs.some((d) => (d as HTMLElement).offsetWidth > 0 && (d.textContent || "").includes("예약불가"));
            }).catch(() => false);

            if (hasResourceConflict) {
              console.log(`  [🔄 자원 예약 시간 충돌 자동 조정] 선택된 자원에 '[예약불가]' 시간 중복이 감지되어 비어 있는 미래 시간대로 일시를 자동 조정합니다.`);
              for (const candidateSlot of [
                { daysOffset: 1, startTime: "07:00", endTime: "08:00" },
                { daysOffset: 2, startTime: "19:00", endTime: "20:00" },
                { daysOffset: 3, startTime: "10:00", endTime: "11:00" },
                { daysOffset: 4, startTime: "14:00", endTime: "15:00" },
              ]) {
                await page.evaluate((slot) => {
                  const targetDate = new Date();
                  targetDate.setDate(targetDate.getDate() + slot.daysOffset);
                  const yyyy = targetDate.getFullYear();
                  const mm = String(targetDate.getMonth() + 1).padStart(2, "0");
                  const dd = String(targetDate.getDate()).padStart(2, "0");
                  const dateStr = `${yyyy}-${mm}-${dd}`;
                  const w = window as any;
                  if (w.jQuery) {
                    const $start = w.jQuery("#startDate1:visible, #useBgnDe1:visible");
                    const $end = w.jQuery("#endDate1:visible, #useEndDe1:visible");
                    const $startHm = w.jQuery("#startHourMinute:visible, #useBgnTime1:visible");
                    const $endHm = w.jQuery("#endHourMinute:visible, #useEndTime1:visible");
                    if ($start.length) {
                      try {
                        $start.datepicker("setDate", dateStr);
                        const onSel = $start.datepicker("option", "onSelect");
                        if (typeof onSel === "function") onSel.call($start[0], dateStr, $start.data("datepicker"));
                      } catch {}
                      $start.val(dateStr).trigger("change");
                    }
                    if ($end.length) {
                      try {
                        $end.datepicker("setDate", dateStr);
                        const onSel = $end.datepicker("option", "onSelect");
                        if (typeof onSel === "function") onSel.call($end[0], dateStr, $end.data("datepicker"));
                      } catch {}
                      $end.val(dateStr).trigger("change");
                    }
                    if ($startHm.length) {
                      try { $startHm.timepicker("setTime", slot.startTime); } catch {}
                      $startHm.val(slot.startTime).trigger("change");
                    }
                    if ($endHm.length) {
                      try { $endHm.timepicker("setTime", slot.endTime); } catch {}
                      $endHm.val(slot.endTime).trigger("change");
                    }
                  }
                }, candidateSlot).catch(() => {});
                await page.waitForTimeout(600);
                const stillConflict = await page.evaluate(() => {
                  const dialogs = Array.from(document.querySelectorAll(".ui-dialog"));
                  return dialogs.some((d) => (d as HTMLElement).offsetWidth > 0 && (d.textContent || "").includes("예약불가"));
                }).catch(() => false);
                if (!stillConflict) {
                  console.log(`  [✨ 자원 예약 가능 확인] 시간대 조정 후 '[예약불가]' 경고가 정상 해제되었습니다.`);
                  break;
                }
              }
            }
          }

          // If this was 합의 button click, verify if 합의 slot is populated (only for AI-generated plans, never Eyedropper!)
          if (!action.recordedByEyedropper && !plan.recordedByEyedropper && descLower.includes("합의") && (await page.locator(".ui-dialog:visible").count().catch(() => 0)) > 0) {
            await page.waitForTimeout(500);
            const topDlg = page.locator(".ui-dialog:visible").last();
            const slotsText = await topDlg.locator("[class*='line'] > div, [class*='box']").allInnerTexts().catch(() => []);
            const hasAgree = slotsText.some(t => t.includes("합의") && (t.includes("test") || t.includes("유니슨") || t.includes("부서")));
            if (!hasAgree) {
              console.log(`  [✨ 합의자 반영 보강] 합의 슬롯 미반영 감지 -> test001 체크 후 합의 버튼 재클릭`);
              const test001Chk = topDlg.locator(`.dynatree-node:has(a:has-text('test001')) .dynatree-checkbox:visible, li:has-text('test001') input[type='checkbox']:visible`).first();
              if (await test001Chk.isVisible().catch(() => false)) {
                await test001Chk.click({ force: true }).catch(() => {});
                await page.waitForTimeout(300);
              }
              const agreeBtn = topDlg.locator("button:has-text('합의'):visible").first();
              if (await agreeBtn.isVisible().catch(() => false)) {
                await agreeBtn.click({ force: true }).catch(() => {});
                await page.waitForTimeout(500);
              }
            }
          }

          // If a dropdown menu opened (e.g. [권한 ▲] toggle in shuttle picker dialog), select permission option ONLY if the next action does NOT already click a dropdown option!
          const isDropdownToggle = (action.selector && action.selector.includes("drop_tgl")) || (action.description && (action.description.includes("권한") || action.description.includes("전달") || action.description.includes("추가")));
          const nextNonWaitAct = plan.actions.slice(actionIdx + 1, actionIdx + 4).find((a) => a.type !== "wait");
          const nextStepClicksDropdownOption =
            Boolean(action.recordedByEyedropper || plan.recordedByEyedropper) ||
            (nextNonWaitAct?.type === "click" &&
              (/drop_menu|dropdown-menu|_delBox|메뉴\/링크/.test(`${nextNonWaitAct.selector || ""} ${nextNonWaitAct.description || ""}`)));
          if (isDropdownToggle && !nextStepClicksDropdownOption) {
            const dropMenuOpt = page.locator(".drop_menu:visible a:has-text('읽기/쓰기'), .drop_menu:visible a:has-text('읽기'), .drop_menu:visible a:first-child, .dropdown-menu:visible a:first-child").first();
            if (await dropMenuOpt.isVisible().catch(() => false)) {
              console.log(`  [✨ 셔틀 권한 선택 완료] 드롭다운 메뉴가 열려 권한 레벨 옵션을 클릭하여 대상 전송을 완료합니다.`);
              await dropMenuOpt.click().catch(() => {});
              await page.waitForTimeout(600);
            }
          }

          // If this was modal confirmation, verify that alert was dismissed and dialog actually closed (unless the next action in the plan is an explicit confirm/alert click!)
          const nextStepIsAlertConfirm =
            nextNonWaitAct?.type === "click" &&
            (/알림 팝업|확인 팝업|naon-cmm-confirm|naon-cmm-alert|#alert_lyr|#confirm_lyr/i.test(
              `${nextNonWaitAct.description || ""} ${nextNonWaitAct.selector || ""}`
            ));
          if (!action.recordedByEyedropper && !plan.recordedByEyedropper && hasActiveTreeDialog && isTreeSelectConfirm && !nextStepIsAlertConfirm) {
            await page.waitForTimeout(400);
            // Strictly match only system alert layers (#alert_lyr, #naon-cmm-alert-confirm, .alert_dialog), NEVER main registration .ui-dialog forms!
            const alertBtn = page.locator(
              "#alert_lyr:visible button:has-text('확인'):visible, button#naon-cmm-alert-confirm:visible, .ui-dialog.alert_dialog:visible button:text-is('확인'):visible"
            ).first();
            if (await alertBtn.isVisible().catch(() => false)) {
              console.log(`  [🤖 알림 팝업 자동 해제] 알림 팝업을 닫고 말단 리프 노드 재선택 후 확인 재시도`);
              await alertBtn.click().catch(() => {});
              await page.waitForTimeout(400);
              const topDlg = page.locator(".ui-dialog:visible, [role='dialog']:visible").last();
              // First expand tree if collapsed
              const expandBtn = topDlg.locator(
                "button.btn_fopn:visible, button:has-text('모두펼침'):visible, .dynatree-node.dynatree-has-children:not(.dynatree-expanded):not([class*='dynatree-exp-e']) > .dynatree-expander:visible"
              ).first();
              if (await expandBtn.isVisible().catch(() => false)) {
                await expandBtn.click({ force: true }).catch(() => {});
                await page.waitForTimeout(500);
              }
              const leafLoc = topDlg.locator(
                "span.dynatree-checkbox:visible, .dynatree-container ul ul span.dynatree-checkbox:visible, .dynatree-container .tico_item a.dynatree-title:visible, .dynatree-container .dynatree-node:not(.dynatree-folder) a.dynatree-title:visible, .dynatree-container ul ul a.dynatree-title:visible, a.dynatree-title:has-text('공용 문서보관함'):visible"
              ).first();
              if (await leafLoc.isVisible().catch(() => false)) {
                await leafLoc.click({ force: true }).catch(() => {});
                await page.waitForTimeout(500);
              }
              const confirmBtn = topDlg.locator("button._confirmBtn:visible, #eapBinderSelect_confirm:visible, .ui-dialog-buttonpane button:has-text('확인'), button:has-text('확인'):visible").first();
              if (await confirmBtn.isVisible().catch(() => false)) {
                await confirmBtn.click({ force: true }).catch(() => {});
              }
            }
            await page.locator(".ui-dialog:visible:has(.dynatree-container)").waitFor({ state: "hidden", timeout: 1500 }).catch(() => {});
            await page.evaluate(() => {
              if (document.querySelectorAll(".ui-dialog:visible").length === 0) {
                document.querySelectorAll(".ui-widget-overlay").forEach(el => el.remove());
              }
            }).catch(() => {});
            console.log(`  [✨ 팝업 닫힘 완료] 선택 팝업이 정상 해제되어 본문 작성 폼으로 진입했습니다.`);
          }

          // If this was a final Save / Register / Send button click (e.g. button#savebtn, button._save, button._notNoteReg_sendButton, button#orgEmpRegForm_addUser), handle post-save confirmation alerts
          const isFinalSaveAction =
            (descLower.includes("저장") ||
             descLower.includes("보내기") ||
             descLower.includes("발송") ||
             selLower.includes("savebtn") ||
             selLower.includes("_save") ||
             selLower.includes("sendbutton") ||
             selLower.includes("adduser") ||
             descLower.includes("등록 완료")) &&
            !isTreeSelectConfirm &&
            !isDraftSubmitAction;

          if (isFinalSaveAction) {
            await page.waitForTimeout(800);
            const hasExplicitUpcomingConfirmStep = plan.actions
              .slice(actionIdx + 1, actionIdx + 4)
              .some((nextAct) =>
                nextAct.type === "click" &&
                ((nextAct.description || "").includes("확인") ||
                 (nextAct.selector || "").toLowerCase().includes("confirm") ||
                 (nextAct.selector || "").toLowerCase().includes("alert"))
              );

            let handledDupModalClose = false;
            if (!hasExplicitUpcomingConfirmStep) {
              for (let alertPass = 0; alertPass < 3; alertPass++) {
                const saveAlertBtn = await findVisibleInPageOrFrames(
                  page,
                  "#alert_lyr:visible button:has-text('확인'):visible, button#naon-cmm-alert-confirm:visible, .ui-dialog.alert_dialog:visible button:text-is('확인'):visible, #confirm_lyr:visible button:has-text('확인'):visible"
                );
                if (!saveAlertBtn || !(await saveAlertBtn.isVisible().catch(() => false))) {
                  break;
                }
                const alertText = await saveAlertBtn.evaluate((btn) => {
                  const dlg = btn.closest(".ui-dialog, #alert_lyr, #confirm_lyr, .system_msg_box, .lyr_alert") || btn.parentElement?.parentElement;
                  return (dlg as HTMLElement)?.innerText || "";
                }).catch(() => "");

                const isValidationError =
                  alertText.includes("게시기한") ||
                  alertText.includes("선택해주세요") ||
                  alertText.includes("입력해주세요") ||
                  alertText.includes("입력하세요") ||
                  alertText.includes("필수");
                const isDuplicateNameError =
                  alertText.includes("존재합니다") ||
                  alertText.includes("중복") ||
                  alertText.includes("이미 등록") ||
                  alertText.includes("이미 존재") ||
                  alertText.includes("같은 이름") ||
                  alertText.includes("사용중") ||
                  alertText.includes("사용 중") ||
                  alertText.includes("아이디");
                const isSuccessNotice =
                  !isValidationError &&
                  !isDuplicateNameError &&
                  (alertText.includes("등록") || alertText.includes("저장") || alertText.includes("완료") || alertText.includes("처리") || alertText.includes("발송"));

                console.log(`  [✨ 저장/발송 알림 확인] '${alertText.trim().replace(/\n/g, " ").slice(0, 35)}' 알림창의 [확인] 버튼을 클릭합니다.`);
                const aBox = await saveAlertBtn.boundingBox().catch(() => null);
                const subTs = Date.now() - recordingStart;
                if (aBox) {
                  const cx = Math.round(aBox.x + aBox.width / 2);
                  const cy = Math.round(aBox.y + aBox.height / 2);
                  triggerClickVisualizer(page, cx, cy).catch(() => {});
                  extraSubMoments.push({
                    id: 0,
                    type: "click",
                    timestamp: subTs,
                    cursor: { x: cx, y: cy },
                    target: { x: Math.round(aBox.x), y: Math.round(aBox.y), width: Math.round(aBox.width), height: Math.round(aBox.height) },
                    description: `[시스템 알림] '확인' 버튼 클릭`,
                  });
                }
                await saveAlertBtn.click({ force: true }).catch(() => {});
                await page.waitForTimeout(800);

                if (isDuplicateNameError) {
                  const openDupDialogClose = await findVisibleInPageOrFrames(
                    page,
                    "button#orgEmpRegForm_close:visible, .ui-dialog:visible button:has-text('닫기'):visible, .ui-dialog:visible button:has-text('취소'):visible, .ui-dialog:visible .ui-dialog-titlebar-close:visible",
                    true
                  );
                  if (openDupDialogClose && (await openDupDialogClose.isVisible().catch(() => false))) {
                    console.log(`  [✨ 중복 항목 모달 닫기] 동일 이름/아이디 항목이 이미 존재하므로 생성 팝업을 닫고 기존 항목으로 시나리오를 이어갑니다.`);
                    await openDupDialogClose.click({ force: true }).catch(() => {});
                    await page.waitForTimeout(500);
                    handledDupModalClose = true;
                  }
                  for (const ctx of [page, ...page.frames()]) {
                    await ctx.evaluate(() => {
                      if (document.querySelectorAll(".ui-dialog:visible").length === 0) {
                        document.querySelectorAll(".ui-widget-overlay").forEach((ov) => ov.remove());
                      }
                    }).catch(() => {});
                  }
                  break;
                }

                if (isValidationError && !action.recordedByEyedropper && !plan.recordedByEyedropper) {
                  // Auto-fill missing required expiration date (e.g. article.ntceEndDe) and re-click Save (AI plans ONLY)
                  await page.evaluate(() => {
                    const future = new Date(Date.now() + 30 * 86400000);
                    const yyyy = future.getFullYear();
                    const mm = String(future.getMonth() + 1).padStart(2, "0");
                    const dd = String(future.getDate()).padStart(2, "0");
                    const dateStr = `${yyyy}-${mm}-${dd}`;
                    document.querySelectorAll("input.hasDatepicker, input._ntceEndDe, input[name*='EndDe']").forEach((inp: any) => {
                      if (!inp.value || inp.value.trim() === "") {
                        inp.value = dateStr;
                        inp.dispatchEvent(new Event("input", { bubbles: true }));
                        inp.dispatchEvent(new Event("change", { bubbles: true }));
                      }
                    });
                  }).catch(() => {});
                  await page.waitForTimeout(400);
                  if (await el.isVisible().catch(() => false)) {
                    console.log(`  [✨ 필수 기한 자동 보정 후 재저장] 누락된 날짜 필드 입력 후 저장 버튼을 다시 클릭합니다.`);
                    await el.click({ force: true }).catch(() => {});
                    await page.waitForTimeout(800);
                    continue;
                  }
                }

                // If the registration form dialog itself (e.g. Schedule registration dialog) remains open after "일정이 등록 되었습니다", close it so the calendar result is visible (AI plans ONLY)
                if (isSuccessNotice && !action.recordedByEyedropper && !plan.recordedByEyedropper) {
                  const openRegDialogClose = await findVisibleInPageOrFrames(
                    page,
                    ".ui-dialog:visible:has(#savebtn) .ui-dialog-titlebar-close:visible, .ui-dialog:visible:has(#savebtn) button:has-text('닫기'):visible"
                  );
                  if (openRegDialogClose && (await openRegDialogClose.isVisible().catch(() => false))) {
                    console.log(`  [✨ 등록 폼 모달 닫기] 일정 등록 완료 후 캘린더 결과 화면 표시를 위해 등록 모달을 닫습니다.`);
                    await openRegDialogClose.click({ force: true }).catch(() => {});
                    await page.waitForTimeout(400);
                  }
                  await page.evaluate(() => {
                    const w = window as any;
                    try {
                      if (w.ObserverControl && typeof w.ObserverControl.notifyObservers === "function") {
                        w.ObserverControl.notifyObservers({ type: "INSERT_SHECEDULE_EVENT" });
                        w.ObserverControl.notifyObservers({ type: "SCHEDULE_CONTENT_LOAD" });
                      }
                    } catch {}
                    try {
                      if (w.jQuery) {
                        w.jQuery("#calendar, .fc").fullCalendar("refetchEvents");
                      }
                    } catch {}
                  }).catch(() => {});
                  await page.waitForTimeout(600);
                }
              }

              // If native window.alert fired a duplicate notice or User Registration dialog remained open after clicking #orgEmpRegForm_addUser, close the modal cleanly
              const hadRecentNativeDupAlert =
                Date.now() - lastNativeDialogTime < 3500 &&
                /존재|중복|사용\s*중|아이디|이미/.test(lastNativeDialogMessage);
              if (!handledDupModalClose && (hadRecentNativeDupAlert || selLower.includes("orgempregform_adduser"))) {
                const lingeringRegModalClose = await findVisibleInPageOrFrames(
                  page,
                  "button#orgEmpRegForm_close:visible, .ui-dialog:visible:has(#orgEmpRegForm_addUser) button:has-text('닫기'):visible, .ui-dialog:visible:has(#orgEmpRegForm_addUser) .ui-dialog-titlebar-close:visible",
                  true
                );
                if (lingeringRegModalClose && (await lingeringRegModalClose.isVisible().catch(() => false))) {
                  console.log(`  [✨ 사용자 등록 모달 닫기] 중복 계정 알림 확인 후 열려 있는 등록 팝업을 닫고 후속 단계를 진행합니다.`);
                  await lingeringRegModalClose.click({ force: true }).catch(() => {});
                  await page.waitForTimeout(500);
                  for (const ctx of [page, ...page.frames()]) {
                    await ctx.evaluate(() => {
                      if (document.querySelectorAll(".ui-dialog:visible").length === 0) {
                        document.querySelectorAll(".ui-widget-overlay").forEach((ov) => ov.remove());
                      }
                    }).catch(() => {});
                  }
                }
              }
            }

            // If this final save/send happened inside a simulated popup (e.g. emlMailRegPopup) and there are subsequent steps targeting the parent window
            if (actionIdx < plan.actions.length - 1 && !hasExplicitUpcomingConfirmStep) {
              const isInsideSimPopup = await page.evaluate(() => {
                return (
                  sessionStorage.getItem("__studio_simulated_popup__") === "1" ||
                  /Popup|newWindowYn=Y/i.test(window.location.href)
                );
              }).catch(() => false);

              if (isInsideSimPopup) {
                // Wait briefly for completion view (e.g. #emlMailSendComplete_selfWindow) to render so the video captures the success state
                await page
                  .locator("#emlMailSendComplete_selfWindow:visible, #emlMailSendComplete_resultMessage:visible, .system_msg_box:visible")
                  .first()
                  .waitFor({ state: "visible", timeout: 2500 })
                  .catch(() => {});
                await page.waitForTimeout(1000);

                const nextNonWaitAct = plan.actions.slice(actionIdx + 1).find((a) => a.type !== "wait");
                const nextElInPopup = nextNonWaitAct?.selector ? await getLocator(page, { ...nextNonWaitAct }) : null;
                const isNextVisibleInPopup = Boolean(nextElInPopup && (await nextElInPopup.isVisible().catch(() => false)));
                if (!isNextVisibleInPopup) {
                  await restoreFromSimulatedPopupIfNeeded(page, "팝업 발송/저장 완료 후 부모 창 후속 시나리오 진행", nextNonWaitAct);
                }
              }
            }
          }

          // Handle explicit Logout / Login button transitions (e.g. GwMainMenu.fn.goLogout(), #btnLogin)
          const isLogoutAction =
            descLower.includes("로그아웃") ||
            selLower.includes("btn_logout") ||
            selLower.includes("gologout");
          const isLoginAction =
            selLower.includes("btnlogin") ||
            descLower.includes("'login' 버튼");

          if (isLogoutAction || isLoginAction) {
            await page.waitForTimeout(400);
            const hasExplicitUpcomingConfirm = plan.actions
              .slice(actionIdx + 1, actionIdx + 4)
              .some((nextAct) =>
                nextAct.type === "click" &&
                ((nextAct.description || "").includes("확인") ||
                 (nextAct.selector || "").toLowerCase().includes("confirm") ||
                 (nextAct.selector || "").toLowerCase().includes("alert"))
              );
            if (!hasExplicitUpcomingConfirm) {
              const confirmBtn = await findVisibleInPageOrFrames(
                page,
                "#confirm_lyr:visible button:has-text('확인'):visible, button#naon-cmm-confirm-ok:visible, #alert_lyr:visible button:has-text('확인'):visible, button#naon-cmm-alert-confirm:visible"
              );
              if (confirmBtn && (await confirmBtn.isVisible().catch(() => false))) {
                console.log(`  [✨ ${isLogoutAction ? "로그아웃" : "로그인"} 확인 팝업 처리] 알림창의 [확인] 버튼을 클릭합니다.`);
                await confirmBtn.click({ force: true }).catch(() => {});
                await page.waitForTimeout(500);
              }
            }
            if (isLogoutAction) {
              console.log(`  [🔒 로컬 세션 전환] 서버의 기본 관리자 세션(auth.json)을 유지한 채 현재 브라우저 컨텍스트 쿠키 및 SSO 스토리지만 초기화하여 로그인 화면으로 이동합니다.`);
              for (const ctx of [page, ...page.frames()]) {
                await ctx.evaluate(() => {
                  try {
                    localStorage.clear();
                    sessionStorage.clear();
                  } catch {}
                }).catch(() => {});
              }
              await context.addInitScript(`
                (function() {
                  try {
                    if (!sessionStorage.getItem("__studio_iam_login_submitted__")) {
                      localStorage.removeItem("IAM_SSO_SIGN_KEY");
                      localStorage.removeItem("IAM_LAST_SSO_SIGN_KEY_STORAGE");
                    }
                    document.addEventListener("DOMContentLoaded", function() {
                      try {
                        var w = window;
                        if (w.SignKey) {
                          w.SignKey.connect = function(cb) {
                            if (cb && typeof cb.error === "function") cb.error();
                          };
                          var origSetup = w.SignKey.setup;
                          if (typeof origSetup === "function") {
                            w.SignKey.setup = function() {
                              try {
                                if (w.SignKey.data) {
                                  w.SignKey.data.toolboxUseYn = "N";
                                  if (!sessionStorage.getItem("__studio_iam_login_submitted__")) {
                                    w.SignKey.data.ssoSignKey = null;
                                  }
                                }
                                if (!sessionStorage.getItem("__studio_iam_login_submitted__")) {
                                  localStorage.removeItem("IAM_SSO_SIGN_KEY");
                                  localStorage.removeItem("IAM_LAST_SSO_SIGN_KEY_STORAGE");
                                }
                              } catch (e) {}
                              return origSetup.apply(this, arguments);
                            };
                          }
                        }
                        var loginBtn = document.getElementById("btnLogin");
                        if (loginBtn) {
                          loginBtn.addEventListener("click", function() {
                            try { sessionStorage.setItem("__studio_iam_login_submitted__", "1"); } catch (e) {}
                          }, true);
                        }
                      } catch (e) {}
                    }, { capture: true });
                  } catch (e) {}
                })();
              `).catch(() => {});
              await context.clearCookies().catch(() => {});
              const rootLoginUrl = new URL("/ekp/main/home/homGwMain", page.url()).href;
              await page.goto(rootLoginUrl, { waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => {});
              await page.locator("input#userId:visible, input[name='userId']:visible").first().waitFor({ state: "visible", timeout: 10000 }).catch(() => {});
            } else if (isLoginAction) {
              await page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
              await page.waitForTimeout(800);
            }
          }

          // If this was draft submission (상신), check if a validation warning or confirmation dialog (.ui-dialog) appeared
          if (isDraftSubmitAction) {
            await page.waitForTimeout(1000);
            let topDlg = page.locator(".ui-dialog:visible, #alert_lyr:visible").last();
            if (await topDlg.isVisible().catch(() => false)) {
              const dlgText = await topDlg.innerText().catch(() => "");
              if (!action.recordedByEyedropper && !plan.recordedByEyedropper && (dlgText.includes("필수") || dlgText.includes("입력") || dlgText.includes("선택하세요"))) {
                console.log(`  [⚠️ 상신 유효성 경고 감지] '${dlgText.trim().replace(/\n/g, ' ').slice(0, 35)}' 경고창 해제 후 폼 입력란 자동 채우기 및 상신 재시도`);
                const alertConfirm = topDlg.locator("button:has-text('확인'), button._confirm, button.btn_pri").first();
                if (await alertConfirm.isVisible().catch(() => false)) {
                  await alertConfirm.click().catch(() => {});
                  await page.waitForTimeout(600);
                }
                // Auto-fill all blank inputs/textareas in document view table
                await page.evaluate(() => {
                  const todayStr = new Date().toISOString().split("T")[0];
                  document.querySelectorAll("table.tbl_frm tr, .doc_view_table tr").forEach((tr) => {
                    const text = tr.textContent || "";
                    if (text.includes("일자") || text.includes("년월일") || text.includes("일시") || text.includes("날짜")) {
                      tr.querySelectorAll("input").forEach((inp: any) => {
                        if (!inp.value || inp.value.trim() === "") {
                          inp.value = todayStr;
                          inp.dispatchEvent(new Event("input", { bubbles: true }));
                          inp.dispatchEvent(new Event("change", { bubbles: true }));
                        }
                      });
                    }
                    tr.querySelectorAll("input[type='text'], input:not([type]), textarea").forEach((inp: any) => {
                      if (!inp.value || inp.value.trim() === "") {
                        inp.value = inp.tagName === "TEXTAREA" ? "금일 회의 완료" : "회의 완료";
                        inp.dispatchEvent(new Event("input", { bubbles: true }));
                        inp.dispatchEvent(new Event("change", { bubbles: true }));
                      }
                    });
                  });
                }).catch(() => {});
                await page.waitForTimeout(500);

                // Click 상신 again
                const retryDraftBtn = page.locator("button._draftBtn:visible, button:has-text('결재상신'):visible, button:has-text('상신'):visible").first();
                if (await retryDraftBtn.isVisible().catch(() => false)) {
                  console.log(`  [✨ 상신 재시도] 필수값 자동 보정 후 [결재상신] 버튼 재클릭`);
                  await retryDraftBtn.click({ force: true }).catch(() => {});
                  await page.waitForTimeout(1000);
                }
              }

              // Only auto-click the confirmation dialog if the plan does NOT already have an explicit upcoming [확인] click step!
              const hasExplicitUpcomingConfirmStep = plan.actions
                .slice(actionIdx + 1, actionIdx + 4)
                .some((nextAct) =>
                  nextAct.type === "click" &&
                  ((nextAct.description || "").includes("확인") ||
                   (nextAct.selector || "").toLowerCase().includes("confirm") ||
                   (nextAct.selector || "").toLowerCase().includes("alert"))
                );

              if (!hasExplicitUpcomingConfirmStep) {
                topDlg = page.locator(".ui-dialog:visible, #alert_lyr:visible").last();
                const confirmBtn = topDlg.locator(".ui-dialog-buttonpane button:has-text('확인'):visible, button:has-text('확인'):visible, button._confirm:visible").first();
                if (await confirmBtn.isVisible().catch(() => false)) {
                  console.log(`  [✨ 상신 확인 팝업 감지] 최종 상신 대화상자의 [확인] 버튼을 클릭합니다.`);
                  await confirmBtn.click().catch(() => {});
                  await page.waitForTimeout(1500);
                }
              }
            }
          }

          await page.waitForTimeout(1000).catch(() => {});
          break;
        }

        case "type": {
          await autoRecoverActiveModals(page, action, moments, recordingStart);
          const isOptionalOrSub = isOptionalAction(action, momentId, plan.actions.length) || isNonCriticalSubOption(action);
          let el = await getLocatorWithWait(page, action, isOptionalOrSub);
          if (!(el && (await el.isVisible().catch(() => false)))) {
            const restored = await restoreFromSimulatedPopupIfNeeded(
              page,
              `'${action.description || action.selector}' 입력 대상 탐색을 위해 팝업 종료`,
              action
            );
            if (restored) {
              el = await getLocatorWithWait(page, action, isOptionalOrSub);
            }
          }
          const hasSpecificTypeSelector = Boolean(
            action.recordedByEyedropper ||
            (action.selector && (/#[a-zA-Z0-9_-]+/.test(action.selector) || action.selector.includes(">")))
          );
          const isTypeElVisible = Boolean(el && (await el.isVisible().catch(() => false)));

          const cleanTypeDesc = (action.description || "").replace(/[\[\]]/g, "");
          const isSearchInput =
            (cleanTypeDesc.includes("검색") || Boolean(action.useScraped) || (action.selector && (action.selector.includes("search") || action.selector.includes("srch")))) &&
            !cleanTypeDesc.includes("제목") &&
            !cleanTypeDesc.includes("본문") &&
            !cleanTypeDesc.includes("내용") &&
            !cleanTypeDesc.includes("작성");

          if (isSearchInput && !action.recordedByEyedropper && !plan.recordedByEyedropper && (!isTypeElVisible || !hasSpecificTypeSelector)) {
            const isFolderTreeSearch = cleanTypeDesc.includes("문서함") || cleanTypeDesc.includes("폴더") || cleanTypeDesc.includes("트리") || cleanTypeDesc.includes("사이드바");
            const contentSearchInput = page.locator(
              "input#atclList_searchWord:visible, input[id*='searchWord']:visible, .new_srch_bar input:visible, #content .srch_input input:visible, #content input[id*='search']:visible, #content input[placeholder*='검색']:visible"
            ).first();
            const sidebarSearchInput = page.locator(
              "#snb .srch_bar input:visible, #snb input[placeholder*='검색']:visible"
            ).first();

            if (!isFolderTreeSearch && await contentSearchInput.isVisible().catch(() => false)) {
              console.log(`  [🎯 본문 목록 검색 입력창 특정] 사이드바/GNB를 배제하고 헤더 바로 밑 본문 툴바의 제목/키워드 검색창을 연결합니다.`);
              el = contentSearchInput;
            } else if (await sidebarSearchInput.isVisible().catch(() => false)) {
              console.log(`  [🎯 사이드바 트리 검색 입력창 특정] 사이드바 내의 검색 입력창을 연결합니다.`);
              el = sidebarSearchInput;
            }
          }
          if (!el) {
            el = await trySelfHealAction(moments, recordingStart, page, action, momentId, plan, dataDir);
          }
          if (!el) {
            if (canSafelySkipFailedAction(action, momentId, plan.actions.length, (action as any)._lastHealReason) || (action as any)._wasSkipped) {
              markActionAndFollowupWaitForPruning(plan, actionIdx, action);
              console.log(`  [⚠️ 비필수 부가 단계 자동 스킵] 입력 요소를 찾을 수 없으나 필수 핵심 단계가 아니므로 안전하게 통과합니다: ${action.description}`);
              break;
            }
            throw new Error(`입력 요소를 찾을 수 없습니다: ${action.selector}`);
          }

          const waitTimeout = isOptionalOrSub ? 2500 : 15000;
          try {
            await el.waitFor({ state: "visible", timeout: waitTimeout });
          } catch (waitErr) {
            let resolved = false;
            if (!action.recordedByEyedropper && !plan.recordedByEyedropper) {
              const desc = action.description || "";
              let fallbackInput: Locator | null = null;
              if (desc.includes("제목") || desc.includes("subject")) {
                const regBtn = page.locator("button#reg_shedule_lefttop:visible").first();
                if (await regBtn.isVisible().catch(() => false)) {
                  await regBtn.click({ force: true }).catch(() => {});
                  await page.waitForTimeout(1500);
                }
                fallbackInput = page.locator("input#eapDocReg_docSubject:visible, input#docTitle:visible, input[name*='Subject']:visible, tr:has-text('제목') input:visible, #reg_schedule_form #subject, .ui-dialog:visible #subject, input#subject:visible, input[placeholder*='제목']").first();
              } else if (desc.includes("내용") || desc.includes("본문") || desc.includes("회의입니다") || desc.includes("에디터")) {
                fallbackInput = page.locator(`
                  div.se-contents:visible,
                  [role='textbox'].se-contents:visible,
                  .doc_view_table textarea:not(.se-ime):visible,
                  table.tbl_frm textarea:not(.se-ime):visible,
                  #eapDocReg_contents textarea:not(.se-ime):visible,
                  textarea:not(.se-ime):not(#eapDocReg_draftOpinCn):not([name*='opinion']):not([placeholder*='의견']):not(._addCmntInput):visible,
                  div[contenteditable='true']:visible,
                  .note-editable:visible,
                  textarea[placeholder*='내용']:visible,
                  #reg_schedule_form #cn,
                  .ui-dialog:visible #cn,
                  textarea:not(.se-ime):visible
                `).first();

                // Automatically populate blank required date/text inputs in the document table to prevent validation alert
                try {
                  await page.evaluate(() => {
                    const todayStr = new Date().toISOString().split("T")[0];
                    document.querySelectorAll("input.hasDatepicker, input[type='date'], input[id*='date'], input[name*='date'], input[placeholder*='yyyy'], input[placeholder*='YYYY']").forEach((inp: any) => {
                      if (!inp.value || inp.value.trim() === "") {
                        inp.value = todayStr;
                        inp.dispatchEvent(new Event("input", { bubbles: true }));
                        inp.dispatchEvent(new Event("change", { bubbles: true }));
                      }
                    });

                    document.querySelectorAll("table.tbl_frm tr, .doc_view_table tr").forEach((tr) => {
                      const text = tr.textContent || "";
                      if (text.includes("일자") || text.includes("년월일") || text.includes("일시") || text.includes("날짜")) {
                        tr.querySelectorAll("input").forEach((inp: any) => {
                          if (!inp.value || inp.value.trim() === "") {
                            inp.value = todayStr;
                            inp.dispatchEvent(new Event("input", { bubbles: true }));
                            inp.dispatchEvent(new Event("change", { bubbles: true }));
                          }
                        });
                      }
                      tr.querySelectorAll("input[type='text'], input:not([type]), textarea:not(.se-ime)").forEach((inp: any) => {
                        if (!inp.value || inp.value.trim() === "") {
                          inp.value = inp.tagName === "TEXTAREA" ? "금일 회의 완료" : "회의 완료";
                          inp.dispatchEvent(new Event("input", { bubbles: true }));
                          inp.dispatchEvent(new Event("change", { bubbles: true }));
                        }
                      });
                    });
                  });
                } catch {}
              } else if (desc.includes("의견") || desc.includes("opinion")) {
                fallbackInput = page.locator("textarea#eapDocReg_draftOpinCn:visible, textarea#eapDocReg_opinCn:visible, textarea[name*='opinion']:visible, textarea[placeholder*='의견']:visible, textarea:not(.se-ime):visible").first();
              }

              if (fallbackInput && (await fallbackInput.isVisible().catch(() => false))) {
                console.log(`  [✨ 지능형 런타임 복구] '${action.description}'에 맞는 입력 필드를 감지하여 자동 복구했습니다.`);
                el = fallbackInput;
                resolved = true;
              }
            }

            // 🚨 Trigger AI Runtime Self-Healing if still not found!
            if (!resolved) {
              const healed = await trySelfHealAction(moments, recordingStart, page, action, momentId, plan, dataDir);
              if (healed) {
                el = healed;
                resolved = true;
              }
            }

            if (!resolved) {
              if (canSafelySkipFailedAction(action, momentId, plan.actions.length, (action as any)._lastHealReason) || (action as any)._wasSkipped) {
                markActionAndFollowupWaitForPruning(plan, actionIdx, action);
                console.log(`  [⚠️ 비필수 부가 단계 자동 스킵] 입력 요소를 찾을 수 없으나 필수 핵심 단계가 아니므로 안전하게 스킵합니다: ${action.description}`);
                break;
              }
              throw new Error(`입력 요소를 찾을 수 없거나 화면에 표시되지 않습니다: ${action.selector}`);
            }
          }

          // If target resolved to Synap Editor's hidden IME proxy (textarea.se-ime), redirect to visible div.se-contents
          const isSeImeProxy = await el.evaluate((node) => node.classList && node.classList.contains("se-ime")).catch(() => false);
          if (isSeImeProxy) {
            const seVisible = page.locator("div.se-contents:visible, [role='textbox'].se-contents:visible").first();
            if (await seVisible.isVisible().catch(() => false)) {
              el = seVisible;
            }
          }

          await el.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => { });
          let { locator: targetEl, box } = await resolveAtomicTarget(el, true);
          el = targetEl;

          const desc = (action.description || "").toLowerCase();
          const sel = (action.selector || "").toLowerCase();
          const isEditorAction = desc.includes("내용") || desc.includes("본문") || desc.includes("에디터") || desc.includes("content") || sel.includes("cn") || sel.includes("editor") || sel.includes("se-contents");

          // When typing content/body, ensure we are targeting the actual editable canvas, not an outer toolbar
          if (isEditorAction) {
            const isAlreadyEditableCanvas = await el
              .evaluate((node) => (node as HTMLElement).isContentEditable || (node.classList && node.classList.contains("se-contents")))
              .catch(() => false);
            if (!isAlreadyEditableCanvas) {
              const innerEditable = el.locator("div.se-contents:visible, [contenteditable='true']:visible, textarea:not(.se-ime):visible, .note-editable:visible, .ce-paragraph:visible").first();
              if (await innerEditable.isVisible().catch(() => false)) {
                el = innerEditable;
                box = await el.boundingBox().catch(() => box);
              }
            }
          }

          const isSynapEditor = await el.evaluate((node) => Boolean(node.classList && node.classList.contains("se-contents"))).catch(() => false);
          const isRichTextEditor =
            isSynapEditor ||
            (isEditorAction &&
              (await el
                .evaluate((node) => {
                  const htmlEl = node as HTMLElement;
                  const tag = (htmlEl.tagName || "").toLowerCase();
                  if (tag === "input" || tag === "textarea" || tag === "select") return false;
                  return Boolean(
                    htmlEl.isContentEditable ||
                    htmlEl.getAttribute?.("contenteditable") === "true" ||
                    htmlEl.getAttribute?.("role") === "textbox"
                  );
                })
                .catch(() => false)));

          // Inspect live editor paragraphs BEFORE clicking so if pre-filled template text exists (e.g. "■ 교육 요청 내용 작성" or "■ 결함 Or 개선 요청 내용\n\n- "),
          // we click at the exact end of the target paragraph instead of hardcoded (36, 32) in the middle of existing characters!
          const editorPlacement = isRichTextEditor
            ? await el
                .evaluate(
                  (
                    node,
                    opts: {
                      rawText: string;
                      paraIdx?: number;
                      insertNewline?: boolean;
                      cursorOffset?: { x: number; y: number };
                    }
                  ) => {
                    const doc = node.ownerDocument || document;
                    const editorRect = node.getBoundingClientRect();
                    const norm = (s: string) =>
                      String(s || "")
                        .replace(/\u200B/g, "")
                        .replace(/\u00a0/g, " ")
                        .replace(/\r?\n/g, "");

                    let paras = Array.from(node.querySelectorAll("p.se-text-paragraph, p")) as HTMLElement[];
                    if (paras.length === 0) {
                      paras = Array.from(node.children || []).filter((ch) =>
                        /^(DIV|LI|H[1-6]|BLOCKQUOTE)$/i.test(ch.tagName || "")
                      ) as HTMLElement[];
                    }

                    const paraTexts = paras.map((p) =>
                      norm(p.innerText !== undefined ? p.innerText : p.textContent || "")
                    );
                    const hasExistingText =
                      paras.length > 0
                        ? paraTexts.some((t) => t.trim().length > 0)
                        : norm((node as HTMLElement).innerText || node.textContent || "").trim().length > 0;

                    if (!hasExistingText || paras.length === 0) {
                      return {
                        hasExistingText: false,
                        targetIdx: 0,
                        targetParaPreview: "",
                        relX: opts.cursorOffset?.x ?? Math.min(36, Math.max(16, Math.round(editorRect.width / 2))),
                        relY: opts.cursorOffset?.y ?? Math.min(32, Math.max(16, Math.round(editorRect.height / 2))),
                        pressEndKey: false,
                        insertNewline: false,
                        cleanedText: null as string | null,
                      };
                    }

                    let cleanedText: string | null = null;
                    let targetIdx = typeof opts.paraIdx === "number" ? opts.paraIdx : -1;
                    let insertNewline = Boolean(opts.insertNewline);

                    // If rawText still starts with the existing template line (e.g. legacy plan before sanitization), strip the duplicate template prefix
                    const p0Trim = paraTexts[0].trim();
                    const normRaw = norm((opts.rawText || "").replace(/\s*↵\s*/g, "\n"));
                    if (p0Trim.length >= 2 && normRaw.startsWith(p0Trim) && normRaw.trim() !== p0Trim) {
                      let rem = normRaw.slice(p0Trim.length);
                      const hadLeadingNewline = /^\n/.test(rem);
                      rem = rem.replace(/^\n/, "").trim();
                      if (rem.length > 0) {
                        cleanedText = rem;
                        if (targetIdx < 0) targetIdx = 0;
                        if (hadLeadingNewline || /^[■▶●◆★▣]/.test(p0Trim)) {
                          insertNewline = true;
                        }
                      }
                    }

                    if (targetIdx < 0 && opts.cursorOffset && typeof opts.cursorOffset.y === "number") {
                      const clickClientY = editorRect.top + opts.cursorOffset.y;
                      for (let i = 0; i < paras.length; i++) {
                        const r = paras[i].getBoundingClientRect();
                        if (clickClientY >= r.top - 4 && clickClientY <= r.bottom + 4) {
                          targetIdx = i;
                          break;
                        }
                      }
                    }

                    if (targetIdx < 0) {
                      // Priority A: First bullet/placeholder line waiting for input (e.g. "- ")
                      const bulletIdx = paraTexts.findIndex((t) => /^[-*·•]\s*$/.test(t.trim()));
                      if (bulletIdx !== -1) {
                        targetIdx = bulletIdx;
                        insertNewline = false;
                      } else {
                        // Priority B: First empty paragraph after the initial heading
                        const emptyIdx = paraTexts.findIndex((t, idx) => idx > 0 && t.trim() === "");
                        if (emptyIdx !== -1) {
                          targetIdx = emptyIdx;
                          insertNewline = false;
                        } else {
                          // Priority C: End of the last paragraph, inserting a new line if it's non-empty
                          targetIdx = paras.length - 1;
                          if (paraTexts[targetIdx].trim().length > 0) {
                            insertNewline = true;
                          }
                        }
                      }
                    }

                    targetIdx = Math.max(0, Math.min(paras.length - 1, targetIdx));

                    // If targeting paragraph 0 with insertNewline=true, but paragraph 1 is ALREADY an empty line,
                    // click paragraph 1 directly instead of inserting a redundant blank line!
                    if (targetIdx === 0 && insertNewline && paras.length >= 2 && paraTexts[1].trim() === "") {
                      targetIdx = 1;
                      insertNewline = false;
                    }

                    const targetP = paras[targetIdx];
                    targetP.scrollIntoView({ block: "nearest" });
                    const updatedEditorRect = node.getBoundingClientRect();
                    const pRect = targetP.getBoundingClientRect();
                    const pText = paraTexts[targetIdx];

                    let clickClientX = pRect.left + 16;
                    let clickClientY = pRect.top + Math.max(10, pRect.height / 2);
                    let pressEndKey = false;

                    if (pText.trim().length > 0) {
                      pressEndKey = true;
                      try {
                        const range = doc.createRange();
                        range.selectNodeContents(targetP);
                        const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
                        if (rects.length > 0) {
                          const lastRect = rects[rects.length - 1];
                          clickClientX = Math.min(pRect.right - 6, Math.max(pRect.left + 12, lastRect.right + 8));
                          clickClientY = lastRect.top + lastRect.height / 2;
                        } else {
                          clickClientX = Math.min(pRect.right - 10, pRect.left + pText.length * 14 + 20);
                        }
                      } catch {
                        clickClientX = Math.min(pRect.right - 10, pRect.left + pText.length * 14 + 20);
                      }
                    }

                    const relX = Math.max(
                      8,
                      Math.min(Math.round(updatedEditorRect.width - 8), Math.round(clickClientX - updatedEditorRect.left))
                    );
                    const relY = Math.max(
                      8,
                      Math.min(Math.round(updatedEditorRect.height - 8), Math.round(clickClientY - updatedEditorRect.top))
                    );

                    return {
                      hasExistingText: true,
                      targetIdx,
                      targetParaPreview: pText.trim().slice(0, 30),
                      relX,
                      relY,
                      pressEndKey,
                      insertNewline,
                      cleanedText,
                    };
                  },
                  {
                    rawText: action.text ?? "",
                    paraIdx: action.editorParaIndex,
                    insertNewline: action.editorInsertNewline,
                    cursorOffset: action.cursorOffset,
                  }
                )
                .catch(() => null)
            : null;

          if (editorPlacement && box) {
            box = (await el.boundingBox().catch(() => box)) || box;
          }

          if (box) {
            let rawX: number;
            let rawY: number;
            if (editorPlacement) {
              rawX = box.x + editorPlacement.relX;
              rawY = box.y + editorPlacement.relY;
            } else {
              // For typing, natural cursor position is near text start (offset 24px, and near top if tall editor)
              const clickX = box.width > 60 ? box.x + (isSynapEditor ? 36 : 16) : box.x + box.width / 2;
              const clickY = isSynapEditor && box.height > 80 ? box.y + 32 : box.y + box.height / 2;
              rawX = clickX + (action.cursorOffset?.x || 0);
              rawY = clickY + (action.cursorOffset?.y || 0);
            }
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

          // Check if target is already focused to prevent duplicate clicking
          const isAlreadyFocused = isRichTextEditor
            ? false
            : await el.evaluate((node) => document.activeElement === node).catch(() => false);
          if (!isAlreadyFocused) {
            // Blur any other active inputs or contenteditable elements (e.g. Wiki title div) so text never leaks across fields
            await el.evaluate((targetNode) => {
              const active = document.activeElement as HTMLElement | null;
              if (
                active &&
                active !== targetNode &&
                (active.tagName === "INPUT" ||
                  active.isContentEditable ||
                  (active.tagName === "TEXTAREA" && !active.classList.contains("se-ime")))
              ) {
                active.blur();
              }
            }).catch(() => {});
            if (moment.cursor) {
              await triggerClickVisualizer(page, moment.cursor.x, moment.cursor.y);
            }
            try {
              if (editorPlacement && box) {
                if (editorPlacement.hasExistingText) {
                  console.log(
                    `  [📝 에디터 커서 정밀 배치] 기존 양식 문단(#${editorPlacement.targetIdx + 1}${editorPlacement.targetParaPreview ? `: "${editorPlacement.targetParaPreview}"` : ""}) 끝 위치(rel=${editorPlacement.relX},${editorPlacement.relY})로 커서를 이동합니다.`
                  );
                }
                await el
                  .click({
                    position: { x: editorPlacement.relX, y: editorPlacement.relY },
                    timeout: 3000,
                  })
                  .catch(() => {});
                if (editorPlacement.pressEndKey) {
                  await page.waitForTimeout(80);
                  await page.keyboard.press("End").catch(() => {});
                }
                if (editorPlacement.insertNewline) {
                  await page.waitForTimeout(80);
                  await page.keyboard.press("Enter").catch(() => {});
                  await page.waitForTimeout(120);
                }
              } else if (isSynapEditor && box) {
                await el.click({
                  position: { x: Math.min(36, Math.round(box.width / 2)), y: Math.min(32, Math.round(box.height / 2)) },
                  timeout: 3000,
                }).catch(() => {});
              } else {
                await el.click({ timeout: 3000, force: action.force ?? true }).catch(() => { });
              }
            } catch { }
          }
          if (!isRichTextEditor) {
            await el.focus().catch(() => { });
          }

          let text = (editorPlacement?.cleanedText ?? action.text ?? "").replace(/\s*↵\s*/g, "\n");
          const isEyedropperAction = Boolean(action.recordedByEyedropper || plan.recordedByEyedropper);

          // Method 2: Dynamic Live Data Linking (ONLY when explicitly requested via useScraped/dynamicFrom or when text is empty placeholder)
          if (action.useScraped && action.useScraped !== "auto" && action.useScraped !== "true") {
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
            // Respect any explicit text typed by the user (including "테스트", "홍길동", etc.)!
            // Only treat literally empty text or generic placeholder "검색어" as missing text.
            const isExplicitTextGiven = Boolean(
              action.text &&
              action.text.trim().length > 0 &&
              action.text.trim() !== "검색어" &&
              action.text.trim() !== "검색어를 입력하세요"
            );
            const isClearAction =
              desc.includes("지우기") ||
              desc.includes("백스페이스") ||
              desc.includes("초기화");
            const shouldPreScrapeSearch =
              !isEyedropperAction &&
              !isClearAction &&
              (desc.includes("검색") ||
               desc.includes("조회") ||
               desc.includes("찾기") ||
               action.useScraped === "auto" ||
               action.useScraped === "true" ||
               (action.selector && (action.selector.includes("search") || action.selector.includes("srch")))) &&
              (!isExplicitTextGiven || action.useScraped === "true");

            if (shouldPreScrapeSearch) {
              const liveKeyword = await scrapeLiveText(page, action);
              if (liveKeyword) {
                console.log(`  [🔍 실시간 DB 연동 검색] 검색어가 비어있거나 동적 스크래핑이 지정되어 현재 화면 목록 데이터("${liveKeyword}")로 검색합니다.`);
                text = liveKeyword;
                if (action.scrapeAs) runtimeVariables.set(action.scrapeAs, text);
              }
            }

            if (isSearchInput && text && text.trim().length > 0) {
              runtimeVariables.set("lastSearchKeyword", text.trim());
              currentRuntimeVariables.set("lastSearchKeyword", text.trim());
            }
          }

          const lowerSel = (action.selector || "").toLowerCase();
          const isTimeOrDate =
            lowerSel.includes("hour") ||
            lowerSel.includes("minute") ||
            lowerSel.includes("time") ||
            lowerSel.includes("date") ||
            desc.includes("시간") ||
            desc.includes("날짜") ||
            desc.includes("일시") ||
            /^\d{1,2}:\d{2}/.test(text.trim()) ||
            /^\d{4}-\d{2}-\d{2}/.test(text.trim());

          const isTitleField =
            !isTimeOrDate &&
            ((action.selector && (
              lowerSel.includes("subject") ||
              lowerSel.includes("title") ||
              lowerSel.includes("name") ||
              lowerSel.includes("doctitle")
            )) ||
            desc.includes("제목") ||
            desc.includes("명칭") ||
            desc.includes("과제") ||
            desc.includes("문서명") ||
            desc.includes("일정명") ||
            desc.includes("기안명"));

          if (isTitleField && text && text.trim().length >= 2) {
            const cleanTitle = text.trim();
            runtimeVariables.set("lastCreatedTitle", cleanTitle);
            currentRuntimeVariables.set("lastCreatedTitle", cleanTitle);

            const words = cleanTitle.split(/\s+/);
            const keyword = words.length >= 2 ? `${words[0]} ${words[1]}` : words[0];
            runtimeVariables.set("lastCreatedKeyword", keyword);
            currentRuntimeVariables.set("lastCreatedKeyword", keyword);
            console.log(`  [📌 신규 등록 엔티티 추적] 등록 항목 제목 감지: "${cleanTitle}" (키워드: "${keyword}")`);
          }

          if (action.scrapeAs && text) {
            runtimeVariables.set(action.scrapeAs, text);
            currentRuntimeVariables.set(action.scrapeAs, text);
          }

          if (isSynapEditor || (isRichTextEditor && editorPlacement?.hasExistingText)) {
            if (!text) {
              console.log(`  [⌫ 백스페이스 입력 초기화] 에디터 내용을 백스페이스로 지웁니다.`);
              await page.keyboard.press("Control+A").catch(() => {});
              await page.keyboard.press("Backspace").catch(() => {});
            } else if (text.includes("\n")) {
              const lines = text.replace(/\r\n/g, "\n").split("\n");
              for (let lIdx = 0; lIdx < lines.length; lIdx++) {
                if (lines[lIdx].length > 0) {
                  await page.keyboard.type(lines[lIdx], { delay: 40 });
                }
                if (lIdx < lines.length - 1) {
                  await page.keyboard.press("Enter");
                  await page.waitForTimeout(120);
                }
              }
            } else {
              await page.keyboard.type(text, { delay: 40 });
            }
          } else {
            // Check existing text in the input/textarea/contenteditable
            let existingVal = "";
            try {
              existingVal = await el.inputValue({ timeout: 500 }).catch(() => "");
            } catch {}

            if (!text) {
              // Explicit Backspace / Clear action recorded by user
              console.log(`  [⌫ 백스페이스 입력 초기화] 기존 입력 내용("${existingVal}")을 백스페이스로 지웁니다.`);
              try {
                if (existingVal && existingVal.length > 0 && existingVal.length <= 15) {
                  await el.press("End").catch(() => {});
                  for (let b = 0; b < existingVal.length; b++) {
                    await el.press("Backspace", { delay: 40 }).catch(async () => {
                      await page.keyboard.press("Backspace").catch(() => {});
                    });
                  }
                }
                await el.selectText({ timeout: 500 }).catch(() => {});
                await el.press("Backspace").catch(async () => {
                  await page.keyboard.press("Backspace").catch(() => {});
                });
                await el.fill("").catch(() => {});
                await el.evaluate((node) => {
                  node.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", code: "Backspace", keyCode: 8, which: 8, bubbles: true }));
                  node.dispatchEvent(new KeyboardEvent("keyup", { key: "Backspace", code: "Backspace", keyCode: 8, which: 8, bubbles: true }));
                  node.dispatchEvent(new Event("input", { bubbles: true }));
                  node.dispatchEvent(new Event("change", { bubbles: true }));
                  try {
                    const w = node.ownerDocument?.defaultView as any;
                    if (w?.jQuery) {
                      w.jQuery(node).trigger("keyup");
                    }
                  } catch {}
                }).catch(() => {});
              } catch {}
            } else {
              // Clear any pre-existing text in the input/textarea before typing so repeated or default text never concatenates
              if (existingVal && existingVal.length > 0) {
                try {
                  await el.selectText({ timeout: 500 }).catch(() => {});
                  await el.press("Backspace").catch(() => {});
                  await el.fill("").catch(() => {});
                } catch {}
              }

              if (text.includes("\n")) {
                // Multi-line typing with explicit Enter key breaks between lines
                const lines = text.replace(/\r\n/g, "\n").split("\n");
                for (let lIdx = 0; lIdx < lines.length; lIdx++) {
                  const lineStr = lines[lIdx];
                  if (lineStr.length > 0) {
                    try {
                      await el.pressSequentially(lineStr, { delay: 40 });
                    } catch {
                      await page.keyboard.type(lineStr, { delay: 40 });
                    }
                  }
                  if (lIdx < lines.length - 1) {
                    await el.press("Enter").catch(async () => {
                      await page.keyboard.press("Enter").catch(() => {});
                    });
                    await page.waitForTimeout(120);
                  }
                }
              } else {
                try {
                  await el.pressSequentially(text, { delay: 40 });
                } catch (typeErr) {
                  try {
                    await el.fill(text);
                  } catch {
                    await page.keyboard.type(text, { delay: 40 });
                  }
                }
              }

              // Ensure all characters were received without drops during async rendering,
              // and ALWAYS dispatch keyup/input/change because Playwright's pressSequentially uses Input.insertText
              // for Korean Hangul characters without firing keyup (which Naonsoft search bars need to sync .srch_optn_box .keywd)
              try {
                const actualTyped = await el.inputValue({ timeout: 500 }).catch(() => null);
                if (actualTyped !== null && actualTyped !== text) {
                  await el.fill(text).catch(() => {});
                }
                await el.evaluate((node) => {
                  node.dispatchEvent(new KeyboardEvent("keyup", { key: "Process", bubbles: true }));
                  node.dispatchEvent(new Event("input", { bubbles: true }));
                  node.dispatchEvent(new Event("change", { bubbles: true }));
                  try {
                    const w = node.ownerDocument?.defaultView as any;
                    if (w?.jQuery) {
                      w.jQuery(node).trigger("keyup");
                    }
                  } catch {}
                }).catch(() => {});
              } catch {}
            }

            // If typing into Admin User Registration ID field (#orgEmpRegForm_UserId) and the ID already exists (or is in 삭제자 'R' from a previous test),
            // retire + permanently delete the pre-existing test account and re-run selectContainsUserIdWithMail so the new registration & subsequent login succeed natively!
            if (lowerSel.includes("orgempregform_userid") && text.trim().length > 0) {
              await page.waitForTimeout(450);
              const wasDuplicateId = await el.evaluate(async (node, targetUserId) => {
                const doc = node.ownerDocument;
                const w = doc?.defaultView as any;
                const chkEl = doc?.getElementById("orgEmpRegForm_UserIdCheck");
                const isInvalid = Boolean(
                  chkEl &&
                  (chkEl.classList.contains("msg_invalid") ||
                   (chkEl.textContent || "").includes("사용중") ||
                   (chkEl.textContent || "").includes("아이디"))
                );
                if (!isInvalid) return false;

                if (w?.naon?.http?.ajax) {
                  try {
                    const apiPrefix = w.frameworkProperties?.context === "/iam" ? "/api" : "/inc";
                    const empListRes: any = await new Promise((resolve) => {
                      w.naon.http.ajax({
                        url: `${apiPrefix}/organization/emp/selectEmpListJSON`,
                        data: {
                          typeStatus: "ALL",
                          searchWord: targetUserId,
                          typeSearch: "ID",
                          "paging.listBlock": 20,
                          "paging.pageNo": 1,
                          subDeptYn: "Y",
                        },
                        success: (res: any) => resolve(res),
                        error: () => resolve(null),
                      });
                    });
                    const empList = empListRes?.data?.empList || [];
                    const existingEmp = empList.find(
                      (item: any) =>
                        (item.empBean?.userId || item.userId || "").toLowerCase() === targetUserId.toLowerCase()
                    );
                    if (existingEmp) {
                      const empId = existingEmp.empBean?.empId || existingEmp.empId;
                      const empStatus = existingEmp.empBean?.empStatus || existingEmp.empStatus;
                      if (empId) {
                        if (empStatus === "W" || empStatus === "I") {
                          await new Promise((resolve) => {
                            w.naon.http.ajax({
                              contentType: "application/json",
                              url: `${apiPrefix}/organization/emp/updateRetireEmployeeList`,
                              data: {
                                deleteEmpList: [
                                  {
                                    empId,
                                    cmpId: existingEmp.empBean?.cmpId || w.loginUserInfo?.cmpId || "",
                                    empBean: {
                                      afftlsBassYn: existingEmp.empBean?.afftlsBassYn || "Y",
                                      cloudAccount: existingEmp.empBean?.cloudAccount || null,
                                    },
                                    personBean: {
                                      psnId: existingEmp.personBean?.psnId || existingEmp.empBean?.psnId || "",
                                      userName: existingEmp.personBean?.userName || existingEmp.empBean?.userName || targetUserId,
                                    },
                                  },
                                ],
                              },
                              success: (res: any) => resolve(res),
                              error: () => resolve(null),
                            });
                          });
                        }
                        await new Promise((resolve) => {
                          w.naon.http.ajax({
                            url: `${apiPrefix}/organization/emp/updateDeleteEmployeeList`,
                            data: [empId],
                            contentType: "application/json",
                            success: (res: any) => resolve(res),
                            error: () => resolve(null),
                          });
                        });
                      }
                    }
                    const regForm = w.OrgEmpRegForm || w.GW?.LOCAL?.OrgEmpRegForm;
                    if (regForm?.fn?.selectContainsUserIdWithMail) {
                      regForm.fn.selectContainsUserIdWithMail(targetUserId);
                    }
                  } catch {}
                }

                // Ensure validation badge visually shows 'ok!' immediately
                (node as HTMLElement).className = "input_txt";
                if (chkEl) {
                  chkEl.className = "validation_msg msg_valid";
                  chkEl.innerHTML = "ok!";
                }
                return true;
              }, text.trim()).catch(() => false);

              if (wasDuplicateId) {
                await page.waitForTimeout(300);
                console.log(`  [🧹 기존 중복 계정 자동 정리] 이전 테스트에서 생성된 '${text.trim()}' 중복 계정을 정리하여 신규 등록 및 후속 로그인을 클린하게 진행합니다.`);
              }
            }
          }

          // If this is a search input and the user submitted via Enter key (i.e. next non-wait action is NOT a search button click),
          // automatically press Enter so the search list updates before the next hover/click step!
          const isSearchField =
            isSearchInput ||
            lowerSel.includes("searchword") ||
            lowerSel.includes("srchword") ||
            (action.targetHtml && /searchWord|srchWord|placeholder=["'][^"']*검색/i.test(action.targetHtml));

          const hasExplicitEnter =
            Boolean(action.pressEnter) ||
            desc.includes("엔터") ||
            /\benter\b/i.test(desc);

          if ((hasExplicitEnter || isSearchField) && !isRichTextEditor) {
            let nextNonWait: BrowsePlanAction | null = null;
            for (let k = actionIdx + 1; k < plan.actions.length; k++) {
              if (plan.actions[k].type !== "wait") {
                nextNonWait = plan.actions[k];
                break;
              }
            }
            const nextDesc = (nextNonWait?.description || "").toLowerCase();
            const nextDescClean = nextDesc.replace(/['"`]/g, "");
            const nextSel = (nextNonWait?.selector || "").toLowerCase();
            const nextHtml = (nextNonWait?.targetHtml || "").toLowerCase();
            const isNextExplicitSearchBtn =
              nextNonWait?.type === "click" &&
              !nextDescClean.includes("카드") &&
              !nextDescClean.includes("양식") &&
              !nextDescClean.includes("항목") &&
              !nextDescClean.includes("결과") &&
              !nextDescClean.includes("상세") &&
              (nextDescClean.includes("검색 버튼") ||
               nextDescClean.includes("검색 실행") ||
               nextDescClean.includes("검색 아이콘") ||
               nextSel.includes("searchbtn") ||
               nextSel.includes("btnsearch") ||
               nextSel.includes("srchbtn") ||
               nextSel.includes("btnsrch") ||
               nextSel.includes("btn_srch") ||
               nextSel.includes("ico_srch") ||
               nextSel.includes("title='검색'") ||
               nextHtml.includes("ico_srch"));

            // For Eyedropper recordings, NEVER guess-press Enter before a click action unless pressEnter was explicitly recorded!
            // (Only allow implicit search Enter on legacy Eyedropper plans when the very next action is hovering a filtered search result card.)
            const isLegacyEyedropperCardHoverAfterSearch =
              isEyedropperAction &&
              isSearchField &&
              nextNonWait?.type === "hover" &&
              (nextSel.includes("aw_li") || nextSel.includes("app_work_box") || nextDescClean.includes("양식 카드"));

            const shouldPressEnter =
              hasExplicitEnter ||
              (!isEyedropperAction && isSearchField && !isNextExplicitSearchBtn) ||
              isLegacyEyedropperCardHoverAfterSearch;

            if (shouldPressEnter && !isNextExplicitSearchBtn) {
              console.log(
                hasExplicitEnter
                  ? `  [⏎ 엔터(Enter) 키 실행] 사용자가 입력 후 Enter 키를 눌렀으므로 Enter 키를 실행합니다.`
                  : `  [⏎ 검색어 엔터 실행] 후속 검색 버튼 클릭 단계가 없으므로 입력창에서 Enter 키를 눌러 검색을 즉시 실행합니다.`
              );
              await el.press("Enter").catch(async () => {
                await page.keyboard.press("Enter").catch(() => {});
              });
              await page.waitForTimeout(700);
            }
          }

          moment.keys = text;
          // 🚨 Canon 2: Track last typed input and its box for adjacent search button binding
          lastTypedInput = el;
          lastTypedBox = box;
          lastTypedTime = Date.now();
          await page.waitForTimeout(600);
          break;
        }

        case "scroll": {
          const deltaY = action.deltaY ?? 300;
          let cursorX = 960;
          let cursorY = 540;

          if (action.selector) {
            const el = await getLocatorWithWait(page, action);
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
          let el = await getLocatorWithWait(page, action);
          if (!el) {
            el = page
              .locator(
                ".ui-dialog:visible .fileinput-button:visible, .ui-dialog:visible button:has-text('파일'):visible, .fileinput-button:visible, button:has-text('파일 선택'):visible, button:has-text('내 PC'):visible, input[type='file']"
              )
              .first();
          }

          const rawFileSpec = (action.filePath || action.text || "첨부파일.txt").trim();
          const rawTokens = rawFileSpec
            .split("|")
            .map((s) => s.trim())
            .filter(Boolean);
          const resolvedFiles: string[] = [];

          for (const token of rawTokens.length > 0 ? rawTokens : ["첨부파일.txt"]) {
            const baseName = path.basename(token);
            const candidates = [
              path.isAbsolute(token) ? token : path.resolve(process.cwd(), token),
              path.join(dataDir, "uploads", baseName),
              path.join(dataDir, baseName),
              path.resolve(process.cwd(), "data", "_uploads", baseName),
            ];
            let found = candidates.find((p) => {
              try {
                return fs.existsSync(p) && fs.statSync(p).isFile();
              } catch {
                return false;
              }
            });
            if (!found) {
              const fallbackDir = path.join(dataDir, "uploads");
              fs.mkdirSync(fallbackDir, { recursive: true });
              const safeName = baseName.replace(/[<>:"/\\|?*]/g, "_") || "sample_attachment.txt";
              found = path.join(fallbackDir, safeName.includes(".") ? safeName : `${safeName}.txt`);
              if (!fs.existsSync(found)) {
                if (/\.(png|jpg|jpeg|gif)$/i.test(found)) {
                  fs.writeFileSync(
                    found,
                    Buffer.from(
                      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
                      "base64"
                    )
                  );
                } else {
                  fs.writeFileSync(found, `첨부 파일 샘플 데이터 (${safeName})\n`, "utf-8");
                }
              }
            }
            resolvedFiles.push(found);
          }

          await el.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
          await page.waitForTimeout(150);
          const box = await el.boundingBox().catch(() => null);
          if (box && box.width > 0 && box.height > 0) {
            const clamped = clampToViewport(
              box.x + box.width / 2 + (action.cursorOffset?.x || 0),
              box.y + box.height / 2 + (action.cursorOffset?.y || 0),
              plan.viewport.width,
              plan.viewport.height
            );
            const cx = Math.round(clamped.x);
            const cy = Math.round(clamped.y);
            moment.cursor = { x: cx, y: cy };
            moment.target = {
              x: Math.round(Math.max(0, box.x)),
              y: Math.round(Math.max(0, box.y)),
              width: Math.round(box.width),
              height: Math.round(box.height),
            };
            await page.mouse.move(cx, cy, { steps: 8 }).catch(() => {});
            triggerClickVisualizer(page, cx, cy).catch(() => {});
          }

          moment.timestamp = Date.now() - recordingStart;

          // Strategy 1: If el is input[type='file'] or contains/wraps an input[type='file'] (e.g. .fileinput-button / .fileupload-buttonbar),
          // call setInputFiles directly so no native OS file dialog ever opens in headed mode!
          let uploaded = false;
          const elTag = await el.evaluate((node) => (node.tagName || "").toLowerCase()).catch(() => "");
          const elType = await el.evaluate((node) => ((node as HTMLInputElement).type || "").toLowerCase()).catch(() => "");

          if (elTag === "input" && elType === "file") {
            await el.setInputFiles(resolvedFiles);
            uploaded = true;
          } else {
            const innerFileInput = el.locator("input[type='file']").first();
            if ((await innerFileInput.count().catch(() => 0)) > 0) {
              await innerFileInput.setInputFiles(resolvedFiles);
              uploaded = true;
            } else {
              const barFileInput = el
                .locator(
                  "xpath=ancestor-or-self::*[contains(@class,'fileinput-button') or contains(@class,'fileupload-buttonbar') or contains(@class,'btn_file')][1]//input[@type='file']"
                )
                .first();
              if ((await barFileInput.count().catch(() => 0)) > 0) {
                await barFileInput.setInputFiles(resolvedFiles);
                uploaded = true;
              }
            }
          }

          // Strategy 2: If el is a button/label that triggers an external input[type='file'] via JS .click() or 'for' attribute,
          // intercept the filechooser event while clicking el, or fall back to nearest input[type='file'] in the container/modal/page
          if (!uploaded) {
            const fcPromise = page.waitForEvent("filechooser", { timeout: 2000 }).catch(() => null);
            await el.click({ timeout: 3000, force: true }).catch(() => {});
            const fc = await fcPromise;
            if (fc) {
              await fc.setFiles(resolvedFiles);
              uploaded = true;
            } else {
              const scopeRoot = action.iframe
                ? page.frameLocator(action.iframe.split(",")[0].trim())
                : page;
              const nearbyInput = scopeRoot
                .locator(
                  ".ui-dialog:visible input[type='file'], .fileupload-buttonbar input[type='file'], .attach_atch_box input[type='file'], .multi_upload_box input[type='file'], input[type='file']"
                )
                .first();
              if ((await nearbyInput.count().catch(() => 0)) > 0) {
                await nearbyInput.setInputFiles(resolvedFiles);
                uploaded = true;
              }
            }
          }

          console.log(
            `  [📎 파일 첨부 완료] 파일: ${resolvedFiles.map((f) => path.basename(f)).join(", ")}`
          );
          await page.waitForTimeout(1200);
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
        for (const sub of extraSubMoments) {
          moments.push(sub);
          console.log(`  [${sub.timestamp}ms] ${sub.type}: ${sub.description}`);
        }
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

  // Measure wall-clock elapsed time BEFORE closing context/browser so post-recording teardown doesn't inflate duration
  const captureEndElapsedMs = Math.max(0, Date.now() - recordingStart);

  // Persist refreshed session cookies so active sessions stay alive across scenarios
  // (Skip overwriting auth.json if the scenario intentionally performed a logout or account switch)
  try {
    const finalUrl = (pageStack[0] || page).url();
    const hasExplicitLogoutOrAccountSwitch = plan.actions.some((a) =>
      /로그아웃|btn_logout|goLogout|#userId|btnLogin|topMenu_logon/i.test(
        `${a.description || ""} ${a.selector || ""} ${a.targetHtml || ""}`
      )
    );
    if (finalUrl && !/login|sign-in|iam|oauth|sso/i.test(finalUrl) && !hasExplicitLogoutOrAccountSwitch) {
      await context.storageState({ path: authPath });
      syncAuthSession(authPath);
    } else if (hasExplicitLogoutOrAccountSwitch) {
      console.log(`  [🔒 세션 보호] 로그아웃/계정 전환 시나리오가 감지되어 기본 로그인 세션(auth.json) 덮어쓰기를 건너뜁니다.`);
    }
  } catch { }

  // Finalize video safely on Windows (handles EPERM file locks from browser preview/Express)
  const mainRecordingPage = pageStack[0] || page;
  const video = mainRecordingPage.video();
  const videoTempPath = await video?.path().catch(() => null);
  for (const seg of childPopupSegments) {
    if (!seg.videoPath) {
      seg.videoPath = await seg.page.video()?.path().catch(() => null);
    }
    if (seg.closedAtMs === undefined) {
      seg.closedAtMs = captureEndElapsedMs;
    }
  }
  await context.close().catch(() => { });
  await browser.close().catch(() => { });

  // Sleep briefly (250ms) to ensure Windows OS releases Chromium write file handles
  await new Promise((r) => setTimeout(r, 250));

  const destPath = path.join(dataDir, "recording.mp4");
  let startOffsetMs = 0;
  let finalVideoDurationMs = captureEndElapsedMs;
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
        // Transcode raw VFR WebM directly to CFR 30fps H.264 MP4 for frame-accurate Remotion seeking
        try {
          execSync(
            `ffmpeg -y -v error -i "${srcFile}" -c:v libx264 -preset veryfast -crf 18 -vf "fps=30" -pix_fmt yuv420p -g 30 -movflags +faststart "${destPath}"`,
            { stdio: "pipe" }
          );
        } catch {
          fs.copyFileSync(srcFile, destPath);
        }
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
        finalVideoDurationMs = videoDurationMs;
        // Compute initial compositor/navigation startup offset before the first screencast frame was emitted
        startOffsetMs = Math.max(0, captureEndElapsedMs - videoDurationMs);
        console.log(
          `[Sync] 비디오 길이: ${videoDurationMs}ms (캡처 경과: ${captureEndElapsedMs}ms, 초기 시작 오프셋 보정: -${startOffsetMs}ms)`
        );

        let prevTs = 0;
        for (const moment of moments) {
          if (moment.timestamp > 0) {
            const shifted = Math.round(moment.timestamp - startOffsetMs);
            moment.timestamp = Math.min(videoDurationMs, Math.max(prevTs + 33, shifted));
            prevTs = moment.timestamp;
          }
        }

        // Composite any child popup window videos onto the main recording video during their active [openSec, closeSec] intervals
        for (const seg of childPopupSegments) {
          if (seg.videoPath && seg.videoPath !== srcFile && fs.existsSync(seg.videoPath)) {
            const openSec = Math.max(0, (seg.openedAtMs - startOffsetMs) / 1000);
            const closeSec = Math.max(openSec + 0.2, ((seg.closedAtMs ?? captureEndElapsedMs) - startOffsetMs) / 1000);
            const tempCompositePath = path.join(dataDir, `recording_popup_composite_${Date.now()}.mp4`);
            try {
              console.log(
                `[🪟 팝업 영상 합성] 자식 팝업 창 녹화본을 메인 영상(${openSec.toFixed(2)}s ~ ${closeSec.toFixed(2)}s) 구간에 오버레이 합성합니다...`
              );
              execSync(
                `ffmpeg -y -v error -i "${destPath}" -itsoffset ${openSec.toFixed(3)} -i "${seg.videoPath}" -filter_complex "[1:v]fps=30,scale=${plan.viewport.width}:${plan.viewport.height}[pop];[0:v][pop]overlay=0:0:eof_action=pass:enable='between(t,${openSec.toFixed(3)},${closeSec.toFixed(3)})'[out]" -map "[out]" -c:v libx264 -preset veryfast -crf 18 -pix_fmt yuv420p -g 30 -movflags +faststart "${tempCompositePath}"`,
                { stdio: "pipe" }
              );
              if (fs.existsSync(tempCompositePath) && fs.statSync(tempCompositePath).size > 1000) {
                fs.copyFileSync(tempCompositePath, destPath);
                try { fs.unlinkSync(tempCompositePath); } catch {}
              }
            } catch (compErr: any) {
              console.warn(`[팝업 영상 합성 경고] 자식 팝업 영상 오버레이 실패: ${compErr.message}`);
              try { if (fs.existsSync(tempCompositePath)) fs.unlinkSync(tempCompositePath); } catch {}
            }
            try { fs.unlinkSync(seg.videoPath); } catch {}
          }
        }
      }
    } catch (err) {
      console.warn("비디오 메타데이터 읽기 오류:", err);
    }

    // Clean up any leftover page@*.webm files in videoDir
    try {
      for (const f of fs.readdirSync(videoDir)) {
        if (f.startsWith("page@") && f.endsWith(".webm")) {
          try { fs.unlinkSync(path.join(videoDir, f)); } catch {}
        }
      }
    } catch {}

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

  // 🌟 Pruning & 2-Pass Clean Master Re-recording:
  // If non-critical optional actions were skipped (e.g. they don't exist on this form), prune them permanently
  // so the plan and subsequent recordings are completely clean and free of dead timeouts.
  const toPrune = plan.actions.filter((a) => (a as any)._shouldPrune);
  let hasPrunedActions = false;
  if (toPrune.length > 0) {
    console.log(`\n✂️ [불필요 비필수 액션 자동 프루닝] 화면에 존재하지 않는 ${toPrune.length}개 비필수 부가 액션을 영구 제거합니다:`);
    toPrune.forEach((a) => console.log(`   - [제거] ${a.description || a.type}`));
    plan.actions = plan.actions.filter((a) => !(a as any)._shouldPrune);
    saveHealedPlan(dataDir, plan);
    hasPrunedActions = true;
  }

  const isCleanPass = process.argv.includes("--clean-pass");
  const isNoCleanPass = process.argv.includes("--no-clean-pass");

  if ((totalHealedCount > 0 || hasPrunedActions) && !isCleanPass && !isNoCleanPass) {
    console.log(`\n========================================================================`);
    console.log(`✨ [시나리오 최적화 완료] 자가 복구 ${totalHealedCount}건, 불필요 액션 프루닝 ${toPrune.length}건 반영 완료.`);
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

  // Ensure sequential moment IDs
  moments.forEach((m, idx) => {
    m.id = idx + 1;
  });

  // Write moments.json using exact video duration
  const totalDurationMs = finalVideoDurationMs;
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

// Auto-calibrate moments against video frames and generate edit plan
try {
  console.log("\nCalibrating moments & building edit plan...");
  execSync(`python scripts/calibrate-moments.py ${slug} --force`, { stdio: "inherit" });

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
  process.exit(0);
} catch (e) {
  console.warn("Could not automatically run build-edit-plan.py:", e);
  process.exit(0);
}
}

main().catch((err) => {
  console.error("Recording failed:", err);
  process.exit(1);
});













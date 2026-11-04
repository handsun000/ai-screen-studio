
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
import { captureSiteBrandFromLivePage } from "../src/services/siteBrandService";
import { generateNarrationScript } from "../src/services/narrationService";

// Universal runtime tracking for created entities across scenarios
const currentRuntimeVariables = new Map<string, string>();
// Maps demonstration-time entity IDs (that may have been deleted and recreated with a new ID during recording)
// to their newly created live runtime IDs in the DOM: oldDemoId -> newRuntimeId
const runtimeEntityIdMap = new Map<string, string>();
// Tracks entity titles/names typed during the current recording session so that if both an old
// leftover demo item and a newly created item with the same title exist on screen, the newly created one is preferred.
const runtimeCreatedTitles = new Set<string>();

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

interface TargetHtmlFingerprint {
  tag: string;
  id: string;
  attrs: Record<string, string>;
  classes: string[];
  childHooks: string[];
  childDataAttrs: Record<string, string>;
  text: string;
  compactText: string;
}

function parseTargetHtmlFingerprint(rawTargetHtml?: string): TargetHtmlFingerprint | null {
  if (!rawTargetHtml || typeof rawTargetHtml !== "string") return null;
  let targetHtml = rawTargetHtml;
  for (const [oldId, newId] of runtimeEntityIdMap.entries()) {
    if (oldId && newId && oldId !== newId && targetHtml.includes(oldId)) {
      targetHtml = targetHtml.split(oldId).join(newId);
    }
  }
  const decoded = targetHtml
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&gt;|&#62;/gi, ">")
    .replace(/&lt;|&#60;/gi, "<")
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;|&#38;/gi, "&")
    .trim();
  const openTagMatch = decoded.match(/^<([a-zA-Z0-9]+)([^<>]*)/);
  if (!openTagMatch) return null;
  const tag = openTagMatch[1].toLowerCase();
  const rawAttrs = openTagMatch[2]
    .replace(/\s+(?:oldtitle|data-original-title|data-qtip|aria-describedby)=["'][^"']*["']/gi, "")
    .replace(/\s+(?:oldtitle|data-original-title|data-qtip|aria-describedby)=["'][^"']*$/gi, "");
  const innerHtml = decoded.slice(openTagMatch[0].length);

  const idMatch = rawAttrs.match(/(?:^|\s)id=["']([^"']+)["']/i);
  const rawId = idMatch ? idMatch[1].trim() : "";
  const isUnstableId =
    /^(ui-id-|jqg|ext-gen|select2-|mceu_|cke_|tinymce|mentiony-|th\d+$|dp\d+$|ADRGR\d+$|[0-9]+$)/i.test(rawId) ||
    /[0-9a-f]{8,}/i.test(rawId);
  const id = !isUnstableId ? rawId : "";

  const ignoredDataAttrRegex = /^data-(?:toggle|dismiss|backdrop|keyboard|spy|ride|slide|placement|original-title|qtip|tooltip|placeholder|i18n|bind|reactid|v-)/i;
  const attrs: Record<string, string> = {};
  for (const attrKey of ["name", "title", "type", "value", "role", "placeholder", "for"]) {
    const m = rawAttrs.match(new RegExp(`(?:^|\\s)${attrKey}=["']([^"']+)["']`, "i"));
    if (m && m[1].trim()) {
      attrs[attrKey] = m[1].trim();
    }
  }
  for (const dm of rawAttrs.matchAll(/\b(data-[a-zA-Z0-9_-]+)=["']([^"']+)["']/gi)) {
    const k = dm[1].toLowerCase();
    const v = dm[2].trim();
    if (!ignoredDataAttrRegex.test(k) && v && v.toLowerCase() !== "empty") {
      attrs[k] = v;
    }
  }

  const transientClsRegex =
    /^(?:active|hover|focus|open|on|selected|disabled|chkbox_on|rdobtn_on|ico_chk_on|dynatree-expanded|dynatree-active|dynatree-focused|dynatree-selected|ui-state-hover|ui-state-focus|ui-state-active|_toolTip)$/i;
  const clsMatch = rawAttrs.match(/\bclass=["']([^"']+)["']/i);
  const classes = clsMatch
    ? clsMatch[1]
        .split(/\s+/)
        .map((c) => c.trim())
        .filter((c) => c && !transientClsRegex.test(c))
    : [];

  const childHooks: string[] = [];
  for (const cm of innerHtml.matchAll(/\bclass=["']([^"']+)["']/gi)) {
    for (const tok of cm[1].split(/\s+/)) {
      if (
        /^(?:scvr\d+|plt_\d+|_[a-zA-Z0-9_-]{3,})$/.test(tok) &&
        !/^_(?:search_option|search|blind|hide|hidden|punchHandle|appendBtn|writeBtn|lineSelect|addBtn|delBtn|selectBtn|setProcess|write|toolTip)$/i.test(tok)
      ) {
        if (!childHooks.includes(tok)) childHooks.push(tok);
      }
    }
  }

  const childDataAttrs: Record<string, string> = {};
  for (const cdm of innerHtml.matchAll(/\b(data-[a-zA-Z0-9_-]+)=["']([^"']+)["']/gi)) {
    const k = cdm[1].toLowerCase();
    const v = cdm[2].trim();
    if (!ignoredDataAttrRegex.test(k) && v && v.toLowerCase() !== "empty") {
      childDataAttrs[k] = v;
    }
  }

  const text = decoded
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const compactText = text.replace(/\s+/g, "");

  return { tag, id, attrs, classes, childHooks, childDataAttrs, text, compactText };
}

async function evaluateVisibleCandidatesByTargetHtml(
  loc: Locator,
  visibleIndices: number[],
  fp: TargetHtmlFingerprint,
  preferNewEntityIdOverOldDemoId: boolean = false
): Promise<{ locator: Locator; isUniqueWinner: boolean }> {
  if (visibleIndices.length <= 1) {
    return { locator: loc.nth(visibleIndices[0] ?? 0), isUniqueWinner: true };
  }
  try {
    const evalRes = await loc.evaluateAll(
      (els, { fp, indices, preferNewEntityIdOverOldDemoId }) => {
        let bestIdx = indices[0];
        let bestScore = -9999;
        let bestScoreCount = 0;

        for (const idx of indices) {
          const el = els[idx] as HTMLElement | undefined;
          if (!el) continue;
          let score = 0;

          if (fp.id) {
            if (el.id === fp.id) score += 500;
            else score -= 300;
          }

          for (const [k, v] of Object.entries(fp.attrs)) {
            const actual = (el.getAttribute(k) || "").trim();
            if (k.startsWith("data-")) {
              const isEntityIdAttr = k.endsWith("-id") && k !== "data-menu-id" && k !== "data-folder-id" && k !== "data-up-page-id";
              if (preferNewEntityIdOverOldDemoId && isEntityIdAttr) {
                // If this entity title was newly created in the current recording session and v is still the unmapped
                // old demonstration ID, prefer the element with a NEW ID (actual !== v) over any leftover old demo item!
                if (actual && actual !== v) score += 350;
                else if (actual === v) score -= 250;
              } else {
                if (actual === v) score += 350;
                else if (actual) score -= 300;
                else score -= 120;
              }
            } else if (k === "name" || k === "for" || k === "value") {
              if (actual === v) score += 240;
              else if (actual) score -= 180;
            } else if (k === "title" || k === "placeholder") {
              const oldTitle = (el.getAttribute("data-original-title") || el.getAttribute("oldtitle") || "").trim();
              if (actual === v || oldTitle === v) score += 200;
              else if (actual && actual !== v) score -= 150;
            } else if (actual === v) {
              score += 50;
            }
          }

          for (const cls of fp.classes) {
            if (el.classList && el.classList.contains(cls)) {
              score += 25;
            }
          }

          for (const chCls of fp.childHooks) {
            if (el.querySelector && el.querySelector(`.${chCls}`)) {
              score += 280;
            } else {
              score -= 120;
            }
          }

          for (const [ck, cv] of Object.entries(fp.childDataAttrs)) {
            try {
              if (el.querySelector && el.querySelector(`[${ck}='${cv.replace(/'/g, "\\'")}']`)) {
                score += 280;
              }
            } catch {}
          }

          if (fp.compactText && el.tagName.toLowerCase() !== "input" && el.tagName.toLowerCase() !== "textarea") {
            const rawElText = (el.innerText || el.textContent || "").replace(/\s+/g, "");
            if (rawElText === fp.compactText) {
              score += 220;
            } else if (rawElText && (rawElText.includes(fp.compactText) || fp.compactText.includes(rawElText))) {
              score += 90;
            } else if (rawElText) {
              score -= 120;
            }
          }

          if (score > bestScore) {
            bestScore = score;
            bestIdx = idx;
            bestScoreCount = 1;
          } else if (score === bestScore) {
            bestScoreCount++;
          }
        }
        return {
          bestIdx,
          isUniqueWinner: bestScore > 0 && bestScoreCount === 1,
        };
      },
      { fp, indices: visibleIndices, preferNewEntityIdOverOldDemoId }
    );
    return {
      locator: loc.nth(typeof evalRes?.bestIdx === "number" ? evalRes.bestIdx : visibleIndices[0]),
      isUniqueWinner: Boolean(evalRes?.isUniqueWinner),
    };
  } catch {
    return { locator: loc.nth(visibleIndices[0]), isUniqueWinner: false };
  }
}

async function pickBestVisibleCandidateByTargetHtml(
  loc: Locator,
  visibleIndices: number[],
  fp: TargetHtmlFingerprint,
  preferNewEntityIdOverOldDemoId: boolean = false
): Promise<Locator> {
  const res = await evaluateVisibleCandidatesByTargetHtml(loc, visibleIndices, fp, preferNewEntityIdOverOldDemoId);
  return res.locator;
}

async function getLocatorWithWait(page: Page, action: BrowsePlanAction, isFastCheck: boolean = false): Promise<Locator | null> {
  // Ensure newly opened popup windows or navigating frames have reached DOM readiness before querying
  const readyState = await page.evaluate(() => document.readyState).catch(() => "complete");
  if (readyState === "loading") {
    await page.waitForLoadState("domcontentloaded", { timeout: 3500 }).catch(() => {});
  }

  const originalSelector = action.selector;
  const rawParts = splitSelectorCandidates(action.selector || "");
  const parts = action.recordedByEyedropper ? rawParts : sortSelectorsBySpecificity(rawParts);

  const topAttempts = isFastCheck ? 1 : 2;
  const allAttempts = isFastCheck ? 2 : 5;

  // 1. 초기 시도는 명시적 후보 셀렉터들(onlyExplicitParts=true)만으로 탐색하여,
  // 화면 로딩 중 3-B-TargetHtml / 3-C / 4 폴백으로 조기 이탈하지 않도록 보장
  // (후보 중 뒤쪽에 위치한 구조적 :nth-of-type 후보가 잘리지 않도록 최대 12개까지 포함)
  if (parts.length > 1) {
    const topCandidates = parts.slice(0, Math.min(12, parts.length)).join(", ");
    action.selector = topCandidates;
    for (let i = 0; i < topAttempts; i++) {
      const el = await getLocator(page, action, false, i >= 1, true);
      if (el && (await el.isVisible().catch(() => false))) {
        action.selector = originalSelector;
        return el;
      }
      await page.waitForTimeout(300);
    }
    action.selector = originalSelector; // 복원
  }

  // 2. 구체적 셀렉터가 당장 보이지 않으면, 모든 후보 셀렉터(parts 전체)를 순서대로 탐색
  // (카드/행 마우스 호버 노출은 즉시 허용하되, 드롭다운 클릭은 마지막 회차에만 허용)
  let el: Locator | null = null;
  action.selector = parts.join(", ");
  for (let i = 0; i < allAttempts; i++) {
    const allowSideEffects = i === allAttempts - 1;
    const allowHoverReveal = true;
    el = await getLocator(page, action, allowSideEffects, allowHoverReveal, false);
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

async function getLocator(
  page: Page,
  action: BrowsePlanAction,
  allowSideEffectRecovery: boolean = false,
  allowHoverReveal: boolean = allowSideEffectRecovery,
  onlyExplicitParts: boolean = false
): Promise<Locator | null> {
  const desc = (action.description || "").toLowerCase();
  const rawOriginalSelector = (action.selector || "").trim();
  const targetHtmlFp = parseTargetHtmlFingerprint(action.targetHtml);

  // 1. Syntax Auto-Fixer (Heals common user input syntax errors like button:btn_svc_open -> button.btn_svc_open)
  let selector = rawOriginalSelector;

  // Apply dynamic runtime Entity ID remapping (when an item created in demonstration was deleted and recreated with a new ID during recording)
  if (runtimeEntityIdMap.size > 0) {
    for (const [oldId, newId] of runtimeEntityIdMap.entries()) {
      if (oldId && newId && oldId !== newId) {
        if (selector.includes(oldId)) {
          selector = selector.split(oldId).join(newId);
        }
        if (targetHtmlFp) {
          if (targetHtmlFp.id && targetHtmlFp.id.includes(oldId)) {
            targetHtmlFp.id = targetHtmlFp.id.split(oldId).join(newId);
          }
          for (const [k, v] of Object.entries(targetHtmlFp.attrs)) {
            if (v && v.includes(oldId)) {
              targetHtmlFp.attrs[k] = v.split(oldId).join(newId);
            }
          }
        }
      }
    }
  }

  // Helper to automatically learn oldDemoId -> newRuntimeId whenever an action's element is resolved via its name/card scope
  const learnRuntimeEntityIdIfChanged = async (resolvedLoc: Locator): Promise<Locator> => {
    const candidateIdPairs = new Map<string, string>();
    if (targetHtmlFp && targetHtmlFp.attrs) {
      for (const [attrKey, oldVal] of Object.entries(targetHtmlFp.attrs)) {
        if (
          attrKey.startsWith("data-") &&
          attrKey.endsWith("-id") &&
          attrKey !== "data-menu-id" &&
          attrKey !== "data-folder-id" &&
          attrKey !== "data-up-page-id" &&
          oldVal &&
          oldVal.length >= 5 &&
          oldVal !== "ROOT"
        ) {
          candidateIdPairs.set(attrKey, oldVal);
        }
      }
    }
    for (const m of rawOriginalSelector.matchAll(/\[(data-[a-zA-Z0-9_-]*id)=['"]([^'"]+)['"]\]/gi)) {
      const attrKey = m[1].toLowerCase();
      const oldVal = m[2].trim();
      if (
        attrKey !== "data-menu-id" &&
        attrKey !== "data-folder-id" &&
        attrKey !== "data-up-page-id" &&
        oldVal &&
        oldVal.length >= 5 &&
        oldVal !== "ROOT" &&
        !candidateIdPairs.has(attrKey)
      ) {
        candidateIdPairs.set(attrKey, oldVal);
      }
    }
    for (const m of rawOriginalSelector.matchAll(
      /\[value=['"]((?:TA|TB|TG|TT|TY|ATCL|DOC|WKS|BRD|EML|NOT|SCD|TSK|WBB|WBP)[0-9a-zA-Z]{8,})['"]\]/gi
    )) {
      const oldVal = m[1].trim();
      if (oldVal && !candidateIdPairs.has("value")) {
        candidateIdPairs.set("value", oldVal);
      }
    }

    if (candidateIdPairs.size > 0) {
      for (const [attrKey, oldVal] of candidateIdPairs.entries()) {
        if (runtimeEntityIdMap.has(oldVal)) continue;
        const liveVal = await resolvedLoc
          .evaluate((el, key) => {
            const direct = el.getAttribute(key);
            if (direct && direct.trim()) return direct.trim();
            const closestEl = el.closest(`[${key}]`);
            if (closestEl) {
              const cVal = closestEl.getAttribute(key);
              if (cVal && cVal.trim()) return cVal.trim();
            }
            const childEl = el.querySelector(`[${key}]`);
            if (childEl) {
              const chVal = childEl.getAttribute(key);
              if (chVal && chVal.trim()) return chVal.trim();
            }
            if (key === "data-org-page-id" || key === "data-page-id") {
              const altKey = key === "data-org-page-id" ? "data-page-id" : "data-org-page-id";
              const altClosest = el.closest(`[${altKey}]`);
              if (altClosest) {
                const aVal = altClosest.getAttribute(altKey);
                if (aVal && aVal.trim()) return aVal.trim();
              }
            }
            return null;
          }, attrKey)
          .catch(() => null);
        if (liveVal && liveVal !== oldVal && !runtimeEntityIdMap.has(oldVal)) {
          runtimeEntityIdMap.set(oldVal, liveVal);
          console.log(
            `  [🔄 신규 생성 ID 동적 매핑] 시연 중 삭제·재생성된 항목 ID를 현재 런타임 ID로 자동 연결합니다 (${attrKey}: ${oldVal} ➔ ${liveVal})`
          );
        }
      }
    }
    return resolvedLoc;
  };

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

  // Filter out dummy onclick='return false;' candidates, generic :has(.ico_*), expand ephemeral entity IDs, and prioritize structural :nth-of-type / :has-text ahead of generic [title]
  const rawSplitCandidates = splitSelectorCandidates(selector).filter(
    (p) => !/\[onclick\*=['"]?(?:return\s+(?:false|true)|javascript:|void\s*\(0\))/i.test(p)
  );
  const nonIconCandidates = rawSplitCandidates.filter((p) => !/:has\(\.ico_[a-zA-Z0-9_-]+\)/i.test(p));
  const baseCandidates = nonIconCandidates.length > 0 ? nonIconCandidates : rawSplitCandidates;
  const expandedCandidates: string[] = [];
  for (const part of baseCandidates) {
    const strippedEphemeralAttr = part.replace(
      /\[data-[a-z0-9_-]*id=['"](?:TA|TB|TG|TT|TY|ATCL|DOC|WKS|BRD|EML|NOT|SCD|TSK|WBB|WBP)[0-9a-z]{12,}['"]\]/gi,
      ""
    );
    if (strippedEphemeralAttr !== part && strippedEphemeralAttr.includes(":nth-of-type(")) {
      expandedCandidates.push(strippedEphemeralAttr);
    }
    expandedCandidates.push(part);
    const ephHashM = part.match(
      /^(\.ui-dialog:visible\s+)?(li|div|tr)#([a-zA-Z0-9_]*?)((?:TA|TB|TG|TT|TY|ATCL|DOC|WKS|BRD|EML|NOT|SCD|TSK|WBB|WBP)[0-9a-z]{12,})(\s+.*)$/i
    );
    if (ephHashM && ephHashM[3] && ephHashM[3].length >= 4) {
      const dlgPre = ephHashM[1] || "";
      expandedCandidates.push(`${dlgPre}${ephHashM[2]}[id^='${ephHashM[3]}']${ephHashM[5]}`);
    }
  }
  const hasStructuralNthInExpanded = expandedCandidates.some((p) =>
    /(?:div|li|tr|ul|dl|dd|td)[^,>]*:nth-of-type\(\d+\)\s*>/i.test(p)
  );
  const cleanedCandidates = hasStructuralNthInExpanded
    ? [
        ...expandedCandidates.filter(
          (p) =>
            /(?:div|li|tr|ul|dl|dd|td)[^,>]*:nth-of-type\(\d+\)\s*>|:(?:has-text|text-is)\(/i.test(p) ||
            !/\[title=['"][^'"]+['"]\]/i.test(p)
        ),
        ...expandedCandidates.filter(
          (p) =>
            !/(?:div|li|tr|ul|dl|dd|td)[^,>]*:nth-of-type\(\d+\)\s*>|:(?:has-text|text-is)\(/i.test(p) &&
            /\[title=['"][^'"]+['"]\]/i.test(p)
        ),
      ]
    : expandedCandidates;
  if (cleanedCandidates.length > 0) {
    selector = Array.from(new Set(cleanedCandidates)).join(", ");
  }
  action.selector = selector;

  // Determine if this action targets a specific entity and whether that entity was newly created in the current recording session
  const rawPartsForOrder = splitSelectorCandidates(action.selector);
  const parts = action.recordedByEyedropper ? [...rawPartsForOrder] : sortSelectorsBySpecificity(rawPartsForOrder);
  const hasSpecificEntityInAction =
    Boolean(
      targetHtmlFp &&
        Object.keys(targetHtmlFp.attrs).some(
          (k) =>
            k.startsWith("data-") &&
            !/^data-(?:menu-id|menu-name|folder-id|folder-name|folder-type|page-mode|tab|search-type|app-type-se|app-type-ordr|up-page-id)$/i.test(
              k
            )
        )
    ) || parts.some((p) => /\b(?:li|tr):has-text\(['"][^'"]+['"]\)/i.test(p));

  const targetsNewlyCreatedEntityInRun =
    runtimeCreatedTitles.size > 0 &&
    Array.from(runtimeCreatedTitles).some(
      (title) =>
        selector.includes(title) ||
        (action.targetHtml && action.targetHtml.includes(title)) ||
        (action.description && action.description.includes(title))
    );

  const hasUnmappedOldDemoId = (partStr: string): boolean => {
    if (!targetsNewlyCreatedEntityInRun) return false;
    for (const m of partStr.matchAll(/\[data-[a-zA-Z0-9_-]*id=['"]([^'"]+)['"]\]/gi)) {
      const idVal = m[1].trim();
      const isMappedNewId = Array.from(runtimeEntityIdMap.values()).includes(idVal);
      if (idVal && !isMappedNewId && !runtimeEntityIdMap.has(idVal)) {
        return true;
      }
    }
    for (const m of partStr.matchAll(
      /\[value=['"]((?:TA|TB|TG|TT|TY|ATCL|DOC|WKS|BRD|EML|NOT|SCD|TSK|WBB|WBP)[0-9a-zA-Z]{8,})['"]\]/gi
    )) {
      const idVal = m[1].trim();
      const isMappedNewId = Array.from(runtimeEntityIdMap.values()).includes(idVal);
      if (idVal && !isMappedNewId && !runtimeEntityIdMap.has(idVal)) {
        return true;
      }
    }
    for (const m of partStr.matchAll(
      /\b(?:li|div|tr)#([a-zA-Z0-9_]*(?:TA|TB|TG|TT|TY|ATCL|DOC|WKS|BRD|EML|NOT|SCD|TSK|WBB|WBP)[0-9a-zA-Z]{12,})\b/gi
    )) {
      const idVal = m[1].trim();
      const isMappedNewId = Array.from(runtimeEntityIdMap.values()).includes(idVal);
      if (idVal && !isMappedNewId && !runtimeEntityIdMap.has(idVal)) {
        return true;
      }
    }
    return false;
  };

  const primaryParts = targetsNewlyCreatedEntityInRun ? parts.filter((p) => !hasUnmappedOldDemoId(p)) : parts;
  const deferredOldIdParts = targetsNewlyCreatedEntityInRun ? parts.filter((p) => hasUnmappedOldDemoId(p)) : [];
  const orderedParts = [...primaryParts, ...deferredOldIdParts];

  // Build candidate bases: prioritized by action.iframe (only if present on current page!), active child frames (page.frames()), and fallback to page and common iframes
  const candidateBases: Array<{ name: string; locator: (sel: string) => Locator }> = [];
  if (action.iframe) {
    const iframeParts = splitSelectorCandidates(action.iframe);
    for (const fSel of iframeParts) {
      if (!fSel) continue;
      const frameCount = await page.locator(fSel).count().catch(() => 0);
      if (frameCount > 0) {
        candidateBases.push({
          name: `iframe(${fSel})`,
          locator: (sel: string) => page.frameLocator(fSel).first().locator(sel),
        });
      }
    }
    // Also traverse all active child frames in page.frames() in reverse (newest modal/popup frame first)
    for (const frame of [...page.frames()].reverse()) {
      if (frame !== page.mainFrame() && !frame.isDetached()) {
        candidateBases.push({
          name: `frame(${frame.name() || frame.url()})`,
          locator: (sel: string) => frame.locator(sel),
        });
      }
    }
    // Fallback to top-level page in case iframe isn't used or was opened as a top-level popup window
    candidateBases.push({
      name: "page(top-level fallback)",
      locator: (sel: string) => page.locator(sel),
    });
  } else {
    candidateBases.push({
      name: "page(main)",
      locator: (sel: string) => page.locator(sel),
    });
    // Also check all active child frames in page.frames() in reverse (newest modal/popup frame first)
    for (const frame of [...page.frames()].reverse()) {
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

  // 2. Active modal dialog scoping (Handles stacked/nested dialogs by prioritizing topmost modal by z-index; skip when action targets an explicit iframe)
  const dialogLoc = page.locator(".ui-dialog:visible, .modal:visible, .layer_wrap:visible, .equ_select_lyr:visible, [role='dialog']:visible");
  const dialogCount = !action.iframe ? await dialogLoc.count().catch(() => 0) : 0;
  const hasOverlay = !action.iframe && (await page.locator(".ui-widget-overlay:visible, .modal-backdrop:visible").count().catch(() => 0)) > 0;

  if (dialogCount > 0 && action.selector) {
    const dialogSelectors = orderedParts;

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
      const hasDialogIframe = (await topDialog.locator("iframe:visible").count().catch(() => 0)) > 0;
      let multiMatchModalFallback: { locator: Locator; cleanSel: string } | null = null;
      for (const s of dialogSelectors) {
        const isLast = s.endsWith(":last") || s.includes(":last");
        let cleanSel = s.replace(/^\.ui-dialog:visible\s*/, "").replace(/^\.modal:visible\s*/, "").trim();
        cleanSel = cleanSel.replace(/:first\b/g, "").replace(/:last\b/g, "").trim();
        if (!cleanSel) continue;

        try {
          let candLoc = topDialog.locator(cleanSel);
          let cCount = await candLoc.count().catch(() => 0);
          if (cCount === 0 && hasDialogIframe) {
            candLoc = topDialog.frameLocator("iframe:visible").first().locator(cleanSel);
            cCount = await candLoc.count().catch(() => 0);
          }
          if (cCount > 0) {
            if (isLast) {
              const lastCand = candLoc.last();
              if (await lastCand.isVisible().catch(() => false)) {
                console.log(`  [🎯 최상단 모달 요소 감지] 활성 팝업(z-index 우선) 내부에서 '${cleanSel}' 요소를 우선 선택합니다.`);
                return await learnRuntimeEntityIdIfChanged(lastCand);
              }
            }
            const visIndices: number[] = [];
            for (let ci = 0; ci < Math.min(cCount, 15); ci++) {
              if (await candLoc.nth(ci).isVisible().catch(() => false)) {
                visIndices.push(ci);
              }
            }
            if (visIndices.length === 1) {
              console.log(`  [🎯 최상단 모달 요소 감지] 활성 팝업(z-index 우선) 내부에서 '${cleanSel}' 유일 매칭 요소를 선택합니다.`);
              return await learnRuntimeEntityIdIfChanged(candLoc.nth(visIndices[0]));
            }
            if (visIndices.length > 1) {
              if (targetHtmlFp) {
                const evalRes = await evaluateVisibleCandidatesByTargetHtml(
                  candLoc,
                  visIndices,
                  targetHtmlFp,
                  targetsNewlyCreatedEntityInRun
                );
                if (evalRes.isUniqueWinner) {
                  console.log(`  [🎯 최상단 모달 요소 감지] 활성 팝업(z-index 우선) 내부에서 '${cleanSel}' 요소를 우선 선택합니다.`);
                  return await learnRuntimeEntityIdIfChanged(evalRes.locator);
                }
                if (!multiMatchModalFallback) {
                  multiMatchModalFallback = { locator: evalRes.locator, cleanSel };
                }
              } else if (!multiMatchModalFallback) {
                multiMatchModalFallback = { locator: candLoc.nth(visIndices[0]), cleanSel };
              }
            }
          }
        } catch {
          // Gracefully skip invalid selector syntax
        }
      }
      if (multiMatchModalFallback) {
        console.log(`  [🎯 최상단 모달 요소 감지] 활성 팝업(z-index 우선) 내부에서 '${multiMatchModalFallback.cleanSel}' 요소를 선택합니다.`);
        return await learnRuntimeEntityIdIfChanged(multiMatchModalFallback.locator);
      }
    }

    // 2-B. Check floating body-level popovers (date/time pickers, autocomplete/select dropdowns, context menus)
    // that render on <body> outside the .ui-dialog DOM subtree
    for (const s of dialogSelectors) {
      const cleanS = s
        .replace(/^\.ui-dialog:visible\s*/, "")
        .replace(/^\.modal:visible\s*/, "")
        .replace(/:first\b/g, "")
        .replace(/:last\b/g, "")
        .trim();
      if (!cleanS) continue;
      // Only allow root fallback when selector has a specific #id, class, attribute, or structural path (never bare 'button:visible' or 'a:visible')
      if (/^[a-z]+(?::visible)?$/i.test(cleanS)) continue;
      if (hasOverlay && /^button\b/i.test(cleanS) && !cleanS.includes("#")) continue;
      try {
        const floatLoc = page.locator(cleanS);
        const fCount = await floatLoc.count().catch(() => 0);
        if (fCount === 1 && (await floatLoc.first().isVisible().catch(() => false))) {
          return await learnRuntimeEntityIdIfChanged(floatLoc.first());
        }
      } catch {}
    }

    if (!hasOverlay) {
      let multiMatchDirectModalFallback: Locator | null = null;
      for (const baseObj of candidateBases) {
        for (const s of dialogSelectors) {
          if (s.includes(".ui-dialog") || s.includes(".modal") || s.includes("layer")) {
            const isLast = s.endsWith(":last") || s.includes(":last");
            let cleanS = s.replace(/:first\b/g, "").replace(/:last\b/g, "").trim();
            if (!cleanS) continue;
            try {
              const directLoc = baseObj.locator(cleanS);
              const dCount = await directLoc.count().catch(() => 0);
              if (dCount > 0) {
                if (isLast) {
                  const lastCand = directLoc.last();
                  if (await lastCand.isVisible().catch(() => false)) return await learnRuntimeEntityIdIfChanged(lastCand);
                }
                const visIndices: number[] = [];
                for (let di = 0; di < Math.min(dCount, 15); di++) {
                  if (await directLoc.nth(di).isVisible().catch(() => false)) {
                    visIndices.push(di);
                  }
                }
                if (visIndices.length === 1) {
                  return await learnRuntimeEntityIdIfChanged(directLoc.nth(visIndices[0]));
                }
                if (visIndices.length > 1) {
                  if (targetHtmlFp) {
                    const evalRes = await evaluateVisibleCandidatesByTargetHtml(
                      directLoc,
                      visIndices,
                      targetHtmlFp,
                      targetsNewlyCreatedEntityInRun
                    );
                    if (evalRes.isUniqueWinner) {
                      return await learnRuntimeEntityIdIfChanged(evalRes.locator);
                    }
                    if (!multiMatchDirectModalFallback) {
                      multiMatchDirectModalFallback = evalRes.locator;
                    }
                  } else if (!multiMatchDirectModalFallback) {
                    multiMatchDirectModalFallback = directLoc.nth(visIndices[0]);
                  }
                }
              }
            } catch {}
          }
        }
      }
      if (multiMatchDirectModalFallback) {
        return await learnRuntimeEntityIdIfChanged(multiMatchDirectModalFallback);
      }
    }

  }

  // 3. Search target selector across candidate bases
  if (action.selector) {
    const isUnscopedGenericActionButtonPart = (partStr: string): boolean => {
      if (!hasSpecificEntityInAction) return false;
      if (/\[data-[a-zA-Z0-9_-]+=/i.test(partStr)) return false;
      if (/\b(?:li|tr|dd|td):has-text\(/i.test(partStr)) return false;
      if (/:(?:nth-of-type|nth-child)\(/i.test(partStr)) return false;
      // Check if there is an #id on the target leaf element itself (as opposed to only a container prefix like ul#wikiBookList_list)
      const leafSegment = partStr.trim().split(/\s+/).pop() || "";
      if (leafSegment.includes("#")) return false;
      const textOrTitleM = partStr.match(/(?::(?:has-text|text-is)\(['"]([^'"]+)['"]\)|\[title=['"]([^'"]+)['"]\])/i);
      const txtVal = (textOrTitleM?.[1] || textOrTitleM?.[2] || "").trim();
      if (txtVal && !/^(?:목록|삭제|옵션|수정|메뉴|더보기|설정|선택|보기|추가|확인)$/i.test(txtVal)) {
        return false;
      }
      return true;
    };

    // 3-B. Prioritize elements that are currently visible on screen across bases (preferring 1-of-1 unique matches over 1-of-N multi-matches)
    let multiMatchStep3Fallback: Locator | null = null;
    for (const rawPart of orderedParts) {
      const isLast = rawPart.endsWith(":last") || rawPart.includes(":last");
      const cleanPart = rawPart.replace(/:first\b/g, "").replace(/:last\b/g, "").trim();
      if (!cleanPart) continue;
      const isUnscopedGenericBtn = isUnscopedGenericActionButtonPart(cleanPart);

      for (const baseObj of candidateBases) {
        try {
          const loc = baseObj.locator(cleanPart);
          const count = await loc.count().catch(() => 0);
          if (count > 0) {
            // Never let an unscoped generic button fallback (e.g. ul#wikiBookList_list button._deleteBook:visible)
            // guess the 1st item in a multi-item list when the action targets a specific entity!
            if (isUnscopedGenericBtn) {
              const totalDomButtons = await baseObj
                .locator(cleanPart.replace(/:visible\s*$/i, "").trim())
                .count()
                .catch(() => count);
              if (totalDomButtons > 1) {
                continue;
              }
            }
            if (isLast) {
              const lastCand = loc.last();
              if (await lastCand.isVisible().catch(() => false)) return await learnRuntimeEntityIdIfChanged(lastCand);
            }
            const visIndices: number[] = [];
            for (let i = 0; i < Math.min(count, 15); i++) {
              if (await loc.nth(i).isVisible().catch(() => false)) {
                visIndices.push(i);
              }
            }
            if (visIndices.length === 1) {
              return await learnRuntimeEntityIdIfChanged(loc.nth(visIndices[0]));
            }
            if (visIndices.length > 1) {
              if (targetHtmlFp) {
                const evalRes = await evaluateVisibleCandidatesByTargetHtml(
                  loc,
                  visIndices,
                  targetHtmlFp,
                  targetsNewlyCreatedEntityInRun
                );
                if (evalRes.isUniqueWinner) {
                  return await learnRuntimeEntityIdIfChanged(evalRes.locator);
                }
                if (!multiMatchStep3Fallback) {
                  multiMatchStep3Fallback = evalRes.locator;
                }
              } else if (!multiMatchStep3Fallback) {
                multiMatchStep3Fallback = loc.nth(visIndices[0]);
              }
            }
          }
        } catch {}
      }
    }
    if (multiMatchStep3Fallback) {
      return await learnRuntimeEntityIdIfChanged(multiMatchStep3Fallback);
    }

    // 3-B-Hover. Resolve CSS-hidden checkbox/radio to wrapping <label>, Auto-Hover Item/Card Container, or (on final retry) Expand Closed Dropdown
    // Runs BEFORE 3-B-TargetHtml so hover-revealed buttons inside cards/rows (#52 '목록', #88 '삭제', #148 '옵션') are revealed on their exact card/row!
    if (action.type === "click" || action.type === "dblclick") {
      const testedHoverKeys = new Set<string>();
      for (const rawPart of orderedParts) {
        const cleanPart = rawPart
          .replace(/:first\b/g, "")
          .replace(/:last\b/g, "")
          .replace(/:visible\s*$/i, "")
          .trim();
        if (!cleanPart) continue;
        const isUnscopedGenericBtn = isUnscopedGenericActionButtonPart(cleanPart);

        for (const baseObj of candidateBases) {
          try {
            const hiddenLoc = baseObj.locator(cleanPart);
            const hiddenCount = await hiddenLoc.count().catch(() => 0);
            if (hiddenCount > 0) {
              // Never hover the 1st card/row in a multi-item list using an unscoped generic button fallback!
              if (isUnscopedGenericBtn && hiddenCount > 1) {
                continue;
              }
              for (let i = 0; i < Math.min(hiddenCount, 4); i++) {
                const candidate = hiddenLoc.nth(i);
                const tagAndType = await candidate
                  .evaluate((el) => ({
                    tag: el.tagName.toLowerCase(),
                    type: ((el as HTMLInputElement).type || "").toLowerCase(),
                    id: el.id || "",
                    isInsideMenu: Boolean(el.closest(".options, .select_list, .drop_menu, .dropdown-menu")),
                    isTriggerItself: Boolean(
                      el.classList.contains("drop_value") ||
                        el.classList.contains("drop_tgl") ||
                        el.classList.contains("select_Value") ||
                        el.classList.contains("select_btn")
                    ),
                  }))
                  .catch(() => ({ tag: "", type: "", id: "", isInsideMenu: false, isTriggerItself: false }));

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

                // Only click a custom dropdown trigger on the final retry if candidate is an option INSIDE a hidden menu AND the dropdown is currently closed!
                if (allowSideEffectRecovery && tagAndType.isInsideMenu && !tagAndType.isTriggerItself) {
                  const dropdownTrigger = candidate
                    .locator(
                      "xpath=ancestor::*[contains(@class,'Selected') or contains(@class,'select_box') or contains(@class,'combobox') or contains(@class,'btn_drop')][1]"
                    )
                    .first();
                  const isDropdownClosed = await dropdownTrigger
                    .evaluate((node) => {
                      if (node.classList.contains("open")) return false;
                      const menu = node.querySelector(".options, .select_list, .drop_menu, .dropdown-menu") as HTMLElement | null;
                      if (menu && window.getComputedStyle(menu).display !== "none" && menu.offsetWidth > 0) return false;
                      return true;
                    })
                    .catch(() => false);

                  if (isDropdownClosed && (await dropdownTrigger.isVisible().catch(() => false))) {
                    console.log(
                      `  [🔽 커스텀 드롭다운 자동 펼침] '${cleanPart}' 옵션이 닫힌 드롭다운 내부에 숨겨져 있어 상위 트리거를 먼저 클릭합니다.`
                    );
                    await dropdownTrigger.click({ timeout: 1500 }).catch(() => {});
                    await page.waitForTimeout(350);
                    if (await candidate.isVisible().catch(() => false)) {
                      return await learnRuntimeEntityIdIfChanged(candidate);
                    }
                  }
                }

                // Universal Item/Card Hover-Reveal: If candidate exists in DOM inside a visible item/card/row (li, tr, dd, td, or card box)
                // and no intermediate panel/section ancestor is hidden, move the mouse over that item container to trigger CSS :hover reveal!
                if (allowHoverReveal && !tagAndType.isInsideMenu) {
                  const hoverTargetBox = await candidate
                    .evaluate((el) => {
                      let cur: HTMLElement | null = el.parentElement;
                      let depth = 0;
                      let hoverEl: HTMLElement | null = null;
                      while (cur && cur !== document.body && depth < 6) {
                        const st = window.getComputedStyle(cur);
                        const r = cur.getBoundingClientRect();
                        const isVis =
                          st.display !== "none" &&
                          st.visibility !== "hidden" &&
                          st.opacity !== "0" &&
                          r.width > 0 &&
                          r.height > 0;
                        if (!isVis) {
                          const tag = cur.tagName.toLowerCase();
                          if (
                            tag === "form" ||
                            tag === "section" ||
                            tag === "article" ||
                            tag === "ul" ||
                            tag === "table" ||
                            cur.classList.contains("ui-dialog") ||
                            cur.classList.contains("drop_menu") ||
                            cur.classList.contains("dropdown-menu") ||
                            (cur.id && !cur.classList.contains("btn_area") && !cur.classList.contains("optn"))
                          ) {
                            return null;
                          }
                        } else {
                          const tag = cur.tagName.toLowerCase();
                          const isItemContainer =
                            tag === "li" ||
                            tag === "tr" ||
                            tag === "dd" ||
                            tag === "td" ||
                            (r.width >= 40 && r.width <= 680 && r.height >= 20 && r.height <= 480);
                          if (isItemContainer && r.width <= 1900 && r.height <= 550) {
                            hoverEl = cur;
                            break;
                          }
                        }
                        cur = cur.parentElement;
                        depth++;
                      }
                      if (!hoverEl) return null;
                      hoverEl.scrollIntoView({ block: "nearest", inline: "nearest" });
                      const hr = hoverEl.getBoundingClientRect();
                      if (hr.width <= 0 || hr.height <= 0) return null;
                      return {
                        x: Math.round(hr.left + hr.width / 2),
                        y: Math.round(hr.top + hr.height / 2),
                        key: `${hoverEl.tagName}#${hoverEl.id}.${Array.from(hoverEl.classList).join(".")}@${Math.round(hr.left)},${Math.round(hr.top)}`,
                      };
                    })
                    .catch(() => null);

                  if (hoverTargetBox && !testedHoverKeys.has(hoverTargetBox.key)) {
                    testedHoverKeys.add(hoverTargetBox.key);
                    await page.mouse.move(hoverTargetBox.x, hoverTargetBox.y).catch(() => {});
                    await page.waitForTimeout(350);
                    if (await candidate.isVisible().catch(() => false)) {
                      console.log(
                        `  [✨ 호버 노출 자동 실행] 부모 항목 마우스 호버로 숨김 상태였던 '${cleanPart}' 요소를 노출시켰습니다!`
                      );
                      return await learnRuntimeEntityIdIfChanged(candidate);
                    }
                  }
                }
              }
            }
          } catch {}
        }
      }
    }

    if (onlyExplicitParts) {
      return null;
    }

    // 3-B-TargetHtml. Fast Direct DOM Fingerprint Match via action.targetHtml (after 3-B-Hover, before AI Self-Healer)
    if (action.recordedByEyedropper && targetHtmlFp && targetHtmlFp.tag) {
      for (const baseObj of candidateBases) {
        try {
          const tagLoc = baseObj.locator(`${targetHtmlFp.tag}:visible`);
          const tCount = await tagLoc.count().catch(() => 0);
          if (tCount > 0 && tCount <= 120) {
            const matchedIdx = await tagLoc
              .evaluateAll(
                (els, fp) => {
                  const dataAttrEntries = Object.entries(fp.attrs).filter(([k]) => k.startsWith("data-"));
                  let bestIdx = -1;
                  let bestScore = 179; // Require at least 180 points (exact id, data-*, title, child hook, or class+text)
                  for (let i = 0; i < els.length; i++) {
                    const el = els[i] as HTMLElement | undefined;
                    if (!el) continue;
                    let score = 0;

                    if (fp.id) {
                      if (el.id === fp.id) score += 500;
                      else continue;
                    }

                    if (dataAttrEntries.length > 0) {
                      let matchedAnyDataAttr = false;
                      let hadConflictingDataAttr = false;
                      for (const [dk, dv] of dataAttrEntries) {
                        const actualD = (el.getAttribute(dk) || "").trim();
                        if (actualD === dv) {
                          matchedAnyDataAttr = true;
                        } else if (actualD && actualD !== dv) {
                          hadConflictingDataAttr = true;
                        }
                      }
                      if (!matchedAnyDataAttr || hadConflictingDataAttr) {
                        continue;
                      }
                    }

                    for (const [k, v] of Object.entries(fp.attrs)) {
                      const actual = (el.getAttribute(k) || "").trim();
                      if (k.startsWith("data-")) {
                        if (actual === v) score += 350;
                        else if (actual) score -= 350;
                        else score -= 180;
                      } else if (k === "name" || k === "for" || k === "value") {
                        if (actual === v) score += 240;
                        else if (actual) score -= 220;
                      } else if (k === "title" || k === "placeholder") {
                        const oldTitle = (el.getAttribute("data-original-title") || el.getAttribute("oldtitle") || "").trim();
                        if (actual === v || oldTitle === v) score += 200;
                        else if (actual && actual !== v) score -= 180;
                      }
                    }

                    for (const cls of fp.classes) {
                      if (el.classList && el.classList.contains(cls)) {
                        score += 25;
                      }
                    }

                    for (const chCls of fp.childHooks) {
                      if (el.querySelector && el.querySelector(`.${chCls}`)) {
                        score += 280;
                      } else {
                        score -= 150;
                      }
                    }

                    for (const [ck, cv] of Object.entries(fp.childDataAttrs)) {
                      try {
                        if (el.querySelector && el.querySelector(`[${ck}='${cv.replace(/'/g, "\\'")}']`)) {
                          score += 280;
                        }
                      } catch {}
                    }

                    if (fp.compactText && el.tagName.toLowerCase() !== "input" && el.tagName.toLowerCase() !== "textarea") {
                      const rawElText = (el.innerText || el.textContent || "").replace(/\s+/g, "");
                      if (rawElText === fp.compactText) {
                        score += 220;
                      } else if (rawElText && (rawElText.includes(fp.compactText) || fp.compactText.includes(rawElText))) {
                        score += 80;
                      } else if (rawElText) {
                        score -= 200;
                      }
                    }

                    if (score > bestScore) {
                      bestScore = score;
                      bestIdx = i;
                    }
                  }
                  return bestIdx;
                },
                targetHtmlFp
              )
              .catch(() => -1);

            if (matchedIdx >= 0) {
              const matchedCand = tagLoc.nth(matchedIdx);
              if (await matchedCand.isVisible().catch(() => false)) {
                console.log(
                  `  [🎯 targetHtml 지문 직접 매칭] 스포이드 원본 HTML 속성/텍스트 지문으로 '${action.description || targetHtmlFp.tag}' 요소를 즉시 특정했습니다.`
                );
                return await learnRuntimeEntityIdIfChanged(matchedCand);
              }
            }
          }
        } catch {}
      }
    }
  }

  // Do NOT return an unverified non-visible locator from top-page (which breaks iframe scoping and masks missing elements).
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
      const style = window.getComputedStyle(node);
      if (style && style.cursor === "pointer" && rect.height <= 120) {
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

  // For Eyedropper recordings, give slow AJAX lists/modals an extra settle retry before self-healing
  if (action.recordedByEyedropper || plan.recordedByEyedropper) {
    await page.waitForTimeout(900);
    const delayedLoc = await getLocator(page, action);
    if (delayedLoc && (await delayedLoc.isVisible().catch(() => false))) {
      console.log(`  [✨ 지연 렌더링 요소 확인] 비동기 로딩 대기 후 원본 요소 '${action.selector}' 탐색을 완료했습니다.`);
      return delayedLoc;
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
  const isEyedropperPlan = Boolean(action.recordedByEyedropper || plan.recordedByEyedropper);
  if (
    healResult?.success &&
    healResult.resolutionType === "INSERT_BEFORE" &&
    Array.isArray(healResult.prerequisiteActions) &&
    healResult.prerequisiteActions.length > 0 &&
    !(action as any)._attemptedInsertBefore
  ) {
    (action as any)._attemptedInsertBefore = true;
    const prevSelector = action.selector;
    const prevSourceSelector = action.sourceSelector;
    const prevTargetSelector = action.targetSelector;
    const prevIframe = action.iframe;

    console.log(
      `  [➕ AI 시나리오 동적 조정 (INSERT_BEFORE)] 누락된 선행 단계 ${healResult.prerequisiteActions.length}개를 먼저 실행하여 타겟 노출을 시도합니다...`
    );
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

    const afterInsertLoc = await getLocator(page, action, true);
    let insertSucceeded = false;
    if (afterInsertLoc) {
      if (await afterInsertLoc.isVisible().catch(() => false)) {
        insertSucceeded = true;
      } else {
        try {
          await afterInsertLoc.waitFor({ state: "visible", timeout: 3500 });
          insertSucceeded = true;
        } catch {}
      }
    }

    if (insertSucceeded && afterInsertLoc) {
      // Only permanently inject prerequisite steps into browse-plan.json for AI-generated plans (never corrupt user Eyedropper action lists!)
      if (!isEyedropperPlan) {
        totalHealedCount++;
        (action as any)._insertBefore = [
          ...((action as any)._insertBefore || []),
          ...healResult.prerequisiteActions,
        ];
        saveHealedPlan(dataDir, plan);
      }
      return afterInsertLoc;
    }

    // Re-run self-heal once on the newly opened screen if selector still needs refinement (PATCH_SELECTOR only — never a recursive INSERT_BEFORE!)
    console.log(`  [🤖 선행 단계 실행 완료 후 본 단계 타겟 재탐색] 새로 열린 화면에서 '${action.description}' 요소를 확정합니다...`);
    const retryHeal = await selfHealElement(page, action, momentId, plan.actions.length, dataDir, plan);
    if (retryHeal && retryHeal.resolutionType !== "INSERT_BEFORE") {
      healResult = retryHeal;
    } else {
      // Roll back speculative selector mutations if INSERT_BEFORE failed to reveal the target element
      action.selector = prevSelector;
      action.sourceSelector = prevSourceSelector;
      action.targetSelector = prevTargetSelector;
      action.iframe = prevIframe;
      healResult = null;
    }
  }

  // 4. Handle REPLACE_STEPS (Current coarse step decomposed into multiple steps — AI plans only)
  if (
    !isEyedropperPlan &&
    healResult?.success &&
    healResult.resolutionType === "REPLACE_STEPS" &&
    Array.isArray(healResult.replacementActions) &&
    healResult.replacementActions.length > 0
  ) {
    console.log(
      `  [🔄 AI 시나리오 동적 조정 (REPLACE_STEPS)] 현재 단계를 ${healResult.replacementActions.length}개의 세부 단계로 분할 교체합니다!`
    );

    const reps = healResult.replacementActions;
    const lastRep = reps[reps.length - 1];
    const leadingReps = reps.slice(0, reps.length - 1);

    if (leadingReps.length > 0) {
      await executeInjectedActionsOnPage(page, leadingReps, moments, startTime, plan);
    }

    const prevSel = action.selector;
    const prevDesc = action.description;
    const prevText = action.text;
    const prevIframe = action.iframe;

    if (lastRep && lastRep.selector) {
      action.selector = lastRep.selector;
      if (lastRep.description) action.description = lastRep.description;
      if (lastRep.text) action.text = lastRep.text;
      if (lastRep.iframe) action.iframe = lastRep.iframe;
    }

    const repLoc = await getLocator(page, action, true);
    if (repLoc && (await repLoc.isVisible().catch(() => false))) {
      totalHealedCount++;
      (action as any)._replaceWith = healResult.replacementActions;
      saveHealedPlan(dataDir, plan);
      return repLoc;
    } else {
      action.selector = prevSel;
      action.description = prevDesc;
      action.text = prevText;
      action.iframe = prevIframe;
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
    const candidateAction: BrowsePlanAction = {
      ...action,
      selector: healResult.selector || action.selector,
      sourceSelector: healResult.sourceSelector || action.sourceSelector,
      targetSelector: healResult.targetSelector || action.targetSelector,
      iframe: healResult.iframe || action.iframe,
    };

    // Verify that the healed selector actually resolves to a visible element BEFORE overwriting browse-plan.json!
    const healedLoc = await getLocator(page, candidateAction, true);
    let isHealedVisible = false;
    if (healedLoc) {
      isHealedVisible = await healedLoc.isVisible().catch(() => false);
      if (!isHealedVisible) {
        try {
          await healedLoc.waitFor({ state: "visible", timeout: 3500 });
          isHealedVisible = true;
        } catch {}
      }
    }

    if (isHealedVisible && healedLoc) {
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

      // Persist permanently back to browse-plan.json ONLY after visibility verification succeeded
      saveHealedPlan(dataDir, plan);
      return healedLoc;
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

async function autoRecoverActiveModals(_page: Page, _action: BrowsePlanAction, _moments: any[], _startTime: number): Promise<boolean> {
  return false;
}

async function scrapeLiveText(_page: Page, _action: BrowsePlanAction): Promise<string | null> {
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
  const firstNonWaitAction = plan.actions.find((a) => a.type !== "wait");
  const startsWithExplicitLogin = Boolean(
    firstNonWaitAction &&
      /#userId|name=['"]userId['"]|#password|type=['"]password['"]|#btnLogin|btn_login/i.test(
        `${firstNonWaitAction.selector || ""} ${firstNonWaitAction.targetHtml || ""} ${firstNonWaitAction.description || ""}`
      )
  );
  const requiresLogin = (plan.requiresLogin !== false && !startsWithExplicitLogin) || forceLogin;

  const isHeadless = process.argv.includes("--headless");
  const isHeaded = !isHeadless;

  // Auto-reuse existing auth session if available and not forced (skip if scenario explicitly starts by demonstrating login)
  if (!startsWithExplicitLogin && !fs.existsSync(authPath) && !forceLogin) {
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
  if (!startsWithExplicitLogin && !forceLogin && fs.existsSync(authPath)) {
    isSessionActive = await isSessionValid(plan.url, authPath, plan.viewport);
  } else if (startsWithExplicitLogin) {
    console.log("\n=======================================================");
    console.log("🔐 [로그인 시연 포함 감지] 시나리오 시작 부분에 로그인 동작이 포함되어 있습니다.");
    console.log("👉 로그인 화면부터 그대로 녹화하기 위해 사전 로그인 세션을 주입하지 않고 시작합니다.");
    console.log("=======================================================\n");
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

  // 2. Main Recording Context (1:1 Window Position & Viewport Synchronization)
  const rawVw = plan.viewport?.width || 1920;
  const rawVh = plan.viewport?.height || 1080;
  const effectiveViewport = {
    width: Math.max(800, Math.round(rawVw / 2) * 2),
    height: Math.max(600, Math.round(rawVh / 2) * 2),
  };
  plan.viewport = effectiveViewport;
  const wb = plan.windowBounds;

  let browser: Browser;
  if (isHeaded) {
    console.log("👁️ [--headed 모드] 브라우저 화면을 직접 표시하며 녹화합니다.");
    const posArg =
      wb && Number.isFinite(wb.left) && Number.isFinite(wb.top)
        ? `--window-position=${Math.round(wb.left)},${Math.round(wb.top)}`
        : "--window-position=50,50";
    const sizeOrMaxArgs =
      wb && wb.windowState !== "maximized" && wb.width >= 600 && wb.height >= 400
        ? [`--window-size=${Math.round(wb.width)},${Math.round(wb.height)}`]
        : ["--start-maximized"];
    try {
      // 1. Try launching system installed Google Chrome (best foreground visibility and taskbar focus on Windows)
      browser = await chromium.launch({
        headless: false,
        channel: "chrome",
        args: [
          ...sizeOrMaxArgs,
          "--new-window",
          posArg,
          "--disable-blink-features=AutomationControlled",
        ],
      });
      console.log("🌐 시스템 구글 크롬(Chrome)으로 녹화 화면 창을 띄웠습니다.");
    } catch {
      // 2. Fallback to bundled Chromium
      browser = await chromium.launch({
        headless: false,
        args: [
          ...sizeOrMaxArgs,
          "--new-window",
          posArg,
        ],
      });
      console.log("🌐 Playwright Chromium으로 녹화 화면 창을 띄웠습니다.");
    }
  } else {
    browser = await chromium.launch({
      headless: true,
      args: [`--window-size=${effectiveViewport.width},${effectiveViewport.height}`],
    });
  }
  const contextOptions: Parameters<typeof browser.newContext>[0] = {
    viewport: effectiveViewport,
    recordVideo: {
      dir: videoDir,
      size: effectiveViewport,
    },
  };

  if (!startsWithExplicitLogin && fs.existsSync(authPath)) {
    contextOptions.storageState = authPath;
    console.log(`저장된 로그인 세션을 불러옵니다: ${authPath}`);
  }

  const context: BrowserContext = await browser.newContext(contextOptions);
  await context.addInitScript("window.__name = (fn) => fn;");

  // --- 🪟 Layer 1: Background Notification Popup Filter (Preserving Native Multi-Window Popups) ---
  // Real popups (window.open & target="_blank") open as actual child Page instances in pageStack
  // so the parent window's live SPA/DOM state and window.opener reference are never destroyed by URL reloads!
  await context.addInitScript(() => {
    try {
      const origOpen = window.open;
      window.open = function (url, target, features) {
        if (/homGwPushPopup|PushPopup|notiPopup|alarmPopup/i.test(`${url || ""} ${target || ""}`)) {
          return null as any;
        }
        return origOpen ? origOpen.apply(window, arguments as any) : null;
      };
    } catch { }
  });

  let page: Page = await context.newPage();
  if (isHeaded && wb && wb.width >= 600 && wb.height >= 400) {
    try {
      const cdp = await context.newCDPSession(page);
      const winInfo: any = await cdp.send("Browser.getWindowForTarget");
      if (winInfo && typeof winInfo.windowId === "number") {
        if (wb.windowState === "maximized") {
          await cdp.send("Browser.setWindowBounds", {
            windowId: winInfo.windowId,
            bounds: { windowState: "maximized" },
          });
        } else {
          await cdp.send("Browser.setWindowBounds", {
            windowId: winInfo.windowId,
            bounds: {
              left: Math.round(wb.left),
              top: Math.round(wb.top),
              width: Math.round(wb.width),
              height: Math.round(wb.height),
              windowState: "normal",
            },
          });
        }
      }
      await cdp.detach().catch(() => {});
    } catch {}
  }
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
      // 1. If targetPage was already closed (e.g. via native window.close()), pop closed pages from pageStack and switch back to the untouched parent page
      if (targetPage.isClosed()) {
        while (pageStack.length > 1 && pageStack[pageStack.length - 1].isClosed()) {
          pageStack.pop();
        }
        page = pageStack[pageStack.length - 1] || context.pages().find((p) => !p.isClosed()) || page;
        await page.bringToFront().catch(() => {});
        return true;
      }

      // 2. If a real child popup window (pageStack.length > 1) is still open, check if targetAction belongs to a parent window in pageStack
      // (Never call page.goto(openerUrl) — switching back to candidateParent preserves its exact SPA DOM state without resetting to Groupware main!)
      if (pageStack.length > 1 && targetAction && targetAction.selector) {
        for (let pIdx = pageStack.length - 2; pIdx >= 0; pIdx--) {
          const candidateParent = pageStack[pIdx];
          if (!candidateParent || candidateParent.isClosed()) continue;
          const parentEl =
            (await getLocator(candidateParent, targetAction, false, false, true)) ||
            (await getLocator(candidateParent, targetAction, false, true, false));
          if (parentEl && (await parentEl.isVisible().catch(() => false))) {
            console.log(`  [🪟 팝업 자동 닫기 및 부모 창 복귀] ${reason} -> 자식 팝업 창을 닫고 상태가 보존된 부모 브라우저 창으로 복귀합니다.`);
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
  runtimeEntityIdMap.clear();
  runtimeCreatedTitles.clear();

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
          // (Clear targetHtml when locating sourceSelector because dragAndDrop's targetHtml describes the DROP container!)
          let srcLoc = await getLocatorWithWait(page, { ...action, selector: srcSelector, targetHtml: undefined }, false);
          if (!(srcLoc && (await srcLoc.isVisible().catch(() => false)))) {
            const restored = await restoreFromSimulatedPopupIfNeeded(
              page,
              `'${action.description || srcSelector}' 드래그 대상 탐색을 위해 팝업 종료`,
              { ...action, selector: srcSelector, targetHtml: undefined }
            );
            if (restored) {
              srcLoc = await getLocatorWithWait(page, { ...action, selector: srcSelector, targetHtml: undefined }, false);
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

          if (!srcLoc && !action.dragFromCoords) {
            const tempSrcAct: BrowsePlanAction = { ...action, selector: srcSelector, targetHtml: undefined };
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
          if (!srcLoc && !action.dragFromCoords) {
            throw new Error(`[드래그 앤 드롭 실패] 시작 요소를 찾을 수 없습니다: ${srcSelector}`);
          }

          // 2. Locate target element
          await page
            .evaluate(() => {
              document.querySelectorAll("ul.mg_ul, .ui-sortable, .group_lst ul").forEach((ul) => {
                const htmlUl = ul as HTMLElement;
                const r = htmlUl.getBoundingClientRect();
                if (r.width > 20 && r.height < 40) {
                  htmlUl.style.minHeight = "120px";
                }
              });
            })
            .catch(() => {});

          let tgtLoc: Locator | null = null;
          if (action.targetSelector || tgtSelector) {
            tgtLoc = await getLocatorWithWait(
              page,
              {
                ...action,
                selector: action.targetSelector || tgtSelector,
                description: "드래그 도착지 영역",
                recordedByEyedropper: true,
              },
              false
            );
          }

          if (!tgtLoc && !action.dragToCoords) {
            const tempTgtAct: BrowsePlanAction = { ...action, selector: action.targetSelector || tgtSelector };
            tgtLoc = await trySelfHealAction(moments, recordingStart, page, tempTgtAct, momentId, plan, dataDir);
            if (tgtLoc) {
              action.targetSelector = tempTgtAct.targetSelector || tempTgtAct.selector || tgtSelector;
              saveHealedPlan(dataDir, plan);
            }
          }
          if (!tgtLoc && !action.dragToCoords) {
            throw new Error(`[드래그 앤 드롭 실패] 도착 요소를 찾을 수 없습니다: ${tgtSelector}`);
          }

          if (srcLoc) {
            await srcLoc.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
          }
          if (tgtLoc) {
            await tgtLoc.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
          }

          const srcBox = srcLoc ? await getSettledBoundingBox(srcLoc) : null;
          const tgtBox = tgtLoc ? await getSettledBoundingBox(tgtLoc) : null;

          if ((!srcBox && !action.dragFromCoords) || (!tgtBox && !action.dragToCoords)) {
            throw new Error(`[드래그 앤 드롭 실패] 시작/도착 요소의 BoundingBox 좌표를 측정할 수 없습니다.`);
          }

          const fromX = action.dragFromCoords?.x ?? Math.round(srcBox!.x + srcBox!.width / 2);
          const fromY = action.dragFromCoords?.y ?? Math.round(srcBox!.y + srcBox!.height / 2);
          const toX = action.dragToCoords?.x ?? Math.round(tgtBox!.x + tgtBox!.width / 2);
          const toY = action.dragToCoords?.y ?? Math.round(tgtBox!.y + tgtBox!.height / 2);

          moment.timestamp = Date.now() - recordingStart;
          moment.cursor = { x: fromX, y: fromY };
          moment.dragFrom = { x: fromX, y: fromY };
          moment.dragTo = { x: toX, y: toY };
          moment.target = srcBox
            ? {
                x: Math.round(srcBox.x),
                y: Math.round(srcBox.y),
                width: Math.round(srcBox.width),
                height: Math.round(srcBox.height),
              }
            : {
                x: Math.max(0, fromX - 20),
                y: Math.max(0, fromY - 12),
                width: 40,
                height: 24,
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

          // Universal jQuery UI Sortable / Kanban Column Drop Sync:
          try {
            const srcHandle = srcLoc ? await srcLoc.elementHandle({ timeout: 500 }).catch(() => null) : null;
            const tgtHandle = tgtLoc ? await tgtLoc.elementHandle({ timeout: 500 }).catch(() => null) : null;
            if (srcHandle && tgtHandle) {
              await page
                .evaluate(
                  ([sNode, tNode]) => {
                    const srcEl = (sNode as HTMLElement)?.closest?.("li._task, li") as HTMLElement | null;
                    const tgtUl = (
                      (tNode as HTMLElement)?.matches?.("ul.mg_ul, ul.ui-sortable, .ui-sortable")
                        ? tNode
                        : (tNode as HTMLElement)?.querySelector?.("ul.mg_ul, ul.ui-sortable, .ui-sortable") ||
                          (tNode as HTMLElement)?.closest?.("ul.mg_ul, ul.ui-sortable, .ui-sortable")
                    ) as HTMLElement | null;
                    if (!srcEl || !tgtUl || tgtUl.contains(srcEl)) return;
                    const senderUl = srcEl.parentElement as HTMLElement | null;
                    tgtUl.appendChild(srcEl);
                    const w = window as any;
                    const $ = w.jQuery || w.$;
                    if ($ && typeof $(tgtUl).sortable === "function") {
                      try {
                        const inst = $(tgtUl).data("ui-sortable") || $(tgtUl).data("sortable");
                        const uiPayload = {
                          item: $(srcEl),
                          sender: senderUl ? $(senderUl) : null,
                          placeholder: $(),
                          helper: $(srcEl),
                        };
                        if (inst && typeof inst._trigger === "function") {
                          inst._trigger("receive", null, uiPayload);
                          inst._trigger("update", null, uiPayload);
                          inst._trigger("stop", null, uiPayload);
                        } else {
                          $(tgtUl).trigger("sortreceive", [uiPayload]);
                          $(tgtUl).trigger("sortupdate", [uiPayload]);
                          $(tgtUl).trigger("sortstop", [uiPayload]);
                        }
                      } catch {}
                    }
                  },
                  [srcHandle, tgtHandle]
                )
                .catch(() => {});
            }
          } catch {}

          await page.waitForTimeout(Math.max(300, (action.ms ?? 1000) - 500));
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

        case "rightclick": {
          await autoRecoverActiveModals(page, action, moments, recordingStart);
          const isOptionalOrSub = isOptionalAction(action, momentId, plan.actions.length) || isNonCriticalSubOption(action);
          let el = await getLocatorWithWait(page, action, isOptionalOrSub);
          if (!(el && (await el.isVisible().catch(() => false)))) {
            const restored = await restoreFromSimulatedPopupIfNeeded(
              page,
              `'${action.description || action.selector}' 우클릭 대상 탐색을 위해 팝업 종료`,
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

          await el.evaluate((node) => {
            const r = node.getBoundingClientRect();
            if (r.top < 60 || r.bottom > window.innerHeight - 60) {
              node.scrollIntoView({ block: "center", inline: "nearest" });
            }
          }).catch(() => {});
          await el.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
          const { locator: targetEl, box } = await resolveAtomicTarget(
            el,
            false,
            action.description || "",
            Boolean(action.recordedByEyedropper || plan.recordedByEyedropper)
          );
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
            await page.mouse.move(moment.cursor.x, moment.cursor.y, { steps: 10 }).catch(() => {});
          }
          moment.timestamp = Date.now() - recordingStart;

          if (moment.cursor) {
            triggerClickVisualizer(page, moment.cursor.x, moment.cursor.y).catch(() => {});
          }

          await el.click({ button: "right", timeout: 10000, force: action.force ?? false });
          await page.waitForTimeout(1000);
          break;
        }

        case "click": {
          await autoRecoverActiveModals(page, action, moments, recordingStart);
          const descLower = (action.description || "").toLowerCase();
          const selLower = (action.selector || "").toLowerCase();
          const isOptionalOrSub = isOptionalAction(action, momentId, plan.actions.length) || isNonCriticalSubOption(action);

          // 1:1 Mouse Pre-Positioning: Move cursor to the exact recorded click coordinates first
          // so any CSS :hover / mouseenter-revealed controls at that point naturally appear before locator lookup
          if (action.clickCoords && (action.clickCoords.x > 0 || action.clickCoords.y > 0)) {
            await page.mouse.move(action.clickCoords.x, action.clickCoords.y).catch(() => {});
            await page.waitForTimeout(150);
          }

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
          const isElVisible = async () => Boolean(el && (await el.isVisible().catch(() => false)));

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

          if (!el) {
            el = await trySelfHealAction(moments, recordingStart, page, action, momentId, plan, dataDir);
          }
          if (!el) {
            if ((action.recordedByEyedropper || plan.recordedByEyedropper) && action.clickCoords && (action.clickCoords.x > 0 || action.clickCoords.y > 0)) {
              const cx = Math.round(action.clickCoords.x);
              const cy = Math.round(action.clickCoords.y);
              console.log(`  [🎯 시연 좌표 1:1 직접 클릭] 셀렉터 미탐색으로 시연 당시 실제 클릭 좌표(${cx}, ${cy})를 직접 클릭합니다.`);
              moment.timestamp = Date.now() - recordingStart;
              moment.cursor = { x: cx, y: cy };
              moment.target = { x: Math.max(0, cx - 24), y: Math.max(0, cy - 16), width: 48, height: 32 };
              triggerClickVisualizer(page, cx, cy).catch(() => {});
              await page.mouse.click(cx, cy).catch(() => {});
              break;
            }
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

            if (!resolvedViaLabel) {
              const healed = await trySelfHealAction(moments, recordingStart, page, action, momentId, plan, dataDir);
              if (healed) {
                el = healed;
                resolvedViaLabel = true;
              }
            }

            if (!resolvedViaLabel) {
              if ((action.recordedByEyedropper || plan.recordedByEyedropper) && action.clickCoords && (action.clickCoords.x > 0 || action.clickCoords.y > 0)) {
                const cx = Math.round(action.clickCoords.x);
                const cy = Math.round(action.clickCoords.y);
                console.log(`  [🎯 시연 좌표 1:1 직접 클릭] 비가시 상태로 시연 당시 실제 클릭 좌표(${cx}, ${cy})를 직접 클릭합니다.`);
                moment.timestamp = Date.now() - recordingStart;
                moment.cursor = { x: cx, y: cy };
                moment.target = { x: Math.max(0, cx - 24), y: Math.max(0, cy - 16), width: 48, height: 32 };
                triggerClickVisualizer(page, cx, cy).catch(() => {});
                await page.mouse.click(cx, cy).catch(() => {});
                break;
              }
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

          let clickPositionOffset: { x: number; y: number } | undefined = undefined;
          if (box) {
            let rawX = box.x + box.width / 2;
            let rawY = box.y + box.height / 2;
            if (isEyedropperClick && action.cursorOffset) {
              const relX = Math.max(2, Math.min(Math.round(box.width - 2), action.cursorOffset.x));
              const relY = Math.max(2, Math.min(Math.round(box.height - 2), action.cursorOffset.y));
              rawX = box.x + relX;
              rawY = box.y + relY;
              if (box.width > 90 || box.height > 48) {
                clickPositionOffset = { x: relX, y: relY };
              }
            } else if (action.cursorOffset) {
              rawX = box.x + box.width / 2 + action.cursorOffset.x;
              rawY = box.y + box.height / 2 + action.cursorOffset.y;
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

          // 1. DOM 상태(disabled) 미리 평가하여 불필요한 딜레이 방지
          const isDisabled = await isElementDisabled(el);

          // 2. 정확한 타임스탬프 기록 (클릭 직전)
          moment.timestamp = Date.now() - recordingStart;

          // 3. 시각적 클릭 마커를 렌더링하도록 백그라운드로 던짐 (await 제거로 딜레이 원천 차단)
          if (moment.cursor) {
            triggerClickVisualizer(page, moment.cursor.x, moment.cursor.y).catch(() => {});
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
                  await el.click({
                    timeout: 3000,
                    force: true,
                    ...(clickPositionOffset ? { position: clickPositionOffset } : {}),
                  }).catch(() => { });
                } else {
                  await el.click({
                    timeout: clickTimeout,
                    force: action.force ?? false,
                    ...(clickPositionOffset ? { position: clickPositionOffset } : {}),
                  });
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

          // Ensure custom radio button labels reliably check their child input[type='radio'] and update .rdobtn_on
          if (
            selLower.includes("rdobtn") ||
            selLower.includes("type='radio'") ||
            (action.targetHtml && (action.targetHtml.includes("rdobtn") || action.targetHtml.includes('type="radio"')))
          ) {
            try {
              await el.evaluate(
                (node) => {
                  const label =
                    node.tagName.toLowerCase() === "label"
                      ? (node as HTMLLabelElement)
                      : (node.closest("label.rdobtn, label[for]") as HTMLLabelElement | null);
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

          // If a DynaTree folder title was clicked and the next step targets another tree node (not an explicit expander click),
          // expand its .dynatree-expander if it remained collapsed so child nodes become visible
          if (selLower.includes("dynatree-title")) {
            let nextNonWaitTree: BrowsePlanAction | null = null;
            for (let k = actionIdx + 1; k < plan.actions.length; k++) {
              if (plan.actions[k].type !== "wait") {
                nextNonWaitTree = plan.actions[k];
                break;
              }
            }
            const nextTreeSel = (nextNonWaitTree?.selector || "").toLowerCase();
            const isNextAnotherTreeNode =
              (nextTreeSel.includes("dynatree-") || nextTreeSel.includes("fancytree-")) &&
              !nextTreeSel.includes("dynatree-expander") &&
              !nextTreeSel.includes("fancytree-expander");
            if (isNextAnotherTreeNode) {
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
          }

          // If this click happened inside a child popup window (pageStack.length > 1) and there are subsequent steps targeting the parent window
          const isFinalSaveOrSendAction =
            descLower.includes("저장") ||
            descLower.includes("보내기") ||
            descLower.includes("발송") ||
            selLower.includes("savebtn") ||
            selLower.includes("_save") ||
            selLower.includes("sendbutton");
          if (isFinalSaveOrSendAction && actionIdx < plan.actions.length - 1 && pageStack.length > 1) {
            await page.waitForTimeout(1000);
            if (!page.isClosed()) {
              const nextNonWaitAct = plan.actions.slice(actionIdx + 1).find((a) => a.type !== "wait");
              const nextElInPopup = nextNonWaitAct?.selector ? await getLocator(page, { ...nextNonWaitAct }) : null;
              const isNextVisibleInPopup = Boolean(nextElInPopup && (await nextElInPopup.isVisible().catch(() => false)));
              if (!isNextVisibleInPopup) {
                await restoreFromSimulatedPopupIfNeeded(page, "팝업 발송/저장 완료 후 부모 창 후속 시나리오 진행", nextNonWaitAct);
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
            const healed = await trySelfHealAction(moments, recordingStart, page, action, momentId, plan, dataDir);
            if (healed) {
              el = healed;
            } else {
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
          const isEditorAction =
            desc.includes("내용") ||
            desc.includes("본문") ||
            desc.includes("에디터") ||
            desc.includes("content") ||
            sel.includes("cn") ||
            sel.includes("editor") ||
            sel.includes("se-contents");

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
          const isSingleLineContentEditable = await el
            .evaluate((node) => {
              const htmlEl = node as HTMLElement;
              const tag = (htmlEl.tagName || "").toLowerCase();
              if (tag === "input" || tag === "textarea" || tag === "select") return false;
              const isCe = Boolean(htmlEl.isContentEditable || htmlEl.getAttribute?.("contenteditable") === "true");
              if (!isCe || htmlEl.classList?.contains("se-contents") || htmlEl.classList?.contains("ProseMirror") || htmlEl.classList?.contains("bn-editor") || htmlEl.classList?.contains("note-editable")) {
                return false;
              }
              const hasPh = Boolean(htmlEl.getAttribute?.("placeholder") || htmlEl.getAttribute?.("data-placeholder"));
              if (hasPh) return true;
              const r = htmlEl.getBoundingClientRect();
              return Boolean(r && r.height > 0 && r.height <= 120);
            })
            .catch(() => false);
          const isInlineEnterCommitEditable = await el
            .evaluate((node) => {
              const htmlEl = node as HTMLElement;
              const tag = (htmlEl.tagName || "").toLowerCase();
              if (tag === "input" || tag === "textarea" || tag === "select") return false;
              const isCe = Boolean(htmlEl.isContentEditable || htmlEl.getAttribute?.("contenteditable") === "true");
              if (!isCe || htmlEl.classList?.contains("se-contents") || htmlEl.classList?.contains("ProseMirror") || htmlEl.classList?.contains("bn-editor") || htmlEl.classList?.contains("note-editable")) {
                return false;
              }
              if (htmlEl.id === "aglTaskReg_subject" || htmlEl.closest?.("#aglTaskReg, .ui-dialog")) return false;
              const cls = htmlEl.className || "";
              return (
                /\b(?:_chkNew|_chkItemName)\b/.test(cls) ||
                Boolean(htmlEl.closest?.("li.task_write, #aglTaskView_chkNew, .chk_write"))
              );
            })
            .catch(() => false);
          const isRichTextEditor =
            isSynapEditor ||
            (!isSingleLineContentEditable &&
              isEditorAction &&
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

          const text = (editorPlacement?.cleanedText ?? action.text ?? "").replace(/\s*↵\s*/g, "\n");

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
            // Check existing text in the input/textarea/contenteditable without waiting 500ms timeout on contenteditable divs
            let existingVal = "";
            try {
              existingVal = await el
                .evaluate((node) => {
                  const h = node as HTMLInputElement;
                  if (typeof h.value === "string") return h.value;
                  return ((node as HTMLElement).innerText || node.textContent || "").replace(/\u200B/g, "");
                })
                .catch(() => "");
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
                if (existingVal && existingVal.trim().length > 0) {
                  await el.selectText({ timeout: 500 }).catch(() => {});
                  await el.press("Backspace").catch(async () => {
                    await page.keyboard.press("Backspace").catch(() => {});
                  });
                  await el.fill("").catch(() => {});
                } else {
                  await el.press("Backspace").catch(async () => {
                    await page.keyboard.press("Backspace").catch(() => {});
                  });
                }
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
                const actualTyped = await el
                  .evaluate((node) => {
                    const h = node as HTMLInputElement;
                    if (typeof h.value === "string") return h.value;
                    return null;
                  })
                  .catch(() => null);
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
          }

          const hasExplicitEnter =
            Boolean(action.pressEnter) ||
            desc.includes("엔터") ||
            /\benter\b/i.test(desc);

          let nextIsExplicitInlineSaveBtn = false;
          if (isInlineEnterCommitEditable && !hasExplicitEnter) {
            for (let k = actionIdx + 1; k < plan.actions.length; k++) {
              if (plan.actions[k].type !== "wait") {
                const nAct = plan.actions[k];
                const nDesc = (nAct.description || "").toLowerCase();
                const nSel = (nAct.selector || "").toLowerCase();
                if (
                  nAct.type === "click" &&
                  (nDesc.includes("저장") ||
                    nDesc.includes("등록") ||
                    nSel.includes("save") ||
                    nSel.includes("confirm"))
                ) {
                  nextIsExplicitInlineSaveBtn = true;
                }
                break;
              }
            }
          }

          if ((hasExplicitEnter || (isInlineEnterCommitEditable && !nextIsExplicitInlineSaveBtn)) && !isRichTextEditor) {
            console.log(`  [⏎ 엔터(Enter) 키 실행] 사용자가 입력 후 Enter 키를 눌렀으므로 Enter 키를 실행합니다.`);
            await el.press("Enter").catch(async () => {
              await page.keyboard.press("Enter").catch(() => {});
            });
            await page.waitForTimeout(700);
          }

          moment.keys = text;
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

          // ── Virtual Windows 11 File Explorer ("열기") Dialog Simulation ──
          // Since OS native file dialogs are outside the browser DOM and invisible to Playwright video recording,
          // render an authentic in-DOM Windows "열기" dialog showing the pre-attached file(s),
          // visually click the file item, and click [열기(O)] before injecting setInputFiles().
          try {
            await page.waitForTimeout(350);

            const vfdFiles = resolvedFiles.map((fPath) => {
              const name = path.basename(fPath);
              const ext = path.extname(name).toLowerCase();
              let sizeBytes = 2048;
              let mtime = new Date();
              try {
                const st = fs.statSync(fPath);
                sizeBytes = st.size || 1024;
                mtime = st.mtime || new Date();
              } catch {}
              const sizeKb = `${Math.max(1, Math.round(sizeBytes / 1024))} KB`;
              const yyyy = mtime.getFullYear();
              const mm = String(mtime.getMonth() + 1).padStart(2, "0");
              const dd = String(mtime.getDate()).padStart(2, "0");
              const hr24 = mtime.getHours();
              const ampm = hr24 < 12 ? "오전" : "오후";
              const hr12 = hr24 % 12 || 12;
              const min = String(mtime.getMinutes()).padStart(2, "0");
              const dateStr = `${yyyy}-${mm}-${dd} ${ampm} ${hr12}:${min}`;

              let typeLabel = "문서 파일";
              let badgeColor = "#0067c0";
              let badgeText = "DOC";
              if (/\.(xlsx|xls|csv)$/i.test(ext)) {
                typeLabel = "Microsoft Excel 워크시트";
                badgeColor = "#107c41";
                badgeText = "XLS";
              } else if (/\.pdf$/i.test(ext)) {
                typeLabel = "PDF 문서";
                badgeColor = "#d93025";
                badgeText = "PDF";
              } else if (/\.(docx|doc)$/i.test(ext)) {
                typeLabel = "Microsoft Word 문서";
                badgeColor = "#185abd";
                badgeText = "DOC";
              } else if (/\.(hwp|hwpx)$/i.test(ext)) {
                typeLabel = "한컴오피스 한글 문서";
                badgeColor = "#0095d9";
                badgeText = "HWP";
              } else if (/\.(pptx|ppt)$/i.test(ext)) {
                typeLabel = "Microsoft PowerPoint 문서";
                badgeColor = "#c43e1c";
                badgeText = "PPT";
              } else if (/\.(png|jpg|jpeg|gif|webp)$/i.test(ext)) {
                typeLabel = "이미지 파일";
                badgeColor = "#7c3aed";
                badgeText = "IMG";
              } else if (/\.(zip|7z|rar)$/i.test(ext)) {
                typeLabel = "압축(ZIP) 폴더";
                badgeColor = "#d97706";
                badgeText = "ZIP";
              } else if (/\.txt$/i.test(ext)) {
                typeLabel = "텍스트 문서";
                badgeColor = "#475569";
                badgeText = "TXT";
              }

              return { name, sizeKb, dateStr, typeLabel, badgeColor, badgeText };
            });

            await page.evaluate((files) => {
              const existing = document.getElementById("__sd_virtual_file_dialog__");
              if (existing) existing.remove();

              const overlay = document.createElement("div");
              overlay.id = "__sd_virtual_file_dialog__";
              overlay.style.cssText = [
                "position:fixed",
                "inset:0",
                "z-index:2147483640",
                "background:rgba(0,0,0,0.18)",
                "display:flex",
                "align-items:center",
                "justify-content:center",
                "font-family:'Segoe UI','Malgun Gothic',sans-serif",
                "user-select:none",
              ].join(";");

              const rowsHtml = files
                .map(
                  (f, idx) => `
                  <tr id="__sd_vfd_file_${idx}" class="sd-vfd-row" style="cursor:pointer;border-bottom:1px solid #f2f2f2;transition:background 0.1s;">
                    <td style="padding:7px 10px;display:flex;align-items:center;gap:8px;color:#1a1a1a;font-weight:500;">
                      <span style="display:inline-flex;align-items:center;justify-content:center;width:24px;height:18px;border-radius:3px;background:${f.badgeColor};color:#fff;font-size:9px;font-weight:700;letter-spacing:0.02em;flex-shrink:0;">${f.badgeText}</span>
                      <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:205px;">${f.name}</span>
                    </td>
                    <td style="padding:7px 8px;color:#555;font-size:11.5px;white-space:nowrap;">${f.dateStr}</td>
                    <td style="padding:7px 8px;color:#555;font-size:11.5px;white-space:nowrap;max-width:130px;overflow:hidden;text-overflow:ellipsis;">${f.typeLabel}</td>
                    <td style="padding:7px 10px;color:#555;font-size:11.5px;text-align:right;white-space:nowrap;">${f.sizeKb}</td>
                  </tr>`
                )
                .join("");

              overlay.innerHTML = `
                <div style="width:680px;height:426px;background:#ffffff;border:1px solid #888;border-radius:8px;box-shadow:0 20px 50px rgba(0,0,0,0.35),0 0 1px rgba(0,0,0,0.4);display:flex;flex-direction:column;overflow:hidden;color:#1a1a1a;font-size:12px;">
                  <!-- Title Bar -->
                  <div style="height:32px;background:#f3f3f3;display:flex;align-items:center;justify-content:space-between;padding:0 12px;border-bottom:1px solid #e5e5e5;">
                    <div style="display:flex;align-items:center;gap:8px;font-size:12px;color:#1a1a1a;">
                      <span style="font-size:14px;">📁</span>
                      <span>열기</span>
                    </div>
                    <div style="color:#666;font-size:13px;padding:2px 6px;">✕</div>
                  </div>

                  <!-- Address & Search Bar -->
                  <div style="height:38px;background:#fafafa;display:flex;align-items:center;gap:8px;padding:0 10px;border-bottom:1px solid #e5e5e5;">
                    <div style="display:flex;gap:6px;color:#777;font-size:13px;padding:0 4px;">
                      <span>←</span><span>→</span><span>↑</span>
                    </div>
                    <div style="flex:1;height:26px;background:#fff;border:1px solid #d6d6d6;border-radius:4px;display:flex;align-items:center;padding:0 10px;gap:6px;color:#222;font-size:12px;">
                      <span>💻</span>
                      <span style="color:#888;">›</span>
                      <span>내 PC</span>
                      <span style="color:#888;">›</span>
                      <span>문서 (Documents)</span>
                      <span style="color:#888;">›</span>
                      <span style="font-weight:600;color:#005fb8;">첨부파일</span>
                    </div>
                    <div style="width:165px;height:26px;background:#fff;border:1px solid #d6d6d6;border-radius:4px;display:flex;align-items:center;padding:0 8px;color:#888;font-size:11.5px;">
                      🔍 첨부파일 검색
                    </div>
                  </div>

                  <!-- Main Explorer Body -->
                  <div style="flex:1;display:flex;min-height:0;background:#fff;">
                    <!-- Left Navigation Sidebar -->
                    <div style="width:154px;border-right:1px solid #e5e5e5;background:#fbfbfb;padding:8px 6px;display:flex;flex-direction:column;gap:2px;font-size:12px;color:#333;">
                      <div style="padding:5px 8px;border-radius:4px;display:flex;align-items:center;gap:8px;color:#555;">⭐ 즐겨찾기</div>
                      <div style="padding:5px 8px;border-radius:4px;display:flex;align-items:center;gap:8px;color:#555;">🖥️ 바탕 화면</div>
                      <div style="padding:5px 8px;border-radius:4px;display:flex;align-items:center;gap:8px;background:#e5f3ff;color:#005fb8;font-weight:600;border-left:3px solid #005fb8;">📄 문서</div>
                      <div style="padding:5px 8px 5px 22px;border-radius:4px;display:flex;align-items:center;gap:6px;background:#f0f7ff;color:#005fb8;font-weight:600;font-size:11.5px;">📂 첨부파일</div>
                      <div style="padding:5px 8px;border-radius:4px;display:flex;align-items:center;gap:8px;color:#555;">⬇️ 다운로드</div>
                      <div style="padding:5px 8px;border-radius:4px;display:flex;align-items:center;gap:8px;color:#555;">🖼️ 사진</div>
                    </div>

                    <!-- Right File List Table -->
                    <div style="flex:1;display:flex;flex-direction:column;min-width:0;padding:4px 8px;">
                      <table style="width:100%;border-collapse:collapse;table-layout:fixed;">
                        <thead>
                          <tr style="border-bottom:1px solid #e0e0e0;color:#555;font-size:11.5px;text-align:left;">
                            <th style="padding:6px 10px;font-weight:500;width:44%;border-right:1px solid #eee;">이름</th>
                            <th style="padding:6px 8px;font-weight:500;width:25%;border-right:1px solid #eee;">수정한 날짜</th>
                            <th style="padding:6px 8px;font-weight:500;width:19%;border-right:1px solid #eee;">유형</th>
                            <th style="padding:6px 10px;font-weight:500;width:12%;text-align:right;">크기</th>
                          </tr>
                        </thead>
                        <tbody>
                          ${rowsHtml}
                        </tbody>
                      </table>
                      <div style="margin-top:auto;padding:6px 10px;font-size:11px;color:#777;border-top:1px solid #f3f3f3;">
                        항목 ${files.length}개
                      </div>
                    </div>
                  </div>

                  <!-- Bottom Dialog Bar -->
                  <div style="background:#f3f3f3;border-top:1px solid #dcdcdc;padding:10px 14px;display:flex;flex-direction:column;gap:8px;">
                    <div style="display:flex;align-items:center;gap:8px;">
                      <span style="width:76px;text-align:right;color:#222;font-size:12px;">파일 이름(N):</span>
                      <input id="__sd_vfd_filename_input" type="text" readonly value="" style="flex:1;height:25px;background:#fff;border:1px solid #ababab;border-radius:3px;padding:0 8px;font-size:12px;color:#111;outline:none;" />
                      <div style="width:148px;height:25px;background:#fff;border:1px solid #ababab;border-radius:3px;display:flex;align-items:center;justify-content:space-between;padding:0 8px;font-size:11.5px;color:#222;">
                        <span>모든 파일 (*.*)</span>
                        <span style="font-size:10px;color:#666;">▾</span>
                      </div>
                    </div>
                    <div style="display:flex;justify-content:flex-end;gap:8px;">
                      <button id="__sd_vfd_btn_open" type="button" style="min-width:86px;height:26px;background:#e1e1e1;border:2px solid #0078d4;border-radius:4px;font-size:12px;font-weight:600;color:#111;cursor:pointer;">열기(O)</button>
                      <button id="__sd_vfd_btn_cancel" type="button" style="min-width:86px;height:26px;background:#e1e1e1;border:1px solid #adadad;border-radius:4px;font-size:12px;color:#222;cursor:pointer;">취소</button>
                    </div>
                  </div>
                </div>
              `;
              document.body.appendChild(overlay);
            }, vfdFiles);

            await page.waitForTimeout(550);

            // Step A: Move cursor to the file item in the virtual dialog & click it
            const firstFileRow = page.locator("#__sd_vfd_file_0").first();
            const fBox = await firstFileRow.boundingBox().catch(() => null);
            const joinedFileNames =
              vfdFiles.length === 1
                ? vfdFiles[0].name
                : vfdFiles.map((f) => `"${f.name}"`).join(" ");

            if (fBox && fBox.width > 0 && fBox.height > 0) {
              const fCx = Math.round(fBox.x + Math.min(140, fBox.width * 0.45));
              const fCy = Math.round(fBox.y + fBox.height / 2);
              await page.mouse.move(fCx, fCy, { steps: 14 }).catch(() => {});
              await page.evaluate((fileNameVal) => {
                const rows = document.querySelectorAll(".sd-vfd-row");
                rows.forEach((r) => {
                  (r as HTMLElement).style.background = "#cce8ff";
                  (r as HTMLElement).style.outline = "1px solid #0078d4";
                });
                const inp = document.getElementById("__sd_vfd_filename_input") as HTMLInputElement | null;
                if (inp) inp.value = fileNameVal;
                const openBtn = document.getElementById("__sd_vfd_btn_open") as HTMLElement | null;
                if (openBtn) {
                  openBtn.style.background = "#0067c0";
                  openBtn.style.borderColor = "#005fb8";
                  openBtn.style.color = "#ffffff";
                }
              }, joinedFileNames);
              const fileClickTs = Date.now() - recordingStart;
              triggerClickVisualizer(page, fCx, fCy).catch(() => {});
              extraSubMoments.push({
                id: 0,
                type: "click",
                timestamp: fileClickTs,
                cursor: { x: fCx, y: fCy },
                target: {
                  x: Math.round(fBox.x),
                  y: Math.round(fBox.y),
                  width: Math.round(fBox.width),
                  height: Math.round(fBox.height),
                },
                description: `[파일 선택 팝업] '${vfdFiles.map((f) => f.name).join(", ")}' 파일 선택`,
              });
            }

            await page.waitForTimeout(650);

            // Step B: Move cursor to [열기(O)] button & click it
            const openBtnLoc = page.locator("#__sd_vfd_btn_open").first();
            const oBox = await openBtnLoc.boundingBox().catch(() => null);
            if (oBox && oBox.width > 0 && oBox.height > 0) {
              const oCx = Math.round(oBox.x + oBox.width / 2);
              const oCy = Math.round(oBox.y + oBox.height / 2);
              await page.mouse.move(oCx, oCy, { steps: 12 }).catch(() => {});
              await page.evaluate(() => {
                const openBtn = document.getElementById("__sd_vfd_btn_open") as HTMLElement | null;
                if (openBtn) {
                  openBtn.style.background = "#004e8c";
                  openBtn.style.transform = "scale(0.98)";
                }
              });
              const openClickTs = Date.now() - recordingStart;
              triggerClickVisualizer(page, oCx, oCy).catch(() => {});
              extraSubMoments.push({
                id: 0,
                type: "click",
                timestamp: openClickTs,
                cursor: { x: oCx, y: oCy },
                target: {
                  x: Math.round(oBox.x),
                  y: Math.round(oBox.y),
                  width: Math.round(oBox.width),
                  height: Math.round(oBox.height),
                },
                description: `[파일 선택 팝업] '열기(O)' 버튼 클릭`,
              });
            }

            await page.waitForTimeout(300);

            // Close the virtual dialog right before injecting the actual file(s)
            await page.evaluate(() => {
              const existing = document.getElementById("__sd_virtual_file_dialog__");
              if (existing) existing.remove();
            });
          } catch (vfdErr) {
            await page
              .evaluate(() => {
                const existing = document.getElementById("__sd_virtual_file_dialog__");
                if (existing) existing.remove();
              })
              .catch(() => {});
          }

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

  // Capture site brand assets (logo, theme colors, hero screenshot) for the URL Master Brand Slide if not cached yet
  try {
    await captureSiteBrandFromLivePage(pageStack[0] || page, plan.url);
  } catch {}

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
  const isAutoCleanPass = process.argv.includes("--auto-clean-pass");

  if (totalHealedCount > 0 || hasPrunedActions) {
    console.log(`\n========================================================================`);
    console.log(`✨ [시나리오 자가 복구 반영 완료] 자가 복구 ${totalHealedCount}건, 불필요 액션 프루닝 ${toPrune.length}건을 플랜에 영구 저장했습니다.`);
    if (isAutoCleanPass && !isCleanPass) {
      console.log(`🎬 [2-Pass 클린 마스터 재녹화 가동] --auto-clean-pass 옵션에 따라 클린 패스를 재녹화합니다!`);
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
    } else {
      console.log(`⚡ [단일 패스 완료] 재녹화 없이 현재 녹화본으로 즉시 후가공을 진행합니다. (대기 구간은 대시보드 '✂️ 잘라내기'로 편집 가능)`);
      console.log(`========================================================================\n`);
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
  try {
    fs.copyFileSync(momentsPath, path.join(dataDir, "moments.body.json"));
    if (fs.existsSync(destPath)) {
      fs.copyFileSync(destPath, path.join(dataDir, "recording.body.mp4"));
    }
    // 새 녹화가 완료되면 과거 렌더링본(output/<slug>.mp4) 및 이전 컷 편집 백업을 정리하여 구버전 노출 방지
    const staleRenderedMp4 = path.resolve(__dirname, "..", "output", `${slug}.mp4`);
    if (fs.existsSync(staleRenderedMp4)) {
      try { fs.unlinkSync(staleRenderedMp4); } catch {}
    }
    for (const staleName of [
      "recording.orig.mp4",
      "recording.undo.mp4",
      "moments.orig.json",
      "moments.undo.json",
      "edit-plan.orig.json",
      "edit-plan.undo.json",
      "narration.orig.json",
      "narration.undo.json",
      "rendered.base.mp4",
      "rendered.base.json",
    ]) {
      const p = path.join(dataDir, staleName);
      if (fs.existsSync(p)) {
        try { fs.unlinkSync(p); } catch {}
      }
    }
  } catch {}
  console.log(`Moments saved: ${momentsPath} (${moments.length} actions)`);

// Auto-calibrate moments against video frames and generate edit plan
try {
  console.log("\nCalibrating moments & building edit plan...");
  execSync(`python scripts/calibrate-moments.py ${slug} --force`, { stdio: "inherit" });
  try {
    fs.copyFileSync(momentsPath, path.join(dataDir, "moments.body.json"));
  } catch {}
  if (!process.argv.includes("--skip-narration")) {
    console.log(
      "\n🎙️ [AI 자동 후가공] 사이트 맞춤형 마스터 슬라이드·목차(Contents)·내레이션 대본 생성 및 음성·영상 합성을 진행합니다..."
    );
    await generateNarrationScript(slug, { synthesizeAudio: true });
    console.log("✨ [AI 자동 후가공 완료] 오프닝 슬라이드 및 음성 합성이 녹화본(recording.mp4)에 반영되었습니다!");
  }
  console.log(`Scenario ready in data/${slug}/`);
  process.exit(0);
} catch (e) {
  console.warn("Could not complete post-recording pipeline:", e);
  process.exit(0);
}
}

main().catch((err) => {
  console.error("Recording failed:", err);
  process.exit(1);
});













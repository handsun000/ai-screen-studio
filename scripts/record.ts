import { chromium, type Browser, type Page, type BrowserContext, type Locator } from "playwright";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import { execSync } from "child_process";
import { getVideoMetadata } from "@remotion/renderer";
import type { BrowsePlan, BrowsePlanAction, Moment, MomentsFile } from "../src/types";
import { sanitizeBrowsePlan } from "../src/services/planSanitizer";

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
      const validPseudos = ["has-text", "visible", "first-child", "last-child", "nth-child", "not", "disabled", "checked", "focus", "hover"];
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
        const cleanSel = s.replace(/^\.ui-dialog:visible\s*/, "").replace(/^\.modal:visible\s*/, "").trim();
        const cand = topDialog.locator(cleanSel).first();
        if (await cand.isVisible().catch(() => false)) {
          console.log(`  [🎯 최상단 모달 요소 감지] 중첩 팝업 #${d + 1} 내부에서 '${cleanSel}' 요소를 우선 선택합니다.`);
          return cand;
        }
      }
    }

    for (const baseObj of candidateBases) {
      for (const s of dialogSelectors) {
        if (s.includes(".ui-dialog") || s.includes(".modal") || s.includes("layer")) {
          const directLoc = baseObj.locator(s).first();
          if (await directLoc.isVisible().catch(() => false)) {
            return directLoc;
          }
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
        for (const part of parts) {
          for (const prefix of scopePrefixes) {
            if (!part.includes(prefix)) {
              const scoped = baseObj.locator(`${prefix} ${part}`).first();
              if (await scoped.isVisible().catch(() => false)) {
                return scoped;
              }
            }
          }
        }
      }
    }

    // 3-B. Prioritize elements that are currently visible on screen across bases
    for (const baseObj of candidateBases) {
      for (const part of parts) {
        const loc = baseObj.locator(part);
        const count = await loc.count().catch(() => 0);
        for (let i = 0; i < count; i++) {
          const candidate = loc.nth(i);
          if (await candidate.isVisible().catch(() => false)) {
            return candidate;
          }
        }
      }
    }
  }

  // 4. Intelligent Self-Healing for Buttons / Interactive Elements
  // If selector is empty or failed to match, extract button/action names from description and try verified patterns
  if (desc) {
    const fallbackSelectors: string[] = [];

    // Extract text in brackets or quotes: [일정 등록], '저장', "확인"
    const quoteMatch = desc.match(/[\[\'\"\(](.*?)[\]\'\"\)]/);
    if (quoteMatch && quoteMatch[1] && quoteMatch[1].length >= 2) {
      const textKey = quoteMatch[1].trim();
      fallbackSelectors.push(
        `button#reg_shedule_lefttop:visible`,
        `#reg_shedule_lefttop:visible`,
        `button:has-text('${textKey}'):visible`,
        `button:has-text('${textKey.replace(/\s+/g, "")}'):visible`,
        `a:has-text('${textKey}'):visible`,
        `a:has-text('${textKey.replace(/\s+/g, "")}'):visible`,
        `:text-is('${textKey}'):visible`,
        `span.txt:has-text('${textKey}'):visible`,
        `.ui-dialog:visible button:has-text('${textKey}')`
      );
    }

    if (desc.includes("일정") && (desc.includes("등록") || desc.includes("작성"))) {
      fallbackSelectors.push(
        "button#reg_shedule_lefttop:visible",
        "#reg_shedule_lefttop:visible",
        "button:has-text('일정 등록'):visible",
        "button:has-text('일정등록'):visible",
        "a:has-text('일정 등록'):visible",
        "button:has-text('등록'):visible"
      );
    }

    if (desc.includes("저장")) {
      fallbackSelectors.push(".ui-dialog:visible #savebtn", ".ui-dialog:visible button:has-text('저장')", "#savebtn:visible", "button:has-text('저장'):visible");
    }

    if ((desc.includes("자원") || desc.includes("예약")) && desc.includes("확인")) {
      fallbackSelectors.unshift(
        "button#link_res_confirm:visible",
        "#link_res_confirm:visible",
        ".equ_select_lyr button#link_res_confirm:visible",
        ".equ_select_lyr .btn_pri:visible",
        ".equ_select_lyr button:has-text('확인'):visible"
      );
    }

    // 캘린더 내 등록된 일정 클릭 의도인 경우: FullCalendar 일정 요소만 핀포인트 (절대 상단 툴바 버튼 매칭 금지)
    if (desc.includes("캘린더") && desc.includes("일정") && (desc.includes("클릭") || desc.includes("확인") || desc.includes("상세"))) {
      fallbackSelectors.unshift(
        ".fc-view .fc-event:visible",
        ".fc-event-container .fc-event:visible",
        ".fc-title:visible",
        "a.fc-day-grid-event:visible",
        ".fc-time-grid-event:visible",
        ".fc-content:visible"
      );
    }

    // 팝업/모달의 단순 [확인] 버튼인 경우: 정확한 텍스트 '확인'만 매칭 (예: '사용자 일정확인' 등 엉뚱한 버튼 매칭 방지)
    if ((desc.includes("팝업") || desc.includes("안내") || desc.includes("모달") || desc.includes("완료")) && desc.includes("확인")) {
      fallbackSelectors.push(
        ".ui-dialog:visible button:text-is('확인')",
        ".ui-dialog:visible button:has-text('확인')",
        "button:text-is('확인'):visible",
        ".btn_area button:text-is('확인'):visible"
      );
    }

    if (desc.includes("상신") || desc.includes("기안")) {
      fallbackSelectors.push("button:has-text('상신'):visible", "button:has-text('기안'):visible");
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

  // 6. Final fallback to first locator on page
  return page.locator(action.selector || "body").first();
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
  locator: Locator
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
      const childCandidates = locator.locator(
        "button:visible, a:visible, input[type='button']:visible, input[type='submit']:visible, [role='button']:visible, input:visible, textarea:visible, select:visible, span.txt:visible, span.name:visible, strong:visible, i.ico:visible"
      );
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

    await checkPage.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
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
  const page: Page = await context.newPage();
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

  // Auto-accept alert/confirm dialogs (e.g. "일정이 등록되었습니다")
  page.on("dialog", async (dialog) => {
    console.log(`  [Alert/Confirm] ${dialog.type()}: ${dialog.message()}`);
    await dialog.accept();
  });

  const moments: Moment[] = [];
  let momentId = 0;

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
          await page.waitForTimeout(ms);
          break;
        }

        case "hover": {
          let el = await getLocator(page, action);
          if (!el) {
            if (action.optional) break;
            throw new Error(`요소를 찾을 수 없습니다: ${action.selector}`);
          }
          if (action.optional) {
            const isVis = await el.isVisible().catch(() => false);
            if (!isVis) {
              console.log(`  [Info] 선택적 단계(Optional) 건너뜀: ${action.description}`);
              break;
            }
          }
          await el.waitFor({ state: "visible", timeout: action.optional ? 2000 : 10000 }).catch(() => { });
          
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
          let el = await getLocator(page, action);
          if (!el) {
            if (action.optional) break;
            throw new Error(`요소를 찾을 수 없습니다: ${action.selector}`);
          }
          if (action.optional) {
            const isVis = await el.isVisible().catch(() => false);
            const isEnabled = await el.isEnabled().catch(() => false);
            if (!isVis || !isEnabled) {
              console.log(`  [Info] 건너뜀(Optional): ${action.description}`);
              break;
            }
          }
          await el.waitFor({ state: "visible", timeout: action.optional ? 2000 : 10000 }).catch(() => { });
          
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

          if (moment.cursor) {
            await triggerClickVisualizer(page, moment.cursor.x, moment.cursor.y);
          }

          try {
            await el.dblclick({ timeout: action.optional ? 3000 : 10000, force: action.force ?? false });
          } catch (dblErr) {
            if (action.optional) {
              console.log(`  [Info] 더블클릭 건너뜀(Optional): ${action.description}`);
              break;
            }
            throw dblErr;
          }
          await page.waitForTimeout(1000);
          break;
        }

        case "click": {
          let el = await getLocator(page, action);
          if (!el) {
            if (action.optional) {
              console.log(`  [Info] 요소를 찾을 수 없어 건너뜀(Optional): ${action.description}`);
              break;
            }
            throw new Error(`요소를 찾을 수 없습니다: ${action.selector}`);
          }

          // 1. Wait for element to become visible on the screen
          const waitTimeout = action.optional ? 4000 : 12000;
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

            if (!resolvedViaLabel) {
              if (action.optional) {
                console.log(`  [Info] 요소가 시간 내에 표시되지 않아 건너뜀(Optional): ${action.description}`);
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

          moment.timestamp = Date.now() - recordingStart;

          // Trigger visual click marker on the page so recorded video shows the exact point of contact
          if (moment.cursor) {
            await triggerClickVisualizer(page, moment.cursor.x, moment.cursor.y);
          }

          // 2. Robust Click Execution
          try {
            const isDisabled = await isElementDisabled(el);
            if (isDisabled) {
              if (action.optional) {
                console.log(`  [Info] 요소가 disabled 상태이므로 클릭 건너뜀(Optional): ${action.description}`);
                break;
              } else {
                await el.click({ timeout: 4000, force: true }).catch(() => { });
              }
            } else {
              await el.click({ timeout: action.optional ? 3000 : 10000, force: action.force ?? false });
            }
          } catch (clickErr: any) {
            if (action.optional) {
              console.log(`  [Info] 선택적 단계 클릭 예외 무시하고 계속(Optional): ${clickErr.message.split("\n")[0]}`);
              break;
            }
            // Non-optional fallback: try DOM dispatchEvent("click")
            try {
              await el.click({ timeout: 3000, force: true });
            } catch {
              await el.dispatchEvent("click").catch(() => {
                throw clickErr;
              });
            }
          }

          await page.waitForTimeout(1000);
          break;
        }

        case "type": {
          let el = await getLocator(page, action);
          if (!el) {
            if (action.optional) {
              console.log(`  [Info] 입력 요소를 찾을 수 없어 건너뜀(Optional): ${action.description}`);
              break;
            }
            throw new Error(`입력 요소를 찾을 수 없습니다: ${action.selector}`);
          }

          const waitTimeout = action.optional ? 4000 : 12000;
          try {
            await el.waitFor({ state: "visible", timeout: waitTimeout });
          } catch (waitErr) {
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
            } else {
              if (action.optional) {
                console.log(`  [Info] 입력 요소가 시간 내에 표시되지 않아 건너뜀(Optional): ${action.description}`);
                break;
              }
              throw new Error(`입력 요소를 찾을 수 없거나 화면에 표시되지 않습니다: ${action.selector}`);
            }
          }
          await el.scrollIntoViewIfNeeded().catch(() => { });
          const { locator: targetEl, box } = await resolveAtomicTarget(el);
          el = targetEl;

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

          if (moment.cursor) {
            await triggerClickVisualizer(page, moment.cursor.x, moment.cursor.y);
          }
          try {
            await el.click({ timeout: 3000, force: action.force ?? true }).catch(() => { });
          } catch { }
          await el.focus().catch(() => { });

          const text = action.text ?? "";
          try {
            await el.pressSequentially(text, { delay: 40 });
          } catch (typeErr) {
            await el.fill(text).catch(() => { });
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
      const candidates = fs.readdirSync(videoDir).filter((f) => f.startsWith("page@") && f.endsWith(".webm"));
      if (candidates.length > 0) {
        srcFile = path.join(videoDir, candidates[0]);
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

  // Write moments.json
  const totalDurationMs = Math.max(0, Date.now() - recordingStart);
  const momentsFile: MomentsFile = {
    metadata: {
      url: plan.url,
      viewportWidth: plan.viewport.width,
      viewportHeight: plan.viewport.height,
      totalDurationMs,
      recordingStart: new Date(recordingStart).toISOString(),
      cursor: { delayMs: 0, preClickRestMs: 120 },
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

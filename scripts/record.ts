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
  if (!action.selector) return null;

  // Clean corrupted quotes or excessive backslashes (e.g. \\\\\\\" -> ')
  let selector = action.selector
    .replace(/\\+"/g, "'")
    .replace(/\\+'/g, "'")
    .replace(/'{2,}/g, "'");

  // Fix common typo ui-dialog without dot
  if (selector.startsWith("ui-dialog")) {
    selector = "." + selector;
  }
  selector = selector.replace(/,\s*ui-dialog/g, ", .ui-dialog");
  action.selector = selector;

  const base = action.iframe ? page.frameLocator(action.iframe) : page;

  // 1. If an active modal dialog exists, prioritize elements inside visible dialogs
  const isDialogPresent =
    (await page
      .locator(".ui-dialog:visible, .modal:visible, .layer_wrap:visible, [role='dialog']:visible")
      .count()
      .catch(() => 0)) > 0;

  if (isDialogPresent) {
    const dialogSelectors = action.selector
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    for (const s of dialogSelectors) {
      if (s.includes(".ui-dialog") || s.includes(".modal") || s.includes("layer")) {
        const directLoc = base.locator(s).first();
        if (await directLoc.isVisible().catch(() => false)) {
          return directLoc;
        }
      } else {
        const scopedLoc = base.locator(`.ui-dialog:visible ${s}, .modal:visible ${s}, .layer_wrap:visible ${s}`).first();
        if (await scopedLoc.isVisible().catch(() => false)) {
          return scopedLoc;
        }
      }
    }
  }

  // 2. Prioritize elements that are currently visible on the screen
  const parts = action.selector
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  for (const part of parts) {
    const loc = base.locator(part);
    const count = await loc.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const candidate = loc.nth(i);
      if (await candidate.isVisible().catch(() => false)) {
        return candidate;
      }
    }
  }

  // 3. Fallback to standard first element
  return base.locator(action.selector).first();
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
  const recordingStart = Date.now();

  const page: Page = await context.newPage();
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
          const el = await getLocator(page, action);
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
          await el.scrollIntoViewIfNeeded().catch(() => { });
          const box = await el.boundingBox({ timeout: 2000 }).catch(() => null);
          if (box) {
            const clamped = clampToViewport(
              box.x + box.width / 2,
              box.y + box.height / 2,
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
          const el = await getLocator(page, action);
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
          await el.scrollIntoViewIfNeeded().catch(() => { });
          const box = await el.boundingBox({ timeout: 2000 }).catch(() => null);
          if (box) {
            const clamped = clampToViewport(
              box.x + box.width / 2,
              box.y + box.height / 2,
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
          const box = await el.boundingBox({ timeout: 2000 }).catch(() => null);

          if (box) {
            const clamped = clampToViewport(
              box.x + box.width / 2,
              box.y + box.height / 2,
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
          const box = await el.boundingBox({ timeout: 2000 }).catch(() => null);

          if (box) {
            const clamped = clampToViewport(
              box.x + box.width / 2,
              box.y + box.height / 2,
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
        const videoDurationMs = durationSec * 1000;
        const wallClockDurationMs = Date.now() - recordingStart;
        startOffsetMs = Math.max(0, wallClockDurationMs - videoDurationMs);
        const effectiveWallMs = Math.max(1, wallClockDurationMs - startOffsetMs);
        const driftRatio = videoDurationMs / effectiveWallMs;

        console.log(
          `[Sync] 비디오 길이: ${videoDurationMs.toFixed(0)}ms, 녹화 시간: ${wallClockDurationMs}ms, 시작 오프셋: -${startOffsetMs.toFixed(0)}ms, 보정 배율: ${driftRatio.toFixed(4)}`
        );

        // Adjust moments timestamps with 2-point linear time-warp calibration
        for (const moment of moments) {
          const shifted = Math.max(0, moment.timestamp - startOffsetMs);
          moment.timestamp = Math.min(
            Math.round(videoDurationMs),
            Math.round(shifted * driftRatio)
          );
        }
      }
    } catch (err) {
      console.warn("비디오 메타데이터 읽기 오류:", err);
      // Fallback: simple offset shift
      for (const moment of moments) {
        moment.timestamp = Math.max(0, Math.round(moment.timestamp - startOffsetMs));
      }
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
const momentsFile: MomentsFile = {
  metadata: {
    url: plan.url,
    viewportWidth: plan.viewport.width,
    viewportHeight: plan.viewport.height,
    totalDurationMs: Math.max(0, Date.now() - recordingStart - startOffsetMs),
    recordingStart: new Date(recordingStart + startOffsetMs).toISOString(),
    cursor: plan.cursor,
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

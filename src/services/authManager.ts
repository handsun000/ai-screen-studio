import { chromium, Browser } from "playwright";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";

export interface EnsureAuthOptions {
  url: string;
  slug?: string;
  viewport?: { width: number; height: number };
  onProgress?: (message: string) => void;
  forceLogin?: boolean;
}

export interface AuthSessionResult {
  success: boolean;
  authPath?: string;
  error?: string;
}

/**
 * Resolves the primary auth session file path for a given scenario slug or default data directory.
 */
export function getAuthFilePath(slug?: string): string {
  const rootDataDir = path.resolve(__dirname, "..", "..", "data");
  if (!fs.existsSync(rootDataDir)) {
    fs.mkdirSync(rootDataDir, { recursive: true });
  }

  if (slug) {
    const slugDir = path.join(rootDataDir, slug);
    if (!fs.existsSync(slugDir)) {
      fs.mkdirSync(slugDir, { recursive: true });
    }
    return path.join(slugDir, "auth.json");
  }

  return path.join(rootDataDir, "auth.json");
}

/**
 * Verifies if an auth.json file exists and actually contains post-login authenticated session data
 * (filters out initial unauthenticated 3-cookie stubs).
 */
export function isValidSessionFile(filePath: string): boolean {
  if (!fs.existsSync(filePath)) return false;
  try {
    const stat = fs.statSync(filePath);
    if (stat.size < 100) return false;
    const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    const cookies = raw.cookies || [];
    return cookies.length > 0;
  } catch {
    return false;
  }
}

/**
 * Scans data directories for any existing, non-empty and genuine auth.json file.
 * Prioritizes the requested slug, then root data/auth.json, then the most recently modified auth.json across all scenario folders.
 */
export function findExistingAuthSession(slug?: string): string | null {
  const rootDataDir = path.resolve(__dirname, "..", "..", "data");
  if (!fs.existsSync(rootDataDir)) return null;

  // 1. Check specified slug first
  if (slug) {
    const slugAuth = path.join(rootDataDir, slug, "auth.json");
    if (isValidSessionFile(slugAuth)) {
      return slugAuth;
    }
  }

  // 2. Check root data/auth.json
  const rootAuth = path.join(rootDataDir, "auth.json");
  if (isValidSessionFile(rootAuth)) {
    return rootAuth;
  }

  // 3. Scan all subdirectories in data/ and find the most recently modified valid auth.json
  try {
    const entries = fs.readdirSync(rootDataDir, { withFileTypes: true });
    let latestAuthPath: string | null = null;
    let latestMtime = 0;

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const candidate = path.join(rootDataDir, entry.name, "auth.json");
      if (isValidSessionFile(candidate)) {
        try {
          const stat = fs.statSync(candidate);
          if (stat.mtimeMs > latestMtime) {
            latestMtime = stat.mtimeMs;
            latestAuthPath = candidate;
          }
        } catch {}
      }
    }

    if (latestAuthPath) {
      return latestAuthPath;
    }
  } catch {}

  return null;
}

/**
 * Validates whether an existing auth storage session is currently valid for the target URL.
 * Checks for login redirects, visible password fields, or active portal elements.
 */
export async function isSessionValid(
  url: string,
  authPath: string,
  viewport: { width: number; height: number } = { width: 1920, height: 1080 }
): Promise<boolean> {
  if (!fs.existsSync(authPath) || fs.statSync(authPath).size < 100) {
    return false;
  }

  let checkBrowser: Browser | null = null;
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

    await checkPage.goto(targetTestUrl, { waitUntil: "domcontentloaded", timeout: 25000 });
    // Brief sleep to catch client-side URL redirects (e.g. location.href = '/login')
    await checkPage.waitForTimeout(2000);

    const currentUrl = checkPage.url().toLowerCase();

    // 1. Check for login URL patterns
    const isLoginUrl =
      currentUrl.includes("/login") ||
      currentUrl.includes("signin") ||
      currentUrl.includes("userlogin") ||
      currentUrl.includes("sso") ||
      currentUrl.includes("/auth");

    // 2. Check for visible password/user input forms
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
      return false;
    }

    if (hasGnbOrPortal || isMainPortalUrl) {
      return true;
    }

    return false;
  } catch {
    if (checkBrowser) {
      await checkBrowser.close().catch(() => {});
    }
    return false;
  }
}

/**
 * Synchronizes an auth.json session file to ALL scenario folders and root data.
 * Guarantees that any single login automatically activates all existing and future scenarios.
 */
export function syncAuthSession(sourceAuthPath: string): void {
  try {
    if (!fs.existsSync(sourceAuthPath) || fs.statSync(sourceAuthPath).size < 100) {
      return;
    }

    const parentDataDir = path.resolve(__dirname, "..", "..", "data");
    if (!fs.existsSync(parentDataDir)) {
      fs.mkdirSync(parentDataDir, { recursive: true });
    }

    // 1. Mirror to root data/auth.json
    const rootAuth = path.join(parentDataDir, "auth.json");
    if (path.resolve(sourceAuthPath) !== path.resolve(rootAuth)) {
      try {
        fs.copyFileSync(sourceAuthPath, rootAuth);
      } catch {}
    }

    // 2. Mirror to ALL subdirectories in data/
    const entries = fs.readdirSync(parentDataDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith(".")) {
        const dest = path.join(parentDataDir, entry.name, "auth.json");
        if (path.resolve(dest) !== path.resolve(sourceAuthPath)) {
          try {
            fs.copyFileSync(sourceAuthPath, dest);
          } catch {}
        }
      }
    }
  } catch (err: any) {
    console.warn(`[세션 동기화 경고] auth.json 동기화 중 오류: ${err.message}`);
  }
}

/**
 * Ensures a specific scenario directory has a copy of the active auth session.
 */
export function ensureSessionForSlug(slug: string): boolean {
  if (!slug) return false;
  const parentDataDir = path.resolve(__dirname, "..", "..", "data");
  const slugDir = path.join(parentDataDir, slug);
  const destAuth = path.join(slugDir, "auth.json");

  if (isValidSessionFile(destAuth)) {
    return true;
  }

  const existingAuth = findExistingAuthSession();
  if (existingAuth && fs.existsSync(existingAuth)) {
    try {
      if (!fs.existsSync(slugDir)) {
        fs.mkdirSync(slugDir, { recursive: true });
      }
      fs.copyFileSync(existingAuth, destAuth);
      return true;
    } catch {}
  }
  return false;
}

// Active login completion trigger listeners (invoked via Dashboard API or external signals)
const activeLoginResolvers = new Set<() => void>();

export function triggerLoginComplete(): boolean {
  if (activeLoginResolvers.size === 0) return false;
  for (const resolver of activeLoginResolvers) {
    try {
      resolver();
    } catch {}
  }
  return true;
}

/**
 * Normalizes a target URL by trimming and ensuring http:// or https:// protocol.
 */
export function normalizeTargetUrl(rawUrl: string): string {
  let url = (rawUrl || "").trim();
  if (!url) return "";
  if (!/^https?:\/\//i.test(url)) {
    url = "http://" + url;
  }
  return url;
}

export interface InteractiveLoginOptions {
  isServer?: boolean;
}

/**
 * Interactive Login Window:
 * Pops up a real headed browser window, directs the user to log in,
 * automatically detects when login is completed, and saves auth.json.
 */
export async function launchInteractiveLogin(
  url: string,
  targetAuthPath: string,
  onProgress?: (message: string) => void,
  options?: InteractiveLoginOptions
): Promise<boolean> {
  const normalizedUrl = normalizeTargetUrl(url);
  onProgress?.(`🌐 [로그인 창 실행] 브라우저 로그인 창(${normalizedUrl})을 띄웁니다. 로그인을 완료해 주세요...`);

  let loginBrowser: Browser;
  try {
    // 1. Prefer system Google Chrome if installed
    loginBrowser = await chromium.launch({
      channel: "chrome",
      headless: false,
      args: [
        "--start-maximized",
        "--new-window",
        "--window-position=50,50",
        "--disable-blink-features=AutomationControlled",
      ],
    });
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
  }

  try {
    const loginContext = await loginBrowser.newContext({
      viewport: null, // Open as a real maximized window
      ignoreHTTPSErrors: true,
    });
    const loginPage = await loginContext.newPage();
    await loginPage.goto(normalizedUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await loginPage.bringToFront();
    await loginPage.evaluate(() => window.focus()).catch(() => {});

    onProgress?.("👉 [로그인 대기] 브라우저 창에서 아이디/비밀번호를 입력하고 로그인을 완료해 주세요.");

    // Listen for newly opened popup windows/tabs (e.g. window.open portal)
    loginContext.on("page", (newPage) => {
      newPage.bringToFront().catch(() => {});
    });

    const startTime = Date.now();
    const GRACE_PERIOD_MS = 2500; // Allow initial page redirect to settle

    const isActuallyLoggedIn = async (): Promise<boolean> => {
      // Must wait past grace period so initial navigation/redirects complete
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

          // 2. POSITIVE indicators REQUIRED: GNB, user info, logout button, portal wrap, or main module URLs
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

    let sessionSaved = false;

    // Helper: inject floating "Login Complete & Close" button on top-right of browser pages
    const injectLoginHelper = async (targetPage: any, loggedIn: boolean) => {
      try {
        if (targetPage.isClosed()) return;
        await targetPage.evaluate((isLoggedIn: boolean) => {
          // Polyfill esbuild/tsx __name helper in browser context
          (window as any).__name = (window as any).__name || ((fn: any) => fn);

          let container = document.getElementById("studio-floating-login-helper");
          // If legacy container exists, replace with latest v3 draggable container immediately
          if (container && container.dataset.version !== "v3") {
            container.remove();
            container = null;
          }

          if (!container) {
            container = document.createElement("div");
            container.id = "studio-floating-login-helper";
            container.dataset.version = "v3";

            // Default initial position (top right, calculated with left/top for zero style conflict)
            let initialTop = 16;
            let initialLeft = Math.max(16, (window.innerWidth || 1280) - 400);

            try {
              const savedPos = sessionStorage.getItem("studio_helper_pos");
              if (savedPos) {
                const pos = JSON.parse(savedPos);
                if (typeof pos.x === "number" && typeof pos.y === "number") {
                  initialLeft = Math.max(8, Math.min((window.innerWidth || 1280) - 360, pos.x));
                  initialTop = Math.max(8, Math.min((window.innerHeight || 800) - 70, pos.y));
                }
              }
            } catch {}

            container.innerHTML = `
              <div id="studio-helper-card" style="position:fixed !important; top:${initialTop}px !important; left:${initialLeft}px !important; z-index:2147483647 !important; background:linear-gradient(135deg, #1e293b, #0f172a) !important; color:#ffffff !important; padding:10px 16px !important; border-radius:12px !important; box-shadow:0 10px 25px -5px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.12) !important; font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif !important; display:flex !important; align-items:center !important; gap:12px !important; pointer-events:auto !important; user-select:none !important; -webkit-user-select:none !important; touch-action:none !important; cursor:grab !important; box-sizing:border-box !important;">
                <div id="studio-drag-handle" title="마우스로 잡고 어디든 드래그하여 이동" style="cursor:grab !important; display:flex !important; align-items:center !important; justify-content:center !important; padding:6px 8px !important; background:rgba(255,255,255,0.1) !important; border-radius:6px !important; color:#cbd5e1 !important; font-size:18px !important; line-height:1 !important; user-select:none !important;">
                  ⠿
                </div>
                <div style="display:flex !important; flex-direction:column !important; cursor:grab !important; pointer-events:none !important;">
                  <span style="font-size:11px !important; color:#94a3b8 !important; font-weight:600 !important; letter-spacing:0.5px !important;">SCREEN DEMO STUDIO</span>
                  <span id="studio-helper-status" style="font-size:13px !important; font-weight:700 !important; color:#38bdf8 !important;">🔐 로그인 진행 중...</span>
                </div>
                <button id="studio-btn-login-done" style="background:#2563eb !important; color:#ffffff !important; border:none !important; padding:8px 16px !important; border-radius:8px !important; font-size:13px !important; font-weight:700 !important; cursor:pointer !important; display:flex !important; align-items:center !important; gap:6px !important; box-shadow:0 4px 12px rgba(37,99,235,0.3) !important; transition:all 0.2s !important; white-space:nowrap !important; pointer-events:auto !important;">
                  <span id="studio-btn-label">⏎ 로그인 완료 & 창 닫기</span>
                </button>
              </div>
            `;
            document.body.appendChild(container);

            const card = document.getElementById("studio-helper-card") as HTMLElement | null;
            const btn = document.getElementById("studio-btn-login-done") as HTMLElement | null;

            if (card) {
              let isDragging = false;
              let startX = 0;
              let startY = 0;
              let startLeft = 0;
              let startTop = 0;

              // Prevent HTML5 ghost image dragging
              card.ondragstart = () => false;

              // Use Pointer Events + setPointerCapture for 100% reliable dragging across iframes and windows
              card.addEventListener("pointerdown", (e: PointerEvent) => {
                if (btn && (e.target === btn || btn.contains(e.target as Node))) {
                  return; // Don't drag when clicking the submit button
                }
                if (e.button !== 0) return; // Left mouse button only

                isDragging = true;
                try {
                  card.setPointerCapture(e.pointerId);
                } catch {}

                const rect = card.getBoundingClientRect();
                startLeft = rect.left;
                startTop = rect.top;
                startX = e.clientX;
                startY = e.clientY;

                card.style.setProperty("cursor", "grabbing", "important");
                card.style.setProperty("opacity", "0.92", "important");
                card.style.setProperty("box-shadow", "0 16px 36px rgba(0,0,0,0.65), 0 0 0 2px rgba(56,189,248,0.7)", "important");
                e.preventDefault();
              });

              card.addEventListener("pointermove", (e: PointerEvent) => {
                if (!isDragging) return;
                const dx = e.clientX - startX;
                const dy = e.clientY - startY;

                let newX = startLeft + dx;
                let newY = startTop + dy;

                const cardWidth = card.offsetWidth || 380;
                const cardHeight = card.offsetHeight || 60;
                newX = Math.max(8, Math.min(window.innerWidth - cardWidth - 8, newX));
                newY = Math.max(8, Math.min(window.innerHeight - cardHeight - 8, newY));

                card.style.setProperty("left", `${newX}px`, "important");
                card.style.setProperty("top", `${newY}px`, "important");
              });

              const handlePointerUp = (e: PointerEvent) => {
                if (!isDragging) return;
                isDragging = false;
                try {
                  card.releasePointerCapture(e.pointerId);
                } catch {}

                card.style.setProperty("cursor", "grab", "important");
                card.style.setProperty("opacity", "1", "important");
                card.style.setProperty("box-shadow", "0 10px 25px -5px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.12)", "important");

                try {
                  const rect = card.getBoundingClientRect();
                  sessionStorage.setItem("studio_helper_pos", JSON.stringify({ x: rect.left, y: rect.top }));
                } catch {}
              };

              card.addEventListener("pointerup", handlePointerUp);
              card.addEventListener("pointercancel", handlePointerUp);
            }

            if (btn) {
              btn.addEventListener("mouseenter", () => {
                btn.style.filter = "brightness(1.15)";
              });
              btn.addEventListener("mouseleave", () => {
                btn.style.filter = "none";
              });
              btn.addEventListener("click", (e) => {
                e.stopPropagation();
                const label = document.getElementById("studio-btn-label");
                if (label) label.textContent = "⏳ 저장 및 닫는 중...";
                btn.style.opacity = "0.7";
                (window as any).__studioLoginDoneTriggered = true;
              });
            }
          }



          // Update styles if logged in
          const statusText = document.getElementById("studio-helper-status");
          const btn = document.getElementById("studio-btn-login-done");
          const card = document.getElementById("studio-helper-card");
          if (isLoggedIn) {
            if (statusText) {
              statusText.textContent = "🎉 로그인 확인됨! 버튼을 누르세요";
              statusText.style.color = "#4ade80";
            }
            if (btn) {
              btn.style.background = "#16a34a";
              btn.style.boxShadow = "0 0 16px rgba(34,197,94,0.6)";
            }
            if (card) {
              card.style.border = "1.5px solid #22c55e";
            }
          }
        }, loggedIn).catch(() => {});
      } catch {}
    };

    const saveSession = async (reason: string): Promise<boolean> => {
      try {
        const loggedIn = await isActuallyLoggedIn();
        if (!loggedIn) {
          console.log(`[세션 저장 건너뜀] 아직 실제 로그인이 완료되지 않아 빈 세션을 저장하지 않습니다 (${reason}).`);
          return false;
        }

        const targetDir = path.dirname(targetAuthPath);
        if (!fs.existsSync(targetDir)) {
          fs.mkdirSync(targetDir, { recursive: true });
        }
        await loginContext.storageState({ path: targetAuthPath });
        syncAuthSession(targetAuthPath);
        onProgress?.(`💾 [세션 저장 완료 - ${reason}] 인증 정보가 영구 저장되었습니다: ${targetAuthPath}`);
        return true;
      } catch (err: any) {
        console.warn(`[세션 저장 실패] ${err.message}`);
        return false;
      }
    };

    // Detect login completion in real-time across ALL pages/popups
    // NOTE: Does NOT auto-close window upon login! Waits for user click on [로그인 완료] button!
    const waitForLoginSuccess = async (): Promise<boolean> => {
      let notifiedLoggedIn = false;

      while (true) {
        try {
          const allPages = loginContext.pages();
          const allClosed = allPages.length === 0 || allPages.every((p) => p.isClosed());
          if (allClosed) {
            if (!sessionSaved) {
              sessionSaved = await saveSession("브라우저 창 닫힘 감지");
            }
            return sessionSaved;
          }

          const loggedIn = await isActuallyLoggedIn();

          // Inject floating helper UI to all active pages
          for (const p of allPages) {
            if (!p.isClosed()) {
              await injectLoginHelper(p, loggedIn);

              // Check if user clicked the in-browser [로그인 완료 & 창 닫기] button
              const triggered = await p
                .evaluate(() => (window as any).__studioLoginDoneTriggered === true)
                .catch(() => false);

              if (triggered) {
                onProgress?.("👆 [사용자 클릭 감지] 브라우저 내 [로그인 완료 & 창 닫기] 버튼 클릭 수신 -> 세션 저장 및 창 종료");
                sessionSaved = await saveSession("브라우저 내 완료 버튼 클릭");
                return true;
              }
            }
          }

          if (loggedIn && !notifiedLoggedIn) {
            notifiedLoggedIn = true;
            onProgress?.("🎉 [로그인 확인 완료] 로그인이 확인되었습니다! 화면 상단 또는 대시보드의 [로그인 완료] 버튼을 누르시면 창이 닫힙니다.");
            sessionSaved = await saveSession("실시간 로그인 감지 (대기 상태)");
          }
        } catch {}
        await new Promise((r) => setTimeout(r, 600));
      }
    };

    // Also support Enter key in console if running in terminal CLI
    const waitForEnter = async (): Promise<boolean> => {
      return new Promise<boolean>((resolve) => {
        if (options?.isServer || !process.stdin.isTTY) return;
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.once("line", async () => {
          rl.close();
          if (!sessionSaved) {
            sessionSaved = await saveSession("콘솔 엔터 입력");
          }
          resolve(sessionSaved);
        });
      });
    };

    // Also support API trigger from Dashboard button
    const waitForApiTrigger = async (): Promise<boolean> => {
      return new Promise<boolean>((resolve) => {
        const handler = async () => {
          activeLoginResolvers.delete(handler);
          onProgress?.("👆 [대시보드 클릭 감지] 대시보드 [로그인 완료] 버튼 수신 -> 세션 저장 및 창 종료");
          if (!sessionSaved) {
            sessionSaved = await saveSession("대시보드 완료 버튼 수신");
          }
          resolve(sessionSaved);
        };
        activeLoginResolvers.add(handler);
      });
    };

    await Promise.race([waitForEnter(), waitForLoginSuccess(), waitForApiTrigger()]);

    if (!sessionSaved) {
      sessionSaved = await saveSession("최종 종료 직전 점검");
    }

    await loginContext.close().catch(() => {});
    await loginBrowser.close().catch(() => {});
    return sessionSaved && fs.existsSync(targetAuthPath) && fs.statSync(targetAuthPath).size > 100;
  } catch (err: any) {
    console.error(`❌ [브라우저 로그인 오류] ${err.message}`, err);
    await loginBrowser.close().catch(() => {});
    onProgress?.(`⚠️ [로그인 오류] ${err.message}`);
    return false;
  }
}

/**
 * Universal Authentication Orchestrator:
 * Ensures an active, verified login session exists before proceeding to Visual Probe or Scenario Generation.
 * If no session exists or session has expired, automatically prompts interactive login.
 */
export async function ensureAuthenticatedSession(
  options: EnsureAuthOptions
): Promise<AuthSessionResult> {
  const targetAuthPath = getAuthFilePath(options.slug);
  const existingCandidate = findExistingAuthSession(options.slug);

  // 1. Check if we already have a valid session and forceLogin is not requested
  if (!options.forceLogin && existingCandidate) {
    options.onProgress?.(`🔍 [세션 유효성 검사] 저장된 인증 세션(${path.basename(path.dirname(existingCandidate))}/auth.json)의 유효성을 점검합니다...`);
    const valid = await isSessionValid(options.url, existingCandidate, options.viewport);
    if (valid) {
      options.onProgress?.("✅ [세션 검증 성공] 기존 로그인 세션이 유효합니다. 시나리오 탐색을 바로 시작합니다.");
      // Ensure targetAuthPath has a copy
      if (existingCandidate !== targetAuthPath) {
        fs.copyFileSync(existingCandidate, targetAuthPath);
      }
      return { success: true, authPath: targetAuthPath };
    } else {
      options.onProgress?.("⚠️ [세션 만료 감지] 기존 로그인 세션이 만료되어 재로그인이 필요합니다.");
    }
  } else {
    options.onProgress?.("🔐 [최초 인증 필요] 저장된 로그인 세션이 없어 신규 로그인이 필요합니다.");
  }

  // 2. Launch Interactive Login to obtain a fresh session
  const success = await launchInteractiveLogin(options.url, targetAuthPath, options.onProgress);
  if (success && fs.existsSync(targetAuthPath)) {
    return { success: true, authPath: targetAuthPath };
  }

  return {
    success: false,
    error: "사용자가 로그인을 완료하지 않았거나 로그인 창이 닫혔습니다.",
  };
}

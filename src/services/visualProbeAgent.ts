import { chromium, Browser, BrowserContext, Page } from "playwright";
import * as fs from "fs";
import * as path from "path";
import { extractLiveCandidates, LiveDOMCandidate } from "./elementSelfHealer";
import { ensureAuthenticatedSession } from "./authManager";

export interface VisualProbeScreen {
  name: string;
  url: string;
  base64: string;
  dialogTitle?: string;
  openedBy?: string;
  candidates: LiveDOMCandidate[];
}

export interface VisualProbeResult {
  success: boolean;
  screens: VisualProbeScreen[];
  error?: string;
}

export interface VisualProbeOptions {
  targetUrl: string;
  prompt: string;
  slug?: string;
  onProgress?: (message: string) => void;
}

/**
 * Finds an existing, valid auth storage session file across data directories.
 */
function findAuthSession(slug?: string): string | null {
  const rootDataDir = path.resolve(__dirname, "..", "..", "data");
  if (!fs.existsSync(rootDataDir)) return null;

  // 1. Check specified slug first
  if (slug) {
    const slugAuth = path.join(rootDataDir, slug, "auth.json");
    if (fs.existsSync(slugAuth) && fs.statSync(slugAuth).size > 100) {
      return slugAuth;
    }
  }

  // 2. Scan all subdirectories in data/ for any fresh auth.json
  const subdirs = fs.readdirSync(rootDataDir);
  for (const dir of subdirs) {
    const candidate = path.join(rootDataDir, dir, "auth.json");
    if (fs.existsSync(candidate) && fs.statSync(candidate).size > 100) {
      return candidate;
    }
  }

  return null;
}

/**
 * Pre-flight Visual Explorer Agent:
 * Headlessly probes the target web application before BrowsePlan generation.
 * Captures real visual screenshots and live DOM element candidates,
 * enabling Gemini Multimodal AI to construct scenarios from actual sight rather than imagination.
 */
export async function probeTargetScreens(options: VisualProbeOptions): Promise<VisualProbeResult> {
  const screens: VisualProbeScreen[] = [];
  let browser: Browser | null = null;
  const promptLower = (options.prompt || "").toLowerCase();

  try {
    // 0. Ensure active authentication session exists BEFORE probing
    options.onProgress?.("🔐 [인증 세션 확인] 시각적 탐색을 위한 로그인 세션 유효성을 점검합니다...");
    const authResult = await ensureAuthenticatedSession({
      url: options.targetUrl,
      slug: options.slug,
      onProgress: options.onProgress,
    });

    if (!authResult.success || !authResult.authPath) {
      return {
        success: false,
        screens: [],
        error: authResult.error || "로그인 세션이 확보되지 않아 화면 탐색을 진행할 수 없습니다.",
      };
    }

    const authPath = authResult.authPath;
    options.onProgress?.("👁️ [시각적 사전 탐색] 인증 세션을 주입하여 Playwright 브라우저를 가동합니다...");

    browser = await chromium.launch({
      headless: true,
      args: ["--window-size=1920,1080"],
    });

    const contextOptions: Parameters<typeof browser.newContext>[0] = {
      viewport: { width: 1920, height: 1080 },
      storageState: authPath,
    };

    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();

    // 1. Navigate to target URL
    options.onProgress?.(`🌐 [화면 접속] 대상 URL(${options.targetUrl})로 이동 중...`);
    await page.goto(options.targetUrl, { waitUntil: "domcontentloaded", timeout: 25000 });
    await page.waitForTimeout(1500);

    // Capture Screen 1: Landing Page
    const landingShot = await page.screenshot({ type: "jpeg", quality: 75 });
    const landingCandidates = await extractLiveCandidates(page).catch(() => ({ candidates: [] }));
    screens.push({
      name: "포탈 메인 대시보드 / 시작 화면",
      url: page.url(),
      base64: landingShot.toString("base64"),
      candidates: landingCandidates.candidates,
    });
    options.onProgress?.(`📸 [화면 확인 #1] 시작 화면 시각 정보 및 요소 (${landingCandidates.candidates.length}개) 캡처 완료`);

    // 2. Module Navigation Probe based on user prompt
    const moduleKeywords = [
      { name: "문서관리", aliases: ["문서관리", "문서", "문서함", "doc"] },
      { name: "전자결재", aliases: ["전자결재", "결재", "기안", "approval", "eapp"] },
      { name: "일정관리", aliases: ["일정관리", "일정", "캘린더", "schedule"] },
      { name: "게시판", aliases: ["게시판", "게시글", "공지사항", "board", "brd"] },
      { name: "자원예약관리", aliases: ["자원예약", "자원", "회의실", "시설"] },
      { name: "주소록", aliases: ["주소록", "연락처", "조직도"] },
      { name: "사내쪽지", aliases: ["사내쪽지", "쪽지", "메시지"] },
      { name: "전자우편", aliases: ["전자우편", "메일", "웹메일", "mail"] },
    ];

    let targetModule = "";
    for (const mod of moduleKeywords) {
      if (mod.aliases.some((alias) => promptLower.includes(alias))) {
        targetModule = mod.name;
        break;
      }
    }

    // If targetModule wasn't found from preset aliases, scan drawer / header links for any keyword from prompt
    if (!targetModule) {
      const words = promptLower.split(/[\s,()_+/]+/).filter((w) => w.length >= 2);
      const btnSvcOpen = page.locator("button.btn_svc_open:visible, button[title*='전체메뉴']:visible, .btn_svc_open:visible").first();
      if (await btnSvcOpen.isVisible().catch(() => false)) {
        await btnSvcOpen.click().catch(() => {});
        await page.waitForTimeout(800);
      }
      for (const word of words) {
        const link = page.locator(`#svc_box a:has-text('${word}'):visible, header a:has-text('${word}'):visible`).first();
        if (await link.isVisible().catch(() => false)) {
          const text = (await link.innerText().catch(() => "")).trim();
          if (text) {
            targetModule = text;
            break;
          }
        }
      }
    }

    if (targetModule) {
      // Check if drawer is needed
      const btnSvcOpen = page.locator("button.btn_svc_open:visible, button[title*='전체메뉴']:visible, .btn_svc_open:visible").first();
      if (await btnSvcOpen.isVisible().catch(() => false)) {
        await btnSvcOpen.click().catch(() => {});
        await page.waitForTimeout(800);
      }

      const menuLink = page.locator(`#svc_box a:has-text('${targetModule}'):visible, a:has-text('${targetModule}'):visible`).first();
      if (await menuLink.isVisible().catch(() => false)) {
        options.onProgress?.(`👉 [모듈 진입] 대상 모듈('${targetModule}')로 이동 중...`);
        await menuLink.click().catch(() => {});
        await page.waitForTimeout(2500);

        // Capture Screen 2: Module Main Page
        const moduleShot = await page.screenshot({ type: "jpeg", quality: 75 });
        const moduleCandidates = await extractLiveCandidates(page).catch(() => ({ candidates: [] }));
        screens.push({
          name: `${targetModule} 메인 화면`,
          url: page.url(),
          base64: moduleShot.toString("base64"),
          candidates: moduleCandidates.candidates,
        });
        options.onProgress?.(`📸 [화면 확인 #2] ${targetModule} 메인 화면 및 요소 (${moduleCandidates.candidates.length}개) 캡처 완료`);
      }
    }

    // 3. Action / Form / Dialog Probe
    const isCreateIntent =
      promptLower.includes("등록") ||
      promptLower.includes("작성") ||
      promptLower.includes("기안") ||
      promptLower.includes("신규") ||
      promptLower.includes("생성") ||
      promptLower.includes("추가");

    const isSearchIntent =
      promptLower.includes("검색") ||
      promptLower.includes("조회") ||
      promptLower.includes("열람") ||
      promptLower.includes("찾기") ||
      promptLower.includes("상세");

    if (isCreateIntent) {
      const writeBtn = page
        .locator(
          "#docMain_writeBtn:visible, #snb button:has-text('등록'):visible, #snb button:has-text('작성'):visible, #snb a:has-text('등록'):visible, #snb a:has-text('작성'):visible, button:has-text('문서 등록'):visible, button:has-text('일정 등록'):visible, button:has-text('기안작성'):visible, button:has-text('새글'):visible, button:has-text('등록'):visible, button:has-text('작성'):visible, button:has-text('기안'):visible, a:has-text('등록'):visible, a:has-text('작성'):visible, .btn_write:visible"
        )
        .first();

      if (await writeBtn.isVisible().catch(() => false)) {
        options.onProgress?.("📝 [등록 폼 탐색] 신규 작성/등록 버튼을 클릭하여 입력 폼 화면 확인 중...");
        await writeBtn.click().catch(() => {});
        await page.waitForTimeout(1800);

        // Dismiss folder/container selection popup if present
        const alertOk = page.locator(".ui-dialog:visible button:has-text('확인'):visible, #alert_lyr button:has-text('확인'):visible").first();
        if (await alertOk.isVisible().catch(() => false)) {
          const leafNode = page.locator(".ui-dialog:visible .dynatree-container .dynatree-node:not(.dynatree-folder) a:visible, .ui-dialog:visible .dynatree-container a:visible").first();
          if (await leafNode.isVisible().catch(() => false)) {
            await leafNode.click().catch(() => {});
            await page.waitForTimeout(400);
          }
          await alertOk.click().catch(() => {});
          await page.waitForTimeout(1500);
        }

        // Capture Screen 3: Form View
        const formShot = await page.screenshot({ type: "jpeg", quality: 75 });
        const formCandidates = await extractLiveCandidates(page).catch(() => ({ candidates: [], activeDialogTitle: undefined }));
        screens.push({
          name: "신규 등록/작성 폼 화면",
          url: page.url(),
          base64: formShot.toString("base64"),
          dialogTitle: formCandidates.activeDialogTitle,
          candidates: formCandidates.candidates,
        });
        options.onProgress?.(`📸 [화면 확인 #3] 등록 폼 화면 및 요소 (${formCandidates.candidates.length}개) 캡처 완료`);

        // Check if prompt asks for sub-dialog (permissions, org chart, attendees, approval line)
        const isSubModalIntent =
          promptLower.includes("권한") ||
          promptLower.includes("조직도") ||
          promptLower.includes("참석자") ||
          promptLower.includes("결재선") ||
          promptLower.includes("수신자") ||
          promptLower.includes("자원") ||
          promptLower.includes("옵션") ||
          promptLower.includes("설정");

        if (isSubModalIntent) {
          const subTrigger = page
            .locator(
              "button:has-text('권한'):visible, label:has-text('권한'):visible, button:has-text('결재선'):visible, button:has-text('참석자'):visible, button:has-text('자원'):visible, button:has-text('옵션'):visible, button:has-text('설정'):visible, button:has-text('추가'):visible, a:has-text('권한'):visible, a:has-text('설정'):visible"
            )
            .first();

          if (await subTrigger.isVisible().catch(() => false)) {
            options.onProgress?.("🪟 [하위 팝업 탐색] 서브 설정(권한/조직도/옵션) 버튼을 클릭하여 모달 화면 확인 중...");
            await subTrigger.click().catch(() => {});
            await page.waitForTimeout(1200);

            // If nested picker trigger exists inside the dialog (e.g. [추가] -> Org modal)
            let nestedOpenedBy: string | undefined = undefined;
            const nestedTrigger = page.locator(".ui-dialog:visible button:has-text('추가'):visible, .ui-dialog:visible button:has-text('조직도'):visible, .ui-dialog:visible button:has-text('주소록'):visible").first();
            if (await nestedTrigger.isVisible().catch(() => false)) {
              await nestedTrigger.click().catch(() => {});
              await page.waitForTimeout(1500);
              nestedOpenedBy = ".ui-dialog:visible button:has-text('추가'):visible, .ui-dialog:visible button:has-text('조직도'):visible";
            }

            // Capture Screen 4: Modal Dialog View
            const modalShot = await page.screenshot({ type: "jpeg", quality: 75 });
            const modalCandidates = await extractLiveCandidates(page).catch(() => ({ candidates: [], activeDialogTitle: undefined }));
            screens.push({
              name: nestedOpenedBy ? "하위 픽커/조직도 선택 팝업 화면" : "설정/선택 팝업 대화상자 화면",
              url: page.url(),
              base64: modalShot.toString("base64"),
              dialogTitle: modalCandidates.activeDialogTitle,
              openedBy: nestedOpenedBy,
              candidates: modalCandidates.candidates,
            });
            options.onProgress?.(`📸 [화면 확인 #4] 팝업 대화상자 화면 및 요소 (${modalCandidates.candidates.length}개) 캡처 완료`);
          }
        }
      }
    } else if (isSearchIntent) {
      // For search intent, inspect the list table and content search bar
      const searchInput = page.locator("#content input:visible, .new_srch_bar input:visible, input[placeholder*='검색']:visible, input[id*='search']:visible").first();
      if (await searchInput.isVisible().catch(() => false)) {
        const searchShot = await page.screenshot({ type: "jpeg", quality: 75 });
        const searchCandidates = await extractLiveCandidates(page).catch(() => ({ candidates: [] }));
        screens.push({
          name: "목록 및 검색 화면",
          url: page.url(),
          base64: searchShot.toString("base64"),
          candidates: searchCandidates.candidates,
        });
        options.onProgress?.(`📸 [화면 확인 #3] 목록 및 검색 화면 요소 (${searchCandidates.candidates.length}개) 캡처 완료`);
      }
    }

    options.onProgress?.(`🎉 [사전 시각 탐색 완료] 총 ${screens.length}개의 실제 브라우저 화면과 DOM 후보군을 확보했습니다! Gemini가 실제 화면을 보며 시나리오를 구성합니다.`);

    return {
      success: true,
      screens,
    };
  } catch (err: any) {
    console.warn(`[VisualProbeAgent 경고] 사전 시각 탐색 중 예외 발생 (${err.message}). 안전하게 폴백합니다.`);
    return {
      success: false,
      screens,
      error: err.message,
    };
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {}
    }
  }
}

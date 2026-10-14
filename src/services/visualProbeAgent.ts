import { chromium, Browser } from "playwright";
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
 * Pre-flight Visual Explorer Agent (V3 - Multi-Module & 2-Step Approval Form Aware):
 * Headlessly probes the target web application before BrowsePlan generation.
 * Captures real visual screenshots and live DOM element candidates across:
 * - Portal Main
 * - Target Business Module Main (all 18 groupware modules supported)
 * - Template Selection & Actual Registration Form (including EAP 2-step card -> [작성] entry)
 * - Sub-dialogs (Approval Line, Org Picker, Permission, Binder/Folder Tree)
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

    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      storageState: authPath,
      ignoreHTTPSErrors: true,
    });
    const page = await context.newPage();

    // 1. Navigate to target URL
    let targetNavUrl = options.targetUrl;
    try {
      const parsed = new URL(options.targetUrl);
      if (parsed.pathname === "" || parsed.pathname === "/") {
        targetNavUrl = new URL("/ekp/main/home/homGwMain", options.targetUrl).toString();
      }
    } catch {}

    options.onProgress?.(`🌐 [화면 접속] 대상 URL(${targetNavUrl})로 이동 중...`);
    await page.goto(targetNavUrl, { waitUntil: "domcontentloaded", timeout: 25000 });
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

    // 2. Module Navigation Probe based on user prompt (All 18 Groupware Modules)
    const moduleKeywords = [
      { name: "전자결재", aliases: ["전자결재", "결재", "기안", "상신", "품의", "회의록", "지출결의서", "approval", "eap", "eapp"] },
      { name: "문서관리", aliases: ["문서관리", "문서함", "문서등록", "문서", "doc", "edms"] },
      { name: "일정관리", aliases: ["일정관리", "일정등록", "일정", "캘린더", "스케줄", "schedule", "scd"] },
      { name: "게시판", aliases: ["게시판", "게시글", "공지사항", "공지", "글작성", "board", "brd"] },
      { name: "자원예약관리", aliases: ["자원예약관리", "자원예약", "자원", "회의실", "차량예약", "시설예약", "rmg"] },
      { name: "업무보고", aliases: ["업무보고", "보고서", "일일보고", "주간보고", "정기보고", "보고등록", "wor"] },
      { name: "스마트워크", aliases: ["스마트워크", "스마트업무", "업무함", "smw"] },
      { name: "프로젝트", aliases: ["프로젝트", "일감", "마일스톤", "간트차트", "이슈", "prj"] },
      { name: "스페이스", aliases: ["스페이스", "팀사이트", "wks", "tws"] },
      { name: "설문조사", aliases: ["설문조사", "설문", "투표", "앙케이트", "sur"] },
      { name: "파일함", aliases: ["파일함", "웹하드", "자료실", "공유폴더", "fbx"] },
      { name: "메모", aliases: ["메모", "포스트잇", "메모장", "mmo"] },
      { name: "사내쪽지", aliases: ["사내쪽지", "쪽지", "쪽지쓰기", "note", "not"] },
      { name: "전자우편", aliases: ["전자우편", "메일", "웹메일", "메일쓰기", "mail", "eml"] },
      { name: "주소록", aliases: ["주소록", "연락처", "addr"] },
      { name: "근태관리", aliases: ["근태관리", "근태", "출퇴근", "휴가", "부재", "attend", "atn"] },
      { name: "조직도", aliases: ["조직도", "임직원", "부서조회"] },
    ];

    let targetModule = "";
    let minIndex = Infinity;
    let maxMatchLen = 0;

    for (const mod of moduleKeywords) {
      for (const alias of mod.aliases) {
        const idx = promptLower.indexOf(alias);
        if (idx !== -1) {
          if (idx < minIndex || (idx === minIndex && alias.length > maxMatchLen)) {
            minIndex = idx;
            maxMatchLen = alias.length;
            targetModule = mod.name;
          }
        }
      }
    }

    // Open service drawer if needed to find or navigate to target module
    const btnSvcOpen = page.locator("button.btn_svc_open:visible, button[title*='전체메뉴']:visible, .btn_svc_open:visible").first();
    if (await btnSvcOpen.isVisible().catch(() => false)) {
      await btnSvcOpen.click().catch(() => {});
      await page.waitForTimeout(900);
    }

    if (!targetModule) {
      const words = promptLower.split(/[\s,()_+/]+/).filter((w) => w.length >= 2);
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
      promptLower.includes("상신") ||
      promptLower.includes("신규") ||
      promptLower.includes("생성") ||
      promptLower.includes("신청") ||
      promptLower.includes("예약") ||
      promptLower.includes("쓰기") ||
      promptLower.includes("발송") ||
      promptLower.includes("보내기") ||
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
          "#eapLeft_workWriteBtn:visible, #gapLeft_workWriteBtn:visible, #docMain_writeBtn:visible, #docLeft_writeBtn:visible, #edmsLeft_docRegBtn:visible, #brdBoardLeft_writeBtn:visible, #reg_shedule_lefttop:visible, #rmgResSideBar_apply:visible, #notSubMenu_noteRegButton:visible, #emlList_goWriteEmail:visible, #worSideBar_workReg:visible, #sur_writeBtn:visible, #prjDetailTaskList_btnAddTask:visible, #mmoMainLeft_addMemoBtn:visible, #addrMain_write_btn:visible, #atnAttendSideBar_absenceWrite:visible, #snb button:has-text('결재작성'):visible, #snb button:has-text('결재 작성'):visible, #snb button:has-text('등록'):visible, #snb button:has-text('작성'):visible, #snb button:has-text('쓰기'):visible, #snb button:has-text('신청'):visible, button:has-text('문서 등록'):visible, button:has-text('일정 등록'):visible, button:has-text('글작성'):visible, .btn_write:visible"
        )
        .first();

      if (await writeBtn.isVisible().catch(() => false)) {
        options.onProgress?.("📝 [등록 폼 탐색] 좌측 신규 작성/등록 버튼을 클릭하여 진입 중...");
        await writeBtn.click().catch(() => {});
        await page.waitForTimeout(1800);

        // Special Handling A: Electronic Approval (EAP) 2-Step Template Selection -> Draft Form
        const isEapWorkSelect =
          (await page.locator("#eapWorkSelect_workList:visible, ul.aw_ul li.aw_li:visible, .app_work_box:visible").count().catch(() => 0)) > 0;

        if (isEapWorkSelect) {
          // Capture Screen 3A: Approval Work Template Selection Screen
          const workSelectShot = await page.screenshot({ type: "jpeg", quality: 75 });
          const workSelectCandidates = await extractLiveCandidates(page).catch(() => ({ candidates: [] }));
          screens.push({
            name: "전자결재 결재업무(양식) 선택 화면",
            url: page.url(),
            base64: workSelectShot.toString("base64"),
            candidates: workSelectCandidates.candidates,
          });
          options.onProgress?.(`📸 [화면 확인 #3A] 결재업무(양식) 선택 화면 요소 (${workSelectCandidates.candidates.length}개) 캡처 완료`);

          // Enter the actual Draft Registration Form by clicking the template card and its inner [작성] button
          const cardLoc = page.locator("ul.aw_ul li.aw_li:first-child .app_work_box:visible, li.aw_li:first-child a._his:visible, .app_work_box:visible").first();
          if (await cardLoc.isVisible().catch(() => false)) {
            await cardLoc.click().catch(() => {});
            await page.waitForTimeout(600);
          }
          const innerWriteBtn = page.locator("ul.aw_ul li.aw_li button.btn_write:visible, .app_work_box button.btn_write:visible, #eapWorkSelect_workList button.btn_write:visible").first();
          if (await innerWriteBtn.isVisible().catch(() => false)) {
            options.onProgress?.("📑 [기안서 폼 진입] 양식 카드 내부 [작성] 버튼을 클릭하여 실제 기안 작성 화면을 오픈합니다...");
            await innerWriteBtn.click().catch(() => {});
            await page.waitForTimeout(2800);
          }
        }

        // Special Handling B: Folder/Binder/WorkBox selection popup before form entry
        const alertOk = page.locator(".ui-dialog:visible button._confirmBtn:visible, .ui-dialog:visible button:has-text('확인'):visible, #alert_lyr button:has-text('확인'):visible").first();
        if (await alertOk.isVisible().catch(() => false)) {
          const expandBtn = page.locator(".ui-dialog:visible .btn_fopn:visible, .ui-dialog:visible .dynatree-expander:visible").first();
          if (await expandBtn.isVisible().catch(() => false)) {
            await expandBtn.click().catch(() => {});
            await page.waitForTimeout(800);
          }
          const leafNode = page.locator(".ui-dialog:visible .dynatree-container .dynatree-node:not(.dynatree-folder) a.dynatree-title:visible, .ui-dialog:visible .dynatree-container a.dynatree-title:visible, #worWorkBoxSelect_workBoxList tr:first-child a:visible").first();
          if (await leafNode.isVisible().catch(() => false)) {
            await leafNode.click().catch(() => {});
            await page.waitForTimeout(500);
          }
          if (await alertOk.isVisible().catch(() => false)) {
            await alertOk.click().catch(() => {});
            await page.waitForTimeout(1500);
          }
        }

        // Capture Screen 3: Actual Form View
        const formShot = await page.screenshot({ type: "jpeg", quality: 75 });
        const formCandidates = await extractLiveCandidates(page).catch(() => ({ candidates: [], activeDialogTitle: undefined }));
        screens.push({
          name: "신규 등록/기안 작성 본문 폼 화면",
          url: page.url(),
          base64: formShot.toString("base64"),
          dialogTitle: formCandidates.activeDialogTitle,
          candidates: formCandidates.candidates,
        });
        options.onProgress?.(`📸 [화면 확인 #3] 등록/기안 폼 화면 및 요소 (${formCandidates.candidates.length}개) 캡처 완료`);

        // 4. Sub-dialog Probe (Approval Line, Permissions, Org Chart, Attendees, Resource Picker)
        const isSubModalIntent =
          promptLower.includes("결재선") ||
          promptLower.includes("합의") ||
          promptLower.includes("권한") ||
          promptLower.includes("조직도") ||
          promptLower.includes("참석자") ||
          promptLower.includes("수신자") ||
          promptLower.includes("자원") ||
          promptLower.includes("보관함") ||
          promptLower.includes("기록물철");

        if (isSubModalIntent) {
          // If Approval Line is requested in EAP, switch to [결재선] tab first if present
          if (promptLower.includes("결재선") || promptLower.includes("합의")) {
            const lineTab = page.locator("#eapDocReg_tabBox a:has-text('결재선'):visible, a:has-text('결재선'):visible").first();
            if (await lineTab.isVisible().catch(() => false)) {
              await lineTab.click().catch(() => {});
              await page.waitForTimeout(600);
            }
          }

          const subTrigger = page
            .locator(
              "button#eapDocReg_lineSelBtn:visible, button#eapDocReg_binderSelBtn:visible, button#resInsertDetailView_resSelect:visible, button#notNoteReg_toAddressButton:visible, button:has-text('결재선 선택'):visible, button:has-text('결재선'):visible, button:has-text('권한'):visible, label:has-text('권한'):visible, button:has-text('참석자'):visible, button:has-text('자원 선택'):visible, button:has-text('주소록'):visible, button:has-text('조직도'):visible"
            )
            .first();

          if (await subTrigger.isVisible().catch(() => false)) {
            options.onProgress?.("🪟 [하위 팝업 탐색] 서브 설정(결재선/권한/조직도/자원) 버튼을 클릭하여 모달 화면 확인 중...");
            await subTrigger.click().catch(() => {});
            await page.waitForTimeout(1400);

            let nestedOpenedBy: string | undefined = undefined;
            const nestedTrigger = page
              .locator(".ui-dialog:visible button#authEdit_authAdd:visible, .ui-dialog:visible button:has-text('추가'):not([data-app-type-ordr]):visible, .ui-dialog:visible button:has-text('조직도'):visible")
              .first();
            if (
              !(promptLower.includes("결재선") || promptLower.includes("합의")) &&
              (await nestedTrigger.isVisible().catch(() => false))
            ) {
              await nestedTrigger.click().catch(() => {});
              await page.waitForTimeout(1400);
              nestedOpenedBy = ".ui-dialog:visible button:has-text('추가'):visible, .ui-dialog:visible button:has-text('조직도'):visible";
            }

            // Capture Screen 4: Modal Dialog View
            const modalShot = await page.screenshot({ type: "jpeg", quality: 75 });
            const modalCandidates = await extractLiveCandidates(page).catch(() => ({ candidates: [], activeDialogTitle: undefined }));
            screens.push({
              name: nestedOpenedBy ? "하위 픽커/조직도 선택 팝업 화면" : "결재선/설정/선택 팝업 대화상자 화면",
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

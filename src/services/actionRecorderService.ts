import { chromium, Browser, BrowserContext, Page } from "playwright";
import { GoogleGenAI } from "@google/genai";
import * as fs from "fs";
import * as path from "path";
import { BrowsePlan, BrowsePlanAction } from "../types";
import { getConfig } from "./configManager";
import {
  findExistingAuthSession,
  getAuthFilePath,
  normalizeTargetUrl,
  syncAuthSession,
} from "./authManager";
import { sanitizeBrowsePlan } from "./planSanitizer";

export interface RecordedRawEvent {
  seq: number;
  timestamp: number;
  kind: "click" | "hover" | "type" | "dragAndDrop" | "select" | "scroll" | "upload";
  selector: string;
  sourceSelector?: string;
  targetSelector?: string;
  targetHtml?: string;
  iframe?: string;
  tagName: string;
  label: string;
  text?: string;
  filePath?: string;
  pressEnter?: boolean;
  editorParaIndex?: number;
  editorInsertNewline?: boolean;
  cursorOffset?: { x: number; y: number };
  pageUrl: string;
  inModal: boolean;
}

export interface RecorderSessionStatus {
  active: boolean;
  finishedByBrowserHud?: boolean;
  targetUrl: string;
  eventsCount: number;
  events: RecordedRawEvent[];
  statusMessage: string;
}

class ActionRecorderService {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private mainPage: Page | null = null;
  private active = false;
  private finishedByBrowserHud = false;
  private targetUrl = "";
  private slug = "";
  private events: RecordedRawEvent[] = [];
  private initialStorageState: any = null;
  private statusMessage = "대기 중";
  private eventListeners = new Set<(status: RecorderSessionStatus) => void>();

  public getActivePage(): Page | null {
    if (!this.context) return null;
    const pages = this.context.pages().filter((p) => !p.isClosed());
    return pages.length > 0 ? pages[pages.length - 1] : null;
  }

  public getStatus(): RecorderSessionStatus {
    return {
      active: this.active,
      finishedByBrowserHud: this.finishedByBrowserHud,
      targetUrl: this.targetUrl,
      eventsCount: this.events.length,
      events: [...this.events],
      statusMessage: this.statusMessage,
    };
  }

  public onStatusChange(listener: (status: RecorderSessionStatus) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  private notifyListeners() {
    const snap = this.getStatus();
    for (const listener of this.eventListeners) {
      try {
        listener(snap);
      } catch {}
    }
  }

  private recordRawEvent(raw: Omit<RecordedRawEvent, "seq" | "timestamp">) {
    const now = Date.now();
    const last = this.events[this.events.length - 1];

    if (last) {
      // If a dragAndDrop event arrives and the immediately preceding event was a click on the EXACT SAME drag source element,
      // upgrade that click into the dragAndDrop so the drag start isn't mistakenly logged as an extra click.
      // NEVER overwrite a preceding click on a different element (e.g. clicking [합의] button right before dragging test002)!
      if (
        raw.kind === "dragAndDrop" &&
        last.kind === "click" &&
        (last.selector === raw.sourceSelector || last.selector === raw.selector)
      ) {
        last.kind = "dragAndDrop";
        last.selector = raw.selector;
        last.sourceSelector = raw.sourceSelector;
        last.targetSelector = raw.targetSelector;
        last.targetHtml = raw.targetHtml;
        last.label = raw.label;
        last.timestamp = now;
        this.statusMessage = `✊ 드래그앤드롭 #${last.seq}: ${raw.label}`;
        console.log(
          `[Live Action Recorder] ${this.statusMessage} -> source: ${raw.sourceSelector} | target: ${raw.targetSelector}`
        );
        this.notifyListeners();
        return;
      }

      // Ignore any stray click immediately after a dragAndDrop (within 600ms)
      if (raw.kind === "click" && last.kind === "dragAndDrop" && now - last.timestamp < 600) {
        return;
      }

      // If user clicked an input field or rich text editor and immediately typed into the same field,
      // upgrade the preceding click into the type event so we don't have redundant click + type
      const lastPrimarySel = (last.selector || "").split(",")[0].trim();
      const rawPrimarySel = (raw.selector || "").split(",")[0].trim();
      const isSameField =
        last.selector === raw.selector ||
        (lastPrimarySel && lastPrimarySel === rawPrimarySel) ||
        (last.label && last.label === raw.label);

      if (
        raw.kind === "type" &&
        last.kind === "click" &&
        isSameField &&
        (last.tagName === "input" ||
          last.tagName === "textarea" ||
          last.tagName === "body" ||
          last.selector.includes("se-contents") ||
          last.selector.includes("contenteditable"))
      ) {
        last.kind = "type";
        last.selector = raw.selector;
        last.text = raw.text;
        last.pressEnter = raw.pressEnter;
        last.editorParaIndex = raw.editorParaIndex;
        last.editorInsertNewline = raw.editorInsertNewline;
        last.cursorOffset = raw.cursorOffset ?? last.cursorOffset;
        last.targetHtml = raw.targetHtml || last.targetHtml;
        last.label = raw.label;
        last.timestamp = now;
        const previewTxt = raw.text ? `"${raw.text.replace(/\n/g, "↵")}"` : "⌫ 내용 지우기";
        this.statusMessage = `⌨️ 입력 감지: ${previewTxt}${raw.pressEnter ? " + ⏎엔터" : ""} (${raw.label})`;
        this.notifyListeners();
        return;
      }

      // If multiple type events on the same selector & paragraph happen consecutively (and the previous one was NOT already submitted via Enter), update with the latest final text
      const isSameEditorPara = (last.editorParaIndex ?? -1) === (raw.editorParaIndex ?? -1);
      if (raw.kind === "type" && last.kind === "type" && isSameField && isSameEditorPara && !last.pressEnter) {
        last.selector = raw.selector;
        last.text = raw.text;
        last.pressEnter = raw.pressEnter;
        last.editorParaIndex = raw.editorParaIndex;
        last.editorInsertNewline = raw.editorInsertNewline;
        last.cursorOffset = raw.cursorOffset ?? last.cursorOffset;
        last.label = raw.label;
        last.timestamp = now;
        const previewTxt = raw.text ? `"${raw.text.replace(/\n/g, "↵")}"` : "⌫ 내용 지우기";
        this.statusMessage = `⌨️ 입력 갱신: ${previewTxt}${raw.pressEnter ? " + ⏎엔터" : ""} (${raw.label})`;
        this.notifyListeners();
        return;
      }

      // If multiple hover events happen consecutively (e.g. moving across cards or dwell hover followed by click-triggered hover on same card),
      // keep only the latest hover target so we never create duplicate or stray hover steps
      if (raw.kind === "hover" && last.kind === "hover") {
        last.selector = raw.selector;
        last.targetHtml = raw.targetHtml;
        last.iframe = raw.iframe;
        last.label = raw.label;
        last.timestamp = now;
        this.statusMessage = `🖱️ 호버 #${last.seq}: ${raw.label}`;
        this.notifyListeners();
        return;
      }

      // If user clicked a <select> dropdown and then selected an option (firing change with raw.text),
      // upgrade the preceding bare click on the same <select> into the option-selection event
      if (
        raw.kind === "click" &&
        raw.tagName === "select" &&
        raw.text &&
        last.kind === "click" &&
        last.tagName === "select" &&
        last.selector === raw.selector
      ) {
        last.text = raw.text;
        last.label = raw.label;
        last.timestamp = now;
        this.statusMessage = `💧 선택 #${last.seq}: ${raw.label}`;
        console.log(`[Live Action Recorder] ${this.statusMessage} -> ${last.selector}`);
        this.notifyListeners();
        return;
      }

      // If user clicked a file-upload button ([파일 선택], [내 PC], [파일첨부], etc.) and selected a file in the OS dialog,
      // upgrade the preceding click on that button into the "upload" event so the visible button selector & file path are unified!
      if (
        raw.kind === "upload" &&
        last.kind === "click" &&
        (last.selector === raw.selector ||
          (raw.selector && raw.selector.includes(last.selector.split(",")[0].trim())) ||
          /파일|첨부|file|atch|내\s*PC|찾아보기|업로드|사진|이미지|표지|불러오기/i.test(
            `${last.label || ""} ${last.selector || ""} ${last.targetHtml || ""}`
          ))
      ) {
        const mergedParts = Array.from(
          new Set(
            [
              ...last.selector.split(",").map((s) => s.trim()),
              ...(raw.selector || "").split(",").map((s) => s.trim()),
            ].filter(Boolean)
          )
        );
        last.kind = "upload";
        last.selector = mergedParts.join(", ");
        last.filePath = raw.filePath;
        last.text = raw.text;
        last.targetHtml = last.targetHtml || raw.targetHtml;
        const baseBtnLabel = (last.label || raw.label || "'파일 선택' 버튼").replace(/\s*클릭$/, "");
        last.label = `${baseBtnLabel}에 '${raw.text || "첨부파일"}' 첨부`;
        last.timestamp = now;
        this.statusMessage = `📎 파일 첨부 #${last.seq}: ${last.label}`;
        console.log(`[Live Action Recorder] ${this.statusMessage} -> ${last.selector} (file: ${last.filePath})`);
        this.notifyListeners();
        return;
      }

      // Ignore accidental double-fire on the exact same click selector within 300ms,
      // OR browser's native <label> -> <input type="checkbox"|"radio"> synthetic second click within 300ms
      if (
        raw.kind === "click" &&
        last.kind === "click" &&
        now - last.timestamp < 300 &&
        (last.selector === raw.selector ||
          (last.tagName === "label" && raw.tagName === "input"))
      ) {
        return;
      }
    }

    const evt: RecordedRawEvent = {
      ...raw,
      seq: this.events.length + 1,
      timestamp: now,
    };
    this.events.push(evt);

    const icon =
      evt.kind === "click"
        ? "💧 클릭"
        : evt.kind === "hover"
        ? "🖱️ 호버"
        : evt.kind === "type"
        ? "⌨️ 입력"
        : evt.kind === "dragAndDrop"
        ? "✊ 드래그앤드롭"
        : evt.kind === "upload"
        ? "📎 파일 첨부"
        : "🖱️ 동작";
    const typeSuffix =
      evt.kind === "type"
        ? ` (${evt.text ? `'${evt.text.replace(/\n/g, "↵")}'` : "⌫ 내용 지우기"}${evt.pressEnter ? " + ⏎엔터" : ""})`
        : evt.kind === "upload"
        ? evt.text && !evt.label.includes(evt.text)
          ? ` ('${evt.text}')`
          : ""
        : evt.text
        ? ` ('${evt.text}')`
        : "";
    this.statusMessage = `${icon} #${evt.seq}: ${evt.label}${typeSuffix}`;
    console.log(`[Live Action Recorder] ${this.statusMessage} -> ${evt.selector}${evt.iframe ? ` [iframe: ${evt.iframe}]` : ""}`);
    this.notifyListeners();
  }

  /**
   * Starts an interactive Headed Chromium browser with Eyedropper highlight & live DOM action capture.
   */
  public async startRecordingSession(options?: {
    url?: string;
    slug?: string;
    headless?: boolean;
  }): Promise<RecorderSessionStatus> {
    if (this.active) {
      await this.stopRecordingSession(false);
    }

    const config = getConfig();
    const rawUrl = (options?.url || config.targetBaseUrl || "http://gwdev.apple21.co.kr/").trim();
    const normalizedUrl = normalizeTargetUrl(rawUrl);

    let entryUrl = normalizedUrl;
    try {
      const u = new URL(normalizedUrl);
      if (u.pathname === "" || u.pathname === "/") {
        entryUrl = new URL("/ekp/main/home/homGwMain", normalizedUrl).toString();
      }
    } catch {}

    this.targetUrl = entryUrl;
    this.slug = options?.slug || "";
    this.events = [];
    this.active = true;
    this.finishedByBrowserHud = false;
    this.statusMessage = "🌐 브라우저 시범 창을 여는 중입니다...";
    this.notifyListeners();

    const existingAuth = findExistingAuthSession(this.slug || undefined);
    const hasValidAuth = existingAuth && fs.existsSync(existingAuth);

    const isHeadless = Boolean(options?.headless);
    this.browser = await chromium.launch({
      headless: isHeadless,
      args: ["--start-maximized", "--disable-blink-features=AutomationControlled"],
    });

    // Use viewport: null so the headed browser uses the real window dimensions (respecting OS DPI scaling & taskbar)
    // and never clips the bottom-right [시범 완료] HUD bar off-screen on the main window.
    this.context = await this.browser.newContext({
      viewport: isHeadless ? { width: 1920, height: 1080 } : null,
      storageState: hasValidAuth ? existingAuth! : undefined,
    });

    // Auto-accept any native JS alert/confirm during user demonstration so it never blocks
    const injectedScriptContent = getInjectedEyedropperScript();
    try {
      new Function(injectedScriptContent);
    } catch (syntaxErr: any) {
      console.error(`[Live Action Recorder] CRITICAL: Injected script syntax error:`, syntaxErr);
      throw syntaxErr;
    }
    this.context.on("page", (p) => {
      p.on("dialog", async (dialog) => {
        console.log(`[Live Action Recorder] 브라우저 알림창 자동 수락: "${dialog.message()}"`);
        await dialog.accept().catch(() => {});
      });
      p.on("framenavigated", (frame) => {
        frame.evaluate(injectedScriptContent).catch(() => {});
      });
    });

    // Expose Node bindings to all frames (main page + iframes + popups)
    await this.context.exposeBinding(
      "__screenDemoRecordAction",
      (source, payload: Omit<RecordedRawEvent, "seq" | "timestamp">) => {
        if (!this.active || !payload) return;
        try {
          if (source?.frame && source?.page && source.frame !== source.page.mainFrame()) {
            const fName = source.frame.name();
            if (fName && (!payload.iframe || payload.iframe.includes(","))) {
              payload.iframe = `iframe[name='${fName}'], iframe#${fName}, ${payload.iframe || "iframe"}`;
            }
          }
        } catch {}
        this.recordRawEvent(payload);
      }
    );

    await this.context.exposeBinding(
      "__screenDemoSaveUploadedFile",
      async (
        _source,
        filePayload: { name: string; size?: number; type?: string; base64?: string }
      ): Promise<string> => {
        try {
          const rawName = (filePayload?.name || "attachment.txt").trim();
          const safeName = path.basename(rawName).replace(/[<>:"/\\|?*]/g, "_") || "attachment.txt";
          const sharedUploadsDir = path.resolve(process.cwd(), "data", "_uploads");
          fs.mkdirSync(sharedUploadsDir, { recursive: true });
          const sharedDest = path.join(sharedUploadsDir, safeName);
          if (filePayload?.base64) {
            fs.writeFileSync(sharedDest, Buffer.from(filePayload.base64, "base64"));
          } else if (!fs.existsSync(sharedDest)) {
            fs.writeFileSync(sharedDest, `첨부 파일 (${safeName})\n`, "utf-8");
          }
          if (this.slug) {
            const slugUploadsDir = path.resolve(process.cwd(), "data", this.slug, "uploads");
            fs.mkdirSync(slugUploadsDir, { recursive: true });
            const slugDest = path.join(slugUploadsDir, safeName);
            fs.copyFileSync(sharedDest, slugDest);
            return `data/${this.slug}/uploads/${safeName}`;
          }
          return `data/_uploads/${safeName}`;
        } catch (err: any) {
          console.warn(`[Live Action Recorder] 업로드 파일 저장 경고: ${err.message}`);
          return filePayload?.name || "attachment.txt";
        }
      }
    );

    await this.context.exposeBinding("__screenDemoFinishSession", async (source, mode?: string) => {
      if (!this.active) return;
      const callerPage = source?.page;
      const isChildPopupPage = Boolean(
        callerPage &&
        this.mainPage &&
        callerPage !== this.mainPage &&
        !this.mainPage.isClosed()
      );

      // If the user clicked the HUD button inside a child popup window (while the main window is still open),
      // close ONLY the popup window and return focus to the main window so they can continue the scenario!
      if ((mode === "close_popup" || isChildPopupPage) && mode !== "force_finish" && callerPage) {
        console.log(`[Live Action Recorder] 팝업 창에서 완료/닫기 버튼 클릭 감지 -> 팝업 창만 닫고 부모 메인 창으로 시범을 이어갑니다.`);
        await callerPage
          .evaluate(() => {
            const w = window as any;
            if (w.top && Array.isArray(w.top.__sdFlushCallbacks)) {
              for (const fn of w.top.__sdFlushCallbacks) {
                try {
                  fn();
                } catch {}
              }
            }
            window.onbeforeunload = null;
          })
          .catch(() => {});
        await callerPage.close().catch(() => {});
        if (this.mainPage && !this.mainPage.isClosed()) {
          await this.mainPage.bringToFront().catch(() => {});
        }
        this.statusMessage = "🪟 팝업 창을 닫고 부모 창으로 복귀했습니다. 부모 창에서 후속 시범을 진행한 뒤 우측 하단 [✅ 시범 완료]를 눌러주세요.";
        this.notifyListeners();
        return;
      }

      console.log(`[Live Action Recorder] 사용자가 메인 브라우저 HUD에서 [시범 완료] 버튼을 클릭했습니다.`);
      this.finishedByBrowserHud = true;
      this.notifyListeners();
      await this.stopRecordingSession(true);
    });

    // Inject Eyedropper + Action Listener into every frame (top window + nested iframes)
    await this.context.addInitScript({
      content: injectedScriptContent,
    });

    const page = await this.context.newPage();
    this.mainPage = page;

    // Belt-and-suspenders: also ensure script is injected on every frame navigation / dynamic iframe load
    page.on("framenavigated", (frame) => {
      frame.evaluate(injectedScriptContent).catch(() => {});
    });

    page.on("close", async () => {
      if (this.active) {
        console.log(`[Live Action Recorder] 브라우저 창이 닫혔습니다. 캡처된 동작으로 시범을 완료합니다.`);
        this.finishedByBrowserHud = true;
        this.notifyListeners();
        await this.stopRecordingSession(false);
      }
    });

    await page.goto(this.targetUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch((e) => {
      console.warn(`[Live Action Recorder] 초기 URL 로드 경고: ${e.message}`);
    });
    await page.evaluate(injectedScriptContent).catch(() => {});

    // Snapshot initial logged-in storageState so if the demonstration includes a logout/account switch,
    // we preserve the starting account's session for replay!
    this.initialStorageState = null;
    try {
      const curUrl = page.url().toLowerCase();
      const hasLoginInput = await page.locator("input#userId:visible, input[name='userId']:visible").first().isVisible().catch(() => false);
      if (!/login|signin|userlogin|oauth/i.test(curUrl) && !hasLoginInput) {
        this.initialStorageState = await this.context.storageState();
      }
    } catch {}

    this.statusMessage = "💧 브라우저에서 원하는 동작(클릭·입력·드래그)을 시범 보여주세요!";
    this.notifyListeners();
    return this.getStatus();
  }

  /**
   * Stops the live recording session, saves updated auth cookies, closes the browser,
   * and refines the captured events into a clean BrowsePlan + canonical prompt.
   */
  public async stopAndBuildScenario(options?: {
    customTitleHint?: string;
    slug?: string;
    directingStyle?: "standard" | "fast" | "detailed";
  }): Promise<{
    events: RecordedRawEvent[];
    plan: BrowsePlan;
    suggestedSlug: string;
    canonicalPrompt: string;
    explanation: string;
  }> {
    const capturedEvents = this.active ? await this.stopRecordingSession(true) : [...this.events];
    this.finishedByBrowserHud = false;
    const targetBaseUrl = this.targetUrl || getConfig().targetBaseUrl || "http://gwdev.apple21.co.kr/";

    // If the user started the Eyedropper while their session was expired (no prior logout)
    // and logged in at the very beginning before demonstrating post-login groupware actions,
    // strip the leading session-recovery login events because stopRecordingSession(true) already saved the fresh logged-in auth.json!
    const hadLogout = capturedEvents.some((e) =>
      /로그아웃|btn_logout|goLogout|topMenu_logon/i.test(
        `${e.label || ""} ${e.selector || ""} ${e.targetHtml || ""}`
      )
    );
    let effectiveEvents = capturedEvents;
    if (!hadLogout && capturedEvents.length > 0) {
      const isInitialLoginEvent = (e: RecordedRawEvent) =>
        /#userId|name=['"]userId['"]|#password|type=['"]password['"]|#btnLogin|btn_login/i.test(
          `${e.selector || ""} ${e.targetHtml || ""} ${e.label || ""}`
        ) || Boolean(e.pageUrl && /login|signin|userlogin/i.test(e.pageUrl));
      if (isInitialLoginEvent(capturedEvents[0])) {
        let firstPostLoginIdx = 0;
        while (firstPostLoginIdx < capturedEvents.length && isInitialLoginEvent(capturedEvents[firstPostLoginIdx])) {
          firstPostLoginIdx++;
        }
        if (firstPostLoginIdx > 0 && firstPostLoginIdx < capturedEvents.length) {
          console.log(
            `[Live Action Recorder] 초기 세션 만료로 인한 로그인 단계(${firstPostLoginIdx}개)를 최신 세션(auth.json)으로 병합하고 본 시나리오 동작부터 플랜을 구성합니다.`
          );
          effectiveEvents = capturedEvents.slice(firstPostLoginIdx);
        }
      }
    }

    const refined = await refineRecordedEventsIntoPlan(
      effectiveEvents,
      targetBaseUrl,
      options?.customTitleHint,
      options?.slug || this.slug,
      options?.directingStyle
    );

    // Ensure any uploaded files are also copied into data/<suggestedSlug>/uploads/ so the scenario folder is self-contained
    if (refined.suggestedSlug) {
      for (const act of refined.plan.actions) {
        if (act.type === "upload" && act.filePath) {
          const updatedPaths: string[] = [];
          for (const rawP of act.filePath.split("|").map((s) => s.trim()).filter(Boolean)) {
            const baseName = path.basename(rawP);
            const srcAbs = path.isAbsolute(rawP) ? rawP : path.resolve(process.cwd(), rawP);
            const sharedFallback = path.resolve(process.cwd(), "data", "_uploads", baseName);
            const destDir = path.resolve(process.cwd(), "data", refined.suggestedSlug, "uploads");
            const destAbs = path.join(destDir, baseName);
            try {
              fs.mkdirSync(destDir, { recursive: true });
              if (fs.existsSync(srcAbs) && srcAbs !== destAbs) {
                fs.copyFileSync(srcAbs, destAbs);
                updatedPaths.push(`data/${refined.suggestedSlug}/uploads/${baseName}`);
              } else if (fs.existsSync(sharedFallback) && sharedFallback !== destAbs) {
                fs.copyFileSync(sharedFallback, destAbs);
                updatedPaths.push(`data/${refined.suggestedSlug}/uploads/${baseName}`);
              } else {
                updatedPaths.push(rawP);
              }
            } catch {
              updatedPaths.push(rawP);
            }
          }
          if (updatedPaths.length > 0) {
            act.filePath = updatedPaths.join("|");
          }
        }
      }
    }

    return {
      events: effectiveEvents,
      ...refined,
    };
  }

  public async stopRecordingSession(saveAuth = true): Promise<RecordedRawEvent[]> {
    if (this.active && this.context) {
      for (const p of this.context.pages()) {
        if (!p.isClosed()) {
          await p
            .evaluate(() => {
              const w = window as any;
              if (w.top && Array.isArray(w.top.__sdFlushCallbacks)) {
                for (const fn of w.top.__sdFlushCallbacks) {
                  try {
                    fn();
                  } catch {}
                }
              }
            })
            .catch(() => {});
        }
      }
    }
    const captured = [...this.events];
    this.active = false;
    this.statusMessage = `✅ 총 ${captured.length}개 동작 캡처 완료. 시나리오 정제 대기 중...`;

    if (saveAuth && this.context) {
      try {
        const authPath = getAuthFilePath(this.slug || undefined);
        const hadLogout = captured.some((e) =>
          /로그아웃|btn_logout|goLogout|topMenu_logon/i.test(
            `${e.label || ""} ${e.selector || ""} ${e.targetHtml || ""}`
          )
        );
        if (hadLogout && this.initialStorageState) {
          fs.writeFileSync(authPath, JSON.stringify(this.initialStorageState, null, 2), "utf-8");
          syncAuthSession(authPath);
        } else {
          await this.context.storageState({ path: authPath });
          syncAuthSession(authPath);
        }
      } catch {}
    }

    await this.cleanupBrowser();
    return captured;
  }

  private async cleanupBrowser() {
    this.active = false;
    this.mainPage = null;
    if (this.context) {
      await this.context.close().catch(() => {});
      this.context = null;
    }
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }
    this.notifyListeners();
  }
}

export const actionRecorderService = new ActionRecorderService();

/**
 * Browser-side script injected into top window and all iframes.
 * Provides:
 * 1. Visual Eyedropper hover highlight box + tag/selector badge
 * 2. Floating HUD controller bar in the top window
 * 3. Precision DOM selector + iframe path extraction for click, type, dragAndDrop, select
 */
export function getInjectedEyedropperScript(): string {
  return `
(function() {
  if (window.__sdEyedropperInstalled) return;
  window.__sdEyedropperInstalled = true;

  const isTopWindow = (window === window.top);
  let eyedropperHighlightEnabled = true;
  let lastTypedElement = null;
  let lastTypedValue = "";
  let lastTypedHadDeletion = false;
  let lastTypedPressEnter = false;
  let lastFlushedElement = null;
  let lastFlushedValue = "";
  let lastFlushedTime = 0;
  let lastEditorBaselineElement = null;
  let lastEditorBaselineParas = null;
  let lastEditorClickedParaIndex = undefined;
  let lastEditorClickOffset = undefined;
  let dragSourceInfo = null;

  // Determine iframe selector if running inside an iframe
  function getCurrentIframeSelector() {
    if (isTopWindow) return undefined;
    try {
      const fe = window.frameElement;
      if (!fe) return "iframe[name='setup_iframe'], iframe#subBody, iframe#contentFrame, iframe";
      if (fe.id) return "iframe#" + fe.id;
      if (fe.getAttribute("name")) return "iframe[name='" + fe.getAttribute("name") + "']";
      return "iframe[name='setup_iframe'], iframe#subBody, iframe#contentFrame, iframe";
    } catch (e) {
      return "iframe[name='setup_iframe'], iframe#subBody, iframe#contentFrame, iframe";
    }
  }

  // Check if an ID looks auto-generated / unstable (e.g. ui-id-14, jqg123, ext-gen102) or is duplicated across multiple visible elements
  function isStableId(id) {
    if (!id || typeof id !== "string") return false;
    if (/^(ui-id-|jqg|ext-gen|select2-|mceu_|cke_|tinymce|th\\d+$|dp\\d+$|ADRGR\\d+$)/i.test(id)) return false;
    if (/^[0-9]+$/.test(id)) return false;
    // Long random hex/uuid suffix
    if (/[0-9a-f]{8,}/i.test(id)) return false;
    try {
      const allSameId = Array.from(document.querySelectorAll("[id='" + id.replace(/'/g, "\\\\'") + "']"));
      if (allSameId.length > 1) {
        const visibleSameId = allSameId.filter(function(node) {
          const r = node.getBoundingClientRect ? node.getBoundingClientRect() : { width: 0, height: 0 };
          return r.width > 0 && r.height > 0;
        });
        if (visibleSameId.length > 1) {
          return false;
        }
      }
    } catch (e) {}
    return true;
  }

  // Clean visible text of an element (with fallbacks for human-readable descriptions)
  function getCleanText(el) {
    if (!el) return "";
    if (el.classList && (el.classList.contains("btn_ico") || el.classList.contains("btn_logout")) && el.getAttribute) {
      const icoTitle = (el.getAttribute("title") || "").trim();
      if (icoTitle) return icoTitle.replace(/\\s+/g, " ").slice(0, 40);
    }
    const raw = (el.innerText || el.textContent || el.value || el.getAttribute("title") || el.getAttribute("placeholder") || el.getAttribute("alt") || "").trim();
    return raw.replace(/\\s+/g, " ").slice(0, 40);
  }

  // Strictly visible DOM text for Playwright :has-text / :text-is selectors (excludes title/placeholder/alt and hidden/blind/0px child spans on icon buttons like a.btn_logout)
  function getVisibleDomText(el) {
    if (!el || !el.tagName) return "";
    const tName = el.tagName.toLowerCase();
    if (tName === "input" || tName === "textarea" || tName === "select") return "";
    if (el.classList && (el.classList.contains("btn_logout") || el.classList.contains("btn_ico") || el.classList.contains("ico"))) {
      return "";
    }
    try {
      const st = window.getComputedStyle(el);
      if (
        st &&
        (st.display === "none" ||
          st.visibility === "hidden" ||
          st.fontSize === "0px" ||
          parseInt(st.textIndent || "0", 10) < -99)
      ) {
        return "";
      }
      if (el.childNodes && el.childNodes.length > 0) {
        const parts = [];
        for (let i = 0; i < el.childNodes.length; i++) {
          const node = el.childNodes[i];
          if (node.nodeType === 3) {
            const nt = (node.nodeValue || "").trim();
            if (nt) parts.push(nt);
          } else if (node.nodeType === 1) {
            const ch = node;
            if (ch.classList && (ch.classList.contains("hide") || ch.classList.contains("blind") || ch.classList.contains("sr_only"))) {
              continue;
            }
            const cst = window.getComputedStyle(ch);
            const cr = ch.getBoundingClientRect ? ch.getBoundingClientRect() : { width: 10, height: 10 };
            if (
              cst &&
              (cst.display === "none" ||
                cst.visibility === "hidden" ||
                cst.opacity === "0" ||
                cst.fontSize === "0px" ||
                parseInt(cst.textIndent || "0", 10) < -99 ||
                cr.width <= 1 ||
                cr.height <= 1)
            ) {
              continue;
            }
            const ct = (ch.innerText || "").trim();
            if (ct) parts.push(ct);
          }
        }
        return parts.join(" ").replace(/\\s+/g, " ").trim().slice(0, 40);
      }
      return (el.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 40);
    } catch (e) {
      return (el.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 40);
    }
  }

  // Find nearest interactive element (button, a, input, textarea, select, label, tree node, work card, custom dropdown, rich editor, etc.)
  function resolveInteractiveElement(target) {
    if (!target || !target.closest) return target;
    const editorSurface = target.closest(
      "div.se-contents, [role='textbox'].se-contents, [contenteditable='true']"
    );
    if (editorSurface) return editorSurface;
    if (target.classList && target.classList.contains("se-ime")) {
      const seRoot = target.closest(".se-main, .se-container, .editor_area, td, body") || document;
      const seCanvas = seRoot.querySelector && seRoot.querySelector("div.se-contents, [role='textbox'].se-contents");
      if (seCanvas) return seCanvas;
    }
    // 0. If target is inside a jQuery FileUpload / custom file button wrapper (.fileinput-button, .btn_file),
    // resolve to the visible wrapper button rather than the transparent <input type="file" style="opacity:0"> overlay!
    const fileBtnWrapper = target.closest(".fileinput-button, .btn_file, label.file_btn, label.btn_file");
    if (fileBtnWrapper) return fileBtnWrapper;
    if (
      target.tagName &&
      target.tagName.toLowerCase() === "input" &&
      (target.getAttribute("type") || "").toLowerCase() === "file"
    ) {
      const btnParent = target.closest("button, a.btn, span.btn, label.btn, label");
      if (btnParent) return btnParent;
    }

    // 1. True atomic interactive controls (prioritized BEFORE table cells th/td so custom widgets inside cells are never swallowed!)
    const primaryInteractive = target.closest(
      "button, a, input, textarea, select, label, .dynatree-title, .dynatree-checkbox, .dynatree-expander, .fancytree-title, .fancytree-checkbox, .fancytree-expander, [role='button'], [role='tab'], [role='menuitem'], [role='option'], [onclick], .Selected, .select_Value, .sp-replacer, .app_work_box, li.aw_li, li.card_item"
    );
    if (primaryInteractive) return primaryInteractive;

    // 2. Check if target or a compact ancestor (within 3 levels, stopping before tr/td/table/body) is a clickable custom widget (cursor: pointer or _hook class)
    let cur = target;
    let depth = 0;
    while (cur && cur !== document.body && depth < 3) {
      const cTag = (cur.tagName || "").toLowerCase();
      if (cTag === "tr" || cTag === "td" || cTag === "th" || cTag === "table" || cTag === "tbody") break;
      const hasHookCls =
        cur.classList &&
        Array.from(cur.classList).some(function(c) {
          return /^_[a-zA-Z0-9_-]+$/.test(c) || /^(btn|ico|tab|swatch|plt_|scvr)/i.test(c);
        });
      if (hasHookCls) return cur;
      try {
        const rect = cur.getBoundingClientRect ? cur.getBoundingClientRect() : null;
        if (rect && rect.width > 0 && rect.width <= 320 && rect.height > 0 && rect.height <= 120) {
          const style = window.getComputedStyle ? window.getComputedStyle(cur) : null;
          if (style && style.cursor === "pointer") {
            return cur;
          }
        }
      } catch (e) {}
      cur = cur.parentElement;
      depth++;
    }

    const fallbackCell = target.closest("tr.lst_tr, th, td");
    return fallbackCell || target;
  }

  // Extract concise HTML snippet of the target element (opening tag + child input/cover/id + text + closing tag)
  function extractTargetHtml(rawEl) {
    const el = resolveInteractiveElement(rawEl);
    if (!el || !el.outerHTML) return "";
    const raw = el.outerHTML
      .replace(/\\s+/g, " ")
      .replace(/\\sstyle="[^"]{60,}"/gi, "")
      .replace(/\\s(?:oldtitle|data-original-title|data-qtip|aria-describedby)="[^"]*"/gi, "")
      .trim();
    if (raw.length <= 420) return raw;
    const openTagMatch = raw.match(/^<[^>]+>/);
    let openTag = "<" + (el.tagName || "el").toLowerCase() + ">";
    if (openTagMatch) {
      if (openTagMatch[0].length <= 360) {
        openTag = openTagMatch[0];
      } else {
        const slicedOpen = openTagMatch[0]
          .slice(0, 360)
          .replace(/\\s+[a-zA-Z0-9_:-]+=["'][^"']*$/, "")
          .replace(/\\s+[a-zA-Z0-9_:-]+=?$/, "");
        openTag = slicedOpen + ">";
      }
    }
    let childMeta = "";
    try {
      const innerSlice = raw.slice(openTag.length);
      const innerInputMatch = innerSlice.match(/<input\\b[^>]*>/i);
      if (innerInputMatch && innerInputMatch[0].length <= 160) {
        childMeta += innerInputMatch[0];
      }
      const innerCoverMatch = innerSlice.match(/<(?:div|span|i)\\b[^>]*class=["'][^"']*\\b(?:scvr\\d+|plt_\\d+|ico_[a-zA-Z0-9_]+)\\b[^"']*["'][^>]*>/i);
      if (innerCoverMatch && innerCoverMatch[0].length <= 120) {
        childMeta += innerCoverMatch[0];
      }
      const innerIdMatch = innerSlice.match(/<(?!input\\b)[a-zA-Z0-9]+\\b[^>]*\\bid=["'][^"']+["'][^>]*>/i);
      if (innerIdMatch && innerIdMatch[0].length <= 140 && !childMeta.includes(innerIdMatch[0])) {
        childMeta += innerIdMatch[0];
      }
    } catch (e) {}
    const txt = getCleanText(el).slice(0, 35);
    return openTag + childMeta + txt + "</" + (el.tagName || "el").toLowerCase() + ">";
  }

  // Filter meaningful CSS classes on an element (ignoring transient hover/active/jQuery/Dynatree/Select2 state classes and numeric-leading classes)
  function getMeaningfulClasses(el, maxCount) {
    if (!el || !el.classList || el.classList.length === 0) return [];
    const filtered = Array.from(el.classList).filter(function(c) {
      return (
        c &&
        /^[a-zA-Z_-][a-zA-Z0-9_-]*$/.test(c) &&
        !/^(active|selected|on|hover|focus|open|opened|closed|collapsed|expanded|disabled|checked|chkbox_on|rdobtn_on|ico_chk_on|_punchHandle|_search_option_hide|_blind|_hide|_hidden)$/i.test(c) &&
        !/^(ui-state-|ui-corner-|ui-widget|ui-draggable|ui-droppable|ui-sortable|select2-(focused|active|dropdown-open|container-active|drop-above)|dynatree-(focused|active|selected|expanded|has-children|folder|lastsib|partsel|loading|statusnode|exp-|ico-)|fancytree-(focused|active|selected|expanded|has-children|folder|lastsib|partsel|loading|statusnode|exp-|ico-))/i.test(c)
      );
    });
    // Keep semantic component classes (e.g. dynatree-title, user_info, chkbox, sub) and action hook classes ahead of generic layout/button classes (btn, btn_ico, etc.)
    const genericPattern = /^(btn|btn_ico|btn_pri|btn_med|btn_sml|btn_lar|btn_block|btn_tp\\d*|input_txt|frm_txt|frm_select|fl|fr|al|ar|ac|mgl|mgr|mgt|mgb|pdl|pdr)$/i;
    filtered.sort(function(a, b) {
      const aScore = genericPattern.test(a) ? 1 : 0;
      const bScore = genericPattern.test(b) ? 1 : 0;
      return aScore - bScore;
    });
    return filtered.slice(0, maxCount || 3);
  }

  // Build exact DOM structural path from nearest stable #id ancestor (or modal root) down to el
  function buildExactDomPathSelector(el, modalEl) {
    if (!el || !el.tagName || el === document.body || el === document.documentElement) return "";

    const parts = [];
    let cur = el;
    let depth = 0;
    let anchoredById = false;

    while (cur && cur !== document.body && cur !== document.documentElement && depth < 6) {
      const curTag = cur.tagName.toLowerCase();
      const curId = cur.getAttribute("id") || "";

      if (isStableId(curId)) {
        parts.unshift(curTag + "#" + curId);
        anchoredById = true;
        break;
      }

      // Stop if we reached the modal root container
      if (modalEl && cur === modalEl) {
        break;
      }

      const clsList = getMeaningfulClasses(cur, 3);
      let step = curTag + (clsList.length > 0 ? "." + clsList.join(".") : "");

      // If element has a numeric class token (e.g., <dd class="1400"> timetable slot), use valid CSS [class~='1400'] attribute selector
      if (cur.classList && cur.classList.length > 0) {
        const numCls = Array.from(cur.classList).find(function(c) {
          return /^[0-9][a-zA-Z0-9_-]*$/.test(c);
        });
        if (numCls) {
          step += "[class~='" + numCls + "']";
        }
      }

      // Check data-* attributes on cur if it has a distinguishing attribute
      const dataAttrs = ["data-app-type-se", "data-app-type-id", "data-app-type-ordr", "data-tab", "data-book-name", "data-menu-id", "data-menu-name", "data-work-id", "data-res-id", "data-dept-id", "data-emp-id", "data-cmp-id", "data-cal-id", "data-brd-id", "data-addr-grpname", "data-addr-grpid", "data-id", "data-key", "data-value", "data-trgt-id"];
      for (let i = 0; i < dataAttrs.length; i++) {
        const attrName = dataAttrs[i];
        const attrVal = cur.getAttribute(attrName);
        if (attrVal && attrVal.length <= 35 && !/['"\\\\]/.test(attrVal)) {
          step += "[" + attrName + "='" + attrVal + "']";
          break;
        }
      }

      // Disambiguate among same-tag siblings (and always scope dynatree-node / aw_li by title text even when filtered to 1 sibling)
      const parent = cur.parentElement;
      if (parent) {
        const sameTagSiblings = Array.from(parent.children).filter(function(ch) {
          return ch.tagName === cur.tagName;
        });
        const isDynatreeNode = cur.classList && cur.classList.contains("dynatree-node");
        const isWorkCardItem = cur.classList && cur.classList.contains("aw_li");
        const titleNode = isDynatreeNode
          ? cur.querySelector(".dynatree-title")
          : isWorkCardItem
            ? cur.querySelector(".tit_box strong.tit, strong.tit") || cur.querySelector(".tit")
            : null;
        const nodeTxt = titleNode ? getCleanText(titleNode).slice(0, 20).replace(/'/g, "") : "";
        if ((isDynatreeNode || isWorkCardItem) && nodeTxt) {
          step += ":has-text('" + nodeTxt + "')";
        } else if (sameTagSiblings.length > 1) {
          const nth = sameTagSiblings.indexOf(cur) + 1;
          if (nth > 0) {
            step += ":nth-of-type(" + nth + ")";
          }
        }
      }

      parts.unshift(step);
      cur = parent;
      depth++;
    }

    if (parts.length === 0) return "";
    const prefix = modalEl && !anchoredById ? ".ui-dialog:visible " : "";
    return prefix + parts.join(" > ") + ":visible";
  }

  // Extract HTML attribute-based selector directly from the element's HTML attributes
  function buildExactHtmlAttributeSelector(el, scopePrefix) {
    if (!el || !el.tagName) return [];
    const tag = el.tagName.toLowerCase();
    const results = [];

    // 1. Check distinguishing data-* attributes on the element itself (prioritize human-readable data-book-name / data-menu-id)
    const priorityDataAttrs = [
      "data-book-name",
      "data-menu-id",
      "data-menu-name",
      "data-app-type-se",
      "data-app-type-id",
      "data-app-type-ordr",
      "data-tab",
      "data-work-id",
      "data-res-id",
      "data-dept-id",
      "data-emp-id",
      "data-cmp-id",
      "data-cal-id",
      "data-brd-id",
      "data-trgt-id",
      "data-addr-grpname",
      "data-addr-grpid",
      "data-doc-id",
      "data-fld-id",
      "data-cl-id",
      "data-id",
      "data-key",
      "data-value",
      "data-role",
      "data-action",
      "data-type",
      "data-code"
    ];
    for (let i = 0; i < priorityDataAttrs.length; i++) {
      const attrName = priorityDataAttrs[i];
      const attrVal = el.getAttribute && el.getAttribute(attrName);
      if (attrVal && attrVal.toLowerCase() !== "empty" && attrVal.length <= 40 && !/['"\\\\=]|\\s{2,}/.test(attrVal)) {
        results.push(scopePrefix + tag + "[" + attrName + "='" + attrVal + "']:visible");
      }
    }

    // 1.5 Check underscore-prefixed JS action/hook classes ONLY on <button> or <input> (e.g. _eapSearchUIsearchBtn, _confirmBtn, _draftBtn)
    // Never emit bare underscore classes on <a>, <li>, <tr>, <div> (like _punchHandle on tree nodes or _doc on document rows) or multi-instance action buttons (_appendBtn, _writeBtn, _lineSelect)!
    if ((tag === "button" || tag === "input") && el.classList && el.classList.length > 0) {
      let ancestorIdEl = null;
      let ancestorIdPrefix = "";
      let p = el.parentElement;
      let d = 0;
      while (p && p !== document.body && d < 5) {
        const pid = p.getAttribute && p.getAttribute("id");
        if (pid && isStableId(pid) && !/^(body|wrap|layout|content|container|main)$/i.test(pid)) {
          ancestorIdEl = p;
          ancestorIdPrefix = p.tagName.toLowerCase() + "#" + pid + " ";
          break;
        }
        p = p.parentElement;
        d++;
      }
      const modalRoot = el.closest && el.closest(".ui-dialog, .modal, .layer_pop, [role='dialog']");
      for (let i = 0; i < el.classList.length; i++) {
        const cls = el.classList[i];
        if (
          cls &&
          /^_[a-zA-Z0-9_-]*(?:btn|button|search|srch|confirm|save|draft|send|write|ok|cancel|close|text|word)[a-zA-Z0-9_-]*$/i.test(cls) &&
          !/^_(?:search_option|blind|hide|hidden|punchHandle|appendBtn|writeBtn|lineSelect|addBtn|delBtn|selectBtn|setProcess|write)$/i.test(cls)
        ) {
          if (ancestorIdEl && ancestorIdPrefix) {
            try {
              const matchesInAncestor = ancestorIdEl.querySelectorAll(tag + "." + cls);
              if (matchesInAncestor.length === 1 && matchesInAncestor[0] === el) {
                results.push((modalRoot ? ".ui-dialog:visible " : "") + ancestorIdPrefix + tag + "." + cls + ":visible");
              }
            } catch (e) {}
          }
          try {
            const checkScope = modalRoot || document;
            const matchesInScope = checkScope.querySelectorAll(tag + "." + cls);
            if (matchesInScope.length === 1 && matchesInScope[0] === el) {
              results.push(scopePrefix + tag + "." + cls + ":visible");
            }
          } catch (e) {}
        }
      }
    }

    // 2. Check name / title / onclick / value attributes
    const nameAttr = el.getAttribute("name") || "";
    const valueAttr = el.getAttribute("value") || "";
    const typeAttr = (el.getAttribute("type") || "").toLowerCase();
    const isRadioOrCheckbox = tag === "input" && (typeAttr === "radio" || typeAttr === "checkbox");
    if (nameAttr && !/['"\\\\]/.test(nameAttr)) {
      if (isRadioOrCheckbox) {
        if (valueAttr && valueAttr.length <= 35 && !/['"\\\\]/.test(valueAttr) && !/^(on|true|false|y|n|1|0)$/i.test(valueAttr)) {
          results.push(scopePrefix + tag + "[name='" + nameAttr + "'][value='" + valueAttr + "']:visible");
        }
      } else {
        results.push(scopePrefix + tag + "[name='" + nameAttr + "']:visible");
      }
    }

    const titleAttr = (el.getAttribute("title") || "").trim();
    const meaningfulBtnClasses = getMeaningfulClasses(el, 2);
    const primaryBtnCls = meaningfulBtnClasses.length > 0 ? meaningfulBtnClasses[0] : "";
    if (
      titleAttr &&
      titleAttr.length >= 2 &&
      titleAttr.length <= 30 &&
      !/['"\\\\]/.test(titleAttr) &&
      !/^(선택|체크)$/i.test(titleAttr) &&
      !(el.classList && el.classList.contains("dynatree-title")) &&
      tag !== "input"
    ) {
      if (primaryBtnCls) {
        results.push(scopePrefix + tag + "." + primaryBtnCls + "[title='" + titleAttr + "']:visible");
      }
      results.push(scopePrefix + tag + "[title='" + titleAttr + "']:visible");
    }

    const onclickAttr = (el.getAttribute("onclick") || "").trim();
    if (onclickAttr) {
      const scrMatch = onclickAttr.match(/(\\/ekp\\/(?:scr|view)\\/[a-zA-Z0-9_\\/?=&.-]+)/i);
      if (scrMatch && scrMatch[1]) {
        results.push(scopePrefix + tag + "[onclick*='" + scrMatch[1] + "']:visible");
      } else if (
        onclickAttr.length <= 45 &&
        !/['"\\\\]/.test(onclickAttr) &&
        !/^(javascript:|return\\s+(false|true)|void\\s*\\(0\\)|if\\s*\\(|for\\s*\\(|while\\s*\\(|switch\\s*\\()/i.test(onclickAttr) &&
        onclickAttr.indexOf("checkedEditMode") === -1
      ) {
        const fnToken = onclickAttr.split(";")[0].trim().slice(0, 28);
        results.push(scopePrefix + tag + "[onclick*='" + fnToken + "']:visible");
      }
    }

    if (primaryBtnCls && /^btn_(?:logout|login|srch|rfsh|setup|admin|write|save|confirm|close)$/i.test(primaryBtnCls)) {
      results.push(scopePrefix + tag + "." + primaryBtnCls + ":visible");
    }

    if (
      valueAttr &&
      valueAttr.length <= 20 &&
      !/['"\\\\]/.test(valueAttr) &&
      !/^(on|true|false|y|n|1|0)$/i.test(valueAttr) &&
      (tag === "button" || typeAttr === "button" || typeAttr === "submit" || typeAttr === "radio" || typeAttr === "checkbox")
    ) {
      results.push(scopePrefix + tag + "[value='" + valueAttr + "']:visible");
    }

    return results;
  }

  // Verify candidate selectors against the live browser DOM at capture time so any selector whose .first()
  // would match a different visible element is discarded, and 1-of-1 unique matches are ranked first!
  function verifyAndRankCandidatesInLiveDom(candidates, el, modalEl) {
    if (!candidates || candidates.length <= 1 || !el) return candidates;
    const uniqueMatches = [];
    const unverifiedSpecific = [];
    const firstMatches = [];

    function isNodeVisible(node) {
      if (!node || !node.getBoundingClientRect) return false;
      if (node === el) return true;
      const r = node.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      try {
        const st = window.getComputedStyle(node);
        if (st && (st.display === "none" || st.visibility === "hidden" || st.opacity === "0")) return false;
      } catch (e) {}
      return true;
    }

    for (let i = 0; i < candidates.length; i++) {
      const cand = candidates[i];
      if (!cand) continue;
      let queryStr = cand.trim();
      let searchRoot = document;
      if (queryStr.indexOf(".ui-dialog:visible ") === 0) {
        queryStr = queryStr.slice(".ui-dialog:visible ".length).trim();
        if (modalEl) searchRoot = modalEl;
      }
      if (queryStr.slice(-8) === ":visible") {
        queryStr = queryStr.slice(0, -8).trim();
      }

      // Check if queryStr contains Playwright pseudo-selectors (:has-text, :text-is, or internal :visible)
      const hasNestedPlaywrightPseudo =
        queryStr.indexOf(":visible") !== -1 ||
        (queryStr.match(/:(?:has-text|text-is)\\(/g) || []).length > 1 ||
        /:has\\([^)]*:(?:has-text|text-is)\\(/.test(queryStr);

      if (hasNestedPlaywrightPseudo) {
        unverifiedSpecific.push(cand);
        continue;
      }

      let baseCss = queryStr;
      let textFilterMode = "";
      let textFilterVal = "";
      const textPseudoMatch = queryStr.match(/^(.*):((?:has-text|text-is))\\(['"]([^'"]+)['"]\\)$/);
      if (textPseudoMatch) {
        baseCss = textPseudoMatch[1].trim() || "*";
        textFilterMode = textPseudoMatch[2];
        textFilterVal = textPseudoMatch[3];
      }

      try {
        const rawNodes = Array.from(searchRoot.querySelectorAll(baseCss));
        const visibleNodes = rawNodes.filter(function(n) {
          if (!isNodeVisible(n)) return false;
          if (!textFilterMode) return true;
          const nClean = getCleanText(n);
          const nRaw = ((n.innerText || n.textContent || "") + "").replace(/\\s+/g, " ").trim();
          if (textFilterMode === "text-is") {
            return nClean === textFilterVal || nRaw === textFilterVal;
          }
          return nClean.indexOf(textFilterVal) !== -1 || nRaw.indexOf(textFilterVal) !== -1;
        });

        const matchIdx = visibleNodes.indexOf(el);
        if (matchIdx === 0 && visibleNodes.length === 1) {
          uniqueMatches.push(cand);
        } else if (matchIdx === 0 && visibleNodes.length > 1) {
          firstMatches.push(cand);
        }
        // If matchIdx > 0 or matchIdx === -1, discard! Because Playwright's .first() would click visibleNodes[0] !== el!
      } catch (err) {
        unverifiedSpecific.push(cand);
      }
    }

    const combined = uniqueMatches.concat(unverifiedSpecific).concat(firstMatches);
    return combined.length > 0 ? combined : candidates;
  }

  // Build a rock-solid Playwright selector for an element prioritizing actual HTML attributes & DOM structural path
  function buildRobustSelector(rawEl) {
    const el = resolveInteractiveElement(rawEl);
    if (!el || !el.tagName) return "";

    const tag = el.tagName.toLowerCase();
    const id = el.getAttribute("id") || "";
    const name = el.getAttribute("name") || "";
    const placeholder = el.getAttribute("placeholder") || "";
    const title = el.getAttribute("title") || "";
    const typeAttr = el.getAttribute("type") || "";
    const text = (el.classList && el.classList.contains("dynatree-title"))
      ? getCleanText(el)
      : getVisibleDomText(el);

    const modalEl = el.closest(".ui-dialog, .modal, .layer_pop, [role='dialog']");
    const datepickerEl = el.closest(".ui-datepicker, #ui-datepicker-div");
    const workCardEl = el.closest("li.aw_li, .app_work_box");
    const workCardTitEl =
      workCardEl && workCardEl.querySelector
        ? workCardEl.querySelector(".tit_box strong.tit, strong.tit") || workCardEl.querySelector(".tit, a._his")
        : null;
    const workCardTit = workCardTitEl ? getCleanText(workCardTitEl).slice(0, 20).replace(/'/g, "") : "";
    const allSvcEl = el.closest("#all_svc_inner");
    const svcLstEl = el.closest("#svc_lst");
    const snbEl = el.closest("#snb, .snb, .workset_btn, .snb_btn_box");
    const rawHeaderEl = el.closest("#header, #gnb");
    const headerEl =
      rawHeaderEl && rawHeaderEl.getBoundingClientRect && rawHeaderEl.getBoundingClientRect().height <= 120
        ? rawHeaderEl
        : null;

    let scopePrefix = "";
    if (modalEl) {
      scopePrefix = ".ui-dialog:visible ";
    } else if (datepickerEl) {
      scopePrefix = ".ui-datepicker:visible ";
    } else if (allSvcEl) {
      scopePrefix = "div#all_svc_inner ";
    } else if (svcLstEl) {
      scopePrefix = "#svc_lst ";
    } else if (workCardEl) {
      scopePrefix = workCardTit ? "li.aw_li:has-text('" + workCardTit + "') " : ".app_work_box ";
    } else if (snbEl) {
      const snbContainer = el.closest("#snb, .snb") || snbEl;
      const snbId = snbContainer && snbContainer.getAttribute ? snbContainer.getAttribute("id") || "" : "";
      if (snbId && isStableId(snbId)) {
        scopePrefix = "#" + snbId + " ";
      } else if (el.closest("#snb")) {
        scopePrefix = "#snb ";
      } else if (el.closest(".snb")) {
        scopePrefix = ".snb ";
      }
    } else if (headerEl) {
      scopePrefix = "#header ";
    }

    const candidates = [];

    // 0. Synap Rich Text Editor Canvas (.se-contents)
    if (el.classList && el.classList.contains("se-contents")) {
      return scopePrefix + "div.se-contents:visible, " + scopePrefix + "[role='textbox'].se-contents:visible";
    }

    // 1. Stable HTML ID (Highest priority)
    if (isStableId(id)) {
      candidates.push((modalEl ? ".ui-dialog:visible " : "") + tag + "#" + id + ":visible");
      if (!modalEl) {
        candidates.push("#" + id + ":visible");
      }
    }

    // 1.5 Universal Child/For Fingerprinting: If <label>, <a>, or <button> lacks its own id, inspect [for], child [id], child <input>, and child distinguishing classes (scvr*, plt_*, ico_*)
    if ((tag === "label" || tag === "a" || tag === "button") && !id && el.querySelector) {
      const baseCls =
        tag === "label"
          ? el.classList && el.classList.contains("chkbox")
            ? "label.chkbox"
            : el.classList && el.classList.contains("rdobtn")
              ? "label.rdobtn"
              : "label"
          : tag;
      if (tag === "label") {
        const forAttr = (el.getAttribute("for") || "").replace(/'/g, "").trim();
        if (forAttr && isStableId(forAttr)) {
          candidates.push(scopePrefix + "label[for='" + forAttr + "']:visible");
        }
      }
      const childWithId = el.querySelector("[id]");
      const childId = childWithId ? childWithId.getAttribute("id") || "" : "";
      if (childId && isStableId(childId)) {
        candidates.push((modalEl ? ".ui-dialog:visible " : "") + baseCls + ":has(#" + childId + "):visible");
      }
      const childInput = el.querySelector("input");
      const childName = childInput ? (childInput.getAttribute("name") || "").replace(/'/g, "").trim() : "";
      const childVal = childInput ? (childInput.getAttribute("value") || "").replace(/'/g, "").trim() : "";
      if (childVal && childVal.length <= 35 && !/^(on|true|false|y|n|1|0)$/i.test(childVal)) {
        if (childName) {
          candidates.push(
            (modalEl ? ".ui-dialog:visible " : "") +
              baseCls +
              ":has(input[name='" +
              childName +
              "'][value='" +
              childVal +
              "']):visible"
          );
        }
        candidates.push((modalEl ? ".ui-dialog:visible " : "") + baseCls + ":has(input[value='" + childVal + "']):visible");
      }
      const childDataEl = el.querySelector("[data-task-subject], [data-emp-id], [data-trgt-id], [data-res-id], [data-dept-id]");
      if (childDataEl && childDataEl.getAttribute) {
        const cAttrs = ["data-task-subject", "data-emp-id", "data-trgt-id", "data-res-id", "data-dept-id"];
        for (let ci = 0; ci < cAttrs.length; ci++) {
          const cVal = (childDataEl.getAttribute(cAttrs[ci]) || "").replace(/'/g, "").trim();
          if (cVal && cVal.toLowerCase() !== "empty" && cVal.length <= 35) {
            candidates.unshift((modalEl ? ".ui-dialog:visible " : "") + baseCls + ":has([" + cAttrs[ci] + "='" + cVal + "']):visible");
            break;
          }
        }
      }
      const childDistinguishingEl = el.querySelector("[class*='scvr'], [class*='plt_'], i[class*='ico_'], span[class*='ico_']");
      if (childDistinguishingEl && childDistinguishingEl.classList) {
        const distCls = Array.from(childDistinguishingEl.classList).find(function(c) {
          if (/^(?:scvr\\d+|plt_\\d+)$/i.test(c)) return true;
          if (tag !== "label" && /^ico_[a-zA-Z0-9_]+$/i.test(c) && !/^ico_(?:chk|rdo|hide|info|user|dept|f\\d+|lst)/i.test(c)) {
            return true;
          }
          return false;
        });
        if (distCls) {
          candidates.push((modalEl ? ".ui-dialog:visible " : "") + baseCls + ":has(." + distCls + "):visible");
        }
      }
    }

    // 2. Exact HTML Attributes (data-*, unique button/input hook classes, name, title, value, onclick)
    const htmlAttrSelectors = buildExactHtmlAttributeSelector(el, scopePrefix);
    for (let i = 0; i < htmlAttrSelectors.length; i++) {
      candidates.push(htmlAttrSelectors[i]);
    }

    // 2.5 If an ancestor within 4 levels has a distinguishing data-trgt-id / data-res-id / data-emp-id (e.g. approval line box [data-trgt-id='M438014134'] label.chkbox),
    // prepend the ancestor-scoped selector so it never hits the wrong row/card!
    const goodClasses = getMeaningfulClasses(el, 3);
    {
      let anc = el.parentElement;
      let ancD = 0;
      const ancAttrs = ["data-trgt-id", "data-res-id", "data-emp-id", "data-dept-id", "data-work-id"];
      while (anc && anc !== document.body && ancD < 4) {
        let matchedAnc = false;
        for (let ai = 0; ai < ancAttrs.length; ai++) {
          const aName = ancAttrs[ai];
          const aVal = anc.getAttribute && anc.getAttribute(aName);
          if (aVal && aVal.toLowerCase() !== "empty" && aVal.length <= 35 && !/['"\\\\]/.test(aVal)) {
            const clsPart = goodClasses.length > 0 ? "." + goodClasses.join(".") : "";
            candidates.push(scopePrefix + "[" + aName + "='" + aVal + "'] " + tag + clsPart + ":visible");
            matchedAnc = true;
            break;
          }
        }
        if (matchedAnc) break;
        anc = anc.parentElement;
        ancD++;
      }
    }

    // 3. Tree node (.dynatree-title): prioritize :text-is('...') and :has-text('...'), and always scope [title='...'] with :has-text('...')
    // because in Naonsoft org trees, user nodes share their parent department's title attribute (e.g. title="유니슨 그룹>유니슨>테스트 부서")!
    if (el.classList && el.classList.contains("dynatree-title") && text) {
      const safeText = text.replace(/'/g, "").trim();
      const safeTitle = title ? title.replace(/'/g, "").trim() : "";
      if (safeText) {
        candidates.push(scopePrefix + ".dynatree-title:text-is('" + safeText + "'):visible");
        candidates.push(scopePrefix + ".dynatree-title:has-text('" + safeText + "'):visible");
      }
      if (safeTitle && safeText) {
        candidates.push(scopePrefix + tag + ".dynatree-title[title='" + safeTitle + "']:has-text('" + safeText + "'):visible");
      } else if (safeTitle) {
        candidates.push(scopePrefix + tag + ".dynatree-title[title='" + safeTitle + "']:visible");
      }
    }

    // 4. Scoped Class + Identifying Text vs Exact DOM Path
    const trEl = el.closest ? el.closest("tr") : null;
    const thEl = trEl ? trEl.querySelector("th") : null;
    const rowThText = thEl ? getCleanText(thEl).replace(/^\\*\\s*/, "").slice(0, 15).replace(/'/g, "").trim() : "";
    const rowScopePrefix = rowThText ? scopePrefix + "tr:has(th:has-text('" + rowThText + "')) " : scopePrefix;
    const domPathSel = buildExactDomPathSelector(el, modalEl);

    // Check if parent has a numeric slot class (e.g., <dd class="1400"><a class="unuse"> in resource timetable)
    const parentEl = el.parentElement;
    const parentNumCls =
      parentEl && parentEl.classList
        ? Array.from(parentEl.classList).find(function(c) {
            return /^[0-9][a-zA-Z0-9_-]*$/.test(c);
          })
        : null;
    if (parentEl && parentNumCls) {
      const pTag = parentEl.tagName.toLowerCase();
      const clsSuffix = goodClasses.length > 0 ? "." + goodClasses.join(".") : "";
      candidates.push(scopePrefix + pTag + "[class~='" + parentNumCls + "'] > " + tag + clsSuffix + ":visible");
    }

    // Find nearest stable #id container ancestor (within 5 levels) to scope repeated buttons like '검색'
    let nearestIdContainerPrefix = "";
    let nearestIdContainerEl = null;
    {
      let anc = el.parentElement;
      let ancDepth = 0;
      while (anc && anc !== document.body && ancDepth < 5) {
        const ancId = anc.getAttribute && anc.getAttribute("id");
        if (ancId && isStableId(ancId) && !/^(body|wrap|layout|content|container|main)$/i.test(ancId)) {
          nearestIdContainerPrefix = (modalEl ? ".ui-dialog:visible " : "") + anc.tagName.toLowerCase() + "#" + ancId + " ";
          nearestIdContainerEl = anc;
          break;
        }
        anc = anc.parentElement;
        ancDepth++;
      }
    }

    // Check if multiple visible elements in the current scope (or even within nearestIdContainerEl, such as 28 radio items in ul#wikiBookReg_imgList) share the exact same text
    let isDuplicateTextInScope = false;
    let isDuplicateTextInContainer = false;
    let isDuplicateTextInRow = false;
    if (text && tag !== "input" && tag !== "textarea" && tag !== "select" && !el.isContentEditable) {
      try {
        const searchRoot = modalEl || document;
        const sameTagEls = Array.from(searchRoot.querySelectorAll(tag));
        let sameTextCount = 0;
        for (let i = 0; i < sameTagEls.length; i++) {
          if (getCleanText(sameTagEls[i]) === text) {
            sameTextCount++;
            if (sameTextCount > 1) {
              isDuplicateTextInScope = true;
              break;
            }
          }
        }
        if (nearestIdContainerEl) {
          const containerTagEls = Array.from(nearestIdContainerEl.querySelectorAll(tag));
          let containerSameCount = 0;
          for (let j = 0; j < containerTagEls.length; j++) {
            if (getCleanText(containerTagEls[j]) === text) {
              containerSameCount++;
              if (containerSameCount > 1) {
                isDuplicateTextInContainer = true;
                break;
              }
            }
          }
        } else {
          isDuplicateTextInContainer = isDuplicateTextInScope;
        }
        if (trEl) {
          const rowTagEls = Array.from(trEl.querySelectorAll(tag));
          let rowSameCount = 0;
          for (let k = 0; k < rowTagEls.length; k++) {
            if (getCleanText(rowTagEls[k]) === text) {
              rowSameCount++;
              if (rowSameCount > 1) {
                isDuplicateTextInRow = true;
                break;
              }
            }
          }
        }
      } catch (err) {}
    }

    if (isDuplicateTextInScope && domPathSel && !rowThText) {
      candidates.push(domPathSel);
    }

    // ContentEditable element specific selectors (placed AFTER id/data-* and WITHOUT :has-text of typed content!)
    if (el.isContentEditable && tag !== "input" && tag !== "textarea") {
      if (placeholder) {
        candidates.push(
          scopePrefix + tag + "[contenteditable='true'][placeholder*='" + placeholder.slice(0, 15).replace(/'/g, "") + "']:visible"
        );
      }
      if (goodClasses.length > 0) {
        const cls = goodClasses.join(".");
        if (nearestIdContainerPrefix) {
          candidates.push(nearestIdContainerPrefix + tag + "." + cls + "[contenteditable='true']:visible");
        }
        candidates.push(scopePrefix + tag + "." + cls + "[contenteditable='true']:visible");
      }
    }

    if (goodClasses.length > 0 && text && text.length >= 2 && tag !== "input" && tag !== "textarea" && tag !== "select" && !el.isContentEditable) {
      const cls = goodClasses.join(".");
      const safeText = text.slice(0, 28).replace(/'/g, "").trim();
      const strippedDateText = safeText.replace(/\\s+\\d{4}[-.]\\d{2}[-.]\\d{2}(?:\\s+.*)?$/, "").trim();
      const primaryToken = safeText.split(/\\s+/)[0];
      if (!isDuplicateTextInContainer && strippedDateText && strippedDateText.length >= 2 && strippedDateText !== safeText) {
        if (nearestIdContainerPrefix && !workCardTit) {
          candidates.push(nearestIdContainerPrefix + tag + "." + cls + ":has-text('" + strippedDateText + "'):visible");
        }
        if (!isDuplicateTextInScope) {
          candidates.push(scopePrefix + tag + "." + cls + ":has-text('" + strippedDateText + "'):visible");
        }
      }
      if (rowThText && !isDuplicateTextInRow) {
        candidates.push(rowScopePrefix + tag + "." + cls + ":has-text('" + safeText + "'):visible");
      }
      if (nearestIdContainerPrefix && !workCardTit && !isDuplicateTextInContainer) {
        candidates.push(nearestIdContainerPrefix + tag + "." + cls + ":has-text('" + safeText + "'):visible");
        if (el.children && el.children.length > 0 && primaryToken && primaryToken.length >= 2 && primaryToken !== safeText) {
          candidates.push(nearestIdContainerPrefix + tag + "." + cls + ":has-text('" + primaryToken + "'):visible");
        }
      }
      if ((!isDuplicateTextInScope || (nearestIdContainerPrefix && !isDuplicateTextInContainer) || workCardTit) && !isDuplicateTextInContainer) {
        candidates.push(scopePrefix + tag + "." + cls + ":has-text('" + safeText + "'):visible");
        if (el.children && el.children.length > 0 && primaryToken && primaryToken.length >= 2 && primaryToken !== safeText) {
          candidates.push(scopePrefix + tag + "." + cls + ":has-text('" + primaryToken + "'):visible");
        }
      }
    }

    // 5. Exact DOM Hierarchy Path from Nearest #id Ancestor
    if (domPathSel && !candidates.includes(domPathSel)) {
      candidates.push(domPathSel);
    }

    // 6. Special Structural Cases (Dynatree Checkboxes & Template Card Write Buttons)
    if (
      el.classList &&
      (el.classList.contains("dynatree-checkbox") ||
        el.classList.contains("dynatree-expander") ||
        el.classList.contains("fancytree-checkbox"))
    ) {
      const nodeEl = el.closest(".dynatree-node, .fancytree-node, li");
      const titleEl = nodeEl ? nodeEl.querySelector(".dynatree-title, .fancytree-title, a") : null;
      const nodeText = titleEl ? getCleanText(titleEl).slice(0, 22).replace(/'/g, "") : "";
      const targetCls = el.classList.contains("dynatree-expander")
        ? "span.dynatree-expander"
        : "span.dynatree-checkbox";
      if (nodeText) {
        candidates.unshift(scopePrefix + ".dynatree-node:has-text('" + nodeText + "') " + targetCls + ":visible");
        candidates.push(scopePrefix + "li:has-text('" + nodeText + "') " + targetCls + ":visible");
      }
    }

    if (workCardEl && (tag === "button" || tag === "a")) {
      if (el.classList && el.classList.contains("btn_write")) {
        if (workCardTit) {
          candidates.unshift("ul.aw_ul li.aw_li:has-text('" + workCardTit + "') button.btn_write:visible");
        } else {
          candidates.push("ul.aw_ul li.aw_li button.btn_write:visible");
        }
      }
    }

    // 7. Input / Textarea specific attributes
    if (tag === "input" || tag === "textarea" || tag === "select") {
      if (typeAttr === "checkbox" || typeAttr === "radio") {
        const row = el.closest("tr, li, label, .chk_div");
        const rowText = row ? getCleanText(row).slice(0, 20).replace(/'/g, "") : "";
        if (rowText && !isDuplicateTextInContainer) {
          candidates.unshift(scopePrefix + "tr:has-text('" + rowText + "') input[type='" + typeAttr + "']:visible");
          candidates.unshift(scopePrefix + "li:has-text('" + rowText + "') input[type='" + typeAttr + "']:visible");
        }
      } else if (name) {
        candidates.push(scopePrefix + tag + "[name='" + name + "']:visible");
      }
      if (placeholder) candidates.push(scopePrefix + tag + "[placeholder*='" + placeholder.slice(0, 15).replace(/'/g, "") + "']:visible");
      if (title && typeAttr !== "checkbox" && typeAttr !== "radio") {
        candidates.push(scopePrefix + tag + "[title*='" + title.slice(0, 15).replace(/'/g, "") + "']:visible");
      }
      if (tag === "textarea" && !id) {
        candidates.push("textarea:not(#eapDocReg_draftOpinCn):visible");
      }
    }

    // 8. Scoped Class + Text Fallback (only after DOM path and HTML attributes)
    let listCtxPrefix = "";
    let isDuplicateTextInListCtx = isDuplicateTextInContainer;
    if (parentEl && parentEl !== document.body) {
      let ctxEl = parentEl;
      let pClasses = getMeaningfulClasses(ctxEl, 2);
      if (pClasses.length === 0 && ctxEl.parentElement && ctxEl.parentElement !== document.body) {
        ctxEl = ctxEl.parentElement;
        pClasses = getMeaningfulClasses(ctxEl, 2);
      }
      if (pClasses.length > 0) {
        listCtxPrefix = ctxEl.tagName.toLowerCase() + "." + pClasses.join(".") + " ";
        if (text && ctxEl.querySelectorAll) {
          try {
            const listTagEls = Array.from(ctxEl.querySelectorAll(tag));
            let listSameCount = 0;
            for (let m = 0; m < listTagEls.length; m++) {
              if (getCleanText(listTagEls[m]) === text) {
                listSameCount++;
              }
            }
            isDuplicateTextInListCtx = listSameCount > 1;
          } catch (err) {}
        }
      }
    }
    if (goodClasses.length > 0 && !el.isContentEditable) {
      const cls = goodClasses.join(".");
      if (text && text.length <= 20 && tag !== "input" && tag !== "textarea") {
        const safeText = text.replace(/'/g, "");
        const textPseudo = safeText.length <= 2 ? ":text-is('" + safeText + "')" : ":has-text('" + safeText + "')";
        if (listCtxPrefix && !isDuplicateTextInListCtx) {
          candidates.unshift(scopePrefix + listCtxPrefix + tag + "." + cls + textPseudo + ":visible");
        }
        if (rowThText && !isDuplicateTextInRow) {
          candidates.push(rowScopePrefix + tag + "." + cls + textPseudo + ":visible");
        }
        if (!isDuplicateTextInContainer) {
          candidates.push(scopePrefix + tag + "." + cls + textPseudo + ":visible");
        }
      }
      if (rowThText && !isDuplicateTextInRow && !isDuplicateTextInContainer) {
        candidates.push(rowScopePrefix + tag + "." + cls + ":visible");
      }
      if (listCtxPrefix && !isDuplicateTextInListCtx) {
        candidates.push(scopePrefix + listCtxPrefix + tag + "." + cls + ":visible");
      }
      const isListItemChild = Boolean(el.closest && el.closest("li, tr"));
      if (!isListItemChild || !text || !isDuplicateTextInContainer) {
        candidates.push(scopePrefix + tag + "." + cls + ":visible");
      }
    } else if (text && text.length >= 1 && text.length <= 25 && tag !== "input" && tag !== "textarea" && !el.isContentEditable) {
      const safeText = text.replace(/'/g, "");
      const textPseudo = safeText.length <= 2 ? ":text-is('" + safeText + "')" : ":has-text('" + safeText + "')";
      if (listCtxPrefix && !isDuplicateTextInListCtx) {
        candidates.unshift(scopePrefix + listCtxPrefix + tag + textPseudo + ":visible");
      }
      if (rowThText && !isDuplicateTextInRow) {
        candidates.push(rowScopePrefix + tag + textPseudo + ":visible");
      }
      if (!isDuplicateTextInScope) {
        candidates.push(scopePrefix + tag + textPseudo + ":visible");
      }
    }

    if (el.isContentEditable && tag !== "input" && tag !== "textarea") {
      candidates.push(scopePrefix + tag + "[contenteditable='true']:visible");
    }

    if (candidates.length === 0) {
      if (title) {
        candidates.push(scopePrefix + tag + "[title*='" + title.slice(0, 15).replace(/'/g, "") + "']:visible");
      } else {
        candidates.push(scopePrefix + tag + ":visible");
      }
    }

    // Deduplicate, verify against live DOM so non-first matches are discarded and 1-of-1 matches come first, and take top 4
    const deduped = Array.from(new Set(candidates));
    const verified = verifyAndRankCandidatesInLiveDom(deduped, el, modalEl);
    return verified.slice(0, 4).join(", ");
  }

  function buildHumanLabel(rawEl) {
    const el = resolveInteractiveElement(rawEl);
    if (!el || !el.tagName) return "요소";
    const tag = el.tagName.toLowerCase();
    const modalEl = el.closest(".ui-dialog, .modal, .layer_pop, [role='dialog']");
    let modalTitle = "";
    if (modalEl) {
      const titleNode = modalEl.querySelector(".ui-dialog-title, .tit, h3, h4");
      if (titleNode) modalTitle = getCleanText(titleNode).slice(0, 15);
    }
    const trEl = el.closest ? el.closest("tr") : null;
    const thEl = trEl ? trEl.querySelector("th") : null;
    const rowThText = thEl ? getCleanText(thEl).replace(/^\\*\\s*/, "").slice(0, 14).trim() : "";
    const prefix = modalTitle
      ? "[" + modalTitle + " 팝업] "
      : modalEl
      ? "[팝업] "
      : rowThText && (tag === "button" || tag === "input" || tag === "select" || tag === "label")
      ? "[" + rowThText + "] "
      : "";

    const text = getCleanText(el);
    const placeholder = el.getAttribute("placeholder") || "";
    const title = el.getAttribute("title") || "";
    const id = el.getAttribute("id") || "";

    if (el.classList && (el.classList.contains("dynatree-checkbox") || el.classList.contains("fancytree-checkbox"))) {
      const nodeEl = el.closest(".dynatree-node, .fancytree-node, li");
      const titleEl = nodeEl ? nodeEl.querySelector(".dynatree-title, .fancytree-title, a") : null;
      const nodeText = titleEl ? getCleanText(titleEl).slice(0, 20) : "";
      return prefix + (nodeText ? "트리 '" + nodeText + "' 체크박스" : "트리 체크박스");
    }

    if (el.classList && el.classList.contains("se-contents")) {
      return prefix + "'에디터 본문' 입력 영역";
    }
    if (el.isContentEditable && tag !== "input" && tag !== "textarea") {
      if (placeholder || /subject|title/i.test(id) || (el.classList && el.classList.contains("title"))) {
        return prefix + "'" + (placeholder || title || "제목") + "' 입력창";
      }
      return prefix + "'에디터 본문' 입력 영역";
    }

    if (tag === "input" || tag === "textarea") {
      const typeAttr = (el.getAttribute("type") || "text").toLowerCase();
      if (typeAttr === "checkbox" || typeAttr === "radio") {
        const container = el.closest("li, tr, label");
        const containerTxt = container ? getCleanText(container).slice(0, 20) : "";
        return prefix + (containerTxt ? "'" + containerTxt + "' 체크박스" : "체크박스");
      }
      if (typeAttr === "file") {
        const fileBtnName = title || placeholder || "파일 선택";
        return prefix + "'" + fileBtnName + "' 버튼";
      }
      const fieldName = placeholder || title || id || "입력란";
      return prefix + "'" + fieldName + "' 입력창";
    }

    if (el.classList && el.classList.contains("dynatree-title")) {
      return prefix + "트리 '" + (text || id) + "' 항목";
    }

    const workCardEl = el.closest("li.aw_li, .app_work_box");
    if (workCardEl && el.classList && el.classList.contains("btn_write")) {
      const cardTitEl = workCardEl.querySelector("strong.tit, .tit, a._his");
      const cardTit = cardTitEl ? getCleanText(cardTitEl).slice(0, 15) : "";
      return cardTit ? "'" + cardTit + "' 양식 카드 [작성] 버튼" : "양식 카드 [작성] 버튼";
    }

    if (text) {
      const isBtnLike =
        tag === "button" ||
        (el.classList && (el.classList.contains("btn") || el.classList.contains("fileinput-button")));
      return prefix + "'" + text.slice(0, 22) + "' " + (tag === "a" ? "메뉴/링크" : isBtnLike ? "버튼" : "요소");
    }
    if (title) {
      return prefix + "'" + title.slice(0, 22) + "' 버튼";
    }
    if (id) {
      return prefix + "#" + id + " (" + tag + ")";
    }
    return prefix + tag + " 요소";
  }

  function normalizeEditorLine(raw) {
    return String(raw || "")
      .replace(/\\u200B/g, "")
      .replace(/\\u00a0/g, " ")
      .replace(/\\r?\\n/g, "");
  }

  function getEditorParagraphNodes(editorEl) {
    if (!editorEl || !editorEl.querySelectorAll) return [];
    const paras = Array.from(editorEl.querySelectorAll("p.se-text-paragraph, p"));
    if (paras.length > 0) return paras;
    const blocks = Array.from(editorEl.children || []).filter(function(ch) {
      return ch && ch.tagName && /^(DIV|LI|H[1-6]|BLOCKQUOTE)$/i.test(ch.tagName);
    });
    return blocks;
  }

  function getEditorParagraphs(editorEl) {
    const nodes = getEditorParagraphNodes(editorEl);
    if (nodes.length > 0) {
      return nodes.map(function(p) {
        return normalizeEditorLine(p.innerText !== undefined ? p.innerText : p.textContent);
      });
    }
    const raw = normalizeEditorLine(editorEl.innerText !== undefined ? editorEl.innerText : editorEl.textContent);
    return raw ? raw.split("\\n") : [""];
  }

  function getClickedParagraphIndex(editorEl, rawTarget, clientY) {
    const nodes = getEditorParagraphNodes(editorEl);
    if (nodes.length === 0) return 0;
    if (rawTarget && rawTarget.closest) {
      const pNode = rawTarget.closest("p.se-text-paragraph, p");
      if (pNode) {
        const idx = nodes.indexOf(pNode);
        if (idx !== -1) return idx;
      }
    }
    if (typeof clientY === "number" && clientY > 0) {
      for (let i = 0; i < nodes.length; i++) {
        const r = nodes[i].getBoundingClientRect ? nodes[i].getBoundingClientRect() : null;
        if (r && clientY >= r.top - 4 && clientY <= r.bottom + 4) {
          return i;
        }
      }
      const lastRect = nodes[nodes.length - 1].getBoundingClientRect
        ? nodes[nodes.length - 1].getBoundingClientRect()
        : null;
      if (lastRect && clientY > lastRect.bottom) {
        return nodes.length - 1;
      }
    }
    return 0;
  }

  function computeEditorTypedDelta(baseParas, finalParas, clickedParaIdx) {
    if (!Array.isArray(finalParas) || finalParas.length === 0) {
      return null;
    }
    const hasBaseContent =
      Array.isArray(baseParas) &&
      baseParas.some(function(line) {
        return String(line || "").trim().length > 0;
      });
    if (!hasBaseContent) {
      const fullTxt = finalParas
        .map(function(s) { return String(s || "").trimEnd(); })
        .join("\\n")
        .replace(/^[ \\t\\r\\n]+|[ \\t\\r\\n]+$/g, "");
      return {
        text: fullTxt,
        editorParaIndex: typeof clickedParaIdx === "number" ? clickedParaIdx : 0,
        editorInsertNewline: false,
        noChange: fullTxt.length === 0
      };
    }

    const I = baseParas.map(function(s) { return String(s || ""); });
    const F = finalParas.map(function(s) { return String(s || ""); });

    let prefixLen = 0;
    while (
      prefixLen < I.length &&
      prefixLen < F.length &&
      I[prefixLen].trimEnd() === F[prefixLen].trimEnd()
    ) {
      prefixLen++;
    }

    let suffixLen = 0;
    while (
      suffixLen < I.length - prefixLen &&
      suffixLen < F.length - prefixLen &&
      I[I.length - 1 - suffixLen].trimEnd() === F[F.length - 1 - suffixLen].trimEnd()
    ) {
      suffixLen++;
    }

    const oldSlice = I.slice(prefixLen, I.length - suffixLen);
    const newSlice = F.slice(prefixLen, F.length - suffixLen);

    if (oldSlice.length === 0 && newSlice.length === 0) {
      return { text: "", editorParaIndex: clickedParaIdx || 0, editorInsertNewline: false, noChange: true };
    }

    // Case 1: Pure insertion of new paragraph line(s) (e.g. pressed Enter at end of I[prefixLen - 1] and typed new line)
    if (oldSlice.length === 0 && newSlice.length > 0) {
      const insertedText = newSlice
        .map(function(s) { return s.trimEnd(); })
        .join("\\n")
        .replace(/^[ \\t\\r\\n]+|[ \\t\\r\\n]+$/g, "");
      if (prefixLen > 0) {
        return {
          text: insertedText,
          editorParaIndex: prefixLen - 1,
          editorInsertNewline: true,
          noChange: insertedText.length === 0
        };
      }
      return {
        text: insertedText,
        editorParaIndex: 0,
        editorInsertNewline: false,
        noChange: insertedText.length === 0
      };
    }

    // Case 2: Modified existing paragraph(s)
    if (oldSlice.length > 0 && newSlice.length > 0) {
      const oldFirst = oldSlice[0];
      const newFirst = newSlice[0];

      // 2a. Typed into an existing blank line
      if (oldFirst.trim() === "") {
        const typedTxt = newSlice
          .map(function(s) { return s.trimEnd(); })
          .join("\\n")
          .replace(/^[ \\t\\r\\n]+|[ \\t\\r\\n]+$/g, "");
        return {
          text: typedTxt,
          editorParaIndex: prefixLen,
          editorInsertNewline: false,
          noChange: typedTxt.length === 0
        };
      }

      // 2b. Appended to the end of an existing non-empty line (e.g. "- " -> "- 결함 내용", or "■ 교육 요청 내용 작성" -> "■ 교육 요청 내용 작성...")
      const oldTrimEnd = oldFirst.trimEnd();
      if (newFirst.indexOf(oldFirst) === 0 || (oldTrimEnd.length > 0 && newFirst.indexOf(oldTrimEnd) === 0)) {
        const matchPrefix = newFirst.indexOf(oldFirst) === 0 ? oldFirst : oldTrimEnd;
        let firstRemainder = newFirst.slice(matchPrefix.length);
        if (matchPrefix !== oldFirst && firstRemainder.charAt(0) === " ") {
          firstRemainder = firstRemainder.slice(1);
        }
        const restLines = newSlice.slice(1).map(function(s) { return s.trimEnd(); });
        if (firstRemainder.trim() === "" && restLines.length > 0) {
          const restTxt = restLines.join("\\n").replace(/^[ \\t\\r\\n]+|[ \\t\\r\\n]+$/g, "");
          return {
            text: restTxt,
            editorParaIndex: prefixLen,
            editorInsertNewline: true,
            noChange: restTxt.length === 0
          };
        }
        const combinedLines = [firstRemainder.trimEnd()]
          .concat(restLines)
          .join("\\n")
          .replace(/^[ \\t\\r\\n]+|[ \\t\\r\\n]+$/g, "");
        return {
          text: combinedLines,
          editorParaIndex: prefixLen,
          editorInsertNewline: false,
          noChange: combinedLines.length === 0
        };
      }
    }

    const fallbackTxt = newSlice
      .map(function(s) { return s.trimEnd(); })
      .join("\\n")
      .replace(/^[ \\t\\r\\n]+|[ \\t\\r\\n]+$/g, "");
    return {
      text: fallbackTxt,
      editorParaIndex: prefixLen,
      editorInsertNewline: false,
      noChange: fallbackTxt.length === 0
    };
  }

  function readEditableValue(t, rawTarget, isDeletion) {
    if (!t) return "";
    const tag = (t.tagName || "").toLowerCase();
    const isSeEditor = Boolean(t.classList && t.classList.contains("se-contents"));
    if (isSeEditor) {
      const seParas = t.querySelectorAll ? Array.from(t.querySelectorAll("p.se-text-paragraph, p")) : [];
      const seTxt =
        seParas.length > 0
          ? seParas
              .map(function(p) {
                return normalizeEditorLine(p.innerText || p.textContent || "").trim();
              })
              .join("\\n")
              .replace(/^[ \\t\\r\\n]+|[ \\t\\r\\n]+$/g, "")
          : normalizeEditorLine(t.innerText || t.textContent || "")
              .replace(/^[ \\t\\r\\n]+|[ \\t\\r\\n]+$/g, "");
      if (isDeletion || seTxt) return seTxt;
      const imeTxt = rawTarget && rawTarget.value !== undefined ? String(rawTarget.value).trim() : "";
      return imeTxt;
    }
    if (tag === "input") {
      return String(t.value !== undefined ? t.value : "").trim();
    }
    if (tag === "textarea") {
      return String(t.value !== undefined ? t.value : "")
        .replace(/\\u200B/g, "")
        .replace(/\\r\\n/g, "\\n")
        .replace(/^[ \\t\\r\\n]+|[ \\t\\r\\n]+$/g, "");
    }
    // Rich text contenteditable (.ProseMirror, CKEditor, etc.): if structured with <p> blocks, join <p> lines with a single newline per Enter
    const paras = t.querySelectorAll ? Array.from(t.querySelectorAll("p")) : [];
    if (paras.length > 0) {
      return paras
        .map(function(p) {
          return normalizeEditorLine(p.innerText || p.textContent || "").trim();
        })
        .join("\\n")
        .replace(/^[ \\t\\r\\n]+|[ \\t\\r\\n]+$/g, "");
    }
    const rawStr = t.value !== undefined ? String(t.value) : String(t.innerText || t.textContent || "");
    return rawStr.replace(/\\u200B/g, "").replace(/\\r\\n/g, "\\n").replace(/^[ \\t\\r\\n]+|[ \\t\\r\\n]+$/g, "");
  }

  function flushPendingType(exceptEl) {
    if (!lastTypedElement) return;
    if (exceptEl && lastTypedElement === exceptEl) return;
    const el = lastTypedElement;
    const tag = (el.tagName || "input").toLowerCase();
    let val =
      tag === "input"
        ? (lastTypedValue || "").trim()
        : (lastTypedValue || "").replace(/\\r\\n/g, "\\n").replace(/^[ \\t\\r\\n]+|[ \\t\\r\\n]+$/g, "");
    const hadDeletion = lastTypedHadDeletion;
    const hadPressEnter = lastTypedPressEnter;
    lastTypedElement = null;
    lastTypedValue = "";
    lastTypedHadDeletion = false;
    lastTypedPressEnter = false;

    const isSeEditor = Boolean(el.classList && el.classList.contains("se-contents"));
    const isRichEditor = Boolean(isSeEditor || el.isContentEditable || (tag === "body" && !isTopWindow));
    let editorParaIndex = undefined;
    let editorInsertNewline = undefined;
    let cursorOffset = undefined;

    if (isRichEditor) {
      const finalParas = getEditorParagraphs(el);
      const baseParas =
        lastEditorBaselineElement === el && Array.isArray(lastEditorBaselineParas)
          ? lastEditorBaselineParas
          : null;
      const diff = computeEditorTypedDelta(baseParas, finalParas, lastEditorClickedParaIndex);
      if (diff) {
        if (diff.noChange && !hadDeletion && !hadPressEnter) {
          lastEditorBaselineParas = finalParas;
          lastEditorBaselineElement = el;
          return;
        }
        val = diff.text;
        editorParaIndex = diff.editorParaIndex;
        editorInsertNewline = diff.editorInsertNewline || undefined;
      }
      if (lastEditorBaselineElement === el && lastEditorClickOffset) {
        cursorOffset = lastEditorClickOffset;
      }
      lastEditorBaselineParas = finalParas;
      lastEditorBaselineElement = el;
    }

    if (!val && !hadDeletion && !hadPressEnter) return;
    if (
      el === lastFlushedElement &&
      val === lastFlushedValue &&
      !hadPressEnter &&
      !hadDeletion &&
      Date.now() - lastFlushedTime < 15000
    ) {
      return;
    }
    lastFlushedElement = el;
    lastFlushedValue = val;
    lastFlushedTime = Date.now();

    const selector = buildRobustSelector(el);
    const label = buildHumanLabel(el);
    const targetHtml = extractTargetHtml(el);
    const iframe = getCurrentIframeSelector();
    const inModal = Boolean(el.closest && el.closest(".ui-dialog, .modal, .layer_pop"));

    try {
      const topDoc = window.top.document;
      const hudStep = topDoc.getElementById("__sd_hud_last_step");
      if (hudStep) {
        const previewVal = val ? ("'" + val.replace(/\\n/g, "↵").slice(0, 20) + "'") : "내용 지우기(⌫ 백스페이스)";
        hudStep.textContent = "최근 감지: ⌨️ " + label + " ➔ " + previewVal + (hadPressEnter ? " + ⏎엔터" : "");
      }
    } catch (err) {}

    if (typeof window.__screenDemoRecordAction === "function") {
      window.__screenDemoRecordAction({
        kind: "type",
        selector: selector || "input:visible, textarea:visible",
        targetHtml,
        iframe,
        tagName: tag,
        label,
        text: val,
        pressEnter: hadPressEnter || undefined,
        editorParaIndex,
        editorInsertNewline,
        cursorOffset,
        pageUrl: location.href,
        inModal
      });
    }
  }

  try {
    if (window.top) {
      window.top.__sdFlushCallbacks = window.top.__sdFlushCallbacks || [];
      window.top.__sdFlushCallbacks.push(flushPendingType);
    }
  } catch (e) {}

  function flushAllFrames(exceptEl) {
    flushPendingType(exceptEl);
    try {
      if (window.top && Array.isArray(window.top.__sdFlushCallbacks)) {
        for (let i = 0; i < window.top.__sdFlushCallbacks.length; i++) {
          try {
            window.top.__sdFlushCallbacks[i](exceptEl);
          } catch (err) {}
        }
      }
    } catch (e) {}
  }

  // Create Eyedropper Hover Overlay & Top HUD on DOMContentLoaded
  function setupVisualOverlays() {
    if (!document.body) return;

    // 1. Eyedropper highlight box (in every frame)
    let box = document.getElementById("__sd_eyedropper_box");
    if (!box) {
      box = document.createElement("div");
      box.id = "__sd_eyedropper_box";
      box.style.cssText = [
        "position: fixed",
        "pointer-events: none",
        "z-index: 2147483645",
        "border: 2px solid #06b6d4",
        "background: rgba(6, 182, 212, 0.12)",
        "border-radius: 5px",
        "box-shadow: 0 0 0 1px rgba(15,23,42,0.5), 0 0 12px rgba(6, 182, 212, 0.45)",
        "transition: all 0.05s ease-out",
        "display: none"
      ].join(";");
      document.body.appendChild(box);
    }

    let badge = document.getElementById("__sd_eyedropper_badge");
    if (!badge) {
      badge = document.createElement("div");
      badge.id = "__sd_eyedropper_badge";
      badge.style.cssText = [
        "position: fixed",
        "pointer-events: none",
        "z-index: 2147483646",
        "background: #0f172a",
        "color: #38bdf8",
        "border: 1px solid #06b6d4",
        "padding: 3px 8px",
        "border-radius: 4px",
        "font-family: Pretendard, -apple-system, sans-serif",
        "font-size: 11px",
        "font-weight: 600",
        "white-space: nowrap",
        "box-shadow: 0 4px 12px rgba(0,0,0,0.4)",
        "display: none"
      ].join(";");
      document.body.appendChild(badge);
    }

    // 2. Top-window Floating Recorder HUD Bar
    if (isTopWindow && !document.getElementById("__sd_recorder_hud")) {
      const isPopupWindow =
        Boolean(window.opener && window.opener !== window) ||
        /[?&]newWindowYn=Y|Popup/i.test(location.href);

      const hud = document.createElement("div");
      hud.id = "__sd_recorder_hud";
      hud.style.cssText = [
        "position: fixed",
        "bottom: 20px",
        "right: 20px",
        "z-index: 2147483647",
        "background: rgba(15, 23, 42, 0.95)",
        "backdrop-filter: blur(10px)",
        "border: 1.5px solid #06b6d4",
        "border-radius: 12px",
        "padding: 12px 16px",
        "color: #f8fafc",
        "font-family: Pretendard, -apple-system, BlinkMacSystemFont, sans-serif",
        "box-shadow: 0 12px 32px rgba(0, 0, 0, 0.55)",
        "display: flex",
        "align-items: center",
        "gap: 12px",
        "user-select: none"
      ].join(";");

      const btnBg = isPopupWindow
        ? "linear-gradient(135deg, #3b82f6, #2563eb)"
        : "linear-gradient(135deg, #10b981, #059669)";
      const btnShadow = isPopupWindow
        ? "0 4px 12px rgba(59,130,246,0.35)"
        : "0 4px 12px rgba(16,185,129,0.35)";
      const btnLabel = isPopupWindow
        ? "🪟 팝업 닫기 (부모 창에서 시범 계속)"
        : "✅ 시범 완료 (AI 시나리오 변환)";

      hud.innerHTML = \`
        <div style="display:flex; align-items:center; gap:8px;">
          <span style="width:10px; height:10px; border-radius:50%; background:#ef4444; display:inline-block; box-shadow:0 0 10px #ef4444;"></span>
          <div>
            <div style="font-size:12px; font-weight:700; color:#38bdf8;">\${isPopupWindow ? "🪟 팝업 동작 감지 중 (부모 창 유지)" : "💧 스포이드 동작 감지 모드 작동 중"}</div>
            <div id="__sd_hud_last_step" style="font-size:11px; color:#cbd5e1; max-width:260px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
              원하는 버튼 클릭·타이핑·드래그를 진행하세요
            </div>
          </div>
        </div>
        <button id="__sd_btn_finish" type="button" style="background:\${btnBg}; color:#fff; border:none; border-radius:8px; padding:8px 14px; font-size:12px; font-weight:700; cursor:pointer; box-shadow:\${btnShadow};">
          \${btnLabel}
        </button>
      \`;

      document.body.appendChild(hud);

      const finishBtn = document.getElementById("__sd_btn_finish");
      if (finishBtn) {
        finishBtn.addEventListener("click", function(e) {
          e.preventDefault();
          e.stopPropagation();
          flushAllFrames();
          finishBtn.textContent = isPopupWindow ? "⏳ 팝업 닫는 중..." : "⏳ 시나리오 변환 중...";
          finishBtn.disabled = true;
          if (typeof window.__screenDemoFinishSession === "function") {
            window.__screenDemoFinishSession(isPopupWindow ? "close_popup" : "finish");
          }
        }, true);
      }
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", setupVisualOverlays);
  } else {
    setupVisualOverlays();
  }
  setInterval(setupVisualOverlays, 1500);

  let suppressClickUntil = 0;
  let lastCommitDragTime = 0;

  // Check if an element is a floating drag helper or our own HUD overlay
  function isDragHelperOrOverlay(el) {
    if (!el || !el.closest) return true;
    if (
      el.id === "__sd_eyedropper_box" ||
      el.id === "__sd_eyedropper_badge" ||
      el.closest("#__sd_recorder_hud") ||
      el.closest(
        ".ui-draggable-dragging, .ui-sortable-helper, .dynatree-drag-helper, .fancytree-drag-helper, .jstree-dnd, ._orgTreeItem, .lyr_count_move, .lyr_count_notmove"
      )
    ) {
      return true;
    }
    return false;
  }

  // Resolve the best drag source element when starting a drag
  function resolveDragSourceElement(rawTarget) {
    if (!rawTarget || !rawTarget.closest) return rawTarget;
    const src = rawTarget.closest(
      "a.dynatree-title, .fancytree-title, label.user_info, .usr_item, .ui-draggable, [draggable='true'], li.aw_li, tr, li, a, label, button"
    );
    return src || resolveInteractiveElement(rawTarget);
  }

  // Check if candidate is the same element, ancestor/descendant, or inside the same non-droppable tree node/container as sourceEl
  function isSameOrSelfDropTarget(sourceEl, candidate) {
    if (!sourceEl || !candidate) return true;
    if (candidate === sourceEl || sourceEl.contains(candidate) || candidate.contains(sourceEl)) return true;
    if (sourceEl.closest && candidate.closest) {
      const sNode = sourceEl.closest(".dynatree-node, .fancytree-node");
      const tNode = candidate.closest(".dynatree-node, .fancytree-node");
      if (sNode && tNode && sNode === tNode) return true;
      const sTree = sourceEl.closest(".dynatree-container, .fancytree-container");
      const tTree = candidate.closest(".dynatree-container, .fancytree-container");
      if (sTree && tTree && sTree === tTree && !candidate.closest(".ui-droppable, ._drag_hover, .drop_zone")) {
        return true;
      }
    }
    return false;
  }

  // Find the actual drop target underneath the cursor (piercing through floating drag clones)
  function resolveDropTargetAtPoint(x, y, sourceEl) {
    // 0. Check if Naonsoft Groupware / jQuery UI has already marked a drop container as hovered!
    const activeHoverSlot = document.querySelector(
      ".app_flow.hover, ._drag_hover, .ui-droppable-hover, .af_ul._drag_hover"
    );
    if (activeHoverSlot && !isSameOrSelfDropTarget(sourceEl, activeHoverSlot)) {
      return activeHoverSlot.closest("[id^='af_'], div.app_flow") || activeHoverSlot;
    }

    if (typeof document.elementsFromPoint !== "function") return null;
    if (typeof x !== "number" || typeof y !== "number" || (x === 0 && y === 0)) return null;

    const stack = document.elementsFromPoint(x, y) || [];
    for (let i = 0; i < stack.length; i++) {
      const candidate = stack[i];
      if (!candidate || candidate === document.body || candidate === document.documentElement) continue;
      if (isDragHelperOrOverlay(candidate)) continue;
      if (isSameOrSelfDropTarget(sourceEl, candidate)) continue;

      // Priority 1: Known approval-line / groupware drop slots
      const slot = candidate.closest(
        "[id^='af_'], div.app_flow, ul.af_ul, li.fb_ul, .ui-droppable, .ui-sortable, [data-app-type-ordr], .appline_flow td, .app_line_box, .drop_zone"
      );
      if (slot && !isSameOrSelfDropTarget(sourceEl, slot)) {
        return slot.closest("[id^='af_'], div.app_flow") || slot;
      }

      // Priority 2: Table cell, list container, or interactive target
      const container = candidate.closest("td, li, ul, .box_cont, [role='region']");
      if (container && !isSameOrSelfDropTarget(sourceEl, container)) {
        return container;
      }

      const resolved = resolveInteractiveElement(candidate);
      if (resolved && !isSameOrSelfDropTarget(sourceEl, resolved)) {
        return resolved;
      }
    }
    return null;
  }

  // Build a specialized selector for a drop target slot (e.g. #af_4, 2nd approval box, droppable container)
  function buildDropTargetSelector(dropEl) {
    if (!dropEl || !dropEl.tagName) return "";
    const modalEl = dropEl.closest && dropEl.closest(".ui-dialog, .modal, .layer_pop, [role='dialog']");
    const modalPrefix = modalEl ? ".ui-dialog:visible " : "";
    const candidates = [];

    // 1. Check if dropEl or a parent/child has an #af_N ID (Naonsoft approval flow slot)
    const afNode =
      (dropEl.id && /^af_\\d+$/.test(dropEl.id) ? dropEl : null) ||
      (dropEl.closest && dropEl.closest("[id^='af_']")) ||
      (dropEl.querySelector && dropEl.querySelector("[id^='af_']"));
    if (afNode && afNode.id) {
      candidates.push("#" + afNode.id);
      candidates.push(modalPrefix + "#" + afNode.id + ":visible");
    }

    // 2. Check if inside an approval flow table cell (td:nth-child(N) div.app_flow)
    const td = dropEl.closest && dropEl.closest("td");
    if (td && td.parentElement) {
      const tds = Array.from(td.parentElement.children).filter(c => c.tagName === "TD" || c.tagName === "TH");
      const tdIdx = tds.indexOf(td) + 1;
      if (tdIdx > 0) {
        const table = td.closest("table");
        const tableSel = table && isStableId(table.id) ? "table#" + table.id : ".appline_flow table";
        if (dropEl.classList.contains("app_flow") || (dropEl.querySelector && dropEl.querySelector(".app_flow"))) {
          candidates.push(tableSel + " td:nth-child(" + tdIdx + ") div.app_flow");
        }
        candidates.push(tableSel + " td:nth-child(" + tdIdx + ")");
      }
    }

    // 3. Check if dropEl has header text (like '결재', '합의', '협조') and nth-of-type
    const flowBox =
      (dropEl.classList && dropEl.classList.contains("app_flow") ? dropEl : null) ||
      (dropEl.closest && dropEl.closest("div.app_flow"));
    if (flowBox) {
      const strong = flowBox.querySelector("strong, .tit, .hd");
      const roleTxt = strong ? getCleanText(strong).slice(0, 10).replace(/'/g, "") : "";
      if (roleTxt) {
        const allFlows = Array.from((modalEl || document).querySelectorAll("div.app_flow")).filter(f =>
          getCleanText(f).includes(roleTxt)
        );
        const flowIdx = allFlows.indexOf(flowBox) + 1;
        if (flowIdx > 0) {
          candidates.push(modalPrefix + "div.app_flow:has(strong:has-text('" + roleTxt + "')):nth-of-type(" + flowIdx + ")");
        }
        candidates.push(modalPrefix + "div.app_flow:has-text('" + roleTxt + "')");
      }
    }

    // 4. Add standard robust selector fallback
    const baseSel = buildRobustSelector(dropEl);
    if (baseSel) candidates.push(baseSel);

    return Array.from(new Set(candidates)).slice(0, 3).join(", ");
  }

  function buildDropTargetLabel(dropEl) {
    if (!dropEl) return "드롭 영역";
    const afNode =
      (dropEl.id && /^af_\\d+$/.test(dropEl.id) ? dropEl : null) ||
      (dropEl.closest && dropEl.closest("[id^='af_']"));
    const td = dropEl.closest && dropEl.closest("td");
    let ordText = "";
    if (td && td.parentElement) {
      const tds = Array.from(td.parentElement.children).filter(c => c.tagName === "TD");
      const idx = tds.indexOf(td);
      if (idx >= 1) ordText = idx + "번째 ";
    }
    const flowBox = (dropEl.closest && dropEl.closest("div.app_flow")) || dropEl;
    const strong = flowBox.querySelector && flowBox.querySelector("strong, .tit, th");
    const roleTxt = strong ? getCleanText(strong).slice(0, 12) : "";
    if (roleTxt) {
      return ordText + "'" + roleTxt + "' 결재칸" + (afNode && afNode.id ? " (#" + afNode.id + ")" : "");
    }
    if (afNode && afNode.id) {
      return ordText + "결재선 슬롯 (#" + afNode.id + ")";
    }
    return buildHumanLabel(dropEl);
  }

  function commitDragAndDrop(endX, endY, explicitTargetEl) {
    if (!dragSourceInfo) return false;
    if (Date.now() - lastCommitDragTime < 400) {
      dragSourceInfo = null;
      return false;
    }

    const useX = endX || dragSourceInfo.lastX || 0;
    const useY = endY || dragSourceInfo.lastY || 0;
    const dist = Math.hypot(useX - dragSourceInfo.startX, useY - dragSourceInfo.startY);
    if (!dragSourceInfo.isDragging && dist < 24 && !explicitTargetEl) {
      dragSourceInfo = null;
      return false;
    }

    const targetEl =
      (explicitTargetEl && !isSameOrSelfDropTarget(dragSourceInfo.el, explicitTargetEl) ? explicitTargetEl : null) ||
      resolveDropTargetAtPoint(useX, useY, dragSourceInfo.el) ||
      dragSourceInfo.lastDropEl;

    const srcInfo = dragSourceInfo;
    dragSourceInfo = null;

    if (!targetEl || isSameOrSelfDropTarget(srcInfo.el, targetEl)) return false;

    lastCommitDragTime = Date.now();
    flushPendingType();
    suppressClickUntil = Date.now() + 750;

    const targetSelector = buildDropTargetSelector(targetEl);
    const targetLabel = buildDropTargetLabel(targetEl);
    const iframe = getCurrentIframeSelector();
    const fullLabel = srcInfo.label + "을(를) " + targetLabel + "으로 드래그 앤 드롭";

    try {
      const topDoc = window.top.document;
      const hudStep = topDoc.getElementById("__sd_hud_last_step");
      if (hudStep) {
        hudStep.textContent = "최근 감지: ✊ " + fullLabel;
      }
    } catch (err) {}

    if (typeof window.__screenDemoRecordAction === "function") {
      window.__screenDemoRecordAction({
        kind: "dragAndDrop",
        selector: srcInfo.selector,
        sourceSelector: srcInfo.selector,
        targetSelector: targetSelector,
        targetHtml: extractTargetHtml(targetEl),
        iframe,
        tagName: (srcInfo.el.tagName || "div").toLowerCase(),
        label: fullLabel,
        pageUrl: location.href,
        inModal: Boolean(targetEl.closest && targetEl.closest(".ui-dialog, .modal"))
      });
    }
    return true;
  }

  // Hook jQuery UI droppable 'drop' & 'sortreceive' events directly if jQuery is present on page
  function ensureJqueryDropHook() {
    const $ = window.jQuery || window.$;
    if (!$ || window.__sdJqueryDropHooked) return;
    try {
      window.__sdJqueryDropHooked = true;
      $(document).on("drop", ".ui-droppable, .af_ul, .app_flow, [id^='af_']", function(event, ui) {
        const dropZone =
          (this.closest && this.closest("[id^='af_'], div.app_flow")) || this;
        if (!dragSourceInfo && ui && ui.helper) {
          const dtNode = ui.helper.data && ui.helper.data("dtSourceNode");
          const srcSpan = dtNode && dtNode.span ? dtNode.span.querySelector("a.dynatree-title") || dtNode.span : (ui.draggable && ui.draggable[0]);
          if (srcSpan) {
            dragSourceInfo = {
              el: srcSpan,
              selector: buildRobustSelector(srcSpan),
              label: buildHumanLabel(srcSpan),
              startX: 0,
              startY: 0,
              lastX: 100,
              lastY: 100,
              isDragging: true,
              lastDropEl: dropZone
            };
          }
        }
        if (dragSourceInfo) {
          dragSourceInfo.isDragging = true;
          commitDragAndDrop(dragSourceInfo.lastX, dragSourceInfo.lastY, dropZone);
        }
      });
    } catch (e) {}
  }
  setInterval(ensureJqueryDropHook, 1000);

  // Update Eyedropper box on mousemove + track live mouse drag (registered on window capture phase)
  window.addEventListener("mousemove", function(e) {
    // Check if user is holding left mouse button and dragging
    if (dragSourceInfo && (e.buttons & 1) === 1) {
      dragSourceInfo.lastX = e.clientX;
      dragSourceInfo.lastY = e.clientY;
      const dist = Math.hypot(e.clientX - dragSourceInfo.startX, e.clientY - dragSourceInfo.startY);
      if (dist >= 22) {
        dragSourceInfo.isDragging = true;
        const dropEl = resolveDropTargetAtPoint(e.clientX, e.clientY, dragSourceInfo.el);
        if (dropEl) {
          dragSourceInfo.lastDropEl = dropEl;
          const box = document.getElementById("__sd_eyedropper_box");
          const badge = document.getElementById("__sd_eyedropper_badge");
          if (box && badge && dropEl.getBoundingClientRect) {
            const rect = dropEl.getBoundingClientRect();
            box.style.display = "block";
            box.style.borderColor = "#f59e0b";
            box.style.background = "rgba(245, 158, 11, 0.16)";
            box.style.left = rect.left + "px";
            box.style.top = rect.top + "px";
            box.style.width = rect.width + "px";
            box.style.height = rect.height + "px";

            badge.style.display = "block";
            badge.style.borderColor = "#f59e0b";
            badge.style.color = "#fde047";
            badge.textContent = "✊ 드래그 중: " + dragSourceInfo.label + " ➔ " + buildDropTargetLabel(dropEl);
            badge.style.top = Math.max(4, rect.top - 28) + "px";
            badge.style.left = Math.min(window.innerWidth - 320, Math.max(4, rect.left)) + "px";
          }
        }
        return;
      }
    }

    if (!eyedropperHighlightEnabled) return;
    const rawTarget = e.target;
    if (!rawTarget || (rawTarget.closest && rawTarget.closest("#__sd_recorder_hud"))) {
      const box = document.getElementById("__sd_eyedropper_box");
      const badge = document.getElementById("__sd_eyedropper_badge");
      if (box) box.style.display = "none";
      if (badge) badge.style.display = "none";
      return;
    }

    let box = document.getElementById("__sd_eyedropper_box");
    let badge = document.getElementById("__sd_eyedropper_badge");
    if (!box || !badge) {
      setupVisualOverlays();
      box = document.getElementById("__sd_eyedropper_box");
      badge = document.getElementById("__sd_eyedropper_badge");
    }

    const el = resolveInteractiveElement(rawTarget);
    if (!el || !box || !badge || !el.getBoundingClientRect) return;

    const rect = el.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4 || rect.width > window.innerWidth * 0.95) {
      box.style.display = "none";
      badge.style.display = "none";
      return;
    }

    box.style.display = "block";
    box.style.borderColor = "#06b6d4";
    box.style.background = "rgba(6, 182, 212, 0.12)";
    box.style.left = rect.left + "px";
    box.style.top = rect.top + "px";
    box.style.width = rect.width + "px";
    box.style.height = rect.height + "px";

    const label = buildHumanLabel(el);
    const sel = buildRobustSelector(el).split(",")[0] || "";
    badge.style.display = "block";
    badge.style.borderColor = "#06b6d4";
    badge.style.color = "#38bdf8";
    badge.textContent = "💧 " + label + "  [" + sel.slice(0, 42) + "]";
    const badgeTop = Math.max(4, rect.top - 26);
    const badgeLeft = Math.min(window.innerWidth - 260, Math.max(4, rect.left));
    badge.style.top = badgeTop + "px";
    badge.style.left = badgeLeft + "px";

    // Live dwell-hover detection on hover-activated card containers (.app_work_box, li.aw_li)
    const hoverCard = rawTarget.closest && rawTarget.closest(".app_work_box, li.aw_li");
    if (hoverCard && hoverCard !== window.__sdLastHoveredCard) {
      window.__sdLastHoveredCard = hoverCard;
      if (window.__sdHoverTimer) clearTimeout(window.__sdHoverTimer);
      window.__sdHoverTimer = setTimeout(function() {
        if (window.__sdLastHoveredCard !== hoverCard) return;
        const cardTitEl = hoverCard.querySelector && (hoverCard.querySelector(".tit_box strong.tit, strong.tit") || hoverCard.querySelector(".tit, a._his"));
        const cardTit = cardTitEl ? getCleanText(cardTitEl).slice(0, 20).replace(/'/g, "") : "";
        const hoverDomPath = buildExactDomPathSelector(hoverCard, hoverCard.closest && hoverCard.closest(".ui-dialog, .modal, .layer_pop"));
        const hoverCandidates = [];
        if (cardTit) {
          hoverCandidates.push("ul.aw_ul li.aw_li:has-text('" + cardTit + "') .app_work_box:visible");
          hoverCandidates.push("li.aw_li:has-text('" + cardTit + "'):visible");
        }
        if (hoverDomPath) hoverCandidates.push(hoverDomPath);
        if (!cardTit) {
          hoverCandidates.push("ul.aw_ul li.aw_li .app_work_box:visible");
        }
        const hoverSelector = Array.from(new Set(hoverCandidates)).slice(0, 3).join(", ");
        const hoverLabel = (cardTit ? "'" + cardTit + "' 양식 카드" : "양식 카드") + "에 마우스 호버 (하위 [작성] 버튼 표시)";

        try {
          const topDoc = window.top.document;
          const hudStep = topDoc.getElementById("__sd_hud_last_step");
          if (hudStep) {
            hudStep.textContent = "최근 감지: 🖱️ " + hoverLabel;
          }
        } catch (err) {}

        if (typeof window.__screenDemoRecordAction === "function") {
          window.__sdLastRecordedHoverCard = hoverCard;
          window.__sdLastRecordedHoverTime = Date.now();
          window.__screenDemoRecordAction({
            kind: "hover",
            selector: hoverSelector,
            targetHtml: extractTargetHtml(hoverCard),
            iframe: getCurrentIframeSelector(),
            tagName: (hoverCard.tagName || "div").toLowerCase(),
            label: hoverLabel,
            pageUrl: location.href,
            inModal: Boolean(hoverCard.closest && hoverCard.closest(".ui-dialog, .modal, .layer_pop"))
          });
        }
      }, 400);
    } else if (!hoverCard && window.__sdLastHoveredCard) {
      window.__sdLastHoveredCard = null;
      if (window.__sdHoverTimer) {
        clearTimeout(window.__sdHoverTimer);
        window.__sdHoverTimer = null;
      }
    }
  }, true);

  // Capture typing on input / textarea / contenteditable / Synap Editor (.se-contents & .se-ime)
  function trackTypedElement(e) {
    const rawTarget = e && e.target;
    if (!rawTarget || (rawTarget.closest && rawTarget.closest("#__sd_recorder_hud"))) return;
    let t = rawTarget;
    if (t.classList && t.classList.contains("se-ime")) {
      const seRoot = t.closest(".se-main, .se-container, .editor_area, td, body") || document;
      const seCanvas = seRoot.querySelector && seRoot.querySelector("div.se-contents, [role='textbox'].se-contents");
      if (seCanvas) t = seCanvas;
    } else if (t.closest && t.closest("div.se-contents, [role='textbox'].se-contents")) {
      t = t.closest("div.se-contents, [role='textbox'].se-contents");
    }
    const tag = (t.tagName || "").toLowerCase();
    const isSeEditor = Boolean(t.classList && t.classList.contains("se-contents"));
    const isEditable = t.isContentEditable || isSeEditor || (tag === "body" && !isTopWindow);

    if (e && e.type === "keyup") {
      const k = e.key || "";
      // For single-line <input>, Enter was already flushed in keydown; for multi-line editors, allow keyup(Enter) so newlines are captured!
      if (
        (k === "Enter" && tag === "input") ||
        k === "Tab" ||
        k === "Escape" ||
        k === "Shift" ||
        k === "Control" ||
        k === "Alt" ||
        k === "Meta" ||
        k === "CapsLock" ||
        /^Arrow|^Page|^Home|^End|^F\\d+$/i.test(k)
      ) {
        return;
      }
    }

    if (tag === "input" || tag === "textarea" || isEditable) {
      const typeAttr = ((t.getAttribute && t.getAttribute("type")) || "").toLowerCase();
      if (
        typeAttr === "checkbox" ||
        typeAttr === "radio" ||
        typeAttr === "button" ||
        typeAttr === "submit" ||
        typeAttr === "reset" ||
        typeAttr === "file" ||
        typeAttr === "image" ||
        typeAttr === "hidden"
      ) {
        return;
      }
      const isDeletion = Boolean(
        e &&
          (e.key === "Backspace" ||
            e.key === "Delete" ||
            (e.inputType && String(e.inputType).indexOf("delete") === 0))
      );
      if (isDeletion) {
        lastTypedHadDeletion = true;
      }
      const newVal = readEditableValue(t, rawTarget, isDeletion);
      // If this exact element & value was already flushed (e.g. via Enter key), do NOT re-arm lastTypedElement unless user explicitly pressed Backspace/Delete!
      if (t === lastFlushedElement && newVal === lastFlushedValue && !isDeletion) {
        return;
      }
      if (lastTypedElement && lastTypedElement !== t) {
        flushPendingType();
      }
      lastTypedElement = t;
      lastTypedValue = newVal;

      try {
        const topDoc = window.top.document;
        const hudStep = topDoc.getElementById("__sd_hud_last_step");
        if (hudStep) {
          const lbl = buildHumanLabel(t);
          const previewVal = newVal
            ? "'" + newVal.replace(/\\n/g, "↵").slice(0, 20) + "'"
            : "내용 지움(⌫ 백스페이스)";
          hudStep.textContent = "최근 감지: ⌨️ " + lbl + " 입력 중: " + previewVal;
        }
      } catch (err) {}
    }
  }
  window.addEventListener("input", trackTypedElement, true);
  window.addEventListener("keyup", trackTypedElement, true);

  function saveAndRecordUploadedFiles(fileList, targetEl) {
    const files = fileList ? Array.from(fileList) : [];
    if (files.length === 0) return;
    flushAllFrames();
    const visualEl = resolveInteractiveElement(targetEl) || targetEl;
    const visualSel = buildRobustSelector(visualEl);
    let rawInputSel = "";
    if (targetEl && targetEl !== visualEl && (targetEl.tagName || "").toLowerCase() === "input") {
      const inpId = targetEl.getAttribute && targetEl.getAttribute("id");
      const inpName = targetEl.getAttribute && targetEl.getAttribute("name");
      if (inpId && isStableId(inpId)) {
        rawInputSel = "input#" + inpId;
      } else if (inpName && !/['"\\\\]/.test(inpName)) {
        rawInputSel = "input[type='file'][name='" + inpName + "']";
      } else {
        rawInputSel = "input[type='file']";
      }
    }
    const selector =
      rawInputSel && visualSel && visualSel.indexOf(rawInputSel) === -1
        ? visualSel + ", " + rawInputSel
        : visualSel || rawInputSel || ".fileinput-button:visible, input[type='file']";
    const label = buildHumanLabel(visualEl);
    const targetHtml = extractTargetHtml(visualEl);
    const iframe = getCurrentIframeSelector();
    const inModal = Boolean(targetEl && targetEl.closest && targetEl.closest(".ui-dialog, .modal, .layer_pop"));
    const fileNames = files.map(function(f) { return f.name; }).join(", ");

    try {
      const topDoc = window.top.document;
      const hudStep = topDoc.getElementById("__sd_hud_last_step");
      if (hudStep) {
        hudStep.textContent = "최근 감지: 📎 파일 첨부: '" + fileNames.slice(0, 28) + "'";
      }
    } catch (err) {}

    Promise.all(
      files.map(function(file) {
        return new Promise(function(resolve) {
          if (typeof window.__screenDemoSaveUploadedFile !== "function" || file.size > 30 * 1024 * 1024) {
            resolve(file.name);
            return;
          }
          const reader = new FileReader();
          reader.onload = function() {
            const dataUrl = String(reader.result || "");
            const commaIdx = dataUrl.indexOf(",");
            const base64 = commaIdx !== -1 ? dataUrl.slice(commaIdx + 1) : "";
            window
              .__screenDemoSaveUploadedFile({
                name: file.name,
                size: file.size,
                type: file.type || "",
                base64: base64
              })
              .then(function(savedPath) {
                resolve(savedPath || file.name);
              })
              .catch(function() {
                resolve(file.name);
              });
          };
          reader.onerror = function() {
            resolve(file.name);
          };
          reader.readAsDataURL(file);
        });
      })
    ).then(function(savedPaths) {
      if (typeof window.__screenDemoRecordAction === "function") {
        window.__screenDemoRecordAction({
          kind: "upload",
          selector: selector,
          targetHtml: targetHtml,
          iframe: iframe,
          tagName: "input",
          label: label + "에 '" + fileNames + "' 첨부",
          text: fileNames,
          filePath: savedPaths.join("|"),
          pageUrl: location.href,
          inModal: inModal
        });
      }
    });
  }

  window.addEventListener("change", function(e) {
    const t = e.target;
    if (!t || (t.closest && t.closest("#__sd_recorder_hud"))) return;
    const tag = (t.tagName || "").toLowerCase();
    if (tag === "input" && ((t.getAttribute && t.getAttribute("type")) || "").toLowerCase() === "file") {
      if (t.files && t.files.length > 0) {
        saveAndRecordUploadedFiles(t.files, t);
      }
      return;
    }
    if (tag === "select") {
      flushAllFrames();
      const selectedOpt = t.options && t.options[t.selectedIndex];
      const optText = selectedOpt ? (selectedOpt.text || t.value) : t.value;
      const selector = buildRobustSelector(t);
      const label = buildHumanLabel(t);
      const targetHtml = extractTargetHtml(t);
      const iframe = getCurrentIframeSelector();
      if (typeof window.__screenDemoRecordAction === "function") {
        window.__screenDemoRecordAction({
          kind: "click",
          selector,
          targetHtml,
          iframe,
          tagName: "select",
          label: label + "에서 '" + optText + "' 선택",
          text: optText,
          pageUrl: location.href,
          inModal: Boolean(t.closest && t.closest(".ui-dialog, .modal"))
        });
      }
      return;
    }
    if (t === lastTypedElement) {
      flushPendingType();
    }
  }, true);

  window.addEventListener("blur", function(e) {
    if (e.target && (e.target === lastTypedElement || e.target === window || e.target === document)) {
      flushPendingType();
    }
  }, true);

  // 1) Mouse & Pointer Drag & Drop (jQuery UI draggable / sortable / Dynatree / custom mouse drag)
  window.addEventListener("mousedown", function(e) {
    if (e.button !== 0) return;
    ensureJqueryDropHook();
    const rawTarget = e.target;
    if (!rawTarget || isDragHelperOrOverlay(rawTarget)) return;

    // Capture jQuery UI Datepicker / Timepicker selection on mousedown (since their popups close on mousedown before click fires)
    const pickerCell =
      rawTarget.closest &&
      rawTarget.closest("#ui-datepicker-div td a, .ui-datepicker td a, .ui-timepicker-list li, .ui-timepicker-wrapper li");
    if (pickerCell && e.isTrusted !== false && typeof window.__screenDemoRecordAction === "function") {
      const cellTxt = getCleanText(pickerCell).replace(/'/g, "").trim();
      if (cellTxt) {
        const isDateCell = Boolean(pickerCell.closest("#ui-datepicker-div, .ui-datepicker"));
        const pickerSel = isDateCell
          ? "#ui-datepicker-div:visible td a:text-is('" + cellTxt + "'):visible, .ui-datepicker:visible td a:text-is('" + cellTxt + "'):visible, #ui-datepicker-div:visible td a:has-text('" + cellTxt + "'):visible"
          : ".ui-timepicker-list:visible li:text-is('" + cellTxt + "'):visible, .ui-timepicker-wrapper:visible li:has-text('" + cellTxt + "'):visible";
        const pickerLabel = isDateCell
          ? "[달력 팝업] '" + cellTxt + "일' 날짜 클릭"
          : "[시간 선택] '" + cellTxt + "' 시간 클릭";
        suppressClickUntil = Date.now() + 250;
        window.__screenDemoRecordAction({
          kind: "click",
          selector: pickerSel,
          targetHtml: extractTargetHtml(pickerCell),
          iframe: getCurrentIframeSelector(),
          tagName: (pickerCell.tagName || "a").toLowerCase(),
          label: pickerLabel,
          text: cellTxt,
          pageUrl: location.href,
          inModal: true
        });
        return;
      }
    }

    const tag = (rawTarget.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return;

    // Snapshot rich editor paragraphs & clicked paragraph index BEFORE typing starts (and flush if moving to a different paragraph inside the same editor)
    const editorSurface =
      rawTarget.closest &&
      rawTarget.closest("div.se-contents, [role='textbox'].se-contents, [contenteditable='true']");
    if (editorSurface) {
      const clickedParaIdx = getClickedParagraphIndex(editorSurface, rawTarget, e.clientY);
      if (
        lastTypedElement === editorSurface &&
        lastTypedValue &&
        lastEditorClickedParaIndex !== undefined &&
        clickedParaIdx !== lastEditorClickedParaIndex
      ) {
        flushPendingType();
      }
      if (lastTypedElement !== editorSurface) {
        lastEditorBaselineElement = editorSurface;
        lastEditorBaselineParas = getEditorParagraphs(editorSurface);
        lastEditorClickedParaIndex = clickedParaIdx;
        const edRect = editorSurface.getBoundingClientRect ? editorSurface.getBoundingClientRect() : null;
        if (edRect && edRect.width > 0 && edRect.height > 0) {
          lastEditorClickOffset = {
            x: Math.max(8, Math.min(Math.round(edRect.width - 8), Math.round(e.clientX - edRect.left))),
            y: Math.max(8, Math.min(Math.round(edRect.height - 8), Math.round(e.clientY - edRect.top)))
          };
        } else {
          lastEditorClickOffset = undefined;
        }
      }
    }

    const srcEl = resolveDragSourceElement(rawTarget);
    if (!srcEl || !srcEl.tagName) return;

    dragSourceInfo = {
      el: srcEl,
      selector: buildRobustSelector(srcEl),
      label: buildHumanLabel(srcEl),
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
      isDragging: false,
      lastDropEl: null
    };
  }, true);

  window.addEventListener("mouseup", function(e) {
    if (!dragSourceInfo) return;
    commitDragAndDrop(e.clientX, e.clientY, null);
  }, true);

  // 2) HTML5 Drag & Drop (draggable="true" or <a href="#"> link drags firing dragstart / dragover / drop / dragend)
  window.addEventListener("dragstart", function(e) {
    const srcEl = resolveDragSourceElement(e.target);
    if (!srcEl) return;
    dragSourceInfo = {
      el: srcEl,
      selector: buildRobustSelector(srcEl),
      label: buildHumanLabel(srcEl),
      startX: e.clientX || 0,
      startY: e.clientY || 0,
      lastX: e.clientX || 0,
      lastY: e.clientY || 0,
      isDragging: true,
      lastDropEl: null
    };
  }, true);

  window.addEventListener("dragover", function(e) {
    if (!dragSourceInfo) return;
    dragSourceInfo.isDragging = true;
    if (e.clientX) dragSourceInfo.lastX = e.clientX;
    if (e.clientY) dragSourceInfo.lastY = e.clientY;
    const dropEl = resolveDropTargetAtPoint(e.clientX, e.clientY, dragSourceInfo.el);
    if (dropEl) {
      dragSourceInfo.lastDropEl = dropEl;
      const box = document.getElementById("__sd_eyedropper_box");
      const badge = document.getElementById("__sd_eyedropper_badge");
      if (box && badge && dropEl.getBoundingClientRect) {
        const rect = dropEl.getBoundingClientRect();
        box.style.display = "block";
        box.style.borderColor = "#f59e0b";
        box.style.background = "rgba(245, 158, 11, 0.16)";
        box.style.left = rect.left + "px";
        box.style.top = rect.top + "px";
        box.style.width = rect.width + "px";
        box.style.height = rect.height + "px";
        badge.style.display = "block";
        badge.style.borderColor = "#f59e0b";
        badge.style.color = "#fde047";
        badge.textContent = "✊ 드래그 중: " + dragSourceInfo.label + " ➔ " + buildDropTargetLabel(dropEl);
        badge.style.top = Math.max(4, rect.top - 28) + "px";
        badge.style.left = Math.min(window.innerWidth - 320, Math.max(4, rect.left)) + "px";
      }
    }
  }, true);

  window.addEventListener("drop", function(e) {
    if (!dragSourceInfo && e && e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const dropTarget = e.target;
      const attachContainer =
        (dropTarget &&
          dropTarget.closest &&
          dropTarget.closest(".fileupload_manger, .attach_atch_box, .multi_upload_box, .fileupload-buttonbar, form, body")) ||
        document;
      const fileInp =
        (attachContainer.querySelector && attachContainer.querySelector("input[type='file']")) || dropTarget;
      saveAndRecordUploadedFiles(e.dataTransfer.files, fileInp);
      return;
    }
    if (!dragSourceInfo) return;
    commitDragAndDrop(e.clientX || dragSourceInfo.lastX, e.clientY || dragSourceInfo.lastY, null);
  }, true);

  window.addEventListener("dragend", function(e) {
    if (!dragSourceInfo) return;
    commitDragAndDrop(dragSourceInfo.lastX || e.clientX, dragSourceInfo.lastY || e.clientY, dragSourceInfo.lastDropEl);
  }, true);

  let lastClickedLabelEl = null;
  let lastClickedLabelTime = 0;

  // Capture clicks (on click in capture phase, ignoring clicks suppressed by a completed drag-and-drop)
  window.addEventListener("click", function(e) {
    if (e.isTrusted === false) {
      return;
    }
    if (Date.now() < suppressClickUntil) {
      return;
    }
    const rawTarget = e.target;
    if (!rawTarget || (rawTarget.closest && rawTarget.closest("#__sd_recorder_hud"))) return;

    // If user was typing into a DIFFERENT element (including in another iframe), flush the typed text first!
    const el = resolveInteractiveElement(rawTarget);
    flushAllFrames(el);

    if (!el || !el.tagName) return;
    const tag = el.tagName.toLowerCase();

    // Suppress the browser's automatic <label> -> <input type="checkbox"|"radio"> synthetic second click event (both nested <label><input></label> and sibling <input id="x"><label for="x">)
    if (
      tag === "label" &&
      ((el.querySelector && el.querySelector("input[type='checkbox'], input[type='radio']")) ||
        el.getAttribute("for"))
    ) {
      lastClickedLabelEl = el;
      lastClickedLabelTime = Date.now();
    } else if (
      tag === "input" &&
      lastClickedLabelEl &&
      Date.now() - lastClickedLabelTime < 300 &&
      (lastClickedLabelEl.contains(el) ||
        (el.id && lastClickedLabelEl.getAttribute("for") === el.id) ||
        (lastClickedLabelEl.parentElement && lastClickedLabelEl.parentElement === el.parentElement))
    ) {
      return;
    }

    // Ignore clicks on pure layout wrappers or hidden search option containers (body/html/wide layout divs/articles without onclick, role, hook class, or pointer cursor)
    if (tag === "html") return;
    if (tag === "body" && !el.isContentEditable) return;
    if (el.id === "eapHeader_option" || (el.classList && el.classList.contains("_search_option_hide"))) return;
    const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : { width: 0, height: 0 };
    const isClickableCustomDiv =
      tag === "div" &&
      ((el.classList &&
        Array.from(el.classList).some(function(c) {
          return /^_[a-zA-Z0-9_-]+$/.test(c) || /^(Selected|select_Value|sp-replacer|btn|ico|tab|swatch|plt_|scvr|app_work_box)/i.test(c);
        })) ||
        (rect.width > 0 &&
          rect.width <= 320 &&
          rect.height > 0 &&
          rect.height <= 120 &&
          window.getComputedStyle &&
          window.getComputedStyle(el).cursor === "pointer"));
    if (
      !isClickableCustomDiv &&
      (tag === "div" || tag === "section" || tag === "article" || tag === "main" || tag === "aside" || tag === "form" || tag === "header" || tag === "ul" || tag === "nav") &&
      (rect.width > 240 || (rect.width === 0 && rect.height === 0)) &&
      !el.getAttribute("onclick") &&
      !el.getAttribute("role")
    ) {
      return;
    }

    const selector = buildRobustSelector(el);
    const label = buildHumanLabel(el);
    const targetHtml = extractTargetHtml(el);
    const iframe = getCurrentIframeSelector();
    const inModal = Boolean(el.closest && el.closest(".ui-dialog, .modal, .layer_pop"));

    // Detect if the clicked element is a hover-revealed button inside a card/row (e.g. li.aw_li > div.app_work_box > div.write > button.btn_write)
    const hoverCardEl =
      (el.classList && el.classList.contains("btn_write") && el.closest && el.closest(".app_work_box, li.aw_li")) ||
      (el.closest && el.closest(".write.btn_group, .hover_btn, .card_hover") && el.closest(".app_work_box, li.aw_li, .card_item, .card_box, li, tr"));

    const alreadyRecordedHoverForCard =
      hoverCardEl &&
      window.__sdLastRecordedHoverCard &&
      (window.__sdLastRecordedHoverCard === hoverCardEl ||
        (window.__sdLastRecordedHoverCard.contains && window.__sdLastRecordedHoverCard.contains(hoverCardEl)) ||
        (hoverCardEl.contains && hoverCardEl.contains(window.__sdLastRecordedHoverCard))) &&
      Date.now() - (window.__sdLastRecordedHoverTime || 0) < 15000;

    if (hoverCardEl && !alreadyRecordedHoverForCard && typeof window.__screenDemoRecordAction === "function") {
      const cardTitEl = hoverCardEl.querySelector && (hoverCardEl.querySelector(".tit_box strong.tit, strong.tit") || hoverCardEl.querySelector(".tit, a._his"));
      const cardTit = cardTitEl ? getCleanText(cardTitEl).slice(0, 20).replace(/'/g, "") : "";
      const hoverDomPath = buildExactDomPathSelector(hoverCardEl, el.closest && el.closest(".ui-dialog, .modal, .layer_pop"));
      const hoverCandidates = [];
      if (cardTit) {
        hoverCandidates.push("ul.aw_ul li.aw_li:has-text('" + cardTit + "') .app_work_box:visible");
        hoverCandidates.push("li.aw_li:has-text('" + cardTit + "'):visible");
      }
      if (hoverDomPath) hoverCandidates.push(hoverDomPath);
      if (!cardTit) {
        hoverCandidates.push("ul.aw_ul li.aw_li .app_work_box:visible");
      }
      const hoverSelector = Array.from(new Set(hoverCandidates)).slice(0, 3).join(", ");
      const hoverLabel = (cardTit ? "'" + cardTit + "' 양식 카드" : "양식 카드") + "에 마우스 호버 (하위 [작성] 버튼 표시)";

      window.__sdLastRecordedHoverCard = hoverCardEl;
      window.__sdLastRecordedHoverTime = Date.now();
      window.__screenDemoRecordAction({
        kind: "hover",
        selector: hoverSelector,
        targetHtml: extractTargetHtml(hoverCardEl),
        iframe,
        tagName: (hoverCardEl.tagName || "div").toLowerCase(),
        label: hoverLabel,
        pageUrl: location.href,
        inModal
      });
    }

    // Update HUD text if in top window
    try {
      const topDoc = window.top.document;
      const hudStep = topDoc.getElementById("__sd_hud_last_step");
      if (hudStep) {
        hudStep.textContent = "최근 감지: " + label;
      }
    } catch (err) {}

    if (typeof window.__screenDemoRecordAction === "function") {
      window.__screenDemoRecordAction({
        kind: "click",
        selector,
        targetHtml,
        iframe,
        tagName: tag,
        label,
        pageUrl: location.href,
        inModal
      });
    }
  }, true);

  // Capture Backspace/Delete clearing and Enter key submission inside input / editor fields
  document.addEventListener("keydown", function(e) {
    if (!e) return;
    const rawTarget = e.target;
    if (!rawTarget || (rawTarget.closest && rawTarget.closest("#__sd_recorder_hud"))) return;
    let t = rawTarget;
    if (t.classList && t.classList.contains("se-ime")) {
      const seRoot = t.closest(".se-main, .se-container, .editor_area, td, body") || document;
      const seCanvas = seRoot.querySelector && seRoot.querySelector("div.se-contents, [role='textbox'].se-contents");
      if (seCanvas) t = seCanvas;
    } else if (t.closest && t.closest("div.se-contents, [role='textbox'].se-contents")) {
      t = t.closest("div.se-contents, [role='textbox'].se-contents");
    }
    const tag = (t && t.tagName ? t.tagName : "").toLowerCase();
    const isSeEditor = Boolean(t && t.classList && t.classList.contains("se-contents"));
    const isEditable = Boolean(t && (t.isContentEditable || isSeEditor || (tag === "body" && !isTopWindow)));
    const isInputField = tag === "input" || tag === "textarea" || isEditable;

    if (isEditable && lastTypedElement !== t && lastEditorBaselineElement !== t) {
      lastEditorBaselineElement = t;
      lastEditorBaselineParas = getEditorParagraphs(t);
    }

    if ((e.key === "Backspace" || e.key === "Delete") && isInputField) {
      const typeAttr = ((t.getAttribute && t.getAttribute("type")) || "").toLowerCase();
      if (
        typeAttr === "checkbox" ||
        typeAttr === "radio" ||
        typeAttr === "button" ||
        typeAttr === "submit" ||
        typeAttr === "reset" ||
        typeAttr === "file" ||
        typeAttr === "image" ||
        typeAttr === "hidden"
      ) {
        return;
      }
      if (lastTypedElement && lastTypedElement !== t) {
        flushPendingType();
      }
      lastTypedElement = t;
      lastTypedHadDeletion = true;
      setTimeout(function() {
        if (lastTypedElement === t) {
          lastTypedValue = readEditableValue(t, rawTarget, true);
        }
      }, 0);
      return;
    }

    if (e.key === "Enter") {
      // Only flush on Enter for single-line <input>; for <textarea>/contenteditable/.se-contents, Enter inserts a newline
      if (tag === "input") {
        const typeAttr = ((t.getAttribute && t.getAttribute("type")) || "").toLowerCase();
        if (
          typeAttr === "checkbox" ||
          typeAttr === "radio" ||
          typeAttr === "button" ||
          typeAttr === "submit" ||
          typeAttr === "reset" ||
          typeAttr === "file" ||
          typeAttr === "image" ||
          typeAttr === "hidden"
        ) {
          return;
        }
        if (lastTypedElement && lastTypedElement !== t) {
          flushPendingType();
        }
        lastTypedElement = t;
        const curVal = readEditableValue(t, rawTarget, false);
        if (curVal || !lastTypedValue) {
          lastTypedValue = curVal;
        }
        lastTypedPressEnter = true;
        flushPendingType();
      }
    }
  }, true);
})();
`;
}

/**
 * Converts raw user demonstration events captured by the Eyedropper Recorder
 * into a clean, well-paced BrowsePlan + Canonical Arrow-Chain Prompt.
 * Preserves 100% of captured DOM selectors & iframes while using AI (or deterministic director rules)
 * to polish descriptions and insert appropriate wait steps between transitions.
 */
async function refineRecordedEventsIntoPlan(
  events: RecordedRawEvent[],
  targetUrl: string,
  _customTitleHint?: string,
  slugHint?: string,
  directingStyle: "standard" | "fast" | "detailed" = "standard"
): Promise<{
  plan: BrowsePlan;
  suggestedSlug: string;
  canonicalPrompt: string;
  explanation: string;
}> {
  const paceMultiplier = directingStyle === "fast" ? 0.7 : directingStyle === "detailed" ? 1.4 : 1.0;
  const scaleMs = (baseMs: number) => Math.round((baseMs * paceMultiplier) / 100) * 100;

  // 1. Build deterministic baseline actions preserving exact captured selectors & iframes
  const actions: BrowsePlanAction[] = [
    {
      type: "wait",
      ms: scaleMs(1500),
      description: "초기 그룹웨어 메인 화면 렌더링 및 상태 안정화 대기",
    },
  ];

  const promptSteps: string[] = [];

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];

    if (ev.kind === "hover") {
      const desc = `${ev.label}`;
      promptSteps.push(desc);
      actions.push({
        type: "hover",
        selector: ev.selector,
        iframe: ev.iframe,
        description: desc,
        recordedByEyedropper: true,
        targetHtml: ev.targetHtml,
      });
      actions.push({
        type: "wait",
        ms: scaleMs(600),
        description: "마우스 호버 후 하위 버튼 노출 대기",
      });
    } else if (ev.kind === "dragAndDrop" && ev.sourceSelector && ev.targetSelector) {
      const desc = `${ev.label}`;
      promptSteps.push(desc);
      actions.push({
        type: "dragAndDrop",
        sourceSelector: ev.sourceSelector,
        targetSelector: ev.targetSelector,
        iframe: ev.iframe,
        description: desc,
        recordedByEyedropper: true,
        targetHtml: ev.targetHtml,
      });
      actions.push({
        type: "wait",
        ms: scaleMs(1200),
        description: "드래그 앤 드롭 반영 대기",
      });
    } else if (ev.kind === "type" && ev.text !== undefined) {
      const formattedText = ev.text.replace(/\n/g, " ↵ ");
      const desc =
        ev.text === ""
          ? `${ev.label} 내용 지우기 (백스페이스)${ev.pressEnter ? " 후 엔터(Enter)" : ""}`
          : `${ev.label}에 '${formattedText}' 입력${ev.pressEnter ? " 후 엔터(Enter)" : ""}`;
      promptSteps.push(desc);
      actions.push({
        type: "type",
        selector: ev.selector,
        iframe: ev.iframe,
        text: ev.text,
        ...(ev.pressEnter ? { pressEnter: true } : {}),
        ...(ev.editorParaIndex !== undefined ? { editorParaIndex: ev.editorParaIndex } : {}),
        ...(ev.editorInsertNewline ? { editorInsertNewline: true } : {}),
        ...(ev.cursorOffset ? { cursorOffset: ev.cursorOffset } : {}),
        description: desc,
        recordedByEyedropper: true,
        targetHtml: ev.targetHtml,
      });
      actions.push({
        type: "wait",
        ms: scaleMs(900),
        description: "입력 텍스트 확인 여유 대기",
      });
    } else if (ev.kind === "upload") {
      const fileLabel = ev.text || (ev.filePath ? path.basename(ev.filePath.split("|")[0]) : "첨부파일");
      const desc = ev.label.includes("첨부") ? ev.label : `${ev.label}에 '${fileLabel}' 파일 첨부`;
      promptSteps.push(desc);
      actions.push({
        type: "upload",
        selector: ev.selector,
        iframe: ev.iframe,
        filePath: ev.filePath || ev.text,
        text: fileLabel,
        description: desc,
        recordedByEyedropper: true,
        targetHtml: ev.targetHtml,
      });
      actions.push({
        type: "wait",
        ms: scaleMs(1400),
        description: "첨부 파일 업로드 및 목록 반영 대기",
      });
    } else {
      // If a native <select> was clicked to open the dropdown and immediately followed by selecting an option (change event),
      // skip the bare opening click so Playwright directly executes selectOption(...) on the <select>.
      if (ev.tagName === "select" && !ev.text && events[i + 1]?.tagName === "select" && events[i + 1]?.text) {
        continue;
      }

      // Safety net: if a click targets a hover-revealed card button (ONLY inside .app_work_box / li.aw_li, never generic btn_write!)
      // and the preceding event was not already a hover, automatically insert the hover + wait steps before the click!
      const prevEv = i > 0 ? events[i - 1] : null;
      const isHoverRevealedClick =
        ((ev.selector.includes("btn_write") || ev.selector.includes("button")) &&
          (ev.selector.includes(".app_work_box") || ev.selector.includes("aw_li"))) ||
        (ev.label.includes("양식 카드") && ev.label.includes("작성"));

      if (isHoverRevealedClick && (!prevEv || prevEv.kind !== "hover")) {
        const cardTitleMatch = ev.selector.match(/has-text\(['"]([^'"]+)['"]\)/) || ev.label.match(/['"]([^'"]+)['"]/);
        const cardTitle = cardTitleMatch ? cardTitleMatch[1].trim() : "";
        const hoverSel = cardTitle && cardTitle !== "작성"
          ? `ul.aw_ul li.aw_li:has-text('${cardTitle}') .app_work_box:visible, li.aw_li:has-text('${cardTitle}'):visible, ul.aw_ul li.aw_li .app_work_box:visible`
          : `ul.aw_ul li.aw_li .app_work_box:visible, .app_work_box:visible`;
        const hoverDesc = `${cardTitle && cardTitle !== "작성" ? `'${cardTitle}' ` : ""}양식 카드에 마우스 호버 (하위 [작성] 버튼 표시)`;
        promptSteps.push(hoverDesc);
        actions.push({
          type: "hover",
          selector: hoverSel,
          iframe: ev.iframe,
          description: hoverDesc,
          recordedByEyedropper: true,
        });
        actions.push({
          type: "wait",
          ms: scaleMs(600),
          description: "마우스 호버 후 [작성] 버튼 표시 대기",
        });
      }

      const desc = ev.label.endsWith("선택") ? ev.label : `${ev.label} 클릭`;
      promptSteps.push(desc);
      actions.push({
        type: "click",
        selector: ev.selector,
        iframe: ev.iframe,
        ...(ev.text ? { text: ev.text } : {}),
        description: desc,
        recordedByEyedropper: true,
        targetHtml: ev.targetHtml,
      });

      // Determine smart wait duration based on whether this click opens a modal, navigates, or submits
      const isHeavyTransition =
        /작성|등록|상신|저장|발송|결재분류|결재선|검색|전자결재|일정관리|자원예약|문서관리|게시판|공지사항|전자우편|받은메일|사내쪽지|쪽지쓰기|메일\s*쓰기|위키|스마트워크|주소록|조직도|확인/.test(ev.label) ||
        Boolean(ev.targetHtml && /GwMainMenu\.fn\.goPage|GwMainMenu\.fn\.openDropMenu/i.test(ev.targetHtml));
      actions.push({
        type: "wait",
        ms: scaleMs(isHeavyTransition ? 1600 : 1000),
        description: isHeavyTransition ? `${ev.label} 클릭 후 화면/팝업 전환 대기` : `${ev.label} 반응 대기`,
      });
    }
  }

  actions.push({
    type: "wait",
    ms: scaleMs(2000),
    description: "최종 시연 결과 화면 클로즈업 확인 대기",
  });

  const canonicalPrompt = promptSteps.join(" -> ");
  let suggestedSlug = (slugHint || "").trim();
  const explanation = `💧 [스포이드 시범 감지 완료] 사용자가 브라우저에서 직접 시연한 ${events.length}개의 실제 동작(클릭·호버·입력·드래그)에서 실제 HTML 태그 속성과 DOM 트리 경로를 추출하여 즉시 촬영 대본으로 변환했습니다.`;

  if (!suggestedSlug) {
    suggestedSlug = `live-demo-${Date.now().toString().slice(-6)}`;
  }

  const rawPlan: BrowsePlan = {
    url: targetUrl,
    viewport: { width: 1920, height: 1080 },
    requiresLogin: true,
    recordedByEyedropper: true,
    actions,
  };

  const { plan: sanitizedPlan } = sanitizeBrowsePlan(rawPlan);

  return {
    plan: sanitizedPlan,
    suggestedSlug,
    canonicalPrompt,
    explanation,
  };
}

import { chromium, Browser, BrowserContext } from "playwright";
import { GoogleGenAI } from "@google/genai";
import * as fs from "fs";
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
  kind: "click" | "hover" | "type" | "dragAndDrop" | "select" | "scroll";
  selector: string;
  sourceSelector?: string;
  targetSelector?: string;
  targetHtml?: string;
  iframe?: string;
  tagName: string;
  label: string;
  text?: string;
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
  private active = false;
  private finishedByBrowserHud = false;
  private targetUrl = "";
  private slug = "";
  private events: RecordedRawEvent[] = [];
  private statusMessage = "대기 중";
  private eventListeners = new Set<(status: RecorderSessionStatus) => void>();

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

      // If user clicked an input field and immediately typed into the same input field,
      // upgrade the preceding click into the type event so we don't have redundant click + type
      if (
        raw.kind === "type" &&
        last.kind === "click" &&
        last.selector === raw.selector &&
        (last.tagName === "input" || last.tagName === "textarea" || last.tagName === "body")
      ) {
        last.kind = "type";
        last.text = raw.text;
        last.label = raw.label;
        last.timestamp = now;
        this.statusMessage = `⌨️ 입력 감지: "${raw.text}" (${raw.label})`;
        this.notifyListeners();
        return;
      }

      // If multiple type events on the same selector happen consecutively, update with the latest final text
      if (raw.kind === "type" && last.kind === "type" && last.selector === raw.selector) {
        last.text = raw.text;
        last.label = raw.label;
        last.timestamp = now;
        this.statusMessage = `⌨️ 입력 갱신: "${raw.text}" (${raw.label})`;
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

      // Ignore accidental double-fire on the exact same click selector within 300ms
      if (
        raw.kind === "click" &&
        last.kind === "click" &&
        last.selector === raw.selector &&
        now - last.timestamp < 300
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
        : "🖱️ 동작";
    this.statusMessage = `${icon} #${evt.seq}: ${evt.label}${evt.text ? ` ('${evt.text}')` : ""}`;
    console.log(`[Live Action Recorder] ${this.statusMessage} -> ${evt.selector}${evt.iframe ? ` [iframe: ${evt.iframe}]` : ""}`);
    this.notifyListeners();
  }

  /**
   * Starts an interactive Headed Chromium browser with Eyedropper highlight & live DOM action capture.
   */
  public async startRecordingSession(options?: {
    url?: string;
    slug?: string;
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

    this.browser = await chromium.launch({
      headless: false,
      args: ["--start-maximized", "--disable-blink-features=AutomationControlled"],
    });

    this.context = await this.browser.newContext({
      viewport: { width: 1920, height: 1080 },
      storageState: hasValidAuth ? existingAuth! : undefined,
    });

    // Auto-accept any native JS alert/confirm during user demonstration so it never blocks
    this.context.on("page", (p) => {
      p.on("dialog", async (dialog) => {
        console.log(`[Live Action Recorder] 브라우저 알림창 자동 수락: "${dialog.message()}"`);
        await dialog.accept().catch(() => {});
      });
    });

    // Expose Node bindings to all frames (main page + iframes + popups)
    await this.context.exposeBinding(
      "__screenDemoRecordAction",
      (_source, payload: Omit<RecordedRawEvent, "seq" | "timestamp">) => {
        if (!this.active || !payload) return;
        this.recordRawEvent(payload);
      }
    );

    await this.context.exposeBinding("__screenDemoFinishSession", async () => {
      if (!this.active) return;
      console.log(`[Live Action Recorder] 사용자가 브라우저 HUD에서 [시범 완료] 버튼을 클릭했습니다.`);
      this.finishedByBrowserHud = true;
      this.notifyListeners();
      await this.stopRecordingSession(true);
    });

    const injectedScriptContent = getInjectedEyedropperScript();

    // Inject Eyedropper + Action Listener into every frame (top window + nested iframes)
    await this.context.addInitScript({
      content: injectedScriptContent,
    });

    const page = await this.context.newPage();

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

    const refined = await refineRecordedEventsIntoPlan(
      capturedEvents,
      targetBaseUrl,
      options?.customTitleHint,
      options?.slug || this.slug,
      options?.directingStyle
    );

    return {
      events: capturedEvents,
      ...refined,
    };
  }

  public async stopRecordingSession(saveAuth = true): Promise<RecordedRawEvent[]> {
    const captured = [...this.events];
    this.active = false;
    this.statusMessage = `✅ 총 ${captured.length}개 동작 캡처 완료. 시나리오 정제 대기 중...`;

    if (saveAuth && this.context) {
      try {
        const authPath = getAuthFilePath(this.slug || undefined);
        await this.context.storageState({ path: authPath });
        syncAuthSession(authPath);
      } catch {}
    }

    await this.cleanupBrowser();
    return captured;
  }

  private async cleanupBrowser() {
    this.active = false;
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
function getInjectedEyedropperScript(): string {
  return `
(function() {
  if (window.__sdEyedropperInstalled) return;
  window.__sdEyedropperInstalled = true;

  const isTopWindow = (window === window.top);
  let eyedropperHighlightEnabled = true;
  let lastTypedElement = null;
  let lastTypedValue = "";
  let dragSourceInfo = null;

  // Determine iframe selector if running inside an iframe
  function getCurrentIframeSelector() {
    if (isTopWindow) return undefined;
    try {
      const fe = window.frameElement;
      if (!fe) return "iframe#subBody, iframe#contentFrame, iframe";
      if (fe.id) return "iframe#" + fe.id;
      if (fe.getAttribute("name")) return "iframe[name='" + fe.getAttribute("name") + "']";
      return "iframe#subBody, iframe#contentFrame, iframe";
    } catch (e) {
      return "iframe#subBody, iframe#contentFrame, iframe";
    }
  }

  // Check if an ID looks auto-generated / unstable (e.g. ui-id-14, jqg123, ext-gen102)
  function isStableId(id) {
    if (!id || typeof id !== "string") return false;
    if (/^(ui-id-|jqg|ext-gen|select2-|mceu_|cke_|tinymce)/i.test(id)) return false;
    if (/^[0-9]+$/.test(id)) return false;
    // Long random hex/uuid suffix
    if (/[0-9a-f]{8,}/i.test(id)) return false;
    return true;
  }

  // Clean visible text of an element
  function getCleanText(el) {
    if (!el) return "";
    const raw = (el.innerText || el.textContent || el.value || el.getAttribute("title") || el.getAttribute("placeholder") || el.getAttribute("alt") || "").trim();
    return raw.replace(/\\s+/g, " ").slice(0, 40);
  }

  // Find nearest interactive element (button, a, input, label, tree node, work card, etc.)
  function resolveInteractiveElement(target) {
    if (!target || !target.closest) return target;
    const interactive = target.closest(
      "button, a, input, textarea, select, label, .dynatree-title, .dynatree-checkbox, .fancytree-title, [role='button'], [role='tab'], [onclick], .app_work_box, li.aw_li, li.card_item, tr.lst_tr, th, td"
    );
    return interactive || target;
  }

  // Extract concise HTML snippet of the target element (opening tag + text + closing tag)
  function extractTargetHtml(rawEl) {
    const el = resolveInteractiveElement(rawEl);
    if (!el || !el.outerHTML) return "";
    const raw = el.outerHTML.replace(/\\s+/g, " ").trim();
    if (raw.length <= 180) return raw;
    const openTagMatch = raw.match(/^<[^>]+>/);
    const openTag = openTagMatch ? openTagMatch[0].slice(0, 140) : "<" + (el.tagName || "el").toLowerCase() + ">";
    const txt = getCleanText(el).slice(0, 30);
    return openTag + txt + "</" + (el.tagName || "el").toLowerCase() + ">";
  }

  // Filter meaningful CSS classes on an element (ignoring transient hover/active/jQuery/Dynatree state classes)
  function getMeaningfulClasses(el, maxCount) {
    if (!el || !el.classList || el.classList.length === 0) return [];
    return Array.from(el.classList)
      .filter(function(c) {
        return (
          c &&
          !/^(active|selected|on|hover|focus|open|opened|closed|collapsed|expanded|disabled|checked)$/i.test(c) &&
          !/^(ui-state-|ui-corner-|ui-widget|ui-draggable|ui-droppable|ui-sortable|dynatree-(focused|active|selected|expanded|has-children|folder|lastsib|partsel|loading|statusnode|exp-|ico-)|fancytree-(focused|active|selected|expanded|has-children|folder|lastsib|partsel|loading|statusnode|exp-|ico-))/i.test(c)
        );
      })
      .slice(0, maxCount || 2);
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

      const clsList = getMeaningfulClasses(cur, 2);
      let step = curTag + (clsList.length > 0 ? "." + clsList.join(".") : "");

      // Check data-* attributes on cur if it has a distinguishing attribute
      const dataAttrs = ["data-app-type-ordr", "data-work-id", "data-res-id", "data-dept-id", "data-emp-id", "data-cmp-id", "data-cal-id", "data-brd-id", "data-id", "data-key", "data-value", "data-trgt-id", "data-menu-id"];
      for (let i = 0; i < dataAttrs.length; i++) {
        const attrName = dataAttrs[i];
        const attrVal = cur.getAttribute(attrName);
        if (attrVal && attrVal.length <= 35 && !/['"\\\\]/.test(attrVal)) {
          step += "[" + attrName + "='" + attrVal + "']";
          break;
        }
      }

      // Disambiguate among same-tag siblings
      const parent = cur.parentElement;
      if (parent) {
        const sameTagSiblings = Array.from(parent.children).filter(function(ch) {
          return ch.tagName === cur.tagName;
        });
        if (sameTagSiblings.length > 1) {
          // For list/tree/table rows that contain a specific named title, prefer scoping by that row's title text
          // only if it's a dynatree-node or template card; otherwise use exact :nth-of-type(n) position in HTML!
          const isTreeNode = cur.classList && (cur.classList.contains("dynatree-node") || cur.classList.contains("aw_li"));
          const titleNode = isTreeNode ? cur.querySelector(".dynatree-title, strong.tit, .tit") : null;
          const nodeTxt = titleNode ? getCleanText(titleNode).slice(0, 20).replace(/'/g, "") : "";
          if (isTreeNode && nodeTxt) {
            step += ":has-text('" + nodeTxt + "')";
          } else {
            const nth = sameTagSiblings.indexOf(cur) + 1;
            if (nth > 0) {
              step += ":nth-of-type(" + nth + ")";
            }
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

    // 1. Check distinguishing data-* attributes on the element itself
    if (el.attributes) {
      for (let i = 0; i < el.attributes.length; i++) {
        const attr = el.attributes[i];
        if (!attr || !attr.name || !attr.value) continue;
        if (
          /^data-(work-id|app-type-ordr|res-id|dept-id|emp-id|cmp-id|cal-id|brd-id|id|key|value|trgt-id|doc-id|menu-id|fld-id|cl-id|role|action|type|code)$/i.test(attr.name) &&
          attr.value.length <= 40 &&
          !/['"\\\\]/.test(attr.value)
        ) {
          results.push(scopePrefix + tag + "[" + attr.name + "='" + attr.value + "']:visible");
        }
      }
    }

    // 2. Check name / onclick / value attributes
    const nameAttr = el.getAttribute("name") || "";
    if (nameAttr && !/['"\\\\]/.test(nameAttr)) {
      results.push(scopePrefix + tag + "[name='" + nameAttr + "']:visible");
    }

    const onclickAttr = (el.getAttribute("onclick") || "").trim();
    if (
      onclickAttr &&
      onclickAttr.length <= 45 &&
      !/['"\\\\]/.test(onclickAttr) &&
      !/^(javascript:|return\\s+(false|true)|void\\s*\\(0\\))/i.test(onclickAttr)
    ) {
      results.push(scopePrefix + tag + "[onclick*='" + onclickAttr.slice(0, 25) + "']:visible");
    }

    const valueAttr = el.getAttribute("value") || "";
    const typeAttr = (el.getAttribute("type") || "").toLowerCase();
    if (
      valueAttr &&
      valueAttr.length <= 20 &&
      !/['"\\\\]/.test(valueAttr) &&
      (tag === "button" || typeAttr === "button" || typeAttr === "submit" || typeAttr === "radio" || typeAttr === "checkbox")
    ) {
      results.push(scopePrefix + tag + "[value='" + valueAttr + "']:visible");
    }

    return results;
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
    const text = getCleanText(el);

    const modalEl = el.closest(".ui-dialog, .modal, .layer_pop, [role='dialog']");
    const datepickerEl = el.closest(".ui-datepicker, #ui-datepicker-div");
    const workCardEl = el.closest("li.aw_li, .app_work_box");
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
    } else if (workCardEl) {
      scopePrefix = ".app_work_box ";
    } else if (snbEl) {
      scopePrefix = "#snb ";
    } else if (headerEl) {
      scopePrefix = "#header ";
    }

    const candidates = [];

    // 1. Stable HTML ID (Highest priority)
    if (isStableId(id)) {
      candidates.push((modalEl ? ".ui-dialog:visible " : "") + tag + "#" + id + ":visible");
      if (!modalEl) {
        candidates.push("#" + id + ":visible");
      }
    }

    // 2. Exact HTML Attributes (data-*, name, value, onclick)
    const htmlAttrSelectors = buildExactHtmlAttributeSelector(el, scopePrefix);
    for (let i = 0; i < htmlAttrSelectors.length; i++) {
      candidates.push(htmlAttrSelectors[i]);
    }

    // 3. Tree node (.dynatree-title): prioritize exact [title='...'] path and :text-is('...') over substring :has-text('...')
    if (el.classList && el.classList.contains("dynatree-title") && text) {
      const safeText = text.replace(/'/g, "").trim();
      const safeTitle = title ? title.replace(/'/g, "").trim() : "";
      if (safeTitle) {
        candidates.push(scopePrefix + tag + ".dynatree-title[title='" + safeTitle + "']:visible");
      }
      if (safeText) {
        candidates.push(scopePrefix + ".dynatree-title:text-is('" + safeText + "'):visible");
        candidates.push(scopePrefix + ".dynatree-title:has-text('" + safeText + "'):visible");
      }
    }

    // 4. Scoped Class + Identifying Text (placed BEFORE positional :nth-of-type DOM path so dynamic lists never click the wrong row)
    const trEl = el.closest ? el.closest("tr") : null;
    const thEl = trEl ? trEl.querySelector("th") : null;
    const rowThText = thEl ? getCleanText(thEl).replace(/^\\*\\s*/, "").slice(0, 15).replace(/'/g, "").trim() : "";
    const rowScopePrefix = rowThText ? scopePrefix + "tr:has(th:has-text('" + rowThText + "')) " : scopePrefix;
    const goodClasses = getMeaningfulClasses(el, 2);

    if (goodClasses.length > 0 && text && text.length >= 2 && text.length <= 35 && tag !== "input" && tag !== "textarea" && tag !== "select") {
      const cls = goodClasses.join(".");
      const safeText = text.replace(/'/g, "").trim();
      if (rowThText) {
        candidates.push(rowScopePrefix + tag + "." + cls + ":has-text('" + safeText + "'):visible");
      }
      candidates.push(scopePrefix + tag + "." + cls + ":has-text('" + safeText + "'):visible");
    }

    // 5. Exact DOM Hierarchy Path from Nearest #id Ancestor (e.g. #eapWorkSelect_workList > ul.aw_ul > li.aw_li... > button.btn.btn_write:visible)
    const domPathSel = buildExactDomPathSelector(el, modalEl);
    if (domPathSel) {
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
      const cardTitEl = workCardEl.querySelector("strong.tit, .tit, a._his");
      const cardTit = cardTitEl ? getCleanText(cardTitEl).slice(0, 20).replace(/'/g, "") : "";
      if (el.classList && el.classList.contains("btn_write")) {
        if (cardTit) {
          candidates.unshift("ul.aw_ul li.aw_li:has-text('" + cardTit + "') button.btn_write:visible");
        }
        candidates.push("ul.aw_ul li.aw_li button.btn_write:visible");
      }
    }

    // 7. Input / Textarea specific attributes
    if (tag === "input" || tag === "textarea" || tag === "select") {
      if (name) candidates.push(scopePrefix + tag + "[name='" + name + "']:visible");
      if (placeholder) candidates.push(scopePrefix + tag + "[placeholder*='" + placeholder.slice(0, 15).replace(/'/g, "") + "']:visible");
      if (title) candidates.push(scopePrefix + tag + "[title*='" + title.slice(0, 15).replace(/'/g, "") + "']:visible");
      if (typeAttr === "checkbox" || typeAttr === "radio") {
        const row = el.closest("tr, li, label, .chk_div");
        const rowText = row ? getCleanText(row).slice(0, 20).replace(/'/g, "") : "";
        if (rowText) {
          candidates.push(scopePrefix + "li:has-text('" + rowText + "') input[type='" + typeAttr + "']:visible");
          candidates.push(scopePrefix + "tr:has-text('" + rowText + "') input[type='" + typeAttr + "']:visible");
        }
      }
      if (tag === "textarea" && !id) {
        candidates.push("textarea:not(#eapDocReg_draftOpinCn):visible");
      }
    }

    // 8. Scoped Class + Text Fallback (only after DOM path and HTML attributes)
    if (goodClasses.length > 0) {
      const cls = goodClasses.join(".");
      if (text && text.length <= 20 && tag !== "input" && tag !== "textarea") {
        const safeText = text.replace(/'/g, "");
        if (rowThText) {
          candidates.push(rowScopePrefix + tag + "." + cls + ":has-text('" + safeText + "'):visible");
        }
        candidates.push(scopePrefix + tag + "." + cls + ":has-text('" + safeText + "'):visible");
      }
      if (rowThText) {
        candidates.push(rowScopePrefix + tag + "." + cls + ":visible");
      }
      // Do not append a bare un-scoped class fallback for dynamic list items that already have specific text/attribute selectors
      const isListItemChild = Boolean(el.closest && el.closest("li, tr"));
      if (!isListItemChild || !text) {
        candidates.push(scopePrefix + tag + "." + cls + ":visible");
      }
    } else if (text && text.length >= 1 && text.length <= 25 && tag !== "input" && tag !== "textarea") {
      const safeText = text.replace(/'/g, "");
      if (rowThText) {
        candidates.push(rowScopePrefix + tag + ":has-text('" + safeText + "'):visible");
      }
      candidates.push(scopePrefix + tag + ":has-text('" + safeText + "'):visible");
    }

    if (candidates.length === 0) {
      if (title) {
        candidates.push(scopePrefix + tag + "[title*='" + title.slice(0, 15).replace(/'/g, "") + "']:visible");
      } else {
        candidates.push(scopePrefix + tag + ":visible");
      }
    }

    // Combine top 3 unique selectors with comma for fallback safety
    const unique = Array.from(new Set(candidates)).slice(0, 3);
    return unique.join(", ");
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
      : rowThText && (tag === "button" || tag === "input" || tag === "select")
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

    if (tag === "input" || tag === "textarea") {
      const typeAttr = (el.getAttribute("type") || "text").toLowerCase();
      if (typeAttr === "checkbox" || typeAttr === "radio") {
        const container = el.closest("li, tr, label");
        const containerTxt = container ? getCleanText(container).slice(0, 20) : "";
        return prefix + (containerTxt ? "'" + containerTxt + "' 체크박스" : "체크박스");
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
      return prefix + "'" + text.slice(0, 22) + "' " + (tag === "a" ? "메뉴/링크" : tag === "button" ? "버튼" : "요소");
    }
    if (title) {
      return prefix + "'" + title.slice(0, 22) + "' 버튼";
    }
    if (id) {
      return prefix + "#" + id + " (" + tag + ")";
    }
    return prefix + tag + " 요소";
  }

  function flushPendingType() {
    if (!lastTypedElement) return;
    const el = lastTypedElement;
    const val = (lastTypedValue || "").trim();
    lastTypedElement = null;
    lastTypedValue = "";
    if (!val) return;

    const selector = buildRobustSelector(el);
    const label = buildHumanLabel(el);
    const targetHtml = extractTargetHtml(el);
    const iframe = getCurrentIframeSelector();
    const inModal = Boolean(el.closest && el.closest(".ui-dialog, .modal, .layer_pop"));

    if (typeof window.__screenDemoRecordAction === "function") {
      window.__screenDemoRecordAction({
        kind: "type",
        selector: selector || "input:visible, textarea:visible",
        targetHtml,
        iframe,
        tagName: (el.tagName || "input").toLowerCase(),
        label,
        text: val,
        pageUrl: location.href,
        inModal
      });
    }
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

      hud.innerHTML = \`
        <div style="display:flex; align-items:center; gap:8px;">
          <span style="width:10px; height:10px; border-radius:50%; background:#ef4444; display:inline-block; box-shadow:0 0 10px #ef4444;"></span>
          <div>
            <div style="font-size:12px; font-weight:700; color:#38bdf8;">💧 스포이드 동작 감지 모드 작동 중</div>
            <div id="__sd_hud_last_step" style="font-size:11px; color:#cbd5e1; max-width:260px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
              원하는 버튼 클릭·타이핑·드래그를 진행하세요
            </div>
          </div>
        </div>
        <button id="__sd_btn_finish" type="button" style="background:linear-gradient(135deg, #10b981, #059669); color:#fff; border:none; border-radius:8px; padding:8px 14px; font-size:12px; font-weight:700; cursor:pointer; box-shadow:0 4px 12px rgba(16,185,129,0.35);">
          ✅ 시범 완료 (AI 시나리오 변환)
        </button>
      \`;

      document.body.appendChild(hud);

      const finishBtn = document.getElementById("__sd_btn_finish");
      if (finishBtn) {
        finishBtn.addEventListener("click", function(e) {
          e.preventDefault();
          e.stopPropagation();
          flushPendingType();
          finishBtn.textContent = "⏳ 시나리오 변환 중...";
          finishBtn.disabled = true;
          if (typeof window.__screenDemoFinishSession === "function") {
            window.__screenDemoFinishSession();
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

  // Find the actual drop target underneath the cursor (piercing through floating drag clones)
  function resolveDropTargetAtPoint(x, y, sourceEl) {
    // 0. Check if Naonsoft Groupware / jQuery UI has already marked a drop container as hovered!
    const activeHoverSlot = document.querySelector(
      ".app_flow.hover, ._drag_hover, .ui-droppable-hover, .af_ul._drag_hover"
    );
    if (activeHoverSlot && (!sourceEl || !activeHoverSlot.contains(sourceEl))) {
      return activeHoverSlot.closest("[id^='af_'], div.app_flow") || activeHoverSlot;
    }

    if (typeof document.elementsFromPoint !== "function") return null;
    if (typeof x !== "number" || typeof y !== "number" || (x === 0 && y === 0)) return null;

    const stack = document.elementsFromPoint(x, y) || [];
    for (let i = 0; i < stack.length; i++) {
      const candidate = stack[i];
      if (!candidate || candidate === document.body || candidate === document.documentElement) continue;
      if (isDragHelperOrOverlay(candidate)) continue;
      if (sourceEl && (candidate === sourceEl || sourceEl.contains(candidate))) continue;

      // Priority 1: Known approval-line / groupware drop slots
      const slot = candidate.closest(
        "[id^='af_'], div.app_flow, ul.af_ul, li.fb_ul, .ui-droppable, .ui-sortable, [data-app-type-ordr], .appline_flow td, .app_line_box, .drop_zone"
      );
      if (slot && (!sourceEl || !slot.contains(sourceEl))) {
        return slot.closest("[id^='af_'], div.app_flow") || slot;
      }

      // Priority 2: Table cell, list container, or interactive target
      const container = candidate.closest("td, li, ul, .box_cont, [role='region']");
      if (container && (!sourceEl || !container.contains(sourceEl))) {
        return container;
      }

      return resolveInteractiveElement(candidate);
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
      (explicitTargetEl && explicitTargetEl !== dragSourceInfo.el ? explicitTargetEl : null) ||
      resolveDropTargetAtPoint(useX, useY, dragSourceInfo.el) ||
      dragSourceInfo.lastDropEl;

    const srcInfo = dragSourceInfo;
    dragSourceInfo = null;

    if (!targetEl || targetEl === srcInfo.el) return false;

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
        const cardTitEl = hoverCard.querySelector && hoverCard.querySelector("strong.tit, .tit, a._his");
        const cardTit = cardTitEl ? getCleanText(cardTitEl).slice(0, 20).replace(/'/g, "") : "";
        const hoverDomPath = buildExactDomPathSelector(hoverCard, hoverCard.closest && hoverCard.closest(".ui-dialog, .modal, .layer_pop"));
        const hoverCandidates = [];
        if (hoverDomPath) hoverCandidates.push(hoverDomPath);
        if (cardTit) {
          hoverCandidates.push("ul.aw_ul li.aw_li:has-text('" + cardTit + "') .app_work_box:visible");
          hoverCandidates.push("li.aw_li:has-text('" + cardTit + "'):visible");
        }
        hoverCandidates.push("ul.aw_ul li.aw_li .app_work_box:visible");
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

  // Capture typing on input / textarea / contenteditable
  window.addEventListener("input", function(e) {
    const t = e.target;
    if (!t || (t.closest && t.closest("#__sd_recorder_hud"))) return;
    const tag = (t.tagName || "").toLowerCase();
    const isEditable = t.isContentEditable || tag === "body";
    if (tag === "input" || tag === "textarea" || isEditable) {
      const typeAttr = (t.getAttribute && t.getAttribute("type") || "").toLowerCase();
      if (typeAttr === "checkbox" || typeAttr === "radio" || typeAttr === "button" || typeAttr === "submit") return;
      lastTypedElement = t;
      lastTypedValue = (t.value !== undefined ? t.value : (t.innerText || t.textContent || "")).trim();
    }
  }, true);

  window.addEventListener("change", function(e) {
    const t = e.target;
    if (!t || (t.closest && t.closest("#__sd_recorder_hud"))) return;
    const tag = (t.tagName || "").toLowerCase();
    if (tag === "select") {
      flushPendingType();
      const selectedOpt = t.options && t.options[t.selectedIndex];
      const optText = selectedOpt ? (selectedOpt.text || t.value) : t.value;
      const selector = buildRobustSelector(t);
      const label = buildHumanLabel(t);
      const iframe = getCurrentIframeSelector();
      if (typeof window.__screenDemoRecordAction === "function") {
        window.__screenDemoRecordAction({
          kind: "click",
          selector,
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
    if (e.target && e.target === lastTypedElement) {
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
    if (!dragSourceInfo) return;
    commitDragAndDrop(e.clientX || dragSourceInfo.lastX, e.clientY || dragSourceInfo.lastY, null);
  }, true);

  window.addEventListener("dragend", function(e) {
    if (!dragSourceInfo) return;
    commitDragAndDrop(dragSourceInfo.lastX || e.clientX, dragSourceInfo.lastY || e.clientY, dragSourceInfo.lastDropEl);
  }, true);

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

    // If user was typing into a DIFFERENT element, flush the typed text first!
    const el = resolveInteractiveElement(rawTarget);
    if (lastTypedElement && lastTypedElement !== el) {
      flushPendingType();
    }

    if (!el || !el.tagName) return;
    const tag = el.tagName.toLowerCase();

    // Ignore clicks on pure layout wrappers or hidden search option containers (body/html/wide layout divs without onclick or role)
    if (tag === "html") return;
    if (tag === "body" && !el.isContentEditable) return;
    if (el.id === "eapHeader_option" || (el.classList && el.classList.contains("_search_option_hide"))) return;
    const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : { width: 0, height: 0 };
    if (
      (tag === "div" || tag === "section" || tag === "form" || tag === "header" || tag === "ul" || tag === "nav") &&
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

    if (hoverCardEl && typeof window.__screenDemoRecordAction === "function") {
      const cardTitEl = hoverCardEl.querySelector && hoverCardEl.querySelector("strong.tit, .tit, a._his");
      const cardTit = cardTitEl ? getCleanText(cardTitEl).slice(0, 20).replace(/'/g, "") : "";
      const hoverDomPath = buildExactDomPathSelector(hoverCardEl, el.closest && el.closest(".ui-dialog, .modal, .layer_pop"));
      const hoverCandidates = [];
      if (hoverDomPath) hoverCandidates.push(hoverDomPath);
      if (cardTit) {
        hoverCandidates.push("ul.aw_ul li.aw_li:has-text('" + cardTit + "') .app_work_box:visible");
        hoverCandidates.push("li.aw_li:has-text('" + cardTit + "'):visible");
      }
      hoverCandidates.push("ul.aw_ul li.aw_li .app_work_box:visible");
      const hoverSelector = Array.from(new Set(hoverCandidates)).slice(0, 3).join(", ");
      const hoverLabel = (cardTit ? "'" + cardTit + "' 양식 카드" : "양식 카드") + "에 마우스 호버 (하위 [작성] 버튼 표시)";

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

  // Also flush pending typing if user presses Enter inside an input box
  document.addEventListener("keydown", function(e) {
    if (e.key === "Enter" && lastTypedElement) {
      flushPendingType();
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
      const desc = `${ev.label}에 '${ev.text}' 입력`;
      promptSteps.push(desc);
      actions.push({
        type: "type",
        selector: ev.selector,
        iframe: ev.iframe,
        text: ev.text,
        description: desc,
        recordedByEyedropper: true,
        targetHtml: ev.targetHtml,
      });
      actions.push({
        type: "wait",
        ms: scaleMs(900),
        description: "입력 텍스트 확인 여유 대기",
      });
    } else {
      // Safety net: if a click targets a hover-revealed card button (e.g. button.btn_write inside .app_work_box / li.aw_li)
      // and the preceding event was not already a hover, automatically insert the hover + wait steps before the click!
      const prevEv = i > 0 ? events[i - 1] : null;
      const isHoverRevealedClick =
        ev.selector.includes("btn_write") ||
        (ev.selector.includes(".app_work_box") && ev.selector.includes("button")) ||
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

      const desc = `${ev.label} 클릭`;
      promptSteps.push(desc);
      actions.push({
        type: "click",
        selector: ev.selector,
        iframe: ev.iframe,
        description: desc,
        recordedByEyedropper: true,
        targetHtml: ev.targetHtml,
      });

      // Determine smart wait duration based on whether this click opens a modal, navigates, or submits
      const isHeavyTransition =
        /작성|등록|상신|저장|결재분류|결재선|검색|전자결재|일정관리|자원예약|문서관리|게시판|확인/.test(ev.label);
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
    recordedByEyedropper: true,
    actions,
  };

  return {
    plan: rawPlan,
    suggestedSlug,
    canonicalPrompt,
    explanation,
  };
}

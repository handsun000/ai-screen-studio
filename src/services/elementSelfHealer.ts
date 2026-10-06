import { GoogleGenAI } from "@google/genai";
import type { Page, Locator } from "playwright";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
import type { BrowsePlanAction, BrowsePlan } from "../types";

dotenv.config({ override: true });

export interface SelfHealResult {
  success: boolean;
  selector: string;
  iframe?: string | null;
  confidence: number;
  reason: string;
}

export interface LiveDOMCandidate {
  tag: string;
  text: string;
  id?: string;
  className?: string;
  type?: string;
  name?: string;
  placeholder?: string;
  title?: string;
  ariaLabel?: string;
  inModal?: string | boolean;
  inSidebar?: boolean;
  inHeader?: boolean;
  frame?: string;
  suggestedSelector: string;
}

/**
 * Extracts visible interactive elements from the current page and all visible iframes (e.g. #subBody).
 */
export async function extractLiveCandidates(page: Page): Promise<{
  activeDialogTitle?: string;
  candidates: LiveDOMCandidate[];
}> {
  try {
    // 1. Extract from top-level document
    const topData = await page.evaluate(() => {
      const candidates: Array<{
        tag: string;
        text: string;
        id?: string;
        className?: string;
        type?: string;
        name?: string;
        placeholder?: string;
        title?: string;
        ariaLabel?: string;
        inModal?: string | boolean;
        inSidebar?: boolean;
        inHeader?: boolean;
        frame?: string;
        suggestedSelector: string;
      }> = [];

      // Detect active top dialog / modal
      let activeDialogTitle = "";
      const rawDialogs = Array.from(document.querySelectorAll(
        ".ui-dialog, .modal, [role='dialog'], .layer_wrap, .equ_select_lyr, #alert_lyr, div[id*='Dialog'], div[class*='dialog']"
      ));
      const visibleDialogs = rawDialogs.filter((d) => {
        const r = d.getBoundingClientRect();
        const s = window.getComputedStyle(d);
        return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden";
      });
      if (visibleDialogs.length > 0) {
        const topDialog = visibleDialogs[visibleDialogs.length - 1];
        const titleEl = topDialog.querySelector(
          ".ui-dialog-title, .modal-title, .tit, h3, h4, .title"
        );
        if (titleEl) {
          activeDialogTitle = (titleEl.textContent || "").trim();
        }
      }

      // Query visible interactive elements
      const query =
        "button, a, input, select, textarea, [contenteditable='true'], [contenteditable=''], .note-editable, .ce-paragraph, div[role='textbox'], [role='button'], .dynatree-node, .dynatree-checkbox, .dynatree-title, .dynatree-expander, .fancytree-node, .fancytree-expander, .fancytree-title, [class*='expander'], [class*='tree-title'], [class*='node-title'], label[for], li[class*='item'], li[class*='depth'], div[onclick], span[onclick]";
      const elements = Array.from(document.querySelectorAll(query));

      for (const el of elements) {
        const rect = el.getBoundingClientRect();
        if (
          rect.width <= 0 ||
          rect.height <= 0 ||
          rect.bottom < 0 ||
          rect.right < 0
        ) {
          continue;
        }
        const style = window.getComputedStyle(el);
        if (
          style.display === "none" ||
          style.visibility === "hidden" ||
          style.opacity === "0"
        ) {
          continue;
        }

        const tag = el.tagName.toLowerCase();
        const text = (el.textContent || "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 50);
        const id = el.id ? el.id.trim() : undefined;
        const className =
          el.className && typeof el.className === "string"
            ? el.className.trim()
            : undefined;
        const type = (el as HTMLInputElement).type || undefined;
        const name = (el as HTMLInputElement).name || undefined;
        const placeholder =
          (el as HTMLInputElement).placeholder || undefined;
        const title = (el as HTMLElement).title || undefined;
        const ariaLabel = el.getAttribute("aria-label") || undefined;

        // Context checks
        const modalContainer = el.closest(
          ".ui-dialog, .modal, [role='dialog'], .layer_wrap"
        );
        const inModal = modalContainer ? activeDialogTitle || true : false;
        const inSidebar = !!el.closest("#snb, .snb, .aside, .left_menu, aside");
        const inHeader = !!el.closest("header, #header, .gnb, .top_menu, nav");

        // Synthesize smart candidate selector
        let suggestedSelector = "";
        const modalPrefix = inModal ? ".ui-dialog:visible " : "";

        if (id && !id.startsWith("ui-id-") && !id.startsWith("_")) {
          suggestedSelector = `${modalPrefix}${tag}#${id}`;
        } else if (text && text.length >= 2 && text.length <= 25) {
          suggestedSelector = `${modalPrefix}${tag}:has-text('${text}')`;
        } else if (name) {
          suggestedSelector = `${modalPrefix}${tag}[name='${name}']`;
        } else if (placeholder) {
          suggestedSelector = `${modalPrefix}${tag}[placeholder*='${placeholder}']`;
        } else if (className) {
          const firstClass = className.split(/\s+/)[0];
          if (firstClass && !firstClass.startsWith("ui-")) {
            suggestedSelector = `${modalPrefix}${tag}.${firstClass}`;
          }
        }

        if (!suggestedSelector) {
          suggestedSelector = `${modalPrefix}${tag}`;
        }

        candidates.push({
          tag,
          text,
          id,
          className,
          type,
          name,
          placeholder,
          title,
          ariaLabel,
          inModal,
          inSidebar,
          inHeader,
          suggestedSelector,
        });

        if (candidates.length >= 50) break;
      }

      return {
        activeDialogTitle: activeDialogTitle || undefined,
        candidates,
      };
    });

    const activeDialogTitle = topData.activeDialogTitle;
    const allCandidates: LiveDOMCandidate[] = [...(topData.candidates || [])];

    // 2. Scan visible iframes (e.g. #subBody, #contentFrame, iframe:visible)
    try {
      const iframeSelectors = await page.evaluate(() => {
        const iframes = Array.from(document.querySelectorAll("iframe"));
        return iframes
          .map((f) => {
            const rect = f.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) return null;
            if (f.id) return `iframe#${f.id}`;
            if (f.name) return `iframe[name='${f.name}']`;
            return "iframe:visible";
          })
          .filter(Boolean) as string[];
      });

      for (const iframeSel of iframeSelectors) {
        if (allCandidates.length >= 75) break;
        try {
          const frameLocator = page.frameLocator(iframeSel);
          const frameCandidates = await frameLocator
            .locator("body")
            .evaluate((body, frameSel) => {
              const list: any[] = [];
              const query =
                "button, a, input, select, textarea, [contenteditable='true'], [contenteditable=''], .note-editable, .ce-paragraph, body, [role='button'], .dynatree-node, .dynatree-checkbox, .dynatree-title, .dynatree-expander, .fancytree-node, .fancytree-expander, .fancytree-title, [class*='expander'], [class*='tree-title'], [class*='node-title'], label[for], li[class*='item'], li[class*='depth']";
              const elements = Array.from(body.querySelectorAll(query));

              for (const el of elements) {
                const rect = el.getBoundingClientRect();
                if (rect.width <= 0 || rect.height <= 0) continue;
                const style = window.getComputedStyle(el);
                if (
                  style.display === "none" ||
                  style.visibility === "hidden" ||
                  style.opacity === "0"
                ) {
                  continue;
                }

                const tag = el.tagName.toLowerCase();
                const text = (el.textContent || "")
                  .replace(/\s+/g, " ")
                  .trim()
                  .slice(0, 50);
                const id = el.id ? el.id.trim() : undefined;
                const className =
                  el.className && typeof el.className === "string"
                    ? el.className.trim()
                    : undefined;
                const type = (el as HTMLInputElement).type || undefined;
                const name = (el as HTMLInputElement).name || undefined;
                const placeholder =
                  (el as HTMLInputElement).placeholder || undefined;
                const title = (el as HTMLElement).title || undefined;

                let suggestedSelector = "";
                if (id && !id.startsWith("ui-id-") && !id.startsWith("_")) {
                  suggestedSelector = `${tag}#${id}`;
                } else if (text && text.length >= 2 && text.length <= 25) {
                  suggestedSelector = `${tag}:has-text('${text}')`;
                } else if (name) {
                  suggestedSelector = `${tag}[name='${name}']`;
                } else if (placeholder) {
                  suggestedSelector = `${tag}[placeholder*='${placeholder}']`;
                } else if (className) {
                  const firstClass = className.split(/\s+/)[0];
                  if (firstClass && !firstClass.startsWith("ui-")) {
                    suggestedSelector = `${tag}.${firstClass}`;
                  }
                }
                if (!suggestedSelector) suggestedSelector = tag;

                list.push({
                  tag,
                  text,
                  id,
                  className,
                  type,
                  name,
                  placeholder,
                  title,
                  frame: frameSel,
                  suggestedSelector,
                });

                if (list.length >= 35) break;
              }
              return list;
            }, iframeSel);

          if (frameCandidates && frameCandidates.length > 0) {
            allCandidates.push(...frameCandidates);
          }
        } catch {}
      }
    } catch {}

    return {
      activeDialogTitle,
      candidates: allCandidates,
    };
  } catch (err) {
    return { candidates: [] };
  }
}

/**
 * AI Runtime Self-Healing Agent:
 * Takes the failed action, captures live browser screen + DOM candidates,
 * calls Gemini with a high-precision prompt, and returns a verified Playwright selector.
 */
export async function selfHealElement(
  page: Page,
  action: BrowsePlanAction,
  stepIndex: number,
  totalSteps: number,
  dataDir?: string
): Promise<SelfHealResult | null> {
  const apiKeys = [
    process.env.GEMINI_API_KEY,
    process.env.GEMINI_API_KEY_ALT,
  ].filter(Boolean) as string[];

  if (apiKeys.length === 0) {
    console.warn("  [⚠️ AI 자가 치유] GEMINI_API_KEY가 없어 자가 치유를 생략합니다.");
    return null;
  }

  // 1. Capture live screen screenshot (JPEG Base64)
  let screenshotBase64 = "";
  try {
    const screenshotBuffer = await page.screenshot({
      type: "jpeg",
      quality: 60,
    });
    screenshotBase64 = screenshotBuffer.toString("base64");
  } catch {}

  // 2. Extract live interactive DOM candidates (top-level + visible iframes)
  const { activeDialogTitle, candidates } = await extractLiveCandidates(page);

  // 3. Assemble Extraordinary High-Precision Self-Healing Prompt
  const systemInstruction = `
당신은 Playwright 브라우저 자동화 녹화 도중 요소 탐색에 실패하거나 셀렉터가 누락되었을 때,
실시간 브라우저 화면(스크린샷 이미지)과 실제 DOM 후보군을 정밀 교차 검증하여
"오직 단 1번의 응답으로 100% 동작하는 완벽한 Playwright 셀렉터"를 복구해내는 [최고위 AI 런타임 자가 치유 아키텍트(Runtime Self-Healing Architect)]입니다.

### [자가 치유의 중요성]
이 복구는 실시간 비디오 녹화 파이프라인의 생명선입니다. 실패 시 전체 녹화가 중단되므로,
어설픈 추측이나 허위 ID 생성 없이, 현재 화면에 실제로 존재하는 대상을 정확하게 짚어내야 합니다.

### [5대 황금 복구 원칙 (Five Gold Rules)]
1. 🚫 무추측 원칙 (Zero-Guessing Policy):
   - 소스코드에 없거나 후보군 목록에 없는 가상 ID(예: #_DOC_TITLE_, #btn_submit, #user_input)를 절대로 지어내지 마십시오.
   - 반드시 제공된 [Live Interactive Candidates] 목록의 실제 id, className, name, 또는 화면에 또렷이 보이는 한글 텍스트(:has-text('...'))를 사용하십시오.
2. 🪟 모달/다이얼로그 팝업 스코핑 (Modal Dialog Isolation):
   - 요소가 팝업/모달 다이얼로그 내부에 있는 경우(또는 현재 화면에 모달이 떠 있는 경우), 반드시 최상단 가시 다이얼로그 범위('.ui-dialog:visible', '.modal:visible', '[role="dialog"]:visible')를 접두사로 지정하십시오.
   - 예: ".ui-dialog:visible button:has-text('확인')", ".ui-dialog:visible #savebtn"
3. 🖼️ iframe 내부 요소 식별 (Iframe Context):
   - 대상 요소가 iframe(예: iframe#subBody, iframe#contentFrame) 내부에 있는 경우, 'iframe' 필드에 해당 iframe 셀렉터를 명시하십시오. (후보군에 'frame' 값이 있으면 그 값을 우선 반영)
4. 🎯 말단 인터랙티브 태그 핀포인트 (Atomic Interactive Element):
   - 넓은 부모 div나 form 대신, 실제 클릭/입력 가능한 말단 태그(button, a, input, textarea, select, span.dynatree-checkbox 등)를 타겟팅하십시오.
   - 텍스트 입력(type)인 경우: 제목이면 input[placeholder*='제목'] 또는 #subject, 본문/내용이면 textarea 또는 #cn 등을 정확히 매핑하십시오.
5. 🛡️ 견고한 2중 방어선 셀렉터 (Robust Dual Fallback via Comma):
   - 고유 식별자(ID 또는 특정 클래스)와 텍스트 매칭(:has-text)을 쉼표(,)로 연결하여 Playwright가 어떤 환경에서도 대상을 즉시 찾을 수 있게 하십시오.
   - 예: ".ui-dialog:visible button#savebtn, .ui-dialog:visible button:has-text('저장')"
   - 예: "button.btn_svc_open, button[title*='전체메뉴']"
   - 예: "iframe#subBody 내의 button#reg_shedule_lefttop, button:has-text('일정 등록')"

### [응답 포맷 (Strict JSON Only)]
반드시 아래 JSON 형식으로만 응답하십시오 (마크다운 코드블록이나 불필요한 설명 금지):
{
  "success": true,
  "selector": ".ui-dialog:visible button#savebtn, .ui-dialog:visible button:has-text('저장')",
  "iframe": null,
  "confidence": 0.99,
  "reason": "화면 중앙 '일정 등록' 모달 내에 우측 상단 '저장' 버튼(#savebtn)이 확인되어 핀포인트 타겟팅함"
}
`;

  const userPrompt = `
[실행 컨텍스트]
- 현재 진행 단계: #${stepIndex} / 총 ${totalSteps}단계
- 수행하려는 액션 타입: "${action.type}"
- 액션 상세 설명: "${action.description}"
${action.type === "type" ? `- 입력할 텍스트(value): "${action.text || ""}"` : ""}
- 기존에 시도했으나 실패한 셀렉터: "${action.selector || "(비어 있음 - 사용자 입력 또는 AI 복구 대기)"}"
- 기존 지정된 iframe: "${action.iframe || "없음 (최상위 페이지)"}"
- 현재 화면에 열린 최상단 팝업/모달 제목: ${activeDialogTitle ? `"${activeDialogTitle}"` : "없음 (일반 페이지)"}

[현재 화면에서 감지된 가시적 인터랙티브 DOM 후보군 (총 ${candidates.length}개)]:
${JSON.stringify(candidates.slice(0, 50), null, 2)}

[요청 사항]
위의 실시간 브라우저 스크린샷과 DOM 후보군을 정밀 분석하여,
"${action.description}" 작업을 수행하기 위해 지금 즉시 ${action.type === "type" ? "포커스하여 텍스트를 입력해야 할 입력창" : "클릭해야 할 실제 버튼/링크/요소"}의
100% 유효한 Playwright 셀렉터를 JSON으로 반환해 주십시오.
`;

  const configuredModel = process.env.GEMINI_MODEL || "gemini-3.8-flash";
  const candidateModels = Array.from(
    new Set([
      configuredModel,
      "gemini-3.8-flash",
      "gemini-3.5-flash",
      "gemini-flash-latest",
    ])
  );

  for (const model of candidateModels) {
    for (const key of apiKeys) {
      try {
        const ai = new GoogleGenAI({ apiKey: key });

        const parts: any[] = [];
        if (screenshotBase64) {
          parts.push({
            inlineData: {
              mimeType: "image/jpeg",
              data: screenshotBase64,
            },
          });
        }
        parts.push({ text: userPrompt });

        const response = await ai.models.generateContent({
          model,
          contents: [{ role: "user", parts }],
          config: {
            systemInstruction,
            temperature: 0.1,
            maxOutputTokens: 4096,
            responseMimeType: "application/json",
            // Disable thinking tokens to prevent output token exhaustion
            thinkingConfig: {
              thinkingBudget: 0,
            },
          },
        });

        const rawText = response.text || "";
        let parsed: any = null;
        try {
          const jsonMatch = rawText.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            parsed = JSON.parse(jsonMatch[0]);
          } else {
            parsed = JSON.parse(rawText.trim());
          }
        } catch (jsonErr: any) {
          console.warn(`  [AI 응답 파싱 경고] (${model}) JSON 파싱 오류: ${jsonErr.message}. 원문: ${rawText.slice(0, 120)}...`);
        }

        if (parsed && parsed.selector) {
          // Guard: Type actions must NEVER target a button element
          if (action.type === "type") {
            const lowerSel = parsed.selector.toLowerCase();
            if (
              (lowerSel.includes("button") || lowerSel.includes(".btn")) &&
              !lowerSel.includes("input") &&
              !lowerSel.includes("textarea") &&
              !lowerSel.includes("contenteditable") &&
              !lowerSel.includes("body") &&
              !lowerSel.includes("iframe")
            ) {
              console.warn(
                `  [⚠️ AI 자가 치유 거절] type(입력) 액션에 버튼 셀렉터('${parsed.selector}')가 반환되어 적용을 거부합니다.`
              );
              continue;
            }
          }

          // Guard 2: Form registration actions (title, content, save) must NEVER target popup/modal dialog elements
          const descLower = (action.description || "").toLowerCase();
          const isPostModalAction =
            descLower.includes("제목") ||
            descLower.includes("본문") ||
            descLower.includes("내용") ||
            descLower.includes("공개") ||
            (descLower.includes("저장") && !descLower.includes("팝업"));

          if (isPostModalAction && (parsed.selector.includes(".ui-dialog") || parsed.selector.includes("문서함명") || parsed.selector.includes("role='dialog'"))) {
            console.warn(
              `  [⚠️ AI 자가 치유 거절] 본문 등록 액션('${action.description}')에 모달 팝업 내부 셀렉터('${parsed.selector}')가 반환되어 적용을 거부합니다.`
            );
            continue;
          }

          // Guard 3: Modal confirmation actions must NEVER target main document body or subBody iframe
          const isModalConfirmAction =
            (descLower.includes("팝업") || descLower.includes("모달") || descLower.includes("문서함")) &&
            (descLower.includes("확인") || descLower.includes("완료"));

          if (isModalConfirmAction && (parsed.iframe || parsed.selector.includes("subBody") || parsed.selector.includes("contentFrame"))) {
            console.warn(
              `  [⚠️ AI 자가 치유 거절] 모달 확인 액션('${action.description}')에 본문 프레임 셀렉터('${parsed.selector}')가 반환되어 적용을 거부합니다.`
            );
            continue;
          }

          return {
            success: true,
            selector: parsed.selector,
            iframe: parsed.iframe || null,
            confidence: parsed.confidence || 0.95,
            reason:
              parsed.reason ||
              "AI 런타임 화면 분석을 통해 올바른 요소를 감지했습니다.",
          };
        }
      } catch (err: any) {
        console.warn(`  [AI 자가 치유 호출 경고] 모델 ${model} 호출 오류: ${err.message}`);
      }
    }
  }

  return null;
}

/**
 * Persists healed selector and iframe back into browse-plan.json so the fix is permanent.
 */
export function saveHealedPlan(dataDir: string, plan: BrowsePlan): void {
  try {
    const planPath = path.join(dataDir, "browse-plan.json");
    if (fs.existsSync(planPath)) {
      fs.writeFileSync(planPath, JSON.stringify(plan, null, 2), "utf-8");
      console.log(`  [💾 영구 저장] 수정된 셀렉터가 browse-plan.json에 영구 반영되었습니다.`);
    }
  } catch (err) {
    console.warn("  [주의] browse-plan.json 업데이트 실패:", err);
  }
}

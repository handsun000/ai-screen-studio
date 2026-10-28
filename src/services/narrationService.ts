import { GoogleGenAI } from "@google/genai";
import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";
import * as dotenv from "dotenv";
import { recordAiUsage } from "./aiUsageTracker";
import type {
  BrowsePlan,
  BrowsePlanAction,
  EditPlan,
  Moment,
  MomentsFile,
  NarrationCue,
  NarrationFile,
  NarrationStyle,
  TimeRegion,
} from "../types";
import { getConfig } from "./configManager";

dotenv.config({ override: true });

const ROOT_DIR = path.resolve(__dirname, "..", "..");
const DATA_DIR = path.join(ROOT_DIR, "data");
const PUBLIC_DIR = path.join(ROOT_DIR, "public");

export interface RawActionContext {
  stepNumber: number;
  timestampSec: number;
  type: string;
  description: string;
  inputValue?: string;
  domSummary?: string;
}

export interface NarrationWindow {
  index: number;
  startMs: number;
  endMs: number;
  maxChars: number;
  isIntro?: boolean;
  stepsInWindow: RawActionContext[];
  fallbackLine: string;
}

export const STYLE_DEFAULT_PITCH: Record<NarrationStyle, string> = {
  manual: "+0Hz",
  friendly: "+4Hz",
  presentation: "-3Hz",
  compact: "+2Hz",
};

/**
 * browse-plan.json의 targetHtml 및 selector에서 AI가 화면 요소의 성격, 기능적 목적(Why), 위치를
 * 정확히 파악할 수 있도록 핵심 DOM 속성(tag, type, id, name, class, title, placeholder, href, data-*)과
 * 의미론적 후보 셀렉터들을 추출합니다.
 */
function extractCleanDomSummary(action?: BrowsePlanAction): string | undefined {
  if (!action) return undefined;
  const parts: string[] = [];
  const html = (action.targetHtml || "").trim();
  if (html) {
    const openTagMatch = html.match(/^<([a-zA-Z0-9_-]+)([^>]*)>/);
    if (openTagMatch) {
      const tag = openTagMatch[1].toLowerCase();
      const attrs = openTagMatch[2] || "";
      const getAttr = (name: string) =>
        attrs.match(new RegExp(`(?:^|\\s)${name}=["']([^"']+)["']`, "i"))?.[1]?.trim();

      const typeAttr = getAttr("type");
      const idAttr = getAttr("id");
      const nameAttr = getAttr("name");
      const classAttr = getAttr("class");
      const titleAttr = getAttr("title");
      const placeholderAttr = getAttr("placeholder");
      const roleAttr = getAttr("role");
      const hrefAttr = getAttr("href");
      const ariaLabelAttr = getAttr("aria-label");

      const dataAttrs: string[] = [];
      const dataRegex = /(?:^|\s)(data-[a-zA-Z0-9_-]+)=["']([^"']+)["']/gi;
      let dMatch: RegExpExecArray | null;
      while ((dMatch = dataRegex.exec(attrs)) !== null) {
        if (dataAttrs.length < 3) {
          dataAttrs.push(`${dMatch[1]}="${dMatch[2].trim()}"`);
        }
      }

      const childInputId = !idAttr
        ? html.match(/<input[^>]*\bid=["']([^"']+)["']/i)?.[1]?.trim()
        : undefined;

      let tagDesc = `<${tag}`;
      if (typeAttr) tagDesc += ` type="${typeAttr}"`;
      if (idAttr) tagDesc += ` id="${idAttr}"`;
      else if (childInputId) tagDesc += ` childInputId="${childInputId}"`;
      if (nameAttr) tagDesc += ` name="${nameAttr}"`;
      if (classAttr) tagDesc += ` class="${classAttr.split(/\s+/).slice(0, 5).join(" ")}"`;
      if (titleAttr) tagDesc += ` title="${titleAttr}"`;
      if (placeholderAttr) tagDesc += ` placeholder="${placeholderAttr}"`;
      if (roleAttr) tagDesc += ` role="${roleAttr}"`;
      if (ariaLabelAttr) tagDesc += ` aria-label="${ariaLabelAttr}"`;
      if (hrefAttr && !/^javascript:/i.test(hrefAttr)) tagDesc += ` href="${hrefAttr}"`;
      if (dataAttrs.length > 0) tagDesc += ` ${dataAttrs.join(" ")}`;
      tagDesc += ">";
      parts.push(tagDesc);
    }
  }
  if (action.selector) {
    const selCandidates = action.selector
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (selCandidates.length > 0) {
      const picked: string[] = [selCandidates[0]];
      for (let i = 1; i < selCandidates.length && picked.length < 3; i++) {
        const cand = selCandidates[i];
        if (/#[a-zA-Z]|\[data-|\._[a-zA-Z0-9_-]+|\[href/i.test(cand) && !picked.includes(cand)) {
          picked.push(cand);
        }
      }
      parts.push(`selectors: ${picked.join(" , ")}`);
    }
  }
  return parts.length > 0 ? parts.join(" | ") : undefined;
}

/**
 * 하드코딩된 시나리오 분기 없이, 타임스탬프와 범용적인 업무 단계(Workflow Stage) 연속성
 * (1: 메뉴/트리 이동 및 목록 항목 진입, 2: 팝업 열기~조작~닫기, 3: 달력 열기~날짜/시간 선택,
 *  4: 입력창 클릭~타이핑 및 연속 폼 필드/옵션 설정, 5: 입력/선택 직후 검색·로그인·등록·저장 등 실행 버튼 클릭,
 *  6: 직후 알림/확인 팝업 닫기)을 기준으로 의미 단위 내레이션 구간(Window)을 구성합니다.
 */
export function buildNarrationWindows(
  momentsFile: MomentsFile,
  browsePlan?: BrowsePlan | null,
  _slug: string = "",
  _style: NarrationStyle = "manual"
): NarrationWindow[] {
  const totalMs = momentsFile.metadata?.totalDurationMs || 30000;

  let meaningful = (momentsFile.moments || []).filter(
    (m) =>
      m.type === "click" ||
      m.type === "rightclick" ||
      m.type === "dblclick" ||
      m.type === "type" ||
      m.type === "drag" ||
      m.type === "dragAndDrop" ||
      m.type === "upload"
  );

  // 시작 직후 '전체메뉴' 클릭 전에 실수로 찍힌 단일 아이콘 클릭이 있으면 제거
  const firstAllMenuIdx = meaningful.findIndex((m) => /전체메뉴/.test(m.description || ""));
  if (firstAllMenuIdx === 1 && /['"]메신저['"]/.test(meaningful[0].description || "")) {
    meaningful = meaningful.slice(1);
  }

  // browse-plan.json의 액션과 매칭하여 원본 DOM 정보 연결
  const planMeaningful = (browsePlan?.actions || []).filter(
    (a) =>
      a.type === "click" ||
      a.type === "rightclick" ||
      a.type === "dblclick" ||
      a.type === "type" ||
      a.type === "dragAndDrop" ||
      a.type === "upload"
  );

  const rawContextMap = new Map<Moment, RawActionContext>();
  let planCursor = 0;

  for (let i = 0; i < meaningful.length; i++) {
    const m = meaningful[i];
    let matchedPlanAction: BrowsePlanAction | undefined;
    for (let j = planCursor; j < planMeaningful.length; j++) {
      if (planMeaningful[j].description === m.description && planMeaningful[j].type === m.type) {
        matchedPlanAction = planMeaningful[j];
        planCursor = j + 1;
        break;
      }
    }
    if (!matchedPlanAction && planMeaningful[i]?.description === m.description) {
      matchedPlanAction = planMeaningful[i];
    }

    const inputValue = (m.keys || matchedPlanAction?.text || "").trim() || undefined;
    rawContextMap.set(m, {
      stepNumber: i + 1,
      timestampSec: Number((m.timestamp / 1000).toFixed(2)),
      type: m.type,
      description: (m.description || "").trim(),
      inputValue,
      domSummary: extractCleanDomSummary(matchedPlanAction),
    });
  }

  if (meaningful.length === 0) {
    return [
      {
        index: 1,
        startMs: 200,
        endMs: Math.min(totalMs - 300, 4800),
        maxChars: 48,
        isIntro: true,
        stepsInWindow: [],
        fallbackLine: "이번 영상에서는 주요 업무 처리 방법을 단계별로 안내해 드립니다.",
      },
    ];
  }

  const normFieldTarget = (s: string) =>
    s
      .replace(/클릭.*$/, "")
      .replace(/에\s*['"].*$/, "")
      .replace(/['"\[\]\s]/g, "")
      .toLowerCase();

  const getModalTag = (desc: string) => desc.match(/\[([^\]]*팝업)\]/)?.[1]?.trim();
  const isConfirmClick = (desc: string) =>
    /\[[^\]]*확인\s*팝업\]|\[알림\s*팝업\]|['"](확인|적용)['"]\s*버튼\s*클릭/i.test(desc) ||
    (/\[[^\]]*팝업\]/.test(desc) && /['"](저장|확인|적용)['"]\s*버튼\s*클릭/.test(desc));
  const isNavMenuClick = (desc: string, dom?: string) =>
    /메뉴\/링크\s*클릭|탭\s*클릭|^['"]전체메뉴['"]|^['"]포탈\s*전체메뉴['"]|^트리\s*['"][^'"]+['"]\s*항목\s*클릭/i.test(desc) ||
    Boolean(dom && /\b(snb|lnb|gnb|dynatree-title)\b/i.test(dom));
  const isDateAction = (desc: string) =>
    /yyyy-mm-dd|hh:mm|달력\s*팝업|날짜\s*클릭|'\d{1,2}일'|'\d{1,2}:\d{2}'/i.test(desc);
  const isInputClick = (m: Moment, desc: string, dom?: string) =>
    m.type === "click" &&
    (/입력창\s*클릭|입력\s*영역\s*클릭|입력란\s*클릭/i.test(desc) ||
      Boolean(dom && /^<(input|textarea)\b|contenteditable/i.test(dom)));
  const isFormOptionClick = (m: Moment, desc: string, dom?: string) =>
    m.type === "click" &&
    !isNavMenuClick(desc, dom) &&
    !isConfirmClick(desc) &&
    (/요소에서\s*['"].*['"]\s*선택|라디오|체크박스|옵션|드롭다운|분류|구분|중요도|공개|비공개|표지|아이콘|권한|승인|사용\s*여부/i.test(desc) ||
      Boolean(dom && /^<(select|label)\b|type="(radio|checkbox)"|\b(chkbox|rdobtn|input_rdo|input_chk)\b/i.test(dom)) ||
      (/요소\s*클릭$/.test(desc) && !/버튼\s*클릭|메뉴\/링크\s*클릭/.test(desc)));
  const isFormOrInputStep = (m: Moment, desc: string, dom?: string) =>
    m.type === "type" || isDateAction(desc) || isInputClick(m, desc, dom) || isFormOptionClick(m, desc, dom);
  const isTriggerOrSubmitClick = (m: Moment, desc: string) =>
    m.type === "click" &&
    (/['"](검색|조회|로그인|Login|등록|적용|추가)['"]\s*(버튼|메뉴\/링크|요소)?\s*클릭/i.test(desc) ||
      /양식\s*카드\s*\[작성\]\s*버튼\s*클릭/i.test(desc));

  const groups: Moment[][] = [];
  let currentGroup: Moment[] = [];

  for (let idx = 0; idx < meaningful.length; idx++) {
    const m = meaningful[idx];
    if (currentGroup.length === 0) {
      currentGroup.push(m);
      continue;
    }

    const groupStart = currentGroup[0].timestamp;
    const prevM = currentGroup[currentGroup.length - 1];
    const sinceGroupStart = m.timestamp - groupStart;
    const sincePrev = m.timestamp - prevM.timestamp;

    const firstDesc = (currentGroup[0].description || "").trim();
    const prevDesc = (prevM.description || "").trim();
    const currDesc = (m.description || "").trim();

    const firstDom = rawContextMap.get(currentGroup[0])?.domSummary;
    const prevDom = rawContextMap.get(prevM)?.domSummary;
    const currDom = rawContextMap.get(m)?.domSummary;

    const firstModal = getModalTag(firstDesc);
    const prevModal = getModalTag(prevDesc);
    const currModal = getModalTag(currDesc);

    // 1. 메뉴/트리 연속 이동 체인 (예: '포탈 전체메뉴' -> '스마트워크', 또는 좌측 트리 메뉴 클릭 -> 목록 문서 클릭)
    const isNavChain =
      isNavMenuClick(firstDesc, firstDom) &&
      isNavMenuClick(currDesc, currDom) &&
      sinceGroupStart < 8500 &&
      sincePrev < 4500;

    // 2. 팝업 열기 버튼 클릭 -> 해당 팝업 내부 조작 -> 팝업 닫기(확인/저장)까지 하나로 묶음
    const prevOpensCurrModal =
      !prevModal &&
      Boolean(currModal) &&
      !/\[알림\s*팝업\]/.test(currModal || "") &&
      currentGroup.length <= 2 &&
      (prevM.type === "click" || prevM.type === "upload") &&
      sincePrev < 4800;

    const isInsideSameModalFlow =
      Boolean(currModal) &&
      !/\[알림\s*팝업\]/.test(currModal || "") &&
      (firstModal === currModal || prevModal === currModal || prevOpensCurrModal) &&
      sinceGroupStart < 12000 &&
      sincePrev < 5200;

    // 3. 날짜/시간 입력창 클릭 -> 달력 날짜/시간 클릭 (또는 제목 입력 직후 날짜 지정까지 하나의 기본정보 설정 단계로 병합)
    const isDateFlow =
      (isDateAction(prevDesc) && isDateAction(currDesc) && sinceGroupStart < 8500 && sincePrev < 4500) ||
      (currentGroup.length === 1 &&
        prevM.type === "type" &&
        isDateAction(currDesc) &&
        !currModal &&
        sincePrev < 3800);

    // 4. 입력 영역 클릭 직후 타이핑 또는 동일 에디터 연속 타이핑
    const isSameInputClickToType =
      prevM.type === "click" &&
      m.type === "type" &&
      sincePrev <= 4000 &&
      (normFieldTarget(prevDesc) === normFieldTarget(currDesc) || isInputClick(prevM, prevDesc, prevDom));

    const isSameEditorConsecutiveType =
      prevM.type === "type" &&
      m.type === "type" &&
      normFieldTarget(prevDesc) === normFieldTarget(currDesc) &&
      sinceGroupStart < 10000 &&
      sincePrev < 5000;

    // 5. 동일 화면(모달 또는 일반 폼) 내 연속 폼 입력/옵션 설정 묶음
    //    (예: 아이디 입력 -> 비밀번호 입력, 구분 라디오 선택 -> 세부 분류 드롭다운 선택 -> 본문 입력 등)
    const prevEndedDatePicker = isDateAction(prevDesc) && /날짜\s*클릭|'\d{1,2}일'|'\d{1,2}:\d{2}'/.test(prevDesc);
    const isConsecutiveFormOrSettingFlow =
      !prevEndedDatePicker &&
      currModal === prevModal &&
      isFormOrInputStep(prevM, prevDesc, prevDom) &&
      isFormOrInputStep(m, currDesc, currDom) &&
      (prevM.type === "type" && m.type === "type"
        ? sinceGroupStart < 9000 && sincePrev < 4800
        : isFormOptionClick(prevM, prevDesc, prevDom)
        ? sinceGroupStart < 9500 && sincePrev < 4500
        : false) &&
      currentGroup.length < 4;

    // 6. 입력/검색/옵션 지정 직후 이를 실행·반영하는 트리거 버튼 클릭 병합
    //    (예: 아이디·비밀번호 입력 -> 'Login' 클릭, 검색어 입력 -> '검색' 클릭 -> 양식 '[작성]' 클릭, 의견 입력 -> '등록' 클릭)
    const groupHasInputOrSearch = currentGroup.some(
      (gm) => gm.type === "type" || /검색|조회|로그인|Login/i.test(gm.description || "")
    );
    const isInputThenTriggerOrSubmit =
      groupHasInputOrSearch &&
      isTriggerOrSubmitClick(m, currDesc) &&
      sincePrev < 5000 &&
      sinceGroupStart < 10500 &&
      currentGroup.length <= 4;

    // 7. 액션 직후 뜨는 확인/알림 팝업('확인') 클릭 병합
    const isConfirmContinuation =
      isConfirmClick(currDesc) &&
      sincePrev < 5500 &&
      currentGroup.length <= 4;

    if (
      isNavChain ||
      prevOpensCurrModal ||
      isInsideSameModalFlow ||
      isDateFlow ||
      isSameInputClickToType ||
      isSameEditorConsecutiveType ||
      isConsecutiveFormOrSettingFlow ||
      isInputThenTriggerOrSubmit ||
      isConfirmContinuation
    ) {
      currentGroup.push(m);
    } else {
      groups.push(currentGroup);
      currentGroup = [m];
    }
  }
  if (currentGroup.length > 0) {
    groups.push(currentGroup);
  }

  // 단독으로 남은 '확인' 클릭은 직전 그룹에 병합
  for (let i = groups.length - 1; i >= 1; i--) {
    const grp = groups[i];
    if (grp.length === 1 && isConfirmClick(grp[0].description || "")) {
      const prevGrp = groups[i - 1];
      const prevLast = prevGrp[prevGrp.length - 1];
      if (grp[0].timestamp - prevLast.timestamp < 6000) {
        prevGrp.push(grp[0]);
        groups.splice(i, 1);
      }
    }
  }

  // 너무 짧은 단독 액션 그룹(< 2.4초)은 맥락이 일치하는 이전/이후 그룹에 병합하여 불필요한 영상 정지(autoHoldMs) 방지
  for (let i = 0; i < groups.length - 1; i++) {
    const grp = groups[i];
    const prevGrp = i > 0 ? groups[i - 1] : undefined;
    const nextGrp = groups[i + 1];
    const afterNextGrp = groups[i + 2];
    const grpSpanMs = nextGrp[0].timestamp - grp[0].timestamp;
    if (grp.length === 1 && grpSpanMs < 2400) {
      const m0 = grp[0];
      const desc0 = (m0.description || "").trim();
      const dom0 = rawContextMap.get(m0)?.domSummary;
      const prevSpanWithCurr = prevGrp ? nextGrp[0].timestamp - prevGrp[0].timestamp : Infinity;
      const nextSpanWithCurr = (afterNextGrp ? afterNextGrp[0].timestamp : totalMs) - grp[0].timestamp;

      // 현재 단독 액션이 폼 입력/옵션이고 직전 그룹도 폼 입력이며 합친 길이가 적절하면 직전 그룹으로 흡수
      if (
        prevGrp &&
        isFormOrInputStep(m0, desc0, dom0) &&
        prevSpanWithCurr <= 10500 &&
        prevGrp.some((pm) => pm.type === "type" || isDateAction(pm.description || ""))
      ) {
        prevGrp.push(m0);
        groups.splice(i, 1);
        i--;
      } else if (nextSpanWithCurr <= 11000) {
        nextGrp.unshift(m0);
        groups.splice(i, 1);
        i--;
      }
    }
  }

  const windows: NarrationWindow[] = [];
  const firstClickMs = groups[0][0].timestamp;

  const makeSimpleFallback = (steps: RawActionContext[]): string => {
    if (steps.length === 0) return "해당 단계를 진행합니다.";
    const last = steps[steps.length - 1];
    return `${last.description.replace(/클릭$/, "클릭합니다").replace(/입력$/, "입력합니다")}.`;
  };

  const firstGroupEndLimitMs = groups[1] ? groups[1][0].timestamp - 250 : totalMs - 200;

  if (firstClickMs >= 3200 || firstGroupEndLimitMs >= 7500) {
    // 첫 액션 전에 여유 시간이 충분하거나(>=3.2s), 첫 번째 그룹 구간 전체가 충분히 긴 경우(>=7.5s, 예: 연속 입력 묶음 등)
    // 오프닝(Intro) 구간과 첫 번째 업무 단계 구간을 분리하되 영상이 멈추지 않도록 시작 시각을 배분합니다.
    const introStartMs = 200;
    const introEndMs =
      firstClickMs >= 3200
        ? Math.min(firstClickMs - 200, 5400)
        : Math.min(4800, Math.max(3200, Math.round(firstGroupEndLimitMs * 0.38)));
    const introDurationMs = Math.max(2400, introEndMs - introStartMs);
    windows.push({
      index: 1,
      startMs: introStartMs,
      endMs: introEndMs,
      maxChars: Math.max(42, Math.min(62, Math.floor((introDurationMs / 1000) * 7.5))),
      isIntro: true,
      stepsInWindow: [],
      fallbackLine: "이번 영상에서는 그룹웨어 주요 업무 처리 방법을 단계별로 안내해 드립니다.",
    });

    for (let i = 0; i < groups.length; i++) {
      const grp = groups[i];
      const nextGrp = groups[i + 1];
      const rawStart =
        i === 0
          ? Math.max(introEndMs + 150, grp[0].timestamp - 200)
          : Math.max(windows[windows.length - 1].endMs + 150, grp[0].timestamp - 200);
      const nextStart = nextGrp ? Math.max(rawStart + 2200, nextGrp[0].timestamp - 250) : totalMs - 200;
      const windowDurationMs = Math.max(2400, Math.min(10500, nextStart - rawStart));
      const endMs = Math.min(totalMs - 100, rawStart + windowDurationMs);
      const maxChars = Math.max(36, Math.min(68, Math.floor((windowDurationMs / 1000) * 7.2)));
      const stepsInWindow = grp
        .map((m) => rawContextMap.get(m))
        .filter((s): s is RawActionContext => Boolean(s));

      windows.push({
        index: windows.length + 1,
        startMs: rawStart,
        endMs,
        maxChars,
        isIntro: false,
        stepsInWindow,
        fallbackLine: makeSimpleFallback(stepsInWindow),
      });
    }
  } else {
    for (let i = 0; i < groups.length; i++) {
      const grp = groups[i];
      const nextGrp = groups[i + 1];
      const rawStart = i === 0 ? 200 : Math.max(300, grp[0].timestamp - 200);
      const nextStart = nextGrp ? Math.max(rawStart + 2400, nextGrp[0].timestamp - 250) : totalMs - 200;
      const windowDurationMs = Math.max(i === 0 ? 3200 : 2400, Math.min(10500, nextStart - rawStart));
      const endMs = Math.min(totalMs - 100, rawStart + windowDurationMs);
      const maxChars = Math.max(i === 0 ? 44 : 36, Math.min(68, Math.floor((windowDurationMs / 1000) * 7.2)));
      const stepsInWindow = grp
        .map((m) => rawContextMap.get(m))
        .filter((s): s is RawActionContext => Boolean(s));

      windows.push({
        index: windows.length + 1,
        startMs: rawStart,
        endMs,
        maxChars,
        isIntro: i === 0,
        stepsInWindow,
        fallbackLine: makeSimpleFallback(stepsInWindow),
      });
    }
  }

  return windows;
}

function getStylePromptInstruction(style: NarrationStyle): string {
  switch (style) {
    case "friendly":
      return `- 말투 스타일: [친절한 튜토리얼 강사형 (해요체)]
- 첫 번째 구간(index: 1)은 전체 액션 흐름을 바탕으로 이 영상이 어떤 기능/업무를 다루는지 친근하게 소개하며 시작하세요("안녕하세요! 이번 영상에서는 ~하는 방법을 차근차근 알아볼게요." 등). 만약 index: 1 구간에 첫 액션(stepsInWindow)이 포함되어 있다면 오프닝 인사와 첫 단계의 목적을 한 문장으로 자연스럽게 연결하세요.
- 이후 구간은 커서가 보여주는 단순 클릭 동작 나열이 아니라, 각 업무 단계를 왜 수행하는지(목적·역할·효과)를 짚어주며 "~위해 설정해 줄게요", "~지정해 줍니다", "~공유해 볼게요"처럼 자연스러운 강사 화법(해요체)을 사용하세요.`;
    case "presentation":
      return `- 말투 스타일: [전문 솔루션 시연 발표형 (하십시오체/발표체)]
- 첫 번째 구간(index: 1)은 전체 액션 흐름을 바탕으로 "지금부터 ~하는 전체 과정을 단계별로 시연하겠습니다."처럼 신뢰감 있는 발표 오프닝으로 시작하세요.
- 이후 구간은 각 단계의 업무적 목적과 기대 효과를 함께 짚어주며 "~환경을 구성하겠습니다", "~설정해 주겠습니다", "~절차를 마무리합니다"처럼 전문적인 프레젠테이션 화법을 사용하세요.`;
    case "compact":
      return `- 말투 스타일: [핵심 기능 해설 브리핑형 (간결한 합니다체)]
- 첫 번째 구간(index: 1)은 전체 액션 흐름을 요약하여 "~매뉴얼을 시작합니다."를 포함해 핵심 목적을 명쾌하게 소개하세요.
- 불필요한 조작 묘사(클릭, 입력창 선택 등)는 덜어내고 각 구간의 업무적 목적과 결과만 간결하게 전달하세요.`;
    case "manual":
    default:
      return `- 말투 스타일: [정석 매뉴얼 해설형 (표준 합니다체)]
- 첫 번째 구간(index: 1)은 전체 액션 흐름을 바탕으로 이 영상이 어떤 업무 매뉴얼인지("이번 영상에서는 ~하는 방법을 단계별로 안내해 드립니다" 등) 소개하는 오프닝 내용을 포함하세요. 만약 index: 1에 첫 액션(stepsInWindow)이 함께 들어 있다면 오프닝 소개와 첫 단계의 목적을 자연스럽게 한 문장으로 이어 주세요.
- 이후 구간은 단순 UI 조작(어디를 클릭하고 무엇을 누르는지) 나열이 아니라, 해당 단계를 **왜 수행하는지(업무적 목적·기능적 역할·적용 효과)**를 중심으로 설명하는 매뉴얼 해설 어조를 사용하세요.`;
  }
}

export async function generateNarrationScript(
  slug: string,
  options?: {
    voice?: string;
    rate?: string;
    pitch?: string;
    style?: NarrationStyle;
    enabled?: boolean;
    showSubtitles?: boolean;
    synthesizeAudio?: boolean;
  }
): Promise<NarrationFile> {
  const scenarioDir = path.join(DATA_DIR, slug);
  const momentsPath = path.join(scenarioDir, "moments.json");
  const browsePlanPath = path.join(scenarioDir, "browse-plan.json");

  if (!fs.existsSync(momentsPath)) {
    throw new Error(`'${slug}' 시나리오의 moments.json 파일이 없습니다. 먼저 녹화를 진행해주세요.`);
  }

  const momentsFile: MomentsFile = JSON.parse(fs.readFileSync(momentsPath, "utf-8"));
  const browsePlan: BrowsePlan | null = fs.existsSync(browsePlanPath)
    ? JSON.parse(fs.readFileSync(browsePlanPath, "utf-8"))
    : null;

  const existing = getNarration(slug);
  const style: NarrationStyle = options?.style || existing?.style || "manual";
  const voice = options?.voice || existing?.voice || "ko-KR-SunHiNeural";
  const rate = options?.rate || existing?.rate || "+5%";
  const pitch = options?.pitch || STYLE_DEFAULT_PITCH[style] || "+0Hz";
  const enabled = options?.enabled ?? existing?.enabled ?? true;
  const showSubtitles = options?.showSubtitles ?? existing?.showSubtitles ?? true;

  const windows = buildNarrationWindows(momentsFile, browsePlan, slug, style);
  const allSteps = windows.flatMap((w) => w.stepsInWindow);

  let finalWindows: NarrationWindow[] = windows.map((w) => ({ ...w }));
  let generatedLines: string[] = finalWindows.map((w) => w.fallbackLine);

  const apiKeys = [process.env.GEMINI_API_KEY, process.env.GEMINI_API_KEY_ALT].filter(Boolean) as string[];
  if (apiKeys.length > 0) {
    const config = getConfig();
    const candidateModels = Array.from(
      new Set([
        config.geminiModel || "gemini-2.5-flash",
        "gemini-2.5-flash",
        "gemini-flash-latest",
      ])
    );

    const styleInstruction = getStylePromptInstruction(style);
    const prompt = `당신은 기업용 그룹웨어 교육 영상의 전문 매뉴얼 해설 작가입니다.

아래 [1. 전체 시나리오 원본 액션 흐름 (처음~끝)]은 사용자가 브라우저에서 실제로 수행한 처음부터 끝까지의 모든 액션과 실제 DOM 요소 정보(\`domSummary\`: 태그, id, class, href, data-*, 의미론적 후보 셀렉터 등)입니다.
그리고 [2. 내레이션 타임라인 구간 목록]은 의미 단위로 묶인 구간(\`index\`)들입니다.

전체 시나리오의 앞뒤 맥락과 \`domSummary\`에 담긴 기능적 단서(예: \`href="/ekp/service/api/file/install/toolbox"\`, \`li._TOOLBOX\`, \`#wikiBookReg_...\`, \`#smwWorkReg_...\`, \`#eapDocReg_...\` 등)를 깊이 있게 분석하여, 시청자가 **"이 작업을 왜 하는지(Why)"**와 **"전체 업무 흐름에서 어떤 의미와 효과가 있는지"** 명확히 이해할 수 있는 매뉴얼 해설 대본을 작성하세요.

[말투 및 오프닝 작성 규칙]
${styleInstruction}

[매뉴얼 해설 대본 작성 핵심 원칙]
1. **커서가 이미 보여주는 조작법(How)을 일일이 중계하지 말고, 왜 하는지(Why·목적·효과)를 설명하세요**:
   - 화면 속 마우스 커서와 줌 효과가 이미 '어느 입력창을 클릭하는지', '드롭다운을 여는지', '달력에서 날짜를 누르는지', '확인/검색/등록 버튼을 누르는지' 시각적으로 다 보여줍니다.
   - 따라서 "입력창을 클릭하고~", "드롭다운 메뉴에서~", "날짜 입력창을 클릭하여~", "검색 버튼을 눌러~", "등록 버튼을 눌러~"처럼 **단순 UI 조작 수단(How)을 기계적으로 낭독하지 마세요.**
   - 대신 \`domSummary\`와 전후 맥락을 바탕으로 **무엇을 위해 이 단계를 수행하는지(업무적 이유, 기능적 목적, 적용 효과)**를 해설하세요:
     * (예: 계정 인증/접속 단계) 아이디·비밀번호·로그인 클릭을 따로 설명하지 않고, "그룹웨어의 업무 서비스를 이용하기 위해 계정 정보를 입력하고 로그인하여 메인 포털에 접속합니다."처럼 목적과 흐름을 하나로 설명
     * (예: 설치프로그램/파일 다운로드 단계) \`domSummary\`의 \`href\`나 클래스(\`_TOOLBOX\` 등)를 확인하여 단순히 "설치프로그램을 클릭하고 Windows를 눌러 다운로드합니다"가 아니라, "PC에서 그룹웨어 부가 기능과 툴박스 연동 도구를 원활하게 사용할 수 있도록 설치프로그램 메뉴에서 운영체제에 맞는 설치 파일을 다운로드합니다."처럼 **설치 이유와 대상의 역할**을 설명
     * (예: 업무/일정/문서 작성 및 옵션 설정 단계) 각 입력칸이나 체크박스를 낱개로 읽지 않고, "처리할 업무의 제목과 완료 기한을 지정하여 일정을 명확히 설정합니다", "업무 성격에 맞는 구분과 세부 분류를 지정하고 본문에 구체적인 내용을 작성합니다", "문서 운영 방식에 맞춰 댓글 허용 및 등록 승인 옵션을 설정합니다"처럼 **해당 설정의 목적**을 설명
     * (예: 타임라인/댓글/결재선/문서 조회 단계) "진행 상황이나 전달 사항을 타임라인 의견으로 등록해 담당자들과 공유합니다", "상신된 문서의 결재 진행 상태를 확인하기 위해 결재현황에서 문서를 조회합니다"처럼 **업무적 가치**를 설명
2. **연속된 잔여 구간 병합(\`windowIndices\`) 허용**:
   - 만약 [2. 내레이션 타임라인 구간 목록]에서 인접한 두 구간(예: \`index: 3\`과 \`index: 4\`)이 사실상 하나의 동일한 소목적(Sub-goal)을 수행하는 연속 과정이어서 한 문장으로 묶어 설명하는 것이 훨씬 자연스럽다면, 응답 JSON에서 \`{"windowIndices": [3, 4], "text": "..."}\`처럼 인접 구간 번호 배열로 묶어서 1개의 대본으로 통합할 수 있습니다. (단, 오프닝인 \`index: 1\`은 단독 유지하세요.)
3. **시연용 예시 입력값과 환경별 선택값은 일반화하세요**:
   - 시연자가 타이핑한 예시 문자열(\`inputValue\`), 특정 날짜/시간 숫자, 특정 부서/사원/업무함/양식명, 첨부 예시 파일명, 그리고 라디오·체크박스·드롭다운·운영체제 선택값 등은 그대로 읽지 말고 "계정 정보", "사용할 기안 양식", "업무 성격에 맞는 분류", "사용 환경에 맞는 설치 파일"처럼 범용 매뉴얼 표현으로 안내하세요.
4. **화면에 없는 허구 조건 창작 금지 및 JSON 출력 형식 준수**:
   - DOM이나 액션 맥락에 근거가 없는 허구의 제약 조건을 지어내지 마세요.
   - 각 항목의 글자 수(공백 포함)는 해당 구간의 \`maxChars\`(병합 시 최대 72자) 이내로 작성하세요.
   - 반드시 아래 JSON 배열 형식으로만 응답하세요 (1번부터 마지막 구간까지 빠짐없이 순서대로 포함):
     [{"windowIndices": [1], "text": "..."}, {"windowIndices": [2], "text": "..."}, ...]

[1. 전체 시나리오 원본 액션 흐름 (처음~끝)]
${JSON.stringify(allSteps, null, 2)}

[2. 내레이션 타임라인 구간 목록]
${JSON.stringify(
  windows.map((w) => ({
    index: w.index,
    isIntro: Boolean(w.isIntro),
    timeRangeSec: `${(w.startMs / 1000).toFixed(1)}s ~ ${(w.endMs / 1000).toFixed(1)}s`,
    maxChars: w.maxChars,
    stepsInWindow: w.stepsInWindow,
  })),
  null,
  2
)}`;

    let aiSuccess = false;
    for (const model of candidateModels) {
      if (aiSuccess) break;
      for (const apiKey of apiKeys) {
        try {
          const ai = new GoogleGenAI({ apiKey });
          const response = await ai.models.generateContent({
            model,
            contents: prompt,
            config: {
              temperature: 0.3,
              responseMimeType: "application/json",
            },
          });

          const rawText = (response.text || "").trim();
          recordAiUsage({
            feature: "AI 대본 생성",
            model,
            slug,
            usageMetadata: response.usageMetadata,
            fallbackPromptChars: prompt.length,
            fallbackOutputChars: rawText.length,
          });
          const parsed = JSON.parse(rawText);
          if (Array.isArray(parsed) && parsed.length > 0) {
            const hasMergedIndices = parsed.some(
              (item) => Array.isArray(item?.windowIndices) && item.windowIndices.length > 0
            );
            if (hasMergedIndices) {
              const rebuiltWindows: NarrationWindow[] = [];
              const rebuiltLines: string[] = [];
              const covered = new Set<number>();

              for (const item of parsed) {
                const rawIndices: number[] = Array.isArray(item.windowIndices)
                  ? item.windowIndices.map((n: any) => Number(n))
                  : item.index !== undefined
                  ? [Number(item.index)]
                  : [];
                const validIndices = rawIndices
                  .filter((n) => Number.isInteger(n) && n >= 1 && n <= windows.length && !covered.has(n))
                  .sort((a, b) => a - b);
                if (validIndices.length === 0) continue;

                validIndices.forEach((n) => covered.add(n));
                const firstW = windows[validIndices[0] - 1];
                const lastW = windows[validIndices[validIndices.length - 1] - 1];
                const mergedSteps = validIndices.flatMap((n) => windows[n - 1].stepsInWindow);
                const mergedW: NarrationWindow = {
                  index: rebuiltWindows.length + 1,
                  startMs: firstW.startMs,
                  endMs: lastW.endMs,
                  maxChars: Math.min(74, firstW.maxChars + (validIndices.length > 1 ? 12 : 0)),
                  isIntro: Boolean(firstW.isIntro),
                  stepsInWindow: mergedSteps,
                  fallbackLine: firstW.fallbackLine,
                };
                rebuiltWindows.push(mergedW);
                rebuiltLines.push(
                  typeof item.text === "string" && item.text.trim() ? item.text.trim() : mergedW.fallbackLine
                );
              }

              // 만약 AI가 일부 구간 번호를 누락했다면 누락된 구간도 안전하게 보존
              for (let wIdx = 1; wIdx <= windows.length; wIdx++) {
                if (!covered.has(wIdx)) {
                  const w = windows[wIdx - 1];
                  rebuiltWindows.push({ ...w, index: rebuiltWindows.length + 1 });
                  rebuiltLines.push(w.fallbackLine);
                }
              }

              if (rebuiltWindows.length > 0) {
                const pairs = rebuiltWindows.map((w, i) => ({ w, line: rebuiltLines[i] }));
                pairs.sort((a, b) => a.w.startMs - b.w.startMs);
                finalWindows = pairs.map((p, i) => ({ ...p.w, index: i + 1 }));
                generatedLines = pairs.map((p) => p.line);
                aiSuccess = true;
                break;
              }
            } else {
              for (const item of parsed) {
                const idx = Number(item.index) - 1;
                if (idx >= 0 && idx < finalWindows.length && typeof item.text === "string" && item.text.trim()) {
                  generatedLines[idx] = item.text.trim();
                }
              }
              aiSuccess = true;
              break;
            }
          }
        } catch (err: any) {
          console.warn(`[Narration AI] 모델 ${model} 호출 실패, 다음 후보 시도 (${err?.message || err})`);
        }
      }
    }
  }

  const cues: NarrationCue[] = finalWindows.map((w, i) => ({
    id: i + 1,
    startMs: w.startMs,
    endMs: w.endMs,
    videoStartMs: w.startMs,
    videoEndMs: w.endMs,
    extraHoldMs: 0,
    isIntro: w.isIntro,
    text: generatedLines[i] || w.fallbackLine,
  }));

  const narrationFile: NarrationFile = {
    slug,
    voice,
    rate,
    pitch,
    style,
    enabled,
    showSubtitles,
    updatedAt: new Date().toISOString(),
    cues,
  };

  saveNarrationFile(slug, narrationFile);

  if (options?.synthesizeAudio !== false) {
    synthesizeNarrationAudio(slug, voice, rate, pitch);
  }

  return getNarration(slug) || narrationFile;
}

export function getNarration(slug: string): NarrationFile | null {
  const narrationPath = path.join(DATA_DIR, slug, "narration.json");
  if (!fs.existsSync(narrationPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(narrationPath, "utf-8"));
  } catch {
    return null;
  }
}

export function computeTimeRegionsAndSyncCues(
  cues: NarrationCue[],
  rawTotalMs: number,
  fps: number = 60
): { timeRegions: TimeRegion[]; totalCompFrames: number; rawTotalFrames: number } {
  const safeRawMs = Math.max(1000, Math.round(rawTotalMs || 15000));
  const rawTotalFrames = Math.max(1, Math.round((safeRawMs / 1000) * fps));

  if (!cues || cues.length === 0) {
    return {
      timeRegions: [
        {
          videoStartFrame: 0,
          videoEndFrame: rawTotalFrames,
          compStartFrame: 0,
          compEndFrame: rawTotalFrames,
          speed: 1.0,
        },
      ],
      totalCompFrames: rawTotalFrames,
      rawTotalFrames,
    };
  }

  for (const cue of cues) {
    const vStart = cue.videoStartMs !== undefined && cue.videoStartMs !== null ? cue.videoStartMs : cue.startMs;
    cue.videoStartMs = Math.max(0, Math.min(safeRawMs - 150, Math.round(Number(vStart) || 0)));
    cue.extraHoldMs = Math.round(Number(cue.extraHoldMs) || 0);
  }

  cues.sort((a, b) => (a.videoStartMs || 0) - (b.videoStartMs || 0));
  let minV = 0;
  cues.forEach((cue, idx) => {
    cue.id = idx + 1;
    if ((cue.videoStartMs || 0) < minV) {
      cue.videoStartMs = Math.min(safeRawMs - 100, minV);
    }
    minV = (cue.videoStartMs || 0) + 100;
  });

  const msToRawF = (ms: number) => Math.max(0, Math.min(rawTotalFrames, Math.round((ms / 1000) * fps)));
  const timeRegions: TimeRegion[] = [];
  let compCursorF = 0;

  const firstVF = msToRawF(cues[0].videoStartMs || 0);
  if (firstVF > 0) {
    timeRegions.push({
      videoStartFrame: 0,
      videoEndFrame: firstVF,
      compStartFrame: 0,
      compEndFrame: firstVF,
      speed: 1.0,
    });
    compCursorF = firstVF;
  }

  const nCues = cues.length;
  for (let i = 0; i < nCues; i++) {
    const cue = cues[i];
    const vStartMs = cue.videoStartMs || 0;
    const rawNextV = i + 1 < nCues ? (cues[i + 1].videoStartMs || vStartMs + 100) : Math.max(vStartMs + 200, safeRawMs);
    const vEndMs = Math.max(vStartMs + 100, rawNextV);
    cue.videoEndMs = vEndMs;

    const rawGapMs = Math.max(100, vEndMs - vStartMs);
    const audioDurMs = Math.round(Number(cue.audioDurationMs) || 0);
    const speechPadMs = i === nCues - 1 ? 260 : 180;
    const minSpeechWindowMs = audioDurMs > 0 ? audioDurMs + speechPadMs : 400;

    const autoHoldMs = Math.max(0, minSpeechWindowMs - rawGapMs);
    const extraHoldMs = Math.round(Number(cue.extraHoldMs) || 0);

    const baseWindowMs = Math.max(rawGapMs, minSpeechWindowMs);
    const minAllowedWindowMs = Math.max(minSpeechWindowMs, Math.max(300, Math.round(rawGapMs * 0.25)));
    const compGapMs = Math.max(minAllowedWindowMs, baseWindowMs + extraHoldMs);
    const effectiveDeltaMs = compGapMs - rawGapMs;

    cue.autoHoldMs = autoHoldMs;
    cue.extraHoldMs = extraHoldMs;
    cue.effectiveDeltaMs = effectiveDeltaMs;
    cue.playbackRate = 1.0;

    const vStartF = msToRawF(vStartMs);
    let vEndF = i === nCues - 1 ? rawTotalFrames : msToRawF(vEndMs);
    if (vEndF <= vStartF) {
      vEndF = Math.min(rawTotalFrames, vStartF + 1);
    }

    const rawFrames = Math.max(1, vEndF - vStartF);
    const compFrames = Math.max(1, Math.round((compGapMs / 1000) * fps));
    const deltaFrames = compFrames - rawFrames;

    cue.startMs = Math.round((compCursorF / fps) * 1000);
    const cueDurForSub = audioDurMs > 0 ? audioDurMs : Math.min(compGapMs, 2500);
    cue.endMs = cue.startMs + cueDurForSub;

    if (Math.abs(deltaFrames) <= 1) {
      timeRegions.push({
        videoStartFrame: vStartF,
        videoEndFrame: vEndF,
        compStartFrame: compCursorF,
        compEndFrame: compCursorF + compFrames,
        speed: Number((rawFrames / compFrames).toFixed(5)),
        cueId: cue.id,
      });
    } else if (deltaFrames > 1) {
      const isIntro = Boolean(cue.isIntro || (i === 0 && vStartMs <= 600));
      const holdRawF = isIntro
        ? 1
        : Math.min(Math.max(2, Math.round(0.08 * fps)), Math.max(1, Math.floor(rawFrames / 4)));
      let holdVStart = vStartF;
      let holdVEnd = Math.min(vEndF, vStartF + holdRawF);
      if (!isIntro) {
        const tailGlideF = Math.min(Math.round(0.45 * fps), Math.max(0, rawFrames - holdRawF - 2));
        holdVEnd = vEndF - tailGlideF;
        holdVStart = Math.max(vStartF, holdVEnd - holdRawF);
      }

      const preRawF = holdVStart - vStartF;
      const actHoldRawF = Math.max(1, holdVEnd - holdVStart);
      const postRawF = vEndF - holdVEnd;
      const holdCompF = actHoldRawF + deltaFrames;
      let cCur = compCursorF;

      if (preRawF > 0) {
        timeRegions.push({
          videoStartFrame: vStartF,
          videoEndFrame: holdVStart,
          compStartFrame: cCur,
          compEndFrame: cCur + preRawF,
          speed: 1.0,
          cueId: cue.id,
        });
        cCur += preRawF;
      }

      timeRegions.push({
        videoStartFrame: holdVStart,
        videoEndFrame: holdVEnd,
        compStartFrame: cCur,
        compEndFrame: cCur + holdCompF,
        speed: Number((actHoldRawF / holdCompF).toFixed(5)),
        cueId: cue.id,
      });
      cCur += holdCompF;

      if (postRawF > 0) {
        timeRegions.push({
          videoStartFrame: holdVEnd,
          videoEndFrame: vEndF,
          compStartFrame: cCur,
          compEndFrame: cCur + postRawF,
          speed: 1.0,
          cueId: cue.id,
        });
        cCur += postRawF;
      }
    } else {
      timeRegions.push({
        videoStartFrame: vStartF,
        videoEndFrame: vEndF,
        compStartFrame: compCursorF,
        compEndFrame: compCursorF + compFrames,
        speed: Number((rawFrames / compFrames).toFixed(5)),
        cueId: cue.id,
      });
    }

    compCursorF += compFrames;
  }

  return {
    timeRegions,
    totalCompFrames: Math.max(1, compCursorF),
    rawTotalFrames,
  };
}

export function saveNarrationFile(slug: string, narration: NarrationFile): NarrationFile {
  const scenarioDir = path.join(DATA_DIR, slug);
  if (!fs.existsSync(scenarioDir)) {
    fs.mkdirSync(scenarioDir, { recursive: true });
  }

  narration.slug = slug;
  narration.updatedAt = new Date().toISOString();
  if (narration.style && !narration.pitch) {
    narration.pitch = STYLE_DEFAULT_PITCH[narration.style] || "+0Hz";
  }
  narration.cues = (narration.cues || [])
    .filter((c) => c && typeof c.text === "string" && c.text.trim().length > 0)
    .map((c, idx) => ({
      ...c,
      id: idx + 1,
      startMs: Math.max(0, Math.round(Number(c.startMs) || 0)),
      endMs: Math.max(Math.round(Number(c.startMs) || 0) + 500, Math.round(Number(c.endMs) || 2000)),
      videoStartMs: c.videoStartMs !== undefined ? Math.max(0, Math.round(Number(c.videoStartMs) || 0)) : Math.max(0, Math.round(Number(c.startMs) || 0)),
      extraHoldMs: Math.round(Number(c.extraHoldMs) || 0),
      text: c.text.trim(),
    }));

  let rawTotalMs = 15000;
  let fps = 60;
  const momentsPath = path.join(scenarioDir, "moments.json");
  const editPlanPath = path.join(scenarioDir, "edit-plan.json");
  let editPlan: EditPlan | null = null;

  if (fs.existsSync(editPlanPath)) {
    try {
      editPlan = JSON.parse(fs.readFileSync(editPlanPath, "utf-8"));
      if (editPlan) {
        fps = Number(editPlan.fps) || 60;
        const rawF = editPlan.rawDurationFrames || editPlan.totalDurationFrames;
        if (rawF) {
          rawTotalMs = Math.round((rawF / fps) * 1000);
        }
      }
    } catch {}
  }

  if (fs.existsSync(momentsPath)) {
    try {
      const mData: MomentsFile = JSON.parse(fs.readFileSync(momentsPath, "utf-8"));
      if (mData?.metadata?.totalDurationMs && mData.metadata.totalDurationMs > 0) {
        rawTotalMs = Math.round(mData.metadata.totalDurationMs);
      }
    } catch {}
  }

  const { timeRegions, totalCompFrames, rawTotalFrames } = computeTimeRegionsAndSyncCues(
    narration.cues,
    rawTotalMs,
    fps
  );

  const narrationPath = path.join(scenarioDir, "narration.json");
  fs.writeFileSync(narrationPath, JSON.stringify(narration, null, 2), "utf-8");

  // Also sync into edit-plan.json so Remotion always has the latest narration object and timeRegions
  if (editPlan) {
    try {
      editPlan.rawDurationFrames = rawTotalFrames;
      editPlan.totalDurationFrames = totalCompFrames;
      editPlan.timeRegions = timeRegions;
      editPlan.narration = narration;
      fs.writeFileSync(editPlanPath, JSON.stringify(editPlan, null, 2), "utf-8");
    } catch {}
  }

  return narration;
}

export function synthesizeNarrationAudio(
  slug: string,
  voice?: string,
  rate?: string,
  pitch?: string
): NarrationFile | null {
  const args = ["scripts/synthesize-tts.py", slug];
  if (voice) args.push("--voice", voice);
  if (rate) args.push("--rate", rate);
  if (pitch) args.push("--pitch", pitch);

  const res = spawnSync("python", args, {
    cwd: ROOT_DIR,
    encoding: "utf-8",
  });

  if (res.status !== 0) {
    console.warn(`[Narration TTS] synthesize-tts.py 오류:`, res.stderr || res.stdout);
  }

  return getNarration(slug);
}

export function ensurePublicNarrationAssets(slug: string): void {
  const narration = getNarration(slug);
  if (!narration) return;

  const srcAudioDir = path.join(DATA_DIR, slug, "audio");
  const destAudioDir = path.join(PUBLIC_DIR, "narration", slug);

  if (fs.existsSync(srcAudioDir)) {
    fs.mkdirSync(destAudioDir, { recursive: true });
    for (const file of fs.readdirSync(srcAudioDir)) {
      if (file.endsWith(".mp3")) {
        fs.copyFileSync(path.join(srcAudioDir, file), path.join(destAudioDir, file));
      }
    }
  }

  saveNarrationFile(slug, narration);
}

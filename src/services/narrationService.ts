import { GoogleGenAI } from "@google/genai";
import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";
import * as dotenv from "dotenv";
import { recordAiUsage } from "./aiUsageTracker";
import { generateAiContent, getGeminiApiKeys } from "./aiClient";
import type {
  BrowsePlan,
  BrowsePlanAction,
  EditPlan,
  IntroTocConfig,
  IntroTocItem,
  Moment,
  MomentsFile,
  NarrationCue,
  NarrationFile,
  NarrationStyle,
  TimeRegion,
} from "../types";
import { getConfig } from "./configManager";
import { ensureSiteBrandForScenario } from "./siteBrandService";
import { bakeOpeningSlideIntoRecording } from "./slideVideoComposer";

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

  // 항상 첫 번째 구간(index: 1, isIntro: true)을 첫 액션 직전의 오프닝/목차 소개 전용 구간으로 배치하여
  // 오프닝 내레이션 및 매뉴얼 목차(Intro TOC) 화면이 표시되는 동안 첫 클릭이 가려지지 않고 자연스럽게 본 화면으로 이어지도록 합니다.
  const introStartMs = firstClickMs >= 500 ? 200 : Math.max(0, firstClickMs - 300);
  const introEndMs =
    firstClickMs >= 3200
      ? Math.min(firstClickMs - 200, 5400)
      : Math.max(introStartMs + 200, firstClickMs - 150);
  windows.push({
    index: 1,
    startMs: introStartMs,
    endMs: introEndMs,
    maxChars: 110,
    isIntro: true,
    stepsInWindow: [],
    fallbackLine:
      "이번 영상에서는 그룹웨어의 핵심 기능 개념을 살펴보고, 주요 메뉴 진입과 업무 처리 절차를 단계별로 안내해 드립니다.",
  });

  for (let i = 0; i < groups.length; i++) {
    const grp = groups[i];
    const nextGrp = groups[i + 1];
    const rawStart =
      i === 0
        ? Math.max(introEndMs + 100, grp[0].timestamp - 150)
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

  return windows;
}

function extractSmartTitleFromOpening(openingText: string, fallbackSlug: string): string {
  const txt = String(openingText || "").trim();
  const m = txt.match(
    /(?:영상에서는|시간에는|매뉴얼에서는|지금부터는?)\s+(.+?)\s*(?:을|를)?\s*(?:단계별로\s*|순서대로\s*|차근차근\s*|함께\s*)?(?:안내|설명|소개|시연|알아보|살펴보|시작)/
  );
  if (m && m[1]) {
    const cleaned = m[1]
      .replace(/\s*(?:하는\s*방법|처리\s*절차|전체\s*과정|사용\s*방법|활용법|기능)(?:을|를)?$/, (sub) =>
        sub.replace(/(?:을|를)$/, "")
      )
      .replace(/(?:을|를)$/, "")
      .trim();
    if (cleaned.length >= 3 && cleaned.length <= 36) {
      return cleaned;
    }
  }
  const m2 = txt.match(/^([가-힣A-Za-z0-9\s·/]{2,24}?)(?:은|는)\s+.+?(?:메뉴|기능|도구|시스템|모듈|공간|서비스)(?:입니다|이며)/);
  if (m2 && m2[1]) {
    const subject = m2[1].trim();
    if (subject.length >= 2 && subject.length <= 24) {
      return `${subject} 사용 및 관리 안내`;
    }
  }
  const slugMap: Record<string, string> = {
    taskboard: "태스크보드 업무 및 할 일 관리 안내",
    smartwork: "스마트워크 업무함 활용 안내",
    approval: "전자결재 기안 및 결재 처리 안내",
    schedule: "일정관리 등록 및 공유 안내",
    calendar: "일정관리 등록 및 공유 안내",
    reservation: "자원예약 신청 및 관리 안내",
    board: "게시판 게시글 작성 및 조회 안내",
    mail: "전자우편 작성 및 수발신 안내",
    memo: "사내쪽지 발송 및 확인 안내",
    address: "주소록 연락처 등록 및 관리 안내",
    doc: "문서관리 등록 및 분류 안내",
    wiki: "위키 페이지 작성 및 협업 안내",
  };
  const lowerSlug = String(fallbackSlug || "").toLowerCase().trim();
  for (const [k, v] of Object.entries(slugMap)) {
    if (lowerSlug === k || lowerSlug.startsWith(`${k}-`) || lowerSlug.startsWith(`${k}_`)) {
      return v;
    }
  }
  const cleanSlug = String(fallbackSlug || "그룹웨어 업무 매뉴얼").replace(/[-_]+/g, " ").trim();
  return /^live\s+demo\s+\d+$/i.test(cleanSlug) || /^[a-z0-9\s]+$/i.test(cleanSlug)
    ? "그룹웨어 주요 기능 사용 매뉴얼"
    : cleanSlug;
}

function extractSmartStepTitleFromCueText(cueText: string, idx: number): string {
  let clause = String(cueText || "").trim().replace(/\.$/, "");
  if (!clause) return `주요 단계 ${idx + 1}`;

  const splitters = [
    /기\s*위해\s+/,
    /을\s*통해\s+/,
    /를\s*통해\s+/,
    /이동하여\s+/,
    /접속하여\s+/,
    /클릭하여\s+/,
    /선택하여\s+/,
    /입력하여\s+/,
    /확인하며\s+/,
    /접속한\s*후\s+/,
    /이동한\s*후\s+/,
    /클릭한\s*후\s+/,
    /입력한\s*뒤\s+/,
    /선택한\s*뒤\s+/,
    /지정하고\s+/,
    /입력하고\s+/,
    /선택하고\s+/,
    /클릭하고\s+/,
    /,\s*/,
  ];
  for (const sp of splitters) {
    const parts = clause.split(sp);
    if (parts.length > 1 && parts[parts.length - 1].trim().length >= 5) {
      clause = parts[parts.length - 1].trim();
    }
  }
  clause = clause
    .replace(/^.+?(?:입력하고|선택하고|클릭하고|지정하고|설정하고|추가하고|접속한\s*후|입력한\s*뒤)\s+/, "")
    .replace(/내려\s*받으실\s*수\s*있습니다$/, "다운로드")
    .replace(/내려\s*받습니다$/, "다운로드")
    .replace(
      /(?:을|를)\s*([가-힣A-Za-z0-9\s]{1,12}?)(?:합니다|입니다|할\s*수\s*있습니다|하실\s*수\s*있습니다|드립니다|해\s*볼게요|보시겠습니다|주겠습니다)$/,
      " $1"
    )
    .replace(
      /(?:에|으로|로)\s*(로그인|이동|접속|진입|전환|저장|등록)(?:합니다|할\s*수\s*있습니다|하실\s*수\s*있습니다|해\s*볼게요|보시겠습니다)$/,
      " $1"
    )
    .replace(
      /(?:합니다|입니다|할\s*수\s*있습니다|하실\s*수\s*있습니다|드립니다|해\s*볼게요|보시겠습니다|주겠습니다)$/,
      ""
    )
    .replace(/\s+/g, " ")
    .trim();

  if (clause.length > 22) {
    const words = clause.split(" ");
    let acc = "";
    for (const w of words) {
      if ((acc ? `${acc} ${w}` : w).length <= 22) {
        acc = acc ? `${acc} ${w}` : w;
      } else {
        break;
      }
    }
    clause = (acc || clause.slice(0, 20)).replace(/\s+(?:및|와|과|의|을|를|에|에서|으로|로|후|뒤)$/, "").trim();
  }
  return clause.length >= 3 ? clause : `주요 단계 ${idx + 1}`;
}

function toOverviewBulletText(rawLine: string, shortTitle: string): string {
  const txt = String(rawLine || "")
    .trim()
    .replace(/\.$/, "")
    .replace(/(?:안내|소개|설명)\s*방법을\s*(?:안내|소개|설명)합니다$/, "방법을 안내합니다");
  if (!txt) return `${shortTitle} 방법과 주요 기능을 안내합니다.`;
  if (/(?:소개합니다|안내합니다|설명합니다|살펴봅니다|알아봅니다)$/.test(txt)) {
    return `${txt}.`;
  }
  let core = txt
    .replace(/^.+?위해\s+/, "")
    .replace(/(?:을|를)\s*(?:입력하고|선택하고|클릭하고)\s+/, " 및 ");

  const endingRules: Array<[RegExp, string]> = [
    [/에\s*로그인합니다$/, " 로그인 방법을 소개합니다"],
    [/내려\s*받으실\s*수\s*있습니다$/, " 다운로드 방법을 소개합니다"],
    [/내려\s*받습니다$/, " 다운로드 방법을 소개합니다"],
    [/이동할\s*수\s*있습니다$/, " 이동 및 메뉴 구성을 안내합니다"],
    [/이동합니다$/, " 이동 방법을 안내합니다"],
    [/확인합니다$/, " 확인 방법을 안내합니다"],
    [/조회할\s*수\s*있습니다$/, " 조회 방법을 소개합니다"],
    [/조회합니다$/, " 조회 방법을 소개합니다"],
    [/(?:합니다|입니다|할\s*수\s*있습니다|하실\s*수\s*있습니다|드립니다|해\s*볼게요|보시겠습니다)$/, " 방법을 안내합니다"],
  ];
  for (const [pattern, replacement] of endingRules) {
    if (pattern.test(core)) {
      core = core.replace(pattern, replacement);
      break;
    }
  }
  return `${core.trim()}.`;
}

function stripVersionAndConversationalText(raw: string): string {
  return String(raw || "")
    .replace(/\b(?:ver\.?|v\.?)\s*\d+(?:\.\d+)*\b/gi, "")
    .replace(/이번\s*(?:시간|영상|매뉴얼|과정)에서는\s+[^.?!]+[.?!]?/g, "")
    .replace(/지금부터는?\s+[^.?!]+[.?!]?/g, "")
    .replace(/(?:안내|소개|설명)\s*방법을\s*(?:안내|소개|설명)합니다/g, "방법을 안내합니다")
    .replace(/\s+/g, " ")
    .trim();
}

function buildFallbackIntroToc(
  slug: string,
  windows: NarrationWindow[],
  lines: string[]
): IntroTocConfig {
  const openingLine = (lines[0] || "").trim();
  const title = extractSmartTitleFromOpening(openingLine, slug);

  const summary = `${title}의 주요 메뉴 구성과 활용 방법을 안내합니다.`;

  const stepPairs = windows
    .map((w, idx) => ({ w, line: (lines[idx] || w.fallbackLine || "").trim() }))
    .filter((p, idx) => idx > 0 && p.line.length > 0);

  const naturalCount =
    stepPairs.length <= 4
      ? stepPairs.length
      : Math.min(5, Math.max(3, Math.ceil(stepPairs.length / 4)));
  const pickedPairs =
    stepPairs.length <= naturalCount
      ? stepPairs
      : Array.from({ length: naturalCount }, (_, i) =>
          stepPairs[Math.min(stepPairs.length - 1, Math.floor((i * stepPairs.length) / naturalCount))]
        );

  const items: IntroTocItem[] = pickedPairs.map((p, idx) => {
    const firstStepDesc = p.w.stepsInWindow?.[0]?.description || "";
    const cleanStepTitle = firstStepDesc
      .replace(/^\[[^\]]+\]\s*/, "")
      .replace(/['"]/g, "")
      .replace(/\s*(버튼|메뉴\/링크|입력창|요소)\s*클릭.*$/, "")
      .trim();
    const shortTitle =
      cleanStepTitle && cleanStepTitle.length >= 2 && cleanStepTitle.length <= 22
        ? cleanStepTitle
        : extractSmartStepTitleFromCueText(p.line, idx);
    return {
      title: shortTitle,
      description: toOverviewBulletText(p.line, shortTitle),
    };
  });

  if (items.length === 0) {
    items.push({
      title: "주요 기능 안내",
      description: summary,
    });
  }

  return {
    enabled: true,
    badge: "그룹웨어 사용 매뉴얼",
    title,
    summary,
    items,
  };
}

function normalizeIntroToc(
  rawToc: any,
  fallback: IntroTocConfig,
  enabledDefault: boolean = true
): IntroTocConfig {
  if (!rawToc || typeof rawToc !== "object") {
    return { ...fallback, enabled: enabledDefault };
  }
  const badge =
    typeof rawToc.badge === "string" && stripVersionAndConversationalText(rawToc.badge)
      ? stripVersionAndConversationalText(rawToc.badge)
      : fallback.badge || "그룹웨어 사용 매뉴얼";
  const title =
    typeof rawToc.title === "string" && stripVersionAndConversationalText(rawToc.title)
      ? stripVersionAndConversationalText(rawToc.title)
      : fallback.title;
  const cleanedSummary =
    typeof rawToc.summary === "string" ? stripVersionAndConversationalText(rawToc.summary) : "";
  const summary = cleanedSummary || fallback.summary;
  const rawItems = Array.isArray(rawToc.items) ? rawToc.items : [];
  const items: IntroTocItem[] = rawItems
    .map((it: any) => {
      if (typeof it === "string") {
        const cleanStr = stripVersionAndConversationalText(it);
        return { title: "", description: cleanStr };
      }
      const t = typeof it?.title === "string" ? stripVersionAndConversationalText(it.title) : "";
      const d = typeof it?.description === "string" ? stripVersionAndConversationalText(it.description) : "";
      return { title: t, description: d || t };
    })
    .filter((it: IntroTocItem) => it.title.length > 0 || it.description.length > 0)
    .slice(0, 8);

  return {
    enabled: rawToc.enabled !== undefined ? Boolean(rawToc.enabled) : enabledDefault,
    badge,
    title,
    summary,
    items: items.length > 0 ? items : fallback.items,
  };
}

function getStylePromptInstruction(style: NarrationStyle): string {
  switch (style) {
    case "friendly":
      return `- 말투 스타일: [친절한 튜토리얼 강사형 (해요체)]
- 첫 번째 구간(index: 1, 오프닝)은 단순히 "이번 영상에서는 ~를 알아볼게요" 한 줄로 끝내지 말고, **이 영상에서 다루는 기능·메뉴가 무엇인지(개념과 역할 설명) + 이번 영상에서 어떤 내용을 차례대로 살펴볼지** 2문장(75~110자)으로 친절하게 소개하며 시작하세요.
- 이후 구간에서도 특정 메뉴나 모듈(예: 태스크보드, 스마트워크, 기록물철, 설치프로그램 등)을 클릭할 때 "태스크보드를 클릭해요"가 아니라 "부서와 개인의 할 일을 보드 형태로 한눈에 관리하는 태스크보드 메뉴로 이동해 볼게요"처럼 **그 메뉴/기능이 무엇인지 먼저 이해시켜 주며** 설명하세요.`;
    case "presentation":
      return `- 말투 스타일: [전문 솔루션 시연 발표형 (하십시오체/발표체)]
- 첫 번째 구간(index: 1, 오프닝)은 **이 영상에서 시연할 핵심 모듈·기능의 개념과 역할**을 먼저 정의하고, 이어서 전체 시연 구성을 2문장(75~110자)으로 브리핑하며 시작하세요.
- 이후 구간은 각 메뉴나 기능의 개념·목적·기대 효과를 함께 짚어주며 전문적인 프레젠테이션 화법을 사용하세요.`;
    case "compact":
      return `- 말투 스타일: [핵심 기능 해설 브리핑형 (간결한 합니다체)]
- 첫 번째 구간(index: 1, 오프닝)은 다루는 핵심 기능의 개념과 이번 매뉴얼의 전체 구성을 명쾌하게 2문장 이내로 요약 소개하세요.
- 이후 구간은 클릭 동작 묘사를 덜어내고 각 메뉴/기능의 역할과 업무적 목적을 간결하게 전달하세요.`;
    case "manual":
    default:
      return `- 말투 스타일: [정석 매뉴얼 해설형 (표준 합니다체)]
- 첫 번째 구간(index: 1, 오프닝)은 단순히 "이번 영상에서는 ~를 안내합니다" 한 줄로 끝내지 말고, **이 영상에서 다루는 화면·기능(예: 그룹웨어 기본 포털, 태스크보드, 스마트워크, 전자결재 등)이 어떤 기능인지 개념과 역할을 먼저 설명한 뒤, 이번 영상에서 다룰 핵심 내용을 2문장(75~110자)으로 안내**하세요.
- 이후 구간에서도 특정 메뉴나 기능(예: 태스크보드, 설치프로그램, 기록물철, AI Chat 등)을 클릭할 때 시청자가 "저게 무슨 메뉴인데 클릭하지?"라는 의문이 들지 않도록, **"할 일과 업무 진행 단계를 보드 형태로 시각화해 관리하는 태스크보드 메뉴로 이동합니다"**처럼 **해당 메뉴·기능의 개념과 목적을 함께 설명**하세요.`;
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
    showIntroToc?: boolean;
    synthesizeAudio?: boolean;
  }
): Promise<NarrationFile> {
  const scenarioDir = path.join(DATA_DIR, slug);
  const momentsPath = path.join(scenarioDir, "moments.json");
  const bodyMomentsPath = path.join(scenarioDir, "moments.body.json");
  const browsePlanPath = path.join(scenarioDir, "browse-plan.json");

  if (!fs.existsSync(momentsPath) && !fs.existsSync(bodyMomentsPath)) {
    throw new Error(`'${slug}' 시나리오의 moments.json 파일이 없습니다. 먼저 녹화를 진행해주세요.`);
  }

  // 이미 오프닝 슬라이드가 합성된 시나리오에서 대본을 재생성할 때는 순수 본문 타임스탬프(moments.body.json)를 기준으로 구간을 산출합니다.
  const sourceMomentsPath = fs.existsSync(bodyMomentsPath) ? bodyMomentsPath : momentsPath;
  const momentsFile: MomentsFile = JSON.parse(fs.readFileSync(sourceMomentsPath, "utf-8"));
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
  const showIntroToc = options?.showIntroToc ?? existing?.showIntroToc ?? existing?.introToc?.enabled ?? true;

  const windows = buildNarrationWindows(momentsFile, browsePlan, slug, style);
  const allSteps = windows.flatMap((w) => w.stepsInWindow);

  let finalWindows: NarrationWindow[] = windows.map((w) => ({ ...w }));
  let generatedLines: string[] = finalWindows.map((w) => w.fallbackLine);
  let aiIntroTocRaw: any = null;

  const config = getConfig();
  const apiKeys = getGeminiApiKeys();
  if (config.aiMode === "cli" || apiKeys.length > 0) {
    const styleInstruction = getStylePromptInstruction(style);
    const prompt = `당신은 기업용 그룹웨어 온라인 교육(웨비나/매뉴얼)의 전문 기획자이자 해설 작가입니다.

아래 [1. 전체 시나리오 원본 액션 흐름 (처음~끝)]은 사용자가 브라우저에서 실제로 시연한 액션과 DOM 요소 정보(\`domSummary\`)입니다.
그리고 [2. 내레이션 타임라인 구간 목록]은 의미 단위로 묶인 구간(\`index\`)들입니다.

전체 시나리오의 맥락과 \`domSummary\`를 깊이 있게 분석하여:
1) 영상 시작 시 화면 전체에 표시할 **교육 개요 및 목차 슬라이드(\`introToc\`)**와
2) 시청자가 **"지금 다루는 메뉴/기능이 대체 무엇인지(개념·역할)"**와 **"이 작업을 왜 하는지(Why)"**를 완벽히 이해할 수 있는 **내레이션 대본(\`cues\`)**을 작성하세요.

[말투 및 오프닝 작성 규칙]
${styleInstruction}

[1. 오프닝 교육 개요 및 목차 슬라이드 (\`introToc\`) 작성 규칙 — 대본(\`cues\`) 문장이나 구어체 대화 복사 절대 금지!]
- \`introToc\`는 내레이션 대본을 적어 놓는 공간이 아니라, 프레젠테이션 첫 장에 보여주는 **깔끔한 문서형 목차(Contents) 슬라이드**입니다.
- **절대 금지**: 슬라이드 텍스트(\`badge\`, \`title\`, \`summary\`, \`items\`)에 \`"이번 시간에는 ~"\`, \`"이번 영상에서는 ~"\`, \`"지금부터 ~"\` 같은 구어체 발표 대본을 넣지 마세요. 또한 \`Ver 7.5\` 같은 버전 정보도 절대 넣지 마세요.
- \`badge\`: 좌측 표지 타이틀 (예: \`"그룹웨어 사용 매뉴얼"\`, \`"전자결재 운영 매뉴얼"\`, \`"스마트워크 사용 매뉴얼"\`)
- \`title\`: 이 영상 전체를 대표하는 교육 제목 (예: \`"그룹웨어 접속 및 기본 화면 안내"\`, \`"태스크보드 업무 관리 및 협업 가이드"\`)
- \`summary\`: 제목 아래에 들어갈 **1줄짜리 간결한 매뉴얼 부제/정의 (35자 이내, 구어체 금지)**
  * (예 1): \`"그룹웨어 접속 및 기본 화면을 안내합니다."\`
  * (예 2): \`"할 일과 업무 진행 단계를 보드 형태로 관리하는 협업 도구를 안내합니다."\`
- \`items\`: 이 영상의 실제 시연 내용과 분량에 맞춰 **핵심 교육 목차(Contents) 항목들을 AI가 자율적으로 도출(개수 고정 금지 — 짧은 시나리오는 2~3개, 일반/긴 시나리오는 3~6개 등 시연 흐름에 맞게 자연스럽게 구성)**하여 아래 예시처럼 \`title\`(핵심 소제목 8~16자)과 \`description\`(\`"~방법을 소개합니다."\`, \`"~기능을 안내합니다."\` 형태의 간결한 1줄 개요)으로 작성하세요:
  * (예시 — 항목 개수는 시나리오의 실제 단계와 내용에 따라 자율 결정):
    - \`title\`: \`"웹·전용 앱 접속 및 로그인"\`, \`description\`: \`"계정 로그인 방법과 PC·모바일 전용 앱의 설치 경로를 소개합니다."\`
    - \`title\`: \`"상단 기본 업무 메뉴 둘러보기"\`, \`description\`: \`"결재, 전자우편, 공지사항, 일정관리 등 주요 포털 메뉴 구성을 안내합니다."\`
    - \`title\`: \`"전체메뉴 및 협업 모듈 이동"\`, \`description\`: \`"포탈 전체메뉴를 통한 스마트워크, 태스크보드, 문서관리 이동 방법을 소개합니다."\`

[2. 매뉴얼 해설 대본 (\`cues\`) 작성 핵심 원칙]
1. **어떤 메뉴나 기능을 클릭할 때 "그 메뉴/기능이 무엇인지(개념과 역할)"를 반드시 함께 설명하세요**:
   - 예를 들어 사용자가 '태스크보드'를 클릭할 때 "태스크보드를 클릭합니다"라고만 하면, 시청자는 **"태스크보드가 뭔데 클릭하지?"**라고 의문을 갖게 됩니다.
   - 따라서 메뉴·모듈·기능(예: 태스크보드, 스마트워크, 기록물철, 설치프로그램, AI Chat, 공지사항, 전자결재 등)을 진입하거나 실행할 때는 반드시 **그 기능이 어떤 역할을 하는지 개념 설명**을 자연스럽게 포함하세요:
     * (나쁜 예): "태스크보드 메뉴를 클릭합니다."
     * (좋은 예): "부서나 개인의 할 일과 진행 상태를 보드 형태로 한눈에 관리할 수 있는 태스크보드 메뉴로 이동합니다."
     * (좋은 예): "부서 보존 문서와 업무 기록을 체계적으로 분류해 보관하는 기록물철 메뉴에 접속하여 문서 현황을 조회합니다."
     * (좋은 예): "PC 전용 메신저와 부가 연동 도구를 내려받을 수 있는 상단 설치프로그램 메뉴에서 설치 파일을 다운로드합니다."
2. **단순 UI 조작법(How: 입력창 클릭, 드롭다운 열기, 버튼 클릭) 나열을 피하고 업무적 목적(Why)을 해설하세요**:
   - 화면 속 마우스 커서가 어디를 누르는지는 이미 보이므로, 각 설정과 입력이 어떤 업무적 의미와 효과를 갖는지를 설명하세요.
3. **연속된 잔여 구간 병합(\`windowIndices\`) 허용**:
   - 인접한 두 구간(예: \`index: 3\`과 \`index: 4\`)이 동일한 소목적을 수행하는 연속 과정이면 \`{"windowIndices": [3, 4], "text": "..."}\`처럼 병합할 수 있습니다. (단, 오프닝인 \`index: 1\`은 단독 유지하세요.)
4. **시연용 예시 입력값 일반화 및 JSON 출력 형식 준수**:
   - 구체적인 시연용 입력값이나 특정 개인/부서명은 범용 매뉴얼 어휘로 일반화하세요.
   - 오프닝(\`index: 1\`)은 75~115자 내외(2문장), 일반 구간은 각 구간의 \`maxChars\`(병합 시 최대 74자) 이내로 작성하세요.
   - 반드시 아래 JSON 객체 형식으로만 응답하세요:
     {
       "introToc": {
         "badge": "그룹웨어 사용 매뉴얼",
         "title": "그룹웨어 접속 및 기본 화면 안내",
         "summary": "그룹웨어 접속 및 기본 화면을 안내합니다.",
         "items": [
           {"title": "웹·전용 앱 접속 및 로그인", "description": "계정 로그인 방법과 PC·모바일 전용 앱의 설치 경로를 소개합니다."},
           {"title": "상단 기본 업무 메뉴 둘러보기", "description": "결재, 전자우편, 공지사항, 일정관리 등 주요 포털 메뉴 구성을 안내합니다."},
           {"title": "전체메뉴 및 협업 모듈 이동", "description": "포탈 전체메뉴를 통한 스마트워크, 태스크보드, 문서관리 이동 방법을 소개합니다."},
           {"title": "AI Chat 및 실시간 통합알림 활용", "description": "대화형 AI Chat 실행 방법과 우측 상단 실시간 통합알림 확인 기능을 안내합니다."}
         ]
       },
       "cues": [
         {"windowIndices": [1], "text": "..."},
         {"windowIndices": [2], "text": "..."}
       ]
     }

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

    try {
      const aiRes = await generateAiContent({
        feature: "AI 대본 생성",
        prompt,
        temperature: 0.3,
        jsonMode: true,
        slug,
        timeoutMs: 120_000,
      });

      const rawText = aiRes.text;
      const parsedRoot = JSON.parse(rawText);
      const parsedCues = Array.isArray(parsedRoot)
        ? parsedRoot
        : Array.isArray(parsedRoot?.cues)
        ? parsedRoot.cues
        : [];
      if (parsedRoot && !Array.isArray(parsedRoot) && parsedRoot.introToc) {
        aiIntroTocRaw = parsedRoot.introToc;
      }

      if (Array.isArray(parsedCues) && parsedCues.length > 0) {
        const hasMergedIndices = parsedCues.some(
          (item: any) => Array.isArray(item?.windowIndices) && item.windowIndices.length > 0
        );
        if (hasMergedIndices) {
          const rebuiltWindows: NarrationWindow[] = [];
          const rebuiltLines: string[] = [];
          const covered = new Set<number>();

          for (const item of parsedCues) {
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
          }
        } else {
          for (const item of parsedCues) {
            const idx = Number(item.index) - 1;
            if (idx >= 0 && idx < finalWindows.length && typeof item.text === "string" && item.text.trim()) {
              generatedLines[idx] = item.text.trim();
            }
          }
        }
      }
    } catch (err: any) {
      console.warn(`[Narration AI] 호출 실패, 규칙 기반 폴백 대본 사용 (${err?.message || err})`);
    }
  }

  const siteBrand = await ensureSiteBrandForScenario(slug);
  const fallbackToc = buildFallbackIntroToc(slug, finalWindows, generatedLines);
  const introToc = normalizeIntroToc(aiIntroTocRaw, fallbackToc, showIntroToc);
  introToc.siteBrand = siteBrand;

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
    showIntroToc,
    introToc,
    siteBrand,
    introBakedIntoVideo: false,
    bakedIntroDurationMs: 0,
    updatedAt: new Date().toISOString(),
    cues,
  };
  (narrationFile as any)._cuesAreUnshiftedBody = true;

  saveNarrationFile(slug, narrationFile);

  if (options?.synthesizeAudio !== false) {
    synthesizeNarrationAudio(slug, voice, rate, pitch);
    await bakeOpeningSlideIntoRecording(slug, { force: true });
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
  fps: number = 60,
  bakedIntroDurationMs: number = 0
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

    // 오프닝 슬라이드가 이미 영상 앞단에 합성된 경우(bakedIntroDurationMs > 0) 첫 번째 오프닝 구간(i === 0 또는 앞단 통합 슬라이드)은
    // 슬라이드 영상 길이가 이미 음성 길이에 맞춰 생성되었으므로 절대로 추가 홀드(⏸ 구간 늘리기)를 발생시키지 않습니다.
    const isBakedIntroCue =
      (i === 0 || (Boolean(cue.isIntro) && (cue.videoStartMs || 0) < Math.max(1000, bakedIntroDurationMs - 200))) &&
      (bakedIntroDurationMs > 0 || (Boolean(cue.isIntro) && rawGapMs >= Math.max(3800, audioDurMs + 200)));

    const autoHoldMs = isBakedIntroCue ? 0 : Math.max(0, minSpeechWindowMs - rawGapMs);
    const extraHoldMs = isBakedIntroCue ? 0 : Math.round(Number(cue.extraHoldMs) || 0);

    const baseWindowMs = isBakedIntroCue ? rawGapMs : Math.max(rawGapMs, minSpeechWindowMs);
    const minAllowedWindowMs = isBakedIntroCue
      ? rawGapMs
      : Math.max(minSpeechWindowMs, Math.max(300, Math.round(rawGapMs * 0.25)));
    const compGapMs = isBakedIntroCue ? rawGapMs : Math.max(minAllowedWindowMs, baseWindowMs + extraHoldMs);
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
    const compFrames = isBakedIntroCue ? rawFrames : Math.max(1, Math.round((compGapMs / 1000) * fps));
    const deltaFrames = compFrames - rawFrames;

    cue.startMs = Math.round((compCursorF / fps) * 1000);
    const cueDurForSub = audioDurMs > 0 ? audioDurMs : Math.min(compGapMs, 2500);
    cue.endMs = cue.startMs + cueDurForSub;
    cue.compStartMs = cue.startMs;
    cue.compEndMs = cue.endMs;

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

  const existingDisk = getNarration(slug);
  const showIntroToc =
    narration.showIntroToc !== undefined
      ? Boolean(narration.showIntroToc)
      : narration.introToc?.enabled !== undefined
      ? Boolean(narration.introToc.enabled)
      : existingDisk?.showIntroToc !== undefined
      ? Boolean(existingDisk.showIntroToc)
      : true;
  narration.showIntroToc = showIntroToc;

  const pseudoWindows: NarrationWindow[] = narration.cues.map((c, i) => ({
    index: i + 1,
    startMs: c.startMs,
    endMs: c.endMs,
    maxChars: 60,
    isIntro: Boolean(c.isIntro || i === 0),
    stepsInWindow: [],
    fallbackLine: c.text,
  }));
  const fallbackToc = buildFallbackIntroToc(
    slug,
    pseudoWindows,
    narration.cues.map((c) => c.text)
  );
  narration.introToc = normalizeIntroToc(
    narration.introToc || existingDisk?.introToc,
    fallbackToc,
    showIntroToc
  );
  if (!narration.siteBrand && existingDisk?.siteBrand) {
    narration.siteBrand = existingDisk.siteBrand;
  }
  if (narration.siteBrand && narration.introToc) {
    narration.introToc.siteBrand = narration.siteBrand;
  }
  if (narration.introBakedIntoVideo === undefined && existingDisk?.introBakedIntoVideo !== undefined) {
    narration.introBakedIntoVideo = existingDisk.introBakedIntoVideo;
  }
  if (narration.bakedIntroDurationMs === undefined && existingDisk?.bakedIntroDurationMs !== undefined) {
    narration.bakedIntroDurationMs = existingDisk.bakedIntroDurationMs;
  }
  if ((narration as any)._bakedSlideSig === undefined && (existingDisk as any)?._bakedSlideSig) {
    (narration as any)._bakedSlideSig = (existingDisk as any)._bakedSlideSig;
  }
  if (!Array.isArray((narration as any).mergedFromSlugs)) {
    if (Array.isArray((existingDisk as any)?.mergedFromSlugs)) {
      (narration as any).mergedFromSlugs = (existingDisk as any).mergedFromSlugs;
    } else {
      const bpPath = path.join(scenarioDir, "browse-plan.json");
      if (fs.existsSync(bpPath)) {
        try {
          const bp = JSON.parse(fs.readFileSync(bpPath, "utf-8"));
          if (Array.isArray(bp?.mergedFromSlugs) && bp.mergedFromSlugs.length > 0) {
            (narration as any).mergedFromSlugs = bp.mergedFromSlugs;
          }
        } catch {}
      }
    }
  }

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

  const bakedIntroMs = narration.introBakedIntoVideo ? Math.round(Number(narration.bakedIntroDurationMs) || 0) : 0;
  const { timeRegions, totalCompFrames, rawTotalFrames } = computeTimeRegionsAndSyncCues(
    narration.cues,
    rawTotalMs,
    fps,
    bakedIntroMs
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

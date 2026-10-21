import { GoogleGenAI } from "@google/genai";
import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";
import * as dotenv from "dotenv";
import type {
  BrowsePlan,
  BrowsePlanAction,
  EditPlan,
  Moment,
  MomentsFile,
  NarrationCue,
  NarrationFile,
  NarrationStyle,
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
 * browse-plan.json의 targetHtml 및 selector에서 AI가 화면 요소의 성격과 위치를
 * 정확히 파악할 수 있도록 핵심 DOM 속성(tag, type, id, name, class, title, placeholder)만 간결하게 추출합니다.
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
        attrs.match(new RegExp(`\\b${name}=["']([^"']+)["']`, "i"))?.[1]?.trim();

      const typeAttr = getAttr("type");
      const idAttr = getAttr("id");
      const nameAttr = getAttr("name");
      const classAttr = getAttr("class");
      const titleAttr = getAttr("title");
      const placeholderAttr = getAttr("placeholder");
      const roleAttr = getAttr("role");

      let tagDesc = `<${tag}`;
      if (typeAttr) tagDesc += ` type="${typeAttr}"`;
      if (idAttr) tagDesc += ` id="${idAttr}"`;
      if (nameAttr) tagDesc += ` name="${nameAttr}"`;
      if (classAttr) tagDesc += ` class="${classAttr.split(/\s+/).slice(0, 4).join(" ")}"`;
      if (titleAttr) tagDesc += ` title="${titleAttr}"`;
      if (placeholderAttr) tagDesc += ` placeholder="${placeholderAttr}"`;
      if (roleAttr) tagDesc += ` role="${roleAttr}"`;
      tagDesc += ">";
      parts.push(tagDesc);
    }
  }
  if (action.selector) {
    const firstSel = action.selector.split(",")[0]?.trim();
    if (firstSel) {
      parts.push(`selector: ${firstSel}`);
    }
  }
  return parts.length > 0 ? parts.join(" | ") : undefined;
}

/**
 * 하드코딩된 시나리오 분기 없이, 타임스탬프와 기본적인 UI 상호작용 연속성
 * (1: 상단 메뉴 이동 체인, 2: 동일 팝업 열기~닫기, 3: 달력 열기~날짜 선택,
 *  4: 동일 입력창 클릭 후 타이핑 또는 연속 타이핑, 5: 버튼 클릭 직후 알림창 확인)만을 기준으로
 * 내레이션이 들어갈 시간 구간(Window)을 분할합니다.
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

  const getModalTag = (desc: string) => desc.match(/\[([^\]]*팝업)\]/)?.[1]?.trim();
  const isConfirmClick = (desc: string) =>
    /\[알림\s*팝업\]|['"](확인|적용)['"]\s*버튼\s*클릭/i.test(desc) ||
    (/\[[^\]]*팝업\]/.test(desc) && /['"]저장['"]\s*버튼\s*클릭/.test(desc));
  const isNavMenuClick = (desc: string) =>
    /메뉴\/링크\s*클릭|탭\s*클릭|^['"]전체메뉴['"]|^['"]포탈\s*전체메뉴['"]/i.test(desc);
  const isDateAction = (desc: string) =>
    /yyyy-mm-dd|hh:mm|달력\s*팝업|날짜\s*클릭|'\d{1,2}일'|'\d{1,2}:\d{2}'/i.test(desc);

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

    const firstModal = getModalTag(firstDesc);
    const prevModal = getModalTag(prevDesc);
    const currModal = getModalTag(currDesc);

    // 1. 메뉴 연속 이동 체인 (예: '포탈 전체메뉴' -> '스마트워크')
    const isNavChain =
      isNavMenuClick(firstDesc) &&
      isNavMenuClick(currDesc) &&
      sinceGroupStart < 8500 &&
      sincePrev < 4200;

    // 2. 팝업 열기 버튼 클릭 -> 해당 팝업 내부 조작 -> 팝업 닫기(확인/저장)까지 하나로 묶음
    const prevOpensCurrModal =
      !prevModal &&
      Boolean(currModal) &&
      !/\[알림\s*팝업\]/.test(currModal || "") &&
      currentGroup.length === 1 &&
      prevM.type === "click" &&
      sincePrev < 4500;

    const isInsideSameModalFlow =
      Boolean(currModal) &&
      !/\[알림\s*팝업\]/.test(currModal || "") &&
      (firstModal === currModal || prevModal === currModal || prevOpensCurrModal) &&
      sinceGroupStart < 11000 &&
      sincePrev < 4800;

    // 3. 날짜/시간 입력창 클릭 -> 달력 날짜/시간 클릭
    const isDateFlow =
      isDateAction(prevDesc) &&
      isDateAction(currDesc) &&
      sinceGroupStart < 8500 &&
      sincePrev < 4500;

    // 4. 동일 입력 영역 클릭 직후 타이핑 또는 동일 에디터 연속 타이핑
    const isSameInputClickToType =
      prevM.type === "click" &&
      m.type === "type" &&
      sincePrev <= 3500 &&
      prevDesc.replace(/클릭.*$/, "").trim() === currDesc.replace(/에\s*['"].*$/, "").trim();

    const isSameEditorConsecutiveType =
      prevM.type === "type" &&
      m.type === "type" &&
      prevDesc.replace(/에\s*['"].*$/, "").trim() === currDesc.replace(/에\s*['"].*$/, "").trim() &&
      sinceGroupStart < 8500 &&
      sincePrev < 4500;

    // 5. 동일 모달 내 연속 텍스트 입력 (예: 사용자 등록 팝업 내 아이디/비밀번호/이름 연속 입력)
    const isSameModalConsecutiveType =
      prevM.type === "type" &&
      m.type === "type" &&
      Boolean(currModal && currModal === prevModal) &&
      sinceGroupStart < 9000 &&
      sincePrev < 4500 &&
      currentGroup.length < 4;

    // 6. 액션 직후 뜨는 확인/알림 팝업('확인') 클릭 병합
    const isConfirmContinuation =
      isConfirmClick(currDesc) &&
      sincePrev < 5000 &&
      currentGroup.length <= 3;

    if (
      isNavChain ||
      prevOpensCurrModal ||
      isInsideSameModalFlow ||
      isDateFlow ||
      isSameInputClickToType ||
      isSameEditorConsecutiveType ||
      isSameModalConsecutiveType ||
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
      if (grp[0].timestamp - prevLast.timestamp < 5500) {
        prevGrp.push(grp[0]);
        groups.splice(i, 1);
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

  if (firstClickMs >= 3200) {
    const introStartMs = 200;
    const introEndMs = Math.min(firstClickMs - 200, 5400);
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
      const rawStart = Math.max(introEndMs + 150, grp[0].timestamp - 200);
      const nextStart = nextGrp ? Math.max(rawStart + 2200, nextGrp[0].timestamp - 250) : totalMs - 200;
      const windowDurationMs = Math.max(2200, Math.min(8200, nextStart - rawStart));
      const endMs = Math.min(totalMs - 100, rawStart + windowDurationMs);
      const maxChars = Math.max(34, Math.min(64, Math.floor((windowDurationMs / 1000) * 7.2)));
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
      const windowDurationMs = Math.max(i === 0 ? 3200 : 2200, Math.min(8200, nextStart - rawStart));
      const endMs = Math.min(totalMs - 100, rawStart + windowDurationMs);
      const maxChars = Math.max(i === 0 ? 44 : 34, Math.min(64, Math.floor((windowDurationMs / 1000) * 7.2)));
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
- 첫 번째 구간(index: 1)은 전체 액션 흐름을 바탕으로 이 영상이 어떤 기능/업무를 다루는지 친근하게 소개하며 시작하세요("안녕하세요! 이번 영상에서는 ~하는 방법을 차근차근 알아볼게요." 등). 만약 index: 1 구간에 첫 액션(stepsInWindow)이 포함되어 있다면 오프닝 인사와 첫 이동 동작을 한 문장으로 자연스럽게 연결하세요.
- 이후 구간은 단순 버튼 읽기가 아니라 각 단계의 역할과 화면 흐름을 짚어주며 "~창을 열어 줄게요", "~지정해 줍니다", "~작성해 주세요", "~등록해 볼게요"처럼 자연스러운 강사 화법(해요체)을 사용하세요.`;
    case "presentation":
      return `- 말투 스타일: [전문 솔루션 시연 발표형 (하십시오체/발표체)]
- 첫 번째 구간(index: 1)은 전체 액션 흐름을 바탕으로 "지금부터 ~하는 전체 과정을 단계별로 시연하겠습니다."처럼 신뢰감 있는 발표 오프닝으로 시작하세요.
- 이후 구간은 각 단계의 업무적 목적과 결과를 함께 짚어주며 "~화면으로 이동하겠습니다", "~설정해 주겠습니다", "~절차를 마무리합니다"처럼 전문적인 프레젠테이션 화법을 사용하세요.`;
    case "compact":
      return `- 말투 스타일: [핵심 기능 해설 브리핑형 (간결한 합니다체)]
- 첫 번째 구간(index: 1)은 전체 액션 흐름을 요약하여 "~매뉴얼을 시작합니다."를 포함해 핵심 목적을 명쾌하게 소개하세요.
- 불필요한 수식어는 줄이되 단순 버튼 읽기가 아니라 목적과 결과를 간결하게 전달하세요.`;
    case "manual":
    default:
      return `- 말투 스타일: [정석 매뉴얼 해설형 (표준 합니다체)]
- 첫 번째 구간(index: 1)은 전체 액션 흐름을 바탕으로 이 영상이 어떤 업무 매뉴얼인지("이번 영상에서는 ~하는 방법을 단계별로 안내해 드립니다" 등) 소개하는 오프닝 내용을 포함하세요. 만약 index: 1에 첫 액션(stepsInWindow)이 함께 들어 있다면 오프닝 소개와 첫 이동 동작을 자연스럽게 한 문장으로 이어 주세요.
- 이후 구간은 단순 버튼 이름 읽기가 아니라, 해당 동작의 목적·역할·결과를 함께 설명하는 매뉴얼 해설 어조("~위해 선택 창을 엽니다", "~지정한 뒤 확인을 눌러 반영합니다", "~정상 반영되었는지 확인합니다")를 사용하세요.`;
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

  let generatedLines: string[] = windows.map((w) => w.fallbackLine);

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

아래 [1. 전체 시나리오 원본 액션 흐름 (처음~끝)]은 사용자가 브라우저에서 실제로 수행한 처음부터 끝까지의 모든 액션과 실제 DOM 요소 정보(\`domSummary\`)입니다.
그리고 [2. 내레이션 타임라인 구간 목록]은 영상 시간에 맞춰 대본을 1문장씩 넣어야 할 구간(\`index\`)들입니다.

전체 시나리오의 앞뒤 맥락과 DOM 요소 정보(\`id\`, \`class\`, \`type\`, \`tag\` 등)를 직접 분석하여, 각 구간이 전체 업무 흐름에서 어떤 역할을 하는지 파악하고 자연스러운 **매뉴얼 해설 내레이션 대본**을 구간마다 1문장씩 작성하세요.

[말투 및 오프닝 작성 규칙]
${styleInstruction}

[매뉴얼 해설 대본 작성 핵심 원칙]
1. **전체 흐름 속에서 각 단계의 목적과 역할(Why & Effect)을 파악해 설명하세요**:
   - 단순히 "'선택' 버튼을 클릭합니다", "'확인' 버튼을 클릭합니다"처럼 기계적으로 버튼을 낭독하지 마세요.
   - 앞뒤 액션과 \`domSummary\`를 보고 그 구간이 무엇을 하는 단계인지(예: 상단 전체메뉴에서 모듈 진입, 팝업을 열어 대상 지정 후 확인, 제목·본문 작성, 문서 저장 완료, 저장된 문서 하단의 댓글/타임라인 영역에서 첨부파일 추가 및 의견 등록, 등록된 항목 조회·삭제 등) 정확히 맥락에 맞게 해설하세요.
2. **시연용 예시 입력값과 선택형 옵션값은 그대로 읽지 말고 일반화하세요**:
   - 사용자가 화면에서 반드시 똑같이 눌러야 하는 **고정 메뉴 및 기능 버튼**('전체메뉴', 모듈 메뉴명, '업무 등록', '일정 등록', '결재 작성', '선택', '추가', '파일첨부', '확인', '저장', '등록', '삭제' 등)은 명칭을 정확히 안내하세요.
   - 반면 시연자가 예시로 타이핑한 문자열(\`inputValue\`), 달력에서 고른 특정 날짜/시간 숫자, 조직도·목록에서 고른 특정 부서/사원/업무함/회의실 이름, 첨부한 예시 파일명, 그리고 라디오버튼·체크박스·드롭다운(\`<select>\`)에서 예시로 고른 특정 옵션값은 그대로 읽지 마세요. 시청자는 상황에 따라 다른 값이나 다른 옵션을 선택할 수 있으므로 "제목을 입력합니다", "상황에 맞게 구분 항목이나 세부 옵션을 선택합니다", "달력에서 기한을 지정합니다", "드롭다운에서 해당 분류를 선택합니다"처럼 범용 매뉴얼 문구로 안내하세요.
3. **화면에 없는 억지 전제조건 지어내기 금지 및 자연스러운 문장 연결**:
   - 액션 데이터에 없는 허구의 설정 조건을 상상으로 덧붙이지 마세요.
   - 매 문장마다 기계적으로 "원하는 ~"을 반복하지 말고, 앞뒤 구간이 하나의 매뉴얼 강의처럼 자연스럽게 이어지도록 작성하세요.
4. **글자 수 및 JSON 출력 형식 준수**:
   - 각 구간의 글자 수(공백 포함)는 지정된 \`maxChars\` 이내로 작성하세요.
   - 반드시 JSON 배열 형식으로만 응답하세요: [{"index": 1, "text": "..."}, ...]

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
          const parsed = JSON.parse(rawText);
          if (Array.isArray(parsed) && parsed.length > 0) {
            for (const item of parsed) {
              const idx = Number(item.index) - 1;
              if (idx >= 0 && idx < windows.length && typeof item.text === "string" && item.text.trim()) {
                generatedLines[idx] = item.text.trim();
              }
            }
            aiSuccess = true;
            break;
          }
        } catch (err: any) {
          console.warn(`[Narration AI] 모델 ${model} 호출 실패, 다음 후보 시도 (${err?.message || err})`);
        }
      }
    }
  }

  const cues: NarrationCue[] = windows.map((w, i) => ({
    id: i + 1,
    startMs: w.startMs,
    endMs: w.endMs,
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
    .sort((a, b) => a.startMs - b.startMs)
    .map((c, idx) => ({
      ...c,
      id: idx + 1,
      startMs: Math.max(0, Math.round(Number(c.startMs) || 0)),
      endMs: Math.max(Math.round(Number(c.startMs) || 0) + 500, Math.round(Number(c.endMs) || 2000)),
      text: c.text.trim(),
    }));

  const narrationPath = path.join(scenarioDir, "narration.json");
  fs.writeFileSync(narrationPath, JSON.stringify(narration, null, 2), "utf-8");

  // Also sync into edit-plan.json so Remotion always has the latest narration object
  const editPlanPath = path.join(scenarioDir, "edit-plan.json");
  if (fs.existsSync(editPlanPath)) {
    try {
      const editPlan: EditPlan = JSON.parse(fs.readFileSync(editPlanPath, "utf-8"));
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

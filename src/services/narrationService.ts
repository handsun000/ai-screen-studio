import { GoogleGenAI } from "@google/genai";
import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";
import * as dotenv from "dotenv";
import type {
  BrowsePlan,
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

export interface NarrationWindow {
  index: number;
  startMs: number;
  endMs: number;
  maxChars: number;
  isIntro?: boolean;
  stageRole?: string;
  rawActions?: string[];
  sampleValuesToGeneralize?: string[];
  actionsSummary: string[];
  fallbackLine: string;
}

export const STYLE_DEFAULT_PITCH: Record<NarrationStyle, string> = {
  manual: "+0Hz",
  friendly: "+4Hz",
  presentation: "-3Hz",
  compact: "+2Hz",
};

type StructuralRole =
  | "nav_entry"
  | "create_start"
  | "popup_open"
  | "popup_select"
  | "popup_confirm"
  | "date_open"
  | "date_pick"
  | "form_input"
  | "option_toggle"
  | "file_upload"
  | "drag_drop"
  | "submit_save"
  | "verify_view"
  | "general_action";

interface StructuralMomentMeta {
  role: StructuralRole;
  modalName?: string;
  fieldLabel?: string;
  targetLabel?: string;
  sampleValue?: string;
  aiFact: string;
  fallbackPhrase: string;
}

const STANDARD_UI_MENU_REGEX =
  /^(전체메뉴|포탈|그룹웨어|스마트워크|전자결재|기업결재|공공결재|결재|일정관리|캘린더|자원예약|자원예약관리|게시판|공지사항|문서관리|문서함|위키|전자우편|메일|웹메일|사내쪽지|쪽지|주소록|연락처|파일관리|파일함|업무보고|프로젝트|스페이스|설문조사|메모|할일|근태관리|조직도|조직관리|관리자|환경설정|메신저|최신\s*주제|최신\s*페이지|내\s*업무|업무함|기안함|결재대기|받은메일|보낸메일|보낸쪽지|내\s*일정|공유\s*일정)$/i;

/**
 * 특정 시나리오 하드코딩 없이, 액션의 구조적 형태(메뉴 이동, 팝업 열기/선택/닫기, 날짜 선택, 입력란 타이핑, 옵션 선택, 첨부, 저장/확인)와
 * 화면 라벨([항목명], [팝업명], '버튼명')만을 기반으로 객관적인 구조 메타데이터를 추출합니다.
 */
function analyzeMomentStructure(
  m: Moment,
  context?: { prevMoment?: Moment; nextMoment?: Moment; typedBefore?: string[] }
): StructuralMomentMeta {
  const desc = (m.description || "").trim();
  const keys = (m.keys || "").trim();
  const prevDesc = (context?.prevMoment?.description || "").trim();
  const nextDesc = (context?.nextMoment?.description || "").trim();

  const bracketMatches = Array.from(desc.matchAll(/\[([^\]]+)\]/g)).map((x) => x[1].trim());
  const modalName = bracketMatches.find((b) => /팝업$/.test(b));
  const fieldLabel = bracketMatches.find((b) => !/팝업$/.test(b));

  const quotedMatches = Array.from(desc.matchAll(/['"]([^'"]+)['"]/g)).map((x) => x[1].trim());
  const targetLabel = quotedMatches[quotedMatches.length - 1] || fieldLabel || "";

  // 1. 파일 첨부 (upload)
  if (m.type === "upload" || /파일\s*첨부|첨부파일|에\s*'[^']+'\s*첨부|파일\s*선택/i.test(desc)) {
    const fileSample = quotedMatches[0] || "";
    return {
      role: "file_upload",
      modalName,
      fieldLabel: fieldLabel || "첨부파일",
      sampleValue: fileSample,
      aiFact: `[파일 첨부] '${fieldLabel || "파일 선택"}' 영역에서 첨부 파일을 업로드 (시연용 파일명 '${fileSample}'은 읽지 말 것)`,
      fallbackPhrase: "관련 첨부 파일을 선택해 업로드",
    };
  }

  // 2. 드래그 앤 드롭 (drag / dragAndDrop)
  if (m.type === "drag" || m.type === "dragAndDrop") {
    return {
      role: "drag_drop",
      modalName,
      fieldLabel,
      targetLabel,
      aiFact: `[드래그 이동] ${desc} (시연용 구체 명칭은 일반화하여 드래그 배치 동작으로 설명)`,
      fallbackPhrase: modalName ? `${modalName}에서 대상을 드래그하여 지정 영역에 배치` : "대상을 마우스로 드래그하여 원하는 위치에 배치",
    };
  }

  // 3. 텍스트 타이핑 입력 (type)
  if (m.type === "type" || Boolean(keys)) {
    const rawField = desc
      .replace(/^\[[^\]]*\]\s*/g, "")
      .replace(/에\s*['"][^'"]*['"]\s*입력.*$/i, "")
      .replace(/입력창|입력란|영역/g, "")
      .trim();

    const readableField =
      fieldLabel ||
      (/search|srch|검색/i.test(rawField)
        ? "검색창"
        : /subject|제목/i.test(rawField)
        ? "제목"
        : /본문|에디터|내용/i.test(rawField)
        ? "본문 내용"
        : /설명|_desc/i.test(rawField)
        ? "설명"
        : /사유|why/i.test(rawField)
        ? "사유"
        : /장소/i.test(rawField)
        ? "장소"
        : /태그|tag/i.test(rawField)
        ? "태그"
        : /폴더|folder/i.test(rawField)
        ? "폴더명"
        : /한국어|다국어|명칭/i.test(rawField)
        ? "명칭"
        : /이메일|email|th7/i.test(rawField) || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(keys)
        ? "이메일"
        : /전화|휴대|mobile|phone|th6/i.test(rawField) || /^\d{2,3}-\d{3,4}-\d{4,5}$/.test(keys)
        ? "전화번호"
        : /비밀번호\s*확인|pwdvalid/i.test(rawField)
        ? "비밀번호 확인"
        : /비밀번호|pwd|password/i.test(rawField)
        ? "비밀번호"
        : /아이디|userid|\bid\b/i.test(rawField)
        ? "아이디"
        : /이름|성명|empname|givenname/i.test(rawField)
        ? "이름"
        : /부서|dept/i.test(rawField)
        ? "부서"
        : /직위|직책|pos/i.test(rawField)
        ? "직위"
        : /회사|cmp/i.test(rawField)
        ? "회사"
        : /시작\s*시간|종료\s*시간|hh:mm/i.test(rawField) || /^\d{1,2}:\d{2}$/.test(keys)
        ? "시간"
        : /시작\s*일|종료\s*일|yyyy-mm-dd|기한|날짜/i.test(rawField) || /^\d{4}-\d{2}-\d{2}$/.test(keys)
        ? "날짜"
        : rawField && !/^[a-z0-9_#-]+$/i.test(rawField)
        ? rawField
        : "세부 입력 항목");

    const isDateOrTime = readableField === "시간" || readableField === "날짜";
    return {
      role: isDateOrTime ? "date_pick" : "form_input",
      modalName,
      fieldLabel: readableField,
      sampleValue: keys,
      aiFact: `[텍스트 입력] ${modalName ? `(${modalName}) ` : ""}'${readableField}' 입력란에 값 작성 (시연 입력값 '${keys}'는 절대 그대로 읽지 말고 '${readableField}'을 입력한다고 설명할 것)`,
      fallbackPhrase:
        readableField === "검색창"
          ? "검색창에 키워드를 입력해 대상 항목을 조회"
          : readableField === "본문 내용"
          ? "본문 에디터 영역에 상세 내용을 작성"
          : `${readableField} 입력란에 내용을 작성`,
    };
  }

  // 4. 날짜 / 시간 피커 열기 및 선택
  const isCalendarDayClickAfterDateInput =
    /^['"]?(?:[12]\d|3[01]|[1-9])(?:일)?['"]?\s*(?:요소|메뉴\/링크|버튼)\s*클릭$/i.test(desc) &&
    /yyyy-mm-dd|시작\s*일|종료\s*일|기한|달력|날짜/i.test(prevDesc);

  if (/yyyy-mm-dd|시작\s*일|종료\s*일|기한\s*입력|hh:mm/i.test(desc) && /입력창\s*클릭/.test(desc)) {
    const isTime = /hh:mm|시간/i.test(desc);
    return {
      role: "date_open",
      modalName,
      fieldLabel: isTime ? "시간" : "날짜",
      aiFact: `[${isTime ? "시간" : "날짜"} 선택창 열기] ${desc}`,
      fallbackPhrase: isTime ? "시간 입력란을 클릭해 진행 시간대를 설정" : "날짜 입력란을 클릭해 달력에서 일자를 지정",
    };
  }

  if (
    isCalendarDayClickAfterDateInput ||
    /달력\s*팝업|날짜\s*클릭|\[\s*달력[^\]]*\]/i.test(desc) ||
    /'\d{1,2}일'/.test(desc) ||
    /'\d{1,2}:\d{2}'/.test(desc)
  ) {
    const isTime = /'\d{1,2}:\d{2}'|시간/.test(desc);
    return {
      role: "date_pick",
      modalName,
      fieldLabel: isTime ? "시간" : "날짜",
      sampleValue: targetLabel,
      aiFact: `[${isTime ? "시간" : "달력 날짜"} 지정] ${desc} (시연에서 클릭한 숫자 '${targetLabel}'은 직접 읽지 말고 날짜/시간을 지정한다고 설명할 것)`,
      fallbackPhrase: isTime ? "진행될 시작 및 종료 시간대를 설정" : "달력에서 일정 날짜나 기한을 지정",
    };
  }

  // 5. 시스템 알림창 / 확인창 닫기 ('[알림 팝업] 확인 버튼 클릭' 등)
  if (/\[알림\s*팝업\]|안내\s*팝업\s*확인/i.test(desc)) {
    return {
      role: "popup_confirm",
      modalName: "알림 팝업",
      targetLabel: "확인",
      aiFact: `[알림창 확인] 처리 안내 알림창의 '확인' 버튼 클릭`,
      fallbackPhrase: "안내창의 '확인'을 눌러 처리를 완료",
    };
  }

  // 6. 모달/팝업 내부 조작 ('[OOO 팝업] ...')
  if (modalName) {
    const cleanModalTitle = modalName.replace(/\s*팝업$/, "").trim();
    if (/['"](확인|적용|선택\s*완료)['"]\s*버튼/i.test(desc)) {
      return {
        role: "popup_confirm",
        modalName,
        targetLabel: targetLabel || "확인",
        aiFact: `[팝업 확정 닫기] ${modalName}에서 '${targetLabel || "확인"}' 버튼을 눌러 선택한 설정을 반영`,
        fallbackPhrase: `'${targetLabel || "확인"}'을 눌러 ${cleanModalTitle} 설정을 반영`,
      };
    }
    if (/['"](저장|등록|생성)['"]\s*버튼/i.test(desc)) {
      return {
        role: "submit_save",
        modalName,
        targetLabel: targetLabel || "저장",
        aiFact: `[팝업 저장 완료] ${modalName}에서 '${targetLabel || "저장"}' 버튼을 눌러 입력·설정한 내용을 저장`,
        fallbackPhrase: `${modalName}에서 '${targetLabel || "저장"}' 버튼을 눌러 등록을 완료`,
      };
    }
    if (/['"]선택['"]\s*버튼|['"]일감\s*선택['"]\s*버튼/i.test(desc)) {
      return {
        role: "popup_open",
        modalName,
        fieldLabel,
        targetLabel,
        aiFact: `[하위 선택창 열기] ${desc}`,
        fallbackPhrase: `${fieldLabel || targetLabel} 지정을 위해 선택 창을 열기`,
      };
    }
    // 팝업 내 트리/목록/체크박스/옵션 항목 선택
    const isOptionLike =
      /체크박스|라디오|공개|비공개|사용|권한|라이선스|요소\s*클릭/.test(desc) &&
      !/선택\s*팝업|조직도\s*팝업|관리자\s*팝업|담당자\s*팝업/.test(modalName);
    if (isOptionLike) {
      return {
        role: "option_toggle",
        modalName,
        fieldLabel,
        targetLabel,
        sampleValue: targetLabel,
        aiFact: `[세부 옵션 설정] ${desc} (시연에서는 '${targetLabel}'을 선택했으나 시청자는 다른 옵션도 선택할 수 있으므로, '${targetLabel}'이라는 특정 선택값을 딱 집어 말하지 말고 공개 범위·사용 기능·권한 등 필요한 세부 옵션을 상황에 맞게 선택한다고 설명할 것)`,
        fallbackPhrase: `${cleanModalTitle} 창에서 필요한 세부 옵션을 상황에 맞게 선택`,
      };
    }
    return {
      role: "popup_select",
      modalName,
      fieldLabel,
      targetLabel,
      sampleValue: targetLabel,
      aiFact: `[팝업 내 항목 선택] ${desc} (구체적인 시연용 사원명·부서명·분류명·선택값 '${targetLabel}'은 직접 읽지 말고 일반화하여 설명할 것)`,
      fallbackPhrase: `${cleanModalTitle} 창에서 대상 항목을 선택`,
    };
  }

  // 7. 모달/팝업을 여는 트리거 버튼 클릭 (다음 액션이 '[OOO 팝업]'이거나 '선택'/'추가'/'조직도'/'결재선' 버튼인 경우)
  const nextModalMatch = nextDesc.match(/\[([^\]]+팝업)\]/);
  if (
    nextModalMatch ||
    (/['"](선택|추가|조직도|주소록|결재선|일감\s*선택)['"]\s*버튼/i.test(desc) && Boolean(fieldLabel || targetLabel))
  ) {
    const openedModal = nextModalMatch ? nextModalMatch[1].replace(/\s*팝업$/, "") : fieldLabel || targetLabel;
    // 단, '업무 등록', '문서 등록', '연락처 등록', '주제 등록', '프로젝트 추가' 같은 최상위 작성 시작 버튼은 create_start로 분류
    if (!/^(업무\s*등록|일정\s*등록|예약\s*신청|결재\s*작성|기안\s*작성|주제\s*등록|글\s*등록|글\s*작성|문서\s*등록|쪽지\s*쓰기|쪽지쓰기|메일\s*쓰기|메일쓰기|연락처\s*등록|연락처등록|새\s*폴더|새폴더|프로젝트\s*추가|새\s*프로젝트\s*생성)$/i.test(targetLabel)) {
      return {
        role: "popup_open",
        modalName: nextModalMatch?.[1],
        fieldLabel: fieldLabel || openedModal,
        targetLabel,
        aiFact: `[선택 팝업 열기] ${fieldLabel ? `'${fieldLabel}' 항목의 ` : ""}'${targetLabel || "선택"}' 버튼을 눌러 ${openedModal} 창 열기`,
        fallbackPhrase: `${fieldLabel || openedModal} 지정을 위해 '${targetLabel || "선택"}' 버튼을 클릭해 창을 열기`,
      };
    }
  }

  // 8. 메뉴 / 탭 / 전체메뉴 네비게이션 이동
  if (/메뉴|링크|탭/.test(desc) || /^['"]전체메뉴['"]\s*버튼/i.test(desc)) {
    if (/전체메뉴/i.test(targetLabel)) {
      return {
        role: "nav_entry",
        targetLabel: "전체메뉴",
        aiFact: `[전체메뉴 열기] 상단 '전체메뉴' 버튼을 클릭하여 그룹웨어 전체 모듈 메뉴 열기`,
        fallbackPhrase: "상단 '전체메뉴'를 열기",
      };
    }
    if (/로그아웃/i.test(targetLabel)) {
      return {
        role: "verify_view",
        targetLabel: "로그아웃",
        aiFact: `[로그아웃] 계정 전환을 위해 '로그아웃' 클릭`,
        fallbackPhrase: "'로그아웃'을 클릭해 현재 계정에서 로그아웃",
      };
    }

    const isStandardMenu = STANDARD_UI_MENU_REGEX.test(targetLabel);
    const isCreatedSampleItem =
      !isStandardMenu &&
      targetLabel.length >= 2 &&
      (/테스트|샘플|예시|\d{4}-\d{2}-\d{2}/.test(targetLabel) ||
        Boolean(
          context?.typedBefore?.some(
            (tv) => tv.length >= 2 && (targetLabel.includes(tv) || tv.includes(targetLabel))
          )
        ));

    if (isCreatedSampleItem) {
      return {
        role: /작성/.test(nextDesc) ? "create_start" : "verify_view",
        targetLabel,
        sampleValue: targetLabel,
        aiFact: `[등록 항목 선택/확인] 목록에서 방금 생성·등록한 항목을 클릭하여 상세 화면 조회 (예시 항목명 '${targetLabel}'은 직접 읽지 말 것)`,
        fallbackPhrase: "목록에 등록된 항목을 클릭하여 상세 내용을 확인",
      };
    }

    return {
      role: "nav_entry",
      targetLabel,
      aiFact: `[메뉴 이동] '${targetLabel}' 메뉴로 이동`,
      fallbackPhrase: `'${targetLabel}' 메뉴로 이동`,
    };
  }

  // 9. 등록된 항목 최종 상세 조회 클릭
  if (/상세\s*정보\s*조회|등록된.*클릭/i.test(desc)) {
    return {
      role: "verify_view",
      targetLabel,
      sampleValue: targetLabel,
      aiFact: `[등록 결과 확인] 목록에서 등록된 항목을 클릭하여 상세 내용이 정상 반영되었는지 조회`,
      fallbackPhrase: "목록에 등록된 항목을 클릭하여 상세 내용을 확인",
    };
  }

  // 10. 주요 작성/등록/생성 시작 버튼
  if (
    /^(업무\s*등록|일정\s*등록|예약\s*신청|결재\s*작성|기안\s*작성|업무\s*작성|주제\s*등록|글\s*등록|글\s*작성|문서\s*등록|쪽지\s*쓰기|쪽지쓰기|메일\s*쓰기|메일쓰기|연락처\s*등록|연락처등록|연락처\s*추가|새\s*폴더|새폴더|보고\s*등록|일감\s*등록|설문\s*등록|프로젝트\s*추가|새\s*프로젝트\s*생성|작성|추가)$/i.test(
      targetLabel
    )
  ) {
    return {
      role: "create_start",
      targetLabel,
      aiFact: `[작성/등록 시작] '${targetLabel}' 버튼을 클릭하여 ${nextModalMatch ? `${nextModalMatch[1]} 열기` : "작성 화면 열기"}`,
      fallbackPhrase: nextModalMatch
        ? `'${targetLabel}' 버튼을 눌러 ${nextModalMatch[1].replace(/\s*팝업$/, "")} 창을 열기`
        : `'${targetLabel}' 버튼을 눌러 작성 화면을 열기`,
    };
  }

  // 11. 저장 / 상신 / 발송 / 삭제 / 생성 / 로그인 완료 버튼
  if (/^(저장|발송|보내기|기안상신|결재상신|상신|등록\s*완료|등록|프로젝트\s*생성|공동\s*편집|삭제|login|로그인)$/i.test(targetLabel)) {
    if (/login|로그인/i.test(targetLabel)) {
      return {
        role: "verify_view",
        targetLabel,
        aiFact: `[로그인 실행] '${targetLabel}' 버튼을 눌러 입력한 계정으로 접속 확인`,
        fallbackPhrase: `'${targetLabel}' 버튼을 눌러 정상 접속되는지 확인`,
      };
    }
    return {
      role: "submit_save",
      targetLabel,
      aiFact: `[최종 처리 실행] '${targetLabel}' 버튼 클릭`,
      fallbackPhrase: `입력을 마친 뒤 '${targetLabel}' 버튼을 클릭`,
    };
  }

  // 12. 확인 버튼 (팝업 외부 일반 확인창)
  if (/^확인$/.test(targetLabel)) {
    return {
      role: "popup_confirm",
      targetLabel: "확인",
      aiFact: `[확인 승인] '확인' 버튼을 눌러 설정 또는 안내창 승인`,
      fallbackPhrase: "'확인' 버튼을 눌러 적용",
    };
  }

  // 13. 체크박스 / 라디오 / 부가 옵션 선택 (특정 선택값만 콕 집어 읽지 않고 옵션 설정 가능함을 안내)
  if (/체크박스|라디오|옵션/.test(desc) || /^(비공개|공개|예약사용|중요\s*공지|댓글\s*사용|사용|미사용)$/.test(targetLabel)) {
    return {
      role: "option_toggle",
      fieldLabel,
      targetLabel,
      sampleValue: targetLabel,
      aiFact: `[세부 옵션 설정] ${desc} (시연자는 예시로 '${targetLabel}'을 선택했으나 시청자는 상황에 따라 다른 옵션도 선택할 수 있으므로, '${targetLabel}'이라는 특정 옵션값만 딱 집어 읽지 말고 공개 여부나 부가 기능 등 필요한 세부 옵션을 상황에 맞게 선택·설정한다고 안내할 것)`,
      fallbackPhrase: "상황에 맞게 공개 여부나 필요한 세부 옵션을 선택해 설정",
    };
  }

  // 14. 트리 항목 선택
  if (/트리\s*['"][^'"]+['"]\s*항목/i.test(desc)) {
    return {
      role: "form_input",
      targetLabel,
      sampleValue: targetLabel,
      aiFact: `[트리 항목 선택] 좌측 또는 영역 내 트리에서 대상 항목 선택 (시연용 명칭 '${targetLabel}'은 일반화할 것)`,
      fallbackPhrase: "트리 목록에서 작업할 대상 항목을 선택",
    };
  }

  // 15. 일반 버튼 / 요소 클릭
  return {
    role: "general_action",
    modalName,
    fieldLabel,
    targetLabel,
    aiFact: `[화면 조작] ${desc}`,
    fallbackPhrase: targetLabel ? `'${targetLabel}' 항목을 선택` : "해당 항목을 선택",
  };
}

/**
 * 시나리오 전체 액션과 슬러그를 분석하여 매뉴얼의 핵심 주제를 도출합니다.
 */
export function deriveScenarioTopicSummary(
  slug: string,
  momentsFile: MomentsFile,
  browsePlan?: BrowsePlan | null
): { fullTopic: string; shortPurpose: string } {
  const uiDescriptions: string[] = [];
  for (const m of momentsFile.moments || []) {
    if (m.description) {
      const cleaned = m.description
        .replace(/에\s*['"][^'"]*['"]\s*입력.*$/i, "")
        .replace(/\[사용자\s*(등록|추가)\s*팝업\]\s*['"][^'"]*['"]\s*요소\s*클릭/gi, "[사용자 등록 팝업] 라이선스 선택");
      uiDescriptions.push(cleaned);
    }
  }
  const selectors: string[] = [];
  for (const a of browsePlan?.actions || []) {
    if (a.description) {
      const cleaned = a.description
        .replace(/에\s*['"][^'"]*['"]\s*입력.*$/i, "")
        .replace(/\[사용자\s*(등록|추가)\s*팝업\]\s*['"][^'"]*['"]\s*요소\s*클릭/gi, "[사용자 등록 팝업] 라이선스 선택");
      uiDescriptions.push(cleaned);
    }
    if (a.selector) selectors.push(a.selector);
  }

  const uiJoined = `${slug} ${uiDescriptions.join(" ")}`;
  const fullJoined = `${uiJoined} ${selectors.join(" ")}`;

  if (/조직관리|사용자\s*등록\s*팝업|사용자\s*추가\s*팝업|orgmgt|orgusermng|orgempregform/i.test(fullJoined)) {
    const hasLogin = /btnlogin|로그아웃|login/i.test(fullJoined);
    return {
      fullTopic: hasLogin
        ? "관리자 조직관리에서 신규 사용자 계정을 등록하고 생성된 계정으로 로그인하는 방법"
        : "관리자 조직관리에서 부서별 신규 사용자 계정을 추가하고 등록하는 방법",
      shortPurpose: hasLogin ? "신규 사용자 계정 등록 및 로그인" : "관리자 신규 사용자 계정 등록",
    };
  }

  if (/위키|주제\s*등록|최신\s*주제|최신\s*페이지|wikibook|wikisidemenu|wikimain/i.test(fullJoined)) {
    const hasTopicReg = /주제\s*등록|wikibookreg|bookreg/i.test(fullJoined);
    const hasPageWrite = /wikibookcontent|제목\s*없는\s*페이지|bn-editor|['"]작성['"]\s*버튼/i.test(fullJoined);
    const hasCollabo = /공동\s*편집|_change_collabo/i.test(fullJoined);
    if (hasTopicReg && hasPageWrite) {
      return {
        fullTopic: hasCollabo
          ? "위키에서 새 주제를 등록한 뒤 페이지를 작성하고 공동 편집으로 저장하는 방법"
          : "위키에서 새 주제를 등록하고 페이지를 작성하여 저장하는 방법",
        shortPurpose: hasCollabo ? "위키 주제 등록 및 공동 편집 페이지 작성" : "위키 주제 등록 및 페이지 작성",
      };
    }
    if (hasTopicReg) {
      return {
        fullTopic: "위키에서 새 주제를 등록하고 설정하는 방법",
        shortPurpose: "위키 새 주제 등록",
      };
    }
    return {
      fullTopic: "위키에서 페이지를 작성하고 관리하는 방법",
      shortPurpose: "위키 페이지 작성 및 관리",
    };
  }

  if (
    /연락처\s*등록|연락처등록|연락처\s*추가|addrmain|contact_add_lyr|tutorial-address|['"]주소록['"]\s*메뉴/i.test(fullJoined) &&
    !/전자우편|메일\s*쓰기|메일쓰기|사내쪽지|쪽지\s*쓰기|쪽지쓰기|emlmail|notnote|tutorial-mail|tutorial-note/i.test(fullJoined)
  ) {
    return {
      fullTopic: "주소록에서 새로운 연락처 정보를 입력하고 저장하는 방법",
      shortPurpose: "주소록 새 연락처 등록",
    };
  }

  if (/사내쪽지|쪽지\s*쓰기|쪽지쓰기|보낸\s*쪽지|notmain|notnotereg|notSubMenu|tutorial-note/i.test(fullJoined)) {
    return {
      fullTopic: "사내쪽지에서 수신 대상자를 선택해 쪽지를 작성하고 발송하는 방법",
      shortPurpose: "사내쪽지 작성 및 발송",
    };
  }

  if (/전자우편|웹메일|메일\s*쓰기|메일쓰기|보낸메일|받은메일|emlmain|emlmail|emllist|tutorial-mail/i.test(fullJoined)) {
    return {
      fullTopic: "전자우편에서 수신자와 본문을 작성해 새 메일을 발송하는 방법",
      shortPurpose: "전자우편 메일 작성 및 발송",
    };
  }

  if (
    /자원예약|예약\s*신청|예약신청|rmgres|resinsertdetailview|resselect_reslist|tutorial-resource/i.test(fullJoined) &&
    !/일정관리|일정\s*등록|scdinsert/i.test(uiJoined)
  ) {
    return {
      fullTopic: "자원예약관리에서 이용할 시설과 시간대를 지정해 예약 신청하는 방법",
      shortPurpose: "자원예약관리 시설 예약 신청",
    };
  }

  if (/일정관리|일정\s*등록|일정등록|캘린더|scdgetmainview|scdinsert|reg_shedule_lefttop|schedule|diary/i.test(fullJoined)) {
    const hasRoom = /회의실|자원|예약사용/i.test(uiJoined);
    const hasAttendee = /참석자|조직도|공유/i.test(uiJoined);
    return {
      fullTopic:
        hasRoom && hasAttendee
          ? "일정관리에서 참석자와 회의실 자원을 함께 지정하여 새 일정을 등록하는 방법"
          : "일정관리에서 일시와 세부 항목을 지정하여 새 일정을 등록하는 방법",
      shortPurpose: "일정관리 새 일정 등록",
    };
  }

  if (
    /전자결재|['"]결재['"]\s*메뉴|결재\s*작성|결재작성|기안\s*작성|기안작성|결재선|결재상신|기안상신|기록물철|eapmain|eapdoc|eapwork|gapmain|gapdoc|gapwork|approval|tutorial-draft/i.test(
      fullJoined
    )
  ) {
    return {
      fullTopic: "전자결재에서 기안 양식을 선택해 문서를 작성하고 결재선을 지정하여 상신하는 방법",
      shortPurpose: "전자결재 기안 작성 및 상신",
    };
  }

  if (/게시판|공지사항|글\s*등록|글\s*작성|글작성|brdboard|brdatcl|tutorial-board|test-board/i.test(fullJoined)) {
    return {
      fullTopic: "게시판에서 대상 게시판을 선택해 새 게시글을 작성하고 등록하는 방법",
      shortPurpose: "게시판 새 게시글 작성 및 등록",
    };
  }

  if (/문서관리|문서\s*등록|문서등록|문서함|docmain|docleft|docselect|atclwrite|atcledit|edms|tutorial-document/i.test(fullJoined)) {
    return {
      fullTopic: "문서관리에서 문서함과 분류를 선택해 새 문서를 등록하고 조회하는 방법",
      shortPurpose: "문서관리 새 문서 등록 및 조회",
    };
  }

  if (/스마트워크|업무\s*등록|업무등록|업무함|smartwork|smwwork|tutorial-smartwork/i.test(fullJoined)) {
    return {
      fullTopic: "스마트워크에서 업무함을 선택하고 담당자와 세부 내용을 입력해 새 업무를 등록하는 방법",
      shortPurpose: "스마트워크 새 업무 등록",
    };
  }

  if (/파일관리|파일함|새\s*폴더|새폴더|개인\s*폴더|fbxmain|filebox|tutorial-filebox/i.test(fullJoined)) {
    return {
      fullTopic: "파일관리에서 개인 폴더를 새로 생성하고 관리하는 방법",
      shortPurpose: "파일관리 새 폴더 생성 및 관리",
    };
  }

  if (/['"](프로젝트|스페이스)['"]\s*메뉴|프로젝트\s*추가|일감\s*등록|일감등록|prjmain|prjtask|prjdetail/i.test(fullJoined)) {
    const isProjectCreate = /프로젝트\s*추가|새\s*프로젝트\s*생성|프로젝트\s*생성/i.test(uiJoined);
    return {
      fullTopic: isProjectCreate
        ? "프로젝트 모듈에서 새 프로젝트를 생성하고 책임자와 세부 옵션을 설정하는 방법"
        : "프로젝트에서 새 일감을 작성하고 담당자를 지정해 등록하는 방법",
      shortPurpose: isProjectCreate ? "신규 프로젝트 생성 및 설정" : "프로젝트 새 일감 등록",
    };
  }

  // 동적 액션 기반 폴백
  let firstMenu = "";
  let mainButton = "";
  for (const m of momentsFile.moments || []) {
    const d = (m.description || "").trim();
    if (!firstMenu && /메뉴\/링크\s*클릭/.test(d)) {
      const match = d.match(/['"]([^'"]+)['"]/);
      if (match && match[1] && !/전체메뉴|포탈|확인|취소/.test(match[1])) {
        firstMenu = match[1].trim();
      }
    }
    if (!mainButton && /버튼\s*클릭/.test(d)) {
      const match = d.match(/['"]([^'"]+)['"]/);
      if (match && match[1] && !/확인|취소|닫기|목록|추가|선택|검색|전체메뉴/.test(match[1])) {
        mainButton = match[1].trim();
      }
    }
  }
  if (firstMenu && mainButton) {
    return {
      fullTopic: `${firstMenu} 메뉴에서 ${mainButton} 기능을 실행하고 처리하는 방법`,
      shortPurpose: `${firstMenu} ${mainButton} 처리`,
    };
  }

  return {
    fullTopic: "그룹웨어 주요 메뉴로 이동하여 업무를 처리하는 방법",
    shortPurpose: "그룹웨어 주요 업무 처리",
  };
}

function applyStyleEnding(basePhrase: string, style: NarrationStyle): string {
  const clean = basePhrase
    .replace(/합니다\.?$/, "")
    .replace(/엽니다\.?$/, "열기")
    .replace(/펼칩니다\.?$/, "펼치기")
    .trim();

  if (style === "friendly") {
    if (clean.endsWith("열기")) return `${clean.replace(/열기$/, "열어 줄게요")}.`;
    if (clean.endsWith("이동")) return `${clean.replace(/이동$/, "이동해 볼게요")}.`;
    if (clean.endsWith("클릭")) return `${clean.replace(/클릭$/, "클릭해 주세요")}.`;
    if (clean.endsWith("선택")) return `${clean.replace(/선택$/, "선택해 줍니다")}.`;
    if (clean.endsWith("지정")) return `${clean.replace(/지정$/, "지정해 주세요")}.`;
    if (clean.endsWith("설정")) return `${clean.replace(/설정$/, "설정해 줄게요")}.`;
    if (clean.endsWith("입력") || clean.endsWith("작성")) return `${clean}해 주세요.`;
    if (clean.endsWith("업로드")) return `${clean.replace(/업로드$/, "업로드해 주세요")}.`;
    if (clean.endsWith("반영") || clean.endsWith("적용")) return `${clean}해 줄게요.`;
    if (clean.endsWith("완료") || clean.endsWith("확인")) return `${clean}해 볼게요.`;
    return `${clean}해 볼게요.`;
  }

  if (style === "presentation") {
    if (clean.endsWith("열기")) return `${clean.replace(/열기$/, "열어 보겠습니다")}.`;
    if (clean.endsWith("이동")) return `${clean}하겠습니다.`;
    if (clean.endsWith("완료")) return `${clean.replace(/완료$/, "절차를 마무리합니다")}.`;
    return `${clean}하겠습니다.`;
  }

  const normalized = clean.replace(/열기$/, "엽니다").replace(/펼치기$/, "펼칩니다");
  if (/(엽니다|펼칩니다)$/.test(normalized)) return `${normalized}.`;
  return `${normalized}합니다.`;
}

function composeFallbackFromMetas(
  metas: StructuralMomentMeta[],
  style: NarrationStyle,
  isFirstCue: boolean
): string {
  if (metas.length === 0) {
    return style === "friendly" ? "다음 단계를 진행해 볼게요." : "다음 단계를 진행합니다.";
  }

  const roles = metas.map((m) => m.role);
  const modalName = metas.find((m) => m.modalName)?.modalName?.replace(/\s*팝업$/, "");

  // 1) 전체메뉴 + 메뉴 이동 통합
  if (roles.every((r) => r === "nav_entry")) {
    const names = metas.map((m) => m.targetLabel).filter(Boolean);
    if (names.length >= 2 && names[0] === "전체메뉴") {
      const dest = names[names.length - 1];
      return applyStyleEnding(`상단 '전체메뉴'를 열어 '${dest}' 메뉴로 이동`, style);
    }
    if (names.length >= 1) {
      return applyStyleEnding(`'${names[names.length - 1]}' 메뉴로 이동`, style);
    }
  }

  // 2) 팝업 열기/선택/확인 완결 단계
  if (roles.includes("popup_confirm") && (roles.includes("popup_open") || roles.includes("popup_select"))) {
    const openMeta = metas.find((m) => m.role === "popup_open" || m.role === "create_start");
    const confirmLabel = metas.find((m) => m.role === "popup_confirm")?.targetLabel || "확인";
    const subject = openMeta?.fieldLabel || modalName || openMeta?.targetLabel || "대상";
    if (openMeta) {
      return applyStyleEnding(
        `'${openMeta.targetLabel || "선택"}' 버튼을 눌러 ${subject} 항목을 지정한 뒤 '${confirmLabel}'을 눌러 반영`,
        style
      );
    }
    return applyStyleEnding(`${subject} 창에서 대상 항목을 선택한 뒤 '${confirmLabel}'을 눌러 반영`, style);
  }

  // 3) 최종 저장/상신/삭제 + 알림 확인
  if (roles.includes("submit_save")) {
    const saveBtn = metas.find((m) => m.role === "submit_save")?.targetLabel || "저장";
    if (roles.includes("popup_confirm")) {
      return applyStyleEnding(`작성한 내용을 확인한 뒤 '${saveBtn}' 버튼을 누르고 확인 창을 승인하여 완료`, style);
    }
    return applyStyleEnding(`입력을 마친 뒤 '${saveBtn}' 버튼을 눌러 처리를 완료`, style);
  }

  // 4) 일반 단일/복합 폴백
  const uniquePhrases: string[] = [];
  for (const m of metas) {
    if (!uniquePhrases.includes(m.fallbackPhrase)) {
      uniquePhrases.push(m.fallbackPhrase);
    }
  }
  const prefix = isFirstCue ? "먼저 " : "";
  if (uniquePhrases.length === 1) {
    return `${prefix}${applyStyleEnding(uniquePhrases[0], style)}`;
  }
  const first = uniquePhrases[0]
    .replace(/열기$/, "열고")
    .replace(/이동$/, "이동한 뒤")
    .replace(/클릭$/, "클릭하고")
    .replace(/선택$/, "선택한 뒤")
    .replace(/지정$/, "지정한 뒤")
    .replace(/설정$/, "설정한 뒤")
    .replace(/작성$/, "작성하고")
    .replace(/업로드$/, "업로드하고");
  return `${prefix}${first}, ${applyStyleEnding(uniquePhrases[uniquePhrases.length - 1], style)}`;
}

export function buildNarrationWindows(
  momentsFile: MomentsFile,
  browsePlan?: BrowsePlan | null,
  slug: string = "",
  style: NarrationStyle = "manual"
): NarrationWindow[] {
  const totalMs = momentsFile.metadata?.totalDurationMs || 30000;
  const topic = deriveScenarioTopicSummary(slug, momentsFile, browsePlan);

  let meaningful = (momentsFile.moments || []).filter(
    (m) =>
      m.type === "click" ||
      m.type === "dblclick" ||
      m.type === "type" ||
      m.type === "drag" ||
      m.type === "dragAndDrop" ||
      m.type === "upload"
  );

  // 비-메신저 시나리오 시작부에서 '전체메뉴' 진입 직전에 실수로 클릭된 '메신저' 아이콘 클릭은 노이즈이므로 제외
  const firstAllMenuIdx = meaningful.findIndex((m) => /전체메뉴/.test(m.description || ""));
  if (firstAllMenuIdx > 0 && !/메신저/.test(topic.fullTopic)) {
    const beforeAllMenu = meaningful.slice(0, firstAllMenuIdx);
    if (beforeAllMenu.every((m) => /['"]메신저['"]/.test(m.description || ""))) {
      meaningful = meaningful.slice(firstAllMenuIdx);
    }
  }

  // 각 액션 시점 이전에 타이핑된 값만 기록 (초반 메뉴명이 후반 타이핑 값과 겹쳐 오판되는 현상 방지)
  const contextMap = new Map<Moment, { prevMoment?: Moment; nextMoment?: Moment; typedBefore?: string[] }>();
  for (let i = 0; i < meaningful.length; i++) {
    const typedBefore = meaningful
      .slice(0, i)
      .map((m) => (m.keys || "").trim())
      .filter((v) => v.length >= 2);
    contextMap.set(meaningful[i], {
      prevMoment: i > 0 ? meaningful[i - 1] : undefined,
      nextMoment: i + 1 < meaningful.length ? meaningful[i + 1] : undefined,
      typedBefore: Array.from(new Set(typedBefore)),
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
        stageRole: "intro",
        rawActions: [],
        sampleValuesToGeneralize: [],
        actionsSummary: [`[오프닝 매뉴얼 소개] ${topic.fullTopic}`],
        fallbackLine: `이번 영상에서는 ${topic.fullTopic}을 단계별로 안내해 드립니다.`,
      },
    ];
  }

  // 워크플로우 구조(Structural Stage) 기반 그룹핑
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
    const nextM = idx + 1 < meaningful.length ? meaningful[idx + 1] : undefined;
    const sinceGroupStart = m.timestamp - groupStart;
    const sincePrev = m.timestamp - prevM.timestamp;

    const firstMeta = analyzeMomentStructure(currentGroup[0], contextMap.get(currentGroup[0]));
    const prevMeta = analyzeMomentStructure(prevM, contextMap.get(prevM));
    const currMeta = analyzeMomentStructure(m, contextMap.get(m));
    const nextMeta = nextM ? analyzeMomentStructure(nextM, contextMap.get(nextM)) : undefined;

    // 1. 입력란 클릭 직후 해당 입력란에 타이핑하는 경우 하나로 결합
    const isInputClickToType =
      prevM.type === "click" &&
      m.type === "type" &&
      sincePrev <= 3500 &&
      (prevMeta.role === "general_action" || prevMeta.role === "form_input");

    // 2. 팝업/모달 생명주기 결합 (팝업 열기 -> 팝업 내부 항목 선택 -> 팝업 확인 닫기)
    const sameModalOrConfirm =
      firstMeta.role === "popup_open" ||
      !firstMeta.modalName ||
      !currMeta.modalName ||
      firstMeta.modalName === currMeta.modalName ||
      currMeta.role === "popup_confirm";

    const isPopupFlowContinuation =
      ((firstMeta.role === "popup_open" || firstMeta.role === "popup_select" || prevMeta.role === "popup_select") &&
        (currMeta.role === "popup_select" || currMeta.role === "popup_confirm") &&
        sameModalOrConfirm &&
        sinceGroupStart < 11000 &&
        sincePrev < 4500) ||
      (prevMeta.role === "date_open" && currMeta.role === "date_pick" && sincePrev < 4500) ||
      (prevMeta.role === "date_pick" && (currMeta.role === "date_open" || currMeta.role === "date_pick") && sinceGroupStart < 8500 && sincePrev < 4000);

    // 3. 저장/상신/삭제 직후 확인창/알림창 승인 결합
    const isSubmitToConfirm =
      (prevMeta.role === "submit_save" ||
        (firstMeta.role === "submit_save" && prevMeta.role === "popup_confirm")) &&
      currMeta.role === "popup_confirm" &&
      sincePrev < 5000;

    // 4. 메뉴 연속 이동 체인 ('전체메뉴' -> '모듈' -> '하위 메뉴')
    const isNavChain =
      firstMeta.role === "nav_entry" &&
      currMeta.role === "nav_entry" &&
      sinceGroupStart < 8500 &&
      sincePrev < 4200;

    // 5. 등록 완료 후 좌측 메뉴 클릭 + 등록된 항목 클릭 (결과 확인)
    const isVerifyNavToItem =
      currentGroup.length === 1 &&
      prevMeta.role === "nav_entry" &&
      currMeta.role === "verify_view" &&
      sincePrev < 4000;

    // 6. 동일 모달 내 연속 입력 또는 연속 옵션 체크
    const isSameModalInputOrOption =
      ((currMeta.role === "form_input" && prevMeta.role === "form_input") ||
        (currMeta.role === "option_toggle" && prevMeta.role === "option_toggle")) &&
      currMeta.modalName === prevMeta.modalName &&
      sinceGroupStart < 8500 &&
      sincePrev < 4200 &&
      currentGroup.length < 4;

    // 7. 로그인 아이디 + 비밀번호 + Login 버튼 연속 동작
    const isLoginFlow =
      /아이디|비밀번호/.test(prevMeta.fieldLabel || "") &&
      (/비밀번호/.test(currMeta.fieldLabel || "") || /login|로그인/i.test(currMeta.targetLabel || "")) &&
      !currMeta.modalName &&
      sinceGroupStart < 8500 &&
      sincePrev < 5000;

    // 경계 분리 보호: 새로운 팝업 열기, 작성 시작, 저장 버튼 클릭 등은 이전 일반 입력과 섞이지 않도록 분리
    const isStartingNewStage =
      currMeta.role === "popup_open" ||
      currMeta.role === "date_open" ||
      currMeta.role === "create_start" ||
      currMeta.role === "submit_save" ||
      currMeta.role === "file_upload" ||
      (currMeta.role === "popup_select" && prevMeta.role !== "popup_open" && prevMeta.role !== "popup_select");

    const isLeavingCompletedStage =
      prevMeta.role === "popup_confirm" ||
      prevMeta.role === "date_pick" ||
      prevMeta.role === "file_upload" ||
      (prevMeta.role === "nav_entry" && currMeta.role !== "nav_entry" && !isVerifyNavToItem) ||
      (prevMeta.role === "create_start" && currMeta.role === "popup_select" && nextMeta?.role === "popup_select");

    if (
      isInputClickToType ||
      isPopupFlowContinuation ||
      isSubmitToConfirm ||
      isNavChain ||
      isVerifyNavToItem ||
      isSameModalInputOrOption ||
      isLoginFlow
    ) {
      currentGroup.push(m);
    } else if (
      !isStartingNewStage &&
      !isLeavingCompletedStage &&
      prevMeta.role === currMeta.role &&
      sinceGroupStart < 3800 &&
      sincePrev < 2400 &&
      currentGroup.length < 3
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

  // 사후 클린업: 단독으로 남은 '확인' 버튼 클릭(popup_confirm)은 직전 그룹에 병합하여
  // "확인 버튼을 클릭합니다" 같은 단독 낭독 구간 생성 방지
  for (let i = groups.length - 1; i >= 1; i--) {
    const grp = groups[i];
    if (grp.length === 1) {
      const meta = analyzeMomentStructure(grp[0], contextMap.get(grp[0]));
      const prevGrp = groups[i - 1];
      const prevLast = prevGrp[prevGrp.length - 1];
      if (meta.role === "popup_confirm" && grp[0].timestamp - prevLast.timestamp < 5500) {
        prevGrp.push(grp[0]);
        groups.splice(i, 1);
      }
    }
  }

  const windows: NarrationWindow[] = [];
  const firstClickMs = groups[0][0].timestamp;

  const buildWindowPayload = (
    grp: Moment[],
    index: number,
    startMs: number,
    endMs: number,
    maxChars: number,
    isIntro: boolean,
    combineIntroTopic?: { fullTopic: string; shortPurpose: string }
  ): NarrationWindow => {
    const metas = grp.map((m) => analyzeMomentStructure(m, contextMap.get(m)));
    const rawActions = grp.map((m) => (m.description || "").trim()).filter(Boolean);
    const sampleValues = Array.from(
      new Set(metas.map((m) => m.sampleValue).filter((v): v is string => Boolean(v && v.length > 0)))
    );
    const aiFacts = Array.from(new Set(metas.map((m) => m.aiFact).filter(Boolean)));
    const dominantRole = metas[metas.length - 1]?.role || "general_action";

    if (combineIntroTopic) {
      const firstActionFallback = composeFallbackFromMetas(metas, style, false);
      return {
        index,
        startMs,
        endMs,
        maxChars,
        isIntro: true,
        stageRole: `intro + ${dominantRole}`,
        rawActions,
        sampleValuesToGeneralize: sampleValues,
        actionsSummary: [
          `[오프닝 매뉴얼 소개 필수] 매뉴얼 주제: ${combineIntroTopic.shortPurpose} (${combineIntroTopic.fullTopic})`,
          ...aiFacts,
        ],
        fallbackLine: `이번 영상에서는 ${combineIntroTopic.shortPurpose} 방법을 알아보며, 먼저 ${firstActionFallback}`,
      };
    }

    return {
      index,
      startMs,
      endMs,
      maxChars,
      isIntro,
      stageRole: dominantRole,
      rawActions,
      sampleValuesToGeneralize: sampleValues,
      actionsSummary: aiFacts,
      fallbackLine: composeFallbackFromMetas(metas, style, index === 2),
    };
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
      stageRole: "intro",
      rawActions: [],
      sampleValuesToGeneralize: [],
      actionsSummary: [`[오프닝 매뉴얼 소개 필수] 매뉴얼 주제: ${topic.shortPurpose} (${topic.fullTopic})`],
      fallbackLine:
        style === "friendly"
          ? `안녕하세요! 이번 영상에서는 ${topic.fullTopic}을 차근차근 알아볼게요.`
          : style === "presentation"
          ? `지금부터 ${topic.fullTopic}을 단계별로 시연하겠습니다.`
          : style === "compact"
          ? `${topic.shortPurpose} 매뉴얼을 시작합니다.`
          : `이번 영상에서는 ${topic.fullTopic}을 단계별로 안내해 드립니다.`,
    });

    for (let i = 0; i < groups.length; i++) {
      const grp = groups[i];
      const nextGrp = groups[i + 1];
      const rawStart = Math.max(introEndMs + 150, grp[0].timestamp - 200);
      const nextStart = nextGrp ? Math.max(rawStart + 2200, nextGrp[0].timestamp - 250) : totalMs - 200;
      const windowDurationMs = Math.max(2200, Math.min(8200, nextStart - rawStart));
      const endMs = Math.min(totalMs - 100, rawStart + windowDurationMs);
      const maxChars = Math.max(34, Math.min(64, Math.floor((windowDurationMs / 1000) * 7.2)));

      windows.push(buildWindowPayload(grp, windows.length + 1, rawStart, endMs, maxChars, false));
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

      windows.push(
        buildWindowPayload(
          grp,
          windows.length + 1,
          rawStart,
          endMs,
          maxChars,
          i === 0,
          i === 0 ? topic : undefined
        )
      );
    }
  }

  return windows;
}

function getStylePromptInstruction(style: NarrationStyle): string {
  switch (style) {
    case "friendly":
      return `- 말투 스타일: [친절한 튜토리얼 강사형 (해요체)]
- 첫 번째 구간(index: 1)은 "안녕하세요! 이번 영상에서는 ~하는 방법을 차근차근 알아볼게요."처럼 친근한 매뉴얼 소개로 시작하세요.
- 이후 구간은 단순 버튼 읽기가 아니라 각 단계의 역할과 화면 흐름을 짚어주며 "~창을 열어 줄게요", "~지정해 줍니다", "~작성해 주세요", "~정상 반영되었는지 확인해 볼게요"처럼 자연스러운 강사 화법(해요체)을 사용하세요.`;
    case "presentation":
      return `- 말투 스타일: [전문 솔루션 시연 발표형 (하십시오체/발표체)]
- 첫 번째 구간(index: 1)은 "지금부터 ~하는 전체 과정을 단계별로 시연하겠습니다."처럼 신뢰감 있는 발표 오프닝으로 시작하세요.
- 이후 구간은 각 단계의 업무적 목적과 결과를 함께 짚어주며 "~화면으로 이동하겠습니다", "~설정해 주겠습니다", "~절차를 마무리합니다"처럼 전문적인 프레젠테이션 화법을 사용하세요.`;
    case "compact":
      return `- 말투 스타일: [핵심 기능 해설 브리핑형 (간결한 합니다체)]
- 첫 번째 구간(index: 1)은 "~매뉴얼을 시작합니다."를 포함하여 핵심 목적을 명쾌하게 소개하세요.
- 불필요한 수식어는 줄이되 단순 버튼 읽기가 아니라 "업무함 지정 후 작성 화면으로 이동합니다"처럼 목적과 결과를 간결하게 전달하세요.`;
    case "manual":
    default:
      return `- 말투 스타일: [정석 매뉴얼 해설형 (표준 합니다체)]
- 첫 번째 구간(index: 1)은 이 영상이 어떤 업무 매뉴얼인지("이번 영상에서는 ~하는 방법을 단계별로 안내해 드립니다" 등) 소개하는 오프닝 내용을 포함하세요.
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

  const topic = deriveScenarioTopicSummary(slug, momentsFile, browsePlan);
  const windows = buildNarrationWindows(momentsFile, browsePlan, slug, style);

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
시나리오 전체 주제: "${topic.fullTopic}"

아래는 화면 녹화 영상의 워크플로우 단계별(Stage) 구간 목록입니다.
어떠한 시나리오가 들어오더라도 하드코딩된 문구 느낌이 나지 않도록, 전체 업무 흐름과 각 구간의 실제 화면 조작(\`rawActions\`, \`structuredFacts\`)을 읽고 시청자가 이해하기 쉬운 자연스러운 **매뉴얼 해설 내레이션 대본**을 구간마다 1문장씩 작성하세요.

[말투 및 오프닝 작성 규칙]
${styleInstruction}

[범용 매뉴얼 해설 작성 5대 핵심 규칙]
1. **단순 '버튼 낭독기' 금지 — 단계의 목적과 화면 흐름(Why & Effect)으로 설명하세요**:
   - 나쁜 예: "'업무 등록' 버튼을 클릭합니다." / "'선택' 버튼을 클릭합니다." / "'확인' 버튼을 클릭합니다."
   - 좋은 예: "좌측의 '업무 등록' 버튼을 눌러 새 업무를 생성할 업무함 선택 창을 엽니다." / "담당자 '선택' 창을 열어 대상 사원을 지정하고 '확인'을 눌러 반영합니다."
   - 한 구간에 [팝업 열기 + 항목 선택 + '확인' 클릭]이나 [저장 + 알림창 '확인' 클릭]이 함께 묶여 있으면, 각 클릭을 쪼개서 나열하지 말고 하나의 완결된 동작으로 매끄럽게 설명하세요.
2. **선택형 옵션(공개 여부, 부가 기능, 권한 체크박스 등)은 클릭한 특정 옵션만 콕 집어 읽지 마세요**:
   - 시연자가 화면에서 \`'비공개'\`, \`'댓글 사용'\`, \`'할일'\`, \`'그룹웨어'\` 같은 라디오 버튼이나 체크박스 옵션을 클릭했더라도, 실제 매뉴얼 시청자는 상황에 따라 다른 옵션을 선택할 수 있습니다.
   - 따라서 "'비공개' 옵션을 체크합니다"처럼 시연자가 누른 특정 옵션만 딱 집어 읽지 말고, **"업무 성격에 맞게 공개 여부 등 세부 옵션을 설정합니다"**, **"필요한 부가 기능이나 서비스 권한 항목을 선택합니다"**처럼 시청자가 필요한 옵션을 선택할 수 있음을 안내하세요.
3. **고정 진입/실행 버튼명은 정확히 안내하되, 시연용 예시 데이터(\`sampleValuesToGeneralize\`)는 절대 그대로 읽지 마세요**:
   - 반드시 눌러야 하는 고정 메뉴/버튼('전체메뉴', '스마트워크', '업무 등록', '전자결재', '일정관리', '위키', '조직도', '선택', '추가', '확인', '저장', '파일 선택' 등)은 시청자가 따라 눌러야 하므로 명칭을 정확히 언급하세요.
   - 반면 시연자가 예시로 입력하거나 선택한 날짜/시간 숫자('16일', '26', '14:00'), 예시 부서/사원/회의실/분류명('공공기업팀', '김민준', '3층 회의실'), 선택형 옵션값('비공개', '할일', '그룹웨어'), 예시 입력 문자열, 예시 첨부파일명('test.txt') 등은 절대 대본에 노출하지 말고 해당 항목의 일반 역할(마감 기한, 담당 사원, 세부 옵션, 제목, 본문 내용, 첨부 파일 등)로 표현하세요.
4. **"원하는 ~" 반복 금지 및 앞뒤 문맥 연결**:
   - 매 문장마다 기계적으로 "원하는 ~"을 반복하지 말고, 앞뒤 구간이 하나의 매뉴얼 강의처럼 자연스럽게 이어지도록 어휘와 연결어를 다양하게 구사하세요.
5. **글자 수 및 JSON 출력 형식 준수**:
   - 각 구간의 글자 수(공백 포함)는 지정된 \`maxChars\` 이내로 작성하세요.
   - 반드시 JSON 배열 형식으로만 응답하세요: [{"index": 1, "text": "..."}, ...]

[시나리오 구간 데이터]
${JSON.stringify(
  windows.map((w) => ({
    index: w.index,
    isIntro: Boolean(w.isIntro),
    timeRangeSec: `${(w.startMs / 1000).toFixed(1)}s ~ ${(w.endMs / 1000).toFixed(1)}s`,
    maxChars: w.maxChars,
    stageRole: w.stageRole,
    rawActions: w.rawActions,
    structuredFacts: w.actionsSummary,
    sampleValuesToGeneralize: w.sampleValuesToGeneralize,
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
              temperature: 0.35,
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

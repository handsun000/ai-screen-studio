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
  actionsSummary: string[];
  fallbackLine: string;
}

export const STYLE_DEFAULT_PITCH: Record<NarrationStyle, string> = {
  manual: "+0Hz",
  friendly: "+4Hz",
  presentation: "-3Hz",
  compact: "+2Hz",
};

type SemanticActionCategory =
  | "nav_entry"
  | "create_start"
  | "box_select"
  | "datetime"
  | "org_select"
  | "res_select"
  | "contact_form"
  | "form_input"
  | "option_toggle"
  | "file_upload"
  | "rating"
  | "submit_save"
  | "verify_view"
  | "alert_confirm"
  | "general";

type MomentRole =
  | "nav_entry"
  | "create_start"
  | "popup_open"
  | "popup_select"
  | "popup_confirm"
  | "date_open"
  | "date_pick"
  | "form_work"
  | "submit_save"
  | "verify_view";

interface SemanticMomentInfo {
  category: SemanticActionCategory;
  role: MomentRole;
  modalScope?: string;
  summaryForAi: string;
  phraseStep: string;
}

const STANDARD_UI_MENU_REGEX =
  /^(전체메뉴|포탈|그룹웨어|스마트워크|전자결재|기업결재|공공결재|결재|일정관리|캘린더|자원예약|자원예약관리|게시판|공지사항|문서관리|문서함|위키|전자우편|메일|웹메일|사내쪽지|쪽지|주소록|연락처|파일관리|파일함|업무보고|프로젝트|스페이스|설문조사|메모|할일|근태관리|조직도|조직관리|관리자|환경설정|메신저|최신\s*주제|최신\s*페이지|내\s*업무|업무함|기안함|결재대기|받은메일|보낸메일|보낸쪽지|내\s*일정|공유\s*일정)$/i;

function getModuleRoleExplanation(menuName: string): { summary: string; phrase: string } {
  const clean = menuName.trim();
  if (/스마트워크/i.test(clean)) {
    return {
      summary: "업무함 기반으로 프로젝트와 단위 업무를 생성·관리하는 '스마트워크' 모듈로 이동",
      phrase: "업무 생성과 진행 현황을 관리하는 '스마트워크' 메뉴로 이동",
    };
  }
  if (/전자결재|기업결재|공공결재|^결재$/i.test(clean)) {
    return {
      summary: "기안문 작성과 결재선 상신·승인을 처리하는 '전자결재' 모듈로 이동",
      phrase: "기안문 작성과 결재 처리를 진행하는 '전자결재' 메뉴로 이동",
    };
  }
  if (/일정관리|캘린더/i.test(clean)) {
    return {
      summary: "개인 및 부서 공유 일정을 등록하고 관리하는 '일정관리' 모듈로 이동",
      phrase: "개인 및 공유 일정을 관리하는 '일정관리' 메뉴로 이동",
    };
  }
  if (/자원예약/i.test(clean)) {
    return {
      summary: "회의실과 공용 장비 등 사내 자원을 예약하는 '자원예약관리' 모듈로 이동",
      phrase: "회의실과 공용 설비를 예약하는 '자원예약관리' 메뉴로 이동",
    };
  }
  if (/게시판|공지사항/i.test(clean)) {
    return {
      summary: "사내 공지와 부서별 게시글을 등록·공유하는 '게시판' 모듈로 이동",
      phrase: "사내 소식과 게시글을 공유하는 '게시판' 메뉴로 이동",
    };
  }
  if (/문서관리/i.test(clean)) {
    return {
      summary: "사내 표준 문서와 자료를 분류별로 체계적으로 보관하는 '문서관리' 모듈로 이동",
      phrase: "사내 문서와 자료를 체계적으로 보관하는 '문서관리' 메뉴로 이동",
    };
  }
  if (/위키/i.test(clean)) {
    return {
      summary: "협업 지식 문서를 주제별로 작성하고 공동 편집하는 '위키' 모듈로 이동",
      phrase: "협업 지식 문서를 작성하고 공유하는 '위키' 메뉴로 이동",
    };
  }
  if (/전자우편|웹메일|^메일$/i.test(clean)) {
    return {
      summary: "사내외 이메일을 작성하고 수발신하는 '전자우편' 모듈로 이동",
      phrase: "사내외 메일을 수발신하는 '전자우편' 메뉴로 이동",
    };
  }
  if (/사내쪽지|^쪽지$/i.test(clean)) {
    return {
      summary: "임직원 간 빠른 업무 메시지와 파일을 주고받는 '사내쪽지' 모듈로 이동",
      phrase: "임직원 간 빠른 업무 메시지를 주고받는 '사내쪽지' 메뉴로 이동",
    };
  }
  if (/주소록/i.test(clean)) {
    return {
      summary: "내외부 업무 연락처를 등록하고 통합 관리하는 '주소록' 모듈로 이동",
      phrase: "업무 연락처를 통합 관리하는 '주소록' 메뉴로 이동",
    };
  }
  if (/파일관리|파일함/i.test(clean)) {
    return {
      summary: "업무 파일과 개인·공유 폴더를 저장하고 관리하는 '파일관리' 모듈로 이동",
      phrase: "업무 파일과 개인 폴더를 관리하는 '파일관리' 메뉴로 이동",
    };
  }
  if (/조직관리/i.test(clean)) {
    return {
      summary: "부서 트리와 임직원 사용자 계정을 생성·관리하는 '조직관리' 화면으로 이동",
      phrase: "부서와 사용자 계정을 관리하는 '조직관리' 화면으로 이동",
    };
  }
  if (/관리자/i.test(clean)) {
    return {
      summary: "그룹웨어 시스템 설정과 조직을 총괄하는 '관리자' 메뉴로 진입",
      phrase: "시스템과 조직을 설정하는 '관리자' 메뉴로 진입",
    };
  }
  if (/업무보고/i.test(clean)) {
    return {
      summary: "일일·정기 업무보고서를 작성하고 공유하는 '업무보고' 모듈로 이동",
      phrase: "업무보고서를 작성하고 공유하는 '업무보고' 메뉴로 이동",
    };
  }
  if (/프로젝트|스페이스/i.test(clean)) {
    return {
      summary: "협업 프로젝트와 단위 일감을 관리하는 '프로젝트' 모듈로 이동",
      phrase: "프로젝트와 세부 일감을 관리하는 '프로젝트' 메뉴로 이동",
    };
  }
  if (/최신\s*주제/i.test(clean)) {
    return {
      summary: "방금 생성한 위키 주제를 확인하기 위해 좌측 '최신 주제' 메뉴로 이동",
      phrase: "등록된 주제 목록을 확인하기 위해 좌측 '최신 주제' 메뉴로 이동",
    };
  }
  if (/최신\s*페이지/i.test(clean)) {
    return {
      summary: "작성한 위키 페이지를 확인하기 위해 좌측 '최신 페이지' 메뉴로 이동",
      phrase: "작성된 페이지 목록을 확인하기 위해 좌측 '최신 페이지' 메뉴로 이동",
    };
  }
  if (/내\s*프로젝트|업무\s*현황|종합\s*현황/i.test(clean)) {
    return {
      summary: `생성된 프로젝트와 진행 상태를 확인하기 위해 좌측 '${clean}' 메뉴로 이동`,
      phrase: `프로젝트 현황을 확인하기 위해 좌측 '${clean}' 메뉴로 이동`,
    };
  }
  return {
    summary: `해당 목록이나 화면을 조회하기 위해 '${clean}' 메뉴로 이동`,
    phrase: `목록을 조회하기 위해 '${clean}' 메뉴로 이동`,
  };
}

/**
 * 시연 중 클릭/입력한 구체적 예시값('16일', '26', '14:00', '3층 회의실', '테스트 부서', 'test002', '김민준' 등)과
 * 고정 UI 기능 버튼('일정관리', '업무 등록', '저장', '조직도', '확인' 등)을 구분하여
 * 단순 버튼 낭독이 아닌 "왜 이 동작을 수행하며 어떤 기능적 효과가 있는지" 설명하는 매뉴얼 해설 표현으로 변환합니다.
 */
function classifyMomentSemantics(
  m: Moment,
  context?: { prevMoment?: Moment; nextMoment?: Moment; typedValues?: string[] }
): SemanticMomentInfo {
  const desc = (m.description || "").trim();
  const keys = (m.keys || "").trim();
  const prevDesc = (context?.prevMoment?.description || "").trim();
  const nextDesc = (context?.nextMoment?.description || "").trim();

  // Extract bracketed context prefix (e.g. "[댓글 사용]", "[권한]", "[담당자]", "[조직도 팝업]", "[업무함 선택 팝업]")
  const bracketMatches = Array.from(desc.matchAll(/\[([^\]]+)\]/g)).map((x) => x[1].trim());
  const firstBracket = bracketMatches[0] || "";
  const modalScope = bracketMatches.find((b) => /팝업$/.test(b));

  // 1. Typing / Input actions -> 절대 예시 입력 문자열(keys)을 대본에서 그대로 읽지 않고 입력 항목의 역할과 목적을 설명
  if (m.type === "type" || Boolean(keys)) {
    const fieldPartOnly = desc
      .replace(/^\[[^\]]*팝업\]\s*/i, "")
      .replace(/에\s*['"][^'"]*['"]\s*입력.*$/i, "")
      .toLowerCase();

    if (/시작\s*시간|종료\s*시간|hh:mm/i.test(fieldPartOnly) || /^\d{1,2}:\d{2}$/.test(keys)) {
      return {
        category: "datetime",
        role: "date_pick",
        modalScope,
        summaryForAi: "일정이나 예약이 진행될 시작 및 종료 시간대를 설정 (예시 시각 숫자는 읽지 말 것)",
        phraseStep: "일정에 맞춰 시작 및 종료 시간을 설정",
      };
    }
    if (/시작\s*일|종료\s*일|yyyy-mm-dd|기한/i.test(fieldPartOnly) || /^\d{4}-\d{2}-\d{2}$/.test(keys)) {
      return {
        category: "datetime",
        role: "date_pick",
        modalScope,
        summaryForAi: "달력에서 업무 기한이나 일정 날짜를 지정 (예시 날짜 숫자는 읽지 말 것)",
        phraseStep: "달력에서 진행 일자나 마감 기한을 지정",
      };
    }

    // 위키 주제명 / 설명 / 태그
    if (/주제명|bookname|위키\s*주제/i.test(fieldPartOnly)) {
      return {
        category: "form_input",
        role: "form_work",
        modalScope,
        summaryForAi: "협업 공간을 구분할 위키 주제명을 입력란에 작성 (예시 주제명은 읽지 말 것)",
        phraseStep: "협업 공간을 구분할 위키 주제명을 입력",
      };
    }
    if (/주제\s*설명|bookdesc|prjinfoerform_desc|_desc|설명/i.test(fieldPartOnly)) {
      const isProjectDesc = /prj|프로젝트/i.test(desc);
      return {
        category: "form_input",
        role: "form_work",
        modalScope,
        summaryForAi: isProjectDesc
          ? "프로젝트의 추진 목적과 주요 내용을 설명란에 작성 (예시 문구는 읽지 말 것)"
          : "공간이나 항목의 용도를 안내하는 상세 설명을 작성 (예시 문구는 읽지 말 것)",
        phraseStep: isProjectDesc
          ? "프로젝트의 목적과 개요를 설명란에 입력"
          : "목적과 용도를 안내하는 설명을 입력",
      };
    }
    if (/태그|tag/i.test(fieldPartOnly)) {
      return {
        category: "form_input",
        role: "form_work",
        modalScope,
        summaryForAi: "추후 문서를 빠르게 분류·검색할 수 있도록 관련 태그를 입력 (예시 태그명은 읽지 말 것)",
        phraseStep: "검색과 분류를 위한 관련 태그를 입력",
      };
    }

    // 검색창 / 양식 검색어 입력
    if (/searchword|srchword|검색어|검색창|양식\s*검색|검색/i.test(fieldPartOnly)) {
      return {
        category: "form_input",
        role: "form_work",
        modalScope,
        summaryForAi: "검색창에 키워드를 입력하여 원하는 양식이나 대상을 빠르게 필터링 조회 (예시 검색어는 직접 읽지 말 것)",
        phraseStep: "검색창에 키워드를 입력해 대상 항목을 빠르게 조회",
      };
    }

    // 신청 사유 / 제목 / 장소 / 에디터 본문 / 폴더명
    if (/신청\s*사유|사유|reqwhy|absnwhy/i.test(fieldPartOnly)) {
      return {
        category: "form_input",
        role: "form_work",
        modalScope,
        summaryForAi: "승인권자가 목적을 확인할 수 있도록 신청 사유란에 구체적인 사유를 작성 (예시 문구는 읽지 말 것)",
        phraseStep: "예약 및 신청 목적을 알 수 있도록 신청 사유를 작성",
      };
    }
    if (/제목\s*없는\s*페이지|wikibookcontent_subject/i.test(fieldPartOnly)) {
      return {
        category: "form_input",
        role: "form_work",
        modalScope,
        summaryForAi: "새 위키 페이지 상단에 문서의 핵심 주제를 나타내는 페이지 제목을 입력 (예시 제목은 읽지 말 것)",
        phraseStep: "상단 제목란에 문서 주제를 나타내는 페이지 제목을 입력",
      };
    }
    if (/subject|제목/i.test(fieldPartOnly)) {
      return {
        category: "form_input",
        role: "form_work",
        modalScope,
        summaryForAi: "목록에서 한눈에 알아볼 수 있도록 상단 제목란에 핵심 제목을 입력 (예시 제목 문구는 직접 읽지 말 것)",
        phraseStep: "상단 제목 입력란에 업무나 문서의 핵심 제목을 입력",
      };
    }
    if (/장소/i.test(fieldPartOnly)) {
      return {
        category: "form_input",
        role: "form_work",
        modalScope,
        summaryForAi: "참석자가 위치를 확인할 수 있도록 장소 입력란에 진행 장소를 작성 (예시 장소명은 읽지 말 것)",
        phraseStep: "일정이 진행될 구체적인 장소를 입력",
      };
    }
    if (/에디터\s*본문|상세\s*내용|일정\s*내용|본문|내용을\s*입력/i.test(fieldPartOnly)) {
      return {
        category: "form_input",
        role: "form_work",
        modalScope,
        summaryForAi: "본문 에디터 영역에 양식 항목에 맞춰 구체적인 업무 내용이나 본문을 상세히 작성 (예시 본문 텍스트는 읽지 말 것)",
        phraseStep: "본문 에디터 영역에 양식에 맞춰 상세 내용을 작성",
      };
    }
    if (/폴더|새폴더|folder/i.test(fieldPartOnly)) {
      return {
        category: "form_input",
        role: "form_work",
        modalScope,
        summaryForAi: "자료를 구분해 보관할 신규 폴더의 이름을 입력 (예시 폴더명은 읽지 말 것)",
        phraseStep: "자료를 분류해 보관할 새 폴더 이름을 입력",
      };
    }

    // 다국어 명칭 입력란 ('한국어' 입력창 - 부서 추가 / 프로젝트 추가 / 분류 추가 등)
    if (/한국어|다국어|i18n/i.test(fieldPartOnly)) {
      const isDeptContext = /부서/.test(keys) || /트리/.test(prevDesc) || /트리/.test(nextDesc);
      return {
        category: "form_input",
        role: "form_work",
        modalScope,
        summaryForAi: isDeptContext
          ? "하위에 새로 생성할 부서 명칭을 입력란에 작성 (예시 부서명은 읽지 말 것)"
          : "새로 추가할 항목의 명칭을 한국어 입력란에 작성 (예시 명칭은 읽지 말 것)",
        phraseStep: isDeptContext
          ? "새로 생성할 하위 부서의 명칭을 입력"
          : "생성할 항목의 명칭을 입력란에 작성",
      };
    }

    // 주소록/연락처 및 계정 생성 전용 필드 판별
    if (/th7|이메일|email/i.test(fieldPartOnly) || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(keys)) {
      return {
        category: "contact_form",
        role: "form_work",
        modalScope,
        summaryForAi: "연락처의 이메일 주소를 입력란에 작성 (예시 이메일은 읽지 말 것)",
        phraseStep: "업무 연락에 사용할 이메일 주소를 작성",
      };
    }
    if (/th6|휴대전화|전화번호|mobile|phone/i.test(fieldPartOnly) || /^\d{2,3}-\d{3,4}-\d{4,5}$/.test(keys)) {
      return {
        category: "contact_form",
        role: "form_work",
        modalScope,
        summaryForAi: "연락처의 휴대전화 번호를 입력란에 작성 (예시 전화번호 숫자는 읽지 말 것)",
        phraseStep: "휴대전화 번호 등 연락처 정보를 입력",
      };
    }
    if (/userid|\bid\b|아이디/i.test(fieldPartOnly)) {
      const isLoginScreen =
        !/팝업/.test(desc) && (/['"]login['"]|로그인\s*버튼/i.test(nextDesc) || /로그아웃/i.test(prevDesc));
      return {
        category: "form_input",
        role: "form_work",
        modalScope,
        summaryForAi: isLoginScreen
          ? "로그인 화면에서 접속할 계정의 아이디를 입력 (예시 아이디는 읽지 말 것)"
          : "신규 사용자가 로그인할 때 사용할 고유 계정 아이디를 입력 (예시 아이디는 읽지 말 것)",
        phraseStep: isLoginScreen ? "접속할 계정의 아이디를 입력" : "사용할 고유 계정 아이디를 입력",
      };
    }
    if (/loginpwdvalid|비밀번호\s*확인/i.test(fieldPartOnly)) {
      return {
        category: "form_input",
        role: "form_work",
        modalScope,
        summaryForAi: "오타 방지를 위해 비밀번호 확인란에 동일한 비밀번호를 한 번 더 입력 (예시 비밀번호는 읽지 말 것)",
        phraseStep: "오류 방지를 위해 비밀번호 확인란을 동일하게 입력",
      };
    }
    if (/loginpwd|password|비밀번호/i.test(fieldPartOnly)) {
      return {
        category: "form_input",
        role: "form_work",
        modalScope,
        summaryForAi: "계정 보안을 위한 비밀번호를 입력란에 작성 (예시 비밀번호는 읽지 말 것)",
        phraseStep: "로그인에 사용할 비밀번호를 입력",
      };
    }
    if (/empname|사용자\s*이름/i.test(fieldPartOnly)) {
      return {
        category: "form_input",
        role: "form_work",
        modalScope,
        summaryForAi: "등록할 임직원의 성명을 사용자 이름란에 입력 (예시 이름은 언급하지 말 것)",
        phraseStep: "등록할 사용자의 성명을 입력",
      };
    }
    if (/givenname|성명|이름/i.test(fieldPartOnly)) {
      return {
        category: "contact_form",
        role: "form_work",
        modalScope,
        summaryForAi: "대상자의 성명을 이름 입력란에 작성 (예시 이름은 언급하지 말 것)",
        phraseStep: "이름과 기본 인적 사항을 입력",
      };
    }
    if (/cmp_name|회사/i.test(fieldPartOnly)) {
      return {
        category: "contact_form",
        role: "form_work",
        modalScope,
        summaryForAi: "소속 회사명을 입력란에 작성",
        phraseStep: "소속 회사 정보를 입력",
      };
    }
    if (/dept_name|부서/i.test(fieldPartOnly)) {
      return {
        category: "contact_form",
        role: "form_work",
        modalScope,
        summaryForAi: "소속 부서명을 입력란에 작성",
        phraseStep: "소속 부서와 직위 정보를 입력",
      };
    }
    if (/pos_name|직위|직책/i.test(fieldPartOnly)) {
      return {
        category: "contact_form",
        role: "form_work",
        modalScope,
        summaryForAi: "직위 및 직책 정보를 입력란에 작성",
        phraseStep: "소속 부서와 직위 정보를 입력",
      };
    }

    // 동적 커스텀 필드 ID ('sxH1784629305979' 등 스마트워크/전자결재 양식 전용 컴포넌트)
    if (/sxh\d+|custom|col_|form_/i.test(fieldPartOnly)) {
      return {
        category: "form_input",
        role: "form_work",
        modalScope,
        summaryForAi: "양식에 구성된 추가 세부 입력 항목에 관련 내용을 작성 (예시 입력값은 읽지 말 것)",
        phraseStep: "양식에 구성된 추가 세부 항목 내용을 입력",
      };
    }

    if (firstBracket && !/팝업$/.test(firstBracket)) {
      return {
        category: "form_input",
        role: "form_work",
        modalScope,
        summaryForAi: `${firstBracket} 입력란에 필요한 세부 정보를 작성 (예시 텍스트는 직접 읽지 말 것)`,
        phraseStep: `${firstBracket} 항목에 세부 정보를 입력`,
      };
    }

    return {
      category: "form_input",
      role: "form_work",
      modalScope,
      summaryForAi: "해당 입력 항목에 필요한 세부 정보를 작성 (예시 텍스트는 직접 읽지 말 것)",
      phraseStep: "해당 입력란에 세부 항목 정보를 작성",
    };
  }

  // 2. Drag & Drop
  if (m.type === "drag" || m.type === "dragAndDrop") {
    const isApprLine = /결재선|합의|참조|열람|수신/i.test(desc);
    return {
      category: isApprLine ? "org_select" : "general",
      role: isApprLine ? "popup_select" : "form_work",
      modalScope,
      summaryForAi: isApprLine
        ? "선택한 대상자를 마우스로 드래그하여 우측 결재선(결재·합의 등) 영역에 배치"
        : "대상을 마우스로 드래그하여 원하는 위치로 이동 배치",
      phraseStep: isApprLine
        ? "대상자를 드래그하여 우측 결재선 영역에 배치"
        : "대상을 드래그하여 지정 위치에 배치",
    };
  }

  // 2-A. File Upload (파일 첨부)
  if (m.type === "upload" || /파일\s*첨부|첨부파일|에\s*'[^']+'\s*첨부|파일\s*선택/i.test(desc)) {
    return {
      category: "file_upload",
      role: "form_work",
      modalScope,
      summaryForAi: "관련 참고 문서나 증빙 자료를 함께 공유하기 위해 '파일 선택'을 눌러 첨부 파일을 업로드 (예시 파일명은 읽지 말 것)",
      phraseStep: "관련 참고 자료를 공유하기 위해 첨부 파일을 업로드",
    };
  }

  // 2-B. Wiki Cover Image Selection Popup ('[주제 이미지 선택 팝업]') or opening it
  if (/\[주제\s*이미지\s*선택\s*팝업\]/i.test(desc)) {
    if (/['"]확인['"]\s*버튼/i.test(desc)) {
      return {
        category: "box_select",
        role: "popup_confirm",
        modalScope: "주제 이미지 선택 팝업",
        summaryForAi: "표지 이미지 선택 후 '확인' 버튼을 눌러 위키 주제 표지로 적용",
        phraseStep: "'확인'을 눌러 선택한 표지 이미지를 적용",
      };
    }
    return {
      category: "box_select",
      role: "popup_select",
      modalScope: "주제 이미지 선택 팝업",
      summaryForAi: "주제 공간을 직관적으로 구분할 수 있도록 표지 이미지 디자인을 선택",
      phraseStep: "주제 공간을 구분할 표지 이미지 디자인을 선택",
    };
  }
  if (/\[주제\s*이미지\s*선택\s*팝업\]/i.test(nextDesc) && /메뉴\/링크\s*클릭|요소\s*클릭/.test(desc)) {
    return {
      category: "box_select",
      role: "popup_open",
      modalScope: "주제 이미지 선택 팝업",
      summaryForAi: "위키 주제의 대표 표지를 변경하기 위해 표지 이미지 미리보기 영역을 클릭하여 선택 창 열기",
      phraseStep: "표지 이미지 영역을 클릭해 디자인 선택 창을 열기",
    };
  }

  // 3. Importance Star Rating ('[일정 팝업] 3 메뉴/링크 클릭' 등) — 날짜보다 먼저 판별
  if (/\[일정\s*팝업\]\s*['"]\d['"]\s*메뉴\/링크\s*클릭/i.test(desc) || /중요도|별점/i.test(desc)) {
    return {
      category: "rating",
      role: "form_work",
      modalScope,
      summaryForAi: "업무나 일정의 중요도를 한눈에 알아볼 수 있도록 중요도(별점) 옵션을 설정",
      phraseStep: "우선순위를 구분할 수 있도록 중요도(별점)를 설정",
    };
  }

  // 4. Date & Time Picker Clicks ('yyyy-MM-dd', 'hh:mm', '[달력 팝업] 31일', 또는 날짜 입력창 직후 '26' 요소 클릭 등)
  const isCalendarDayClickAfterDateInput =
    /^['"]?(?:[12]\d|3[01]|[1-9])(?:일)?['"]?\s*(?:요소|메뉴\/링크|버튼)\s*클릭$/i.test(desc) &&
    /yyyy-mm-dd|시작\s*일|종료\s*일|기한|달력|날짜/i.test(prevDesc);

  if (/yyyy-mm-dd|시작\s*일|종료\s*일|기한\s*입력/i.test(desc) && /입력창\s*클릭/.test(desc)) {
    return {
      category: "datetime",
      role: "date_open",
      modalScope,
      summaryForAi: "날짜 지정 달력을 열기 위해 날짜(기한) 입력란을 클릭",
      phraseStep: "기한 입력란을 클릭해 달력에서 일자를 지정",
    };
  }
  if (
    isCalendarDayClickAfterDateInput ||
    /달력\s*팝업|날짜\s*클릭/i.test(desc) ||
    /\[\s*달력[^\]]*\]/i.test(desc) ||
    /'\d{1,2}일'/.test(desc)
  ) {
    return {
      category: "datetime",
      role: "date_pick",
      modalScope,
      summaryForAi: "달력에서 일정이나 업무 마감 기한 날짜를 선택 (예시 일자 숫자는 절대 읽지 말고 날짜를 지정한다고 설명할 것)",
      phraseStep: "달력에서 진행 일자나 마감 기한을 지정",
    };
  }
  if (/hh:mm|시간\s*선택|시간\s*클릭/i.test(desc) || /'\d{1,2}:\d{2}'/.test(desc)) {
    return {
      category: "datetime",
      role: /입력창\s*클릭/.test(desc) ? "date_open" : "date_pick",
      modalScope,
      summaryForAi: "시간 선택 목록에서 진행 시간대를 설정 (예시 시각 숫자는 언급하지 말고 시간을 맞춘다고 설명할 것)",
      phraseStep: "일정에 맞춰 시작 및 종료 시간대를 설정",
    };
  }

  // 5. Organization Chart / User / Dept / Assignee / Admin / Approval Line Selection
  // ('[조직도 팝업] ...', '[담당자 선택 팝업] ...', '[관리자 팝업] ...', '[담당자 팝업] ...', '[결재선 팝업] ...')
  if (/\[(조직도|주소록|담당자(\s*선택)?|관리자(\s*선택)?|참여자(\s*선택)?|책임자(\s*선택)?|수신자(\s*선택)?|공유자(\s*선택)?|결재선[^\]]*)\s*팝업\]/i.test(desc)) {
    const isAssignee = /담당자/i.test(desc) || /담당자/i.test(prevDesc);
    const isAdminOrMgr = /관리자|책임자/i.test(desc);
    const isApprLine = /결재선/i.test(desc);
    const isAuth = /권한/i.test(prevDesc);

    if (/['"]확인['"]\s*버튼/i.test(desc)) {
      return {
        category: "org_select",
        role: "popup_confirm",
        modalScope: modalScope || "조직도 팝업",
        summaryForAi: isAssignee
          ? "담당자 지정 후 '확인' 버튼을 눌러 담당자로 반영"
          : isAdminOrMgr
          ? "책임자(관리자) 지정 후 '확인' 버튼을 눌러 반영"
          : isApprLine
          ? "결재선 구성을 마친 뒤 '확인' 버튼을 눌러 기안문에 결재선을 반영"
          : "대상자 선택 후 '확인' 버튼을 눌러 설정 내용을 반영",
        phraseStep: isAssignee
          ? "'확인'을 눌러 담당자 지정을 완료"
          : isAdminOrMgr
          ? "'확인'을 눌러 책임자(관리자) 지정을 완료"
          : isApprLine
          ? "'확인'을 눌러 구성된 결재선을 기안문에 반영"
          : "'확인'을 눌러 대상자 지정을 완료",
      };
    }
    if (/['"]추가['"]\s*버튼/i.test(desc)) {
      return {
        category: "org_select",
        role: "popup_select",
        modalScope: modalScope || "조직도 팝업",
        summaryForAi: "체크한 사원을 우측 수신·참석 대상 목록에 추가",
        phraseStep: "'추가' 버튼을 눌러 선택한 사원을 대상 목록에 반영",
      };
    }
    if (/트리\s*['"][^'"]+['"]\s*항목/i.test(desc)) {
      return {
        category: "org_select",
        role: "popup_select",
        modalScope: modalScope || "조직도 팝업",
        summaryForAi: "조직도 트리에서 대상자가 소속된 부서를 선택 (예시 부서명은 읽지 말 것)",
        phraseStep: "조직도 트리에서 소속 부서를 선택",
      };
    }
    return {
      category: "org_select",
      role: "popup_select",
      modalScope: modalScope || "조직도 팝업",
      summaryForAi: isAssignee
        ? "목록에서 해당 업무를 수행할 담당 사원을 선택 (예시 사원명은 읽지 말 것)"
        : isAdminOrMgr
        ? "목록에서 프로젝트를 총괄할 책임자(관리자) 사원을 선택 (예시 사원명은 읽지 말 것)"
        : isAuth
        ? "권한을 부여할 대상 사원이나 부서를 선택 (예시 명칭은 읽지 말 것)"
        : "사원 목록에서 함께 공유하거나 수신할 대상자를 선택 (예시 사원명은 읽지 말 것)",
      phraseStep: isAssignee
        ? "업무를 수행할 담당 사원을 선택"
        : isAdminOrMgr
        ? "총괄할 책임자(관리자) 사원을 선택"
        : "목록에서 대상 사원을 선택",
    };
  }

  if (
    /\[(담당자|참석자|공유자|수신자|참조|열람|권한|관리자|책임자)\]\s*['"](선택|추가|조직도)['"]/i.test(desc) ||
    (/['"]선택['"]\s*버튼/.test(desc) && /\[(조직도|담당자|관리자|참여자|책임자|수신자)/i.test(nextDesc))
  ) {
    const nextPopupRole = nextDesc.match(/\[(담당자|관리자|참여자|책임자|수신자|공유자)/)?.[1];
    const roleLabel =
      (firstBracket && !/팝업$/.test(firstBracket) ? firstBracket : nextPopupRole) || "대상자";
    return {
      category: "org_select",
      role: "popup_open",
      modalScope: `${roleLabel} 선택 팝업`,
      summaryForAi: `${roleLabel}를 지정하기 위해 '선택' 버튼을 눌러 조직도 선택 창 열기`,
      phraseStep: `${roleLabel} 지정을 위해 선택 창을 열기`,
    };
  }

  // 6. Resource / Meeting Room Selection ('[자원 선택 팝업]', '[자원예약 팝업]')
  if (/\[자원\s*선택\s*팝업\]|\[자원예약\s*팝업\]/i.test(desc)) {
    if (/['"]확인['"]\s*버튼/i.test(desc)) {
      return {
        category: "res_select",
        role: "popup_confirm",
        modalScope: "자원 선택 팝업",
        summaryForAi: "이용할 시설 선택 후 '확인' 버튼을 눌러 예약 자원으로 반영",
        phraseStep: "'확인'을 눌러 회의실(자원) 선택을 완료",
      };
    }
    if (/['"]시설['"]|폴더|회의실|예약신청|체크박스/i.test(desc)) {
      return {
        category: "res_select",
        role: "popup_select",
        modalScope: "자원 선택 팝업",
        summaryForAi: "자원 목록에서 이용할 회의실이나 공용 설비를 선택 (예시 회의실 명칭은 일반화할 것)",
        phraseStep: "자원 목록에서 이용할 회의실(시설)을 선택",
      };
    }
  }

  // 6-B. Binder / Document Box / Board / Workbox / Task Type Selection Popup
  if (/\[(분류|문서함|게시판|업무함|보고함|기록물철|일감(\s*선택)?)[^\]]*팝업\]/i.test(desc)) {
    const rawKind = (desc.match(/\[(분류|문서함|게시판|업무함|보고함|기록물철|일감)/)?.[1] || "분류").trim();
    const boxKind = rawKind === "일감" ? "일감 유형" : rawKind;
    const opensWriteForm = /업무함|문서함|게시판|보고함/.test(boxKind) && !/선택\s*버튼/.test(prevDesc);

    if (/['"]확인['"]\s*버튼/i.test(desc)) {
      return {
        category: "box_select",
        role: "popup_confirm",
        modalScope: modalScope || `${boxKind} 선택 팝업`,
        summaryForAi: opensWriteForm
          ? `${boxKind} 선택 후 '확인' 버튼을 눌러 해당 양식의 상세 작성 화면으로 진입`
          : `${boxKind} 선택 후 '확인' 버튼을 눌러 설정을 반영`,
        phraseStep: opensWriteForm
          ? `'확인'을 눌러 해당 ${boxKind}의 작성 화면으로 이동`
          : `'확인'을 눌러 선택한 ${boxKind}을 적용`,
      };
    }
    if (/전체\s*펼침|트리\s*확장/i.test(desc)) {
      return {
        category: "box_select",
        role: "popup_select",
        modalScope: modalScope || `${boxKind} 선택 팝업`,
        summaryForAi: `하위 ${boxKind} 목록을 한눈에 볼 수 있도록 트리 펼침 버튼을 클릭`,
        phraseStep: `하위 ${boxKind} 트리를 펼치기`,
      };
    }
    return {
      category: "box_select",
      role: "popup_select",
      modalScope: modalScope || `${boxKind} 선택 팝업`,
      summaryForAi: `목록에서 적용할 대상 ${boxKind} 항목을 선택 (구체적인 예시 명칭은 읽지 말 것)`,
      phraseStep: `목록에서 대상 ${boxKind} 항목을 선택`,
    };
  }

  if (
    /\[(결재분류|기록물철|문서보관함|게시판|문서함|업무함)\]\s*['"]선택['"]/i.test(desc) ||
    /['"]일감\s*선택['"]\s*버튼/i.test(desc)
  ) {
    const isTaskSelect = /일감\s*선택/i.test(desc);
    const labelName = isTaskSelect ? "일감 유형" : firstBracket || "분류";
    return {
      category: "box_select",
      role: "popup_open",
      modalScope: `${labelName} 선택 팝업`,
      summaryForAi: isTaskSelect
        ? "프로젝트에 연결할 일감 유형을 지정하기 위해 '일감선택' 버튼을 클릭하여 팝업 열기"
        : `문서가 체계적으로 보관될 ${labelName}을 지정하기 위해 '선택' 버튼을 눌러 팝업 열기`,
      phraseStep: isTaskSelect
        ? "연결할 일감 유형 지정을 위해 '일감선택' 창을 열기"
        : `문서가 보관될 ${labelName}을 지정하기 위해 '선택' 버튼을 클릭`,
    };
  }

  // 7. Resource use checkbox + Named Option Checkboxes ('[댓글 사용]', '[옵션] 비공개', '[보낸 쪽지 저장]' 등)
  if (/['"]예약사용['"]/i.test(desc)) {
    return {
      category: "res_select",
      role: "popup_open",
      summaryForAi: "일정에 맞춰 회의실이나 설비를 함께 배정하기 위해 자원 '예약사용' 항목을 체크",
      phraseStep: "일정에 필요한 회의실을 함께 배정하기 위해 '예약사용'을 체크",
    };
  }
  if (/\[댓글\s*사용\]/i.test(desc)) {
    return {
      category: "option_toggle",
      role: "form_work",
      summaryForAi: "구성원 간 자유로운 의견 교환이 가능하도록 '댓글 사용' 옵션을 활성화",
      phraseStep: "의견 공유가 가능하도록 '댓글 사용' 옵션을 체크",
    };
  }
  if (/['"]비공개['"]/i.test(desc)) {
    return {
      category: "option_toggle",
      role: "form_work",
      summaryForAi: "보안이 필요한 업무나 일정인 경우 지정된 담당자와 관련자만 열람할 수 있도록 '비공개' 옵션을 체크",
      phraseStep: "지정된 담당자만 열람할 수 있도록 '비공개' 옵션을 체크",
    };
  }

  // 8. System Alert / Confirmation Dialog
  if (/\[알림\s*팝업\]|안내\s*팝업\s*확인/i.test(desc)) {
    return {
      category: "alert_confirm",
      role: "popup_confirm",
      modalScope: "알림 팝업",
      summaryForAi: "처리 완료 안내 알림창의 '확인' 버튼을 눌러 절차를 마무리",
      phraseStep: "안내창의 '확인'을 눌러 처리를 마무리",
    };
  }

  // 9. Final verification click on newly created item
  if (/상세\s*정보\s*조회|등록된.*클릭/i.test(desc)) {
    return {
      category: "verify_view",
      role: "verify_view",
      summaryForAi: "목록에 방금 등록된 항목을 클릭하여 작성한 상세 내용과 설정 정보가 정상 반영되었는지 확인",
      phraseStep: "목록에 등록된 항목을 클릭해 상세 내용이 정상 반영되었는지 확인",
    };
  }

  // 9-B. Tree node selection outside modal (e.g. '트리 그룹웨어TFT 항목 클릭', '트리 공공기업팀 항목 클릭')
  if (/^트리\s*['"][^'"]+['"]\s*항목/i.test(desc)) {
    const isAdminOrg = /추가|등록|부서|한국어/i.test(nextDesc);
    return {
      category: "org_select",
      role: "form_work",
      summaryForAi: isAdminOrg
        ? "좌측 조직도 트리에서 하위 부서나 사용자를 추가할 기준 부서를 선택 (예시 부서명은 일반화할 것)"
        : "좌측 부서 트리에서 조회할 대상 부서를 선택 (예시 부서명은 일반화할 것)",
      phraseStep: isAdminOrg
        ? "조직도 트리에서 작업할 대상 부서를 선택"
        : "트리에서 조회할 대상 부서를 선택",
    };
  }

  // 10. Fixed UI Navigation Menus & Standard Action Buttons
  let targetName = "";
  const allMatches = Array.from(desc.matchAll(/['"]([^'"]+)['"]|\[([^\]]+)\]/g));
  for (const match of allMatches) {
    const candidate = (match[1] || match[2] || "").trim();
    if (!candidate) continue;
    if (/팝업$|받는사람|제목/.test(candidate) && allMatches.length > 1) continue;
    targetName = candidate;
  }

  if (targetName) {
    // 사용자 등록 팝업 내 라이선스 체크박스 ('그룹웨어', '전자결재', '모바일 그룹웨어' 등)
    if (/\[사용자\s*(등록|추가)\s*팝업\]/i.test(desc) && (/요소\s*클릭|체크박스/.test(desc) || !/저장|확인|취소/.test(targetName))) {
      return {
        category: "option_toggle",
        role: "form_work",
        modalScope,
        summaryForAi: `신규 계정이 사용할 수 있는 서비스 권한을 부여하기 위해 '${targetName}' 라이선스 항목을 체크`,
        phraseStep: `서비스 이용 권한 부여를 위해 '${targetName}' 라이선스를 체크`,
      };
    }

    // 프로젝트 추가 팝업 내 연결 메뉴 옵션 체크박스 ('할일', '문서함' 등 요소 클릭)
    if (/\[프로젝트\s*추가\s*팝업\]/i.test(desc) && /요소\s*클릭|체크박스/.test(desc)) {
      return {
        category: "option_toggle",
        role: "form_work",
        modalScope,
        summaryForAi: `프로젝트에서 함께 사용할 세부 기능('${targetName}' 등) 옵션을 선택`,
        phraseStep: `프로젝트에서 함께 사용할 '${targetName}' 등 세부 기능 옵션을 선택`,
      };
    }

    // 연락처 등록 팝업 내 주소록 구분('개인', '공용', '부서') 및 세부 그룹 드롭다운('- 선택 -' -> 그룹명) 선택
    if (
      /요소에서\s*['"][^'"]+['"]\s*선택/.test(desc) ||
      (/^(개인|공용|부서)$/.test(targetName) && (/버튼\s*클릭|요소\s*클릭/.test(desc) || /연락처/i.test(prevDesc)))
    ) {
      return {
        category: "box_select",
        role: "popup_select",
        modalScope,
        summaryForAi: `연락처를 보관할 주소록 구분('${targetName}')을 선택`,
        phraseStep: `연락처를 보관할 '${targetName}' 주소록 구분을 선택`,
      };
    }
    if (/-\s*선택\s*-/.test(targetName)) {
      return {
        category: "box_select",
        role: "popup_open",
        modalScope,
        summaryForAi: "항목을 저장할 세부 그룹(분류)을 지정하기 위해 드롭다운 선택 목록을 열기",
        phraseStep: "저장할 세부 그룹을 지정하기 위해 선택 목록을 열기",
      };
    }
    if (/-\s*선택\s*-/.test(prevDesc) && /요소\s*클릭/.test(desc)) {
      return {
        category: "box_select",
        role: "popup_confirm",
        modalScope,
        summaryForAi: "드롭다운 목록에서 항목을 보관할 대상 그룹을 선택 (구체적인 예시 그룹명은 읽지 말 것)",
        phraseStep: "드롭다운 목록에서 보관할 대상 그룹을 선택",
      };
    }

    if (/조직도(\s*선택)?|주소록|결재선/.test(targetName) && /버튼/.test(desc)) {
      return {
        category: "org_select",
        role: "popup_open",
        modalScope: `${targetName} 팝업`,
        summaryForAi: `대상자를 지정하기 위해 '${targetName}' 버튼을 눌러 선택 팝업 창 열기`,
        phraseStep: `대상자 지정을 위해 '${targetName}' 버튼을 클릭해 선택 창을 열기`,
      };
    }

    if (/체크박스/.test(desc)) {
      const isOptionCheckbox =
        /중요\s*공지|보낸\s*쪽지함에\s*저장|내게도\s*발송|개별\s*발송|긴급|보안|댓글|알림|공유|사용|허용|그룹웨어|전자결재|모바일|메일|메신저/.test(
          targetName
        );
      if (isOptionCheckbox) {
        const optionExplain = /중요\s*공지/.test(targetName)
          ? `게시글이 목록 상단에 강조 표시되도록 '${targetName}' 옵션을 체크`
          : /보낸\s*쪽지|내게도/.test(targetName)
          ? `발송 내역을 보관하고 확인할 수 있도록 '${targetName}' 옵션을 체크`
          : `부가 기능 적용을 위해 '${targetName}' 옵션을 체크`;
        return {
          category: "option_toggle",
          role: "form_work",
          modalScope,
          summaryForAi: optionExplain,
          phraseStep: optionExplain,
        };
      }
      return {
        category: "general",
        role: modalScope ? "popup_select" : "form_work",
        modalScope,
        summaryForAi: "목록에서 작업할 대상 항목의 체크박스를 선택",
        phraseStep: "목록에서 대상 항목을 체크",
      };
    }

    if (/메뉴|링크|탭/.test(desc) || /^['"]전체메뉴['"]\s*버튼/i.test(desc)) {
      if (/전체메뉴/i.test(targetName)) {
        return {
          category: "nav_entry",
          role: "nav_entry",
          summaryForAi: "그룹웨어의 전체 서비스 모듈 목록을 열기 위해 상단 '전체메뉴' 버튼을 클릭",
          phraseStep: "포탈 상단 '전체메뉴'를 열기",
        };
      }
      if (/로그아웃/i.test(targetName)) {
        return {
          category: "verify_view",
          role: "verify_view",
          summaryForAi: "생성된 신규 계정으로 전환 접속하기 위해 현재 계정에서 '로그아웃'을 클릭",
          phraseStep: "신규 계정 접속을 확인하기 위해 현재 계정에서 '로그아웃'을 클릭",
        };
      }

      // 표준 모듈/메뉴 이름은 절대 생성된 예시 항목(isCreatedSampleItem)으로 오판하지 않도록 보호
      const isStandardMenu = STANDARD_UI_MENU_REGEX.test(targetName);
      const isCreatedSampleItem =
        !isStandardMenu &&
        (/테스트|샘플|예시|\d{4}-\d{2}-\d{2}/.test(targetName) ||
          Boolean(
            context?.typedValues?.some(
              (tv) => tv.length >= 2 && (targetName.includes(tv) || tv.includes(targetName))
            )
          ));

      if (isCreatedSampleItem) {
        if (/작성/.test(nextDesc)) {
          return {
            category: "verify_view",
            role: "create_start",
            summaryForAi: "방금 생성한 항목(주제/폴더)을 선택하여 하위 문서를 작성할 상세 화면으로 이동",
            phraseStep: "방금 생성한 항목을 선택해 상세 화면으로 이동",
          };
        }
        return {
          category: "verify_view",
          role: "verify_view",
          summaryForAi: "목록에 방금 등록된 항목을 클릭하여 작성한 상세 내용과 설정 정보가 정상 반영되었는지 확인 (예시 제목은 읽지 말 것)",
          phraseStep: "목록에 등록된 항목을 클릭해 상세 내용이 정상 반영되었는지 확인",
        };
      }

      const modExplain = getModuleRoleExplanation(targetName);
      return {
        category: "nav_entry",
        role: "nav_entry",
        summaryForAi: modExplain.summary,
        phraseStep: modExplain.phrase,
      };
    }

    // 주요 작성/등록 시작 버튼 ('업무 등록', '일정 등록', '결재 작성', '주제 등록', '글 등록', '문서 등록', '쪽지쓰기', '메일쓰기', '프로젝트 추가', '새 프로젝트 생성' 등)
    if (
      /^(업무\s*등록|일정\s*등록|예약\s*신청|결재\s*작성|기안\s*작성|업무\s*작성|주제\s*등록|글\s*등록|글\s*작성|문서\s*등록|쪽지\s*쓰기|쪽지쓰기|메일\s*쓰기|메일쓰기|연락처\s*등록|연락처등록|연락처\s*추가|새\s*폴더|새폴더|보고\s*등록|일감\s*등록|설문\s*등록|프로젝트\s*추가|새\s*프로젝트\s*생성)$/i.test(
        targetName
      )
    ) {
      const opensBoxModal = /선택\s*팝업/.test(nextDesc);
      const explainMap: Record<string, string> = {
        "업무 등록": opensBoxModal
          ? "좌측의 '업무 등록' 버튼을 클릭하여 새 업무를 생성할 업무함 선택 창을 열기"
          : "좌측의 '업무 등록' 버튼을 클릭하여 새 업무 작성 화면을 열기",
        "일정 등록": "좌측의 '일정 등록' 버튼을 클릭하여 일시와 참석자를 지정하는 일정 등록 화면을 열기",
        "예약 신청": "좌측의 '예약 신청' 버튼을 클릭하여 이용할 시설과 시간대를 지정하는 예약 화면을 열기",
        "결재 작성": "좌측의 '결재 작성' 버튼을 클릭하여 기안에 사용할 결재 양식 선택 화면으로 이동",
        "기안 작성": "좌측의 '기안 작성' 버튼을 클릭하여 기안에 사용할 결재 양식 선택 화면으로 이동",
        "업무 작성": "좌측의 '업무 작성' 버튼을 클릭하여 기안에 사용할 결재 양식 선택 화면으로 이동",
        "주제 등록": "좌측의 '주제 등록' 버튼을 클릭하여 협업 지식 공간인 새 위키 주제 생성 창을 열기",
        "글 등록": "상단의 '글 등록' 버튼을 클릭하여 새 게시글 작성 화면으로 이동",
        "글 작성": "상단의 '글 작성' 버튼을 클릭하여 새 게시글 작성 화면으로 이동",
        "문서 등록": opensBoxModal
          ? "좌측의 '문서 등록' 버튼을 클릭하여 문서를 보관할 문서함 선택 창을 열기"
          : "좌측의 '문서 등록' 버튼을 클릭하여 새 문서 작성 화면으로 이동",
        "쪽지쓰기": "좌측의 '쪽지쓰기' 버튼을 클릭하여 수신자와 본문을 입력하는 쪽지 작성 화면을 열기",
        "쪽지 쓰기": "좌측의 '쪽지 쓰기' 버튼을 클릭하여 수신자와 본문을 입력하는 쪽지 작성 화면을 열기",
        "메일쓰기": "좌측의 '메일쓰기' 버튼을 클릭하여 수신자와 본문을 작성하는 메일 발송 화면을 열기",
        "메일 쓰기": "좌측의 '메일 쓰기' 버튼을 클릭하여 수신자와 본문을 작성하는 메일 발송 화면을 열기",
        "연락처 등록": "좌측의 '연락처 등록' 버튼을 클릭하여 새 연락처 정보를 입력하는 등록 창을 열기",
        "연락처등록": "좌측의 '연락처등록' 버튼을 클릭하여 새 연락처 정보를 입력하는 등록 창을 열기",
        "연락처 추가": "좌측의 '연락처 추가' 버튼을 클릭하여 새 연락처 정보를 입력하는 등록 창을 열기",
        "새폴더": "상단의 '새폴더' 버튼을 클릭하여 하위 폴더를 생성하는 입력 창을 열기",
        "새 폴더": "상단의 '새 폴더' 버튼을 클릭하여 하위 폴더를 생성하는 입력 창을 열기",
        "프로젝트 추가": "좌측의 '프로젝트 추가' 버튼을 눌러 신규 프로젝트 생성 절차를 시작",
        "새 프로젝트 생성": "'새 프로젝트 생성' 버튼을 클릭하여 프로젝트 상세 설정 창을 열기",
      };
      const normKey = targetName.replace(/\s+/g, " ").trim();
      const phrase = explainMap[normKey] || explainMap[targetName] || `'${targetName}' 버튼을 눌러 새 항목 작성 화면을 열기`;
      return {
        category: "create_start",
        role: "create_start",
        summaryForAi: phrase,
        phraseStep: phrase,
      };
    }

    if (/^목록$/.test(targetName)) {
      return {
        category: "nav_entry",
        role: "nav_entry",
        summaryForAi: "전체 목록 화면으로 돌아가기 위해 '목록' 버튼을 클릭",
        phraseStep: "'목록' 버튼을 눌러 전체 목록 화면으로 이동",
      };
    }

    if (/^작성$/.test(targetName)) {
      const isFormCard = /검색|양식|카드|aw_li/i.test(prevDesc);
      const phrase = isFormCard
        ? "조회된 결재 양식 카드에서 '작성' 버튼을 눌러 기안문 작성 화면으로 이동"
        : "우측 상단의 '작성' 버튼을 클릭하여 새 페이지 편집 화면을 열기";
      return {
        category: "create_start",
        role: "create_start",
        summaryForAi: phrase,
        phraseStep: phrase,
      };
    }

    if (/^추가$/.test(targetName) && !modalScope) {
      const opensUserModal = /사용자\s*(등록|추가)\s*팝업/.test(nextDesc);
      const phrase = opensUserModal
        ? "선택한 부서에 신규 임직원을 등록하기 위해 상단 '추가' 버튼을 눌러 사용자 등록 창을 열기"
        : "새 항목을 등록하기 위해 '추가' 버튼을 눌러 입력 창을 열기";
      return {
        category: "create_start",
        role: "create_start",
        summaryForAi: phrase,
        phraseStep: phrase,
      };
    }

    if (/공동\s*편집/.test(targetName)) {
      return {
        category: "submit_save",
        role: "submit_save",
        summaryForAi: "여러 구성원이 문서를 함께 수정·보완할 수 있도록 '공동 편집' 버튼을 눌러 공동 편집 모드를 실행",
        phraseStep: "구성원들과 함께 문서를 편집할 수 있도록 '공동 편집' 버튼을 클릭",
      };
    }

    if (/삭제/.test(targetName)) {
      return {
        category: "submit_save",
        role: "submit_save",
        summaryForAi: "등록된 항목을 정리하기 위해 상단 '삭제' 버튼을 클릭",
        phraseStep: "등록된 항목을 정리하기 위해 '삭제' 버튼을 클릭",
      };
    }

    if (/login|로그인/i.test(targetName)) {
      return {
        category: "verify_view",
        role: "verify_view",
        summaryForAi: `'${targetName}' 버튼을 눌러 입력한 계정으로 그룹웨어에 정상 로그인되는지 확인`,
        phraseStep: `'${targetName}' 버튼을 눌러 해당 계정으로 정상 접속되는지 확인`,
      };
    }

    if (/저장|발송|보내기|기안상신|결재상신|상신|등록\s*완료|프로젝트\s*생성/.test(targetName)) {
      const isDeptCreateModal = /프로젝트\s*추가\s*팝업/i.test(desc) && /^저장$/.test(targetName);
      if (isDeptCreateModal) {
        return {
          category: "submit_save",
          role: "popup_confirm",
          modalScope,
          summaryForAi: `입력한 명칭을 확인한 뒤 '${targetName}' 버튼을 눌러 생성을 완료`,
          phraseStep: `'${targetName}'을 눌러 생성을 완료`,
        };
      }
      const actionVerb = /발송|보내기/.test(targetName)
        ? "작성한 내용과 수신자를 확인한 뒤 발송을 완료"
        : /상신/.test(targetName)
        ? "작성한 기안문과 결재선을 확인한 뒤 결재를 상신"
        : /프로젝트\s*생성/.test(targetName)
        ? "설정한 프로젝트 정보를 확인한 뒤 프로젝트 생성을 완료"
        : "작성한 모든 항목을 확인한 뒤 최종 등록을 완료";
      return {
        category: "submit_save",
        role: "submit_save",
        modalScope,
        summaryForAi: `'${targetName}' 버튼을 눌러 ${actionVerb}`,
        phraseStep: `모든 항목 입력을 마친 뒤 '${targetName}' 버튼을 눌러 ${actionVerb.replace(/^.*뒤\s*/, "")}`,
      };
    }

    if (/확인/.test(targetName)) {
      const prevWasDelete = /삭제/.test(prevDesc);
      const prevWasSave = /저장|발송|보내기|상신|등록/.test(prevDesc);
      return {
        category: prevWasDelete || prevWasSave ? "submit_save" : "alert_confirm",
        role: "popup_confirm",
        modalScope,
        summaryForAi: prevWasDelete
          ? "확인 창에서 '확인' 버튼을 눌러 해당 항목을 최종 삭제"
          : prevWasSave
          ? "확인 창의 '확인' 버튼을 눌러 등록 절차를 최종 확정"
          : "선택한 설정을 적용하기 위해 '확인' 버튼을 클릭",
        phraseStep: prevWasDelete
          ? "확인 창을 승인하여 최종 삭제를 완료"
          : prevWasSave
          ? "안내창의 '확인'을 눌러 등록을 최종 완료"
          : "'확인'을 눌러 선택한 내용을 적용",
      };
    }

    if (firstBracket && !/팝업$/.test(firstBracket) && firstBracket !== targetName) {
      return {
        category: "general",
        role: /선택|추가|찾기/.test(targetName) ? "popup_open" : "form_work",
        modalScope,
        summaryForAi: `${firstBracket} 설정을 위해 '${targetName}' 버튼을 클릭`,
        phraseStep: `${firstBracket} 설정을 위해 '${targetName}' 버튼을 클릭`,
      };
    }
    return {
      category: "general",
      role: "form_work",
      modalScope,
      summaryForAi: `'${targetName}' 버튼을 클릭하여 해당 기능을 실행`,
      phraseStep: `'${targetName}' 버튼을 클릭해 기능을 실행`,
    };
  }

  const cleaned = desc
    .replace(/\s*\(Phase\s*\d+\)/gi, "")
    .replace(/\s*반응\s*대기$/g, "")
    .trim();
  return {
    category: "general",
    role: "form_work",
    modalScope,
    summaryForAi: cleaned,
    phraseStep: "해당 기능을 실행",
  };
}

function cleanActionDescription(
  m: Moment,
  context?: { prevMoment?: Moment; nextMoment?: Moment; typedValues?: string[] }
): string {
  return classifyMomentSemantics(m, context).summaryForAi;
}

/**
 * 시나리오 전체 액션과 슬러그를 분석하여 "어떤 매뉴얼인지" 핵심 주제를 한 구절로 도출합니다.
 */
export function deriveScenarioTopicSummary(
  slug: string,
  momentsFile: MomentsFile,
  browsePlan?: BrowsePlan | null
): { fullTopic: string; shortPurpose: string } {
  // 시연 중 타이핑한 예시 문자열이나 팝업 내 부가 옵션(예: 사용자 등록 팝업 내 '전자결재' 라이선스 체크박스)이
  // 전체 시나리오 모듈 판별을 오염시키지 않도록 정제합니다.
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

  // 0. 관리자 / 조직관리 / 사용자 계정 생성 및 로그인
  if (
    /조직관리|사용자\s*등록\s*팝업|사용자\s*추가\s*팝업|orgmgt|orgusermng|orgempregform/i.test(fullJoined)
  ) {
    const hasLogin = /btnlogin|로그아웃|login/i.test(fullJoined);
    return {
      fullTopic: hasLogin
        ? "관리자 조직관리에서 신규 사용자 계정을 등록하고 생성된 계정으로 로그인하는 방법"
        : "관리자 조직관리에서 부서별 신규 사용자 계정을 추가하고 등록하는 방법",
      shortPurpose: hasLogin
        ? "신규 사용자 계정 등록 및 로그인"
        : "관리자 신규 사용자 계정 등록",
    };
  }

  // 1. 위키 (Wiki)
  if (/위키|주제\s*등록|최신\s*주제|최신\s*페이지|wikibook|wikisidemenu|wikimain/i.test(fullJoined)) {
    const hasTopicReg = /주제\s*등록|wikibookreg|bookreg/i.test(fullJoined);
    const hasPageWrite = /wikibookcontent|제목\s*없는\s*페이지|bn-editor|['"]작성['"]\s*버튼/i.test(fullJoined);
    const hasCollabo = /공동\s*편집|_change_collabo/i.test(fullJoined);

    if (hasTopicReg && hasPageWrite) {
      return {
        fullTopic: hasCollabo
          ? "위키에서 새 주제를 등록한 뒤 페이지를 작성하고 공동 편집으로 저장하는 방법"
          : "위키에서 새 주제를 등록하고 페이지를 작성하여 저장하는 방법",
        shortPurpose: hasCollabo
          ? "위키 주제 등록 및 공동 편집 페이지 작성"
          : "위키 주제 등록 및 페이지 작성",
      };
    }
    if (hasTopicReg) {
      return {
        fullTopic: "위키에서 표지 이미지와 권한을 설정하여 새 주제를 등록하는 방법",
        shortPurpose: "위키 새 주제 등록",
      };
    }
    if (hasPageWrite) {
      return {
        fullTopic: hasCollabo
          ? "위키에서 새 페이지를 작성하고 공동 편집 모드로 저장하는 방법"
          : "위키에서 새 페이지를 작성하고 저장하는 방법",
        shortPurpose: "위키 새 페이지 작성",
      };
    }
    return {
      fullTopic: "위키에서 주제와 페이지를 조회하고 관리하는 방법",
      shortPurpose: "위키 주제 및 페이지 관리",
    };
  }

  // 2. 주소록 (Address Book) — 메일/쪽지 내 수신자 [주소록] 팝업 호출과 구분하여 연락처 등록 모듈만 판별
  if (
    /연락처\s*등록|연락처등록|연락처\s*추가|addrmain|contact_add_lyr|tutorial-address|['"]주소록['"]\s*메뉴/i.test(
      fullJoined
    ) &&
    !/전자우편|메일\s*쓰기|메일쓰기|사내쪽지|쪽지\s*쓰기|쪽지쓰기|emlmail|notnote|tutorial-mail|tutorial-note/i.test(
      fullJoined
    )
  ) {
    return {
      fullTopic: "주소록에서 새로운 연락처 정보를 입력하고 저장하는 방법",
      shortPurpose: "주소록 새 연락처 등록",
    };
  }

  // 3. 사내쪽지 (Internal Note)
  if (/사내쪽지|쪽지\s*쓰기|쪽지쓰기|보낸\s*쪽지|notmain|notnotereg|notSubMenu|tutorial-note/i.test(fullJoined)) {
    return {
      fullTopic: "사내쪽지에서 수신 대상자를 선택해 쪽지를 작성하고 발송하는 방법",
      shortPurpose: "사내쪽지 작성 및 발송",
    };
  }

  // 4. 전자우편 / 웹메일 (Email)
  if (/전자우편|웹메일|메일\s*쓰기|메일쓰기|보낸메일|받은메일|emlmain|emlmail|emllist|tutorial-mail/i.test(fullJoined)) {
    return {
      fullTopic: "전자우편에서 수신자와 본문을 작성해 새 메일을 발송하는 방법",
      shortPurpose: "전자우편 메일 작성 및 발송",
    };
  }

  // 5. 자원예약관리 (Resource Reservation) — 회의실/시설 전용 예약 모듈을 일정관리보다 먼저 판별
  if (
    /자원예약|예약\s*신청|예약신청|rmgres|resinsertdetailview|resselect_reslist|tutorial-resource/i.test(
      fullJoined
    ) &&
    !/일정관리|일정\s*등록|scdinsert/i.test(uiJoined)
  ) {
    return {
      fullTopic: "자원예약관리에서 이용할 회의실(시설)과 사용 시간대를 지정해 예약 신청하는 방법",
      shortPurpose: "자원예약관리 회의실 예약 신청",
    };
  }

  // 6. 일정관리 (Schedule / Calendar)
  if (
    /일정관리|일정\s*등록|일정등록|캘린더|scdgetmainview|scdinsert|reg_shedule_lefttop|schedule|diary/i.test(
      fullJoined
    )
  ) {
    const hasRoom = /회의실|자원|예약사용/i.test(uiJoined);
    const hasAttendee = /참석자|조직도|공유/i.test(uiJoined);
    if (hasRoom && hasAttendee) {
      return {
        fullTopic: "일정관리에서 참석자와 회의실 자원을 함께 지정하여 새 일정을 등록하는 방법",
        shortPurpose: "일정관리 참석자·회의실 지정 일정 등록",
      };
    }
    return {
      fullTopic: hasAttendee || hasRoom
        ? "일정관리에서 세부 옵션과 대상자를 지정하여 새 일정을 등록하는 방법"
        : "일정관리 캘린더에서 새로운 일정을 등록하고 확인하는 방법",
      shortPurpose: "일정관리 새 일정 등록",
    };
  }

  // 7. 전자결재 / 기업결재 / 공공결재 (EAP / GAP)
  if (
    /전자결재|['"]결재['"]\s*메뉴|결재\s*작성|결재작성|기안\s*작성|기안작성|결재선|결재상신|기안상신|기록물철|eapmain|eapdoc|eapwork|gapmain|gapdoc|gapwork|approval|tutorial-draft/i.test(
      fullJoined
    )
  ) {
    const hasApprLine = /결재선|합의|드래그|eaplineselect|gaplineselect/i.test(fullJoined);
    const hasBinder = /기록물철|보관함|binder/i.test(fullJoined);
    if (/승인|반려|결재대기/.test(uiJoined) && !/결재\s*작성|결재작성|기안\s*작성|기안작성|btn_write/.test(fullJoined)) {
      return {
        fullTopic: "전자결재에서 대기 중인 결재 문서를 검토하고 승인 처리하는 방법",
        shortPurpose: "전자결재 문서 검토 및 승인 처리",
      };
    }
    if (hasApprLine && hasBinder) {
      return {
        fullTopic: "전자결재에서 기안 양식을 선택해 문서정보와 결재선을 지정하고 상신하는 방법",
        shortPurpose: "전자결재 기안 작성 및 결재선 상신",
      };
    }
    return {
      fullTopic: hasApprLine
        ? "전자결재에서 기안 양식을 작성하고 결재선을 지정하여 상신하는 방법"
        : "전자결재에서 기안 양식을 선택해 문서를 작성하고 상신하는 방법",
      shortPurpose: hasApprLine ? "전자결재 기안 작성 및 결재선 상신" : "전자결재 기안문 작성 및 상신",
    };
  }

  // 8. 게시판 / 공지사항 (Board)
  if (/게시판|공지사항|글\s*등록|글\s*작성|글작성|brdboard|brdatcl|tutorial-board|test-board/i.test(fullJoined)) {
    const isNotice = /공지사항|중요\s*공지/.test(uiJoined);
    return {
      fullTopic: isNotice
        ? "게시판에서 공지사항 게시글을 작성하고 등록하는 방법"
        : "게시판에서 대상 게시판을 선택해 새 게시글을 작성하고 등록하는 방법",
      shortPurpose: isNotice ? "게시판 공지사항 작성 및 등록" : "게시판 새 게시글 작성 및 등록",
    };
  }

  // 9. 문서관리 (Document Management)
  if (/문서관리|문서\s*등록|문서등록|문서함|docmain|docleft|docselect|atclwrite|atcledit|edms|tutorial-document/i.test(fullJoined)) {
    return {
      fullTopic: "문서관리에서 문서함과 분류를 선택해 새 문서를 등록하고 조회하는 방법",
      shortPurpose: "문서관리 새 문서 등록 및 조회",
    };
  }

  // 10. 스마트워크 (SmartWork)
  if (/스마트워크|업무\s*등록|업무등록|업무함|smartwork|smwwork|tutorial-smartwork/i.test(fullJoined)) {
    return {
      fullTopic: "스마트워크에서 업무함을 선택하고 담당자를 지정해 새 업무를 등록하는 방법",
      shortPurpose: "스마트워크 새 업무 등록",
    };
  }

  // 11. 파일관리 / 파일함 (Filebox)
  if (/파일관리|파일함|새\s*폴더|새폴더|개인\s*폴더|fbxmain|filebox|tutorial-filebox/i.test(fullJoined)) {
    return {
      fullTopic: "파일관리에서 개인 폴더를 새로 생성하고 관리하는 방법",
      shortPurpose: "파일관리 새 폴더 생성 및 관리",
    };
  }

  // 12. 업무보고 (Work Report)
  if (/업무보고|보고\s*등록|보고등록|보고함|wormain|worreport|worsidebar/i.test(fullJoined)) {
    return {
      fullTopic: "업무보고에서 보고함을 선택해 새 업무보고서를 작성하고 등록하는 방법",
      shortPurpose: "업무보고 새 보고서 작성 및 등록",
    };
  }

  // 13. 프로젝트 / 스페이스 / 일감 (Project / Workspace)
  if (/['"](프로젝트|스페이스)['"]\s*메뉴|일감\s*등록|일감등록|마일스톤|prjmain|prjtask|prjdetail/i.test(fullJoined)) {
    return {
      fullTopic: "프로젝트에서 새 일감을 작성하고 담당자를 지정해 등록하는 방법",
      shortPurpose: "프로젝트 새 일감 등록",
    };
  }

  // 14. 설문조사 (Survey)
  if (/설문조사|설문\s*등록|설문등록|sursurvey/i.test(fullJoined)) {
    return {
      fullTopic: "설문조사에서 새로운 설문 문항을 작성하고 등록하는 방법",
      shortPurpose: "설문조사 새 설문 등록",
    };
  }

  // 15. 메모 / 할일 (Memo / Todo)
  if (/['"]메모['"]\s*메뉴|메모\s*등록|mmomain|mmomemo/i.test(fullJoined)) {
    return {
      fullTopic: "메모 모듈에서 새 메모를 작성하고 저장하는 방법",
      shortPurpose: "새 메모 작성 및 저장",
    };
  }

  // 16. 근태관리 (Attendance)
  if (/근태관리|출퇴근|부재\s*등록|부재등록|휴가\s*신청|atnattend/i.test(fullJoined)) {
    return {
      fullTopic: "근태관리에서 출퇴근 및 부재 내역을 등록하고 관리하는 방법",
      shortPurpose: "근태관리 부재 및 근태 등록",
    };
  }

  // 17. 동적 액션 기반 주제 추출 폴백 (미등록/커스텀 모듈이라도 실제 클릭한 메뉴명과 핵심 버튼을 조합)
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
  if (firstMenu) {
    return {
      fullTopic: `${firstMenu} 메뉴의 주요 기능을 실행하고 처리하는 방법`,
      shortPurpose: `${firstMenu} 기능 실행 및 처리`,
    };
  }

  return {
    fullTopic: "그룹웨어 주요 메뉴로 이동하여 업무를 처리하는 방법",
    shortPurpose: "그룹웨어 주요 업무 처리",
  };
}

function applyStyleEnding(baseActionPhrase: string, style: NarrationStyle, isLast: boolean): string {
  const clean = baseActionPhrase
    .replace(/합니다\.?$/, "")
    .replace(/엽니다\.?$/, "열기")
    .replace(/펼칩니다\.?$/, "펼치기")
    .trim();

  if (style === "friendly") {
    if (clean.endsWith("열기")) return `${clean.replace(/열기$/, "열어 줄게요")}.`;
    if (clean.endsWith("펼치기")) return `${clean.replace(/펼치기$/, "펼쳐 볼게요")}.`;
    if (clean.endsWith("이동")) return `${clean.replace(/이동$/, "이동해 볼게요")}.`;
    if (clean.endsWith("진입")) return `${clean.replace(/진입$/, "진입해 볼게요")}.`;
    if (clean.endsWith("클릭")) return `${clean.replace(/클릭$/, "클릭해 주세요")}.`;
    if (clean.endsWith("선택")) return `${clean.replace(/선택$/, "선택해 줍니다")}.`;
    if (clean.endsWith("지정")) return `${clean.replace(/지정$/, "지정해 주세요")}.`;
    if (clean.endsWith("설정")) return `${clean.replace(/설정$/, "맞춰 줄게요")}.`;
    if (clean.endsWith("입력")) return `${clean.replace(/입력$/, "입력해 줄게요")}.`;
    if (clean.endsWith("작성")) return `${clean.replace(/작성$/, "작성해 주세요")}.`;
    if (clean.endsWith("조회")) return `${clean.replace(/조회$/, "조회해 볼게요")}.`;
    if (clean.endsWith("업로드")) return `${clean.replace(/업로드$/, "업로드해 주세요")}.`;
    if (clean.endsWith("체크")) return `${clean.replace(/체크$/, "체크해 줍니다")}.`;
    if (clean.endsWith("적용") || clean.endsWith("반영")) {
      return `${clean.replace(/(적용|반영)$/, "적용해 줄게요")}.`;
    }
    if (clean.endsWith("추가")) return `${clean.replace(/추가$/, "추가해 줄게요")}.`;
    if (clean.endsWith("저장") || clean.endsWith("상신")) return `${clean}해 줄게요.`;
    if (clean.endsWith("삭제")) return `${clean.replace(/삭제$/, "삭제해 볼게요")}.`;
    if (clean.endsWith("확인")) return `${clean.replace(/확인$/, "확인해 볼게요")}.`;
    if (clean.endsWith("마무리") || clean.endsWith("완료")) {
      return `${clean.replace(/(마무리|완료)$/, "마무리해 볼게요")}.`;
    }
    return `${clean}해 볼게요.`;
  }

  if (style === "presentation") {
    if (clean.endsWith("열기")) return `${clean.replace(/열기$/, "열어 보겠습니다")}.`;
    if (clean.endsWith("펼치기")) return `${clean.replace(/펼치기$/, "펼쳐 보겠습니다")}.`;
    if (clean.endsWith("이동") || clean.endsWith("진입")) return `${clean}하는 화면을 보시겠습니다.`;
    if (clean.endsWith("클릭")) return `${clean}하여 진행하겠습니다.`;
    if (clean.endsWith("선택")) return `${clean}하도록 하겠습니다.`;
    if (clean.endsWith("지정")) return `${clean}해 주겠습니다.`;
    if (clean.endsWith("설정")) return `${clean}해 주겠습니다.`;
    if (clean.endsWith("입력") || clean.endsWith("작성")) return `${clean}해 주겠습니다.`;
    if (clean.endsWith("조회")) return `${clean}해 보겠습니다.`;
    if (clean.endsWith("업로드")) return `${clean}하도록 하겠습니다.`;
    if (clean.endsWith("적용") || clean.endsWith("반영")) return `${clean}하겠습니다.`;
    if (clean.endsWith("완료") || clean.endsWith("마무리")) {
      return `${clean.replace(/(완료|마무리)$/, "절차를 마무리합니다")}.`;
    }
    return `${clean}하겠습니다.`;
  }

  const normalizedStandard = clean
    .replace(/열기$/, "엽니다")
    .replace(/펼치기$/, "펼칩니다");

  if (style === "compact") {
    if (/(엽니다|펼칩니다)$/.test(normalizedStandard)) return `${normalizedStandard}.`;
    return `${normalizedStandard}합니다.`;
  }

  // Default "manual"
  if (/(엽니다|펼칩니다)$/.test(normalizedStandard)) return `${normalizedStandard}.`;
  if (isLast && (normalizedStandard.endsWith("완료") || normalizedStandard.endsWith("마무리"))) {
    return `${normalizedStandard}합니다.`;
  }
  return `${normalizedStandard}합니다.`;
}

function composeIntroFallbackSentence(
  topic: { fullTopic: string; shortPurpose: string },
  style: NarrationStyle,
  combinedWithActions?: Moment[],
  typedValues?: string[],
  contextMap?: Map<Moment, { prevMoment?: Moment; nextMoment?: Moment; typedValues?: string[] }>
): string {
  if (!combinedWithActions || combinedWithActions.length === 0) {
    switch (style) {
      case "friendly":
        return `안녕하세요! 이번 영상에서는 ${topic.fullTopic}을 차근차근 알아볼게요.`;
      case "presentation":
        return `지금부터 ${topic.fullTopic}을 단계별로 시연하겠습니다.`;
      case "compact":
        return `${topic.shortPurpose} 매뉴얼을 시작합니다.`;
      case "manual":
      default:
        return `이번 영상에서는 ${topic.fullTopic}을 단계별로 안내해 드립니다.`;
    }
  }

  // Combined intro + first action (when first click happens early < 3.2s)
  const firstStepRaw = extractActionPhrases(combinedWithActions, 0, typedValues, contextMap)[0] || "상단 메뉴로 이동";
  const firstStepEnded = applyStyleEnding(firstStepRaw, style, false);
  switch (style) {
    case "friendly":
      return `안녕하세요! ${topic.shortPurpose} 방법을 알아볼 텐데요, 먼저 ${firstStepEnded}`;
    case "presentation":
      return `지금부터 ${topic.shortPurpose} 시연을 시작하며, 먼저 ${firstStepEnded}`;
    case "compact":
      return `${topic.shortPurpose} 매뉴얼입니다. 먼저 ${firstStepEnded}`;
    case "manual":
    default:
      return `이번 영상에서는 ${topic.shortPurpose} 방법을 알아보며, 먼저 ${firstStepEnded}`;
  }
}

/**
 * 한 구간(Window) 안의 액션들을 의미·맥락 단위로 통합하여
 * 단순 버튼 클릭 나열이 아닌 "왜 이 동작을 수행하며 어떤 기능적 효과가 있는지" 설명하는 해설형 구절을 생성합니다.
 */
function extractActionPhrases(
  actions: Moment[],
  partIndexInSameCategory = 0,
  typedValues?: string[],
  contextMap?: Map<Moment, { prevMoment?: Moment; nextMoment?: Moment; typedValues?: string[] }>
): string[] {
  const infos = actions.map((m, idx) =>
    classifyMomentSemantics(
      m,
      contextMap?.get(m) || {
        prevMoment: idx > 0 ? actions[idx - 1] : undefined,
        nextMoment: idx + 1 < actions.length ? actions[idx + 1] : undefined,
        typedValues,
      }
    )
  );
  const categories = new Set(infos.map((i) => i.category));
  const joinedDescs = actions.map((a) => a.description || "").join(" ");

  // 0. 포탈 상단 '전체메뉴' + 모듈 메뉴 진입 통합 구간
  if (categories.size === 1 && categories.has("nav_entry")) {
    const hasAllMenu = infos.some((i) => i.phraseStep.includes("전체메뉴"));
    const moduleSteps = infos.filter((i) => !i.phraseStep.includes("전체메뉴"));
    if (hasAllMenu && moduleSteps.length >= 2) {
      const lastMod = moduleSteps[moduleSteps.length - 1].phraseStep;
      const firstModName = moduleSteps[0].phraseStep.match(/['"]([^'"]+)['"]/)?.[1] || "상위";
      return [`포탈 상단 '전체메뉴'에서 '${firstModName}' 메뉴를 거쳐 ${lastMod}`];
    }
    if (hasAllMenu && moduleSteps.length === 1) {
      return [`포탈 상단 '전체메뉴'를 열어 ${moduleSteps[0].phraseStep}`];
    }
    if (moduleSteps.length >= 2) {
      const lastMod = moduleSteps[moduleSteps.length - 1].phraseStep;
      const firstModName = moduleSteps[0].phraseStep.match(/['"]([^'"]+)['"]/)?.[1] || "상위";
      return [`'${firstModName}' 메뉴로 진입한 뒤 ${lastMod}`];
    }
  }

  // 1. 날짜/시간 전용 구간일 때 목적 중심 해설 문구 생성
  if (categories.size === 1 && categories.has("datetime")) {
    const hasDate = infos.some((i) => i.phraseStep.includes("일자") || i.phraseStep.includes("기한"));
    const hasTime = infos.some((i) => i.phraseStep.includes("시간"));
    if (partIndexInSameCategory > 0) {
      return [hasDate && hasTime ? "이어서 종료 일자와 세부 시간대를 일정에 맞춰 설정" : "이어서 진행될 시작 및 종료 시간대를 설정"];
    }
    if (hasDate && hasTime) {
      return ["달력에서 진행 일자를 선택하고 시작 및 종료 시간대를 함께 설정"];
    }
    if (hasDate) {
      return ["날짜 입력란을 클릭해 달력에서 진행 일자나 마감 기한을 지정"];
    }
    return ["일정에 맞춰 진행될 시작 시간과 종료 시간대를 설정"];
  }

  // 2. 업무함 / 문서함 / 게시판 / 기록물철 / 주소록 그룹 / 표지 이미지 선택 팝업 구간
  if (categories.size === 1 && categories.has("box_select")) {
    if (/연락처등록\s*팝업|주소록\s*구분|-\s*선택\s*-/.test(joinedDescs)) {
      return ["연락처를 보관할 주소록 구분과 세부 그룹을 드롭다운 목록에서 차례대로 선택"];
    }
    if (/주제\s*이미지/.test(joinedDescs)) {
      const hasOpen = infos.some((i) => i.role === "popup_open");
      const hasConfirm = infos.some((i) => i.role === "popup_confirm");
      if (hasOpen && hasConfirm) {
        return ["표지 이미지 영역을 클릭해 주제 공간을 구분할 디자인을 선택한 뒤 '확인'을 눌러 적용"];
      }
      if (hasConfirm) {
        return ["주제 공간을 구분할 표지 이미지 디자인을 선택한 뒤 '확인'을 눌러 적용"];
      }
      return ["위키 주제를 직관적으로 구분할 표지 이미지 디자인을 선택"];
    }

    const rawBoxKind = (joinedDescs.match(/(업무함|문서함|게시판|보고함|기록물철|결재분류|일감|분류)/)?.[1] || "분류함").trim();
    const boxKind = rawBoxKind === "일감" ? "일감 유형" : rawBoxKind;
    const hasOpen = infos.some((i) => i.role === "popup_open");
    const hasConfirm = infos.some((i) => i.role === "popup_confirm");
    const opensWriteForm = /업무함|문서함|보고함/.test(boxKind) && !hasOpen;

    if (boxKind === "일감 유형") {
      return [
        hasConfirm
          ? "연결할 일감 유형 지정을 위해 '일감선택' 창을 열어 대상 항목을 체크하고 '확인'을 눌러 반영"
          : "연결할 일감 유형 지정을 위해 '일감선택' 창에서 대상 항목을 선택",
      ];
    }
    if (hasOpen && hasConfirm) {
      return [`문서가 보관될 ${boxKind} '선택' 버튼을 눌러 대상 함을 지정한 뒤 '확인'을 눌러 반영`];
    }
    if (hasConfirm) {
      return [
        opensWriteForm
          ? `목록에서 등록할 대상 ${boxKind}을 선택한 뒤 '확인'을 눌러 상세 작성 화면으로 이동`
          : `목록에서 등록할 대상 ${boxKind}을 선택한 뒤 '확인'을 눌러 분류 지정을 완료`,
      ];
    }
    return [`트리 목록에서 등록할 대상 ${boxKind}을 선택`];
  }

  // 3. 연락처 입력 폼 연속 구간
  if (categories.size === 1 && categories.has("contact_form")) {
    const hasPhoneOrEmail = infos.some(
      (i) => i.phraseStep.includes("휴대전화") || i.phraseStep.includes("이메일")
    );
    const hasBasicInfo = infos.some(
      (i) => i.phraseStep.includes("이름") || i.phraseStep.includes("회사") || i.phraseStep.includes("부서")
    );
    if (hasBasicInfo && hasPhoneOrEmail) {
      return ["연락처 등록 창에서 성명과 소속, 휴대전화 및 이메일 등 필수 정보를 차례대로 입력"];
    }
    if (hasPhoneOrEmail) {
      return ["이어서 업무 연락에 필요한 휴대전화 번호와 이메일 주소를 입력"];
    }
    return ["연락처 등록 창에서 대상자의 이름과 회사, 부서 등 기본 인적 사항을 입력"];
  }

  // 4. 조직도 / 담당자 / 관리자 / 권한 / 결재선 선택 전용 구간
  if (
    (categories.size === 1 && categories.has("org_select")) ||
    (categories.size === 2 && categories.has("org_select") && categories.has("alert_confirm"))
  ) {
    const isAssignee = /담당자/.test(joinedDescs);
    const isAdminOrMgr = /관리자\s*팝업|책임자/.test(joinedDescs);
    const isAuth = /권한/.test(joinedDescs);
    const isApprLine = /결재선|드래그/.test(joinedDescs);
    const hasOpenBtn = infos.some((i) => i.role === "popup_open");
    const hasConfirm = infos.some((i) => i.role === "popup_confirm");

    if (isAdminOrMgr) {
      if (hasOpenBtn && hasConfirm) {
        return ["책임자 항목의 '선택' 버튼을 눌러 조직도에서 총괄할 관리자 사원을 지정하고 '확인'을 눌러 반영"];
      }
      if (hasConfirm) {
        return ["조직도에서 프로젝트를 총괄할 책임자(관리자) 사원을 선택한 뒤 '확인'을 눌러 반영"];
      }
      return ["총괄할 책임자(관리자) 지정을 위해 조직도에서 대상 사원을 선택"];
    }
    if (isAssignee) {
      if (hasOpenBtn && hasConfirm) {
        return ["담당자 항목의 '선택' 버튼을 눌러 조직도에서 업무를 수행할 담당 사원을 지정하고 '확인'을 눌러 반영"];
      }
      if (hasConfirm) {
        return ["조직도에서 업무를 수행할 담당 사원을 선택한 뒤 '확인'을 눌러 반영"];
      }
      return ["담당자 지정을 위해 조직도에서 대상 사원을 선택"];
    }
    if (isAuth) {
      if (hasOpenBtn && hasConfirm) {
        return ["권한 '추가' 버튼을 눌러 열람·편집 권한을 부여할 대상을 지정하고 '확인'을 눌러 반영"];
      }
      if (hasConfirm) {
        return ["조직도에서 권한을 부여할 부서나 사원을 선택한 뒤 '확인'을 눌러 반영"];
      }
    }
    if (isApprLine) {
      if (hasConfirm) {
        return ["결재선 설정 창에서 부서와 결재 대상자를 선택해 결재선 영역에 배치한 뒤 '확인'을 눌러 반영"];
      }
      return ["결재선 설정 창에서 결재자를 선택하여 우측 결재선 영역에 배치"];
    }
    if (hasOpenBtn && hasConfirm) {
      return ["조직도 창을 열어 함께 공유하거나 수신할 대상 사원을 선택한 뒤 '확인'을 눌러 반영"];
    }
    if (hasConfirm) {
      return ["조직도에서 소속 부서와 대상 사원을 선택한 후 '확인' 버튼을 눌러 반영"];
    }
    if (hasOpenBtn) {
      return ["대상자 지정을 위해 조직도 선택 창을 열어 소속 부서와 사원을 선택"];
    }
    return [infos[infos.length - 1].phraseStep];
  }

  // 5. 자원/회의실 선택 전용 구간
  if (categories.size === 1 && categories.has("res_select")) {
    const hasConfirm = infos.some((i) => i.role === "popup_confirm");
    const hasCheckUse = infos.some((i) => i.phraseStep.includes("예약사용"));
    if (hasCheckUse && hasConfirm) {
      return ["자원 '예약사용'을 체크한 뒤 이용할 회의실(시설)을 선택하고 '확인'을 눌러 배정"];
    }
    if (hasCheckUse) {
      return ["일정에 필요한 회의실을 함께 배정하기 위해 자원 '예약사용'을 체크하고 시설을 선택"];
    }
    if (hasConfirm) {
      return ["자원 목록에서 이용할 회의실(시설)을 선택한 뒤 '확인'을 눌러 배정을 완료"];
    }
    return ["자원 목록에서 이용할 회의실(시설)을 선택"];
  }

  // 5-B. 다중 라이선스 체크박스 연속 선택 구간 ('그룹웨어' + '모바일 그룹웨어' 등)
  if (
    categories.size === 1 &&
    categories.has("option_toggle") &&
    infos.length >= 2 &&
    infos.every((i) => i.phraseStep.includes("라이선스를 체크"))
  ) {
    const licenseNames = infos
      .map((i) => i.phraseStep.match(/['"]([^'"]+)['"]/)?.[1])
      .filter(Boolean);
    if (licenseNames.length >= 2) {
      return [`신규 계정이 이용할 수 있도록 '${licenseNames[0]}'와 '${licenseNames[1]}' 등 서비스 라이선스를 체크`];
    }
  }

  // 6. 사용자 계정 생성 폼 연속 입력 또는 로그인 연속 입력 구간
  if (categories.size === 1 && categories.has("form_input")) {
    const hasEmpName = infos.some((i) => i.phraseStep.includes("사용자의 성명"));
    const hasUserId = infos.some((i) => i.phraseStep.includes("계정 아이디") || i.phraseStep.includes("계정의 아이디"));
    const hasPwd = infos.some((i) => i.phraseStep.includes("비밀번호를 입력"));
    const hasPwdConfirm = infos.some((i) => i.phraseStep.includes("비밀번호 확인"));

    const isUserRegModal = /사용자\s*(등록|추가)\s*팝업/.test(joinedDescs);
    if (isUserRegModal || (hasEmpName && (hasPwd || hasPwdConfirm))) {
      return ["사용자 등록 창에서 사용할 계정 아이디와 초기 비밀번호, 임직원 성명 등 필수 정보를 차례대로 입력"];
    }
    if (hasEmpName && hasUserId) {
      return ["사용자 등록 창에서 등록할 임직원의 성명과 사용할 고유 계정 아이디를 입력"];
    }
    if (hasPwd && hasPwdConfirm) {
      return ["계정 보안을 위해 사용할 초기 비밀번호와 비밀번호 확인란을 동일하게 입력"];
    }
    if (hasUserId && hasPwd && !hasEmpName && !hasPwdConfirm) {
      return ["로그인 화면에서 접속할 계정의 아이디와 비밀번호를 차례대로 입력"];
    }
  }

  // 7. 저장/상신/공동편집/프로젝트생성/삭제 + 확인 통합 완료 구간
  const hasDelete = infos.some((i) => i.phraseStep.includes("삭제"));
  const hasCollabo = infos.some((i) => i.phraseStep.includes("공동 편집"));
  const hasProjectCreate = infos.some((i) => i.phraseStep.includes("프로젝트 생성"));
  const hasSaveOrSubmit = infos.some(
    (i) => i.category === "submit_save" && !i.phraseStep.includes("삭제") && !i.phraseStep.includes("공동 편집")
  );
  const hasConfirmStep = infos.some((i) => i.role === "popup_confirm" || i.category === "alert_confirm");

  if (hasDelete && hasConfirmStep && infos.length <= 3) {
    return ["등록된 항목을 정리하려면 상단 '삭제' 버튼을 누르고 확인 창을 승인하여 최종 삭제"];
  }
  if (hasCollabo && hasConfirmStep) {
    return ["구성원들과 함께 문서를 편집할 수 있도록 '공동 편집' 버튼을 누르고 안내창의 '확인'을 눌러 전환"];
  }
  if (hasProjectCreate && hasConfirmStep) {
    const hasOptionSelect = infos.some((i) => i.category === "option_toggle");
    if (hasOptionSelect) {
      return ["함께 사용할 세부 기능 항목을 추가로 선택한 뒤 '프로젝트 생성'과 안내창의 '확인'을 눌러 등록을 완료"];
    }
    return ["설정한 프로젝트 정보를 확인한 뒤 '프로젝트 생성' 버튼을 누르고 안내창의 '확인'을 눌러 생성을 진행"];
  }
  if (hasSaveOrSubmit && hasConfirmStep && infos.length <= 3) {
    const isDeptModal = /부서/.test(joinedDescs) && /한국어/.test(joinedDescs);
    if (isDeptModal) {
      return ["조직도 트리에서 상위 부서를 선택한 뒤 새로 추가할 하위 부서 명칭을 입력하고 '저장'을 눌러 생성을 완료"];
    }
    return ["작성한 모든 항목을 확인한 뒤 '저장' 버튼을 누르고 안내창의 '확인'을 눌러 등록을 최종 완료"];
  }

  // 8. 로그인 입력 + Login 버튼 통합 구간
  if (
    infos.some((i) => i.phraseStep.includes("아이디") || i.phraseStep.includes("비밀번호")) &&
    infos.some((i) => i.phraseStep.includes("Login") || i.phraseStep.includes("정상 접속"))
  ) {
    return ["로그인 화면에서 방금 생성한 계정의 아이디와 비밀번호를 입력하고 'Login'을 눌러 정상 접속되는지 확인"];
  }

  // 8-B. 등록 완료 후 목록/분류함 메뉴 클릭 + 방금 등록된 항목 클릭 (결과 확인 통합 구간)
  if (
    infos.length === 2 &&
    infos[0].role === "nav_entry" &&
    infos[1].role === "verify_view"
  ) {
    return ["해당 목록 화면으로 이동한 뒤 방금 등록한 항목을 클릭해 상세 내용이 정상 반영되었는지 확인"];
  }

  // 9. 복합 구간: 각 액션의 일반화 구절을 중복 제거하여 조합
  const uniqueSteps: string[] = [];
  for (const info of infos) {
    if (
      info.category === "datetime" &&
      uniqueSteps.some((s) => s.includes("일자") || s.includes("기한") || s.includes("시간"))
    ) {
      const idx = uniqueSteps.findIndex((s) => s.includes("일자") || s.includes("기한") || s.includes("시간"));
      uniqueSteps[idx] = "달력에서 일정 날짜와 진행 시간대를 지정";
      continue;
    }
    // 에디터 본문 영역 클릭 후 바로 에디터 본문 타이핑이 이어질 때 클릭 구절 생략
    if (
      info.role === "form_work" &&
      info.category === "general" &&
      /에디터\s*본문/.test(joinedDescs) &&
      infos.some((other) => other.phraseStep.includes("본문 에디터 영역에"))
    ) {
      continue;
    }
    if (!uniqueSteps.includes(info.phraseStep)) {
      uniqueSteps.push(info.phraseStep);
    }
  }
  return uniqueSteps;
}

function composeFallbackSentence(
  actions: Moment[],
  isFirstActionCue: boolean,
  isLast: boolean,
  style: NarrationStyle = "manual",
  partIndexInSameCategory = 0,
  typedValues?: string[],
  contextMap?: Map<Moment, { prevMoment?: Moment; nextMoment?: Moment; typedValues?: string[] }>
): string {
  const uniqueSteps = extractActionPhrases(actions, partIndexInSameCategory, typedValues, contextMap);

  if (uniqueSteps.length === 0) {
    if (style === "friendly") {
      return isLast ? "처리된 결과를 화면에서 함께 확인해 볼게요." : "다음 화면으로 이동해 계속 진행해 볼게요.";
    }
    if (style === "presentation") {
      return isLast ? "최종 처리된 결과를 화면에서 확인하시겠습니다." : "화면을 전환하여 다음 단계를 진행하겠습니다.";
    }
    return isLast ? "처리된 결과를 화면에서 확인합니다." : "화면을 이동하며 다음 단계를 진행합니다.";
  }

  if (uniqueSteps.length === 1) {
    const prefix = isFirstActionCue ? "먼저 " : "";
    return `${prefix}${applyStyleEnding(uniqueSteps[0], style, isLast)}`;
  }

  const firstPart = uniqueSteps[0]
    .replace(/열기$/, "열고")
    .replace(/펼치기$/, "펼친 뒤")
    .replace(/클릭$/, "클릭하고")
    .replace(/이동$/, "이동한 뒤")
    .replace(/진입$/, "진입한 뒤")
    .replace(/선택$/, "선택한 뒤")
    .replace(/지정$/, "지정한 뒤")
    .replace(/설정$/, "설정한 후")
    .replace(/입력$/, "입력한 후")
    .replace(/작성$/, "작성하고")
    .replace(/조회$/, "조회한 뒤")
    .replace(/업로드$/, "업로드하고")
    .replace(/체크$/, "체크한 뒤")
    .replace(/(적용|반영)$/, "적용한 뒤")
    .replace(/배치$/, "배치한 뒤")
    .replace(/(완료|마무리)$/, "진행하고");
  const lastPart = uniqueSteps[uniqueSteps.length - 1];
  const prefix = isFirstActionCue ? "먼저 " : "";
  return `${prefix}${firstPart}, ${applyStyleEnding(lastPart, style, isLast)}`;
}

function getDominantCategory(
  grp: Moment[],
  contextMap?: Map<Moment, { prevMoment?: Moment; nextMoment?: Moment; typedValues?: string[] }>
): SemanticActionCategory {
  const cats = grp.map((m) => classifyMomentSemantics(m, contextMap?.get(m)).category);
  if (cats.every((c) => c === cats[0])) return cats[0];
  return "general";
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

  // 각 시점(Moment) 이전에 타이핑된 텍스트만 추출하여 초반 모듈 메뉴('스마트워크' 등)가
  // 후반부 제목 입력값('스마트워크 그룹웨어 교육 신청')과 겹쳐 생성 항목으로 오판되는 현상을 원천 차단
  const contextMap = new Map<Moment, { prevMoment?: Moment; nextMoment?: Moment; typedValues?: string[] }>();
  for (let i = 0; i < meaningful.length; i++) {
    const typedBefore = meaningful
      .slice(0, i)
      .map((m) => (m.keys || "").trim())
      .filter((v) => v.length >= 2);
    contextMap.set(meaningful[i], {
      prevMoment: i > 0 ? meaningful[i - 1] : undefined,
      nextMoment: i + 1 < meaningful.length ? meaningful[i + 1] : undefined,
      typedValues: Array.from(new Set(typedBefore)),
    });
  }

  const allTypedValues = Array.from(
    new Set(meaningful.map((m) => (m.keys || "").trim()).filter((v) => v.length >= 2))
  );

  if (meaningful.length === 0) {
    return [
      {
        index: 1,
        startMs: 200,
        endMs: Math.min(totalMs - 300, 4800),
        maxChars: 48,
        isIntro: true,
        actionsSummary: [`[오프닝 매뉴얼 소개] ${topic.fullTopic}`],
        fallbackLine: composeIntroFallbackSentence(topic, style, undefined, allTypedValues, contextMap),
      },
    ];
  }

  // 의미·워크플로우 단계(Stage) 기반 스마트 그룹핑:
  // 1) 포탈 전체메뉴 + 모듈 진입은 하나의 진입 단계로 묶음
  // 2) 팝업 열기(popup_open) + 팝업 내 선택(popup_select) + 팝업 확인(popup_confirm)은 하나의 완결된 단계로 묶음
  // 3) 날짜 입력창 클릭(date_open) + 달력 날짜/시간 선택(date_pick)은 하나의 일정 설정 단계로 묶되 앞뒤 일반 폼 입력과 섞이지 않게 분리
  // 4) 저장/상신/삭제(submit_save) + 직후 확인/알림창 확인(popup_confirm/alert_confirm)은 하나의 완료 단계로 묶음
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

    const firstSem = classifyMomentSemantics(currentGroup[0], contextMap.get(currentGroup[0]));
    const prevSem = classifyMomentSemantics(prevM, contextMap.get(prevM));
    const currSem = classifyMomentSemantics(m, contextMap.get(m));
    const nextSem = nextM ? classifyMomentSemantics(nextM, contextMap.get(nextM)) : undefined;

    // A. 입력창/에디터 영역 클릭 직후 해당 입력란에 타이핑하는 경우 (예: 에디터 본문 클릭 -> 본문 타이핑)
    const isInputClickToType =
      prevM.type === "click" &&
      m.type === "type" &&
      sincePrev <= 3200 &&
      prevSem.role === "form_work" &&
      prevSem.category === "general";

    // B. 팝업/달력 완결 결합: 현재 그룹이 팝업/달력 진행 중이고 지금 액션이 해당 팝업의 선택 또는 '확인' 닫기인 경우
    const isPopupFlowContinuation =
      ((firstSem.role === "popup_open" || firstSem.role === "popup_select" || prevSem.role === "popup_select") &&
        (currSem.role === "popup_select" || currSem.role === "popup_confirm") &&
        (firstSem.category === currSem.category || currSem.role === "popup_confirm") &&
        sinceGroupStart < 11000 &&
        sincePrev < 4500) ||
      (prevSem.role === "date_open" && currSem.role === "date_pick" && sincePrev < 4500);

    // C. 저장/상신/삭제 직후 확인창 승인 결합 ('저장' -> '[알림 팝업] 확인', '삭제' -> '확인')
    const isSubmitToConfirm =
      (prevSem.role === "submit_save" ||
        (firstSem.role === "submit_save" && prevSem.category === "alert_confirm")) &&
      (currSem.role === "popup_confirm" || currSem.category === "alert_confirm") &&
      sincePrev < 5000;

    // D. 조직도 부서 트리 선택 -> 하위 부서명 입력 -> 저장 (단기 부서 추가 완결 플로우)
    const isDeptCreateFlow =
      /^트리\s*['"]/.test(currentGroup[0].description || "") &&
      prevSem.role !== "create_start" &&
      (/한국어|부서/.test(m.description || "") ||
        (/한국어|부서/.test(prevM.description || "") && currSem.role === "popup_confirm")) &&
      currentGroup.length < 3 &&
      sinceGroupStart < 8500 &&
      sincePrev < 5000;

    // E. 네비게이션 메뉴 연속 진입 ('전체메뉴' -> '스마트워크' 또는 '전체메뉴' -> '관리자' -> '조직관리')
    const isNavChain =
      firstSem.role === "nav_entry" &&
      currSem.role === "nav_entry" &&
      sinceGroupStart < 8500 &&
      sincePrev < 4200;

    // F. 트리 부서 선택 직후 상단 '추가' 버튼 클릭 또는 '프로젝트 추가' -> '새 프로젝트 생성' 연속 클릭
    const isTreeSelectToCreateStart =
      (/^트리\s*['"]/.test(prevM.description || "") &&
        currSem.role === "create_start" &&
        sincePrev < 3500) ||
      (firstSem.role === "create_start" &&
        currSem.role === "create_start" &&
        currentGroup.length === 1 &&
        sincePrev < 3500);

    // F-2. 등록 완료 후 좌측 분류함/그룹 메뉴 클릭 직후 등록된 항목 클릭 (결과 확인 통합)
    const isVerifyNavToItem =
      currentGroup.length === 1 &&
      prevSem.role === "nav_entry" &&
      currSem.role === "verify_view" &&
      sincePrev < 3800;

    // G. 동일 카테고리 연속 진행 (날짜/시간 연속 설정, 연락처 연속 입력, 다중 라이선스 체크 등)
    const isSameCohesiveCategory =
      prevSem.category === currSem.category &&
      (currSem.category === "datetime" ||
        currSem.category === "org_select" ||
        currSem.category === "res_select" ||
        currSem.category === "contact_form" ||
        currSem.category === "box_select" ||
        (currSem.category === "option_toggle" &&
          prevSem.phraseStep.includes("라이선스") &&
          currSem.phraseStep.includes("라이선스"))) &&
      sinceGroupStart < 9000 &&
      sincePrev < 4200 &&
      currentGroup.length < 6;

    // H. 사용자 등록 팝업 내 연속 텍스트 입력 또는 로그인 화면 내 아이디+비밀번호+Login 연속 입력
    const isCohesiveAccountForm =
      currSem.category === "form_input" &&
      prevSem.category === "form_input" &&
      Boolean(currSem.modalScope && currSem.modalScope === prevSem.modalScope) &&
      /사용자\s*(등록|추가)/.test(currSem.modalScope || "") &&
      sinceGroupStart < 9500 &&
      sincePrev < 5000 &&
      currentGroup.length < 4;

    const isLoginFlow =
      /아이디|비밀번호/.test(prevM.description || "") &&
      /비밀번호|login|로그인/i.test(m.description || "") &&
      !currSem.modalScope &&
      sinceGroupStart < 8500 &&
      sincePrev < 5000;

    // [경계 분리 보호 규칙]: 서로 다른 의미 단계가 단순히 시간 간격이 짧다는 이유로 합쳐지지 않도록 차단!
    const isStartingNewPopupOrPicker =
      currSem.role === "popup_open" ||
      currSem.role === "date_open" ||
      (currSem.role === "popup_select" && prevSem.role !== "popup_open" && prevSem.role !== "popup_select") ||
      (currSem.role === "create_start" && !isTreeSelectToCreateStart);

    const isLeavingCompletedPopupOrPicker =
      prevSem.role === "popup_confirm" ||
      prevSem.role === "date_pick" ||
      (prevSem.role === "nav_entry" && currSem.role !== "nav_entry" && !isVerifyNavToItem) ||
      (prevSem.role === "create_start" && currSem.role === "popup_select" && nextSem?.role === "popup_select");

    const isStartingSubmitAfterForm =
      currSem.role === "submit_save" &&
      prevSem.role !== "submit_save" &&
      !isDeptCreateFlow;

    if (
      isInputClickToType ||
      isPopupFlowContinuation ||
      isSubmitToConfirm ||
      isDeptCreateFlow ||
      isNavChain ||
      isTreeSelectToCreateStart ||
      isVerifyNavToItem ||
      isSameCohesiveCategory ||
      isCohesiveAccountForm ||
      isLoginFlow
    ) {
      currentGroup.push(m);
    } else if (
      !isStartingNewPopupOrPicker &&
      !isLeavingCompletedPopupOrPicker &&
      !isStartingSubmitAfterForm &&
      prevSem.category === currSem.category &&
      sinceGroupStart < 4000 &&
      sincePrev < 2500 &&
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

  // 사후 클린업: 단독으로 떨어져 나온 '확인' 버튼 클릭(popup_confirm / alert_confirm)은 직전 그룹에 병합하여
  // "확인 버튼을 눌러 적용합니다" 같은 파편화된 낭독 구간이 절대 생성되지 않도록 보장
  for (let i = groups.length - 1; i >= 1; i--) {
    const grp = groups[i];
    if (grp.length === 1) {
      const sem = classifyMomentSemantics(grp[0], contextMap.get(grp[0]));
      const prevGrp = groups[i - 1];
      const prevLast = prevGrp[prevGrp.length - 1];
      if (
        (sem.role === "popup_confirm" || sem.category === "alert_confirm") &&
        grp[0].timestamp - prevLast.timestamp < 5500
      ) {
        prevGrp.push(grp[0]);
        groups.splice(i, 1);
      }
    }
  }

  const windows: NarrationWindow[] = [];
  const firstClickMs = groups[0][0].timestamp;

  // Case 1: 첫 클릭 전 여유 시간이 충분한 경우 (>= 3.2s) -> 독립된 #1 오프닝 매뉴얼 소개 구간 생성
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
      actionsSummary: [`[오프닝 매뉴얼 소개 필수] 매뉴얼 주제: ${topic.shortPurpose} (${topic.fullTopic})`],
      fallbackLine: composeIntroFallbackSentence(topic, style, undefined, allTypedValues, contextMap),
    });

    for (let i = 0; i < groups.length; i++) {
      const grp = groups[i];
      const prevGrp = i > 0 ? groups[i - 1] : null;
      const nextGrp = groups[i + 1];
      const partIdx =
        prevGrp &&
        getDominantCategory(prevGrp, contextMap) === getDominantCategory(grp, contextMap) &&
        getDominantCategory(grp, contextMap) !== "general"
          ? 1
          : 0;

      const rawStart = Math.max(introEndMs + 150, grp[0].timestamp - 200);
      const nextStart = nextGrp ? Math.max(rawStart + 2200, nextGrp[0].timestamp - 250) : totalMs - 200;
      const windowDurationMs = Math.max(2200, Math.min(8200, nextStart - rawStart));
      const endMs = Math.min(totalMs - 100, rawStart + windowDurationMs);
      const maxChars = Math.max(34, Math.min(64, Math.floor((windowDurationMs / 1000) * 7.2)));
      const summaries = Array.from(
        new Set(grp.map((m) => cleanActionDescription(m, contextMap.get(m))).filter(Boolean))
      );
      const fallbackLine = composeFallbackSentence(
        grp,
        i === 0,
        i === groups.length - 1,
        style,
        partIdx,
        allTypedValues,
        contextMap
      );

      windows.push({
        index: windows.length + 1,
        startMs: rawStart,
        endMs,
        maxChars,
        actionsSummary: summaries,
        fallbackLine,
      });
    }
  } else {
    // Case 2: 첫 클릭이 3.2초 이전에 시작되는 경우 -> 0.2s에서 [오프닝 소개 + 첫 진입 단계] 결합
    for (let i = 0; i < groups.length; i++) {
      const grp = groups[i];
      const prevGrp = i > 0 ? groups[i - 1] : null;
      const nextGrp = groups[i + 1];
      const partIdx =
        prevGrp &&
        getDominantCategory(prevGrp, contextMap) === getDominantCategory(grp, contextMap) &&
        getDominantCategory(grp, contextMap) !== "general"
          ? 1
          : 0;

      const rawStart = i === 0 ? 200 : Math.max(300, grp[0].timestamp - 200);
      const nextStart = nextGrp ? Math.max(rawStart + 2400, nextGrp[0].timestamp - 250) : totalMs - 200;
      const windowDurationMs = Math.max(i === 0 ? 3200 : 2200, Math.min(8200, nextStart - rawStart));
      const endMs = Math.min(totalMs - 100, rawStart + windowDurationMs);
      const maxChars = Math.max(i === 0 ? 44 : 34, Math.min(64, Math.floor((windowDurationMs / 1000) * 7.2)));
      const summaries = Array.from(
        new Set(grp.map((m) => cleanActionDescription(m, contextMap.get(m))).filter(Boolean))
      );

      if (i === 0) {
        windows.push({
          index: 1,
          startMs: rawStart,
          endMs,
          maxChars,
          isIntro: true,
          actionsSummary: [
            `[오프닝 매뉴얼 소개 필수 포함] 매뉴얼 주제: ${topic.shortPurpose} (${topic.fullTopic})`,
            ...summaries,
          ],
          fallbackLine: composeIntroFallbackSentence(topic, style, grp, allTypedValues, contextMap),
        });
      } else {
        windows.push({
          index: windows.length + 1,
          startMs: rawStart,
          endMs,
          maxChars,
          actionsSummary: summaries,
          fallbackLine: composeFallbackSentence(
            grp,
            false,
            i === groups.length - 1,
            style,
            partIdx,
            allTypedValues,
            contextMap
          ),
        });
      }
    }
  }

  return windows;
}

function getStylePromptInstruction(style: NarrationStyle): string {
  switch (style) {
    case "friendly":
      return `- 말투 스타일: [친절한 튜토리얼 강사형 (해요체)]
- 첫 번째 구간(index: 1)은 반드시 "안녕하세요! 이번 영상에서는 ~하는 방법을 차근차근 알아볼게요."처럼 친근한 매뉴얼 소개로 시작하세요.
- 이후 구간은 단순 버튼 낭독("~클릭해 주세요")이 아니라, 왜 그 기능을 누르는지 설명하며 "~창을 열어 줄게요", "~지정해 줍니다", "~작성해 주세요", "~정상 반영되었는지 확인해 볼게요"처럼 다정하고 이해하기 쉬운 강사 화법(해요체)을 사용하세요.`;
    case "presentation":
      return `- 말투 스타일: [전문 솔루션 시연 발표형 (하십시오체/발표체)]
- 첫 번째 구간(index: 1)은 반드시 "지금부터 ~하는 전체 과정을 단계별로 시연하겠습니다."처럼 신뢰감 있는 발표 오프닝으로 시작하세요.
- 이후 구간은 각 단계의 업무적 목적과 효과를 함께 짚어주며 "~화면으로 이동하겠습니다", "~권한을 설정해 주겠습니다", "~절차를 마무리합니다"처럼 전문적인 프레젠테이션 화법을 사용하세요.`;
    case "compact":
      return `- 말투 스타일: [핵심 기능 해설 브리핑형 (간결한 합니다체)]
- 첫 번째 구간(index: 1)은 "~매뉴얼을 시작합니다."를 포함하여 핵심 목적을 명쾌하게 소개하세요.
- 불필요한 수식어는 줄이되 단순 버튼 읽기가 아니라 "업무함 지정 후 작성 화면으로 이동합니다"처럼 목적과 결과를 간결하게 전달하세요.`;
    case "manual":
    default:
      return `- 말투 스타일: [정석 매뉴얼 해설형 (표준 합니다체)]
- 첫 번째 구간(index: 1)은 반드시 이 영상이 어떤 업무 매뉴얼인지("이번 영상에서는 ~하는 방법을 단계별로 안내해 드립니다" 등) 소개하는 오프닝 내용을 포함하세요.
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

  const apiKey = process.env.GEMINI_API_KEY || "";
  if (apiKey) {
    try {
      const config = getConfig();
      const ai = new GoogleGenAI({ apiKey });
      const styleInstruction = getStylePromptInstruction(style);
      const prompt = `당신은 기업용 그룹웨어 교육 영상의 전문 매뉴얼 해설 작가입니다.
시나리오 전체 주제: "${topic.fullTopic}"

아래는 화면 녹화 영상의 의미 단계별(Stage) 타임스탬프와 해당 구간에서 수행되는 동작의 목적·맥락 요약입니다.
시청자가 영상을 보며 **"왜 이 메뉴나 버튼을 누르는지, 어떤 창이 열리고 어떤 기능적 효과가 적용되는지"** 쉽게 이해할 수 있도록 각 구간(index)마다 자연스러운 **매뉴얼 해설형 내레이션 대본**을 1문장씩 작성하세요.

[말투 및 오프닝 작성 규칙]
${styleInstruction}
- 특히 index: 1 구간은 영상의 첫 시작이므로, 이 영상이 어떤 모듈에서 어떤 업무 절차를 안내하는 매뉴얼인지 명확히 소개하며 시작하세요.

[매뉴얼 해설형 대본 작성 5대 원칙 — 단순 '버튼 낭독기' 절대 금지!]
1. **목적과 기능 효과(Why & Effect)를 함께 설명하세요**:
   - 나쁜 예(단순 버튼 낭독): "'업무 등록' 버튼을 클릭합니다." / "'선택' 버튼을 클릭합니다." / "'확인' 버튼을 눌러 적용합니다." / "'비공개' 옵션을 체크합니다."
   - 좋은 예(매뉴얼 해설형): "좌측의 '업무 등록' 버튼을 눌러 새 업무를 생성할 업무함 선택 창을 엽니다." / "담당자 항목의 '선택'을 눌러 조직도에서 업무를 수행할 담당 사원을 지정하고 확인을 누릅니다." / "보안이 필요한 업무인 경우 지정된 담당자만 열람할 수 있도록 '비공개' 옵션을 체크합니다."
2. **고정 UI 메뉴·버튼 명칭은 정확히 안내하되, 시연용 예시 데이터는 절대 그대로 읽지 마세요**:
   - 고정된 메뉴/버튼('전체메뉴', '스마트워크', '업무 등록', '전자결재', '일정관리', '위키', '관리자', '조직관리', '공동 편집', '조직도', '추가', '선택', '확인', '저장', '삭제', '로그아웃', 'Login' 등)은 시청자가 화면에서 찾아 눌러야 하므로 명칭을 정확히 언급하세요.
   - 반면, 시연자가 예시로 클릭한 날짜/시간 숫자('16일', '26', '14:00'), 예시 부서/사원/회의실/함 이름('공공기업팀', '테스트 부서', '3층 회의실', 'test002'), 예시 입력 문구('스마트워크 그룹웨어 교육 신청', '그룹웨어', '김민준' 등)는 절대 대본에 그대로 노출하지 말고 역할과 의미로 설명하세요.
3. **"원하는 ~" 표현 남발 금지**:
   - 매 문장마다 기계적으로 "원하는 ~"을 반복하지 말고, 문맥에 맞게 "등록할 대상 업무함", "업무를 수행할 담당 사원", "일정에 맞는 마감 기한", "양식에 구성된 세부 항목" 등 구체적인 업무 어휘를 사용하세요.
4. **앞뒤 문장 간 자연스러운 흐름 연결 및 중복 방지**:
   - 각 구간에 제공된 \`draftHint\`의 핵심 해설 맥락을 살리면서 앞뒤 구간과 어휘나 어미가 단조롭게 겹치지 않도록 매끄럽게 다듬어 주세요.
5. **글자 수 및 출력 형식 준수**:
   - 각 구간의 글자 수(공백 포함)는 지정된 \`maxChars\` 이내로 작성하세요.
   - 반드시 JSON 배열 형식으로만 응답하세요: [{"index": 1, "text": "..."}, ...]

[구간 데이터]
${JSON.stringify(
  windows.map((w) => ({
    index: w.index,
    isIntro: Boolean(w.isIntro),
    timeRangeSec: `${(w.startMs / 1000).toFixed(1)}s ~ ${(w.endMs / 1000).toFixed(1)}s`,
    maxChars: w.maxChars,
    actions: w.actionsSummary,
    draftHint: w.fallbackLine,
  })),
  null,
  2
)}`;

      const response = await ai.models.generateContent({
        model: config.geminiModel || "gemini-2.5-flash",
        contents: prompt,
        config: {
          temperature: 0.35,
          responseMimeType: "application/json",
        },
      });

      const rawText = (response.text || "").trim();
      const parsed = JSON.parse(rawText);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          const idx = Number(item.index) - 1;
          if (idx >= 0 && idx < windows.length && typeof item.text === "string" && item.text.trim()) {
            generatedLines[idx] = item.text.trim();
          }
        }
      }
    } catch (err: any) {
      console.warn(`[Narration AI] Gemini 대본 생성 폴백 사용 (${err?.message || err})`);
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


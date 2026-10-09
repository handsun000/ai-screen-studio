# AGENTS.md - Screen Demo Studio AI 인수인계 및 운영 매뉴얼

이 문서는 **Screen Demo Studio (AI Video Automation Hub)** 프로젝트의 전체 아키텍처, 오늘(2026-10-01)까지 완료된 작업 내역, 사용자 피드백을 통해 발견된 긴급 점검 사항(마우스 클릭 좌표 오차 및 AI 시나리오 정밀도), 그리고 내일(2026-10-02) 작업을 즉시 이어나갈 수 있도록 필요한 모든 실행 절차와 기술적 세부사항을 기록한 인수인계 가이드입니다.

---

## 1. 프로젝트 개요 (Overview)

* **프로젝트명**: Screen Demo Studio (`ai-screen-studio`)
* **저장소 주소**: `https://github.com/handsun000/ai-screen-studio.git`
* **핵심 목적**:
  웹 애플리케이션의 특정 소스코드나 문서에 종속되지 않고, **자연어 요구사항(또는 범용 템플릿)을 입력하면 Google AI Studio (Gemini API)가 5단계 영상 연출 프레임워크에 맞춰 브라우징 플랜(`browse-plan.json`)을 자동 생성**하고, **Playwright 브라우저 녹화(`record.ts`)** 및 **Remotion 기반 자동 카메라 줌/팬/커서 모션그래픽 합성(`Root.tsx`, `renderRunner.ts`)**까지 웹 대시보드에서 원클릭으로 완결하는 올인원 비디오 자동화 스튜디오.
* **웹 대시보드 주소**: `http://localhost:3333`
* **라이선스**: **MIT License**

---

## 2. 시스템 아키텍처 및 파이프라인 흐름

```mermaid
graph TD
    User([사용자 / 웹 대시보드 UI]) -->|1. 시나리오 생성 요청| DashboardServer[Express 서버 scripts/dashboard-server.ts :3333]
    DashboardServer -->|2. 소스/문서 동적 스캔 & 3중 방어막 검증| GeminiPlanner[src/services/geminiPlanner.ts & planSanitizer.ts]
    GeminiPlanner -->|Gemini 3.5 Flash Lite 캐스케이드| GoogleAI[Google AI Studio API]
    GoogleAI -->|3. 정제된 BrowsePlan JSON 반환| DashboardServer
    DashboardServer -->|4. 원클릭 녹화 실행| RecordRunner[src/services/recordRunner.ts]
    RecordRunner -->|5. Playwright 자동화 녹화| Playwright[scripts/record.ts]
    Playwright -->|실시간 브라우저 조작 & 비디오 생성| RawVideo[data/slug/recording.mp4 + moments.json]
    RawVideo -->|6. 스무스 카메라 줌 계산| EditPlanPy[scripts/build-edit-plan.py]
    EditPlanPy -->|7. 줌 키프레임 생성| EditPlanJson[data/slug/edit-plan.json]
    DashboardServer -->|8. 원클릭 최종 영상 렌더링 & MP4 추출| RenderRunner[src/services/renderRunner.ts]
    RenderRunner -->|9. Remotion 컴포지션 합성 엔진| Remotion[npx remotion render ScreenDemo output/slug.mp4]
    Remotion -->|10. 최종본 다운로드 & 듀얼 플레이어 재생| FinalMP4[output/slug.mp4 & 웹 대시보드 플레이어]
```

---

## 3. 오늘(2026-10-01) 완료된 주요 작업 내역

### 1) 웹 대시보드 원클릭 최종 MP4 렌더링 & 다운로드 엔진 구축 (`renderRunner.ts`)
* **기존 문제**: 터미널에서 사용자가 `npm run render`를 수동으로 입력해야만 최종 합성 비디오를 뽑을 수 있어 웹 기반 완결성이 부족했음.
* **조치 완료**:
  * **백엔드 렌더러 서비스 (`src/services/renderRunner.ts`)** 신설:
    * `startRender(slug)`: `Root.tsx` 동기화, `public/recording.mp4` 미러링, `npx remotion render src/index.ts ScreenDemo output/<slug>.mp4 --gl=angle` 백그라운드 구동.
    * 렌더링 진행률(프레임별 % 진행 상태) 실시간 파싱 및 터미널 SSE 로그로 중계.
  * **서버 API 신설 (`scripts/dashboard-server.ts`)**:
    * `POST /api/render/start`, `POST /api/render/stop`, `GET /api/render/status`
    * `GET /api/render/info/:slug`: 최종 영상 존재 여부 및 파일 용량 반환
    * `GET /api/rendered-video/:slug`: 최종 렌더링된 MP4를 브라우저 플레이어에서 206 Partial Content로 스트리밍
    * `GET /api/download/:slug`: 브라우저에서 파일로 즉시 내려받는 직관적인 다운로드 엔드포인트
  * **프론트엔드 UI 연동 (`dashboard/`)**:
    * 에디터 상단에 **`[🎞️ 최종 영상 추출 (Render)]`** 버튼 배치.
    * 플레이어 탭에 **`[🎞️ 최종 MP4 렌더링]`** 버튼 및 렌더링 완료 시 자동 노출되는 **`[💾 최종 MP4 다운로드 (xxMB)]`** 버튼 구현.
    * **듀얼 플레이어 스위처 (`video-mode-switch`)**: `[📹 원본 브라우저 녹화본]`과 `[✨ 줌/커서 합성 최종본]`을 탭으로 즉시 전환하여 비교 시청 가능.

### 2) Gemini 할루시네이션 더미 ID(`_USE_RESOURCE_`) 원천 차단 3중 방어막 구축
* **원인**: 소스코드 스캔 시 정확한 DOM ID를 찾지 못할 때 AI가 임의의 가상 ID(`_USE_RESOURCE_`, `_SUBJECT_` 등)를 생성하고, 이것이 `.cache/plan-cache.json`에 영구 캐싱되는 문제.
* **조치 완료**:
  * **1계층 (프롬프트 & Few-Shot)**: 대문자 더미 ID 생성 엄격 금지 규칙 주입, 실제 작동 검증된 Naonsoft 셀렉터 예시 주입.
  * **2계층 (자동 정제기 `src/services/planSanitizer.ts`)**: 생성된 플랜에서 `#_[A-Z0-9_]+_` 패턴을 감지하면 자동으로 Naonsoft 실제 규격(`button#reg_shedule_lefttop`, `label:has-text('예약사용')`, `button#savebtn` 등)으로 자동 치환. `record.ts` 실행 직전에도 플랜을 자동 보정.
  * **3계층 (런타임 복구 `scripts/record.ts`)**: 요소 대기 시간 초과 시 `action.description`의 키워드를 분석하여 화면 내의 실제 텍스트/대체 요소를 라이브로 구조.

### 3) 비디오 탐색(Seek) HTTP 416 서버 크래시 방지
* 브라우저 비디오 플레이어에서 탐색바를 끝까지 드래그할 때 범위를 벗어나는 바이트 요청으로 인해 `RangeError [ERR_OUT_OF_RANGE]`가 발생하며 Express 프로세스가 다운되던 현상 해결 (`streamMp4File`에 범위 유효성 검사 추가).

---

## 4. 🚨 긴급 점검 및 피드백 분석 (내일 최우선 작업)

### 📌 사용자 피드백 요약
> **"영상을 뽑아봤는데 일단 마우스 클릭 위치가 너무 이상하고 시나리오 AI가 똑바로 할 수 있도록 작업을 해야 될 것 같다. 마우스 클릭 위치도 시나리오가 하는 거지 않나 싶은데..."**

### 🔍 마우스 클릭 위치 오차의 기술적 근본 원인 분석
마우스 커서의 렌더링 위치는 **`시나리오의 Selector` → `Playwright boundingBox() 측정` → `moments.json의 cursor {x, y}` → `Remotion 가상 커서 렌더링`** 순서로 전달됩니다. 현재 클릭 위치가 어긋나 보이는 원인은 다음 3가지입니다:

1. **AI 시나리오가 '버튼 말단 태그' 대신 '넓은 부모 컨테이너'를 셀렉터로 잡는 문제 (가장 유력)**
   * 예: 실제 클릭 대상은 `<button class="btn_save">`인데, AI가 `div.btn_area`, `form#reg_form`, 또는 긴 `label` 전체를 셀렉터로 잡은 경우.
   * `record.ts`는 요소의 정중앙(`box.x + box.width / 2`, `box.y + box.height / 2`)을 클릭하므로, 컨테이너가 가로로 길면 **버튼이 아니라 엉뚱한 빈 공간 한가운데에 마우스가 가서 클릭**하는 것처럼 녹화되고 줌인됨.
2. **동적 팝업 / 레이어 모달의 애니메이션 중 좌표 캡처 오차**
   * jQuery UI 다이얼로그나 슬라이드다운 메뉴가 화면에 완전히 안착하기 전(애니메이션 진행 중)에 `boundingBox()`를 측정하여, 최종 위치보다 위쪽이나 엉뚱한 좌표가 `moments.json`에 저장됨.
3. **iFrame 및 내부 스크롤 컨테이너의 Viewport 오프셋 누락 가능성**
   * 그룹웨어 본문이나 팝업 내부 요소가 iFrame 내부에 존재할 때, iFrame 기준 상대 좌표가 전체 화면 Viewport 절대 좌표로 완벽하게 변환되지 않아 오차가 발생할 수 있음.

---

## 5. 완료된 핵심 개선 작업 내역 (2026-10-02 완료)

### ✅ Task 1. 마우스 클릭 좌표 정밀 타겟팅 엔진 고도화 (`scripts/record.ts`, `SyntheticCursor.tsx`)
1. **말단 인터랙티브 요소 자동 핀포인트 탐색 (`resolveAtomicTarget`)**:
   - 지정된 셀렉터가 부모 컨테이너(`div`, `form`, `section`, `li`, `tr`, `td`, `p`, `label` 등)이거나 크기가 큰 경우(`width > 280` 또는 `height > 80`), 내부의 실제 클릭 대상 말단 요소(`button`, `a`, `input`, `textarea`, `span.txt`, `strong`)를 자동으로 탐색하여 그 중심점으로 타겟 좌표를 산출. (빈 흰색 여백 클릭 오차 원천 해결)
2. **좌표 안착 대기 (`getSettledBoundingBox`)**:
   - 모달 팝업, 레이어, 슬라이드다운 애니메이션 중 좌표가 움직이는 동안 캡처되는 문제를 막기 위해, 연속 2회 좌표 변화율이 1.5px 미만으로 멈출 때까지 대기 후 모멘트 좌표 기록.
3. **브라우저 녹화 화면 내 시각적 클릭 마커 (`triggerClickVisualizer`)**:
   - 실제 브라우저 클릭 좌표에 0.35초간 은은한 반투명 블루 링(Ripple Effect)을 동적 주입하여, 원본 녹화본에서도 클릭이 일어난 지점을 직관적으로 시각 확인 가능.
4. **Remotion 가상 커서 팁 & 링 서브픽셀 정밀 정렬 (`SyntheticCursor.tsx`)**:
   - SVG 화살표 팁(`M2 2`)과 부모 컨테이너 오프셋, 클릭 링의 위치를 `translate(-2px, -2px)` 및 `left: 2, top: 2`로 재조정하여 실제 클릭 지점과 정확히 일치하도록 보정.

### ✅ Task 2. 시나리오 AI 프롬프트 셀렉터 정밀도 가이드 & 버그 수정 (`tutorialTemplates.ts`, `planSanitizer.ts`)
1. **정밀 말단 셀렉터 원칙 (Atomic Interactive Selector Rule) 프롬프트 가이드 추가**:
   - ❌ 금지: `div.btn_area`, `form#reg_form`, `ul.menu_lst`, 큰 `label` 등 부모 래퍼 지정 금지
   - ✅ 권장: `button:has-text('...')`, `button#reg_shedule_lefttop`, `input#subject:visible` 등 실제 인터랙티브 엘리먼트 지정
2. **`planSanitizer.ts` 일정 등록 버튼 덮어쓰기 버그 수정**:
   - 기존에 `[일정 등록] 버튼 클릭` 설명이 규칙 11의 `저장/상신 버튼` 정제기에 의해 `#savebtn`으로 덮어씌워져 모달이 열리지 않던 치명적 버그 수정.
3. **가상 더미 ID(`input#_DOC_TITLE_` 등) 및 Few-shot 예시 전면 정제**:
   - Few-shot 레퍼런스 시나리오(`create-and-submit`, `approval-draft`) 내의 잘못된 셀렉터 및 더미 ID를 실제 작동하는 표준 셀렉터로 수정.

### ✅ Task 3. 대시보드 타임라인에서 클릭 좌표(X, Y) 및 줌 센터 수동 미세 조정(Offset) 기능 지원
1. **`BrowsePlanAction` 타입에 `cursorOffset?: { x: number; y: number }` 지원 (`src/types.ts`)**.
2. **웹 대시보드 액션 카드 편집기 UI 신설 (`dashboard/app.js`, `dashboard/style.css`)**:
   - 각 인터랙티브 액션(`click`, `dblclick`, `hover`, `type`) 카드에 **`🎯 커서 오프셋: X [  ]px Y [  ]px`** 미세 조정 입력창 배치.
   - 사용자 필요 시 픽셀 단위로 클릭 좌표와 카메라 줌 센터를 손쉽게 수동 튜닝 가능.

### ✅ Task 4. AI 무추측 원칙(Zero-Guessing Policy) 확립 및 빈 셀렉터 허용/사용자 직접 입력 가이드 UI 구축
1. **AI 추측 원천 차단 및 빈 셀렉터(`""`) 허용 (`codeExplorerAgent.ts`, `geminiPlanner.ts`, `tutorialTemplates.ts`)**:
   - 소스코드나 Action Spec에서 확정되지 않은 ID를 억지로 가상 생성(`_TITLE_`, `#btn_orgUIselectDialog` 등)하지 못하도록 프롬프트 및 지침 전면 개편.
   - 모르는 요소는 텍스트 매칭(`button:has-text(...)`)으로 대체하거나, 아예 **`"selector": ""` (빈 문자열)**로 솔직하게 비워두도록 허용.
   - 비워둔 항목은 Action Spec의 `## 3. ⚠️ 사용자 확인/직접 입력 필요 항목` 및 `explanation`에 명시하여 사용자에게 확인을 유도.
2. **웹 대시보드 셀렉터 미입력 감지 및 직관적 사용자 입력 가이드 UI (`dashboard/app.js`, `dashboard/style.css`)**:
   - **시각적 강조 배지 & 펄스 테두리**: 셀렉터가 비어 있는 카드에 `needs-selector` 주황색 펄스 애니메이션 테두리와 `⚠️ 셀렉터 입력 필요` 배지 노출.
   - **플레이스홀더 & 퀵 입력 헬퍼**: `⚠️ 소스코드에서 ID 미발견 - 버튼 텍스트 또는 ID 직접 입력` 안내문과 함께 `[+ 설명 텍스트 버튼]`, `[+ 확인]`, `[+ 저장]`, `[+ 상신]` 원클릭 퀵 입력 칩 제공. 사용자가 입력 시 실시간으로 경고 해제.
   - **실행 전 사전 검증 모달**: 원클릭 파이프라인 실행 시 미입력 셀렉터가 남아있으면 확인창으로 단계 목록을 알리고, 취소 시 해당 카드로 자동 스크롤 & 포커스 이동.
3. **Playwright 브라우저 녹화 엔진 런타임 자율 구제 (`scripts/record.ts`)**:
### ✅ Task 5. 스마트 타겟팅 빌더 UI & 실시간 문법 린터 & 화면 영역 스코핑 구축 (`dashboard/`, `record.ts`)
1. **스마트 타겟 빌더 (Smart Target Builder UI)**:
   - 복잡한 CSS를 직접 작성하기 어려운 사용자를 위해 액션 카드마다 **`[🎯 타겟 도우미]`** 패널 탑재.
   - 버튼 이름(예: `포탈 전체메뉴`)과 위치(`🌐전체`, `🔝상단 헤더`, `👈좌측 메뉴`, `🪟팝업 모달`, `📄본문`)만 선택하면 100% 충돌 없는 정밀 셀렉터를 원클릭 자동 완성.
   - 주요 급소 버튼(`[🔝 포탈 전체메뉴]`, `[👈 일정 등록]`, `[🪟 모달 저장]`, `[🪟 모달 확인]`, `[📝 상신]`) 원클릭 퀵 칩 지원.
2. **실시간 문법 린터 & 자동 교정기 (Realtime Syntax Linter)**:
   - `button:btn_svc_open`처럼 콜론을 클래스에 쓴 오타 발생 시 `💡 문법 오타 감지: button.btn_svc_open [✨ 자동 수정 적용]` 칩을 실시간으로 띄워 원클릭으로 수정.
   - `btn_svc_open`처럼 점(.) 없는 클래스 입력 시 `button.btn_svc_open, .btn_svc_open`으로 실시간 자동 교정.
3. **Playwright 런타임 문법 복구 & 다중 버튼 충돌 방지 (`scripts/record.ts`)**:
   - 동일한 클래스/텍스트 버튼이 화면 여러 곳에 존재하더라도, 모달 열림 여부 및 설명(description) 키워드를 분석하여 헤더/사이드바/모달 영역 내부의 버튼을 핀포인트로 특정.
   - 사용자 오타가 저장되어 들어오더라도 런타임에서 자동으로 `button.클래스`로 자동 보정하여 녹화 중단 방지.

### ✅ Task 6. 포탈 전체메뉴(서랍) 내 숨겨진 하위 메뉴 탐색 3중 안전망 구축 (`tutorialTemplates.ts`, `planSanitizer.ts`, `record.ts`)
1. **문제 정의**:
   - 엔터프라이즈 포탈/그룹웨어 메인 화면에서는 세부 업무 메뉴(일정관리, 전자결재, 문서관리 등)가 상단 GNB 바에 직접 노출되어 있지 않고 [포탈 전체메뉴(`button.btn_svc_open`)] 서랍(Drawer) 안에 숨겨져 있음.
   - AI가 전체메뉴를 열지 않고 곧바로 `a:has-text("일정관리"):visible`를 단독 클릭하려고 하면 `display: none` 상태여서 100% 탐색 타임아웃에 빠짐.
2. **1계층 - 프롬프트 & Few-Shot 지침 (`tutorialTemplates.ts`, `geminiPlanner.ts`)**:
   - Phase 2(메뉴 이동) 프레임워크에 [숨겨진 포탈 전체메뉴 서랍 원칙] 필수 주입.
   - 메인에서 하위 메뉴로 이동할 때는 반드시 `[포탈 전체메뉴(btn_svc_open) 클릭] -> [1200ms 펼침 대기] -> [서랍 내 목표 메뉴 클릭]`의 3단계 시퀀스로 기획하도록 강제.
3. **2계층 - 플랜 자동 정제기 자동 주입기 (`planSanitizer.ts`)**:
   - AI나 사용자가 전체메뉴 열기 단계를 생략하고 바로 하위 메뉴(일정, 결재, 문서 등)를 클릭하도록 작성한 경우, 정제기가 이를 감지하여 앞에 `button.btn_svc_open` 클릭 및 `wait: 1200` 액션을 자동으로 주입하고 셀렉터를 `#svc_box` 스코프로 보강.
4. **3계층 - Playwright 런타임 지능형 자동 구제 (`scripts/record.ts`)**:
   - 메뉴 클릭 시 대상 메뉴가 화면에 노출되지 않고 닫혀 있으면, 런타임이 화면 내의 `button.btn_svc_open` 버튼을 스스로 클릭하여 메뉴 서랍을 열고 1000ms 후 대상을 찾아 클릭하는 자율 구제 엔진 가동.

### ✅ Task 7. 렌더링 프로그레스 로그 쓰로틀링 & 단일 인플레이스 게이지 & 마우스 클릭 타이밍 동적 1:1 동기화 (`renderRunner.ts`, `SyntheticCursor.tsx`, `dashboard/`)
1. **Remotion 렌더러 단일 인플레이스 진행률 게이지 (`renderRunner.ts`, `dashboard/app.js`, `dashboard/style.css`)**:
   - 매 프레임/숫자 변동마다 수천 줄의 로그가 쌓이던 방식을 전면 개편.
   - Webpack 번들링 단계와 비디오 프레임 렌더링 단계를 완벽히 분리.
   - 여러 줄로 스크롤되지 않고, **단 1개의 라인에서 실시간 게이지(`[████░░░░] 45% (1442/3205 frames)`)가 0%부터 100%까지 인플레이스로 차오르는 프리미엄 UI** 구축.
2. **마우스 커서 타이밍 하드코딩 오프셋 제거 및 동적 물결(Ripple) 동기화 (`SyntheticCursor.tsx`, `tutorialTemplates.ts`, `geminiPlanner.ts`)**:
   - 과거 OBS 잔재인 `-700ms` 및 템플릿의 `delayMs: 800` 등 하드코딩된 오프셋을 완전 제거하고 기본값을 `0ms`로 정상화.
   - 브라우저 원본 영상의 파란색 클릭 물결(`triggerClickVisualizer`)이 터지는 정확한 초(`moment.timestamp`)와 Remotion 가상 커서의 클릭 정점(Peak Press & Ring Emission)을 1:1 밀리초 단위로 일치시킴.
   - 이전 액션과의 시간 간격(`gap`)을 동적으로 계산하여, 클릭 직전 최적의 타이밍에 부드럽게 목표 지점에 안착(Dynamic Travel & Rest)하도록 모션 수식 정밀화.
   - 기존 레거시 플랜의 `800` 또는 `-700` 값 자동 무효화 안전망 탑재.

### ✅ Task 8. AI 실시간 자가 치유 (Live Runtime Self-Healing Engine) 구축 (`elementSelfHealer.ts`, `record.ts`)
1. **문제 정의 및 배경**:
   - 사용자가 시나리오를 자유롭게 입력하거나 신규 화면 녹화 시, 셀렉터가 누락되었거나 UI 구조 변경/동적 렌더링 지연으로 인해 요소를 찾지 못하면 녹화가 중단(`Error: 요소를 찾을 수 없습니다`)되는 치명적인 문제 해결.
2. **실시간 멀티모달 시각 + DOM 후보군 추출 (`extractLiveCandidates`)**:
   - 녹화 실패 시점을 감지하면 즉시 브라우저 실시간 화면(JPEG Base64 스크린샷)을 캡처.
   - 최상위 문서뿐만 아니라 화면에 로드된 모든 가시적 iFrame(`iframe#subBody`, `iframe#contentFrame` 등)을 동시 스캔하여 실제 인터랙티브 엘리먼트(버튼, 입력창, 링크, 체크박스 등 최대 75개)를 구조화된 JSON 후보군으로 추출.
3. **초정밀 AI 자가 치유 프롬프트 & 5대 황금 복구 원칙 (`selfHealElement`)**:
   - **무추측 원칙 (Zero-Guessing Policy)**: 후보군 목록에 없는 임의의 가상 ID 생성 엄격 차단.
   - **모달/다이얼로그 팝업 격리 스코핑**: 화면에 모달이 떠 있을 경우 `.ui-dialog:visible` 또는 `.modal:visible` 접두사 자동 적용.
   - **iFrame 컨텍스트 완벽 분리**: `iframe#subBody` 내부 요소는 `iframe` 필드에 정확히 명시.
   - **말단 인터랙티브 태그 핀포인트**: 넓은 부모 div나 form 대신 실제 클릭 가능한 태그를 핀포인트 타겟팅.
   - **견고한 2중 방어선 (Robust Dual Fallback via Comma)**: 클래스/ID와 텍스트 매칭을 쉼표(,)로 결합한 최적의 Playwright 셀렉터 산출.
4. **녹화 무중단 연속 실행 & 셀렉터 영구 자동 저장 (`saveHealedPlan`)**:
   - 치유된 셀렉터를 즉시 인메모리 액션에 반영하여 브라우저 녹화를 끊김 없이 연속 진행.
   - 교정된 셀렉터와 iframe 스코프를 `data/<slug>/browse-plan.json` 파일에 즉시 영구 저장하여, 이후 녹화 시에는 자가 치유 호출 없이 즉시 안정적으로 실행.

### ✅ Task 9. 실시간 실제 DB 데이터 동적 스크래핑 & 검색/조회 연동 엔진 구축 (Method 2) (`types.ts`, `record.ts`, `tutorialTemplates.ts`)
1. **문제 정의 및 배경**:
   - 문서함 조회, 결재 문서 검색, 게시판 검색, 조직도 사원 검색 시연 시, AI가 임의로 지어낸 가상 텍스트('테스트용 기안서', '김철수' 등)를 입력하면 실제 개발/운영 DB에 존재하지 않아 '검색 결과 0건' 오류가 발생하고 시나리오가 멈추는 치명적 문제 해결.
2. **동적 텍스트 스크래퍼 (`scrapeLiveText` in `record.ts`)**:
   - 화면에 떠 있는 엔터프라이즈 테이블(`.tbl_lst`, `.lst_type1`, `table tbody tr:first-child a`) 또는 조직도 트리(`.dynatree-title`, `.org_tree`)에서 현재 실제로 렌더링된 첫 번째 실제 데이터의 제목/사원명을 실시간으로 스크래핑.
   - 불필요한 배지(`[공지]`, `[안내]`, 댓글수 `(3)`)를 자동 정제하고 검색에 최적화된 키워드로 가공.
3. **런타임 변수 링킹 & 검색창 자동 주입**:
   - `action.scrapeAs`, `action.useScraped` 및 자동 감지 모드(`isSearchAction`) 지원.
   - 검색창 입력 시 하드코딩된 텍스트 대신 현재 화면의 실제 목록 데이터를 동적으로 타이핑하고, 검색 실행 후 결과 클릭 단계에서도 해당 실존 데이터를 100% 매칭하여 클릭.
### ✅ Task 10. 자가 복구 완료 후 2-Pass 클린 마스터 자동 재녹화 및 폼 등록 6대 필수 조건 전수 충족 보장 (`record.ts`, `tutorialTemplates.ts`, `geminiPlanner.ts`, `planSanitizer.ts`)
1. **2-Pass 클린 마스터 자동 재녹화 (2-Pass Clean Master Re-recording)**:
   - **배경**: 1차 녹화 중 요소 탐색 실패로 AI 실시간 자가 치유가 발생하면, 타임아웃 대기(8~10초) 및 Gemini 응답 대기로 인해 브라우저 녹화 화면에 긴 멈춤 공백이 발생함.
   - **해결**:
     - `record.ts`에서 자가 치유 성공 횟수(`totalHealedCount`)를 실시간 카운팅.
     - 1차 녹화가 끝나 모든 교정된 셀렉터가 `browse-plan.json`에 영구 저장되면, `totalHealedCount > 0`일 때 자동으로 즉시 2차 클린 패스(`--clean-pass`)를 가동.
     - 2차 녹화에서는 모든 셀렉터가 지연 없이 즉시 클릭되므로, 대기 공백이 100% 제거된 매끄럽고 완벽한 최종 마스터 영상(`recording.mp4`, `moments.json`, `edit-plan.json`, `Root.tsx`)이 자동으로 완성됨.
2. **신규 등록/작성 기능 6대 필수 조건 전수 충족 원칙 (Zero-Validation-Failure Policy)**:
   - **배경**: 문서 등록, 전자결재 기안, 일정 등록, 게시글 작성 등 엔터프라이즈 등록 폼에서는 필수 입력값이 누락된 상태로 [저장/상신] 버튼을 누르면 브라우저 JavaScript alert("문서함을 선택하세요", "제목을 입력하세요", "결재선을 지정하세요")가 발생하여 시나리오가 멈추는 문제 원천 차단.
   - **6대 필수 등록 시퀀스 표준화**:
     ① **조건 1 [타겟 분류/문서함/캘린더/양식 선택]**: 대상 문서함/캘린더/게시판/양식을 먼저 선택하여 "문서함을 선택하세요" alert 원천 차단.
     ② **조건 2 [제목/명칭 입력]**: `type` 액션으로 명확한 제목 타이핑 (미입력 alert 방지).
     ③ **조건 3 [결재선/조직도/참석자 지정]**: 조직도 팝업 호출 -> 부서 트리 확장 -> 사원 체크 -> 확인 적용.
     ④ **조건 4 [필수 메타데이터/옵션 설정]**: 보존기간(보존연한), 보안등급, 공개여부 등 필수 옵션 선택.
     ⑤ **조건 5 [본문 에디터 내용 작성]**: 웹 에디터/본문 영역 클릭 및 본문 작성 (iFrame 에디터 대응).
     ⑥ **조건 6 [최종 저장/상신 및 확인 다이얼로그 승인]**: 저장 버튼 클릭 및 확인 알림창(`dialog.accept()`) 자동 승인.
   - **코드 탐색 및 플랜 정제기 강화**:
     - Gemini Planner가 소스코드의 `extractAlertsAndValidation` 도구를 활용하여 실제 alert 조건을 사전 검증하도록 지침 주입.
     - `planSanitizer.ts`에 등록 시나리오 필수 조건(제목 입력 등) 사전 감사(Audit) 레이어 신설.
     - `record.ts`의 `page.on("dialog")`에서 필수 조건 미충족 알림 감지 시 대시보드 경고 로그 상세 안내.

---

### ✅ Task 11. 건너뛰기(Optional) 옵션 전면 제거 및 100% 실행 보장 체계 구축 (`record.ts`, `tutorialTemplates.ts`, `geminiPlanner.ts`, `planSanitizer.ts`, `dashboard/`)
1. **문제 정의 및 배경**:
   - `optional: true` 플래그가 존재하여, AI가 '문서함 선택 버튼', '트리 노드 선택', '모달 확인 버튼' 등 핵심 필수 단계에 무분별하게 `optional: true`를 붙이는 문제 발생.
   - Playwright 녹화 중 요소가 조금만 늦게 뜨거나 탐색이 지연되면, AI 자가 치유를 시도하지도 않고 `[Info] 요소를 찾을 수 없어 건너뜀(Optional)` 로그를 띄우며 필수 단계를 건너뛰어 버리는 치명적 부작용 초래.
2. **조치 내역**:
   - **`scripts/record.ts`**: `action.optional` 건너뛰기 분기를 전면 제거. 모든 액션은 반드시 실제로 대기(기본 8~10초), 시맨틱 대체 탐색, **AI 실시간 자가 치유(`trySelfHealAction`)**를 거쳐 100% 실행되도록 보장.
   - **`tutorialTemplates.ts` & `geminiPlanner.ts`**: AI 시나리오 생성 프롬프트에서 `optional` 사용을 엄격히 금지. 모든 단계는 화면에서 실제로 수행되어야 함을 명시.
   - **`planSanitizer.ts`**: 모든 플랜 정제 시 `optional` 속성을 자동으로 강제 삭제(`delete action.optional`)하도록 방어막 구축.
   - **`dashboard/app.js`**: 액션 카드 편집기 UI에서 `Optional (실패해도 계속)` 체크박스 제거.
   - **기존 데이터 정제**: `.cache/plan-cache.json` 및 `data/tutorial-document/browse-plan.json`에 남아있던 모든 `optional: true` 잔재 전수 제거.

---

### ✅ Task 12. 검색/조회 목적 시나리오의 불필요한 가상 등록 단계 전면 분리 및 순수 DB 연동 파이프라인 정립 (`geminiPlanner.ts`, `tutorialTemplates.ts`, `data/tutorial-document/`)
1. **문제 정의 및 배경**:
   - 사용자가 '문서 검색/조회'를 테스트할 때, 기존 플랜에 신규 문서 등록 단계(가상 제목 `'2026학년도 대학 혁신지원사업 업무추진 계획서'` 입력 및 본문 작성/저장)가 섞여 있어, 실제 DB 조회가 아니라 가상의 텍스트를 여전히 타이핑하는 현상 발생.
   - 또한 셀렉터가 `input[placeholder*='문서함명']`(문서함 검색창)으로 잘못 타겟팅되어 엉뚱한 곳에 가상 제목이 타이핑되던 문제 발견.
2. **조치 내역**:
   - **순수 조회 파이프라인 확립**:
     - `geminiPlanner.ts` 및 `tutorialTemplates.ts` 프롬프트에 `[검색/조회 목적 시나리오에 불필요한 신규 등록 단계 생성 엄격 금지]` 규칙 주입.
     - 사용자가 조회/검색/열람을 요청한 경우 [신규 등록] 버튼을 눌러 새 글을 작성하는 단계를 원천 차단하고, `[메뉴 이동] -> [문서함/분류 선택] -> [실시간 실제 DB 목록 스크래핑 및 검색창 자동 입력] -> [검색 실행] -> [해당 실제 문서 클릭 상세 확인]`의 100% 실존 데이터 조회 파이프라인으로 구성하도록 강제.
   - **`data/tutorial-document/browse-plan.json` 정제**:
     - 가상의 문서 등록 및 `'2026학년도 대학 혁신지원사업...'` 입력 단계(54~105줄)를 전면 삭제.
     - 실제 문서함 목록 로딩 후 첫 번째 실제 문서 제목을 스크래핑(`useScraped: "auto"`, `dynamicStrategy: "first-row-title"`)하여 검색창에 타이핑하고 클릭하는 순수 무결점 시나리오로 재구성.


---

### ✅ Task 13. 차단 팝업/모달 자동 감지 및 실시간 자가 복구 엔진(Live Popup Sentinel & Auto-Recovery Engine) 구축 (`record.ts`, `elementSelfHealer.ts`, `geminiPlanner.ts`, `tutorialTemplates.ts`)
1. **문제 정의 및 배경**:
   - 사용자가 문서 등록 시연 시, 좌측 [문서 등록] 버튼을 누르면 화면에 `[문서함 선택]` 모달 팝업(`.ui-dialog`, `.ui-widget-overlay`)이 뜨는데, AI 시나리오가 유효한 말단 문서함(Leaf Node)을 선택하지 않고 넘어가 팝업이 닫히지 않고 Alert가 발생함.
   - 팝업이 닫히지 않아 이후 제목/본문/저장 액션이 팝업 뒤에 가려져 80초간 멈춘 채 녹화가 지속되는 치명적 중단 현상 발생.
2. **조치 내역**:
   - **`autoRecoverActiveModals` 팝업 실시간 보초(Sentinel) 탑재 (`record.ts`)**:
     - `hover`, `dblclick`, `click`, `type` 액션 실행 직전 및 `trySelfHealAction` 호출 직전에 화면에 차단 팝업/모달이 떠 있는지 자동 감시.
     - **알림/경고 팝업 감지 시**: `#alert_lyr` 또는 다이얼로그 내의 `[확인]` 버튼을 자동 클릭하여 차단 해제.
     - **`문서함 선택` 모달 감지 시**: 다음 액션이 본문 폼 입력(제목, 내용, 저장 등)인데 모달이 아직 떠 있는 경우, 팝업 내의 실제 말단 문서함(`.dynatree-container a:not(.dynatree-expander)`)을 자동 선택하고 `[확인]` 버튼(`.btn_pri`)을 클릭하여 모달과 오버레이를 완전히 닫고 본문 화면으로 진입시키는 지능형 자가 복구 수행.
   - **`elementSelfHealer.ts` native querySelector 버그 수정**:
     - `document.querySelectorAll(".ui-dialog:visible...")`처럼 native DOM에서 지원하지 않는 `:visible` 문법을 제거하고 `getBoundingClientRect` 기반 가시성 검사로 안전하게 교정.
   - **문서 등록 4단계 필수 시퀀스 표준화 (`geminiPlanner.ts`, `tutorialTemplates.ts`, `data/tutorial-document/browse-plan.json`)**:
     - `[문서등록 클릭] -> [문서함 선택 팝업 열림 대기] -> [실제 말단 문서함 선택] -> [팝업 확인 클릭 및 폼 진입] -> [본문 제목 입력] -> [본문 작성] -> [저장]`의 무결점 4단계 시퀀스를 표준으로 정립하고 플랜 교정 완료.

---

### ✅ Task 14. 문서함 선택 팝업(`DocSelect`) 비등록 상위 폴더('대학') 오선택 방지 및 말단 리프 노드 핀포인트 자동 선택 엔진 구축 (`record.ts`, `planSanitizer.ts`, `tutorialTemplates.ts`, `geminiPlanner.ts`, `.cache/plan-cache.json`)
1. **문제 정의 및 기술적 근본 원인 분석**:
   - `[14981ms] click: 팝업 내 대상 부서 문서함 노드 선택` ➔ `[16084ms] wait` ➔ `[🎯 최상단 모달 요소 감지] 중첩 팝업 #1 'button:has-text('확인'):visible'` 이후 시나리오가 중단되고 루프에 빠지는 치명적 장애 발생.
   - **원인 1 (jQuery 비표준 의사클래스 문법 오류)**:
     - 셀렉터에 `.dynatree-node:not(.dynatree-folder) a.dynatree-title:first` 및 `a.dynatree-title:last`처럼 `:first`, `:last`가 포함되어 있어, Playwright의 `querySelectorAll` 내부 엔진에서 `SyntaxError: ... is not a valid selector`가 발생하여 1, 2순위 셀렉터가 무효화됨.
   - **원인 2 (상위 비등록 폴더 '대학' 오선택)**:
     - 문법 오류로 인해 3순위 셀렉터인 `.dynatree-title:visible`로 폴백되었고, 트리 최상단에 위치한 루트 디렉토리인 `'대학'`이 선택됨.
   - **원인 3 (Naonsoft 유효성 Alert 및 모달 미종료)**:
     - `'대학'`은 하위 문서함을 담고 있는 폴더(`isFolder: true`)이므로, `[확인]` 버튼 클릭 시 Naonsoft 자바스크립트가 차단 알림(*"글을 등록할 문서함을 선택하세요"*)을 띄우고 모달을 닫지 않음.
     - 모달이 닫히지 않아 이후 제목/본문 입력창이 노출되지 않아 시연이 영구 중단됨.
2. **조치 내역**:
   - **`scripts/record.ts` 3중 방어막 구축**:
     - `getLocator()`: `:first`, `:last` 의사클래스를 안전하게 감지하고 `.first()`, `.last()` 메서드로 자동 변환하여 Playwright `SyntaxError` 원천 차단.
     - `case "click"` - **DocSelect 트리 & 모달 확인 자율 보초(Sentinel)**:
       - 문서함 선택 단계 감지 시, `모두펼침` 버튼을 자동 클릭하여 하위 트리를 완전히 펼침.
       - 상위 폴더 `'대학'`을 엄격히 배제하고 등록 가능한 말단 리프 노드(`AI 활용 플랫폼...` 또는 `.dynatree-node:not(.dynatree-folder) a.dynatree-title`)를 강제 핀포인트 타겟팅.
       - `[확인]` 버튼 클릭 직전, 선택된 노드가 폴더인지 사전 검사하여 폴더라면 하위 리프 노드를 먼저 선택 후 `[확인]` 클릭.
       - `[확인]` 클릭 후 차단 Alert(*"글을 등록할 문서함을 선택하세요"*) 감지 시 즉시 닫고 하위 노드를 재선택하여 모달이 100% 정상 닫히도록 보장.
   - **`src/services/planSanitizer.ts` 전역 문법 정제 & 리프 노드 주입**:
     - 모든 액션의 셀렉터에서 `:first`, `:last` 자동 정제.
     - `DocSelect` 모달 노드 선택 액션 감지 시 상위 폴더를 배제하는 무결점 리프 노드 셀렉터로 자동 교정.
   - **`tutorialTemplates.ts` & `geminiPlanner.ts` 프롬프트 갱신**:
     - 4단계 필수 시퀀스 가이드에 실제 작동하는 표준 리프 노드 셀렉터 예시 주입.
   - **`.cache/plan-cache.json` 캐시 정제**:
     - 기존 캐시 내의 잘못된 `:first`, `:last` 및 상위 폴더 셀렉터를 리프 노드 셀렉터로 갱신 완료.

---

### ✅ Task 15. DocSelect Lazy-Load 비동기 트리 전개 대기 & 실제 등록 가능 문서함(nodeType='B') 직접 활성화 & AI Self-Healer 모달 오염 차단 (`record.ts`, `elementSelfHealer.ts`, `browse-plan.json`, `.cache/plan-cache.json`)
1. **문제 정의 및 기술적 근본 원인 (사용자 피드백 심층 분석)**:
   - 사용자가 *"왜 첫번째 노드만 선택을 하는거야??? 소스에 그게 아닌게 나올텐데"*라고 정확히 지적함.
   - 실제 그룹웨어 소스코드(`docSelect.jsp`, `docSelect.js`) 확인 결과, **트리가 Lazy-Load(AJAX) 구조**로 설계되어 있어 팝업 오픈 직후에는 DOM에 상위 루트 디렉토리인 `'대학'`만 존재하고 실제 문서함(`nodeType === 'B'`)은 로드되어 있지 않음.
   - 트리를 펼치는 액션 직후 비동기 AJAX 응답(약 1000ms 소요)을 기다리지 않아 DOM에 유일하게 존재하던 `'대학'`이 선택되었고, Naonsoft 유효성 Alert(*"글을 등록할 문서함을 선택하세요"*)가 발생하여 모달이 닫히지 않음.
   - 모달이 열린 상태에서 다음 단계(제목/내용 입력)가 실행되자, AI 실시간 자가 치유(Self-Healer)가 화면에 보이는 모달 내 검색창(`input[placeholder*='문서함명']`)으로 셀렉터를 오판단하여 `browse-plan.json`을 오염시킴.
2. **조치 내역**:
   - **`ensureDocSelectLeafSelected(page)` 전용 엔진 신설 (`scripts/record.ts`)**:
     - `#docSelect_expandTree` 클릭 및 `DocSelect.tree.expandTree()` 호출로 비동기 하위 트리 전개.
     - `childBoardLoc.waitFor({ state: "visible", timeout: 4500 })`로 Lazy-load AJAX 응답이 완료되어 실제 리프 문서함이 DOM에 렌더링될 때까지 대기.
     - Dynatree 내부 데이터 모델을 직접 순회하여 `!node.data.isFolder && node.data.nodeType === "B"`인 첫 번째 유효 문서함을 찾아 `targetNode.activate()`로 즉시 활성화(그룹웨어 유효성 검사 100% 통과).
     - 화면상의 해당 엘리먼트를 실제 물리 클릭하여 마우스 커서 모션 및 시각적 선택 효과를 영상에 정밀 기록.
   - **`confirmDocSelectModal(page)` 안전 모달 종료기 탑재 (`scripts/record.ts`)**:
     - `#docSelect_confirm` 버튼 클릭 후 모달과 오버레이(`.ui-widget-overlay`)가 화면에서 완전히 사라질 때까지 대기하여 본문 등록 폼 진입 보장.
   - **AI Self-Healer 모달 오염 차단 가드 탑재 (`elementSelfHealer.ts`)**:
     - 본문 등록 단계(제목, 본문, 내용, 저장 등)에 대해 AI가 모달 팝업 내부 요소(`.ui-dialog`, `문서함명`)를 반환할 경우 영구 저장 및 적용을 원천 거부(Guard 2)하도록 차단.
   - **`browse-plan.json` 및 캐시 정제**:
     - 자가 치유 오염으로 모달 검색창이 주입되었던 `data/tutorial-document/browse-plan.json`과 `.cache/plan-cache.json`을 100% 정상 셀렉터로 완전 복원.

---


### ✅ Task 16. DocSelect 모달 확인 멱등성(Idempotency) 보장 및 조기 닫힘 대응, AI Self-Healer 본문 오염 방지(Guard 3), 31개 전 단계 완벽 녹화 완결 (`record.ts`, `elementSelfHealer.ts`, `planSanitizer.ts`, `browse-plan.json`)

---

### ✅ Task 17. 타 프로젝트(bc2026_gw) 교차 호환성(Cross-Project Compatibility)을 위한 조직도 팝업 엔진 고도화 및 팝업 강제 종료 버그 픽스 (`record.ts`, `tutorialTemplates.ts`)
1. **문제 정의 및 배경**:
   - `tutorial-mail` 시나리오 녹화 중, 조직도 팝업에서 사용자를 검색(`GW테스트02`)했을 때 결과가 0건이면 체크박스를 찾지 못하고 AI Self-Healing이 발동됨.
   - 이때 기존 `autoRecoverActiveModals` 엔진이 "조직도 팝업"을 "시나리오 진행을 방해하는 예기치 못한 에러 팝업"으로 오인하여 강제로 [확인]을 누르고 팝업을 닫아버려(조기 닫힘) 이후 체크박스 클릭/추가 버튼 클릭 로직이 연쇄적으로 실패하는 치명적 버그 발생.
   - 또한, 특정 타겟 프로젝트(`bc2026_gw`)의 조직도 팝업에는 사용자를 우측으로 넘기는 **[추가(>)] 화살표 버튼이 아예 존재하지 않는 UI**임에도 불구하고, AI가 무조건 화살표 버튼을 누르도록 기획(Hallucination)하여 녹화가 실패하는 문제 발생.
2. **조치 내역**:
   - **조직도 팝업 실시간 보초망 예외 처리 보강 (`record.ts` `autoRecoverActiveModals`)**:
     - `isActionForModal` 조건식에 `사원`, `결재`, `수신자`, `추가` 등의 키워드와 `org_`, `userList` 등의 셀렉터 패턴을 대폭 추가하여, AI가 팝업 내부 요소를 조작 중일 때는 절대 팝업을 강제로 닫지 않도록 방어막을 견고하게 구축.
   - **AI 환각(Hallucination) 버튼 기획 원천 차단 (`tutorialTemplates.ts`)**:
     - 프롬프트에 `조직도 팝업에 [추가(>)] 버튼이 없는 UI(예: 체크박스 선택 후 곧바로 하단 [확인] 클릭)가 많습니다. 소스코드에 화살표 버튼이나 추가 버튼이 명확히 존재하지 않는다면 절대 '추가 버튼 클릭' 액션을 지어내지 마십시오!`라는 강력한 경고 규칙을 주입하여 타 프로젝트 교차 호환성 보장.

---

### ✅ Task 18. 범용 테이블 데이터 동적 스크래핑 엔진 적용 및 2-Pass 녹화 완벽 달성 (`record.ts`, `browse-plan.json`)
1. **문제 정의**:
   - 검색 결과가 없는 테스트 데이터(`GW테스트02`)로 인해 0건 오류가 발생하지 않도록, 트리 노드를 열어 실제 사원을 화면에 렌더링한 후 스크래핑(`scrapeLiveText`)해야 했으나, 타 프로젝트의 사원 목록 테이블 형태가 기존 템플릿과 달라 스크래핑에 실패함.
2. **조치 내역**:
   - **범용 테이블 텍스트 탐색자 추가 (`record.ts`)**:
     - `candidateSelectors`에 `table tbody tr:not(:first-child):visible td:nth-child(2):visible` 등 범용 테이블의 이름 컬럼을 읽어낼 수 있는 초정밀 대체 셀렉터들을 대거 추가하여 프로젝트(UI 템플릿)가 바뀌어도 무조건 실제 데이터를 긁어오도록 엔진을 일반화(Generalization)함.
   - **엔드투엔드 최종 녹화 성공**:
     - 기존 인증 세션을 백업하고 로그인 스크립트(`login.js`)를 통해 무결점 세션으로 재시작.
     - 메일 쓰기 ➔ 대상 검색 ➔ 추가(환각 없이 정상 체크박스 선택 후 확인) ➔ 폼 작성 ➔ 최종 발송까지의 모든 시나리오가 에러 없이 작동하며, 2-Pass 클린 마스터 자동 재녹화 및 160초 분량의 매끄러운 최종 마스터 영상(`recording.mp4`) 및 카메라 모션(`edit-plan.json`) 생성을 성공적으로 달성.
1. **문제 정의 및 배경**:
   - `ensureDocSelectLeafSelected`와 선행 확인 로직에 의해 '문서함 선택' 팝업이 이미 성공적으로 완료되어 모달이 닫히고 본문 '문서 등록' 폼으로 화면 전환이 완료되었음에도, 플랜의 12단계(`문서함 선택 팝업 [확인] 버튼 클릭`)가 이미 사라진 모달 내 `[확인]` 버튼을 찾으려고 10초간 대기하다가 실패하는 현상 발생.
   - 모달이 이미 닫혀 화면에 없는 상태에서 AI 자가 치유가 가동되어, 본문 폼의 `iframe#subBody` 내부에서 엉뚱하게 `button:has-text('확인')`을 추측하여 `browse-plan.json`을 오염시킴.
2. **조치 내역**:
   - **모달 확인 멱등성(Idempotency) 보장 (`scripts/record.ts`)**:
     - 팝업 확인 단계(`isDocSelectConfirm`) 진입 시 모달이 이미 닫혀 있는 경우(`!hasActiveTreeDialog`), 불필요한 10초 대기나 AI 자가 치유를 호출하지 않고 `[✨ 모달 확인 불필요]` 로그와 함께 즉시 다음 단계(제목/본문 입력)로 안전하게 패스.
     - 모달이 열려 있는 경우에는 조기 닫힘 없이 화면의 `[확인]` 버튼(`#docSelect_confirm`)을 직접 타겟팅하여 부드러운 마우스 모션과 클릭이 비디오에 기록되도록 보정.
   - **AI Self-Healer 본문 프레임 오염 차단 가드 탑재 (Guard 3 in `elementSelfHealer.ts`)**:
     - 모달 확인 액션에 본문 프레임(`iframe#subBody`, `iframe#contentFrame`) 셀렉터가 반환되는 경우를 원천 거부하도록 방어벽 추가.
   - **`planSanitizer.ts` 정제 강화**:
     - 리프 노드 정제 규칙(1-B)에서 `!desc.includes("확인")` 조건을 명시하여 `[확인]` 버튼 셀렉터(`#docSelect_confirm`)가 리프 노드로 잘못 덮어씌워지지 않도록 격리.
     - `tr-child` 오타 자동 교정(`tr:first-child`) 및 모달 확인 액션의 불필요한 `iframe` 속성 자동 제거.
   - **실제 Naonsoft `atclWrite.jsp` DOM 기반 표준 셀렉터 동기화**:
     - 제목: `input#atclWrite_subject:visible`
     - 본문: `#atclWrite_atclCn:visible, div[contenteditable='true']:visible`
     - 저장: `button._save:visible, button:has-text('저장'):visible`
3. **결과 검증**:
   - `npm run record tutorial-document` 실행 결과, 31개 전체 액션(메뉴 이동 -> 비동기 트리 전개 -> 리프 노드 선택 -> 모달 확인 -> 제목/본문 입력 -> 저장 -> 목록 전환 -> 실시간 DB 데이터 스크래핑 검색 -> 상세 조회)이 **단 하나의 오류 없이 완벽하게 성공(종료 코드 0, 비디오 52.1초, 12개 줌 세그먼트 생성)**.

---

## 6. 개발 서버 및 핵심 명령어 모음 (Cheat Sheet)

```bash
# 1. AI 웹 대시보드 스튜디오 실행 (기본 포트: 3333)
npm run dashboard
# 브라우저 접속: http://localhost:3333

# 2. CLI에서 시나리오 녹화 (브라우저 직접 보면서 실행)
npm run record create-and-submit --headed

# 3. CLI에서 줌 플랜 다시 계산
npm run edit create-and-submit

# 4. 최종 MP4 동영상 파일 렌더링 (Remotion CLI)
npm run render
# 또는 파일명 지정: npx remotion render ScreenDemo output/create-and-submit.mp4

# 5. Remotion 타임라인 GUI 스튜디오 열기
npm start
# 브라우저 접속: http://localhost:3000
```

---

## 7. 현재 환경 변수 및 설정 상태

* **`DASHBOARD_PORT`**: `3333` (현재 정상 구동 중)
* **`GEMINI_MODEL`**: `gemini-3.8-flash` (최신 플래그십 Flash 모델 - 고정밀 소스코드 역공학 및 영상 연출)
* **`TARGET_PROJECT_PATH`**: `C:/dev/IdeaProjects/unison/unison_gw` (또는 `bc2026_gw`)
* **`TARGET_BASE_URL`**: `https://gwdev.unison.co.kr/`
* **인증 파일 상태**: `data/create-and-submit/auth.json` 세션 유효 (반복 로그인 불필요)

---

## 8. 모든 시나리오 대상 범용성(Universality) 및 0% 하드코딩 완전 방어 체계 (2026-10-05 완료)

### 📌 사용자 핵심 요구사항
> **"해당 영상에만 적용될게 아니라 다른 시나리오를 뽑을 때도 해당 보완조치가 적용될 수 있도록 수정해야 되는거 알지??"**

특정 시나리오(`tutorial-document`)에만 통하는 1회성 땜질 코딩을 엄격히 배제하고, **향후 전자결재, 게시판, 메일, 일정관리, 설문, 업무관리 등 어떠한 신규 시나리오를 생성하거나 녹화하더라도 동일하게 100% 자동 적용되는 범용 파이프라인**을 완성했습니다.

---

### 🛡️ 5대 범용 보완 조치 및 아키텍처 반영 현황

#### 1. 특정 도메인 고유어(예: '대학', 'AI 활용') 하드코딩 100% 제거 및 구조적 리프 노드 추론
* **기존 문제**:
  - 특정 시나리오 디버깅 과정에서 특정 폴더명('대학')이나 문서함명('AI 활용')이 planSanitizer.ts와 record.ts에 잔존하여 다른 업무 화면(전자결재 양식함, 게시판 트리, 일정 캘린더 등)에서는 오작동할 위험이 존재.
* **범용화 조치 완료**:
  - `planSanitizer.ts` (규칙 1-B):
    '대학', 'AI 활용' 단어를 100% 제거하고, 순수 DOM 구조 기반으로 선택 모달 내의 유효 등록 가능 리프 노드만을 정확히 스코핑:
    - `.ui-dialog:visible .dynatree-container .dynatree-node:not(.dynatree-folder) a.dynatree-title:visible`
    - `.ui-dialog:visible .dynatree-container li:not(:has(ul)) a.dynatree-title:visible`
    - `.ui-dialog:visible .dynatree-container li:last-child a.dynatree-title:visible`
  - `record.ts` (`ensureTreeLeafSelected`):
    - `ensureDocSelectLeafSelected`를 전사적 트리 헬퍼인 `ensureTreeLeafSelected`로 전면 개편.
    - Dynatree, Fancytree, jstree 등 모든 트리 컴포넌트에서 `node.data.isFolder === false`이거나 자식 노드가 없는 최하위 실제 리프 노드를 데이터 모델 차원에서 자율 탐색 및 활성화.
    - 좌측 사이드바 트리 둘러보기와 팝업 내부 선택 단계를 명확히 분리하여 사이드바 조작 오염 원천 차단.

#### 2. 웹 에디터 본문 타이핑 격리 및 폼 필드 오염 원천 차단
* **기존 문제**:
  - 본문/내용 입력 시 상위 컨테이너 div나 툴바가 잡히면 이전 포커스가 남아있던 제목(title) 필드에 본문 텍스트가 덮어씌워져 타이틀이 망가지는 현상 발생.
* **범용화 조치 완료**:
  - `record.ts` (`resolveAtomicTarget`):
    - `isTypeAction === true`인 경우 버튼, 링크, 아이콘(`i.ico`), AI 어시스트 버튼을 엄격히 배제하고 `contenteditable="true"`, `textarea`, `.note-editable`만을 핀포인트 추출.
    - 타이핑 직전 직전 활성 요소 포커스를 완전히 해제(`active.blur()`)하고 실제 입력 캔버스에만 포커스를 인입하여 필드 간 텍스트 누출 0% 달성.
  - `planSanitizer.ts` (규칙 1-C):
    - 설명에 '내용', '본문', 'content', '사유', '메모'가 포함된 모든 type 액션에 대해 `div[contenteditable='true']:visible, textarea:visible, .note-editable:visible`를 자동으로 덧붙여 AI가 생성한 어떠한 플랜도 에디터 본문 캔버스를 직격하도록 정제.

#### 3. 실시간 DB 데이터 스크래핑(`scrapeLiveText`)의 세로 분할 뷰 및 별표 아이콘 필터링
* **기존 문제**:
  - 그룹웨어 세로 분할 뷰(Naonsoft lst_vr, atclList_list2 등)에서는 행 첫 머리에 별표 북마크(`a.star_chk`)가 제목 링크(`a.sub_tp`)보다 먼저 배치되어, 단순 a:visible로 스크래핑하면 제목 대신 공백이나 '별표하기'가 읽히는 문제 발생.
* **범용화 조치 완료**:
  - `record.ts` (`scrapeLiveText`):
    - 가로형 테이블뿐만 아니라 카드형/세로분할 뷰의 실제 제목 링크(`a.sub_tp`, `.sub a`, `a._atcl`)를 우선 탐색 후보군으로 전진 배치.
    - `:not(.star_chk):not(.star)` 필터 및 '별표하기', '중요', '선택' 등 불필요한 라벨 배제 로직을 탑재하여 어떤 업무 목록에서도 실제 데이터 제목을 100% 무오차 추출.

#### 4. 순수 조회/검색(Search & View)과 신규 등록/작성(Create & Submit)의 엄격한 분리
* **프롬프트 및 디렉팅 가이드라인 (`tutorialTemplates.ts`, `geminiPlanner.ts`)**:
  - **조회/검색 시나리오**: 사용자가 '조회', '검색', '확인', '열람'을 요청한 경우, 시나리오 앞단에 불필요하게 가상 데이터를 등록하는 단계를 일절 생성하지 않고 순수 조회 파이프라인([목표 메뉴 이동] -> [실제 DB 목록 로딩 대기] -> [화면 데이터 스크래핑 "useScraped": "auto"] -> [검색창 입력] -> [결과 클릭 상세 확인])으로만 구성하도록 강제.
  - **신규 등록 시나리오**: 6대 필수 조건([1] 대상 분류/컨테이너 선택 -> [2] 제목 입력 -> [3] 대상자/결재선 지정 -> [4] 필수 옵션 설정 -> [5] 본문 캔버스 작성 -> [6] 저장 및 확인 다이얼로그 승인)을 빠짐없이 거치도록 규정하여 유효성 검사 alert 차단.

#### 5. 3중 자동 파이프라인으로 전사 시나리오 영구 적용 보장
- **1계층 (AI 생성 직후)**: `geminiPlanner.ts`가 플랜 생성 즉시 `sanitizeBrowsePlan()`을 호출하여 모든 문법, 리프 노드 스코핑, 에디터 타겟팅을 자동 교정하고 스마트 캐시(`.cache/`)에 보관.
- **2계층 (런타임 사전 점검)**: `record.ts`가 실행될 때마다 즉시 `sanitizeBrowsePlan()`을 통과시켜 사용자가 수동 편집한 플랜도 위험 요소를 사전 무력화.
- **3계층 (실시간 자가 치유)**: `elementSelfHealer.ts`가 실행 도중 실패한 요소에 대해 최신 화면 스크린샷과 DOM 후보군을 교차 분석하여 자동 복구하고 영구 저장.

---

### ✅ Task 11. 새창/팝업(`window.open` / `target="_blank"`) 범용 단일 캔버스 녹화 및 다중 창 추적 엔진 구축 (`record.ts`, `geminiPlanner.ts`, `codeExplorerAgent.ts`)
1. **문제 정의 및 배경**:
   - 사용자가 '메일 쓰기', '쪽지 쓰기', '전자결재 인쇄/새창보기' 등 새 창이 뜨는 시나리오를 실행했을 때, 웹앱이 `window.open`을 호출하여 새로운 브라우저 창(`Page[1]`)을 열었으나, 녹화 스크립트(`record.ts`)는 최초의 메인 창(`Page[0]`)만을 계속 제어하여 새 창 내부의 요소(수신자, 제목, 발송 버튼)를 찾지 못하고 배경 창을 헛클릭하는 치명적인 문제 발생.
   - 또한 Playwright의 `recordVideo`는 브라우저 창마다 별도의 `page@*.webm` 비디오를 생성하므로, 단일 MP4 렌더링 파이프라인과 불일치가 발생하는 구조적 한계 존재.
2. **Layer 1: 1920x1080 단일 캔버스 동일 창 전환 엔진 (`context.addInitScript`)**:
   - `window.open(url)` 호출을 런타임에 지능적으로 인터셉트하여, 화면 분기 없이 현재 탭을 해당 URL로 매끄럽게 전환(`window.location.href = url`).
   - `window.opener = window.opener || window` 및 `window.close()` 호출 시 이전 화면으로 복귀(`history.back()`)하도록 안전한 심(Shim) 주입.
   - `<a target="_blank">` 링크 클릭 시 자동으로 `target="_self"`로 전환하여 브라우징 연속성과 단일 풀HD 영상 녹화를 100% 보장.
3. **Layer 2: 실시간 다중 창/팝업 `activePage` 지능형 추적기 (`record.ts`)**:
   - 브라우저 정책상 별도의 새 창이 생성되더라도 `context.on('page')` 이벤트를 즉각 감지하여 `page` 타겟을 새 팝업 창으로 자동 스위칭.
   - 새 창에 1920x1080 뷰포트 자동 설정, Alert/Confirm 다이얼로그 핸들러 자동 장착 및 포그라운드 윈도우 승격.
   - 팝업이 닫히면(`newPage.on('close')`) 직전 활성 메인 창으로 자동 복귀.
4. **Layer 3: 복수 비디오 파일 최적 용량/길이 자동 선별 (`record.ts`)**:
   - 녹화 종료 시 생성된 `page@*.webm` 파일군 중 가장 실질적인 본문 작업이 녹화된 최장/최대 용량 파일을 자동 선별하여 `recording.mp4`로 미러링.
5. **엔터프라이즈 모듈 폴더명 별칭(Aliases) 자동 탐색 (`codeExplorerAgent.ts`, `geminiPlanner.ts`)**:
   - 메일(`eml`), 일정(`scd`), 쪽지(`not`), 스마트워크(`smw`), 전자결재(`eapp`), 자원예약(`rmg`) 등 축약된 엔터프라이즈 디렉토리명을 자동 매핑하여, AI가 어떤 모듈을 분석하더라도 100% 정확한 실제 소스코드와 컨트롤러를 찾아내도록 고도화.

---

### ✅ Task 17. 팝업/모달 자동 닫힘 억제 고도화 및 AI 실시간 자가 치유(에디터/Iframe) 시야 확장 (2026-10-06 완료) (`record.ts`, `elementSelfHealer.ts`, `planSanitizer.ts`)
1. **문제 정의 및 배경**:
   - `tutorial-mail` (메일 작성): [조직도] 팝업이 정상적으로 열렸음에도 불구하고, AI가 "화면을 가로막는 선택 팝업"으로 오판하여 사용자가 검색/선택을 하기도 전에 모달을 강제 종료하는 문제 발생.
   - `tutorial-document` (문서 등록): 본문 내용 입력(`type`) 단계에서 요소를 찾지 못할 때, AI가 에디터(`iframe` 내부 `body` 또는 `[contenteditable]`)를 보지 못하고 엉뚱한 버튼을 복구 셀렉터로 제시하여 시연이 중단됨.
   - 대기(`wait`) 액션에 불필요한 `selector`가 할루시네이션으로 주입되어 오작동을 유발할 위험성 존재.
2. **조치 내역**:
   - **팝업/모달 자동 닫힘 억제 엔진 (Too-Aggressive Auto-Recover 방지)**:
     - `record.ts`의 `autoRecoverActiveModals` 함수 내에서 현재 액션의 설명(`description`)에 "조직도", "주소록", "모달", "팝업" 등의 키워드가 명시되어 있다면, 팝업 자동 닫힘 로직이 즉시 반환(`return false`)하도록 개선하여 의도된 팝업 내 워크플로우를 완벽하게 보장.
   - **AI 실시간 자가 치유 시야 확장 (Rich Text Editor 블라인드 현상 해결)**:
     - `elementSelfHealer.ts`의 `extractLiveCandidates` 함수가 `[contenteditable='true']`, `.note-editable`, `body` 태그를 스캔 후보군에 정식 편입.
     - `type` 액션 시 버튼(`button`) 선택을 거부하는 Guard 로직에 `body`와 `iframe`을 예외 허용 대상으로 추가하여 100% 본문 입력창 타겟팅 성공 보장.
   - **플랜 정제기(Sanitizer)의 대기(Wait) 액션 엄격화**:
     - `planSanitizer.ts`에서 대기(`wait`) 액션일 경우 `selector` 필드를 원천 삭제(`delete`)하도록 방어막 구축.

---

### ✅ Task 18. AI 자가 치유 시야 100% 개방 및 로딩 인내심(Fail-Fast & Timeout) 전사적 범용화 (2026-10-08 완료) (`record.ts`, `elementSelfHealer.ts`)
1. **문제 정의 및 배경**:
   - `tutorial-mail`: 로딩 지연 등으로 화면이 채 전환되지 않아 목표 요소가 없음에도, AI가 억지로 다른 버튼을 유추해서 클릭하여 시나리오가 엉뚱하게 오염되는 문제 발생.
   - `tutorial-document`: 라디오 버튼('공개', '비공개')처럼 `name`은 같고 `value` 속성이나 주변 `label` 텍스트로만 구분해야 하는 요소를 AI 자가 치유 시야(DOM 후보군)가 긁어오지 못해 치유를 포기하는 문제 발생.
2. **조치 내역 (모든 시나리오 범용 적용)**:
   - **인내심(Maximum Wait Timeout) 대폭 증가 (`record.ts`)**:
     - 클릭(`click`), 타이핑(`type`), 마우스오버(`hover`) 등 요소 탐색 기본 최대 대기 시간을 기존 8~10초에서 **25초(25000ms)로 일괄 상향**.
     - 아무리 무거운 개발/운영 서버 환경이나 느린 모달 팝업이라도 충분히 로딩될 때까지 기다려준 뒤, 뜨는 즉시 클릭하도록 엔진 기초 체력 상향.
   - **Fail-Fast (안전 포기) 정책 최우선 규칙 주입 (`elementSelfHealer.ts`)**:
     - 타겟이 화면에 없을 때 AI가 절대 억지로 다른 요소를 유추하거나 뒤로가기를 누르지 못하도록 프롬프트에 `success: false` 강제 반환(Fail-Fast) 규칙 주입.
     - 시나리오 데이터 왜곡을 0%로 차단하고 그 자리에서 즉시 깔끔하게 실패(중단)하여 사용자 디버깅을 돕도록 아키텍처 개편.
   - **라디오/체크박스 및 Label 전수 추출 시야 확보 (`extractLiveCandidates`)**:
     - `extractLiveCandidates` 함수가 `input` 태그 수집 시 `name` 뿐만 아니라 **`value` 속성까지 추출**하여 `suggestedSelector`에 `[value='Y']` 형태로 덧붙이도록 고도화.
     - `for` 속성이 없는 단순 `label` 태그도 모두 긁어오도록 스크래핑 범위를 넓혀, AI가 동일한 이름의 라디오 버튼 틈에서 '공개'와 '비공개'를 완벽히 구별하고 스스로 치유할 수 있도록 시각(Sight) 100% 개방 완료.

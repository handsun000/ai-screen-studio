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

## 5. 내일(2026-10-02) 최우선 착수 액션 플랜

### 🎯 Task 1. 마우스 클릭 좌표 정밀 타겟팅 엔진 고도화 (`scripts/record.ts`)
* **말단 인터랙티브 요소 자동 핀포인트 탐색**:
  * 지정된 셀렉터의 크기가 너무 크거나(예: width > 300px 또는 height > 80px) `div/form/p` 컨테이너인 경우, 그 내부에서 실제 클릭 대상인 가장 작은 자식 요소(`button`, `input`, `a`, `span.txt`)를 자동으로 찾아 그 중심점을 클릭 좌표로 설정.
* **좌표 안착 대기 (`waitForSettled`)**:
  * 클릭 전 100ms 간격으로 `boundingBox()`를 2회 측정하여 좌표 변화율이 0(완전히 정지)일 때 클릭 및 마우스 모멘트 기록.
* **시각적 클릭 마커(Click Visualizer) 녹화 옵션**:
  * 실제 클릭이 일어난 좌표에 반투명 링(Ripple Effect)을 화면에 0.4초간 잠깐 표시하여, 영상 자체에서 클릭 위치가 맞았는지 직관적으로 검증할 수 있도록 지원.

### 🎯 Task 2. 시나리오 AI 프롬프트 셀렉터 정밀도 가이드 강화 (`tutorialTemplates.ts`, `geminiPlanner.ts`)
* 프롬프트 시스템 지침에 **"정밀 말단 셀렉터 원칙(Atomic Selector Rule)"** 추가:
  * ❌ 금지: 부모 래퍼(`div`, `form`, `ul`, `tr`, 큰 `label`)
  * ✅ 권장: 사용자가 손가락으로 누르는 실제 인터랙티브 엘리먼트(`button:has-text('...')`, `a.menu_item`, `input#id`, `input[type='checkbox'] + label`)
* 그룹웨어 주요 인터랙션(메뉴 클릭, 팝업 버튼, 체크박스 토글 등)에 대한 고정밀 Few-shot 매핑 테이블 보강.

### 🎯 Task 3. 대시보드 타임라인에서 클릭 좌표(X, Y) 및 줌 센터 수동 미세 조정(Offset) 기능 지원
* 웹 대시보드 액션 카드에서 필요 시 `cursorOffset: { x: +10, y: -5 }` 등을 미세 조정할 수 있는 UI 옵션 제공 (완전 자동 + 세부 튜닝 양방향 지원).

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
* **`GEMINI_MODEL`**: `gemini-3.5-flash-lite` (안정형 저지연 모델)
* **`TARGET_PROJECT_PATH`**: `C:/dev/IdeaProjects/unison/unison_gw` (또는 `bc2026_gw`)
* **`TARGET_BASE_URL`**: `https://gwdev.unison.co.kr/`
* **인증 파일 상태**: `data/create-and-submit/auth.json` 세션 유효 (반복 로그인 불필요)

// State Management
let currentPlan = null;
let currentSlug = "";
let currentExplanation = "";
let selectedScenario = null;
let scenarioDetailsCache = {};
let sseSource = null;
let currentProjectAnalysis = null;

// DOM Elements
const tabBtns = document.querySelectorAll(".tab-btn");
const tabPanes = document.querySelectorAll(".tab-pane");

const promptInput = document.getElementById("prompt-input");
const slugInput = document.getElementById("slug-input");
const headedToggle = document.getElementById("headed-toggle");
const loginToggle = document.getElementById("login-toggle");

if (headedToggle) {
  if (localStorage.getItem("screen_demo_headed") !== null) {
    headedToggle.checked = localStorage.getItem("screen_demo_headed") === "true";
  }
  headedToggle.addEventListener("change", () => {
    localStorage.setItem("screen_demo_headed", headedToggle.checked);
  });
}
const btnGenerate = document.getElementById("btn-generate");
const generateBtnText = document.getElementById("generate-btn-text");
const aiProgressBar = document.getElementById("ai-progress-bar");
const aiProgressText = document.getElementById("ai-progress-text");
const actionSpecContainer = document.getElementById("action-spec-container");
const btnToggleActionSpec = document.getElementById("btn-toggle-action-spec");
const actionSpecBody = document.getElementById("action-spec-body");
const actionSpecContent = document.getElementById("action-spec-content");
const specToggleLabel = document.getElementById("spec-toggle-label");

const targetProjectPathInput = document.getElementById("target-project-path");
const targetBaseUrlInput = document.getElementById("target-base-url");
const btnValidateProject = document.getElementById("btn-validate-project");
const pillProjectName = document.getElementById("pill-project-name");
const projectStatusBadge = document.getElementById("project-status-badge");
const projectStatusText = document.getElementById("project-status-text");
const metaProjectType = document.getElementById("meta-project-type");
const metaDocsTags = document.getElementById("meta-docs-tags");
const pillGw = document.getElementById("pill-gw");

const actionsList = document.getElementById("actions-list");
const planSlugBadge = document.getElementById("plan-slug-badge");
const explanationText = document.getElementById("explanation-text");
const btnAddAction = document.getElementById("btn-add-action");
const btnAddActionTop = document.getElementById("btn-add-action-top");
const btnBlockPresets = document.getElementById("btn-block-presets");
const menuBlockPresets = document.getElementById("menu-block-presets");
const btnSavePlan = document.getElementById("btn-save-plan");
const btnRunPipeline = document.getElementById("btn-run-pipeline");
const btnRenderVideo = document.getElementById("btn-render-video");

const scenarioCardsContainer = document.getElementById("scenario-cards-container");
const scenariosCount = document.getElementById("scenarios-count");
const playerTitle = document.getElementById("player-title");
const playerMeta = document.getElementById("player-meta");
const videoPlayer = document.getElementById("demo-video-player");
const videoEmpty = document.getElementById("video-empty");
const btnSetActive = document.getElementById("btn-set-active");
const btnReRecord = document.getElementById("btn-re-record");
const btnPlayerRender = document.getElementById("btn-player-render");
const btnDownloadVideo = document.getElementById("btn-download-video");
const btnModeRaw = document.getElementById("btn-mode-raw");
const btnModeRendered = document.getElementById("btn-mode-rendered");
const videoModeBadge = document.getElementById("video-mode-badge");
let currentVideoMode = "raw"; // "raw" | "rendered"
const timelineVisualBar = document.getElementById("timeline-visual-bar");
const timelineStats = document.getElementById("timeline-stats");
const jsonViewerContent = document.getElementById("json-viewer-content");
const jsonTabBtns = document.querySelectorAll(".json-tab-btn");

const terminalOutput = document.getElementById("terminal-output");
const terminalStatusText = document.getElementById("terminal-status-text");
const btnClearTerminal = document.getElementById("btn-clear-terminal");
const btnStopTask = document.getElementById("btn-stop-task");
const activeSlugLabel = document.getElementById("current-active-slug");

const terminalLoginBanner = document.getElementById("terminal-login-banner");
const btnBannerEnter = document.getElementById("btn-banner-enter");
const terminalInputText = document.getElementById("terminal-input-text");
const btnTerminalSend = document.getElementById("btn-terminal-send");

// Initialization
document.addEventListener("DOMContentLoaded", () => {
  initTabs();
  fetchTemplates();
  initSSE();
  fetchConfig();
  fetchStatus();
  fetchScenarios();
  bindEvents();
});

// 1. Tab Navigation
function initTabs() {
  tabBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      const tabId = btn.getAttribute("data-tab");
      switchTab(tabId);
    });
  });
}

function switchTab(tabId) {
  tabBtns.forEach((b) => b.classList.toggle("active", b.getAttribute("data-tab") === tabId));
  tabPanes.forEach((p) => p.classList.toggle("active", p.id === tabId));
}

const templateCardsGrid = document.getElementById("template-cards-grid");
const phasesStepsList = document.getElementById("phases-steps-list");
const btnClearPrompt = document.getElementById("btn-clear-prompt");
const directingStyleSelect = document.getElementById("directing-style-select");

// 2. Universal Scenario Templates
async function fetchTemplates() {
  // Removed per user request to simplify UI
}

// 3. Dynamic Project Config & Status
async function fetchConfig() {
  try {
    const res = await fetch("/api/config");
    const data = await res.json();
    const config = data.config;
    const analysis = data.analysis;
    currentProjectAnalysis = analysis;

    targetProjectPathInput.value = config.targetProjectPath || "";
    targetBaseUrlInput.value = config.targetBaseUrl || "";

    updateProjectAnalysisUI(analysis);
  } catch (err) {
    console.error("fetchConfig failed:", err);
  }
}

function updateProjectAnalysisUI(analysis) {
  if (!analysis) return;

  const dot = projectStatusBadge.querySelector(".status-dot");

  if (analysis.exists) {
    if (!analysis.path) {
      pillProjectName.textContent = `🌐 Live URL 모드`;
      dot.style.background = "var(--success-color)";
      dot.style.boxShadow = "0 0 8px var(--success-glow)";
      projectStatusText.textContent = `Live Web 모드 (로컬 소스코드 불필요)`;
      metaProjectType.textContent = `${analysis.projectType} - ${analysis.sourceSummary}`;
      metaDocsTags.innerHTML = '<span style="color:var(--text-muted)">실시간 브라우저 DOM 자동 탐색 가동</span>';
    } else {
      pillProjectName.textContent = `${analysis.projectName} 연동됨`;
      dot.style.background = "var(--success-color)";
      dot.style.boxShadow = "0 0 8px var(--success-glow)";
      projectStatusText.textContent = `${analysis.projectName} (${analysis.projectType})`;
      metaProjectType.textContent = `${analysis.projectType} - ${analysis.sourceSummary}`;

      metaDocsTags.innerHTML = "";
      if (analysis.docFiles && analysis.docFiles.length > 0) {
        analysis.docFiles.forEach((doc) => {
          const span = document.createElement("span");
          span.className = "doc-tag";
          span.textContent = `📄 ${doc}`;
          metaDocsTags.appendChild(span);
        });
      } else {
        metaDocsTags.innerHTML = '<span style="color:var(--text-muted)">문서 파일 없음 (.md)</span>';
      }
    }
  } else {
    pillProjectName.textContent = "경로 불일치";
    dot.style.background = "var(--danger-color)";
    dot.style.boxShadow = "0 0 8px rgba(239, 68, 68, 0.4)";
    projectStatusText.textContent = "로컬 경로 확인 필요 (비워두면 Live URL 모드로 동작)";
    metaProjectType.textContent = analysis.sourceSummary;
    metaDocsTags.innerHTML = '<span style="color:var(--danger-color)">경로가 올바르지 않습니다 (비워두시면 자동 Live URL 모드로 전환됩니다)</span>';
  }
}

async function handleSaveConfig() {
  const targetProjectPath = targetProjectPathInput.value.trim();
  const targetBaseUrl = targetBaseUrlInput.value.trim();

  if (!targetBaseUrl) {
    alert("접속 대상 서비스 URL(Target Base URL)을 입력해주세요.");
    return;
  }

  btnValidateProject.disabled = true;
  btnValidateProject.textContent = "저장 중...";

  try {
    const res = await fetch("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetProjectPath, targetBaseUrl }),
    });

    const data = await res.json();
    updateProjectAnalysisUI(data.analysis);

    if (!targetProjectPath) {
      alert(`타겟 설정이 저장되었습니다!\n- 접속 URL: ${data.config.targetBaseUrl}\n- 동작 모드: 순수 실시간 웹(Live URL) 모드 (로컬 소스코드 불필요)`);
    } else if (data.analysis.exists) {
      alert(`타겟 프로젝트가 성공적으로 변경되었습니다!\n- 프로젝트: ${data.analysis.projectName}\n- 경로: ${data.analysis.path}\n- 타입: ${data.analysis.projectType}`);
    } else {
      alert(`경고: 입력하신 로컬 경로가 존재하지 않습니다.\n${targetProjectPath}\n(경로를 비워두시면 Live URL 모드로 동작합니다.)`);
    }
  } catch (err) {
    alert("설정 저장 실패: " + err.message);
  } finally {
    btnValidateProject.disabled = false;
    btnValidateProject.textContent = "💾 설정 저장";
  }
}

// 4. API Status
async function fetchStatus() {
  try {
    const res = await fetch("/api/status");
    const data = await res.json();

    activeSlugLabel.textContent = data.activeSlug || "none";

    const pillAi = document.getElementById("pill-ai");
    if (data.geminiApiKeySet) {
      pillAi.innerHTML = `<span class="status-dot"></span><span>${data.geminiModel}</span>`;
      pillAi.title = `API Key: ${data.geminiApiKeyPreview}`;
    } else {
      pillAi.innerHTML = `<span class="status-dot" style="background:#EF4444"></span><span>Gemini Key 미설정</span>`;
    }
  } catch (err) {
    console.error("fetchStatus failed:", err);
  }
}

// 5. Scenarios List
async function fetchScenarios() {
  try {
    const res = await fetch("/api/scenarios");
    const data = await res.json();
    const scenarios = data.scenarios || [];

    scenariosCount.textContent = `${scenarios.length}개`;
    scenarioCardsContainer.innerHTML = "";

    scenarios.forEach((s) => {
      const item = document.createElement("div");
      item.className = `scenario-item ${s.isActive ? "active-scenario" : ""}`;
      if (selectedScenario === s.slug) item.classList.add("selected");

      item.innerHTML = `
        <div class="scenario-item-header">
          <span class="scenario-slug">${s.slug}</span>
          ${s.isActive ? '<span class="active-tag">Active</span>' : ""}
        </div>
        <div class="scenario-meta-row">
          <span>액션: ${s.actionsCount}개</span>
          <span>줌: ${s.zoomSegmentsCount}구간</span>
          ${s.durationSec ? `<span>${s.durationSec}초</span>` : ""}
          <span class="${s.hasVideo ? "has-video-tag" : ""}">${s.hasVideo ? "🎥 비디오 있음" : "녹화 전"}</span>
        </div>
      `;

      item.addEventListener("click", () => selectScenario(s.slug));
      scenarioCardsContainer.appendChild(item);
    });

    // Auto-select first or active
    if (!selectedScenario && scenarios.length > 0) {
      const target = scenarios.find((s) => s.isActive) || scenarios[0];
      selectScenario(target.slug);
    }
  } catch (err) {
    console.error("fetchScenarios failed:", err);
  }
}

// 6. Select & View Scenario
async function selectScenario(slug, preferMode = null) {
  selectedScenario = slug;

  document.querySelectorAll(".scenario-item").forEach((el) => {
    el.classList.toggle("selected", el.querySelector(".scenario-slug").textContent === slug);
  });

  playerTitle.textContent = slug;
  playerMeta.textContent = "상세 정보 불러오는 중...";

  try {
    const res = await fetch(`/api/scenarios/${slug}`);
    const details = await res.json();
    scenarioDetailsCache[slug] = details;

    playerMeta.textContent = `액션 ${details.browsePlan?.actions?.length || 0}개 | 줌 세그먼트 ${details.editPlan?.segments?.length || 0}개`;

    // Check Rendered Video Info
    let renderInfo = { exists: false };
    try {
      const renderRes = await fetch(`/api/render/info/${slug}`);
      if (renderRes.ok) {
        renderInfo = await renderRes.json();
      }
    } catch { }

    if (btnDownloadVideo) {
      if (renderInfo.exists) {
        btnDownloadVideo.classList.remove("hidden");
        btnDownloadVideo.href = renderInfo.downloadUrl;
        btnDownloadVideo.download = `${slug}-final.mp4`;
        const sizeMb = ((renderInfo.fileSizeBytes || 0) / (1024 * 1024)).toFixed(1);
        btnDownloadVideo.innerHTML = `💾 최종 MP4 다운로드 <small>(${sizeMb}MB)</small>`;
      } else {
        btnDownloadVideo.classList.add("hidden");
      }
    }

    // Determine video playback mode
    const targetMode = preferMode || (renderInfo.exists && currentVideoMode === "rendered" ? "rendered" : "raw");
    setVideoMode(targetMode, details, renderInfo);

    renderTimelineVisual(details);
    updateJsonViewer("browse");
  } catch (err) {
    console.error("selectScenario failed:", err);
  }
}

function setVideoMode(mode, details = null, renderInfo = null) {
  if (!selectedScenario) return;
  const slug = selectedScenario;
  const d = details || scenarioDetailsCache[slug] || {};

  currentVideoMode = mode;

  if (btnModeRaw) btnModeRaw.classList.toggle("active", mode === "raw");
  if (btnModeRendered) btnModeRendered.classList.toggle("active", mode === "rendered");

  if (mode === "rendered") {
    // Check if rendered video actually exists
    const hasRendered = renderInfo ? renderInfo.exists : (d.hasRenderedVideo || false);
    if (!hasRendered) {
      if (videoModeBadge) videoModeBadge.textContent = "최종 렌더링 파일 없음 (렌더링 필요)";
      videoPlayer.style.display = "none";
      videoEmpty.style.display = "flex";
      videoEmpty.querySelector("p").textContent = "최종 렌더링(합성)된 MP4 비디오가 없습니다.";
      videoEmpty.querySelector("span").textContent = "[🎞️ 최종 MP4 렌더링] 버튼을 눌러 비디오를 추출하세요.";
      return;
    }

    if (videoModeBadge) videoModeBadge.textContent = "✨ 줌/커서 합성 최종본 재생 중";
    videoEmpty.style.display = "none";
    videoPlayer.style.display = "block";
    videoPlayer.src = `/api/rendered-video/${slug}?t=${Date.now()}`;
  } else {
    // Raw recording mode
    if (d.hasVideo) {
      if (videoModeBadge) videoModeBadge.textContent = "📹 원본 브라우저 녹화본 재생 중";
      videoEmpty.style.display = "none";
      videoPlayer.style.display = "block";
      videoPlayer.src = `${d.videoUrl || `/api/video/${slug}`}?t=${Date.now()}`;
    } else {
      if (videoModeBadge) videoModeBadge.textContent = "녹화 비디오 없음";
      videoEmpty.style.display = "flex";
      videoPlayer.style.display = "none";
      videoPlayer.src = "";
    }
  }
}

// 7. Timeline Visual Bar
function renderTimelineVisual(details) {
  timelineVisualBar.innerHTML = "";
  const editPlan = details.editPlan;
  const moments = details.moments;

  if (!editPlan || !editPlan.totalDurationFrames) {
    timelineStats.textContent = "플랜 데이터 없음";
    return;
  }

  const totalFrames = editPlan.totalDurationFrames;
  const fps = editPlan.fps || 60;
  const totalMs = (totalFrames / fps) * 1000;

  const segments = editPlan.segments || [];
  const clickMoments = moments?.moments?.filter((m) => m.type === "click") || [];

  timelineStats.textContent = `${segments.length} Segments, ${clickMoments.length} Clicks (${(totalFrames / fps).toFixed(1)}s)`;

  // Draw Zoom Segments
  segments.forEach((seg) => {
    const leftPercent = (seg.startFrame / totalFrames) * 100;
    const widthPercent = ((seg.endFrame - seg.startFrame) / totalFrames) * 100;

    const block = document.createElement("div");
    block.className = "segment-block";
    block.style.left = `${leftPercent}%`;
    block.style.width = `${Math.max(1, widthPercent)}%`;
    block.title = `${seg.description} (${(seg.startFrame / fps).toFixed(1)}s - ${(seg.endFrame / fps).toFixed(1)}s, ${seg.zoom}x)`;
    timelineVisualBar.appendChild(block);
  });

  // Draw Click Moment Markers
  clickMoments.forEach((m) => {
    const leftPercent = (m.timestamp / totalMs) * 100;
    const marker = document.createElement("div");
    marker.className = "moment-marker";
    marker.style.left = `${leftPercent}%`;
    marker.title = `[Click #${m.id}] ${m.description} (${(m.timestamp / 1000).toFixed(2)}s)`;

    marker.addEventListener("click", () => {
      if (videoPlayer.duration) {
        videoPlayer.currentTime = m.timestamp / 1000;
        videoPlayer.play();
      }
    });

    timelineVisualBar.appendChild(marker);
  });
}

// 8. JSON Viewer
function updateJsonViewer(type) {
  const details = scenarioDetailsCache[selectedScenario];
  if (!details) return;

  jsonTabBtns.forEach((btn) => {
    btn.classList.toggle("active", btn.getAttribute("data-json") === type);
  });

  let data = null;
  if (type === "browse") data = details.browsePlan;
  else if (type === "edit") data = details.editPlan;
  else if (type === "moments") data = details.moments;

  jsonViewerContent.textContent = data ? JSON.stringify(data, null, 2) : "데이터가 없습니다.";
}

// 9. Generate Browse Plan via Gemini (with 2-Stage Code Explorer Agent & Video Directing)
async function handleGeneratePlan() {
  const prompt = promptInput.value.trim();
  if (!prompt) {
    alert("시나리오 상세 설명을 입력해주세요.");
    promptInput.focus();
    return;
  }

  const targetProjectPath = targetProjectPathInput.value.trim();
  const targetUrl = targetBaseUrlInput.value.trim();

  btnGenerate.disabled = true;
  generateBtnText.textContent = "AI 코드 분석 및 시나리오 연출 중...";

  if (aiProgressBar) {
    aiProgressBar.classList.remove("hidden");
    if (aiProgressText) {
      if (targetProjectPath) {
        aiProgressText.textContent = "🔍 [1단계: 소스코드 역공학] 타겟 프로젝트 코드 및 DOM 셀렉터 탐색 시작...";
      } else {
        aiProgressText.textContent = "🌐 [Live Web 모드] 실시간 대상 웹 서비스 URL 기반 5단계 시나리오 연출 중...";
      }
    }
  }

  // Connect SSE for real-time progress updates
  let progressEventSource = null;
  try {
    progressEventSource = new EventSource("/api/gemini/stream-progress");
    progressEventSource.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (payload.progress && aiProgressText) {
          aiProgressText.textContent = payload.progress;
        }
      } catch { }
    };
  } catch (sseErr) {
    console.warn("Progress SSE connection failed:", sseErr);
  }

  try {
    const slug = slugInput.value.trim();
    const directingStyleSelect = document.getElementById("directing-style-select");
    const directingStyle = directingStyleSelect ? directingStyleSelect.value : "standard";
    const depthSelect = document.getElementById("scenario-depth-select");
    const depth = depthSelect ? depthSelect.value : "standard";
    const cacheToggle = document.getElementById("cache-toggle");
    const bypassCache = cacheToggle ? !cacheToggle.checked : false;

    const res = await fetch("/api/scenarios/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt,
        slug,
        targetProjectPath,
        targetUrl,
        directingStyle,
        depth,
        bypassCache,
      }),
    });

    if (!res.ok) {
      const errData = await res.json();
      throw new Error(errData.error || "플랜 생성 실패");
    }

    const data = await res.json();
    currentPlan = data.plan;
    currentSlug = data.suggestedSlug;
    currentExplanation = data.explanation;

    slugInput.value = currentSlug;

    if (data.isFromCache) {
      planSlugBadge.textContent = `시나리오: ${currentSlug} ⚡ (캐시 적중 - 토큰 소모 0)`;
      explanationText.textContent = `⚡ [캐시 적중] 동일한 시나리오 분석 결과가 캐시에 보관되어 있어 AI API 호출 없이 0.05초 만에 즉시 불러왔습니다.\n\n${currentExplanation}`;
    } else {
      planSlugBadge.textContent = `시나리오: ${currentSlug}`;
      explanationText.textContent = currentExplanation;
    }

    // Display Action Spec if available
    if (data.actionSpecMarkdown && actionSpecContainer && actionSpecContent) {
      actionSpecContainer.classList.remove("hidden");
      actionSpecContent.textContent = data.actionSpecMarkdown;
      if (actionSpecBody) actionSpecBody.classList.remove("hidden");
      if (specToggleLabel) specToggleLabel.textContent = "▲ 접기";
    }

    renderActionCards();
  } catch (err) {
    alert("Gemini 플랜 생성 중 오류: " + err.message);
  } finally {
    if (progressEventSource) {
      progressEventSource.close();
    }
    if (aiProgressBar) {
      aiProgressBar.classList.add("hidden");
    }
    btnGenerate.disabled = false;
    generateBtnText.textContent = "Gemini로 시나리오 생성";
  }
}

// 10. Action Manipulation & Rendering
let draggedActionIndex = null;

const SMART_PRESET_BLOCKS = {
  title: [
    { type: "wait", ms: 1200, description: "제목 입력창 포커스 대기" },
    {
      type: "type",
      selector: "input#docTitle:visible, input[name*='title']:visible, input[placeholder*='제목']:visible, [title*='문서제목'] input",
      text: "2026학년도 대학 업무 개선 계획서",
      description: "문서 제목 입력 ('2026학년도 대학 업무 개선 계획서')",
      iframe: "iframe[name*='docBox'], iframe[src*='frmFormletUiFrame']",
    },
    { type: "wait", ms: 1000, description: "제목 입력 확인 대기" },
  ],
  apprLine: [
    {
      type: "click",
      selector: "button:has(.ico_org), a:has(.ico_org), button:has-text('조직도'), button:has-text('결재선')",
      description: "결재선 / 조직도 팝업 열기",
    },
    { type: "wait", ms: 2500, description: "조직도 팝업 로딩 대기" },
    {
      type: "click",
      selector: ".ui-dialog:visible .dynatree-expander, .ui-dialog:visible .folder, .ui-dialog:visible .dynatree-node:first-child .dynatree-expander",
      description: "조직도 부서 트리 확장 클릭",
    },
    { type: "wait", ms: 1500, description: "하위 조직 구성원 로딩 대기" },
    {
      type: "click",
      selector: ".ui-dialog:visible input[type='checkbox'], .ui-dialog:visible .dynatree-checkbox",
      description: "조직도에서 결재자 선택 체크",
    },
    {
      type: "click",
      selector: ".ui-dialog:visible button:has-text('확인'), .ui-dialog:visible button:has-text('적용')",
      description: "결재선 지정 [확인] 버튼 클릭",
    },
    { type: "wait", ms: 1500, description: "결재선 반영 대기" },
  ],
  editorBody: [
    {
      type: "click",
      selector: "div[contenteditable='true'], textarea#content, iframe[name*='editor']",
      description: "본문 에디터 영역 포커스 클릭",
    },
    {
      type: "type",
      selector: "div[contenteditable='true'], textarea#content",
      text: "본 계획서에 따른 세부 추진 일정을 검토 후 재가하여 주시기 바랍니다.",
      description: "본문 내용 작성 ('본 계획서에 따른 세부 추진 일정을...')",
    },
    { type: "wait", ms: 1200, description: "본문 입력 완료 대기" },
  ],
  submitConfirm: [
    {
      type: "click",
      selector: "button:has-text('상신'):visible, button:has-text('저장'):visible, button:has-text('등록'):visible",
      description: "기안문 [상신] 버튼 클릭",
    },
    { type: "wait", ms: 2000, description: "상신 처리 및 결과 다이얼로그 대기" },
    {
      type: "wait",
      ms: 3000,
      description: "상신 완료 화면 3초간 와이드 뷰 (아웃트로)",
    },
  ],
};

function insertBlockPreset(presetKey) {
  const actionsToAdd = SMART_PRESET_BLOCKS[presetKey];
  if (!actionsToAdd) return;
  const targetUrl = targetBaseUrlInput.value.trim() || "https://gwdev.bc.ac.kr/";
  if (!currentPlan) {
    currentPlan = {
      url: targetUrl,
      viewport: { width: 1920, height: 1080 },
      requiresLogin: true,
      actions: [],
    };
  }
  const startIndex = currentPlan.actions.length;
  currentPlan.actions.push(...JSON.parse(JSON.stringify(actionsToAdd)));
  renderActionCards();

  setTimeout(() => {
    const cards = actionsList.querySelectorAll(".action-item-card");
    if (cards[startIndex]) {
      cards[startIndex].scrollIntoView({ behavior: "smooth", block: "nearest" });
      cards[startIndex].style.borderColor = "#FBBF24";
      cards[startIndex].style.boxShadow = "0 0 20px rgba(251, 191, 36, 0.5)";
      setTimeout(() => {
        cards[startIndex].style.borderColor = "";
        cards[startIndex].style.boxShadow = "";
      }, 1500);
    }
  }, 50);
}

function createDefaultAction(type = "click", description = "새 액션") {
  return {
    type,
    selector: "",
    description,
    force: false,
  };
}

function insertActionAt(targetIndex, actionData = null) {
  const targetUrl = targetBaseUrlInput.value.trim() || "https://gwdev.bc.ac.kr/";
  if (!currentPlan) {
    currentPlan = {
      url: targetUrl,
      viewport: { width: 1920, height: 1080 },
      requiresLogin: true,
      actions: [],
    };
  }
  const newAction = actionData ? JSON.parse(JSON.stringify(actionData)) : createDefaultAction();
  const validIndex = Math.max(0, Math.min(targetIndex, currentPlan.actions.length));
  currentPlan.actions.splice(validIndex, 0, newAction);
  renderActionCards();

  setTimeout(() => {
    const cards = actionsList.querySelectorAll(".action-item-card");
    if (cards[validIndex]) {
      cards[validIndex].scrollIntoView({ behavior: "smooth", block: "nearest" });
      const descInput = cards[validIndex].querySelector('[data-field="description"]');
      if (descInput) descInput.focus();
      cards[validIndex].style.borderColor = "var(--accent-color)";
      cards[validIndex].style.boxShadow = "0 0 16px rgba(99, 102, 241, 0.5)";
      setTimeout(() => {
        cards[validIndex].style.borderColor = "";
        cards[validIndex].style.boxShadow = "";
      }, 1000);
    }
  }, 50);
}

function moveAction(fromIndex, toIndex) {
  if (!currentPlan || !currentPlan.actions) return;
  if (toIndex < 0 || toIndex >= currentPlan.actions.length || fromIndex === toIndex) return;
  const [moved] = currentPlan.actions.splice(fromIndex, 1);
  currentPlan.actions.splice(toIndex, 0, moved);
  renderActionCards();

  setTimeout(() => {
    const cards = actionsList.querySelectorAll(".action-item-card");
    if (cards[toIndex]) {
      cards[toIndex].scrollIntoView({ behavior: "smooth", block: "nearest" });
      cards[toIndex].style.borderColor = "#38BDF8";
      cards[toIndex].style.boxShadow = "0 0 16px rgba(56, 189, 248, 0.5)";
      setTimeout(() => {
        cards[toIndex].style.borderColor = "";
        cards[toIndex].style.boxShadow = "";
      }, 1000);
    }
  }, 50);
}

function duplicateAction(index) {
  if (!currentPlan || !currentPlan.actions || !currentPlan.actions[index]) return;
  const clone = JSON.parse(JSON.stringify(currentPlan.actions[index]));
  clone.description = `${clone.description || "액션"} (복제)`;
  insertActionAt(index + 1, clone);
}

function deleteAction(index) {
  if (!currentPlan || !currentPlan.actions) return;
  currentPlan.actions.splice(index, 1);
  renderActionCards();
}

function createInsertDivider(insertIndex) {
  const divider = document.createElement("div");
  divider.className = "action-insert-divider";
  divider.innerHTML = `
    <button class="btn-insert-inline" type="button" title="이 위치에 새 액션 삽입">
      <span>+</span> 여기에 액션 삽입
    </button>
  `;
  divider.querySelector("button").addEventListener("click", () => {
    insertActionAt(insertIndex);
  });
  return divider;
}

function escapeHtmlAttr(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Render Editable Action Cards
function renderActionCards() {
  actionsList.innerHTML = "";
  if (!currentPlan || !currentPlan.actions || currentPlan.actions.length === 0) {
    actionsList.innerHTML = `
      <div class="empty-state">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/></svg>
        <p>생성된 액션이 없습니다.</p>
        <button class="btn btn-sm btn-secondary" style="margin-top: 10px;" id="btn-empty-add-action">+ 첫 번째 액션 추가</button>
      </div>`;
    const btnEmptyAdd = document.getElementById("btn-empty-add-action");
    if (btnEmptyAdd) btnEmptyAdd.addEventListener("click", () => insertActionAt(0));
    return;
  }

  // Divider at top (index 0)
  actionsList.appendChild(createInsertDivider(0));

  const totalActions = currentPlan.actions.length;

  currentPlan.actions.forEach((act, idx) => {
    const card = document.createElement("div");
    card.className = "action-item-card";
    card.draggable = true;
    card.dataset.index = idx;

    const isMissingSelector = act.type !== "wait" && (!act.selector || act.selector.trim() === "");
    if (isMissingSelector) {
      card.classList.add("needs-selector");
    }

    const badgeClass = `badge-${act.type}`;

    card.innerHTML = `
      <div class="action-top-row">
        <div class="action-drag-handle" title="드래그하여 순서 변경 (Drag & Drop)">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <circle cx="9" cy="6" r="2"/><circle cx="15" cy="6" r="2"/>
            <circle cx="9" cy="12" r="2"/><circle cx="15" cy="12" r="2"/>
            <circle cx="9" cy="18" r="2"/><circle cx="15" cy="18" r="2"/>
          </svg>
        </div>
        <div class="action-badge-group">
          <span class="action-index">#${idx + 1}</span>
          <select class="action-badge ${badgeClass}" data-field="type">
            <option value="click" ${act.type === "click" ? "selected" : ""}>CLICK</option>
            <option value="wait" ${act.type === "wait" ? "selected" : ""}>WAIT</option>
            <option value="type" ${act.type === "type" ? "selected" : ""}>TYPE</option>
            <option value="hover" ${act.type === "hover" ? "selected" : ""}>HOVER</option>
            <option value="dblclick" ${act.type === "dblclick" ? "selected" : ""}>DBLCLICK</option>
            <option value="scroll" ${act.type === "scroll" ? "selected" : ""}>SCROLL</option>
            <option value="navigate" ${act.type === "navigate" ? "selected" : ""}>NAVIGATE</option>
          </select>
          ${isMissingSelector ? `<span class="badge-needs-input" title="소스코드에서 ID가 불확실하여 비워두었습니다. 직접 셀렉터나 버튼 텍스트를 입력해주세요.">⚠️ 셀렉터 입력 필요</span>` : ""}
          <input type="text" placeholder="액션 설명 (한글)" value="${escapeHtmlAttr(act.description)}" data-field="description" style="width: 240px; font-weight: 500;">
        </div>
        <div class="action-card-controls">
          <button class="action-ctrl-btn action-move-up" title="한 단계 위로 이동" ${idx === 0 ? "disabled" : ""}>▲</button>
          <button class="action-ctrl-btn action-move-down" title="한 단계 아래로 이동" ${idx === totalActions - 1 ? "disabled" : ""}>▼</button>
          <button class="action-ctrl-btn action-ctrl-insert action-insert-btn" title="이 액션 바로 아래에 새 액션 삽입">+ 아래 추가</button>
          <button class="action-ctrl-btn action-ctrl-duplicate action-duplicate-btn" title="이 액션 그대로 복제">복제</button>
          <button class="action-delete-btn" title="삭제">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
          </button>
        </div>
      </div>

      <div class="action-inputs-grid">
        ${act.type !== "wait" ? `
          <div class="input-with-label">
            <span class="input-label">🎯 대상 요소 (CSS 셀렉터)</span>
            <div class="selector-input-wrapper" style="display:flex; gap:8px; width:100%;">
              <input type="text" 
                class="${isMissingSelector ? "input-needs-attention" : ""}"
                placeholder="${isMissingSelector ? "⚠️ 셀렉터 직접 입력 또는 우측 [🎯 타겟 도우미]로 간편 생성" : "CSS 셀렉터 (예: button.btn_svc_open 또는 #savebtn)"}" 
                value="${escapeHtmlAttr(act.selector)}" 
                data-field="selector" style="flex:1;">
              <button type="button" class="btn-open-builder btn-toggle-builder" title="복잡한 CSS 몰라도 클릭 한 번으로 특정 버튼 셀렉터 완성">🎯 타겟 도우미</button>
            </div>
          </div>` : ""}
        ${act.type === "wait" ? `
          <div class="input-with-label">
            <span class="input-label">⏳ 딜레이 대기 시간 (ms)</span>
            <input type="number" placeholder="대기 시간(ms)" value="${act.ms || 2000}" data-field="ms">
          </div>` : ""}
        ${act.type === "type" ? `
          <div class="input-with-label">
            <span class="input-label">⌨️ 키보드로 입력할 텍스트</span>
            <input type="text" placeholder="입력할 텍스트" value="${escapeHtmlAttr(act.text)}" data-field="text">
          </div>` : ""}
        ${act.type !== "wait" ? `
          <div class="input-with-label">
            <span class="input-label">🪟 내부 iFrame (선택사항)</span>
            <input type="text" placeholder="iFrame 셀렉터 (옵션)" value="${escapeHtmlAttr(act.iframe)}" data-field="iframe">
          </div>` : ""}
      </div>

      ${act.type !== "wait" ? `
      <!-- 실시간 문법 린터 / 자동 교정 칩 컨테이너 -->
      <div class="linter-container" style="display: none; margin-top: 4px;"></div>

      <!-- 스마트 타겟 빌더 패널 (토글형) -->
      <div class="smart-target-builder hidden">
        <div class="builder-header">
          <span class="builder-title">🎯 스마트 타겟 빌더 (다중 버튼 충돌 방지)</span>
          <button type="button" class="builder-close-btn" title="닫기">✕</button>
        </div>
        
        <!-- 퀵 엔터프라이즈 프리셋 칩 -->
        <div class="builder-field-group">
          <span class="builder-field-label">⚡ 주요 급소 버튼 원클릭 퀵 선택:</span>
          <div class="builder-scope-chips">
            <button type="button" class="builder-chip preset-chip" data-preset="portal-menu">🔝 포탈 전체메뉴</button>
            <button type="button" class="builder-chip preset-chip" data-preset="sched-reg">👈 일정 등록 (사이드바)</button>
            <button type="button" class="builder-chip preset-chip" data-preset="modal-save">🪟 팝업 저장 (#savebtn)</button>
            <button type="button" class="builder-chip preset-chip" data-preset="modal-confirm">🪟 팝업 확인</button>
            <button type="button" class="builder-chip preset-chip" data-preset="appr-submit">📝 기안문 상신</button>
          </div>
        </div>

        <div class="builder-field-group">
          <span class="builder-field-label">📍 대상 버튼이 위치한 화면 영역 (다른 화면/헤더 버튼과 겹침 원천 방지!):</span>
          <div class="builder-scope-chips scope-selector-chips">
            <button type="button" class="builder-chip scope-chip active" data-scope="global">🌐 전체화면 (자동)</button>
            <button type="button" class="builder-chip scope-chip" data-scope="header">🔝 상단 헤더 / GNB</button>
            <button type="button" class="builder-chip scope-chip" data-scope="sidebar">👈 좌측 사이드바</button>
            <button type="button" class="builder-chip scope-chip" data-scope="modal">🪟 팝업 / 모달 내부</button>
            <button type="button" class="builder-chip scope-chip" data-scope="body">📄 본문 / 목록 화면</button>
          </div>
        </div>

        <div class="builder-field-group">
          <span class="builder-field-label">🔍 누를 버튼의 이름 (한글 텍스트 또는 클래스명):</span>
          <input type="text" class="builder-keyword-input" placeholder="예: 포탈 전체메뉴, 일정 등록, 저장, btn_svc_open" value="${escapeHtmlAttr(act.description ? act.description.replace(/[\[\]]/g, "").split(" ")[0] : "")}">
        </div>

        <div class="builder-preview-row">
          <span class="builder-preview-code">...</span>
          <button type="button" class="btn-apply-builder">✨ 이 셀렉터 적용</button>
        </div>
      </div>` : ""}

      ${isMissingSelector ? `
      <div class="quick-selector-hints">
        <span class="hint-label">💡 퀵 입력 헬퍼:</span>
        <button type="button" class="btn-quick-fill" data-fill="button.btn_svc_open, button[title='포탈 전체메뉴'], button:has-text('포탈 전체메뉴')">+ [포탈 전체메뉴] 버튼</button>
        <button type="button" class="btn-quick-fill" data-fill="button#reg_shedule_lefttop, button:has-text('일정 등록'):visible">+ [일정 등록] 버튼</button>
        <button type="button" class="btn-quick-fill" data-fill=".ui-dialog:visible #savebtn, .ui-dialog:visible button:has-text('저장')">+ [모달 저장] 버튼</button>
        <button type="button" class="btn-quick-fill" data-fill=".ui-dialog:visible button:has-text('확인')">+ [모달 확인] 버튼</button>
      </div>` : ""}

      <div class="action-options-row">
        <div class="action-checkboxes">
          <label><input type="checkbox" data-field="force" ${act.force ? "checked" : ""}> Force Click (강제 클릭)</label>
        </div>
        ${["click", "dblclick", "hover", "type"].includes(act.type) ? `
        <div class="action-offset-group" title="요소 중심점을 기준으로 마우스 클릭 및 카메라 줌 좌표를 미세 이동합니다 (예: X +10, Y -5)">
          <span class="offset-label">🎯 커서 오프셋:</span>
          <label class="offset-input-wrap">X <input type="number" class="offset-input" data-field="cursorOffsetX" placeholder="0" value="${act.cursorOffset?.x ?? ""}">px</label>
          <label class="offset-input-wrap">Y <input type="number" class="offset-input" data-field="cursorOffsetY" placeholder="0" value="${act.cursorOffset?.y ?? ""}">px</label>
        </div>` : ""}
      </div>
    `;

    // Bind Quick Fill Buttons
    card.querySelectorAll(".btn-quick-fill").forEach((btn) => {
      btn.addEventListener("click", () => {
        const fillValue = btn.getAttribute("data-fill");
        const selectorInput = card.querySelector('[data-field="selector"]');
        if (selectorInput && fillValue) {
          selectorInput.value = fillValue;
          act.selector = fillValue;
          renderActionCards();
        }
      });
    });

    // --- Smart Target Builder & Realtime Linter Logic ---
      const builderPanel = card.querySelector(".smart-target-builder");
      const btnToggleBuilder = card.querySelector(".btn-toggle-builder");
      const builderCloseBtn = card.querySelector(".builder-close-btn");
      const linterContainer = card.querySelector(".linter-container");
      const selectorInput = card.querySelector('[data-field="selector"]');
      const keywordInput = card.querySelector(".builder-keyword-input");
      const previewCode = card.querySelector(".builder-preview-code");
      const btnApplyBuilder = card.querySelector(".btn-apply-builder");
      let currentScope = "global";

      function updateBuilderPreview() {
        if (!keywordInput || !previewCode) return;
        const kw = keywordInput.value.trim();
        let generated = "";

        if (!kw) {
          generated = currentScope === "modal" ? ".ui-dialog:visible button" : "button";
        } else {
          const isClassLike = kw.startsWith(".") || (/^[a-zA-Z][a-zA-Z0-9_-]+$/.test(kw) && !kw.includes(" "));
          const baseTarget = isClassLike
            ? (kw.startsWith(".") ? kw : `.${kw}`)
            : `button:has-text('${kw}'):visible, a:has-text('${kw}'):visible`;

          switch (currentScope) {
            case "header":
              generated = `header ${baseTarget}, #header ${baseTarget}, .gnb ${baseTarget}, ${baseTarget}`;
              break;
            case "sidebar":
              generated = `#snb ${baseTarget}, #left ${baseTarget}, aside ${baseTarget}, ${baseTarget}`;
              break;
            case "modal":
              generated = `.ui-dialog:visible ${baseTarget}, .modal:visible ${baseTarget}`;
              break;
            case "body":
              generated = `#content ${baseTarget}, .list_container ${baseTarget}, ${baseTarget}`;
              break;
            default:
              generated = baseTarget;
          }
        }
        previewCode.textContent = generated;
      }

      if (btnToggleBuilder && builderPanel) {
        btnToggleBuilder.addEventListener("click", () => {
          builderPanel.classList.toggle("hidden");
          if (!builderPanel.classList.contains("hidden")) {
            updateBuilderPreview();
            if (keywordInput) keywordInput.focus();
          }
        });
      }

      if (builderCloseBtn && builderPanel) {
        builderCloseBtn.addEventListener("click", () => builderPanel.classList.add("hidden"));
      }

      // Scope Chips Selection
      card.querySelectorAll(".scope-chip").forEach((chip) => {
        chip.addEventListener("click", () => {
          card.querySelectorAll(".scope-chip").forEach((c) => c.classList.remove("active"));
          chip.classList.add("active");
          currentScope = chip.getAttribute("data-scope");
          updateBuilderPreview();
        });
      });

      if (keywordInput) {
        keywordInput.addEventListener("input", updateBuilderPreview);
      }

      if (btnApplyBuilder && previewCode && selectorInput) {
        btnApplyBuilder.addEventListener("click", () => {
          const selVal = previewCode.textContent.trim();
          if (selVal) {
            selectorInput.value = selVal;
            act.selector = selVal;
            renderActionCards();
          }
        });
      }

      // Presets in Builder
      const PRESET_SELECTORS = {
        "portal-menu": "button.btn_svc_open, button[title='포탈 전체메뉴'], button:has-text('포탈 전체메뉴')",
        "sched-reg": "button#reg_shedule_lefttop, #snb button:has-text('일정 등록'):visible, button:has-text('일정 등록'):visible",
        "modal-save": ".ui-dialog:visible #savebtn, .ui-dialog:visible button:has-text('저장'), button#savebtn:visible",
        "modal-confirm": ".ui-dialog:visible button:has-text('확인'), button:has-text('확인'):visible",
        "appr-submit": "button:has-text('상신'):visible, button:has-text('저장'):visible",
      };

      card.querySelectorAll(".preset-chip").forEach((chip) => {
        chip.addEventListener("click", () => {
          const key = chip.getAttribute("data-preset");
          const selVal = PRESET_SELECTORS[key];
          if (selVal && selectorInput) {
            selectorInput.value = selVal;
            act.selector = selVal;
            renderActionCards();
          }
        });
      });

      // Realtime Syntax Linter
      function checkSelectorSyntax(val) {
        if (!linterContainer) return;
        linterContainer.innerHTML = "";
        linterContainer.style.display = "none";
        if (!val) return;

        const trimmed = val.trim();
        // 1. Detect button:class_name typo
        const colonClassMatch = trimmed.match(/\b(button|a|div|span|input|li):([a-zA-Z][a-zA-Z0-9_-]*)\b/);
        if (colonClassMatch) {
          const [full, tag, cls] = colonClassMatch;
          const validPseudos = ["has-text", "visible", "first-child", "last-child", "nth-child", "not", "disabled", "checked"];
          if (!validPseudos.includes(cls)) {
            const suggested = trimmed.replace(full, `${tag}.${cls}`);
            linterContainer.style.display = "block";
            linterContainer.innerHTML = `
            <div class="syntax-linter-chip" title="클릭하여 즉시 교정">
              <span>💡 문법 오타 감지: <strong>${full}</strong> ➡️ <strong>${tag}.${cls}</strong> (콜론 대신 점 사용)</span>
              <span style="text-decoration: underline; font-weight: 700;">[✨ 자동 수정 적용]</span>
            </div>
          `;
            linterContainer.querySelector(".syntax-linter-chip").addEventListener("click", () => {
              selectorInput.value = suggested;
              act.selector = suggested;
              checkSelectorSyntax(suggested);
            });
            return;
          }
        }

        // 2. Detect bare class without dot
        if (/^[a-zA-Z][a-zA-Z0-9_-]+$/.test(trimmed) && !["button", "input", "textarea", "a", "select", "div"].includes(trimmed)) {
          const suggested = `button.${trimmed}, .${trimmed}`;
          linterContainer.style.display = "block";
          linterContainer.innerHTML = `
          <div class="syntax-linter-chip" title="클릭하여 즉시 교정">
            <span>💡 클래스 점(.) 누락 감지: <strong>${trimmed}</strong> ➡️ <strong>.${trimmed}</strong></span>
            <span style="text-decoration: underline; font-weight: 700;">[✨ 자동 수정 적용]</span>
          </div>
        `;
          linterContainer.querySelector(".syntax-linter-chip").addEventListener("click", () => {
            selectorInput.value = suggested;
            act.selector = suggested;
            checkSelectorSyntax(suggested);
          });
        }
      }

      if (selectorInput) {
        selectorInput.addEventListener("input", (e) => checkSelectorSyntax(e.target.value));
        checkSelectorSyntax(selectorInput.value);
      }

      // Bind Change Handlers
      card.querySelectorAll("[data-field]").forEach((input) => {
        input.addEventListener("input", () => {
          const field = input.getAttribute("data-field");
          if (field === "selector") {
            act.selector = input.value;
            const trimmed = input.value.trim();
            if (trimmed.length > 0) {
              card.classList.remove("needs-selector");
              input.classList.remove("input-needs-attention");
              const badge = card.querySelector(".badge-needs-input");
              if (badge) badge.remove();
            } else {
              card.classList.add("needs-selector");
              input.classList.add("input-needs-attention");
            }
          }
        });
        input.addEventListener("change", () => {
          const field = input.getAttribute("data-field");
          if (input.type === "checkbox") {
            act[field] = input.checked;
          } else if (field === "cursorOffsetX" || field === "cursorOffsetY") {
            if (!act.cursorOffset) act.cursorOffset = { x: 0, y: 0 };
            const val = input.value === "" ? 0 : parseInt(input.value, 10);
            if (field === "cursorOffsetX") act.cursorOffset.x = isNaN(val) ? 0 : val;
            if (field === "cursorOffsetY") act.cursorOffset.y = isNaN(val) ? 0 : val;
            if (act.cursorOffset.x === 0 && act.cursorOffset.y === 0 && input.value === "") {
              delete act.cursorOffset;
            }
          } else if (input.type === "number") {
            act[field] = parseInt(input.value, 10);
          } else {
            act[field] = input.value;
            if (field === "type") renderActionCards();
          }
        });
      });

      // Control Button Listeners
      card.querySelector(".action-move-up").addEventListener("click", () => moveAction(idx, idx - 1));
      card.querySelector(".action-move-down").addEventListener("click", () => moveAction(idx, idx + 1));
      card.querySelector(".action-insert-btn").addEventListener("click", () => insertActionAt(idx + 1));
      card.querySelector(".action-duplicate-btn").addEventListener("click", () => duplicateAction(idx));
      card.querySelector(".action-delete-btn").addEventListener("click", () => deleteAction(idx));

      // HTML5 Drag & Drop
      card.addEventListener("dragstart", (e) => {
        draggedActionIndex = idx;
        card.classList.add("is-dragging");
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", String(idx));
      });

      card.addEventListener("dragover", (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        if (draggedActionIndex !== null && draggedActionIndex !== idx) {
          card.classList.add("drag-over");
        }
      });

      card.addEventListener("dragleave", () => {
        card.classList.remove("drag-over");
      });

      card.addEventListener("drop", (e) => {
        e.preventDefault();
        card.classList.remove("drag-over");
        if (draggedActionIndex !== null && draggedActionIndex !== idx) {
          moveAction(draggedActionIndex, idx);
        }
      });

      card.addEventListener("dragend", () => {
        card.classList.remove("is-dragging");
        document.querySelectorAll(".action-item-card").forEach((c) => c.classList.remove("drag-over"));
        draggedActionIndex = null;
      });

      actionsList.appendChild(card);

      // Divider after this card (index idx + 1)
      actionsList.appendChild(createInsertDivider(idx + 1));
    });
  }

// 11. Save Plan
async function handleSavePlan(silent = false) {
      const slug = slugInput.value.trim() || currentSlug;
      if (!slug) {
        if (!silent) alert("시나리오 식별자(Slug)를 입력해주세요.");
        return false;
      }
      if (!currentPlan) {
        if (!silent) alert("저장할 플랜이 없습니다.");
        return false;
      }

      try {
        const res = await fetch("/api/scenarios/save", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slug, plan: currentPlan }),
        });
        const data = await res.json();
        if (data.success) {
          if (!silent) {
            alert(`'${slug}' 브라우징 플랜이 성공적으로 저장되었습니다!`);
          }
          fetchScenarios();
          return true;
        }
      } catch (err) {
        if (!silent) alert("저장 실패: " + err.message);
        return false;
      }
      return false;
    }

// 12. Run Pipeline (Record & Edit)
async function handleRunPipeline() {
      const slug = slugInput.value.trim() || currentSlug;
      if (!slug) {
        alert("시나리오 식별자(Slug)를 입력해주세요.");
        return;
      }

      // 1. Fetch latest server browse-plan to ensure we don't overwrite with stale memory state
      try {
        const checkRes = await fetch(`/api/scenarios/${slug}`);
        if (checkRes.ok) {
          const details = await checkRes.json();
          if (details && details.browsePlan && (!currentPlan || !currentPlan.actions || currentPlan.actions.length === 0)) {
            currentPlan = details.browsePlan;
            renderActionCards();
          }
        }
      } catch (syncErr) {
        console.warn("Could not sync server plan before run:", syncErr);
      }

      // 1.5. Validate if any non-wait action is missing a selector
      if (currentPlan && currentPlan.actions) {
        const missingActions = currentPlan.actions
          .map((a, i) => ({ act: a, index: i + 1 }))
          .filter(({ act }) => act.type !== "wait" && (!act.selector || act.selector.trim() === ""));

        if (missingActions.length > 0) {
          const summaryList = missingActions
            .slice(0, 3)
            .map(({ index, act }) => `• #${index} [${act.description || act.type}]`)
            .join("\n");
          const moreText = missingActions.length > 3 ? ` 외 ${missingActions.length - 3}개` : "";

          const proceed = confirm(
            `⚠️ 다음 ${missingActions.length}개 액션의 셀렉터가 비어 있습니다:\n\n${summaryList}${moreText}\n\n셀렉터가 비어있어도 화면 텍스트로 자동 추론을 시도하지만, 직접 지정하는 것이 가장 정확합니다.\n\n이대로 계속 녹화를 진행하시겠습니까?`
          );

          if (!proceed) {
            // Scroll to the first missing card and focus its selector input
            const firstMissingIndex = missingActions[0].index - 1;
            const targetCard = actionsList.querySelector(`[data-index="${firstMissingIndex}"]`);
            if (targetCard) {
              targetCard.scrollIntoView({ behavior: "smooth", block: "center" });
              const selInput = targetCard.querySelector('[data-field="selector"]');
              if (selInput) {
                setTimeout(() => selInput.focus(), 300);
              }
            }
            return;
          }
        }
      }

      // 2. Save only if currentPlan is valid
      if (currentPlan && currentPlan.actions && currentPlan.actions.length > 0) {
        await handleSavePlan(true);
      }

      switchTab("tab-terminal");
      appendTerminalLog(`🚀 '${slug}' 원클릭 자동 녹화 파이프라인 요청 중...`, "system-line");

      try {
        const res = await fetch("/api/scenarios/record", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            slug,
            headed: headedToggle.checked,
            login: loginToggle.checked,
          }),
        });

        const data = await res.json();
        if (!data.success) {
          throw new Error(data.error);
        }
        terminalStatusText.textContent = `실행 중 (${slug})`;
      } catch (err) {
        appendTerminalLog(`❌ 파이프라인 시작 실패: ${err.message}`, "log-error");
      }
    }

// 12-2. Run Video Render (Remotion Composite)
async function handleRenderVideo(targetSlug = null) {
      const slug = targetSlug || slugInput.value.trim() || currentSlug || selectedScenario;
      if (!slug) {
        alert("렌더링할 시나리오를 선택하거나 Slug를 입력해주세요.");
        return;
      }

      // Pre-check scenario details
      const details = scenarioDetailsCache[slug];
      if (details && !details.hasVideo) {
        alert(`'${slug}' 시나리오의 원본 녹화 비디오가 없습니다.\n먼저 [원클릭 녹화 & 제작]을 실행하여 녹화를 완료해주세요.`);
        return;
      }

      switchTab("tab-terminal");
      const prevLive = terminalOutput.querySelector(".render-live-progress");
      if (prevLive) prevLive.classList.remove("render-live-progress");
      appendTerminalLog(`🎞️ '${slug}' 최종 MP4 렌더링(비디오 추출) 프로세스 시작 요청 중...`, "system-line");

      try {
        const res = await fetch("/api/render/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slug }),
        });

        const data = await res.json();
        if (!data.success) {
          throw new Error(data.error);
        }
        terminalStatusText.textContent = `렌더링 중 (${slug})`;
      } catch (err) {
        appendTerminalLog(`❌ 비디오 렌더링 시작 실패: ${err.message}`, "log-error");
      }
    }

// 13. SSE for Terminal Logs
function initSSE() {
      if (sseSource) sseSource.close();
      sseSource = new EventSource("/api/record/stream");

      sseSource.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === "log") {
            const isProgress =
              data.isProgress === true ||
              data.line.includes("비디오 프레임 렌더링:") ||
              data.line.includes("렌더링 진행:") ||
              (data.line.includes("frames)") && data.line.includes("%"));

            if (isProgress) {
              let liveLine = terminalOutput.querySelector(".render-live-progress");
              if (!liveLine) {
                liveLine = document.createElement("div");
                liveLine.className = "terminal-line log-sync render-live-progress";
                terminalOutput.appendChild(liveLine);
              }
              liveLine.textContent = data.line;
              terminalOutput.scrollTop = terminalOutput.scrollHeight;
            } else {
              // If completion or failure, finalize live progress class
              if (data.line.includes("완료") || data.line.includes("실패") || data.line.includes("중단")) {
                const liveLine = terminalOutput.querySelector(".render-live-progress");
                if (liveLine) {
                  liveLine.classList.remove("render-live-progress");
                }
              }

              let lineClass = "";
              if (data.line.includes("[ERR]") || data.line.includes("오류") || data.line.includes("FAIL")) {
                lineClass = "log-error";
              } else if (data.line.includes("완료") || data.line.includes("SUCCESS")) {
                lineClass = "log-success";
              } else if (data.line.includes("[Sync]") || data.line.includes("보정")) {
                lineClass = "log-sync";
              } else if (data.line.includes("] click:") || data.line.includes("] type:")) {
                lineClass = "log-step";
              }
              appendTerminalLog(data.line, lineClass);
            }

            if (data.line.includes("[Enter] 키를 눌러주세요") || data.line.includes("로그인을 완료해 주세요")) {
              if (terminalLoginBanner) terminalLoginBanner.style.display = "flex";
            }
          } else if (data.type === "snapshot") {
            if (data.task && data.task.logs) {
              data.task.logs.forEach((l) => {
                appendTerminalLog(l);
                if (l.includes("[Enter] 키를 눌러주세요") || l.includes("로그인을 완료해 주세요")) {
                  if (data.task.status === "running" && terminalLoginBanner) {
                    terminalLoginBanner.style.display = "flex";
                  }
                }
              });
              if (data.task.status === "running") {
                const isRender = data.task.id && data.task.id.startsWith("render-");
                terminalStatusText.textContent = `${isRender ? "렌더링 중" : "실행 중"} (${data.task.slug})`;
              }
            }
          } else if (data.type === "status") {
            const isRender = data.task.id && data.task.id.startsWith("render-");
            if (data.task.status === "completed") {
              terminalStatusText.textContent = isRender ? "렌더링 완료" : "녹화 완료";
              if (terminalLoginBanner) terminalLoginBanner.style.display = "none";
              fetchScenarios();
              fetchStatus();
              setTimeout(() => {
                selectScenario(data.task.slug, isRender ? "rendered" : null);
                switchTab("tab-scenarios");
              }, 1500);
            } else if (data.task.status === "failed") {
              terminalStatusText.textContent = isRender ? "렌더링 실패" : "녹화 실패";
              if (terminalLoginBanner) terminalLoginBanner.style.display = "none";
            } else if (data.task.status === "stopped") {
              terminalStatusText.textContent = "작업 중단됨";
              if (terminalLoginBanner) terminalLoginBanner.style.display = "none";
            }
          }
        } catch (e) {
          console.error("SSE parse error:", e);
        }
      };
    }

async function sendTerminalInput(input = "\n") {
      try {
        const res = await fetch("/api/record/input", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ input }),
        });
        const data = await res.json();
        if (!data.success) {
          appendTerminalLog(`⚠️ ${data.error || "입력 전송 실패"}`, "log-error");
        } else {
          if (terminalLoginBanner) terminalLoginBanner.style.display = "none";
        }
      } catch (err) {
        appendTerminalLog(`⚠️ 서버 통신 오류: ${err.message}`, "log-error");
      }
    }

function appendTerminalLog(text, className = "") {
      const line = document.createElement("div");
      line.className = `terminal-line ${className}`;
      line.textContent = text;
      terminalOutput.appendChild(line);
      terminalOutput.scrollTop = terminalOutput.scrollHeight;
    }

// 14. Event Bindings
function bindEvents() {
      btnValidateProject.addEventListener("click", handleSaveConfig);
      btnGenerate.addEventListener("click", handleGeneratePlan);
      btnSavePlan.addEventListener("click", handleSavePlan);
      btnRunPipeline.addEventListener("click", handleRunPipeline);
      if (btnRenderVideo) {
        btnRenderVideo.addEventListener("click", () => handleRenderVideo());
      }
      if (btnPlayerRender) {
        btnPlayerRender.addEventListener("click", () => handleRenderVideo(selectedScenario));
      }
      if (btnModeRaw) {
        btnModeRaw.addEventListener("click", () => setVideoMode("raw"));
      }
      if (btnModeRendered) {
        btnModeRendered.addEventListener("click", () => setVideoMode("rendered"));
      }

      if (btnToggleActionSpec) {
        btnToggleActionSpec.addEventListener("click", () => {
          if (actionSpecBody) {
            actionSpecBody.classList.toggle("hidden");
            if (specToggleLabel) {
              specToggleLabel.textContent = actionSpecBody.classList.contains("hidden") ? "▼ 펼쳐보기" : "▲ 접기";
            }
          }
        });
      }

      if (btnClearPrompt) {
        btnClearPrompt.addEventListener("click", () => {
          promptInput.value = "";
          slugInput.value = "";
          promptInput.focus();
        });
      }

      if (pillGw) {
        pillGw.addEventListener("click", () => {
          switchTab("tab-generator");
          targetBaseUrlInput.focus();
          targetBaseUrlInput.select();
        });
      }

      if (btnAddActionTop) {
        btnAddActionTop.addEventListener("click", () => {
          insertActionAt(0);
        });
      }

      if (btnBlockPresets && menuBlockPresets) {
        menuBlockPresets.classList.add("hidden");
        btnBlockPresets.addEventListener("click", (e) => {
          e.stopPropagation();
          menuBlockPresets.classList.toggle("hidden");
        });

        menuBlockPresets.querySelectorAll("[data-preset]").forEach((item) => {
          item.addEventListener("click", () => {
            const preset = item.getAttribute("data-preset");
            insertBlockPreset(preset);
            menuBlockPresets.classList.add("hidden");
          });
        });

        document.addEventListener("click", (e) => {
          if (!btnBlockPresets.contains(e.target) && !menuBlockPresets.contains(e.target)) {
            menuBlockPresets.classList.add("hidden");
          }
        });
      }

      btnAddAction.addEventListener("click", () => {
        const targetIdx = currentPlan && currentPlan.actions ? currentPlan.actions.length : 0;
        insertActionAt(targetIdx);
      });

      btnClearTerminal.addEventListener("click", () => {
        terminalOutput.innerHTML = "";
      });

      btnStopTask.addEventListener("click", async () => {
        btnStopTask.disabled = true;
        btnStopTask.textContent = "중단 중...";
        try {
          await fetch("/api/scenarios/stop", { method: "POST" });
          appendTerminalLog("⏹️ 작업 중단 요청이 전송되었습니다.", "system-line");
        } finally {
          setTimeout(() => {
            btnStopTask.disabled = false;
            btnStopTask.textContent = "⏹️ 작업 중단";
          }, 1000);
        }
      });

      btnSetActive.addEventListener("click", async () => {
        if (!selectedScenario) return;
        try {
          const res = await fetch("/api/scenarios/activate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ slug: selectedScenario }),
          });
          const data = await res.json();
          if (data.success) {
            alert(`'${selectedScenario}'가 Remotion의 활성 컴포지션으로 설정되었습니다!`);
            fetchStatus();
            fetchScenarios();
          }
        } catch (err) {
          alert("활성화 실패: " + err.message);
        }
      });

      btnReRecord.addEventListener("click", () => {
        if (!selectedScenario) return;
        const details = scenarioDetailsCache[selectedScenario];
        if (details && details.browsePlan) {
          currentPlan = details.browsePlan;
          currentSlug = selectedScenario;
          slugInput.value = currentSlug;
          planSlugBadge.textContent = `시나리오: ${currentSlug}`;
          explanationText.textContent = `기존 시나리오 '${selectedScenario}'를 불러왔습니다.`;
          renderActionCards();
          switchTab("tab-generator");
        }
      });

      jsonTabBtns.forEach((btn) => {
        btn.addEventListener("click", () => {
          updateJsonViewer(btn.getAttribute("data-json"));
        });
      });

      // Terminal Enter & Interactive Input Bindings
      if (btnBannerEnter) {
        btnBannerEnter.addEventListener("click", () => {
          sendTerminalInput("\n");
        });
      }

      if (btnTerminalSend) {
        btnTerminalSend.addEventListener("click", () => {
          const val = terminalInputText ? terminalInputText.value : "";
          if (terminalInputText) terminalInputText.value = "";
          sendTerminalInput(val ? val + "\n" : "\n");
        });
      }

      if (terminalInputText) {
        terminalInputText.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            const val = terminalInputText.value;
            terminalInputText.value = "";
            sendTerminalInput(val ? val + "\n" : "\n");
          }
        });
      }

      if (terminalOutput) {
        terminalOutput.addEventListener("click", () => {
          if (terminalInputText) terminalInputText.focus();
        });
      }

      // Global Enter Key: if viewing Tab 3 (Terminal), pressing Enter anywhere sends Enter to the process
      document.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          const activeEl = document.activeElement;
          // If user is actively typing in a form input in another tab, don't intercept
          if (
            activeEl &&
            (activeEl.tagName === "INPUT" || activeEl.tagName === "TEXTAREA") &&
            activeEl !== terminalInputText
          ) {
            return;
          }

          const terminalTab = document.getElementById("tab-terminal");
          if (terminalTab && terminalTab.classList.contains("active")) {
            const isButton = activeEl && activeEl.tagName === "BUTTON";
            if (!isButton) {
              e.preventDefault();
              const val = terminalInputText ? terminalInputText.value : "";
              if (terminalInputText) terminalInputText.value = "";
              sendTerminalInput(val ? val + "\n" : "\n");
            }
          }
        }
      });
    }

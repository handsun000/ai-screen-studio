// State Management
let currentPlan = null;
let currentSlug = "";
let currentExplanation = "";
let selectedScenario = null;
let scenarioDetailsCache = {};
let sseSource = null;
let currentProjectAnalysis = null;
let allScenariosList = [];
let scenarioFilterMode = "all";
let scenarioSearchQuery = "";
let compactWaitsEnabled = true;
let videoMergeQueue = [];

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
const editorScenarioSelect = document.getElementById("editor-scenario-select");
const planStatsPills = document.getElementById("plan-stats-pills");
const btnToggleCompactWaits = document.getElementById("btn-toggle-compact-waits");
const btnAddAction = document.getElementById("btn-add-action");
const btnAddActionTop = document.getElementById("btn-add-action-top");
const btnBlockPresets = document.getElementById("btn-block-presets");
const menuBlockPresets = document.getElementById("menu-block-presets");
const btnSavePlan = document.getElementById("btn-save-plan");
const btnRunPipeline = document.getElementById("btn-run-pipeline");
const btnRenderVideo = document.getElementById("btn-render-video");

const scenarioCardsContainer = document.getElementById("scenario-cards-container");
const scenariosCount = document.getElementById("scenarios-count");
const scenarioSearchInput = document.getElementById("scenario-search-input");
const scenarioFilterChips = document.querySelectorAll(".scenario-filter-chip");
const playerTitle = document.getElementById("player-title");
const playerStatusBadges = document.getElementById("player-status-badges");
const playerFlowSubtitle = document.getElementById("player-flow-subtitle");
const playerMeta = document.getElementById("player-meta");
const videoPlayer = document.getElementById("demo-video-player");
const videoEmpty = document.getElementById("video-empty");
const videoTimecode = document.getElementById("video-timecode");
const videoSpeedSelect = document.getElementById("video-speed-select");
const btnSetActive = document.getElementById("btn-set-active");
const btnReRecord = document.getElementById("btn-re-record");
const btnDirectRerecord = document.getElementById("btn-direct-rerecord");
const btnPlayerRender = document.getElementById("btn-player-render");
const renderFpsSelect = document.getElementById("render-fps-select");
const btnDownloadVideo = document.getElementById("btn-download-video");
const btnModeRaw = document.getElementById("btn-mode-raw");
const btnModeRendered = document.getElementById("btn-mode-rendered");
const videoModeBadge = document.getElementById("video-mode-badge");
let currentVideoMode = "raw"; // "raw" | "rendered"

// Isolated Background Render State & Dock Elements
let activeRenderTask = null;
let renderQueueList = [];
let lastCompletedRenderTask = null;
let renderDockDismissedTaskId = null;

const backgroundRenderDock = document.getElementById("background-render-dock");
const renderDockTitle = document.getElementById("render-dock-title");
const renderDockSlug = document.getElementById("render-dock-slug");
const renderDockFps = document.getElementById("render-dock-fps");
const renderDockQueue = document.getElementById("render-dock-queue");
const renderDockProgressFill = document.getElementById("render-dock-progress-fill");
const renderDockDetail = document.getElementById("render-dock-detail");
const btnCloseRenderDock = document.getElementById("btn-close-render-dock");
const btnStopRenderDock = document.getElementById("btn-stop-render-dock");
const btnOpenRenderedDock = document.getElementById("btn-open-rendered-dock");
const btnDownloadRenderDock = document.getElementById("btn-download-render-dock");

if (renderFpsSelect) {
  const savedFps = localStorage.getItem("screen_demo_render_fps");
  renderFpsSelect.value = savedFps === "60" ? "60" : "30";
  renderFpsSelect.addEventListener("change", () => {
    localStorage.setItem("screen_demo_render_fps", renderFpsSelect.value === "60" ? "60" : "30");
  });
}
const timelineBarWrapper = document.getElementById("timeline-bar-wrapper");
const timelineScrollViewport = document.getElementById("timeline-scroll-viewport");
const timelineVisualBar = document.getElementById("timeline-visual-bar");
const timelineTrackRuler = document.getElementById("timeline-track-ruler");
const timelineTrackZoom = document.getElementById("timeline-track-zoom");
const timelineTrackMoments = document.getElementById("timeline-track-moments");
const timelineTrackNarration = document.getElementById("timeline-track-narration");
const timelinePlayhead = document.getElementById("timeline-playhead");
const timelineStats = document.getElementById("timeline-stats");
const timelineZoomBadge = document.getElementById("timeline-zoom-badge");
const btnTimelineZoomIn = document.getElementById("btn-timeline-zoom-in");
const btnTimelineZoomOut = document.getElementById("btn-timeline-zoom-out");
const timelineZoomPresetBtns = document.querySelectorAll(".btn-timeline-zoom-preset");
let timelineZoomLevel = 1;
let lastTimelineTotalMs = 0;
const studioSubtabBtns = document.querySelectorAll(".studio-subtab-btn");
const studioSubtabPanes = document.querySelectorAll(".studio-subtab-pane");
const subtabMomentsCount = document.getElementById("subtab-moments-count");
const momentsStepList = document.getElementById("moments-step-list");
const jsonViewerContent = document.getElementById("json-viewer-content");
const jsonTabBtns = document.querySelectorAll(".json-tab-btn");
const btnCopyJson = document.getElementById("btn-copy-json");

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
  initTheme();
  initTabs();
  fetchTemplates();
  initSSE();
  fetchConfig();
  fetchStatus();
  renderActionCards();
  fetchScenarios();
  bindEvents();
});

function initTheme() {
  const savedTheme = localStorage.getItem("screen_demo_theme") || "light";
  applyTheme(savedTheme);
  const toggleBtn = document.getElementById("btn-theme-toggle");
  if (toggleBtn) {
    toggleBtn.addEventListener("click", () => {
      const current = document.documentElement.getAttribute("data-theme") || "light";
      const next = current === "dark" ? "light" : "dark";
      localStorage.setItem("screen_demo_theme", next);
      applyTheme(next);
    });
  }
}

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  const labelEl = document.getElementById("theme-toggle-label");
  if (labelEl) {
    labelEl.textContent = theme === "dark" ? "🌙 다크" : "☀️ 라이트";
  }
  if (window.electronAPI && typeof window.electronAPI.setTheme === "function") {
    window.electronAPI.setTheme(theme);
  }
}

// ── Windows 11 Fluent In-App Dialog (Replaces native Electron alert/confirm) ──
function showFluentDialog(message, options = {}) {
  const mode = options.mode || "alert"; // "alert" | "confirm"
  const rawText = String(message == null ? "" : message).trim();

  let dialogType = "info";
  let titleText = "Screen Demo Studio";
  let badgeSymbol = "i";

  if (mode === "confirm") {
    dialogType = "warn";
    titleText = "실행 확인";
    badgeSymbol = "!";
  } else if (/실패|오류|에러|Error|❌/i.test(rawText)) {
    dialogType = "error";
    titleText = "작업 오류 안내";
    badgeSymbol = "✕";
  } else if (/성공|저장되었습니다|지정되었습니다|완료되었습니다|🎉|✅/.test(rawText)) {
    dialogType = "success";
    titleText = "완료 안내";
    badgeSymbol = "✓";
  } else if (/⚠️|입력해주세요|선택해주세요|없습니다|비어/.test(rawText)) {
    dialogType = "warn";
    titleText = "확인이 필요합니다";
    badgeSymbol = "!";
  }

  const cleanBody = rawText.replace(/^(?:⚠️|🎉|✅|❌)\s*/, "");

  return new Promise((resolve) => {
    const existing = document.querySelector(".fluent-dialog-overlay");
    if (existing) existing.remove();

    const overlay = document.createElement("div");
    overlay.className = "fluent-dialog-overlay";

    const card = document.createElement("div");
    card.className = "fluent-dialog-card";
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-modal", "true");

    const header = document.createElement("div");
    header.className = "fluent-dialog-header";

    const iconEl = document.createElement("div");
    iconEl.className = `fluent-dialog-icon type-${dialogType}`;
    iconEl.textContent = badgeSymbol;

    const titleEl = document.createElement("div");
    titleEl.className = "fluent-dialog-title";
    titleEl.textContent = options.title || titleText;

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "fluent-dialog-close";
    closeBtn.title = "닫기 (Esc)";
    closeBtn.textContent = "✕";

    header.appendChild(iconEl);
    header.appendChild(titleEl);
    header.appendChild(closeBtn);

    const body = document.createElement("div");
    body.className = "fluent-dialog-body";
    body.textContent = cleanBody;

    const footer = document.createElement("div");
    footer.className = "fluent-dialog-footer";

    let cancelBtn = null;
    if (mode === "confirm") {
      cancelBtn = document.createElement("button");
      cancelBtn.type = "button";
      cancelBtn.className = "btn btn-secondary";
      cancelBtn.textContent = options.cancelText || "취소";
      footer.appendChild(cancelBtn);
    }

    const okBtn = document.createElement("button");
    okBtn.type = "button";
    okBtn.className = "btn btn-primary";
    okBtn.textContent = options.okText || (mode === "confirm" ? "계속 진행" : "확인");
    footer.appendChild(okBtn);

    card.appendChild(header);
    card.appendChild(body);
    card.appendChild(footer);
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    const cleanup = (result) => {
      document.removeEventListener("keydown", onKeyDown, true);
      overlay.remove();
      resolve(result);
    };

    const onKeyDown = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        cleanup(false);
      } else if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        cleanup(true);
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    okBtn.addEventListener("click", () => cleanup(true));
    closeBtn.addEventListener("click", () => cleanup(false));
    if (cancelBtn) {
      cancelBtn.addEventListener("click", () => cleanup(false));
    }
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay && mode === "alert") {
        cleanup(false);
      }
    });

    setTimeout(() => okBtn.focus(), 10);
  });
}

function showAppAlert(message, options = {}) {
  return showFluentDialog(message, { ...options, mode: "alert" });
}

function showAppConfirm(message, options = {}) {
  return showFluentDialog(message, { ...options, mode: "confirm" });
}

window.alert = (msg) => {
  void showAppAlert(msg);
};

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

// 3. Dynamic Target URL Config & Status
async function fetchConfig() {
  try {
    const res = await fetch("/api/config");
    const data = await res.json();
    const config = data.config;
    const analysis = data.analysis;
    currentProjectAnalysis = analysis;

    if (targetProjectPathInput) {
      targetProjectPathInput.value = "";
    }
    targetBaseUrlInput.value = config.targetBaseUrl || "";

    updateProjectAnalysisUI(analysis, config.targetBaseUrl);
  } catch (err) {
    console.error("fetchConfig failed:", err);
  }
}

function updateProjectAnalysisUI(analysis, targetUrlOverride) {
  const dot = projectStatusBadge ? projectStatusBadge.querySelector(".status-dot") : null;
  const rawUrl = targetUrlOverride || (targetBaseUrlInput ? targetBaseUrlInput.value.trim() : "");
  let hostLabel = "Live URL 모드";
  try {
    if (rawUrl) {
      hostLabel = new URL(rawUrl).host || rawUrl;
    }
  } catch {
    if (rawUrl) hostLabel = rawUrl;
  }

  if (pillProjectName) {
    pillProjectName.textContent = `🌐 ${hostLabel}`;
  }
  if (dot) {
    dot.style.background = "var(--ok)";
    dot.style.boxShadow = "none";
  }
  if (projectStatusText) {
    projectStatusText.textContent = `접속 대상: ${hostLabel}`;
  }
}

async function handleSaveConfig() {
  let targetBaseUrl = targetBaseUrlInput.value.trim();

  if (!targetBaseUrl) {
    alert("접속 대상 서비스 URL을 입력해주세요.");
    return;
  }
  if (!/^https?:\/\//i.test(targetBaseUrl)) {
    targetBaseUrl = "http://" + targetBaseUrl;
    targetBaseUrlInput.value = targetBaseUrl;
  }

  btnValidateProject.disabled = true;
  btnValidateProject.textContent = "저장 중...";

  try {
    const res = await fetch("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetProjectPath: "", targetBaseUrl }),
    });

    const data = await res.json();
    updateProjectAnalysisUI(data.analysis, data.config.targetBaseUrl);
    alert(`타겟 접속 URL이 저장되었습니다!\n- 접속 URL: ${data.config.targetBaseUrl}`);
  } catch (err) {
    alert("설정 저장 실패: " + err.message);
  } finally {
    btnValidateProject.disabled = false;
    btnValidateProject.textContent = "💾 URL 저장";
  }
}

// 4. API & CLI Execution Mode Status
let latestAiStatusData = {
  aiMode: "api",
  aiCliProvider: "agy",
  aiCliModel: "gemini-3.8-flash-low",
  geminiModel: "gemini-3.8-flash",
  geminiApiKeySet: false,
  geminiApiKeyPreview: "미설정",
  availableClis: [],
};

function syncAiModeUI(data) {
  if (data) {
    latestAiStatusData = {
      ...latestAiStatusData,
      ...data,
    };
  }
  const mode = latestAiStatusData.aiMode === "cli" ? "cli" : "api";

  document.querySelectorAll(".ai-mode-seg-btn").forEach((btn) => {
    const btnMode = btn.getAttribute("data-ai-mode");
    btn.classList.toggle("active", btnMode === mode);
  });

  const pillAi = document.getElementById("pill-ai");
  if (!pillAi) return;

  if (mode === "cli") {
    const provider = latestAiStatusData.aiCliProvider || "agy";
    const cliModel = latestAiStatusData.aiCliModel || "gemini-3.8-flash-low";
    pillAi.innerHTML = `<span class="status-dot" style="background:var(--ok)"></span><span>CLI · ${provider} (${cliModel})</span>`;
    pillAi.title = `현재 💻 로컬 CLI 모드 활성 (${provider}/${cliModel} · API 요금 ₩0) — 클릭하여 모델 변경 및 사용량 보기`;
  } else if (latestAiStatusData.geminiApiKeySet) {
    pillAi.innerHTML = `<span class="status-dot"></span><span>API · ${latestAiStatusData.geminiModel || "gemini-3.8-flash"}</span>`;
    pillAi.title = `현재 🔌 API 모드 활성 (API Key: ${latestAiStatusData.geminiApiKeyPreview}) — 클릭하여 CLI/API 모드 설정 및 사용량 보기`;
  } else {
    pillAi.innerHTML = `<span class="status-dot" style="background:var(--fail)"></span><span>API · Key 미설정 (CLI 전환 가능)</span>`;
    pillAi.title = "GEMINI_API_KEY가 설정되지 않았습니다. 옆의 [💻 CLI] 버튼을 누르거나 클릭하여 모드를 변경하세요.";
  }
}

async function switchAiExecutionModeQuick(nextMode, extra = {}) {
  const mode = nextMode === "cli" ? "cli" : "api";
  try {
    const res = await fetch("/api/ai-mode", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ aiMode: mode, ...extra }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "AI 모드 변경 실패");
    if (data.config) {
      syncAiModeUI({
        aiMode: data.config.aiMode,
        aiCliProvider: data.config.aiCliProvider,
        aiCliModel: data.config.aiCliModel,
        geminiModel: data.config.geminiModel,
        availableClis: data.availableClis || latestAiStatusData.availableClis,
      });
    }
    await fetchStatus();
  } catch (err) {
    showAppAlert("AI 실행 모드 전환 실패: " + err.message);
  }
}

async function fetchStatus() {
  try {
    const res = await fetch("/api/status");
    const data = await res.json();

    if (activeSlugLabel) {
      activeSlugLabel.textContent = data.activeSlug || "none";
    }

    syncAiModeUI(data);

    const pillAuth = document.getElementById("pill-auth");
    const authDot = document.getElementById("auth-status-dot");
    const authLabel = document.getElementById("pill-auth-label");
    if (pillAuth && authLabel) {
      if (data.hasAuthSession) {
        if (authDot) authDot.style.background = "var(--ok)";
        authLabel.textContent = "로그인 활성";
        pillAuth.title = `인증 세션: ${data.authSessionPath || "auth.json"} (클릭하여 계정 변경/재로그인)`;
      } else {
        if (authDot) authDot.style.background = "var(--warn)";
        authLabel.textContent = "로그인 필요 (클릭)";
        pillAuth.title = "저장된 세션이 없습니다. 클릭하여 브라우저에서 1회 로그인합니다.";
      }
    }
  } catch (err) {
    console.error("fetchStatus failed:", err);
  }
}

async function openAiUsageModal() {
  try {
    const res = await fetch("/api/ai-usage");
    const ct = res.headers.get("content-type") || "";
    const usage = ct.includes("application/json")
      ? await res.json()
      : { today: {}, total: {}, recentHistory: [] };
    const today = usage.today || { calls: 0, promptTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, costKrw: 0 };
    const total = usage.total || { calls: 0, promptTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, costKrw: 0 };
    const history = Array.isArray(usage.recentHistory) ? usage.recentHistory : [];

    const currentMode = usage.aiMode || latestAiStatusData.aiMode || "api";
    const currentCliProvider = usage.aiCliProvider || latestAiStatusData.aiCliProvider || "agy";
    const currentCliModel = usage.aiCliModel || latestAiStatusData.aiCliModel || "gemini-3.8-flash-low";
    const rawClis = Array.isArray(usage.availableClis)
      ? usage.availableClis
      : latestAiStatusData.availableClis || [];

    const fullCliCatalog = [
      {
        id: "agy",
        name: "Antigravity CLI (agy)",
        installed: true,
        models: [
          { id: "gemini-3.8-flash-low", label: "Gemini 3.8 Flash (Low · 초고속 추천)" },
          { id: "gemini-3.8-flash-medium", label: "Gemini 3.8 Flash (Medium · 균형)" },
          { id: "gemini-3.8-flash-high", label: "Gemini 3.8 Flash (High · 정밀)" },
          { id: "gemini-4-argon-low", label: "Gemini 4 Argon (Low · 고속)" },
          { id: "gemini-4-argon-medium", label: "Gemini 4 Argon (Medium · 고성능)" },
          { id: "gemini-4-argon-high", label: "Gemini 4 Argon (High · 최고성능)" },
          { id: "claude-sonnet-5-5-low", label: "Claude Sonnet 5.5 (Low)" },
          { id: "claude-sonnet-5-5-medium", label: "Claude Sonnet 5.5 (Medium)" },
          { id: "claude-sonnet-5-5-high", label: "Claude Sonnet 5.5 (High)" },
          { id: "claude-opus-5-5-low", label: "Claude Opus 5.5 (Low)" },
          { id: "claude-opus-5-5-medium", label: "Claude Opus 5.5 (Medium)" },
          { id: "claude-opus-5-5-high", label: "Claude Opus 5.5 (High)" },
          { id: "gpt-oss-120b-medium", label: "GPT-OSS 120B (Medium)" },
        ],
      },
      {
        id: "naoncode",
        name: "NAON CODE CLI (naoncode)",
        installed: true,
        models: [
          { id: "qwen3.8-27b", label: "Qwen 3.8 27B (NAON AI Gateway · 기본 추천)" },
          { id: "qwen3.8-27b-NAON", label: "Qwen 3.8 27B NAON (사내 전용 게이트웨이)" },
          { id: "qwen3.6:35b-NAON", label: "Qwen 3.6 35B NAON (사내 전용 게이트웨이)" },
          { id: "qwen3.8-flash-openrouter", label: "Qwen 3.8 Flash (OpenRouter · 고속)" },
          { id: "qwen3-30b-a3b", label: "Qwen 3 30B-A3B (NAON AI Gateway)" },
          { id: "gemma-3-27b-it", label: "Gemma 3 27B IT (NAON AI Gateway)" },
          { id: "deepseek-v4", label: "DeepSeek V4 (NAON AI Gateway · 추론)" },
          { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash (NAON AI Gateway)" },
          { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro (NAON AI Gateway)" },
          { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 (NAON AI Gateway)" },
          { id: "gpt-5", label: "GPT-5 (NAON AI Gateway)" },
        ],
      },
      {
        id: "claude",
        name: "Claude Code CLI (claude)",
        installed: false,
        models: [
          { id: "default", label: "Claude 기본 모델 (Default)" },
          { id: "sonnet", label: "Claude Sonnet (표준 · 추천)" },
          { id: "haiku", label: "Claude Haiku (초고속)" },
          { id: "opus", label: "Claude Opus (최고성능)" },
          { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
          { id: "claude-opus-4-6", label: "Claude Opus 4.6" },
          { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
        ],
      },
      {
        id: "gemini",
        name: "Google Gemini CLI (gemini)",
        installed: false,
        models: [
          { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash (고속 추천)" },
          { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro (고성능)" },
          { id: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash Lite (초경량)" },
          { id: "gemini-3-flash-preview", label: "Gemini 3 Flash Preview" },
          { id: "gemini-3-pro-preview", label: "Gemini 3 Pro Preview" },
        ],
      },
      {
        id: "codex",
        name: "OpenAI Codex CLI (codex)",
        installed: false,
        models: [
          { id: "gpt-5-codex", label: "GPT-5 Codex (표준 추천)" },
          { id: "gpt-5", label: "GPT-5 (고성능)" },
          { id: "o4-mini", label: "o4-mini (초고속 추론)" },
          { id: "o3", label: "o3 (심층 추론)" },
        ],
      },
      {
        id: "ollama",
        name: "Ollama Local LLM (ollama)",
        installed: false,
        models: [
          { id: "qwen3:8b", label: "Qwen 3 (8B · 로컬 추천)" },
          { id: "gemma3:12b", label: "Gemma 3 (12B)" },
          { id: "llama3.3:latest", label: "Llama 3.3 (Latest)" },
          { id: "deepseek-r1:8b", label: "DeepSeek R1 (8B)" },
        ],
      },
      {
        id: "copilot",
        name: "GitHub Copilot CLI (copilot)",
        installed: false,
        models: [
          { id: "claude-sonnet-4.5", label: "Claude Sonnet 4.5 (Copilot)" },
          { id: "gpt-5", label: "GPT-5 (Copilot)" },
          { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro (Copilot)" },
        ],
      },
    ];

    const mergedClis = fullCliCatalog.map((defItem) => {
      const srv = rawClis.find((r) => r.id === defItem.id);
      if (!srv) return defItem;
      const mergedModels = [...(Array.isArray(srv.models) ? srv.models : [])];
      const seenIds = new Set(mergedModels.map((m) => m.id));
      for (const dm of defItem.models) {
        if (!seenIds.has(dm.id)) {
          seenIds.add(dm.id);
          mergedModels.push(dm);
        }
      }
      return {
        ...defItem,
        ...srv,
        models: mergedModels,
      };
    });

    for (const srv of rawClis) {
      if (srv && srv.id && !mergedClis.some((m) => m.id === srv.id)) {
        mergedClis.push(srv);
      }
    }

    const availableClis = [
      ...mergedClis.filter((c) => c.installed),
      ...mergedClis.filter((c) => !c.installed),
    ];

    const existing = document.querySelector(".fluent-dialog-overlay");
    if (existing) existing.remove();

    const overlay = document.createElement("div");
    overlay.className = "fluent-dialog-overlay";

    const cliProviderOptionsHtml = availableClis
      .map((c) => {
        const statusText = c.installed ? "✅ 설치됨" : "⚠️ 미설치";
        return `<option value="${c.id}" ${c.id === currentCliProvider ? "selected" : ""}>${c.name} (${statusText})</option>`;
      })
      .join("");

    const getModelsHtmlForProvider = (providerId, selectedModel) => {
      const found = availableClis.find((c) => c.id === providerId) || availableClis[0];
      const models = Array.isArray(found?.models) ? found.models : [{ id: "gemini-3.8-flash-low", label: "Gemini 3.8 Flash (Low)" }];
      return models
        .map((m) => `<option value="${m.id}" ${m.id === selectedModel ? "selected" : ""}>${m.label}</option>`)
        .join("");
    };

    const historyRowsHtml =
      history.length === 0
        ? `<tr><td colspan="5" style="padding:20px 12px;text-align:center;color:var(--text-3);">아직 기록된 AI 호출 내역이 없습니다.<br><span style="font-size:11.5px;">(스포이드 동작 감지는 AI를 호출하지 않아 요금이 발생하지 않습니다.)</span></td></tr>`
        : history
            .map((item) => {
              const dt = new Date(item.timestamp);
              const timeStr = isNaN(dt.getTime())
                ? item.timestamp
                : `${String(dt.getMonth() + 1).padStart(2, "0")}/${String(dt.getDate()).padStart(2, "0")} ${String(dt.getHours()).padStart(2, "0")}:${String(dt.getMinutes()).padStart(2, "0")}:${String(dt.getSeconds()).padStart(2, "0")}`;
              const isCliCall = item.mode === "cli" || String(item.model || "").startsWith("[CLI]");
              const costCellHtml = isCliCall
                ? `<span style="color:var(--ok);font-weight:700;" title="로컬 CLI 로그인 세션 호출 (API 요금 ₩0)">₩0 (CLI)</span>`
                : `₩${Number(item.costKrw || 0).toFixed(2)} <span style="color:var(--text-3);font-weight:400;">($${Number(item.costUsd || 0).toFixed(4)})</span>`;
              const totalTokStr = Number(item.totalTokens || 0).toLocaleString();
              const promptTokStr = Number(item.promptTokens || 0).toLocaleString();
              const outTokStr = Number(item.outputTokens || 0).toLocaleString();
              return `
                <tr style="border-bottom:1px solid var(--stroke);">
                  <td style="padding:6px 8px;color:var(--text-3);font-family:var(--font-mono);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${timeStr}">${timeStr}</td>
                  <td style="padding:6px 8px;color:var(--text);font-weight:600;font-size:11.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${item.feature}">${item.feature}</td>
                  <td style="padding:6px 8px;color:var(--text-2);font-family:var(--font-mono);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${item.model}">${item.model}</td>
                  <td style="padding:6px 8px;color:var(--text-2);font-family:var(--font-mono);font-size:11px;text-align:right;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="총 ${totalTokStr} 토큰 (입력 ${promptTokStr} / 출력 ${outTokStr})">
                    ${totalTokStr} <span style="color:var(--text-3);font-size:10px;">(${promptTokStr}+${outTokStr})</span>
                  </td>
                  <td style="padding:6px 8px;color:var(--accent);font-family:var(--font-mono);font-size:11px;font-weight:600;text-align:right;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                    ${costCellHtml}
                  </td>
                </tr>`;
            })
            .join("");

    overlay.innerHTML = `
      <div class="fluent-dialog-card ai-usage-modal-card" style="max-width:780px;width:94vw;" role="dialog" aria-modal="true">
        <div class="fluent-dialog-header" style="padding:13px 20px 8px;">
          <div class="fluent-dialog-icon type-info">⚙️</div>
          <div class="fluent-dialog-title">AI 실행 모드 설정 (API 모드 / CLI 모드) 및 사용량</div>
          <button type="button" class="fluent-dialog-close" id="btn-close-ai-usage" title="닫기 (Esc)">✕</button>
        </div>
        <div class="fluent-dialog-body" style="white-space:normal;padding:4px 20px 14px;max-height:none;overflow:visible;">
          <div style="font-size:12px;font-weight:700;color:var(--text-2);margin-bottom:6px;">
            1. AI 실행 엔진 방식 선택 (대본 생성 · 시나리오 생성 · 실시간 자가치유 공통 적용)
          </div>
          <div class="ai-mode-card-grid" style="margin-bottom:10px;">
            <div class="ai-mode-option-card ${currentMode === "api" ? "selected-api" : ""}" id="card-select-api-mode" style="padding:10px 13px;">
              <div class="ai-mode-card-header-row" style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:nowrap;white-space:nowrap;margin-bottom:4px;">
                <span style="font-weight:700;font-size:13px;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">🔌 API 모드 (Gemini SDK)</span>
                <span class="status-tag" style="flex-shrink:0;white-space:nowrap;background:${usage.geminiApiKeySet ? "var(--accent-soft)" : "var(--fail-soft)"};color:${usage.geminiApiKeySet ? "var(--accent)" : "var(--fail)"};">
                  ${usage.geminiApiKeySet ? `Key: ${usage.geminiApiKeyPreview}` : "Key 미설정"}
                </span>
              </div>
              <div style="font-size:11.5px;color:var(--text-2);line-height:1.4;">
                <code>.env</code>에 설정된 <code>GEMINI_API_KEY</code>로 직접 호출합니다. 응답 속도가 가장 빠르며 멀티모달 화면 이미지 분석을 지원합니다.
              </div>
            </div>

            <div class="ai-mode-option-card ${currentMode === "cli" ? "selected-cli" : ""}" id="card-select-cli-mode" style="padding:10px 13px;">
              <div class="ai-mode-card-header-row" style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:nowrap;white-space:nowrap;margin-bottom:4px;">
                <span style="font-weight:700;font-size:13px;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">💻 CLI 모드 (로컬 로그인 CLI)</span>
                <span class="status-tag" style="flex-shrink:0;white-space:nowrap;background:var(--ok-soft);color:var(--ok);">API 요금 ₩0</span>
              </div>
              <div style="font-size:11.5px;color:var(--text-2);line-height:1.4;">
                PC에 설치된 <strong>Antigravity (agy)</strong> · <strong>NAON CODE (naoncode)</strong> · <strong>Claude</strong> · <strong>Gemini</strong> · <strong>Codex</strong> · <strong>Ollama</strong> · <strong>Copilot</strong> CLI를 호출합니다.
              </div>
            </div>
          </div>

          <div id="modal-cli-settings-box" style="background:var(--layer);border:1px solid var(--stroke);border-radius:var(--r-card);padding:9px 12px;margin-bottom:10px;">
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:nowrap;">
              <span style="font-size:12px;font-weight:600;color:var(--text-2);white-space:nowrap;flex-shrink:0;">💻 로컬 CLI 도구:</span>
              <select id="modal-cli-provider-select" class="narration-select" style="flex:1 1 210px;min-width:0;">
                ${cliProviderOptionsHtml}
              </select>
              <span style="font-size:12px;font-weight:600;color:var(--text-2);white-space:nowrap;flex-shrink:0;">모델:</span>
              <select id="modal-cli-model-select" class="narration-select" style="flex:1.15 1 240px;min-width:0;">
                ${getModelsHtmlForProvider(currentCliProvider, currentCliModel)}
              </select>
              <button type="button" class="btn btn-sm btn-outline" id="btn-test-ai-mode" style="white-space:nowrap;flex-shrink:0;">
                ⚡ 연결 테스트
              </button>
            </div>
            <div id="modal-ai-test-result" style="font-size:11.5px;color:var(--text-3);margin-top:5px;font-family:var(--font-mono);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
              ※ 상단 헤더 우측의 <strong>[🔌 API | 💻 CLI]</strong> 스위치로도 언제든 1클릭 전환할 수 있습니다.
            </div>
          </div>

          <div style="font-size:12px;font-weight:700;color:var(--text-2);margin-bottom:6px;">
            2. 토큰 사용량 및 예상 API 요금 요약
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px;">
            <div style="background:var(--layer);border:1px solid var(--stroke);border-radius:var(--r-card);padding:9px 13px;">
              <div style="font-size:12px;color:var(--text-2);margin-bottom:3px;display:flex;justify-content:space-between;white-space:nowrap;">
                <span>오늘 사용량 (${usage.todayKey || "오늘"})</span>
                <span style="font-weight:600;color:var(--text);">${today.calls}회 호출</span>
              </div>
              <div style="font-size:16px;font-weight:700;color:var(--accent);font-family:var(--font-mono);white-space:nowrap;">
                약 ₩${Number(today.costKrw || 0).toFixed(1)}원 <span style="font-size:11.5px;color:var(--text-2);font-weight:500;">($${Number(today.costUsd || 0).toFixed(4)})</span>
              </div>
              <div style="font-size:11px;color:var(--text-3);margin-top:3px;font-family:var(--font-mono);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                총 ${Number(today.totalTokens || 0).toLocaleString()} 토큰 (입력 ${Number(today.promptTokens || 0).toLocaleString()} · 출력 ${Number(today.outputTokens || 0).toLocaleString()})
              </div>
            </div>
            <div style="background:var(--layer);border:1px solid var(--stroke);border-radius:var(--r-card);padding:9px 13px;">
              <div style="font-size:12px;color:var(--text-2);margin-bottom:3px;display:flex;justify-content:space-between;white-space:nowrap;">
                <span>전체 누적 사용량</span>
                <span style="font-weight:600;color:var(--text);">${total.calls}회 호출</span>
              </div>
              <div style="font-size:16px;font-weight:700;color:var(--text);font-family:var(--font-mono);white-space:nowrap;">
                약 ₩${Number(total.costKrw || 0).toFixed(1)}원 <span style="font-size:11.5px;color:var(--text-2);font-weight:500;">($${Number(total.costUsd || 0).toFixed(4)})</span>
              </div>
              <div style="font-size:11px;color:var(--text-3);margin-top:3px;font-family:var(--font-mono);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                총 ${Number(total.totalTokens || 0).toLocaleString()} 토큰 (입력 ${Number(total.promptTokens || 0).toLocaleString()} · 출력 ${Number(total.outputTokens || 0).toLocaleString()})
              </div>
            </div>
          </div>

          <div style="font-size:12px;font-weight:600;color:var(--text-2);margin-bottom:5px;">최근 호출 상세 내역 (최대 30건)</div>
          <div id="ai-usage-history-scroll" style="max-height:175px;overflow-y:auto;overflow-x:hidden;border:1px solid var(--stroke);border-radius:var(--r-ctl);background:var(--layer);">
            <table class="ai-usage-history-table" style="width:100%;table-layout:fixed;border-collapse:collapse;font-size:11.5px;text-align:left;">
              <colgroup>
                <col style="width:14%;">
                <col style="width:22%;">
                <col style="width:31%;">
                <col style="width:21%;">
                <col style="width:12%;">
              </colgroup>
              <thead>
                <tr style="border-bottom:1px solid var(--stroke);background:var(--card);color:var(--text-2);font-size:11px;position:sticky;top:0;z-index:1;">
                  <th style="padding:6px 8px;font-weight:600;white-space:nowrap;">시각</th>
                  <th style="padding:6px 8px;font-weight:600;white-space:nowrap;">기능</th>
                  <th style="padding:6px 8px;font-weight:600;white-space:nowrap;">실행 모델</th>
                  <th style="padding:6px 8px;font-weight:600;text-align:right;white-space:nowrap;">토큰 (입력+출력)</th>
                  <th style="padding:6px 8px;font-weight:600;text-align:right;white-space:nowrap;">예상 요금</th>
                </tr>
              </thead>
              <tbody>
                ${historyRowsHtml}
              </tbody>
            </table>
          </div>
          <div style="margin-top:6px;font-size:11px;color:var(--text-3);display:flex;justify-content:space-between;white-space:nowrap;gap:8px;">
            <span>※ API 모드: Google AI Studio 공식 단가($1 = ₩${usage.exchangeRateKrw || 1400}) 기준 추정치</span>
            <span>💻 CLI 모드 호출은 구독 세션을 사용하므로 API 요금이 ₩0원입니다.</span>
          </div>
        </div>
        <div class="fluent-dialog-footer" style="justify-content:space-between;padding:10px 20px;">
          <button type="button" class="btn btn-secondary" id="btn-reset-ai-usage">내역 초기화</button>
          <button type="button" class="btn btn-primary" id="btn-ok-ai-usage">닫기</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    let selectedModeInModal = currentMode;
    const apiCard = overlay.querySelector("#card-select-api-mode");
    const cliCard = overlay.querySelector("#card-select-cli-mode");
    const providerSelect = overlay.querySelector("#modal-cli-provider-select");
    const modelSelect = overlay.querySelector("#modal-cli-model-select");
    const testBtn = overlay.querySelector("#btn-test-ai-mode");
    const testResultEl = overlay.querySelector("#modal-ai-test-result");

    const applyModalModeSelection = async (nextMode) => {
      selectedModeInModal = nextMode;
      apiCard?.classList.toggle("selected-api", nextMode === "api");
      cliCard?.classList.toggle("selected-cli", nextMode === "cli");
      await switchAiExecutionModeQuick(nextMode, {
        aiCliProvider: providerSelect?.value || "agy",
        aiCliModel: modelSelect?.value || "gemini-3.8-flash-low",
      });
      if (testResultEl) {
        testResultEl.style.color = "var(--ok)";
        testResultEl.textContent =
          nextMode === "cli"
            ? `✅ 로컬 CLI 모드(${providerSelect?.value}/${modelSelect?.value})로 즉시 전환되었습니다.`
            : `✅ Google Gemini API 모드로 즉시 전환되었습니다.`;
      }
    };

    apiCard?.addEventListener("click", () => applyModalModeSelection("api"));
    cliCard?.addEventListener("click", () => applyModalModeSelection("cli"));

    providerSelect?.addEventListener("change", async () => {
      const nextProvider = providerSelect.value;
      if (modelSelect) {
        modelSelect.innerHTML = getModelsHtmlForProvider(nextProvider, "");
      }
      await applyModalModeSelection("cli");
    });

    modelSelect?.addEventListener("change", async () => {
      await applyModalModeSelection("cli");
    });

    testBtn?.addEventListener("click", async () => {
      if (!testResultEl) return;
      testBtn.disabled = true;
      testBtn.textContent = "⏳ 테스트 중...";
      testResultEl.style.color = "var(--accent)";
      testResultEl.textContent = `⏳ ${selectedModeInModal.toUpperCase()} 모드로 테스트 요청을 전송하고 있습니다...`;
      try {
        const resTest = await fetch("/api/ai-mode/test", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            aiMode: selectedModeInModal,
            aiCliProvider: providerSelect?.value,
            aiCliModel: modelSelect?.value,
          }),
        });
        const dataTest = await resTest.json();
        if (!resTest.ok || !dataTest.success) {
          throw new Error(dataTest.error || "연결 실패");
        }
        testResultEl.style.color = "var(--ok)";
        testResultEl.textContent = `✅ 연결 성공! (${(dataTest.elapsedMs / 1000).toFixed(1)}s) — 모델: ${dataTest.modelUsed} · 응답: ${dataTest.responseText}`;
        fetchStatus();
      } catch (errTest) {
        testResultEl.style.color = "var(--fail)";
        testResultEl.textContent = `❌ 연결 실패: ${errTest.message}`;
      } finally {
        testBtn.disabled = false;
        testBtn.textContent = "⚡ 연결 테스트";
      }
    });

    const close = () => {
      document.removeEventListener("keydown", onKey, true);
      overlay.remove();
    };
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    };
    document.addEventListener("keydown", onKey, true);

    overlay.querySelector("#btn-close-ai-usage")?.addEventListener("click", close);
    overlay.querySelector("#btn-ok-ai-usage")?.addEventListener("click", close);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close();
    });

    overlay.querySelector("#btn-reset-ai-usage")?.addEventListener("click", async () => {
      const ok = await showAppConfirm("누적된 AI API 사용량 및 요금 기록을 모두 초기화하시겠습니까?");
      if (!ok) return;
      await fetch("/api/ai-usage/reset", { method: "POST" });
      await openAiUsageModal();
    });
  } catch (err) {
    showAppAlert("AI 사용량 정보를 불러오지 못했습니다: " + err.message);
  }
}

// 5. Scenarios List & Quick Search / Filter
async function fetchScenarios() {
  try {
    const prevSelectedSummary = selectedScenario
      ? allScenariosList.find((x) => x.slug === selectedScenario)
      : null;
    const prevLastMod = prevSelectedSummary?.lastModified || "";
    const prevVideoSize = prevSelectedSummary?.videoSizeBytes || 0;

    const res = await fetch(`/api/scenarios?t=${Date.now()}`, { cache: "no-store" });
    const data = await res.json();
    allScenariosList = data.scenarios || [];

    // Populate Tab 1 Quick Scenario Loader Dropdown (grouped by domain/site)
    if (editorScenarioSelect) {
      const prevVal = editorScenarioSelect.value || currentSlug || "";
      editorScenarioSelect.innerHTML = `<option value="">📂 기존 시나리오 빠른 불러오기 (${allScenariosList.length}개)...</option>`;
      const groupsForSelect = buildDomainSummaryGroups(allScenariosList);
      groupsForSelect.forEach((g) => {
        const optgroup = document.createElement("optgroup");
        const groupLabel =
          g.siteName && g.siteName !== g.domainKey
            ? `🏢 ${g.siteName} (${g.domainKey}) — ${g.items.length}개`
            : `🌐 ${g.domainKey} — ${g.items.length}개`;
        optgroup.label = groupLabel;
        g.items.forEach((s) => {
          const opt = document.createElement("option");
          opt.value = s.slug;
          const shortFlow = s.flowSummary
            ? s.flowSummary.length > 32
              ? s.flowSummary.slice(0, 32) + "…"
              : s.flowSummary
            : `${s.actionsCount}단계`;
          opt.textContent = `${s.slug} — ${shortFlow}`;
          optgroup.appendChild(opt);
        });
        editorScenarioSelect.appendChild(optgroup);
      });
      if (prevVal) editorScenarioSelect.value = prevVal;
    }

    renderScenarioList();

    // Auto-select most recent scenario or refresh current scenario if its disk file was updated externally
    if (!selectedScenario && allScenariosList.length > 0) {
      selectScenario(allScenariosList[0].slug);
    } else if (selectedScenario) {
      const curSummary = allScenariosList.find((x) => x.slug === selectedScenario);
      const diskChanged =
        curSummary &&
        ((prevLastMod && curSummary.lastModified && curSummary.lastModified !== prevLastMod) ||
          (prevVideoSize && curSummary.videoSizeBytes && curSummary.videoSizeBytes !== prevVideoSize));
      if (diskChanged && (!videoPlayer || videoPlayer.paused) && !autoTtsInFlight) {
        delete scenarioDetailsCache[selectedScenario];
        selectScenario(selectedScenario, currentVideoMode);
      }
    }
  } catch (err) {
    console.error("fetchScenarios failed:", err);
  }
}

let scenarioDomainFilter = "all";
const collapsedDomainGroups = new Set(
  (() => {
    try {
      const raw = localStorage.getItem("screen_demo_collapsed_domains");
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  })()
);

function saveCollapsedDomainGroups() {
  try {
    localStorage.setItem("screen_demo_collapsed_domains", JSON.stringify(Array.from(collapsedDomainGroups)));
  } catch {}
}

function buildDomainSummaryGroups(list) {
  const domainMap = new Map();
  (list || []).forEach((s) => {
    const domainKey = String(s.domainKey || "other").trim() || "other";
    let g = domainMap.get(domainKey);
    if (!g) {
      g = {
        domainKey,
        hostKey: s.hostKey || domainKey,
        siteName: s.siteName || domainKey,
        primaryColor: s.primaryColor || "#0068FF",
        logoUrl: s.logoUrl || "",
        items: [],
      };
      domainMap.set(domainKey, g);
    } else {
      if ((!g.siteName || g.siteName === g.domainKey) && s.siteName && s.siteName !== domainKey) {
        g.siteName = s.siteName;
      }
      if (!g.logoUrl && s.logoUrl) {
        g.logoUrl = s.logoUrl;
      }
      if ((!g.primaryColor || g.primaryColor === "#0068FF") && s.primaryColor && s.primaryColor !== "#0068FF") {
        g.primaryColor = s.primaryColor;
      }
    }
    g.items.push(s);
  });
  return Array.from(domainMap.values());
}

function renderScenarioDomainChips() {
  const chipsContainer = document.getElementById("scenario-domain-chips");
  if (!chipsContainer) return;

  const groups = buildDomainSummaryGroups(allScenariosList);
  if (scenarioDomainFilter !== "all" && !groups.some((g) => g.domainKey === scenarioDomainFilter)) {
    scenarioDomainFilter = "all";
  }

  if (groups.length === 0) {
    chipsContainer.classList.add("hidden");
    chipsContainer.innerHTML = "";
    return;
  }

  chipsContainer.classList.remove("hidden");
  const allChipHtml = `
    <button type="button" class="scenario-domain-chip${scenarioDomainFilter === "all" ? " active" : ""}" data-domain="all" title="모든 도메인/사이트 시나리오 보기">
      <span>🌐 전체</span>
      <span class="domain-chip-count">(${allScenariosList.length})</span>
    </button>
  `;

  const domainChipsHtml = groups
    .map((g) => {
      const isActive = scenarioDomainFilter === g.domainKey;
      const label = g.siteName && g.siteName !== g.domainKey ? `${g.siteName}` : g.domainKey;
      return `
        <button type="button" class="scenario-domain-chip${isActive ? " active" : ""}" data-domain="${escapeHtmlAttr(g.domainKey)}" title="${escapeHtmlAttr(g.siteName)} (${escapeHtmlAttr(g.domainKey)}) 시나리오만 필터링">
          <span class="domain-chip-dot" style="background:${escapeHtmlAttr(g.primaryColor || "#0068FF")};"></span>
          <span>${escapeHtmlAttr(label)}</span>
          <span class="domain-chip-count">(${g.items.length})</span>
        </button>
      `;
    })
    .join("");

  chipsContainer.innerHTML = allChipHtml + domainChipsHtml;

  chipsContainer.querySelectorAll(".scenario-domain-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      scenarioDomainFilter = chip.dataset.domain || "all";
      renderScenarioList();
    });
  });
}

function renderScenarioList() {
  if (!scenarioCardsContainer) return;

  renderScenarioDomainChips();

  const query = (scenarioSearchQuery || "").trim().toLowerCase();
  const filtered = allScenariosList.filter((s) => {
    if (scenarioFilterMode === "rendered" && !s.hasRenderedVideo) return false;
    if (scenarioFilterMode === "recorded" && !s.hasVideo) return false;
    if (scenarioFilterMode === "eyedropper" && !s.recordedByEyedropper) return false;
    if (scenarioDomainFilter !== "all" && (s.domainKey || "other") !== scenarioDomainFilter) return false;
    if (query) {
      const slugMatch = (s.slug || "").toLowerCase().includes(query);
      const flowMatch = (s.flowSummary || "").toLowerCase().includes(query);
      const siteMatch = (s.siteName || "").toLowerCase().includes(query);
      const domainMatch = (s.domainKey || "").toLowerCase().includes(query);
      return slugMatch || flowMatch || siteMatch || domainMatch;
    }
    return true;
  });

  if (scenariosCount) {
    scenariosCount.textContent =
      filtered.length === allScenariosList.length
        ? `${allScenariosList.length}개`
        : `${filtered.length} / ${allScenariosList.length}개`;
  }

  scenarioCardsContainer.innerHTML = "";

  if (filtered.length === 0) {
    scenarioCardsContainer.innerHTML = `
      <div class="studio-empty-box" style="margin-top: 12px;">
        조건에 맞는 시나리오가 없습니다.<br>검색어나 필터/도메인 칩을 변경해보세요.
      </div>
    `;
    renderMergeQueueUI();
    return;
  }

  const domainGroups = buildDomainSummaryGroups(filtered);

  domainGroups.forEach((group) => {
    const groupEl = document.createElement("div");
    const isCollapsed = collapsedDomainGroups.has(group.domainKey) && !query && scenarioDomainFilter === "all";
    groupEl.className = `scenario-domain-group${isCollapsed ? " collapsed" : ""}`;
    groupEl.dataset.domainGroup = group.domainKey;

    const headerEl = document.createElement("div");
    headerEl.className = "scenario-domain-group-header";
    headerEl.title = `클릭하여 '${group.siteName} (${group.domainKey})' 그룹 접기/펼치기`;
    const hostDisplay = group.domainKey && group.domainKey !== group.siteName ? group.domainKey : "";
    headerEl.innerHTML = `
      <div class="domain-group-left">
        <span class="domain-group-color-bar" style="background:${escapeHtmlAttr(group.primaryColor || "#0068FF")};"></span>
        ${
          group.logoUrl
            ? `<img class="domain-group-logo" src="${escapeHtmlAttr(group.logoUrl)}" alt="${escapeHtmlAttr(group.siteName)}" onerror="this.style.display='none'" />`
            : ""
        }
        <span class="domain-group-title">${escapeHtmlAttr(group.siteName)}</span>
        ${hostDisplay ? `<span class="domain-group-host">${escapeHtmlAttr(hostDisplay)}</span>` : ""}
      </div>
      <div class="domain-group-right">
        <span class="domain-group-count">${group.items.length}개</span>
        <span class="domain-group-chevron">▼</span>
      </div>
    `;

    headerEl.addEventListener("click", () => {
      const nowCollapsed = !groupEl.classList.contains("collapsed");
      groupEl.classList.toggle("collapsed", nowCollapsed);
      if (nowCollapsed) {
        collapsedDomainGroups.add(group.domainKey);
      } else {
        collapsedDomainGroups.delete(group.domainKey);
      }
      saveCollapsedDomainGroups();
    });

    const bodyEl = document.createElement("div");
    bodyEl.className = "scenario-domain-group-body";

    group.items.forEach((s) => {
      const item = document.createElement("div");
      item.className = "scenario-item";
      item.dataset.slug = s.slug;
      item.dataset.domainKey = s.domainKey || "other";
      if (selectedScenario === s.slug) item.classList.add("selected");

      const isActivelyRendering =
        activeRenderTask &&
        (activeRenderTask.status === "running" || activeRenderTask.status === "queued") &&
        activeRenderTask.slug === s.slug;
      const isQueuedForRender =
        !isActivelyRendering &&
        Array.isArray(renderQueueList) &&
        renderQueueList.some((q) => q && q.slug === s.slug);

      const statusBadgeHtml = isActivelyRendering
        ? `<span class="status-tag status-tag-rendering" data-render-badge="${escapeHtmlAttr(s.slug)}" title="백그라운드 최종 MP4 렌더링 진행 중 (${activeRenderTask.fps || 30}fps)">⏳ 렌더링 ${activeRenderTask.progress || 0}%</span>`
        : isQueuedForRender
        ? `<span class="status-tag status-tag-queued" data-render-badge="${escapeHtmlAttr(s.slug)}" title="백그라운드 렌더링 대기열 등록됨">🕒 대기 중</span>`
        : s.hasRenderedVideo
        ? '<span class="status-tag status-tag-rendered" title="줌/커서 합성 최종 MP4 완료">✨ 최종본</span>'
        : s.hasVideo
        ? '<span class="status-tag status-tag-raw" title="원본 브라우저 녹화 완료">📹 녹화됨</span>'
        : '<span class="status-tag status-tag-empty">녹화 전</span>';

      const mergedBadgeHtml =
        Array.isArray(s.mergedFromSlugs) && s.mergedFromSlugs.length > 0
          ? `<span class="status-tag status-tag-merged" title="병합된 챕터: ${escapeHtmlAttr(s.mergedFromSlugs.join(" + "))}">🔗 병합본</span>`
          : "";

      const queueIdx = videoMergeQueue.indexOf(s.slug);
      if (queueIdx >= 0) item.classList.add("in-merge-queue");
      const mergeBtnHtml =
        s.hasRenderedVideo || s.hasVideo
          ? `<button type="button" class="btn-card-merge ${queueIdx >= 0 ? "in-queue" : ""}" title="${
              queueIdx >= 0
                ? `현재 합치기 목록 #${queueIdx + 1}번에 담겨 있습니다 (클릭 시 해제)`
                : "이 영상을 통합 목차(Master Contents) 슬라이드가 포함된 합치기 목록에 추가합니다"
            }">${queueIdx >= 0 ? `✓ 합치기 #${queueIdx + 1}` : "🔗 합치기+"}</button>`
          : "";

      item.innerHTML = `
        <div class="scenario-item-header">
          <div class="scenario-title-stack">
            <span class="scenario-topic-title" title="${escapeHtmlAttr(s.slug)}">${escapeHtmlAttr(s.slug)}</span>
          </div>
          <div class="scenario-badges-right">
            ${mergedBadgeHtml}
            ${s.recordedByEyedropper ? '<span class="status-tag status-tag-eye" title="스포이드 직접 시범 시나리오">💧</span>' : ""}
            ${s.hasNarration ? '<span class="status-tag status-tag-tts" title="AI 나레이션 음성 합성됨">🎙️</span>' : ""}
            ${statusBadgeHtml}
          </div>
        </div>
        <div class="scenario-flow-summary" title="${escapeHtmlAttr(s.flowSummary || "")}">
          ${escapeHtmlAttr(s.flowSummary || "동작 설명이 등록되지 않은 시나리오입니다.")}
        </div>
        <div class="scenario-meta-row">
          <div class="scenario-meta-stats">
            <span>🎯 ${s.actionsCount}단계</span>
            <span>🔍 줌 ${s.zoomSegmentsCount}구간</span>
            ${s.durationSec ? `<span>⏱️ ${s.durationSec}s</span>` : ""}
          </div>
          <div class="scenario-card-actions-right">
            ${mergeBtnHtml}
            <button type="button" class="btn-card-edit" title="브라우징 플랜 편집기(탭 1)에서 이 시나리오 열기">✏️ 편집</button>
            <button type="button" class="btn-card-delete" title="이 시나리오와 관련 녹화/렌더링 파일을 모두 삭제합니다">🗑️</button>
          </div>
        </div>
      `;

      const mergeBtn = item.querySelector(".btn-card-merge");
      if (mergeBtn) {
        mergeBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          toggleScenarioInMergeQueue(s.slug);
        });
      }

      const editBtn = item.querySelector(".btn-card-edit");
      if (editBtn) {
        editBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          loadScenarioIntoEditor(s.slug, true);
        });
      }

      const deleteBtn = item.querySelector(".btn-card-delete");
      if (deleteBtn) {
        deleteBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          handleDeleteScenario(s.slug);
        });
      }

      item.addEventListener("click", () => selectScenario(s.slug));
      bodyEl.appendChild(item);
    });

    groupEl.appendChild(headerEl);
    groupEl.appendChild(bodyEl);
    scenarioCardsContainer.appendChild(groupEl);
  });

  renderMergeQueueUI();
}

async function handleDeleteScenario(slug) {
  if (!slug) return;
  const confirmed = await showAppConfirm(
    `⚠️ '${slug}' 시나리오를 정말 삭제하시겠습니까?\n\n브라우징 플랜, 원본 녹화 영상(recording.mp4), AI 나레이션, 최종 렌더링 MP4가 모두 함께 삭제되며 되돌릴 수 없습니다.`
  );
  if (!confirmed) return;

  try {
    // Release Windows file lock if this scenario's video is currently loaded in the player
    if (selectedScenario === slug && typeof releaseVideoFileLock === "function") {
      await releaseVideoFileLock();
    }

    const res = await fetch(`/api/scenarios/${encodeURIComponent(slug)}`, {
      method: "DELETE",
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.error || "시나리오 삭제 실패");
    }

    delete scenarioDetailsCache[slug];
    const qIdx = videoMergeQueue.indexOf(slug);
    if (qIdx >= 0) {
      videoMergeQueue.splice(qIdx, 1);
    }

    if (currentSlug === slug) {
      currentSlug = "";
      currentPlan = null;
      if (slugInput && slugInput.value === slug) slugInput.value = "";
      if (editorScenarioSelect && editorScenarioSelect.value === slug) editorScenarioSelect.value = "";
      if (planSlugBadge) planSlugBadge.textContent = "시나리오 미선택";
      renderActionCards();
    }

    const wasSelected = selectedScenario === slug;
    if (wasSelected) {
      selectedScenario = null;
    }

    await fetchScenarios();

    if (wasSelected && !selectedScenario && allScenariosList.length === 0) {
      if (playerTitle) playerTitle.textContent = "영상 미리보기";
      if (playerFlowSubtitle) playerFlowSubtitle.textContent = "좌측 라이브러리에서 시나리오를 선택해주세요.";
      if (playerMeta) playerMeta.textContent = "시나리오를 선택해주세요";
      if (playerStatusBadges) playerStatusBadges.innerHTML = "";
      if (videoPlayer) {
        videoPlayer.style.display = "none";
        videoPlayer.src = "";
      }
      if (videoEmpty) videoEmpty.style.display = "flex";
    }
  } catch (err) {
    alert(`❌ 시나리오 삭제 실패: ${err.message}`);
  }
}

let latestStorageStats = null;

function formatBytesToMbOrGb(bytes) {
  const num = Number(bytes || 0);
  if (num <= 0) return "0 MB";
  const mb = num / (1024 * 1024);
  if (mb >= 1024) {
    return `${(mb / 1024).toFixed(2)} GB (${mb.toFixed(0)} MB)`;
  }
  return `${mb.toFixed(1)} MB`;
}

function updateSelectedStorageReclaimUI() {
  if (!latestStorageStats) return;
  const r = latestStorageStats.reclaimable || {};
  const chkHardlinks = document.getElementById("chk-storage-hardlinks");
  const chkTemp = document.getElementById("chk-storage-temp");
  const chkOrphan = document.getElementById("chk-storage-orphan");
  const chkUndo = document.getElementById("chk-storage-undo");
  const badgeEl = document.getElementById("storage-reclaim-badge");
  const execBtn = document.getElementById("btn-execute-storage-cleanup");

  let selectedBytes = 0;
  if (!chkHardlinks || chkHardlinks.checked) {
    selectedBytes += Number(r.deduplicateHardlinks?.bytes || 0);
  }
  if (!chkTemp || chkTemp.checked) {
    selectedBytes += Number(r.tempCacheFiles?.bytes || 0);
  }
  if (!chkOrphan || chkOrphan.checked) {
    selectedBytes += Number(r.orphanOutputs?.bytes || 0);
  }
  if (chkUndo && chkUndo.checked) {
    selectedBytes += Number(r.undoBackups?.bytes || 0);
  }

  if (badgeEl) {
    badgeEl.textContent =
      selectedBytes > 100 * 1024
        ? `약 ${formatBytesToMbOrGb(selectedBytes)} 절감 가능`
        : "✨ 최적화 완료됨";
  }
  if (execBtn) {
    execBtn.disabled = selectedBytes <= 0;
  }
}

async function loadStorageStats() {
  const summaryEl = document.getElementById("storage-stats-summary");
  const badgeEl = document.getElementById("storage-reclaim-badge");
  try {
    if (badgeEl) badgeEl.textContent = "분석 중...";
    const res = await fetch("/api/storage/stats");
    if (!res.ok) throw new Error("용량 조회 실패");
    const data = await res.json();
    const stats = data.stats;
    if (!stats) return;
    latestStorageStats = stats;

    const r = stats.reclaimable || {};
    const hlSizeEl = document.getElementById("storage-size-hardlinks");
    const tmpSizeEl = document.getElementById("storage-size-temp");
    const orpSizeEl = document.getElementById("storage-size-orphan");
    const undoSizeEl = document.getElementById("storage-size-undo");
    const toggleBtn = document.getElementById("btn-toggle-storage-drawer");

    if (hlSizeEl) {
      hlSizeEl.textContent = `${formatBytesToMbOrGb(r.deduplicateHardlinks?.bytes || 0)} (${r.deduplicateHardlinks?.count || 0}개)`;
    }
    if (tmpSizeEl) {
      tmpSizeEl.textContent = `${formatBytesToMbOrGb(r.tempCacheFiles?.bytes || 0)} (${r.tempCacheFiles?.count || 0}개)`;
    }
    if (orpSizeEl) {
      orpSizeEl.textContent = `${formatBytesToMbOrGb(r.orphanOutputs?.bytes || 0)} (${r.orphanOutputs?.count || 0}개)`;
    }
    if (undoSizeEl) {
      undoSizeEl.textContent = `${formatBytesToMbOrGb(r.undoBackups?.bytes || 0)} (${r.undoBackups?.count || 0}개)`;
    }

    if (summaryEl) {
      const savedText =
        stats.hardlinkSavedBytes > 1024 * 1024
          ? ` · 🔗 하드링크 절감 중: <strong>${formatBytesToMbOrGb(stats.hardlinkSavedBytes)}</strong>`
          : "";
      summaryEl.innerHTML = `실제 디스크 점유: <strong>${formatBytesToMbOrGb(stats.physicalTotalBytes)}</strong> <span style="opacity:0.8">(논리 합계: ${formatBytesToMbOrGb(stats.logicalTotalBytes)})</span>${savedText}`;
    }

    if (toggleBtn) {
      const safeReclaimMb = (Number(r.totalBytes || 0) / (1024 * 1024)).toFixed(0);
      toggleBtn.textContent =
        Number(r.totalBytes || 0) > 10 * 1024 * 1024
          ? `🧹 용량 (-${safeReclaimMb}MB)`
          : "🧹 용량";
    }

    updateSelectedStorageReclaimUI();
  } catch (err) {
    if (summaryEl) {
      summaryEl.textContent = `용량 분석 실패: ${err.message}`;
    }
  }
}

function toggleStorageDrawer(forceOpen = null) {
  const drawer = document.getElementById("storage-optimizer-drawer");
  const btn = document.getElementById("btn-toggle-storage-drawer");
  if (!drawer) return;
  const shouldOpen = forceOpen !== null ? Boolean(forceOpen) : drawer.classList.contains("hidden");
  drawer.classList.toggle("hidden", !shouldOpen);
  if (btn) btn.classList.toggle("active", shouldOpen);
  if (shouldOpen) {
    loadStorageStats();
  }
}

async function handleExecuteStorageCleanup() {
  const execBtn = document.getElementById("btn-execute-storage-cleanup");
  const resultEl = document.getElementById("storage-cleanup-result");
  const chkHardlinks = document.getElementById("chk-storage-hardlinks");
  const chkTemp = document.getElementById("chk-storage-temp");
  const chkOrphan = document.getElementById("chk-storage-orphan");
  const chkUndo = document.getElementById("chk-storage-undo");

  const origHtml = execBtn ? execBtn.innerHTML : "";
  try {
    if (execBtn) {
      execBtn.disabled = true;
      execBtn.innerHTML = `<span class="spinner" style="width:12px;height:12px;border-width:2px"></span> 최적화 진행 중...`;
    }
    if (resultEl) {
      resultEl.classList.add("hidden");
    }

    const res = await fetch("/api/storage/cleanup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        deduplicateHardlinks: chkHardlinks ? chkHardlinks.checked : true,
        cleanTempFiles: chkTemp ? chkTemp.checked : true,
        cleanOrphanOutputs: chkOrphan ? chkOrphan.checked : true,
        cleanUndoBackups: chkUndo ? chkUndo.checked : false,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || "디스크 용량 최적화 실패");
    }

    if (resultEl) {
      const reclaimedStr = formatBytesToMbOrGb(data.reclaimedBytes || 0);
      resultEl.innerHTML = `✅ <strong>최적화 완료!</strong> 물리 디스크 용량 <strong>${reclaimedStr}</strong> 절감 (🔗 하드링크 통합 ${data.hardlinkedCount || 0}건 · 🗑️ 임시/불필요 파일 정리 ${data.deletedCount || 0}건)`;
      resultEl.classList.remove("hidden");
    }

    await loadStorageStats();
  } catch (err) {
    alert(`❌ 디스크 용량 최적화 오류: ${err.message}`);
  } finally {
    if (execBtn) {
      execBtn.innerHTML = origHtml || "⚡ 선택한 항목 즉시 최적화";
      updateSelectedStorageReclaimUI();
    }
  }
}

function toggleMergeDrawer(forceOpen = null) {
  const drawer = document.getElementById("video-merge-drawer");
  const btn = document.getElementById("btn-toggle-merge-drawer");
  if (!drawer) return;
  const shouldOpen = forceOpen !== null ? Boolean(forceOpen) : drawer.classList.contains("hidden");
  drawer.classList.toggle("hidden", !shouldOpen);
  if (btn) btn.classList.toggle("active", shouldOpen);
  renderMergeQueueUI();
}

function toggleScenarioInMergeQueue(slug) {
  if (!slug) return;
  const idx = videoMergeQueue.indexOf(slug);
  if (idx >= 0) {
    videoMergeQueue.splice(idx, 1);
  } else {
    videoMergeQueue.push(slug);
    toggleMergeDrawer(true);
  }
  renderScenarioList();
}

function moveMergeQueueItem(idx, delta) {
  const targetIdx = idx + delta;
  if (idx < 0 || idx >= videoMergeQueue.length || targetIdx < 0 || targetIdx >= videoMergeQueue.length) {
    return;
  }
  const tmp = videoMergeQueue[idx];
  videoMergeQueue[idx] = videoMergeQueue[targetIdx];
  videoMergeQueue[targetIdx] = tmp;
  renderScenarioList();
}

function removeMergeQueueItem(idx) {
  if (idx < 0 || idx >= videoMergeQueue.length) return;
  videoMergeQueue.splice(idx, 1);
  renderScenarioList();
}

function clearMergeQueue() {
  videoMergeQueue = [];
  renderScenarioList();
}

function renderMergeQueueUI() {
  const listEl = document.getElementById("merge-queue-list");
  const summaryEl = document.getElementById("merge-queue-summary");
  const toggleBtn = document.getElementById("btn-toggle-merge-drawer");
  const execBtn = document.getElementById("btn-execute-video-merge");

  let totalDur = 0;
  videoMergeQueue.forEach((slug) => {
    const found = allScenariosList.find((x) => x.slug === slug);
    if (found && found.durationSec) {
      totalDur += Number(found.durationSec || 0);
    }
  });

  if (summaryEl) {
    summaryEl.textContent =
      videoMergeQueue.length > 0
        ? `${videoMergeQueue.length}개 챕터 · 약 ${totalDur.toFixed(1)}초`
        : "0개 선택됨";
  }

  if (toggleBtn) {
    toggleBtn.textContent =
      videoMergeQueue.length > 0 ? `🔗 합치기 (${videoMergeQueue.length})` : "🔗 합치기";
  }

  if (execBtn) {
    execBtn.disabled = videoMergeQueue.length < 2;
  }

  if (!listEl) return;
  listEl.innerHTML = "";

  if (videoMergeQueue.length === 0) {
    listEl.innerHTML = `<div class="merge-queue-empty">선택된 영상이 없습니다. 아래 시나리오 카드에서 [🔗 합치기+]를 눌러 추가하세요.<br/><span style="font-size:11px;opacity:0.8;">✨ 병합 시 제일 앞에 [전체 통합 목차 슬라이드 + 전체 오프닝 음성]이 자동 생성됩니다.</span></div>`;
    return;
  }

  videoMergeQueue.forEach((slug, idx) => {
    const found = allScenariosList.find((x) => x.slug === slug);
    const durText = found?.durationSec ? `${found.durationSec}s` : "";
    const row = document.createElement("div");
    row.className = "merge-queue-item";
    row.innerHTML = `
      <div class="merge-queue-item-left">
        <span class="merge-queue-order">${idx + 1}</span>
        <span class="merge-queue-slug" title="${escapeHtmlAttr(slug)}">${escapeHtmlAttr(slug)}</span>
        ${durText ? `<span class="merge-queue-dur">(${durText})</span>` : ""}
      </div>
      <div class="merge-queue-actions">
        <button type="button" class="btn-merge-step btn-merge-up" title="위로 이동" ${idx === 0 ? "disabled" : ""}>↑</button>
        <button type="button" class="btn-merge-step btn-merge-down" title="아래로 이동" ${
          idx === videoMergeQueue.length - 1 ? "disabled" : ""
        }>↓</button>
        <button type="button" class="btn-merge-step btn-merge-remove" title="목록에서 제거">✕</button>
      </div>
    `;

    row.querySelector(".btn-merge-up")?.addEventListener("click", () => moveMergeQueueItem(idx, -1));
    row.querySelector(".btn-merge-down")?.addEventListener("click", () => moveMergeQueueItem(idx, 1));
    row.querySelector(".btn-merge-remove")?.addEventListener("click", () => removeMergeQueueItem(idx));
    listEl.appendChild(row);
  });
}

async function handleExecuteVideoMerge() {
  if (videoMergeQueue.length < 2) {
    alert("합칠 시나리오 영상을 최소 2개 이상 선택해주세요.");
    return;
  }

  const slugInputEl = document.getElementById("merge-output-slug-input");
  const execBtn = document.getElementById("btn-execute-video-merge");
  const outputSlug = slugInputEl ? slugInputEl.value.trim() : "";

  const origBtnHtml = execBtn ? execBtn.innerHTML : "";
  if (execBtn) {
    execBtn.disabled = true;
    execBtn.innerHTML = "⏳ 전체 통합 목차 슬라이드·음성 생성 및 영상 병합 중...";
  }

  try {
    const res = await fetch("/api/video-edit/merge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slugs: videoMergeQueue,
        outputSlug: outputSlug || undefined,
      }),
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.error || "영상 합치기 실패");
    }

    const mergedSlug = data.outputSlug;
    delete scenarioDetailsCache[mergedSlug];
    await fetchScenarios();
    await selectScenario(mergedSlug, "rendered");
    if (slugInputEl) slugInputEl.value = mergedSlug;
  } catch (err) {
    alert(`영상 합치기 오류: ${err.message}`);
  } finally {
    if (execBtn) {
      execBtn.disabled = videoMergeQueue.length < 2;
      execBtn.innerHTML = origBtnHtml || "🔗 순서대로 하나로 합치기";
    }
  }
}

async function loadScenarioIntoEditor(slug, switchToEditorTab = true) {
  if (!slug) return;
  try {
    let details = scenarioDetailsCache[slug];
    if (!details) {
      const res = await fetch(`/api/scenarios/${slug}`);
      if (!res.ok) throw new Error("시나리오 로드 실패");
      details = await res.json();
      scenarioDetailsCache[slug] = details;
    }
    if (details && details.browsePlan) {
      currentPlan = JSON.parse(JSON.stringify(details.browsePlan));
      currentSlug = slug;
      if (slugInput) slugInput.value = slug;
      if (editorScenarioSelect) editorScenarioSelect.value = slug;
      const summaryObj = allScenariosList.find((x) => x.slug === slug);
      const flowText = summaryObj?.flowSummary || "";
      if (planSlugBadge) {
        planSlugBadge.textContent = `📌 ${slug}${details.browsePlan.recordedByEyedropper ? " · 💧 스포이드 실측" : ""}`;
      }
      if (explanationText) {
        explanationText.textContent = flowText
          ? `📂 [${slug}] 시나리오를 불러왔습니다. 흐름: ${flowText}`
          : `📂 기존 시나리오 '${slug}' (${details.browsePlan.actions?.length || 0}개 단계)를 불러왔습니다.`;
      }
      renderActionCards();
      if (switchToEditorTab) {
        switchTab("tab-generator");
        const editorCardEl = document.querySelector(".editor-card");
        if (editorCardEl) {
          editorCardEl.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      }
    }
  } catch (err) {
    alert(`시나리오 불러오기 실패: ${err.message}`);
  }
}

// 6. Select & View Scenario
async function selectScenario(slug, preferMode = null) {
  selectedScenario = slug;

  document.querySelectorAll(".scenario-item").forEach((el) => {
    const itemSlug = el.dataset.slug || el.querySelector(".scenario-slug")?.textContent;
    el.classList.toggle("selected", itemSlug === slug);
  });

  const playerSlugChip = document.getElementById("player-slug-chip");
  if (playerTitle) {
    playerTitle.textContent = slug;
  }
  if (playerSlugChip) {
    playerSlugChip.classList.add("hidden");
  }
  if (playerMeta) playerMeta.textContent = "상세 정보 불러오는 중...";

  try {
    const res = await fetch(`/api/scenarios/${slug}?t=${Date.now()}`, { cache: "no-store" });
    const details = await res.json();
    scenarioDetailsCache[slug] = details;

    const actions = details.browsePlan?.actions || [];
    const coreActionsCount = actions.filter((a) => a.type !== "wait" && a.type !== "navigate").length;
    const zoomCount = details.editPlan?.segments?.length || 0;
    const fps = details.editPlan?.fps || 60;
    const totalFrames = details.editPlan?.totalDurationFrames || 0;
    const durationSec = totalFrames > 0 ? (totalFrames / fps).toFixed(1) : null;
    const summaryItem = allScenariosList.find((s) => s.slug === slug);

    if (playerTitle) {
      playerTitle.textContent = slug;
    }
    if (playerSlugChip) {
      playerSlugChip.classList.add("hidden");
    }

    // Check Rendered Video Info
    let renderInfo = { exists: false };
    try {
      const renderRes = await fetch(`/api/render/info/${slug}?t=${Date.now()}`, { cache: "no-store" });
      if (renderRes.ok) {
        renderInfo = await renderRes.json();
      }
    } catch {}

    unappliedNarrationState.slug = slug;
    unappliedNarrationState.dirty = false;
    unappliedNarrationState.needsSlideBake = false;
    unappliedNarrationState.reason = "";
    unappliedNarrationState.dismissed = false;
    unappliedNarrationState.renderInfo = renderInfo;

    updateRenderUI();

    // Render Korean Flow Subtitle
    if (playerFlowSubtitle) {
      const flowStr =
        summaryItem?.flowSummary ||
        actions
          .filter((a) => a.type !== "wait" && a.type !== "navigate" && a.description)
          .slice(0, 6)
          .map((a) => a.description)
          .join(" ➔ ");
      playerFlowSubtitle.textContent = flowStr || "등록된 단계별 한글 설명이 없습니다.";
    }

    if (playerMeta) {
      playerMeta.textContent = `전체 액션 ${actions.length}개 (핵심 조작 ${coreActionsCount}개) · 카메라 줌 ${zoomCount}구간${
        durationSec ? ` · 총 길이 ${durationSec}초` : ""
      }`;
    }

    if (btnDownloadVideo) {
      if (renderInfo.exists) {
        btnDownloadVideo.classList.remove("hidden");
        btnDownloadVideo.href = renderInfo.downloadUrl;
        btnDownloadVideo.download = `${slug}-final.mp4`;
        const sizeMb = ((renderInfo.fileSizeBytes || 0) / (1024 * 1024)).toFixed(1);
        btnDownloadVideo.innerHTML = `💾 다운로드 <small>(${sizeMb}MB)</small>`;
      } else {
        btnDownloadVideo.classList.add("hidden");
      }
    }

    // Determine video playback mode
    const targetMode = preferMode || (renderInfo.exists && currentVideoMode === "rendered" ? "rendered" : "raw");
    setVideoMode(targetMode, details, renderInfo);

    handleClearCutRange();
    renderTimelineVisual(details);
    renderMomentsStepList(details);
    renderNarrationStudio(details);
    updateJsonViewer("browse");
  } catch (err) {
    console.error("selectScenario failed:", err);
  }
}

const unappliedNarrationState = {
  slug: "",
  dirty: false,
  needsSlideBake: false,
  reason: "",
  dismissed: false,
  renderInfo: null,
};

async function refreshScenarioRenderInfo(slug = selectedScenario) {
  if (!slug) return null;
  try {
    const renderRes = await fetch(`/api/render/info/${slug}?t=${Date.now()}`, { cache: "no-store" });
    if (renderRes.ok) {
      const info = await renderRes.json();
      if (slug === selectedScenario) {
        unappliedNarrationState.renderInfo = info;
      }
      return info;
    }
  } catch {}
  return null;
}

function markNarrationUnapplied(reason, options = {}) {
  if (!selectedScenario) return;
  unappliedNarrationState.slug = selectedScenario;
  unappliedNarrationState.dirty = true;
  if (options.needsSlideBake) {
    unappliedNarrationState.needsSlideBake = true;
  }
  unappliedNarrationState.reason =
    reason || "대본·오프닝 목차 또는 구간 홀드 변경 사항이 아직 실제 영상 파일에 재합성되지 않았습니다.";
  unappliedNarrationState.dismissed = false;
  updatePlayerStatusAndModeBadges(scenarioDetailsCache[selectedScenario], unappliedNarrationState.renderInfo);
}

async function clearNarrationUnapplied() {
  unappliedNarrationState.dirty = false;
  unappliedNarrationState.needsSlideBake = false;
  unappliedNarrationState.reason = "";
  unappliedNarrationState.dismissed = false;
  const info = await refreshScenarioRenderInfo(selectedScenario);
  updatePlayerStatusAndModeBadges(scenarioDetailsCache[selectedScenario], info);
}

async function handleApplyUnappliedNarration() {
  if (!selectedScenario) return;
  const slug = selectedScenario;
  const applyBtn = document.getElementById("btn-apply-unapplied-narration");
  const prevSec = videoPlayer && Number.isFinite(videoPlayer.currentTime) ? videoPlayer.currentTime : 0;
  const needsSlideBake = Boolean(unappliedNarrationState.needsSlideBake);

  if (applyBtn) {
    applyBtn.disabled = true;
    applyBtn.textContent = "⏳ 영상·음성·슬라이드 즉시 반영 중...";
  }
  stopRealtimeHoldAndAudio();
  if (typeof releaseVideoFileLock === "function") {
    await releaseVideoFileLock();
  }

  try {
    const narration = collectNarrationFromUI({ sortByStartTime: true });
    const res = await fetch(`/api/narration/${slug}/save`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        narration,
        synthesize: true,
        bakeSlide: needsSlideBake,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "반영 실패");

    const details = scenarioDetailsCache[slug];
    if (details) {
      if (data.narration) details.narration = data.narration;
      if (data.moments) details.moments = data.moments;
      if (data.editPlan) details.editPlan = data.editPlan;
      syncScenarioTimelineInMemory(details);
    }

    await clearNarrationUnapplied();
    setVideoMode(currentVideoMode, details, unappliedNarrationState.renderInfo);
    if (videoPlayer && prevSec > 0.5) {
      videoPlayer.addEventListener(
        "loadedmetadata",
        () => {
          videoPlayer.currentTime = Math.min(prevSec, Math.max(0, (videoPlayer.duration || prevSec) - 0.2));
        },
        { once: true }
      );
    }
    renderNarrationStudio(details);
    renderTimelineVisual(details);
    renderMomentsStepList(details);
    updateJsonViewer("narration");
    fetchScenarios();
  } catch (err) {
    alert(`변경 사항 영상 반영 오류: ${err.message}`);
  } finally {
    if (applyBtn) {
      applyBtn.disabled = false;
      applyBtn.textContent = "⚡ 지금 영상에 즉시 반영 (TTS·슬라이드 재합성)";
    }
  }
}

function updatePlayerStatusAndModeBadges(details, renderInfo = null) {
  if (!selectedScenario) return;
  const slug = selectedScenario;
  const d = details || scenarioDetailsCache[slug] || {};
  const rInfo = renderInfo || unappliedNarrationState.renderInfo || { exists: Boolean(d.hasRenderedVideo) };
  const narration = d.narration || d.editPlan?.narration || null;
  const cues = Array.isArray(narration?.cues) ? narration.cues : [];
  const hasTts = cues.length > 0;
  const mergedSlugs = Array.isArray(narration?.mergedFromSlugs)
    ? narration.mergedFromSlugs
    : Array.isArray(d.browsePlan?.mergedFromSlugs)
    ? d.browsePlan.mergedFromSlugs
    : [];
  const isMergedScenario = mergedSlugs.length > 0;
  const hasUnsynthesized =
    Boolean(rInfo.hasUnsynthesizedCues) ||
    (hasTts && narration?.enabled !== false && cues.some((c) => !c.audioFile));
  const isDirtyOrOutdated =
    Boolean(unappliedNarrationState.dirty) ||
    hasUnsynthesized ||
    (Boolean(rInfo.isOutdated) && !unappliedNarrationState.dismissed);

  // 1) Top Header Status Badges (#player-status-badges)
  if (playerStatusBadges) {
    const badges = [];
    if (isMergedScenario) {
      badges.push(
        `<span class="status-tag status-tag-merged" title="병합 원본 챕터: ${escapeHtmlAttr(
          mergedSlugs.join(" ➔ ")
        )}">🔗 ${mergedSlugs.length}챕터 병합</span>`
      );
    } else if (d.browsePlan?.recordedByEyedropper) {
      badges.push('<span class="status-tag status-tag-eye" title="스포이드 동작 감지로 캡처된 시나리오">💧 스포이드</span>');
    }

    if (rInfo.exists || d.hasRenderedVideo) {
      if (isDirtyOrOutdated) {
        badges.push(
          `<span class="status-tag status-tag-warn" title="${escapeHtmlAttr(
            unappliedNarrationState.reason || rInfo.outdatedReason || "대본·슬라이드 수정 사항 재합성 필요"
          )}">⚠️ MP4 재합성 필요</span>`
        );
      } else {
        badges.push(
          '<span class="status-tag status-tag-rendered" title="최신 대본·슬라이드·줌·커서가 최종 MP4에 모두 반영되어 있습니다">✨ 최신 MP4</span>'
        );
      }
    } else if (d.hasVideo) {
      badges.push('<span class="status-tag status-tag-raw">📹 원본 녹화본</span>');
    } else {
      badges.push('<span class="status-tag status-tag-empty">녹화 전</span>');
    }

    if (hasTts) {
      if (unappliedNarrationState.dirty || hasUnsynthesized) {
        badges.push(
          `<span class="status-tag status-tag-warn" title="수정된 대본 또는 미합성 음성이 있습니다">🎙️ 대본 수정됨(${cues.length})</span>`
        );
      } else {
        badges.push(`<span class="status-tag status-tag-tts" title="AI 나레이션 대본 및 TTS 음성 (${cues.length}구간)">🎙️ 대본 ${cues.length}구간</span>`);
      }
    }

    if (
      activeRenderTask &&
      (activeRenderTask.status === "running" || activeRenderTask.status === "queued") &&
      activeRenderTask.slug === slug
    ) {
      badges.push(
        `<span class="status-tag status-tag-rendering" id="player-live-render-badge">⏳ 렌더링 ${
          activeRenderTask.progress || 0
        }% (${activeRenderTask.fps || 30}fps)</span>`
      );
    } else if (Array.isArray(renderQueueList) && renderQueueList.some((q) => q && q.slug === slug)) {
      badges.push('<span class="status-tag status-tag-queued" id="player-live-render-badge">🕒 렌더링 대기 중</span>');
    }
    playerStatusBadges.innerHTML = badges.join("");
  }

  // 2) Mode Switch Button Labels & Player Right Badge (#video-mode-badge)
  if (btnModeRaw) {
    btnModeRaw.textContent = isMergedScenario
      ? "📹 병합 마스터 원본"
      : hasTts && narration?.enabled !== false
      ? "📹 원본 녹화본 (실시간 TTS·홀드)"
      : "📹 원본 브라우저 녹화본";
  }
  if (btnModeRendered) {
    btnModeRendered.textContent = isMergedScenario
      ? "✨ 챕터 병합 최종본"
      : rInfo.exists || d.hasRenderedVideo
      ? "✨ 줌/커서 합성 최종본"
      : "✨ 줌/커서 합성 최종본 (미생성)";
  }

  if (videoModeBadge) {
    videoModeBadge.classList.remove("mode-badge-rendered", "mode-badge-sim", "mode-badge-merged", "mode-badge-warn");
    if (currentVideoMode === "rendered") {
      const hasRendered = rInfo ? rInfo.exists : d.hasRenderedVideo || false;
      if (!hasRendered) {
        videoModeBadge.textContent = "⚠️ 최종 렌더링 파일 없음 (렌더링 필요)";
        videoModeBadge.classList.add("mode-badge-warn");
      } else if (isDirtyOrOutdated) {
        videoModeBadge.textContent = "⚠️ 최종본 재생 중 (미반영 대본·편집 있음)";
        videoModeBadge.classList.add("mode-badge-warn");
      } else if (isMergedScenario) {
        videoModeBadge.textContent = `🔗 ${mergedSlugs.length}개 챕터 병합 최종본 재생 중`;
        videoModeBadge.classList.add("mode-badge-merged");
      } else {
        videoModeBadge.textContent = "✨ 줌·커서·TTS 합성 최종본 재생 중";
        videoModeBadge.classList.add("mode-badge-rendered");
      }
    } else {
      if (!d.hasVideo) {
        videoModeBadge.textContent = "녹화 비디오 없음";
      } else if (isMergedScenario) {
        videoModeBadge.textContent = `🔗 ${mergedSlugs.length}개 챕터 병합 마스터 재생 중`;
        videoModeBadge.classList.add("mode-badge-merged");
      } else if (hasTts && narration?.enabled !== false) {
        videoModeBadge.textContent = "📹 원본 녹화본 + 🎙️실시간 TTS·홀드 시뮬레이션";
        videoModeBadge.classList.add("mode-badge-sim");
      } else {
        videoModeBadge.textContent = "📹 원본 브라우저 녹화본 재생 중";
      }
    }
  }

  // 3) Unapplied Narration / Outdated MP4 Banner (#narration-unapplied-banner)
  const bannerEl = document.getElementById("narration-unapplied-banner");
  if (bannerEl) {
    if (!isDirtyOrOutdated || unappliedNarrationState.dismissed) {
      bannerEl.classList.add("hidden");
      bannerEl.innerHTML = "";
    } else {
      const bannerReason =
        unappliedNarrationState.reason ||
        (hasUnsynthesized
          ? "아직 음성(TTS)이 합성되지 않은 대본 구간이 있습니다."
          : rInfo.outdatedReason || "대본·슬라이드 수정 사항이 아직 최종 영상에 반영되지 않았습니다.");
      bannerEl.classList.remove("hidden");
      bannerEl.innerHTML = `
        <div class="unapplied-banner-left">
          <span class="unapplied-banner-icon">⚠️</span>
          <span class="unapplied-banner-text" id="narration-unapplied-text">${escapeHtmlAttr(bannerReason)}</span>
          <span class="unapplied-banner-sub">원본·최종 영상 파일에 변경 사항을 즉시 동기화할 수 있습니다.</span>
        </div>
        <div class="unapplied-banner-actions">
          <button type="button" class="btn btn-sm btn-primary" id="btn-apply-unapplied-narration" style="padding:4px 11px;font-size:11.5px;font-weight:700;">
            ⚡ 지금 영상에 즉시 반영 (TTS·슬라이드 재합성)
          </button>
          <button type="button" class="btn btn-sm btn-outline" id="btn-dismiss-unapplied-banner" title="이 알림 닫기" style="padding:4px 8px;font-size:11px;">
            ✕ 닫기
          </button>
        </div>
      `;
      const applyBtn = bannerEl.querySelector("#btn-apply-unapplied-narration");
      if (applyBtn) {
        applyBtn.addEventListener("click", handleApplyUnappliedNarration);
      }
      const dismissBtn = bannerEl.querySelector("#btn-dismiss-unapplied-banner");
      if (dismissBtn) {
        dismissBtn.addEventListener("click", () => {
          unappliedNarrationState.dismissed = true;
          updatePlayerStatusAndModeBadges(d, rInfo);
        });
      }
    }
  }
}

function setVideoMode(mode, details = null, renderInfo = null) {
  if (!selectedScenario) return;
  const slug = selectedScenario;
  const d = details || scenarioDetailsCache[slug] || {};
  const rInfo = renderInfo || unappliedNarrationState.renderInfo || null;

  currentVideoMode = mode;

  if (btnModeRaw) btnModeRaw.classList.toggle("active", mode === "raw");
  if (btnModeRendered) btnModeRendered.classList.toggle("active", mode === "rendered");

  updatePlayerStatusAndModeBadges(d, rInfo);

  if (mode === "rendered") {
    const hasRendered = rInfo ? rInfo.exists : d.hasRenderedVideo || false;
    if (!hasRendered) {
      videoPlayer.style.display = "none";
      videoEmpty.style.display = "flex";
      videoEmpty.querySelector("p").textContent = "최종 렌더링(합성)된 MP4 비디오가 없습니다.";
      videoEmpty.querySelector("span").textContent = "[🎞️ 최종 MP4 렌더링] 버튼을 눌러 비디오를 추출하세요.";
      return;
    }

    videoEmpty.style.display = "none";
    videoPlayer.style.display = "block";
    videoPlayer.src = `/api/rendered-video/${slug}?t=${Date.now()}`;
  } else {
    if (d.hasVideo) {
      videoEmpty.style.display = "none";
      videoPlayer.style.display = "block";
      videoPlayer.src = `${d.videoUrl || `/api/video/${slug}`}?t=${Date.now()}`;
    } else {
      videoEmpty.style.display = "flex";
      videoPlayer.style.display = "none";
      videoPlayer.src = "";
    }
  }
  stopRealtimeHoldAndAudio();
  if (videoSpeedSelect && videoPlayer) {
    videoPlayer.playbackRate = parseFloat(videoSpeedSelect.value) || 1.0;
  }
}

// 6.8 Real-Time Segment Stretch/Shrink & 100% Sync Engine (Browser Memory + Live Preview)
const realtimeHoldState = {
  active: false,
  isProgrammaticPause: false,
  isProgrammaticResume: false,
  isProgrammaticSeek: false,
  regionIdx: -1,
  completedRegions: new Set(),
  playedCueIds: new Set(),
  compStartMs: 0,
  holdDurationMs: 0,
  videoEndFrame: 0,
  startWallMs: 0,
  rafId: null,
  lastPlayedCueId: null,
};
let quickSaveTimer = null;
let autoTtsSynthTimer = null;
let autoTtsInFlight = false;
let autoTtsQueued = false;

function stopRealtimeHoldAndAudio(preserveCompletedProgress = false) {
  realtimeHoldState.active = false;
  realtimeHoldState.isProgrammaticPause = false;
  realtimeHoldState.isProgrammaticResume = false;
  realtimeHoldState.regionIdx = -1;
  if (!preserveCompletedProgress) {
    realtimeHoldState.completedRegions.clear();
    realtimeHoldState.playedCueIds.clear();
  } else if (realtimeHoldState.lastPlayedCueId !== null) {
    realtimeHoldState.playedCueIds.delete(realtimeHoldState.lastPlayedCueId);
  }
  realtimeHoldState.lastPlayedCueId = null;
  if (activePreviewAudio) {
    try {
      activePreviewAudio.pause();
    } catch {}
    activePreviewAudio = null;
  }
  const badgeEl = document.getElementById("live-timewarp-badge");
  if (badgeEl) badgeEl.classList.add("hidden");
  const subEl = document.getElementById("live-subtitle-overlay");
  if (subEl) subEl.classList.add("hidden");
}

function syncCompletedHoldRegionsForSeek(rawTimeSec, compTimeMs = null) {
  realtimeHoldState.completedRegions.clear();
  realtimeHoldState.playedCueIds.clear();
  realtimeHoldState.lastPlayedCueId = null;

  const details = scenarioDetailsCache[selectedScenario];
  const editPlan = details?.editPlan;
  const narration = details?.narration || editPlan?.narration;
  const regions = editPlan?.timeRegions;
  const fps = Number(editPlan?.fps || 60);
  const rawSec = Number(rawTimeSec || 0);
  if (rawSec <= 0.15 && (compTimeMs === null || compTimeMs <= 220)) {
    return;
  }

  const effectiveCompMs =
    compTimeMs !== null ? Number(compTimeMs) : videoTimeMsToCompTimeMs(rawSec * 1000, editPlan);
  const rawFrame = rawSec * fps;
  const compFrame = (effectiveCompMs / 1000) * fps;

  if (Array.isArray(regions)) {
    regions.forEach((r, idx) => {
      const vSpan = Math.max(0, (r.videoEndFrame || 0) - (r.videoStartFrame || 0));
      const cSpan = Math.max(0, (r.compEndFrame || 0) - (r.compStartFrame || 0));
      if (r.speed < 0.25 && cSpan - vSpan >= 4) {
        if (compTimeMs !== null) {
          if (compFrame > 15 && r.compStartFrame <= compFrame + 2) {
            realtimeHoldState.completedRegions.add(idx);
          }
        } else {
          if (rawFrame > 15 && r.videoStartFrame <= rawFrame + 2) {
            realtimeHoldState.completedRegions.add(idx);
          }
        }
      }
    });
  }

  const cues = narration?.cues || [];
  cues.forEach((c) => {
    if ((c.endMs || 0) <= effectiveCompMs + 180) {
      realtimeHoldState.playedCueIds.add(c.id);
    }
  });
}

function computeTimeRegionsAndSyncCuesJS(cues, rawTotalMs, fps, momentsList = [], bakedIntroDurationMs = 0) {
  const safeRawTotalMs = Math.max(1000, Math.round(rawTotalMs || 15000));
  const rawTotalFrames = Math.max(1, Math.round((safeRawTotalMs / 1000) * fps));
  if (!Array.isArray(cues) || cues.length === 0) {
    return {
      cues: [],
      timeRegions: [
        {
          videoStartFrame: 0,
          videoEndFrame: rawTotalFrames,
          compStartFrame: 0,
          compEndFrame: rawTotalFrames,
          speed: 1.0,
        },
      ],
      totalDurationFrames: rawTotalFrames,
      rawDurationFrames: rawTotalFrames,
    };
  }

  const interactiveMoments = (momentsList || []).filter(
    (m) => m.type !== "wait" && m.type !== "navigate" && typeof m.timestamp === "number"
  );
  const allMissingAnchor = cues.every((c) => typeof c.videoStartMs !== "number");
  if (allMissingAnchor) {
    cues.forEach((c, idx) => {
      if (idx === 0 && (c.isIntro || (c.startMs || 0) <= 600)) {
        c.videoStartMs = Math.min(400, Math.max(100, Number(c.startMs || 200)));
      } else {
        const mIdx = cues[0]?.isIntro || (cues[0]?.startMs || 0) <= 600 ? idx - 1 : idx;
        if (mIdx >= 0 && mIdx < interactiveMoments.length && cues.length - 1 <= interactiveMoments.length) {
          const mTs = Number(interactiveMoments[mIdx].timestamp || 0);
          if ((c.startMs || 0) > mTs + 250) {
            c.videoStartMs = Math.max(0, mTs - 200);
          } else {
            c.videoStartMs = Math.max(0, Number(c.startMs || 0));
          }
        } else {
          c.videoStartMs = Math.max(0, Number(c.startMs || 0));
        }
      }
    });
  } else {
    cues.forEach((c) => {
      if (typeof c.videoStartMs !== "number" || isNaN(c.videoStartMs)) {
        c.videoStartMs = Math.max(0, Number(c.startMs || 0));
      } else {
        c.videoStartMs = Math.max(0, Math.round(c.videoStartMs));
      }
    });
  }

  for (let i = 1; i < cues.length; i++) {
    if (cues[i].videoStartMs < cues[i - 1].videoStartMs + 100) {
      cues[i].videoStartMs = cues[i - 1].videoStartMs + 100;
    }
    if (cues[i].videoStartMs > safeRawTotalMs - 200) {
      cues[i].videoStartMs = Math.max(cues[i - 1].videoStartMs + 50, safeRawTotalMs - 200);
    }
  }

  const n = cues.length;
  for (let i = 0; i < n; i++) {
    if (i < n - 1) {
      cues[i].videoEndMs = Math.max(cues[i].videoStartMs + 100, cues[i + 1].videoStartMs);
    } else {
      cues[i].videoEndMs = Math.max(cues[i].videoStartMs + 300, safeRawTotalMs);
    }
  }

  const timeRegions = [];
  let compCursorFrames = 0;

  function appendRegion(vStartF, vEndF, cStartF, cEndF, cueId) {
    vStartF = Math.max(0, Math.round(vStartF));
    vEndF = Math.max(vStartF, Math.round(vEndF));
    cStartF = Math.max(0, Math.round(cStartF));
    cEndF = Math.max(cStartF, Math.round(cEndF));
    const cSpan = cEndF - cStartF;
    const vSpan = vEndF - vStartF;
    if (cSpan <= 0) return;
    const speed = Number((vSpan / cSpan).toFixed(6));
    const reg = {
      videoStartFrame: vStartF,
      videoEndFrame: vEndF,
      compStartFrame: cStartF,
      compEndFrame: cEndF,
      speed,
    };
    if (cueId !== undefined && cueId !== null) reg.cueId = cueId;
    timeRegions.push(reg);
  }

  const firstVStartMs = cues[0].videoStartMs || 0;
  const firstVStartF = Math.max(0, Math.round((firstVStartMs / 1000) * fps));
  if (firstVStartF > 0) {
    appendRegion(0, firstVStartF, 0, firstVStartF, null);
    compCursorFrames = firstVStartF;
  }

  const speechPadBaseMs = 180;
  for (let i = 0; i < n; i++) {
    const c = cues[i];
    const cueId = Number(c.id || i + 1);
    const vStartMs = Number(c.videoStartMs || 0);
    const vEndMs = Number(c.videoEndMs || vStartMs + 1000);
    const vStartF = i === 0 ? firstVStartF : Math.max(0, Math.min(rawTotalFrames, Math.round((vStartMs / 1000) * fps)));
    let vEndF = i === n - 1 ? rawTotalFrames : Math.max(0, Math.min(rawTotalFrames, Math.round((vEndMs / 1000) * fps)));
    if (vEndF <= vStartF) {
      vEndF = Math.min(rawTotalFrames, vStartF + 1);
    }

    const rawGapMs = Math.max(100, vEndMs - vStartMs);
    const textLen = String(c.text || "").trim().length;
    const audioDurMs = Number(c.audioDurationMs || Math.max(1800, textLen * 145));
    const speechPadMs = i === n - 1 ? 260 : speechPadBaseMs;
    const minSpeechWindowMs = audioDurMs > 0 ? audioDurMs + speechPadMs : 400;

    // 이미 오프닝 슬라이드가 합성된 영상(bakedIntroDurationMs > 0)의 첫 번째 구간(i === 0 또는 앞단 통합 슬라이드)은
    // 슬라이드 길이가 이미 음성 길이에 맞춰 생성되었으므로 절대로 추가 홀드(⏸ 구간 늘리기)를 발생시키지 않습니다.
    const isBakedIntroCue =
      (i === 0 || (Boolean(c.isIntro) && (c.videoStartMs || 0) < Math.max(1000, bakedIntroDurationMs - 200))) &&
      (bakedIntroDurationMs > 0 || (Boolean(c.isIntro) && rawGapMs >= Math.max(3800, audioDurMs + 200)));

    const autoHoldMs = isBakedIntroCue ? 0 : Math.max(0, minSpeechWindowMs - rawGapMs);
    const extraHoldMs = isBakedIntroCue ? 0 : Math.round(Number(c.extraHoldMs || 0));

    const baseWindowMs = isBakedIntroCue ? rawGapMs : Math.max(rawGapMs, minSpeechWindowMs);
    const minAllowedWindowMs = isBakedIntroCue
      ? rawGapMs
      : Math.max(minSpeechWindowMs, Math.max(300, Math.round(rawGapMs * 0.25)));
    const compGapMs = isBakedIntroCue ? rawGapMs : Math.max(minAllowedWindowMs, baseWindowMs + extraHoldMs);
    const effectiveDeltaMs = compGapMs - rawGapMs;

    const rawFrames = Math.max(1, vEndF - vStartF);
    const compFrames = isBakedIntroCue ? rawFrames : Math.max(1, Math.round((compGapMs / 1000) * fps));
    const deltaFrames = compFrames - rawFrames;

    const cStartF = compCursorFrames;
    const cEndF = cStartF + compFrames;

    c.autoHoldMs = Math.round(autoHoldMs);
    c.extraHoldMs = extraHoldMs;
    c.effectiveDeltaMs = Math.round(effectiveDeltaMs);
    c.playbackRate = 1.0;
    c.startMs = Math.round((cStartF / fps) * 1000);
    const cueDurForSub = audioDurMs > 0 ? audioDurMs : Math.min(compGapMs, 2500);
    c.endMs = c.startMs + cueDurForSub;

    const isIntro = Boolean(c.isIntro || (i === 0 && vStartMs <= 600));
    if (Math.abs(deltaFrames) <= 1) {
      appendRegion(vStartF, vEndF, cStartF, cEndF, cueId);
    } else if (deltaFrames > 1) {
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
      let cCur = cStartF;

      if (preRawF > 0) {
        appendRegion(vStartF, holdVStart, cCur, cCur + preRawF, cueId);
        cCur += preRawF;
      }
      appendRegion(holdVStart, holdVEnd, cCur, cCur + holdCompF, cueId);
      cCur += holdCompF;
      if (postRawF > 0) {
        appendRegion(holdVEnd, vEndF, cCur, cCur + postRawF, cueId);
        cCur += postRawF;
      }
    } else {
      appendRegion(vStartF, vEndF, cStartF, cEndF, cueId);
    }

    compCursorFrames = cEndF;
  }

  return {
    cues,
    timeRegions,
    totalDurationFrames: Math.max(1, compCursorFrames),
    rawDurationFrames: rawTotalFrames,
  };
}

function syncScenarioTimelineInMemory(details) {
  if (!details) return;
  const editPlan = details.editPlan;
  const narration = details.narration || editPlan?.narration;
  if (!narration || !Array.isArray(narration.cues) || narration.cues.length === 0) return;

  const fps = Number(editPlan?.fps || 60);
  const rawFrames = Number(editPlan?.rawDurationFrames || editPlan?.totalDurationFrames || 0);
  const momentsDurMs = Number(details.moments?.metadata?.totalDurationMs || details.moments?.totalDurationMs || 0);
  const rawTotalMs =
    momentsDurMs > 0
      ? momentsDurMs
      : rawFrames > 0
      ? Math.round((rawFrames / fps) * 1000)
      : videoPlayer && videoPlayer.duration
      ? Math.round(videoPlayer.duration * 1000)
      : 15000;

  const bakedIntroDurationMs = narration.introBakedIntoVideo ? Number(narration.bakedIntroDurationMs || 0) : 0;
  const synced = computeTimeRegionsAndSyncCuesJS(
    narration.cues,
    rawTotalMs,
    fps,
    details.moments?.moments || [],
    bakedIntroDurationMs
  );

  narration.cues = synced.cues;
  details.narration = narration;
  if (editPlan) {
    editPlan.rawDurationFrames = synced.rawDurationFrames;
    editPlan.totalDurationFrames = synced.totalDurationFrames;
    editPlan.timeRegions = synced.timeRegions;
    editPlan.narration = narration;
  }
}

function videoTimeMsToCompTimeMs(rawTimeMs, editPlan, completedRegions = null) {
  const regions = editPlan?.timeRegions;
  const fps = Number(editPlan?.fps || 60);
  if (!Array.isArray(regions) || regions.length === 0) return rawTimeMs;

  const rawFrame = (rawTimeMs / 1000) * fps;
  let compF = null;
  for (let idx = 0; idx < regions.length; idx++) {
    const r = regions[idx];
    if (rawFrame >= r.videoStartFrame && rawFrame <= r.videoEndFrame) {
      const vSpan = r.videoEndFrame - r.videoStartFrame;
      const cSpan = r.compEndFrame - r.compStartFrame;
      if (completedRegions && completedRegions.has(idx) && cSpan > vSpan) {
        const progressedRawF = Math.max(0, Math.min(vSpan, rawFrame - r.videoStartFrame));
        compF = r.compStartFrame + (cSpan - vSpan) + progressedRawF;
        break;
      }
      if (vSpan <= 0.0001 || r.speed <= 0.0001) {
        compF = r.compStartFrame;
        break;
      }
      const ratio = (rawFrame - r.videoStartFrame) / vSpan;
      compF = r.compStartFrame + ratio * cSpan;
      break;
    }
  }
  if (compF === null) {
    const last = regions[regions.length - 1];
    if (rawFrame > last.videoEndFrame) {
      const extraF = rawFrame - last.videoEndFrame;
      compF = last.compEndFrame + extraF;
    } else {
      return rawTimeMs;
    }
  }
  if (completedRegions && completedRegions.size > 0) {
    for (const cIdx of completedRegions) {
      const rc = regions[cIdx];
      if (rc && rawFrame >= rc.videoStartFrame - 1) {
        const rvSpan = Math.max(0, rc.videoEndFrame - rc.videoStartFrame);
        const rcSpan = Math.max(0, rc.compEndFrame - rc.compStartFrame);
        const minCompF = rc.compStartFrame + Math.max(0, rcSpan - rvSpan);
        if (compF < minCompF) compF = minCompF;
      }
    }
  }
  return (compF / fps) * 1000;
}

function compTimeMsToVideoTimeMs(compTimeMs, editPlan) {
  const regions = editPlan?.timeRegions;
  const fps = Number(editPlan?.fps || 60);
  if (!Array.isArray(regions) || regions.length === 0) return compTimeMs;

  const compFrame = (compTimeMs / 1000) * fps;
  for (const r of regions) {
    if (compFrame >= r.compStartFrame && compFrame <= r.compEndFrame) {
      const vFrame = r.videoStartFrame + (compFrame - r.compStartFrame) * r.speed;
      return (vFrame / fps) * 1000;
    }
  }
  const last = regions[regions.length - 1];
  if (compFrame > last.compEndFrame) {
    return (last.videoEndFrame / fps) * 1000;
  }
  return compTimeMs;
}

function saveNarrationTimingQuick() {
  if (!selectedScenario) return;
  if (quickSaveTimer) clearTimeout(quickSaveTimer);
  quickSaveTimer = setTimeout(async () => {
    const details = scenarioDetailsCache[selectedScenario];
    const narration = details?.narration;
    if (!narration) return;
    try {
      const res = await fetch(`/api/narration/${selectedScenario}/save`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ narration, synthesize: false }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.narration && details) {
          details.narration = data.narration;
          if (data.editPlan) details.editPlan = data.editPlan;
          else syncScenarioTimelineInMemory(details);
        }
      }
    } catch (e) {
      console.warn("Quick timing save failed:", e);
    }
  }, 220);
}

async function runAutoSynthesizeAndFitNow(targetRowIdx = null) {
  if (!selectedScenario) return;
  if (autoTtsInFlight) {
    autoTtsQueued = true;
    return;
  }
  autoTtsInFlight = true;
  if (autoTtsSynthTimer) {
    clearTimeout(autoTtsSynthTimer);
    autoTtsSynthTimer = null;
  }

  const slug = selectedScenario;
  const statusBadge = document.getElementById("narration-status-badge");
  const container = document.getElementById("narration-cues-container");
  const allRows = container ? container.querySelectorAll(".narration-cue-row") : [];
  if (targetRowIdx !== null && allRows[targetRowIdx]) {
    const bWrap = allRows[targetRowIdx].querySelector(".cue-sync-badge-wrap");
    if (bWrap) {
      bWrap.innerHTML = `<span class="cue-sync-badge badge-auto-hold">🔄 음성·영상길이 자동 맞춤 중...</span>`;
    }
  }
  if (statusBadge) {
    statusBadge.textContent = "🔄 수정 대본 TTS 측정 & 영상 길이 자동 맞춤 중...";
  }

  try {
    const narration = collectNarrationFromUI({ sortByStartTime: false });
    const res = await fetch(`/api/narration/${slug}/save`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ narration, synthesize: true }),
    });
    if (res.ok) {
      const data = await res.json();
      const details = scenarioDetailsCache[slug];
      if (details && data.narration) {
        const prevBakedSig = details.narration?._bakedSlideSig;
        details.narration = data.narration;
        if (data.moments) {
          details.moments = data.moments;
        }
        if (data.editPlan) {
          details.editPlan = data.editPlan;
        } else if (details.editPlan) {
          details.editPlan.narration = data.narration;
        }
        syncScenarioTimelineInMemory(details);
        const isMerged = Array.isArray(data.narration?.mergedFromSlugs) && data.narration.mergedFromSlugs.length > 0;
        if (prevBakedSig && data.narration._bakedSlideSig && prevBakedSig !== data.narration._bakedSlideSig && currentVideoMode === "raw") {
          const prevSec = videoPlayer && Number.isFinite(videoPlayer.currentTime) ? videoPlayer.currentTime : 0;
          setVideoMode("raw", details);
          if (videoPlayer && prevSec > 0.5) {
            videoPlayer.addEventListener(
              "loadedmetadata",
              () => {
                videoPlayer.currentTime = Math.min(prevSec, Math.max(0, (videoPlayer.duration || prevSec) - 0.2));
              },
              { once: true }
            );
          }
        } else if (data.renderedVideoUpdated && (currentVideoMode === "rendered" || isMerged)) {
          const prevSec = videoPlayer && Number.isFinite(videoPlayer.currentTime) ? videoPlayer.currentTime : 0;
          setVideoMode(currentVideoMode, details);
          if (videoPlayer && prevSec > 0.5) {
            videoPlayer.addEventListener(
              "loadedmetadata",
              () => {
                videoPlayer.currentTime = Math.min(prevSec, Math.max(0, (videoPlayer.duration || prevSec) - 0.2));
              },
              { once: true }
            );
          }
        }

        // If user is currently typing in an input inside narration studio, update badges/times in-place without losing focus
        const activeEl = document.activeElement;
        const isTypingInCue =
          activeEl && container && container.contains(activeEl) && (activeEl.tagName === "INPUT" || activeEl.tagName === "TEXTAREA");

        if (isTypingInCue) {
          const rowsNow = container.querySelectorAll(".narration-cue-row");
          details.narration.cues.forEach((sc, sIdx) => {
            const rEl = rowsNow[sIdx];
            if (!rEl) return;
            const currentInputVal = (rEl.querySelector(".cue-text-input")?.value || "").trim();
            rEl.dataset.compStartMs = String(sc.startMs || 0);
            rEl.dataset.compEndMs = String(sc.endMs || 0);
            if (currentInputVal === sc.text) {
              rEl.dataset.lastSyncedText = sc.text;
            }
            const jEl = rEl.querySelector(".cue-jump-time");
            if (jEl) {
              const cs = ((sc.startMs || 0) / 1000).toFixed(1);
              const ce = ((sc.endMs || 0) / 1000).toFixed(1);
              jEl.textContent = `➔ ${cs}~${ce}s`;
            }
            const bWrap = rEl.querySelector(".cue-sync-badge-wrap");
            if (bWrap) bWrap.innerHTML = buildCueSyncBadgeHtml(sc);
          });
          const styleLabels = {
            manual: "📘 정석 매뉴얼",
            friendly: "😊 친절 가이드",
            presentation: "🎙️ 시연 발표",
            compact: "⚡ 핵심 브리핑",
          };
          const styleBadgeText = styleLabels[details.narration.style || "manual"] || "📘 정석 매뉴얼";
          const totalHoldMs = details.narration.cues.reduce(
            (acc, c) => acc + Math.max(0, Number(c.effectiveDeltaMs || 0)),
            0
          );
          if (statusBadge) {
            const holdText = totalHoldMs >= 200 ? ` · ⏱️싱크연장 +${(totalHoldMs / 1000).toFixed(1)}s` : "";
            statusBadge.textContent = `✅ 자동맞춤 완료 · ${details.narration.cues.length}구간 · ${styleBadgeText}${holdText}`;
          }
        } else {
          renderNarrationStudio(details);
        }
        await clearNarrationUnapplied();
        renderTimelineVisual(details);
        renderMomentsStepList(details);
        updateJsonViewer("narration");
      }
    }
  } catch (err) {
    console.warn("Auto TTS synthesize failed:", err);
  } finally {
    autoTtsInFlight = false;
    if (autoTtsQueued) {
      autoTtsQueued = false;
      runAutoSynthesizeAndFitNow();
    }
  }
}

function scheduleAutoSynthesizeAndFit(targetRowIdx = null, delayMs = 850) {
  if (autoTtsSynthTimer) clearTimeout(autoTtsSynthTimer);
  autoTtsSynthTimer = setTimeout(() => {
    runAutoSynthesizeAndFitNow(targetRowIdx);
  }, delayMs);
}

// 6.9 Direct Video Cut (Trim) Editor & Undo/Restore
let cutPreviewStopRawSec = null;
let timelineDragCutState = null;
let isCutEditorOpen = false;

function toggleCutEditorBar(forceOpen = null) {
  const barEl = document.getElementById("video-cut-editor-bar");
  const btnEl = document.getElementById("btn-toggle-cut-editor");
  if (!barEl) return;
  isCutEditorOpen = forceOpen !== null ? Boolean(forceOpen) : barEl.classList.contains("hidden");
  barEl.classList.toggle("hidden", !isCutEditorOpen);
  if (btnEl) {
    btnEl.classList.toggle("active", isCutEditorOpen);
  }
}

function updateCutSelectionUI() {
  const cutInInput = document.getElementById("cut-in-input");
  const cutOutInput = document.getElementById("cut-out-input");
  const cutDurationBadge = document.getElementById("cut-duration-badge");
  const cutSelEl = document.getElementById("timeline-cut-selection");
  const btnUndo = document.getElementById("btn-undo-video-cut");
  const btnRestoreOrig = document.getElementById("btn-restore-orig-video");

  const details = scenarioDetailsCache[selectedScenario];
  const editStatus = details?.videoEditStatus;

  if (btnUndo) {
    btnUndo.classList.toggle("hidden", !editStatus?.hasUndoBackup);
  }
  if (btnRestoreOrig) {
    btnRestoreOrig.classList.toggle("hidden", !editStatus?.hasOriginalBackup);
    if (editStatus?.hasOriginalBackup && editStatus?.originalDurationSec) {
      btnRestoreOrig.title = `최초 녹화 원본 영상(${editStatus.originalDurationSec.toFixed(1)}s)으로 복원합니다`;
    }
  }

  if (!cutInInput || !cutOutInput || !cutSelEl) return;

  const inSec = parseFloat(cutInInput.value);
  const outSec = parseFloat(cutOutInput.value);

  if (!Number.isFinite(inSec) || !Number.isFinite(outSec) || outSec <= inSec + 0.05) {
    cutSelEl.classList.add("hidden");
    if (cutDurationBadge) cutDurationBadge.classList.add("hidden");
    return;
  }

  // 사용자가 타임라인에서 Shift+드래그 등으로 구간을 지정하면 잘라내기 바를 자동으로 펼침
  if (!isCutEditorOpen) {
    toggleCutEditorBar(true);
  }

  const cutDur = outSec - inSec;
  if (cutDurationBadge) {
    cutDurationBadge.classList.remove("hidden");
    cutDurationBadge.textContent = `✂️ -${cutDur.toFixed(1)}s 삭제 영역`;
  }

  const editPlan = details?.editPlan;
  const fps = Number(editPlan?.fps || 60);
  const totalCompMs =
    editPlan?.totalDurationFrames > 0
      ? (editPlan.totalDurationFrames / fps) * 1000
      : (videoPlayer?.duration || Math.max(outSec, 10)) * 1000;

  if (totalCompMs <= 0) {
    cutSelEl.classList.add("hidden");
    return;
  }

  const startCompMs = editPlan?.timeRegions?.length
    ? videoTimeMsToCompTimeMs(inSec * 1000, editPlan)
    : inSec * 1000;
  const endCompMs = editPlan?.timeRegions?.length
    ? videoTimeMsToCompTimeMs(outSec * 1000, editPlan)
    : outSec * 1000;

  const leftPct = Math.min(99.5, Math.max(0, (startCompMs / totalCompMs) * 100));
  const rightPct = Math.min(100, Math.max(leftPct + 0.5, (endCompMs / totalCompMs) * 100));
  cutSelEl.style.left = `${leftPct}%`;
  cutSelEl.style.width = `${Math.max(0.5, rightPct - leftPct)}%`;
  cutSelEl.classList.remove("hidden");
}

function getCurrentRawVideoTimeSec() {
  if (!videoPlayer) return 0;
  const curSec = videoPlayer.currentTime || 0;
  if (currentVideoMode === "rendered") {
    const details = scenarioDetailsCache[selectedScenario];
    const rawMs = compTimeMsToVideoTimeMs(curSec * 1000, details?.editPlan);
    return Number((rawMs / 1000).toFixed(1));
  }
  return Number(curSec.toFixed(1));
}

function handleSetCutInFromPlayhead() {
  const cutInInput = document.getElementById("cut-in-input");
  const cutOutInput = document.getElementById("cut-out-input");
  if (!cutInInput) return;
  const curRawSec = getCurrentRawVideoTimeSec();
  cutInInput.value = curRawSec.toFixed(1);
  const outVal = parseFloat(cutOutInput?.value || "");
  if (!Number.isFinite(outVal) || outVal <= curRawSec) {
    const maxDur = videoPlayer?.duration || curRawSec + 3.0;
    if (cutOutInput) {
      cutOutInput.value = Math.min(maxDur, curRawSec + 2.0).toFixed(1);
    }
  }
  updateCutSelectionUI();
}

function handleSetCutOutFromPlayhead() {
  const cutInInput = document.getElementById("cut-in-input");
  const cutOutInput = document.getElementById("cut-out-input");
  if (!cutOutInput) return;
  const curRawSec = getCurrentRawVideoTimeSec();
  cutOutInput.value = curRawSec.toFixed(1);
  const inVal = parseFloat(cutInInput?.value || "");
  if (!Number.isFinite(inVal) || inVal >= curRawSec) {
    if (cutInInput) {
      cutInInput.value = Math.max(0, curRawSec - 2.0).toFixed(1);
    }
  }
  updateCutSelectionUI();
}

function handleClearCutRange() {
  const cutInInput = document.getElementById("cut-in-input");
  const cutOutInput = document.getElementById("cut-out-input");
  if (cutInInput) cutInInput.value = "";
  if (cutOutInput) cutOutInput.value = "";
  cutPreviewStopRawSec = null;
  updateCutSelectionUI();
}

function handlePreviewCutRange() {
  if (!videoPlayer || !videoPlayer.duration) return;
  const cutInInput = document.getElementById("cut-in-input");
  const cutOutInput = document.getElementById("cut-out-input");
  const inSec = parseFloat(cutInInput?.value || "");
  const outSec = parseFloat(cutOutInput?.value || "");
  if (!Number.isFinite(inSec) || !Number.isFinite(outSec) || outSec <= inSec + 0.1) {
    alert("먼저 잘라낼 시작(초)과 끝(초) 지점을 지정해주세요.");
    return;
  }
  if (currentVideoMode !== "raw") {
    setVideoMode("raw");
  }
  stopRealtimeHoldAndAudio();
  syncCompletedHoldRegionsForSeek(inSec, null);
  cutPreviewStopRawSec = outSec;
  realtimeHoldState.isProgrammaticSeek = true;
  videoPlayer.currentTime = Math.max(0, inSec);
  realtimeHoldState.isProgrammaticResume = true;
  videoPlayer.play().catch(() => {
    realtimeHoldState.isProgrammaticResume = false;
  });
}

async function handleApplyVideoCut() {
  if (!selectedScenario) return;
  const cutInInput = document.getElementById("cut-in-input");
  const cutOutInput = document.getElementById("cut-out-input");
  const btnApply = document.getElementById("btn-apply-video-cut");
  const inSec = parseFloat(cutInInput?.value || "");
  const outSec = parseFloat(cutOutInput?.value || "");

  if (!Number.isFinite(inSec) || !Number.isFinite(outSec) || outSec <= inSec + 0.19) {
    alert("잘라낼 시작(초)과 끝(초) 구간을 최소 0.2초 이상으로 지정해주세요.\n(영상을 재생하며 [시작점 현위치] / [끝점 현위치] 버튼을 누르거나 값을 입력하세요)");
    return;
  }

  const slug = selectedScenario;
  if (btnApply) {
    btnApply.disabled = true;
    btnApply.textContent = "⏳ 구간 잘라내는 중...";
  }
  stopRealtimeHoldAndAudio();
  let prevVideoSrc = "";
  if (videoPlayer) {
    if (!videoPlayer.paused) {
      videoPlayer.pause();
    }
    prevVideoSrc = videoPlayer.getAttribute("src") || "";
    videoPlayer.removeAttribute("src");
    videoPlayer.load();
  }

  try {
    const res = await fetch(`/api/video-edit/${slug}/cut`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ startSec: inSec, endSec: outSec }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "컷 편집 실패");

    const details = scenarioDetailsCache[slug];
    if (details) {
      if (data.moments) details.moments = data.moments;
      if (data.editPlan) details.editPlan = data.editPlan;
      if (data.narration) details.narration = data.narration;
      if (data.editStatus) details.videoEditStatus = data.editStatus;
      syncScenarioTimelineInMemory(details);
    }

    handleClearCutRange();
    setVideoMode("raw", details);
    if (videoPlayer) {
      const resumeSec = Math.max(0, inSec - 0.3);
      videoPlayer.addEventListener(
        "loadedmetadata",
        () => {
          realtimeHoldState.isProgrammaticSeek = true;
          videoPlayer.currentTime = Math.min(videoPlayer.duration || resumeSec, resumeSec);
          updateVideoPlaybackSync();
        },
        { once: true }
      );
    }
    handleClearCutRange();
    renderTimelineVisual(details);
    renderMomentsStepList(details);
    renderNarrationStudio(details);
    updateJsonViewer("edit");
    fetchScenarios();
  } catch (err) {
    if (videoPlayer && prevVideoSrc) {
      videoPlayer.src = prevVideoSrc;
      videoPlayer.load();
    }
    alert(`구간 잘라내기 실패: ${err.message}`);
  } finally {
    if (btnApply) {
      btnApply.disabled = false;
      btnApply.textContent = "✂️ 선택 구간 잘라내기";
    }
  }
}

async function handleRestoreVideoCut(mode = "undo") {
  if (!selectedScenario) return;
  const slug = selectedScenario;
  const btn = document.getElementById(mode === "orig" ? "btn-restore-orig-video" : "btn-undo-video-cut");
  const origLabel = btn ? btn.textContent : "";
  if (btn) {
    btn.disabled = true;
    btn.textContent = "⏳ 복원 중...";
  }
  stopRealtimeHoldAndAudio();
  let prevRestoreVideoSrc = "";
  if (videoPlayer) {
    if (!videoPlayer.paused) {
      videoPlayer.pause();
    }
    prevRestoreVideoSrc = videoPlayer.getAttribute("src") || "";
    videoPlayer.removeAttribute("src");
    videoPlayer.load();
  }

  try {
    const res = await fetch(`/api/video-edit/${slug}/restore`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "복원 실패");

    const details = scenarioDetailsCache[slug];
    if (details) {
      if (data.moments) details.moments = data.moments;
      if (data.editPlan) details.editPlan = data.editPlan;
      if (data.narration) details.narration = data.narration;
      if (data.editStatus) details.videoEditStatus = data.editStatus;
      syncScenarioTimelineInMemory(details);
    }

    handleClearCutRange();
    setVideoMode("raw", details);
    handleClearCutRange();
    renderTimelineVisual(details);
    renderMomentsStepList(details);
    renderNarrationStudio(details);
    updateJsonViewer("edit");
    fetchScenarios();
  } catch (err) {
    if (videoPlayer && prevRestoreVideoSrc) {
      videoPlayer.src = prevRestoreVideoSrc;
      videoPlayer.load();
    }
    alert(`영상 복원 실패: ${err.message}`);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = origLabel;
    }
  }
}

// 7. Multi-Track Timeline Visual Bar, Zoom Controls & Bidirectional Script Jump
function renderTimelineRulerTicks(totalMs) {
  if (!timelineTrackRuler) return;
  timelineTrackRuler.innerHTML = "";
  const totalSec = Math.max(0, (totalMs || 0) / 1000);
  if (totalSec <= 0.1) return;

  const visibleSec = totalSec / Math.max(1, timelineZoomLevel || 1);
  const candidateSteps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  const stepSec = candidateSteps.find((s) => visibleSec / s <= 14) || 300;
  const majorMultiple = stepSec < 5 ? stepSec * 5 : stepSec * 2;

  for (let t = 0; t <= totalSec + 0.001; t += stepSec) {
    const roundedT = Number(t.toFixed(1));
    const leftPct = Math.min(99.8, Math.max(0, (roundedT / totalSec) * 100));
    const tick = document.createElement("div");
    const isMajor = roundedT === 0 || Math.abs(roundedT % majorMultiple) < 0.05;
    tick.className = `timeline-ruler-tick${isMajor ? " major" : ""}`;
    tick.style.left = `${leftPct}%`;
    tick.textContent =
      roundedT >= 60 ? formatTimecode(roundedT).replace(/\.0$/, "") : `${roundedT}s`;
    timelineTrackRuler.appendChild(tick);
  }
}

function setTimelineZoom(nextZoom, anchorRatio = null, cursorOffsetX = null) {
  const clamped = Math.min(20, Math.max(1, Number(nextZoom) || 1));
  const rounded = Math.round(clamped * 10) / 10;
  timelineZoomLevel = rounded;

  if (timelineVisualBar) {
    timelineVisualBar.style.width = `${timelineZoomLevel * 100}%`;
    timelineVisualBar.classList.toggle("is-zoomed", timelineZoomLevel >= 2);
  }
  if (timelineZoomBadge) {
    timelineZoomBadge.textContent = `${timelineZoomLevel % 1 === 0 ? timelineZoomLevel.toFixed(0) : timelineZoomLevel.toFixed(1)}x`;
  }
  if (timelineZoomPresetBtns && timelineZoomPresetBtns.length > 0) {
    timelineZoomPresetBtns.forEach((btn) => {
      const btnZoom = parseFloat(btn.getAttribute("data-zoom") || "1");
      btn.classList.toggle("active", Math.abs(btnZoom - timelineZoomLevel) < 0.15);
    });
  }

  if (lastTimelineTotalMs > 0) {
    renderTimelineRulerTicks(lastTimelineTotalMs);
  }

  if (timelineScrollViewport && timelineVisualBar) {
    if (timelineZoomLevel <= 1.01) {
      timelineScrollViewport.scrollLeft = 0;
    } else if (anchorRatio !== null && Number.isFinite(anchorRatio)) {
      const targetStageX = anchorRatio * timelineScrollViewport.scrollWidth;
      const offset = Number.isFinite(cursorOffsetX) ? cursorOffsetX : timelineScrollViewport.clientWidth / 2;
      timelineScrollViewport.scrollLeft = Math.max(0, targetStageX - offset);
    } else if (timelinePlayhead) {
      const playheadPct = parseFloat(timelinePlayhead.style.left || "0") / 100;
      const targetStageX = playheadPct * timelineScrollViewport.scrollWidth;
      timelineScrollViewport.scrollLeft = Math.max(0, targetStageX - timelineScrollViewport.clientWidth / 2);
    }
  }
}

function scrollTimelineToCompMs(compMs, center = true) {
  if (!timelineScrollViewport || !lastTimelineTotalMs || timelineZoomLevel <= 1.01) return;
  const ratio = Math.min(1, Math.max(0, (compMs || 0) / lastTimelineTotalMs));
  const targetX = ratio * timelineScrollViewport.scrollWidth;
  const viewW = timelineScrollViewport.clientWidth || 1;
  const curLeft = timelineScrollViewport.scrollLeft;

  if (center) {
    timelineScrollViewport.scrollTo({
      left: Math.max(0, targetX - viewW / 2),
      behavior: "smooth",
    });
  } else if (targetX < curLeft + 24 || targetX > curLeft + viewW - 36) {
    timelineScrollViewport.scrollLeft = Math.max(0, targetX - viewW * 0.25);
  }
}

function jumpFromTimelineToNarrationCue(cueIdx, cue, details) {
  const narration = details?.narration || details?.editPlan?.narration || null;
  const isMergedScenario =
    (Array.isArray(narration?.mergedFromSlugs) && narration.mergedFromSlugs.length > 0) ||
    (Array.isArray(details?.browsePlan?.mergedFromSlugs) && details.browsePlan.mergedFromSlugs.length > 0);
  const compStartMs = Number(cue?.startMs || 0);
  const rawStartMs = Number(cue?.videoStartMs ?? compStartMs);

  // 1) Seek video player to the cue start time
  if (videoPlayer && videoPlayer.duration) {
    stopRealtimeHoldAndAudio();
    const targetSec =
      currentVideoMode === "rendered" || isMergedScenario ? compStartMs / 1000 : rawStartMs / 1000;
    if (currentVideoMode === "raw" && !isMergedScenario) {
      syncCompletedHoldRegionsForSeek(rawStartMs / 1000, Math.max(0, compStartMs - 150));
    }
    realtimeHoldState.isProgrammaticSeek = true;
    videoPlayer.currentTime = Math.max(0, Math.min(targetSec, (videoPlayer.duration || targetSec) - 0.05));
    updateVideoPlaybackSync();
  }

  // 2) Switch bottom Studio Sub-Tab to "🎙️ AI 나레이션 대본 & 음성 합성 (TTS)"
  const narTabBtn = document.querySelector('.studio-subtab-btn[data-subtab="subtab-narration"]');
  if (narTabBtn && !narTabBtn.classList.contains("active")) {
    narTabBtn.click();
  }

  // 3) Highlight timeline block & scroll/flash/focus corresponding narration cue row
  if (timelineTrackNarration) {
    timelineTrackNarration.querySelectorAll(".narration-segment-block").forEach((b) => {
      b.classList.toggle("active-timeline-cue", Number(b.dataset.cueIdx) === cueIdx);
    });
  }

  const cueContainer = document.getElementById("narration-cues-container");
  if (cueContainer) {
    const targetRow = cueContainer.querySelector(`.narration-cue-row[data-orig-idx="${cueIdx}"]`);
    if (targetRow) {
      cueContainer.querySelectorAll(".narration-cue-row").forEach((r) => r.classList.toggle("active-cue", r === targetRow));
      targetRow.scrollIntoView({ behavior: "smooth", block: "center" });
      targetRow.classList.remove("cue-flash-highlight");
      void targetRow.offsetWidth;
      targetRow.classList.add("cue-flash-highlight");
      const textInput = targetRow.querySelector(".cue-text-input");
      if (textInput) {
        try {
          textInput.focus({ preventScroll: true });
        } catch {
          textInput.focus();
        }
      }
    }
  }
}

function renderTimelineVisual(details) {
  if (!timelineVisualBar) return;
  if (timelineTrackRuler) timelineTrackRuler.innerHTML = "";
  if (timelineTrackZoom) timelineTrackZoom.innerHTML = "";
  if (timelineTrackMoments) timelineTrackMoments.innerHTML = "";
  if (timelineTrackNarration) timelineTrackNarration.innerHTML = "";
  if (timelinePlayhead) timelinePlayhead.style.left = "0%";

  syncScenarioTimelineInMemory(details);

  const editPlan = details?.editPlan;
  const moments = details?.moments;
  const narration = details?.narration || editPlan?.narration || null;

  if (!editPlan || !editPlan.totalDurationFrames) {
    lastTimelineTotalMs = 0;
    if (timelineStats) timelineStats.textContent = "녹화 후 타임라인 생성됨";
    return;
  }

  const totalFrames = editPlan.totalDurationFrames;
  const rawFrames = editPlan.rawDurationFrames || totalFrames;
  const fps = editPlan.fps || 60;
  const totalMs = (totalFrames / fps) * 1000;
  lastTimelineTotalMs = totalMs;
  const deltaSec = (totalFrames - rawFrames) / fps;

  const segments = editPlan.segments || [];
  const timeRegions = editPlan.timeRegions || [];
  const allMoments = moments?.moments || [];
  const interactiveMoments = allMoments.filter((m) => m.type !== "wait" && m.type !== "navigate");
  const cues = narration?.cues || [];

  if (timelineStats) {
    const stretchNote =
      Math.abs(deltaSec) >= 0.1
        ? ` · 원본 ${(rawFrames / fps).toFixed(1)}s ➔ 싱크 ${(totalFrames / fps).toFixed(1)}s (${
            deltaSec > 0 ? `+${deltaSec.toFixed(1)}s 연장` : `${deltaSec.toFixed(1)}s 단축`
          })`
        : ` (${(totalFrames / fps).toFixed(1)}s)`;
    timelineStats.textContent = `줌 ${segments.length}구간 · 동작 ${interactiveMoments.length}회 · 나레이션 ${cues.length}구간${stretchNote}`;
  }

  // Apply current zoom width and draw Lane 1: Time Ruler Ticks
  timelineVisualBar.style.width = `${timelineZoomLevel * 100}%`;
  timelineVisualBar.classList.toggle("is-zoomed", timelineZoomLevel >= 2);
  renderTimelineRulerTicks(totalMs);

  const zoomLaneTarget = timelineTrackZoom || timelineVisualBar;
  const momentsLaneTarget = timelineTrackMoments || timelineVisualBar;
  const narrationLaneTarget = timelineTrackNarration || timelineVisualBar;

  // Lane 2-A) Draw Zoom Segments (mapped onto unified composition timeline)
  segments.forEach((seg) => {
    const compStartMs = videoTimeMsToCompTimeMs((seg.startFrame / fps) * 1000, editPlan);
    const compEndMs = videoTimeMsToCompTimeMs((seg.endFrame / fps) * 1000, editPlan);
    const leftPercent = Math.min(99.5, Math.max(0, (compStartMs / totalMs) * 100));
    const widthPercent = Math.max(0.6, ((compEndMs - compStartMs) / totalMs) * 100);

    const block = document.createElement("div");
    block.className = "segment-block";
    block.style.left = `${leftPercent}%`;
    block.style.width = `${Math.min(100 - leftPercent, widthPercent)}%`;
    block.title = `[줌 ${seg.zoom}x] ${seg.description || "확대 구간"} (${(compStartMs / 1000).toFixed(1)}s ~ ${(
      compEndMs / 1000
    ).toFixed(1)}s)`;
    block.innerHTML = `<span class="segment-block-label">🔍 ${seg.zoom}x</span>`;
    zoomLaneTarget.appendChild(block);
  });

  // Lane 2-B) Draw Hold / Time-Stretch Regions on Zoom/Hold lane
  timeRegions.forEach((reg) => {
    const cSpanF = (reg.compEndFrame || 0) - (reg.compStartFrame || 0);
    if (cSpanF < 6) return;
    if (reg.speed < 0.25 || reg.speed > 1.15) {
      const startMs = (reg.compStartFrame / fps) * 1000;
      const endMs = (reg.compEndFrame / fps) * 1000;
      const leftPercent = Math.min(99.5, Math.max(0, (startMs / totalMs) * 100));
      const widthPercent = Math.max(0.5, ((endMs - startMs) / totalMs) * 100);

      const hBlock = document.createElement("div");
      hBlock.className = "hold-segment-block";
      hBlock.style.left = `${leftPercent}%`;
      hBlock.style.width = `${Math.min(100 - leftPercent, widthPercent)}%`;
      const durSec = ((endMs - startMs) / 1000).toFixed(1);
      hBlock.title =
        reg.speed < 0.25
          ? `⏸️ [구간 늘리기(홀드) +${durSec}s] 대본 #${reg.cueId || ""} 싱크 맞춤 구간 (${(startMs / 1000).toFixed(1)}s ~ ${(endMs / 1000).toFixed(1)}s)`
          : `⚡ [구간 단축 ${reg.speed.toFixed(2)}x] 대본 #${reg.cueId || ""} (${(startMs / 1000).toFixed(1)}s ~ ${(endMs / 1000).toFixed(1)}s)`;
      zoomLaneTarget.appendChild(hBlock);
    }
  });

  // Lane 3) Draw Interactive Action / Click Moment Markers
  const isMergedScenario =
    (Array.isArray(narration?.mergedFromSlugs) && narration.mergedFromSlugs.length > 0) ||
    (Array.isArray(details?.browsePlan?.mergedFromSlugs) && details.browsePlan.mergedFromSlugs.length > 0);
  interactiveMoments.forEach((m, i) => {
    const compMomentMs = videoTimeMsToCompTimeMs(m.timestamp || 0, editPlan);
    const leftPercent = Math.min(99.6, Math.max(0.2, (compMomentMs / totalMs) * 100));
    const marker = document.createElement("div");
    marker.className = "moment-marker";
    marker.dataset.momentIdx = String(i);
    marker.dataset.compMs = String(Math.round(compMomentMs));
    marker.style.left = `${leftPercent}%`;
    marker.title = `[#${i + 1} ${(m.type || "click").toUpperCase()}] ${m.description || ""} (싱크 ${(
      compMomentMs / 1000
    ).toFixed(1)}s / 원본 ${((m.timestamp || 0) / 1000).toFixed(1)}s) — 클릭 시 해당 동작으로 이동`;

    marker.addEventListener("click", (e) => {
      e.stopPropagation();
      if (videoPlayer && videoPlayer.duration) {
        stopRealtimeHoldAndAudio();
        const rawSec = (m.timestamp || 0) / 1000;
        if (currentVideoMode === "raw" && !isMergedScenario) {
          syncCompletedHoldRegionsForSeek(rawSec, compMomentMs);
        }
        realtimeHoldState.isProgrammaticSeek = true;
        videoPlayer.currentTime =
          currentVideoMode === "rendered" || isMergedScenario ? compMomentMs / 1000 : rawSec;
        realtimeHoldState.isProgrammaticResume = true;
        videoPlayer.play().catch(() => {
          realtimeHoldState.isProgrammaticResume = false;
        });
      }
      if (momentsStepList) {
        const cards = momentsStepList.querySelectorAll(".moment-step-card");
        const targetCard = cards[i];
        if (targetCard) {
          targetCard.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      }
    });

    momentsLaneTarget.appendChild(marker);
  });

  // Lane 4) Draw Narration TTS Segments (click to jump directly to script row)
  cues.forEach((cue, idx) => {
    const startMs = cue.startMs || 0;
    const endMs = cue.endMs || startMs + 2000;
    const leftPercent = Math.min(99.2, Math.max(0, (startMs / totalMs) * 100));
    const widthPercent = Math.max(0.6, ((endMs - startMs) / totalMs) * 100);

    const nBlock = document.createElement("div");
    nBlock.className = "narration-segment-block";
    nBlock.dataset.cueIdx = String(idx);
    nBlock.dataset.compStartMs = String(startMs);
    nBlock.dataset.compEndMs = String(endMs);
    nBlock.style.left = `${leftPercent}%`;
    nBlock.style.width = `${Math.min(100 - leftPercent, widthPercent)}%`;
    const deltaLabel =
      (cue.effectiveDeltaMs || 0) >= 100
        ? ` [구간 +${((cue.effectiveDeltaMs || 0) / 1000).toFixed(1)}s 연장]`
        : (cue.effectiveDeltaMs || 0) <= -100
        ? ` [구간 ${((cue.effectiveDeltaMs || 0) / 1000).toFixed(1)}s 단축]`
        : "";
    nBlock.title = `🎙️ [대본 #${idx + 1}] "${cue.text || ""}" (${(startMs / 1000).toFixed(1)}s ~ ${(
      endMs / 1000
    ).toFixed(1)}s)${deltaLabel}\n👉 클릭 시 해당 시점 이동 및 하단 대본 줄로 점프`;
    const cleanText = String(cue.text || "").trim();
    nBlock.innerHTML = `<span class="narration-block-label">#${idx + 1} ${escapeHtmlAttr(cleanText)}</span>`;

    nBlock.addEventListener("click", (e) => {
      e.stopPropagation();
      jumpFromTimelineToNarrationCue(idx, cue, details);
    });

    narrationLaneTarget.appendChild(nBlock);
  });

  if (videoPlayer && (videoPlayer.currentTime > 0 || realtimeHoldState.active)) {
    updateVideoPlaybackSync();
  }
  updateCutSelectionUI();
}

function renderMomentsStepList(details) {
  if (!momentsStepList) return;

  const rawMoments = details?.moments?.moments || [];
  const interactiveMoments = rawMoments.filter((m) => m.type !== "wait");
  const editSegments = details?.editPlan?.segments || [];
  const fps = details?.editPlan?.fps || 60;
  const narration = details?.narration || details?.editPlan?.narration;
  const isMergedScenario =
    (Array.isArray(narration?.mergedFromSlugs) && narration.mergedFromSlugs.length > 0) ||
    (Array.isArray(details?.browsePlan?.mergedFromSlugs) && details.browsePlan.mergedFromSlugs.length > 0);

  if (interactiveMoments.length > 0) {
    if (subtabMomentsCount) subtabMomentsCount.textContent = `${interactiveMoments.length}단계`;
    momentsStepList.innerHTML = "";

    interactiveMoments.forEach((m, idx) => {
      const rawSec = ((m.timestamp || 0) / 1000).toFixed(1);
      const compMs = videoTimeMsToCompTimeMs(m.timestamp || 0, details?.editPlan);
      const compSec = (compMs / 1000).toFixed(1);
      const timeSecLabel = Math.abs(compMs - (m.timestamp || 0)) >= 150 ? `${compSec}s` : `${rawSec}s`;
      const frame = Math.round(((m.timestamp || 0) / 1000) * fps);
      const activeZoomSeg = editSegments.find((s) => frame >= s.startFrame && frame <= s.endFrame && s.zoom > 1.05);
      const zoomLabel = activeZoomSeg ? `🔍 ${activeZoomSeg.zoom}x 줌` : "";
      const coordsLabel = m.x && m.y ? `(${Math.round(m.x)}, ${Math.round(m.y)})` : "";
      const typeUpper = (m.type || "click").toUpperCase();

      const card = document.createElement("div");
      card.className = "moment-step-card";
      card.dataset.timestampMs = m.timestamp || 0;
      card.dataset.compTimestampMs = Math.round(compMs);
      card.innerHTML = `
        <span class="moment-step-time" title="싱크 시점 ${compSec}s (원본 ${rawSec}s)">${timeSecLabel}</span>
        <div class="moment-step-info">
          <div class="moment-step-title" title="${escapeHtmlAttr(m.description || typeUpper)}">
            <span style="color:var(--accent); font-family:var(--font-mono); font-size:0.74rem; margin-right:4px;">#${idx + 1} ${typeUpper}</span>
            ${escapeHtmlAttr(m.description || "동작 수행")}
          </div>
          <div class="moment-step-sub">
            ${[zoomLabel, coordsLabel, m.selector || ""].filter(Boolean).join(" · ")}
          </div>
        </div>
      `;

      card.addEventListener("click", () => {
        if (videoPlayer && videoPlayer.duration) {
          stopRealtimeHoldAndAudio();
          const targetRawSec = (m.timestamp || 0) / 1000;
          if (currentVideoMode === "raw" && !isMergedScenario) {
            syncCompletedHoldRegionsForSeek(targetRawSec, compMs);
          }
          realtimeHoldState.isProgrammaticSeek = true;
          videoPlayer.currentTime =
            currentVideoMode === "rendered" || isMergedScenario ? compMs / 1000 : targetRawSec;
          realtimeHoldState.isProgrammaticResume = true;
          videoPlayer.play().catch(() => {
            realtimeHoldState.isProgrammaticResume = false;
          });
        }
      });

      momentsStepList.appendChild(card);
    });
    return;
  }

  // Fallback: if not recorded yet, show planned steps from browsePlan
  const plannedActions = (details?.browsePlan?.actions || []).filter((a) => a.type !== "wait");
  if (subtabMomentsCount) subtabMomentsCount.textContent = `${plannedActions.length}단계 (녹화 전)`;
  if (plannedActions.length === 0) {
    momentsStepList.innerHTML = `<div class="studio-empty-box">등록된 동작 모멘트가 없습니다.</div>`;
    return;
  }

  momentsStepList.innerHTML = "";
  plannedActions.forEach((act, idx) => {
    const card = document.createElement("div");
    card.className = "moment-step-card";
    card.innerHTML = `
      <span class="moment-step-time">#${idx + 1}</span>
      <div class="moment-step-info">
        <div class="moment-step-title" title="${escapeHtmlAttr(act.description || act.type)}">
          <span style="color:var(--accent); font-family:var(--font-mono); font-size:0.74rem; margin-right:4px;">${(act.type || "CLICK").toUpperCase()}</span>
          ${escapeHtmlAttr(act.description || "계획된 동작")}
        </div>
        <div class="moment-step-sub">${escapeHtmlAttr(act.selector || act.sourceSelector || "셀렉터 자동 탐색")}</div>
      </div>
    `;
    momentsStepList.appendChild(card);
  });
}

function formatTimecode(sec) {
  if (!sec || isNaN(sec) || sec < 0) return "00:00.0";
  const mins = Math.floor(sec / 60);
  const rem = (sec % 60).toFixed(1);
  return `${String(mins).padStart(2, "0")}:${rem.padStart(4, "0")}`;
}

function startRealtimePreviewLoop() {
  if (realtimeHoldState.rafId) return;
  const tick = () => {
    updateVideoPlaybackSync();
    if (videoPlayer && (!videoPlayer.paused || realtimeHoldState.active || realtimeHoldState.isProgrammaticResume)) {
      realtimeHoldState.rafId = requestAnimationFrame(tick);
    } else {
      realtimeHoldState.rafId = null;
    }
  };
  realtimeHoldState.rafId = requestAnimationFrame(tick);
}

function updateVideoPlaybackSync() {
  if (!videoPlayer) return;
  const details = scenarioDetailsCache[selectedScenario];
  const editPlan = details?.editPlan;
  const narration = details?.narration || editPlan?.narration;
  const fps = Number(editPlan?.fps || 60);
  const userSpeed = parseFloat(videoSpeedSelect?.value || "1") || 1.0;

  const rawCurSec = videoPlayer.currentTime || 0;
  const rawDurSec = videoPlayer.duration || 0;

  if (cutPreviewStopRawSec !== null && !videoPlayer.paused && rawCurSec >= cutPreviewStopRawSec) {
    cutPreviewStopRawSec = null;
    videoPlayer.pause();
  }

  let compCurMs = rawCurSec * 1000;
  let compTotalMs = rawDurSec * 1000;

  const badgeEl = document.getElementById("live-timewarp-badge");
  const subEl = document.getElementById("live-subtitle-overlay");
  const isMergedScenario =
    (Array.isArray(narration?.mergedFromSlugs) && narration.mergedFromSlugs.length > 0) ||
    (Array.isArray(details?.browsePlan?.mergedFromSlugs) && details.browsePlan.mergedFromSlugs.length > 0);

  if (
    currentVideoMode === "raw" &&
    !isMergedScenario &&
    editPlan &&
    Array.isArray(editPlan.timeRegions) &&
    editPlan.timeRegions.length > 0
  ) {
    compTotalMs = ((editPlan.totalDurationFrames || fps * rawDurSec) / fps) * 1000;
    const regions = editPlan.timeRegions;

    if (realtimeHoldState.active) {
      const elapsedSimMs = (performance.now() - realtimeHoldState.startWallMs) * userSpeed;
      if (elapsedSimMs >= realtimeHoldState.holdDurationMs) {
        // Hold finished! Mark region completed and resume raw video playback without seeking currentTime
        // (Seeking currentTime would fire the async 'seeking' event, interrupting activePreviewAudio & resetting hold state!)
        if (realtimeHoldState.regionIdx >= 0) {
          realtimeHoldState.completedRegions.add(realtimeHoldState.regionIdx);
        }
        const finishedEndMs = realtimeHoldState.compStartMs + realtimeHoldState.holdDurationMs;
        realtimeHoldState.active = false;
        realtimeHoldState.isProgrammaticPause = false;
        realtimeHoldState.regionIdx = -1;
        if (badgeEl) badgeEl.classList.add("hidden");
        videoPlayer.playbackRate = userSpeed;
        realtimeHoldState.isProgrammaticResume = true;
        videoPlayer.play().catch(() => {
          realtimeHoldState.isProgrammaticResume = false;
        });
        compCurMs = finishedEndMs;
      } else {
        compCurMs = realtimeHoldState.compStartMs + elapsedSimMs;
        const remainSec = Math.max(0, (realtimeHoldState.holdDurationMs - elapsedSimMs) / 1000).toFixed(1);
        const totalHoldSec = (realtimeHoldState.holdDurationMs / 1000).toFixed(1);
        if (badgeEl) {
          badgeEl.classList.remove("hidden");
          badgeEl.textContent = `⏸️ 실시간 구간 늘리기(홀드) 중 (+${totalHoldSec}s · 남은 ${remainSec}s)`;
        }
      }
    } else if (!videoPlayer.paused) {
      const rawCurFrame = rawCurSec * fps;
      const bakedIntroEndFrame = narration?.introBakedIntoVideo
        ? ((Number(narration.bakedIntroDurationMs || 0) - 50) / 1000) * fps
        : 0;
      // Check if we entered an uncompleted hold region (never pause inside the baked opening slide!)
      let triggeredHold = false;
      for (let rIdx = 0; rIdx < regions.length; rIdx++) {
        const r = regions[rIdx];
        if (bakedIntroEndFrame > 0 && (r.videoStartFrame || 0) < bakedIntroEndFrame) {
          realtimeHoldState.completedRegions.add(rIdx);
          continue;
        }
        const vSpan = Math.max(0, (r.videoEndFrame || 0) - (r.videoStartFrame || 0));
        const cSpan = Math.max(0, (r.compEndFrame || 0) - (r.compStartFrame || 0));
        const extraHoldFrames = cSpan - vSpan;
        if (r.speed < 0.25 && extraHoldFrames >= 4 && !realtimeHoldState.completedRegions.has(rIdx)) {
          if (rawCurFrame >= r.videoStartFrame && rawCurFrame <= r.videoEndFrame + 6) {
            const alreadyPlayedRawF = Math.max(0, Math.min(vSpan, rawCurFrame - r.videoStartFrame));
            realtimeHoldState.completedRegions.add(rIdx);
            realtimeHoldState.active = true;
            realtimeHoldState.isProgrammaticPause = true;
            realtimeHoldState.regionIdx = rIdx;
            realtimeHoldState.compStartMs = ((r.compStartFrame + alreadyPlayedRawF) / fps) * 1000;
            realtimeHoldState.holdDurationMs = (extraHoldFrames / fps) * 1000;
            realtimeHoldState.videoEndFrame = r.videoEndFrame;
            realtimeHoldState.startWallMs = performance.now();
            videoPlayer.pause();
            compCurMs = realtimeHoldState.compStartMs;
            triggeredHold = true;
            startRealtimePreviewLoop();
            break;
          }
        }
      }

      if (!triggeredHold) {
        // Check if we are in a shortened (fast-forward) region
        const activeReg = regions.find(
          (r) => rawCurFrame >= r.videoStartFrame && rawCurFrame <= r.videoEndFrame && r.speed >= 0.25
        );
        if (activeReg && activeReg.speed > 1.08) {
          const targetRate = Math.min(4.0, Number((userSpeed * activeReg.speed).toFixed(2)));
          if (Math.abs(videoPlayer.playbackRate - targetRate) > 0.05) {
            videoPlayer.playbackRate = targetRate;
          }
          if (badgeEl) {
            badgeEl.classList.remove("hidden");
            badgeEl.textContent = `⚡ 실시간 구간 단축 재생 (${activeReg.speed.toFixed(2)}x)`;
          }
        } else {
          if (Math.abs(videoPlayer.playbackRate - userSpeed) > 0.05) {
            videoPlayer.playbackRate = userSpeed;
          }
          if (badgeEl) badgeEl.classList.add("hidden");
        }
        compCurMs = videoTimeMsToCompTimeMs(rawCurSec * 1000, editPlan, realtimeHoldState.completedRegions);
      }
    } else {
      compCurMs = videoTimeMsToCompTimeMs(rawCurSec * 1000, editPlan, realtimeHoldState.completedRegions);
      if (badgeEl) badgeEl.classList.add("hidden");
    }

    // Live Subtitle & TTS Audio Preview in Raw Mode
    const cues = narration?.cues || [];
    const speakingCue = cues.find((c, idx) => {
      const nextCueStart = idx < cues.length - 1 ? cues[idx + 1].startMs || Infinity : Infinity;
      const effectiveEnd = Math.min(nextCueStart - 10, (c.endMs || 0) + 100);
      return compCurMs >= (c.startMs || 0) && compCurMs <= effectiveEnd;
    });
    const isPlayingOrHolding = !videoPlayer.paused || realtimeHoldState.active;

    // 오프닝 슬라이드는 이미 recording.mp4 영상 자체에 직접 합성되어 있으므로
    // 플레이어 위를 가리는 예전 HTML 오버레이(#live-intro-toc-overlay)는 항상 숨김 처리합니다.
    const tocOverlayEl = document.getElementById("live-intro-toc-overlay");
    if (tocOverlayEl) {
      tocOverlayEl.classList.add("hidden");
    }

    if (subEl) {
      if (
        narration?.showSubtitles !== false &&
        !isMergedScenario &&
        speakingCue &&
        speakingCue.text
      ) {
        subEl.classList.remove("hidden");
        subEl.textContent = speakingCue.text;
        subEl.style.left = "50%";
        subEl.style.maxWidth = "69%";
      } else {
        subEl.classList.add("hidden");
      }
    }

    const isMergedAllAudioInVideo = isMergedScenario && !videoPlayer.muted;
    const isBakedIntroAudioInVideo = Boolean(
      isMergedAllAudioInVideo ||
        (narration?.introBakedIntoVideo &&
          speakingCue &&
          (speakingCue.id === 1 || speakingCue.isIntro) &&
          !videoPlayer.muted)
    );

    if (
      isPlayingOrHolding &&
      narration?.enabled !== false &&
      speakingCue &&
      speakingCue.audioFile &&
      !isBakedIntroAudioInVideo
    ) {
      if (
        !realtimeHoldState.playedCueIds.has(speakingCue.id) &&
        compCurMs < (speakingCue.endMs || 0) - 180
      ) {
        realtimeHoldState.playedCueIds.add(speakingCue.id);
        realtimeHoldState.lastPlayedCueId = speakingCue.id;
        if (activePreviewAudio) {
          try {
            activePreviewAudio.pause();
          } catch {}
        }
        const audioFileName = speakingCue.audioFile.split("/").pop();
        const url = `/api/narration/audio/${selectedScenario}/${audioFileName}`;
        activePreviewAudio = new Audio(url);
        activePreviewAudio.playbackRate = userSpeed;
        const offsetSec = Math.max(0, (compCurMs - (speakingCue.startMs || 0)) / 1000);
        if (offsetSec > 0.25) {
          activePreviewAudio.currentTime = offsetSec;
        }
        activePreviewAudio.play().catch(() => {});
      }
    }
  } else {
    if (badgeEl) badgeEl.classList.add("hidden");
    if (subEl) subEl.classList.add("hidden");
    const tocOverlayEl = document.getElementById("live-intro-toc-overlay");
    if (tocOverlayEl) tocOverlayEl.classList.add("hidden");
  }

  const displayCurSec = compCurMs / 1000;
  const displayDurSec = compTotalMs / 1000;

  if (videoTimecode) {
    if (currentVideoMode === "raw" && Math.abs(displayDurSec - rawDurSec) >= 0.2 && rawDurSec > 0) {
      videoTimecode.textContent = `${formatTimecode(displayCurSec)} / ${formatTimecode(displayDurSec)} (원본 ${formatTimecode(rawCurSec)})`;
    } else {
      videoTimecode.textContent = `${formatTimecode(displayCurSec)} / ${formatTimecode(displayDurSec)}`;
    }
  }

  if (timelinePlayhead && compTotalMs > 0) {
    const pct = Math.min(100, Math.max(0, (compCurMs / compTotalMs) * 100));
    timelinePlayhead.style.left = `${pct}%`;
    if ((!videoPlayer.paused || realtimeHoldState.active) && timelineZoomLevel > 1.01) {
      scrollTimelineToCompMs(compCurMs, false);
    }
  }

  // Highlight active moment marker on timeline & moment card in step list
  if (timelineTrackMoments) {
    timelineTrackMoments.querySelectorAll(".moment-marker[data-comp-ms]").forEach((mEl) => {
      const mCompMs = parseFloat(mEl.dataset.compMs || "0");
      mEl.classList.toggle("active-timeline-moment", Math.abs(compCurMs - mCompMs) <= 650);
    });
  }

  if (momentsStepList) {
    const cards = momentsStepList.querySelectorAll(".moment-step-card[data-timestamp-ms]");
    let activeCard = null;
    const useCompTime = currentVideoMode === "rendered" || isMergedScenario;
    const refMs = useCompTime ? compCurMs : rawCurSec * 1000;
    cards.forEach((c) => {
      const tMs = useCompTime
        ? parseFloat(c.dataset.compTimestampMs || c.dataset.timestampMs || "0")
        : parseFloat(c.dataset.timestampMs || "0");
      const isNear = Math.abs(refMs - tMs) <= 900;
      c.classList.toggle("active-moment", isNear);
      if (isNear) activeCard = c;
    });
    if (activeCard && (!videoPlayer.paused || realtimeHoldState.active)) {
      activeCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }

  // Highlight active narration block on timeline & active narration cue row in script editor
  if (timelineTrackNarration) {
    timelineTrackNarration.querySelectorAll(".narration-segment-block").forEach((bEl) => {
      const bStart = parseFloat(bEl.dataset.compStartMs || "0");
      const bEnd = parseFloat(bEl.dataset.compEndMs || String(bStart + 2500));
      bEl.classList.toggle("active-timeline-cue", compCurMs >= bStart && compCurMs <= bEnd + 150);
    });
  }

  const cueRows = document.querySelectorAll("#narration-cues-container .narration-cue-row");
  cueRows.forEach((row) => {
    const startMs = parseFloat(row.dataset.compStartMs || "0");
    const endMs = parseFloat(row.dataset.compEndMs || String(startMs + 2500));
    const isSpeaking = compCurMs >= startMs && compCurMs <= endMs + 150;
    row.classList.toggle("active-cue", isSpeaking);
  });

  // Highlight active merged chapter tab based on current playback time
  const chapterTabBtns = document.querySelectorAll("#narration-chapter-tabs-bar .narration-chapter-tab");
  if (chapterTabBtns.length > 0) {
    let matchedTab = null;
    chapterTabBtns.forEach((tabBtn) => {
      const chStartMs = parseFloat(tabBtn.dataset.compStartMs ?? tabBtn.dataset.startMs ?? "0");
      const chNextStartMs = parseFloat(tabBtn.dataset.nextCompStartMs ?? "999999999");
      if (compCurMs >= chStartMs - 150 && compCurMs < chNextStartMs - 150) {
        matchedTab = tabBtn;
      }
    });
    if (!matchedTab && compCurMs < 1000) {
      matchedTab = chapterTabBtns[0];
    }
    if (matchedTab) {
      chapterTabBtns.forEach((tabBtn) => tabBtn.classList.toggle("active", tabBtn === matchedTab));
    }
  }
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
  else if (type === "narration") data = details.narration || details.editPlan?.narration || null;

  jsonViewerContent.textContent = data ? JSON.stringify(data, null, 2) : "데이터가 없습니다.";
}

// 8.5 AI Narration Script & Edge Neural TTS Studio
let activePreviewAudio = null;

const STYLE_RECOMMENDED_PITCH = {
  manual: "+0Hz",
  friendly: "+4Hz",
  presentation: "-3Hz",
  compact: "+2Hz",
};

function getOpeningTemplateByStyle(style) {
  switch (style) {
    case "friendly":
      return "안녕하세요! 지금부터 이 화면의 주요 기능을 함께 따라 해 볼게요.";
    case "presentation":
      return "지금부터 본 시나리오의 핵심 업무 처리 과정을 시연해 보시겠습니다.";
    case "compact":
      return "본 매뉴얼의 핵심 기능 실행 절차를 안내합니다.";
    case "manual":
    default:
      return "이번 영상에서는 본 시나리오의 주요 기능과 사용 방법을 순서대로 안내합니다.";
  }
}

function buildCueSyncBadgeHtml(cue) {
  const autoHold = Number(cue.autoHoldMs || 0);
  const extraHold = Number(cue.extraHoldMs || 0);
  const effDelta = Number(cue.effectiveDeltaMs || 0);

  if (extraHold > 0) {
    return `<span class="cue-sync-badge badge-manual-hold" title="대본 자동 홀드 ${(autoHold / 1000).toFixed(1)}s + 수동 늘리기 +${(
      extraHold / 1000
    ).toFixed(1)}s — 뒤따르는 대본·카메라 줌·커서 싱크가 자동으로 함께 이동합니다">⏱️ +${(effDelta / 1000).toFixed(
      1
    )}s</span>`;
  }
  if (effDelta <= -100) {
    return `<span class="cue-sync-badge badge-shrink" title="수동 구간 줄이기 적용됨 (대본 음성 길이 이하로는 줄어들지 않아 음성이 절대 잘리지 않습니다)">⚡ ${(
      effDelta / 1000
    ).toFixed(1)}s</span>`;
  }
  if (autoHold >= 100) {
    return `<span class="cue-sync-badge badge-auto-hold" title="대본이 원본 동작 간격보다 길어 음성 속도를 빠르게 왜곡하지 않고 화면을 자동으로 +${(
      effDelta / 1000
    ).toFixed(1)}s 홀드(연장)하여 싱크를 맞춥니다">⏳ +${(effDelta / 1000).toFixed(1)}s 연장</span>`;
  }
  return `<span class="cue-sync-badge badge-normal" title="원본 영상 길이 안에서 정상 속도로 대본이 재생됩니다">1.0x 정속</span>`;
}

function extractSmartTitleFromOpening(openingText, fallbackSlug) {
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
  const slugMap = {
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

function extractSmartStepTitleFromCueText(cueText, idx) {
  let clause = String(cueText || "").trim().replace(/\.$/, "");
  if (!clause) return `단계 ${idx + 1}`;

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
    .replace(/(?:을|를)\s*([가-힣A-Za-z0-9\s]{1,12}?)(?:합니다|입니다|할\s*수\s*있습니다|하실\s*수\s*있습니다|드립니다|해\s*볼게요|보시겠습니다|주겠습니다)$/, " $1")
    .replace(/(?:에|으로|로)\s*(로그인|이동|접속|진입|전환|저장|등록)(?:합니다|할\s*수\s*있습니다|하실\s*수\s*있습니다|해\s*볼게요|보시겠습니다)$/, " $1")
    .replace(/(?:합니다|입니다|할\s*수\s*있습니다|하실\s*수\s*있습니다|드립니다|해\s*볼게요|보시겠습니다|주겠습니다)$/, "")
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
  return clause.length >= 3 ? clause : `단계 ${idx + 1}`;
}

function toOverviewBulletTextJS(rawLine) {
  const txt = String(rawLine || "")
    .trim()
    .replace(/\.$/, "")
    .replace(/(?:안내|소개|설명)\s*방법을\s*(?:안내|소개|설명)합니다$/, "방법을 안내합니다");
  if (!txt) return "";
  if (/(?:소개합니다|안내합니다|설명합니다|살펴봅니다|알아봅니다)$/.test(txt)) {
    return `${txt}.`;
  }
  let core = txt
    .replace(/^.+?위해\s+/, "")
    .replace(/(?:을|를)\s*(?:입력하고|선택하고|클릭하고)\s+/, " 및 ");

  const endingRules = [
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

function stripVersionAndConversationalTextJS(raw) {
  return String(raw || "")
    .replace(/\b(?:ver\.?|v\.?)\s*\d+(?:\.\d+)*\b/gi, "")
    .replace(/이번\s*(?:시간|영상|매뉴얼|과정)에서는\s+[^.?!]+[.?!]?/g, "")
    .replace(/지금부터는?\s+[^.?!]+[.?!]?/g, "")
    .replace(/(?:안내|소개|설명)\s*방법을\s*(?:안내|소개|설명)합니다/g, "방법을 안내합니다")
    .replace(/\s+/g, " ")
    .trim();
}

function formatLeftCoverHeadingJS(rawBadge) {
  const clean = stripVersionAndConversationalTextJS(rawBadge || "그룹웨어 사용 매뉴얼");
  if (!clean || clean === "그룹웨어 교육 가이드" || clean === "그룹웨어 사용 매뉴얼") {
    return { line1: "그룹웨어", line2: "사용 매뉴얼" };
  }
  const words = clean.split(/\s+/);
  if (words.length >= 2) {
    return { line1: words[0], line2: words.slice(1).join(" ") };
  }
  return { line1: "그룹웨어", line2: clean };
}

function deriveDefaultIntroToc(narration) {
  const cues = narration?.cues || [];
  const openingText = (cues[0]?.text || "").trim();
  const title = stripVersionAndConversationalTextJS(
    extractSmartTitleFromOpening(openingText, narration?.slug || selectedScenario)
  );
  const items = cues.slice(1, 5).map((c, idx) => ({
    title: stripVersionAndConversationalTextJS(extractSmartStepTitleFromCueText(c.text, idx)),
    description: stripVersionAndConversationalTextJS(toOverviewBulletTextJS(c.text || "")),
  }));
  if (items.length === 0) {
    items.push({
      title: "주요 기능 안내",
      description: `${title}의 주요 메뉴 구성과 활용 방법을 안내합니다.`,
    });
  }
  const summary = `${title}의 주요 메뉴 구성과 활용 방법을 안내합니다.`;
  return {
    enabled: narration?.showIntroToc !== false,
    badge: "그룹웨어 사용 매뉴얼",
    title,
    summary,
    items,
  };
}

function getEffectiveIntroToc(narration) {
  const fallback = deriveDefaultIntroToc(narration);
  const raw = narration?.introToc;
  if (!raw || typeof raw !== "object") return fallback;
  const rawTitle = stripVersionAndConversationalTextJS(raw.title || "");
  const isGenericDemoSlug = /^live\s+demo\s+\d+$/i.test(rawTitle);
  const items =
    Array.isArray(raw.items) && raw.items.length > 0
      ? raw.items.slice(0, 8).map((it, idx) => {
          const cleanT = stripVersionAndConversationalTextJS(it?.title || "");
          const cleanD = stripVersionAndConversationalTextJS(
            it?.description || fallback.items[idx]?.description || ""
          );
          const isShortTitleInDesc = !cleanT && cleanD && cleanD.length <= 36 && !/[.!?]$/.test(cleanD);
          return {
            title: isShortTitleInDesc
              ? cleanD
              : !cleanT || /^단계\s*\d+$|^주요\s*단계\s*\d*$/.test(cleanT)
              ? extractSmartStepTitleFromCueText(cleanD, idx)
              : cleanT,
            description: isShortTitleInDesc
              ? `${cleanD}의 주요 기능과 사용 절차를 안내합니다.`
              : cleanD,
          };
        })
      : fallback.items;

  const cleanBadge = stripVersionAndConversationalTextJS(raw.badge || fallback.badge || "그룹웨어 사용 매뉴얼");
  const cleanSummary = stripVersionAndConversationalTextJS(raw.summary || "");

  return {
    enabled: raw.enabled !== undefined ? Boolean(raw.enabled) : fallback.enabled,
    badge: cleanBadge === "그룹웨어 교육 가이드" ? "그룹웨어 사용 매뉴얼" : cleanBadge || "그룹웨어 사용 매뉴얼",
    title: !rawTitle || isGenericDemoSlug ? fallback.title : rawTitle,
    summary: cleanSummary || fallback.summary,
    items,
  };
}

function escapeHtmlAttr(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function renderLiveIntroTocOverlay(overlayEl, narration) {
  if (!overlayEl) return;
  const toc = getEffectiveIntroToc(narration);
  const siteBrand = narration?.siteBrand || toc?.siteBrand || {};
  const sig = JSON.stringify({ toc, siteBrand });
  if (overlayEl.dataset.tocSig === sig) return;
  overlayEl.dataset.tocSig = sig;

  const primaryColor = siteBrand.primaryColor || "#0068ff";
  const secondaryColor = siteBrand.secondaryColor || "#0047b3";
  const accentColor = siteBrand.accentColor || "#0bb4fa";
  const siteName = siteBrand.siteName || "그룹웨어";
  const logoUrl = siteBrand.logoUrl || "";

  const coverHeading = formatLeftCoverHeadingJS(toc.badge || siteBrand.manualBadge);
  const cleanSubtitle = stripVersionAndConversationalTextJS(toc.summary);

  const rowsHtml = (toc.items || [])
    .slice(0, 8)
    .map((it, idx) => {
      const rawTitle = stripVersionAndConversationalTextJS(it.title || "");
      const rawDesc = stripVersionAndConversationalTextJS(it.description || "");
      const hasDistinctTitle =
        Boolean(rawTitle) &&
        Boolean(rawDesc) &&
        rawTitle !== rawDesc &&
        !/^(?:단계|주요\s*단계|핵심|주요\s*기능)\s*\d*$/.test(rawTitle);

      return `
      <div style="display:flex;align-items:center;gap:14px;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;padding:14px 18px;box-shadow:0 4px 14px rgba(15,41,66,0.05);">
        <div style="min-width:32px;height:32px;border-radius:8px;background:${escapeHtmlAttr(
          primaryColor
        )}14;border:1px solid ${escapeHtmlAttr(
        primaryColor
      )}45;display:flex;align-items:center;justify-content:center;font-size:13.5px;font-weight:800;color:${escapeHtmlAttr(
        primaryColor
      )};flex-shrink:0;">${String(idx + 1).padStart(2, "0")}</div>
        <div style="display:flex;flex-direction:column;gap:4px;flex:1;min-width:0;">
          ${
            hasDistinctTitle
              ? `<span style="font-size:15.5px;font-weight:700;color:#0f2942;letter-spacing:-0.02em;line-height:1.28;word-break:keep-all;">${escapeHtmlAttr(
                  rawTitle
                )}</span>
                 <span style="font-size:13px;font-weight:500;color:#475569;letter-spacing:-0.015em;line-height:1.38;word-break:keep-all;">${escapeHtmlAttr(
                   rawDesc
                 )}</span>`
              : `<span style="font-size:14.5px;font-weight:600;color:#1e293b;letter-spacing:-0.02em;line-height:1.38;word-break:keep-all;">${escapeHtmlAttr(
                  rawDesc || rawTitle
                )}</span>`
          }
        </div>
      </div>`;
    })
    .join("");

  overlayEl.innerHTML = `
    <div style="width:100%;height:100%;background:#f4f7fc;display:flex;flex-direction:column;justify-content:center;padding:28px 48px 28px 48px;position:relative;overflow:hidden;">
      <div style="position:absolute;top:0;left:0;right:0;height:5px;background:linear-gradient(90deg,${escapeHtmlAttr(
        primaryColor
      )} 0%,${escapeHtmlAttr(accentColor)} 100%);"></div>
      <button type="button" id="btn-close-live-toc-preview" title="플레이어 미리보기에서 오프닝 슬라이드를 닫습니다" style="position:absolute;top:10px;right:12px;pointer-events:auto;background:rgba(15,41,66,0.08);border:1px solid rgba(15,41,66,0.16);border-radius:999px;padding:3px 9px;font-size:11px;font-weight:600;color:#334155;cursor:pointer;z-index:5;">✕ 미리보기 닫기</button>
      <div style="display:flex;justify-content:space-between;align-items:flex-end;gap:16px;padding-bottom:14px;border-bottom:1.5px solid #dce5f2;">
        <div style="display:flex;flex-direction:column;gap:4px;">
          <div style="font-size:14.5px;font-weight:800;color:${escapeHtmlAttr(primaryColor)};letter-spacing:0.02em;text-transform:uppercase;">Contents</div>
          <div style="font-size:24px;font-weight:800;color:#0f2942;letter-spacing:-0.03em;line-height:1.24;word-break:keep-all;">${escapeHtmlAttr(
            toc.title
          )}</div>
          ${
            cleanSubtitle
              ? `<div style="font-size:13px;font-weight:500;color:#475569;letter-spacing:-0.01em;line-height:1.38;margin-top:2px;word-break:keep-all;">${escapeHtmlAttr(
                  cleanSubtitle
                )}</div>`
              : ""
          }
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px;flex-shrink:0;">
          ${
            logoUrl
              ? `<img src="${escapeHtmlAttr(
                  logoUrl
                )}" alt="Site Logo" style="height:22px;max-width:140px;object-fit:contain;" />`
              : `<span style="font-size:13px;font-weight:800;color:${escapeHtmlAttr(primaryColor)};">${escapeHtmlAttr(
                  siteName
                )}</span>`
          }
          <span style="font-size:10px;font-weight:700;color:#475569;background:#e2e8f0;padding:2px 8px;border-radius:999px;">${escapeHtmlAttr(
            toc.badge || siteBrand.manualBadge || "그룹웨어 사용 매뉴얼"
          )}</span>
        </div>
      </div>
      <div style="margin-top:18px;display:flex;flex-direction:column;gap:11px;overflow-y:auto;">
        ${rowsHtml}
      </div>
    </div>
  `;

  const closeBtn = overlayEl.querySelector("#btn-close-live-toc-preview");
  if (closeBtn) {
    closeBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      window.__hideIntroTocPreview = true;
      window.__forcePreviewIntroToc = false;
      overlayEl.classList.add("hidden");
    });
  }
}

let isSiteBrandEditorExpanded = false;
let isSiteBrandDrawerOpen = false;
let isIntroTocDrawerOpen = false;

function updateVoiceOptionsSummaryUI() {
  const summaryEl = document.getElementById("voice-options-summary-text");
  const voiceSelect = document.getElementById("narration-voice-select");
  const rateSelect = document.getElementById("narration-rate-select");
  if (!summaryEl) return;
  const vVal = voiceSelect ? voiceSelect.value : "ko-KR-SunHiNeural";
  const rVal = rateSelect ? rateSelect.value : "+5%";
  const vName = vVal.includes("InJoon") ? "인준" : vVal.includes("Hyunsu") ? "현수" : "선희";
  summaryEl.textContent = `${vName} · ${rVal}`;
}

function renderSiteBrandBar(details, narration) {
  const barEl = document.getElementById("narration-site-brand-bar");
  if (!barEl) return;

  if (!details || !selectedScenario) {
    barEl.classList.add("hidden");
    barEl.innerHTML = "";
    return;
  }

  const brand =
    narration?.siteBrand ||
    details?.siteBrand ||
    narration?.introToc?.siteBrand || {
      hostKey: details?.hostKey || "default_site",
      originUrl: details?.browsePlan?.url || "",
      siteName: details?.siteName || "그룹웨어",
      manualBadge: narration?.introToc?.badge || "그룹웨어 사용 매뉴얼",
      primaryColor: details?.primaryColor || "#0068FF",
      logoUrl: details?.logoUrl || "",
    };

  const siteName = brand.siteName || "그룹웨어";
  const manualBadge = brand.manualBadge || narration?.introToc?.badge || "그룹웨어 사용 매뉴얼";
  const primaryColor = /^#[0-9a-fA-F]{6}$/.test(String(brand.primaryColor || "").trim())
    ? String(brand.primaryColor).trim().toUpperCase()
    : "#0068FF";
  const hostKey = brand.hostKey || "default_site";
  const baseDomain = details.baseDomain || hostKey;
  const logoUrl = brand.logoUrl ? `${brand.logoUrl}?t=${Date.now()}` : "";

  barEl.classList.toggle("hidden", !isSiteBrandDrawerOpen);
  const brandToggleBtn = document.getElementById("btn-toggle-brand-drawer");
  if (brandToggleBtn) {
    brandToggleBtn.classList.toggle("active", isSiteBrandDrawerOpen);
    brandToggleBtn.innerHTML = `<span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${escapeHtmlAttr(
      primaryColor
    )};"></span> 🎨 브랜드(${escapeHtmlAttr(siteName)}) ${isSiteBrandDrawerOpen ? "▴" : "▾"}`;
  }

  const presetColors = [
    { hex: "#FF9600", label: "부천대 오렌지 (#FF9600)" },
    { hex: "#218CF3", label: "유니슨 블루 (#218CF3)" },
    { hex: "#0068FF", label: "그룹웨어 블루 (#0068FF)" },
    { hex: "#0F7B0F", label: "에메랄드 그린 (#0F7B0F)" },
    { hex: "#5C2D91", label: "엔터프라이즈 퍼플 (#5C2D91)" },
    { hex: "#D83B01", label: "코랄 레드 (#D83B01)" },
  ];

  const presetsHtml = presetColors
    .map(
      (p) =>
        `<button type="button" class="btn-brand-color-preset" data-color="${p.hex}" title="${escapeHtmlAttr(
          p.label
        )}" style="background:${p.hex};"></button>`
    )
    .join("");

  barEl.innerHTML = `
    <div class="site-brand-summary-row">
      <div class="site-brand-summary-left">
        <span class="site-brand-color-swatch" id="brand-summary-swatch" style="background:${escapeHtmlAttr(
          primaryColor
        )};" title="테마 대표 색상 (${escapeHtmlAttr(primaryColor)})"></span>
        ${
          logoUrl
            ? `<img src="${escapeHtmlAttr(
                logoUrl
              )}" alt="Site Logo" class="site-brand-logo-thumb" onerror="this.style.display='none'" />`
            : ""
        }
        <span class="site-brand-name-pill" id="brand-summary-name">${escapeHtmlAttr(siteName)}</span>
        <span class="site-brand-badge-pill" id="brand-summary-badge">${escapeHtmlAttr(manualBadge)}</span>
        <span class="site-brand-domain-pill" title="동일 상위 도메인(${escapeHtmlAttr(
          baseDomain
        )})을 공유하는 모든 서브도메인(예: gw / gwdev)과 시나리오에 브랜드 로고·테마 색상이 자동 상속됩니다">🌐 ${escapeHtmlAttr(
    hostKey
  )}${baseDomain && baseDomain !== hostKey ? ` (상위도메인 ${escapeHtmlAttr(baseDomain)} 자동상속)` : ""}</span>
        <span class="site-brand-hex-pill" id="brand-summary-hex">${escapeHtmlAttr(primaryColor)}</span>
      </div>
      <div style="display:inline-flex;align-items:center;gap:6px;">
        <button type="button" class="btn btn-sm btn-outline" id="btn-toggle-site-brand-editor" style="padding:3px 10px;font-size:11.5px;font-weight:700;">
          🎨 사이트 브랜드(로고·색상·기관명) 설정 ${isSiteBrandEditorExpanded ? "▴" : "▾"}
        </button>
      </div>
    </div>
    <div class="site-brand-editor-panel${isSiteBrandEditorExpanded ? "" : " hidden"}" id="site-brand-editor-panel">
      <div class="site-brand-fields-row">
        <div class="site-brand-field-group">
          <label class="site-brand-field-label" for="brand-site-name-input">기관/사이트명</label>
          <input type="text" id="brand-site-name-input" value="${escapeHtmlAttr(
            siteName
          )}" placeholder="예: 부천대학교, 유니슨 그룹" style="width:165px;padding:5px 8px;font-size:12px;font-weight:700;" />
        </div>
        <div class="site-brand-field-group">
          <label class="site-brand-field-label" for="brand-manual-badge-input">매뉴얼 배지</label>
          <input type="text" id="brand-manual-badge-input" value="${escapeHtmlAttr(
            manualBadge
          )}" placeholder="예: 그룹웨어 사용 매뉴얼" style="width:190px;padding:5px 8px;font-size:12px;" />
        </div>
        <div class="site-brand-field-group">
          <label class="site-brand-field-label" for="brand-primary-color-picker">테마 색상</label>
          <input type="color" id="brand-primary-color-picker" value="${escapeHtmlAttr(
            primaryColor
          )}" style="width:30px;height:28px;padding:1px;border-radius:4px;border:1px solid var(--stroke);cursor:pointer;background:var(--card);" />
          <input type="text" id="brand-primary-color-hex" value="${escapeHtmlAttr(
            primaryColor
          )}" maxlength="7" style="width:82px;padding:5px 7px;font-size:12px;font-family:var(--font-mono);text-transform:uppercase;" />
          <div class="site-brand-color-presets" title="자주 쓰는 기관 테마 색상 빠른 선택">
            ${presetsHtml}
          </div>
        </div>
      </div>
      <div class="site-brand-actions-row">
        <label class="narration-check-pill" title="체크 시 같은 기관 상위 도메인(${escapeHtmlAttr(
          baseDomain
        )})을 사용하는 모든 시나리오와 서브도메인(gw / gwdev 등)에 동일 브랜드 설정을 일괄 적용합니다">
          <input type="checkbox" id="brand-propagate-domain-toggle" checked />
          <span>🔗 상위 도메인(${escapeHtmlAttr(baseDomain)})의 모든 시나리오·서브도메인에 공통 적용</span>
        </label>
        <div style="display:inline-flex;align-items:center;gap:6px;">
          <button type="button" class="btn btn-sm btn-outline" id="btn-save-site-brand" style="padding:4px 10px;font-size:11.5px;font-weight:700;">
            💾 브랜드 설정 저장
          </button>
          <button type="button" class="btn btn-sm btn-primary" id="btn-save-and-bake-site-brand" title="변경한 브랜드 색상·기관명·배지를 저장하고 오프닝 슬라이드 영상을 즉시 재합성합니다" style="padding:4px 11px;font-size:11.5px;font-weight:700;">
            🎬 저장 후 오프닝 슬라이드 즉시 재합성
          </button>
        </div>
      </div>
    </div>
  `;

  const toggleBtn = barEl.querySelector("#btn-toggle-site-brand-editor");
  const panelEl = barEl.querySelector("#site-brand-editor-panel");
  if (toggleBtn && panelEl) {
    toggleBtn.addEventListener("click", () => {
      isSiteBrandEditorExpanded = !isSiteBrandEditorExpanded;
      panelEl.classList.toggle("hidden", !isSiteBrandEditorExpanded);
      toggleBtn.innerHTML = `🎨 사이트 브랜드(로고·색상·기관명) 설정 ${isSiteBrandEditorExpanded ? "▴" : "▾"}`;
    });
  }

  const colorPicker = barEl.querySelector("#brand-primary-color-picker");
  const colorHexInput = barEl.querySelector("#brand-primary-color-hex");
  const summarySwatch = barEl.querySelector("#brand-summary-swatch");
  const summaryHex = barEl.querySelector("#brand-summary-hex");

  const applyColorInput = (hexVal) => {
    const clean = String(hexVal || "").trim().toUpperCase();
    if (/^#[0-9A-F]{6}$/.test(clean)) {
      if (colorPicker) colorPicker.value = clean;
      if (colorHexInput) colorHexInput.value = clean;
      if (summarySwatch) summarySwatch.style.background = clean;
      if (summaryHex) summaryHex.textContent = clean;
    }
  };

  if (colorPicker) {
    colorPicker.addEventListener("input", () => applyColorInput(colorPicker.value));
  }
  if (colorHexInput) {
    colorHexInput.addEventListener("input", () => {
      const val = colorHexInput.value.trim();
      if (/^#[0-9a-fA-F]{6}$/.test(val)) {
        applyColorInput(val);
      }
    });
  }
  barEl.querySelectorAll(".btn-brand-color-preset").forEach((btn) => {
    btn.addEventListener("click", () => {
      const c = btn.getAttribute("data-color");
      if (c) applyColorInput(c);
    });
  });

  const handleSaveBrand = async (bakeSlide) => {
    if (!selectedScenario) return;
    const slug = selectedScenario;
    const saveBtn = barEl.querySelector("#btn-save-site-brand");
    const bakeBtn = barEl.querySelector("#btn-save-and-bake-site-brand");
    const nextSiteName = (barEl.querySelector("#brand-site-name-input")?.value || "").trim() || siteName;
    const nextManualBadge = (barEl.querySelector("#brand-manual-badge-input")?.value || "").trim() || manualBadge;
    const nextPrimaryColor =
      (barEl.querySelector("#brand-primary-color-hex")?.value || "").trim() ||
      colorPicker?.value ||
      primaryColor;
    const propagateToBaseDomain = barEl.querySelector("#brand-propagate-domain-toggle")?.checked !== false;

    if (saveBtn) saveBtn.disabled = true;
    if (bakeBtn) {
      bakeBtn.disabled = true;
      if (bakeSlide) bakeBtn.textContent = "⏳ 브랜드 저장 & 슬라이드 재합성 중...";
    }
    if (bakeSlide) {
      stopRealtimeHoldAndAudio();
      if (typeof releaseVideoFileLock === "function") {
        await releaseVideoFileLock();
      }
    }

    try {
      const res = await fetch(`/api/site-brands/${slug}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          siteName: nextSiteName,
          manualBadge: nextManualBadge,
          primaryColor: nextPrimaryColor,
          propagateToBaseDomain,
          bakeSlide: Boolean(bakeSlide),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "사이트 브랜드 설정 저장 실패");

      if (propagateToBaseDomain) {
        Object.keys(scenarioDetailsCache).forEach((cachedSlug) => {
          if (cachedSlug !== slug) {
            delete scenarioDetailsCache[cachedSlug];
          }
        });
      }

      const curDetails = scenarioDetailsCache[slug];
      if (curDetails) {
        if (data.brand) curDetails.siteBrand = data.brand;
        if (data.baseDomain) curDetails.baseDomain = data.baseDomain;
        if (data.narration) {
          curDetails.narration = data.narration;
        } else if (curDetails.narration && data.brand) {
          curDetails.narration.siteBrand = data.brand;
          if (curDetails.narration.introToc) {
            curDetails.narration.introToc.badge = data.brand.manualBadge;
          }
        }
        if (data.editPlan) curDetails.editPlan = data.editPlan;
        if (data.moments) curDetails.moments = data.moments;
        syncScenarioTimelineInMemory(curDetails);
      }

      const overlayEl = document.getElementById("live-intro-toc-overlay");
      if (overlayEl) delete overlayEl.dataset.tocSig;

      await fetchScenarios();
      if (bakeSlide && curDetails) {
        await clearNarrationUnapplied();
        setVideoMode(curDetails.hasRenderedVideo && data.renderedVideoUpdated ? currentVideoMode : "raw", curDetails);
      } else {
        markNarrationUnapplied(
          "사이트 브랜드(테마 색상·기관명·매뉴얼 배지)가 수정되었습니다. 오프닝 슬라이드 영상에 반영하려면 [지금 영상에 즉시 반영]을 눌러주세요.",
          { needsSlideBake: true }
        );
      }
      renderNarrationStudio(curDetails);
      renderTimelineVisual(curDetails);
      renderMomentsStepList(curDetails);
      updateVideoProgressUI();
      updateJsonViewer("narration");
    } catch (err) {
      alert(`사이트 브랜드 저장 오류: ${err.message}`);
    } finally {
      if (saveBtn) saveBtn.disabled = false;
      if (bakeBtn) {
        bakeBtn.disabled = false;
        bakeBtn.textContent = "🎬 저장 후 오프닝 슬라이드 즉시 재합성";
      }
    }
  };

  const saveBtn = barEl.querySelector("#btn-save-site-brand");
  if (saveBtn) {
    saveBtn.addEventListener("click", () => handleSaveBrand(false));
  }
  const saveBakeBtn = barEl.querySelector("#btn-save-and-bake-site-brand");
  if (saveBakeBtn) {
    saveBakeBtn.addEventListener("click", () => handleSaveBrand(true));
  }
}

function renderIntroTocEditor(details, narration) {
  const editorEl = document.getElementById("narration-intro-toc-editor");
  if (!editorEl) return;

  if (!narration || !Array.isArray(narration.cues) || narration.cues.length === 0) {
    editorEl.classList.add("hidden");
    editorEl.innerHTML = "";
    return;
  }

  const showToc = narration.showIntroToc !== false && narration.introToc?.enabled !== false;
  const tocDrawerBtn = document.getElementById("btn-toggle-intro-toc-drawer");
  if (!showToc) {
    editorEl.classList.add("hidden");
    if (tocDrawerBtn) tocDrawerBtn.classList.remove("active");
    return;
  }

  editorEl.classList.toggle("hidden", !isIntroTocDrawerOpen);
  if (tocDrawerBtn) {
    tocDrawerBtn.classList.toggle("active", isIntroTocDrawerOpen);
    tocDrawerBtn.textContent = isIntroTocDrawerOpen ? "📑 오프닝 목차 ▴" : "📑 오프닝 목차 ▾";
  }
  const toc = getEffectiveIntroToc(narration);
  narration.introToc = toc;
  const isBaked = Boolean(narration.introBakedIntoVideo);
  const bakedSec = ((narration.bakedIntroDurationMs || 0) / 1000).toFixed(1);
  const brandName = narration.siteBrand?.siteName || "";

  const itemsHtml = (toc.items || [])
    .map(
      (item, idx) => `
      <div class="intro-toc-item-row" data-toc-idx="${idx}">
        <span style="font-size:11.5px;font-weight:800;color:#0078ff;font-family:var(--font-mono);min-width:26px;text-align:center;">${String(
          idx + 1
        ).padStart(2, "0")}</span>
        <input type="text" class="toc-item-title-input" value="${escapeHtmlAttr(
          item.title || ""
        )}" placeholder="소제목 (예: 웹·전용 앱 접속 및 로그인)" style="width:200px;padding:5px 8px;font-size:12px;font-weight:700;" />
        <input type="text" class="toc-item-desc-input" value="${escapeHtmlAttr(
          item.description || ""
        )}" placeholder="목차 개요 (예: 웹 접속 방법과 PC·모바일 전용 앱의 설치 및 로그인 방법을 소개합니다.)" style="flex:1;min-width:220px;padding:5px 10px;font-size:12px;" />
        <button type="button" class="btn btn-sm btn-outline btn-delete-toc-item" title="목차 항목 삭제" style="padding:3px 7px;font-size:11px;color:var(--fail);">✕</button>
      </div>`
    )
    .join("");

  editorEl.innerHTML = `
    <div class="intro-toc-editor-header">
      <div class="intro-toc-editor-title" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
        <span>📑 사이트 맞춤형 마스터 오프닝 목차(Contents) 슬라이드 편집</span>
        ${
          isBaked
            ? `<span class="status-tag status-tag-rendered" style="font-size:10.5px;padding:2px 7px;">✅ 녹화본 앞단 영상 합성 완료 (${bakedSec}s${
                brandName ? ` · ${escapeHtmlAttr(brandName)}` : ""
              })</span>`
            : `<span class="status-tag status-tag-raw" style="font-size:10.5px;padding:2px 7px;">💡 [🎬 슬라이드 영상에 반영] 클릭 시 녹화본 앞단에 즉시 합성</span>`
        }
      </div>
      <div style="display:inline-flex;align-items:center;gap:6px;">
        <button type="button" class="btn btn-sm btn-outline" id="btn-bake-intro-toc" title="수정한 목차 슬라이드와 오프닝 음성을 녹화본(recording.mp4) 앞단에 1~2초 만에 즉시 재합성합니다" style="padding:3px 9px;font-size:11px;border-color:var(--accent);color:var(--accent);font-weight:700;">🎬 슬라이드 영상에 반영</button>
        <button type="button" class="btn btn-sm btn-outline" id="btn-preview-intro-toc" title="비디오를 오프닝 시점(0.1초)으로 이동하여 목차 슬라이드를 확인합니다" style="padding:3px 8px;font-size:11px;">👁️ 오프닝 구간 이동</button>
        <button type="button" class="btn btn-sm btn-outline" id="btn-add-intro-toc-item" title="Contents 목차 항목을 추가합니다" style="padding:3px 8px;font-size:11px;">➕ 목차 항목 추가</button>
      </div>
    </div>
    <div class="intro-toc-meta-row">
      <input type="text" id="toc-badge-input" value="${escapeHtmlAttr(
        toc.badge
      )}" placeholder="좌측 표지 타이틀 (예: 그룹웨어 사용 매뉴얼)" title="슬라이드 좌측 표지 타이틀" style="width:170px;padding:5px 8px;font-size:12px;" />
      <input type="text" id="toc-title-input" value="${escapeHtmlAttr(
        toc.title
      )}" placeholder="교육 제목 (예: 그룹웨어 접속 및 기본 화면 안내)" title="Contents 슬라이드 메인 제목" style="width:280px;padding:5px 8px;font-size:12px;font-weight:700;" />
      <input type="text" id="toc-summary-input" value="${escapeHtmlAttr(
        toc.summary
      )}" placeholder="1줄 부제 (예: 그룹웨어 접속 및 기본 화면을 안내합니다.)" title="슬라이드 제목 하단 1줄 부제 (구어체 대본 금지)" style="flex:1;min-width:220px;padding:5px 8px;font-size:12px;" />
    </div>
    <div class="intro-toc-items-list" id="intro-toc-items-list">
      ${itemsHtml}
    </div>
  `;

  const syncTocEdits = () => {
    const updated = collectNarrationFromUI({ sortByStartTime: false });
    if (scenarioDetailsCache[selectedScenario]) {
      scenarioDetailsCache[selectedScenario].narration = updated;
      if (scenarioDetailsCache[selectedScenario].editPlan) {
        scenarioDetailsCache[selectedScenario].editPlan.narration = updated;
      }
    }
    const overlayEl = document.getElementById("live-intro-toc-overlay");
    if (overlayEl) {
      delete overlayEl.dataset.tocSig;
    }
    updateVideoProgressUI();
    updateJsonViewer("narration");
    markNarrationUnapplied(
      "오프닝 목차(Contents) 슬라이드 내용이 수정되었습니다. 영상 앞단에 반영하려면 [🎬 슬라이드 영상에 반영] 또는 [지금 영상에 즉시 반영]을 눌러주세요.",
      { needsSlideBake: true }
    );
    saveNarrationTimingQuick();
  };

  editorEl
    .querySelectorAll("#toc-badge-input, #toc-title-input, #toc-summary-input, .toc-item-title-input, .toc-item-desc-input")
    .forEach((inp) => {
      inp.addEventListener("input", syncTocEdits);
      inp.addEventListener("change", syncTocEdits);
    });

  editorEl.querySelectorAll(".btn-delete-toc-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      const row = btn.closest(".intro-toc-item-row");
      if (row) row.remove();
      syncTocEdits();
      renderIntroTocEditor(scenarioDetailsCache[selectedScenario], scenarioDetailsCache[selectedScenario]?.narration);
    });
  });

  const addBtn = editorEl.querySelector("#btn-add-intro-toc-item");
  if (addBtn) {
    addBtn.addEventListener("click", () => {
      const updated = collectNarrationFromUI({ sortByStartTime: false });
      if (!updated.introToc) updated.introToc = getEffectiveIntroToc(updated);
      updated.introToc.items.push({
        title: `주요 기능 ${updated.introToc.items.length + 1}`,
        description: "해당 기능의 주요 구성과 사용 방법을 안내합니다.",
      });
      if (scenarioDetailsCache[selectedScenario]) {
        scenarioDetailsCache[selectedScenario].narration = updated;
      }
      renderIntroTocEditor(scenarioDetailsCache[selectedScenario], updated);
      syncTocEdits();
    });
  }

  const bakeBtn = editorEl.querySelector("#btn-bake-intro-toc");
  if (bakeBtn) {
    bakeBtn.addEventListener("click", async () => {
      if (!selectedScenario) return;
      const slug = selectedScenario;
      const origTxt = bakeBtn.textContent;
      bakeBtn.disabled = true;
      bakeBtn.textContent = "⏳ 슬라이드 영상 합성 중...";
      stopRealtimeHoldAndAudio();
      if (typeof releaseVideoFileLock === "function") {
        await releaseVideoFileLock();
      }
      try {
        const updated = collectNarrationFromUI({ sortByStartTime: false });
        const res = await fetch(`/api/narration/${slug}/bake-slide`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ narration: updated }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "슬라이드 합성 실패");
        const details = scenarioDetailsCache[slug];
        if (details) {
          if (data.narration) details.narration = data.narration;
          if (data.editPlan) details.editPlan = data.editPlan;
          if (data.moments) details.moments = data.moments;
          syncScenarioTimelineInMemory(details);
        }
        window.__forcePreviewIntroToc = false;
        await clearNarrationUnapplied();
        setVideoMode("raw", details);
        renderNarrationStudio(details);
        renderTimelineVisual(details);
        renderMomentsStepList(details);
        updateJsonViewer("narration");
      } catch (err) {
        alert(`슬라이드 영상 합성 오류: ${err.message}`);
      } finally {
        bakeBtn.disabled = false;
        bakeBtn.textContent = origTxt || "🎬 슬라이드 영상에 반영";
      }
    });
  }

  const previewBtn = editorEl.querySelector("#btn-preview-intro-toc");
  if (previewBtn) {
    previewBtn.addEventListener("click", () => {
      if (videoPlayer) {
        stopRealtimeHoldAndAudio();
        videoPlayer.pause();
        window.__hideIntroTocPreview = false;
        window.__forcePreviewIntroToc = !narration.introBakedIntoVideo;
        videoPlayer.currentTime = 0.1;
        updateVideoProgressUI();
      }
    });
  }
}

function extractDynamicMergedChapters(details, narration) {
  const mergedSlugs = Array.isArray(narration?.mergedFromSlugs) ? narration.mergedFromSlugs : [];
  const cues = Array.isArray(narration?.cues) ? narration.cues : [];
  if (mergedSlugs.length === 0 || cues.length === 0) return [];

  const tocItems = Array.isArray(narration?.introToc?.items) ? narration.introToc.items : [];
  const moments = Array.isArray(details?.moments?.moments)
    ? details.moments.moments
    : Array.isArray(details?.moments)
    ? details.moments
    : [];

  const chapterStartCueIndices = [Math.min(2, cues.length - 1)];

  for (let i = 2; i < cues.length; i++) {
    const c = cues[i];
    const txt = String(c.text || "").trim();
    const isBridge =
      Boolean(c._isAutoBridgeCue) ||
      (/사용법에\s*대해\s*알아보겠습니다\.?$/.test(txt) && i + 1 < cues.length);
    if (isBridge && i + 1 < cues.length && chapterStartCueIndices.length < mergedSlugs.length) {
      chapterStartCueIndices.push(i + 1);
    }
  }

  if (chapterStartCueIndices.length < mergedSlugs.length && moments.length > 0) {
    for (let chIdx = chapterStartCueIndices.length; chIdx < mergedSlugs.length; chIdx++) {
      const m = moments.find((mm) =>
        String(mm.description || mm.action || "").includes(`[챕터 ${chIdx + 1}:`)
      );
      if (m) {
        const mStartMs = Number(m.timestamp ?? m.timestampMs ?? 0);
        const foundCueIdx = cues.findIndex(
          (c, cIdx) =>
            cIdx > chapterStartCueIndices[chapterStartCueIndices.length - 1] &&
            (c.videoStartMs ?? c.startMs ?? 0) >= mStartMs - 1500
        );
        if (foundCueIdx !== -1) {
          chapterStartCueIndices.push(foundCueIdx);
        }
      }
    }
  }

  const chapters = [];
  const firstChCueIdx = chapterStartCueIndices[0] || 0;
  if (firstChCueIdx > 0) {
    const masterEndCue = cues[firstChCueIdx - 1] || cues[0];
    chapters.push({
      chNum: 0,
      slug: "__master_intro__",
      shortTitle: "표지·통합목차",
      fullTitle: "그룹웨어 사용 매뉴얼 표지 및 전체 통합 목차(Master Contents)",
      startCueIdx: 0,
      endCueIdx: firstChCueIdx - 1,
      startMs: cues[0]?.startMs ?? 0,
      videoStartMs: cues[0]?.videoStartMs ?? 0,
      endMs: masterEndCue?.endMs ?? 29000,
    });
  }

  mergedSlugs.forEach((slug, idx) => {
    const startCueIdx =
      chapterStartCueIndices[idx] !== undefined
        ? chapterStartCueIndices[idx]
        : Math.min(cues.length - 1, Math.floor(((idx + 1) * cues.length) / (mergedSlugs.length + 1)));
    const nextStartCueIdx =
      idx + 1 < mergedSlugs.length && chapterStartCueIndices[idx + 1] !== undefined
        ? chapterStartCueIndices[idx + 1]
        : cues.length;
    const endCueIdx = Math.max(startCueIdx, nextStartCueIdx - 1);
    const startCue = cues[startCueIdx] || cues[0];
    const endCue = cues[endCueIdx] || startCue;

    const tocItem = tocItems[idx] || {};
    const rawTocTitle = stripVersionAndConversationalTextJS(tocItem.title || "");
    const rawTocDesc = stripVersionAndConversationalTextJS(tocItem.description || "");
    let fullTitle =
      rawTocTitle && !/^(?:단계|주요\s*단계|챕터)\s*\d*$/.test(rawTocTitle)
        ? rawTocTitle
        : rawTocDesc && rawTocDesc.length <= 42
        ? rawTocDesc
        : "";

    if (!fullTitle && startCue?.text) {
      const mTitle = String(startCue.text)
        .trim()
        .match(/^(.+?)\s*(?:기능은|에서는|화면에서는|모듈은|메뉴는)/);
      if (mTitle && mTitle[1] && mTitle[1].length <= 36) {
        fullTitle = mTitle[1].trim();
      }
    }
    if (!fullTitle) fullTitle = slug;

    const shortTitle =
      fullTitle
        .replace(/^그룹웨어\s*/, "")
        .replace(/\s*(?:사용법|매뉴얼|가이드|안내)$/, "")
        .trim() || fullTitle;

    chapters.push({
      chNum: idx + 1,
      slug,
      shortTitle: shortTitle.length > 28 ? `${shortTitle.slice(0, 27)}…` : shortTitle,
      fullTitle,
      startCueIdx,
      endCueIdx,
      startMs: startCue?.startMs ?? 0,
      videoStartMs: startCue?.videoStartMs ?? startCue?.startMs ?? 0,
      endMs: endCue?.endMs ?? (startCue?.startMs ?? 0) + 5000,
    });
  });

  return chapters;
}

async function handleRebuildMergedScenario(mergedSlugs) {
  if (!selectedScenario || !Array.isArray(mergedSlugs) || mergedSlugs.length < 2) return;
  const targetSlug = selectedScenario;
  const confirmed = await showAppConfirm(
    `원본 챕터 시나리오(${mergedSlugs.join(" → ")})의 최신 영상과 대본을 기반으로 '${targetSlug}' 병합 시나리오를 처음부터 다시 빌드하시겠습니까?\n\n(수정한 통합 목차 및 각 챕터의 최신 렌더링본이 결합됩니다.)`
  );
  if (!confirmed) return;

  const btn = document.getElementById("btn-rebuild-merged-from-chapters");
  const origTxt = btn ? btn.textContent : "";
  if (btn) {
    btn.disabled = true;
    btn.textContent = "⏳ 원본 챕터 병합 재빌드 중...";
  }
  stopRealtimeHoldAndAudio();
  if (typeof releaseVideoFileLock === "function") {
    await releaseVideoFileLock();
  }
  try {
    const res = await fetch("/api/video-edit/merge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slugs: mergedSlugs,
        outputSlug: targetSlug,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "병합 시나리오 재빌드 실패");
    delete scenarioDetailsCache[targetSlug];
    await fetchScenarios();
    await selectScenario(targetSlug);
  } catch (err) {
    alert(`병합본 재빌드 오류: ${err.message}`);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = origTxt || "🔄 원본 챕터로 병합본 재빌드";
    }
  }
}

function renderNarrationStudio(details, focusIndex = null) {
  const container = document.getElementById("narration-cues-container");
  const chapterTabsBar = document.getElementById("narration-chapter-tabs-bar");
  const tocEditorEl = document.getElementById("narration-intro-toc-editor");
  const statusBadge = document.getElementById("narration-status-badge");
  const styleSelect = document.getElementById("narration-style-select");
  const voiceSelect = document.getElementById("narration-voice-select");
  const pitchSelect = document.getElementById("narration-pitch-select");
  const rateSelect = document.getElementById("narration-rate-select");
  const enabledToggle = document.getElementById("narration-enabled-toggle");
  const subtitleToggle = document.getElementById("narration-subtitle-toggle");
  const tocToggle = document.getElementById("narration-toc-toggle");

  if (!container) return;

  syncScenarioTimelineInMemory(details);

  const narration = details?.narration || details?.editPlan?.narration || null;
  renderSiteBrandBar(details, narration);

  if (!narration || !Array.isArray(narration.cues) || narration.cues.length === 0) {
    if (tocEditorEl) {
      tocEditorEl.classList.add("hidden");
      tocEditorEl.innerHTML = "";
    }
    if (chapterTabsBar) {
      chapterTabsBar.classList.add("hidden");
      chapterTabsBar.innerHTML = "";
    }
    if (statusBadge) {
      statusBadge.textContent = "대본 없음";
      statusBadge.style.background = "var(--neutral-soft)";
      statusBadge.style.color = "var(--neutral)";
    }
    container.innerHTML = `
      <div class="studio-empty-box">
        상단에서 <strong>말투(문체)</strong>와 <strong>음성/억양 톤</strong>을 선택한 뒤 <strong>[✨ AI 대본(오프닝 포함) 생성 &amp; 음성 합성]</strong>을 누르면, 영상 시작 시 매뉴얼 구성 목차와 단계별 나레이션이 자동 생성됩니다.
      </div>
    `;
    return;
  }

  if (styleSelect && narration.style) styleSelect.value = narration.style;
  if (voiceSelect && narration.voice) voiceSelect.value = narration.voice;
  if (pitchSelect && narration.pitch) pitchSelect.value = narration.pitch;
  if (rateSelect && narration.rate) rateSelect.value = narration.rate;
  if (enabledToggle) enabledToggle.checked = narration.enabled !== false;
  if (subtitleToggle) subtitleToggle.checked = narration.showSubtitles !== false;
  if (tocToggle) {
    tocToggle.checked = narration.showIntroToc !== false && narration.introToc?.enabled !== false;
  }
  updateVoiceOptionsSummaryUI();

  renderIntroTocEditor(details, narration);

  const mergedChapters = extractDynamicMergedChapters(details, narration);
  const chapterStartMap = new Map();
  mergedChapters.forEach((ch) => {
    if (ch.chNum >= 1) {
      chapterStartMap.set(ch.startCueIdx, ch);
    }
  });

  if (chapterTabsBar) {
    if (mergedChapters.length > 0) {
      chapterTabsBar.classList.remove("hidden");
      const curPlayMs = videoPlayer && Number.isFinite(videoPlayer.currentTime) ? videoPlayer.currentTime * 1000 : 0;
      const tabsHtml = mergedChapters
        .map((ch, idx) => {
          const nextCh = idx + 1 < mergedChapters.length ? mergedChapters[idx + 1] : null;
          const nextCompStartMs = nextCh ? nextCh.startMs : 999999999;
          const isInitiallyActive = curPlayMs >= ch.startMs - 150 && curPlayMs < nextCompStartMs - 150;
          const startSec = ((ch.startMs || 0) / 1000).toFixed(1);
          const cueRange = `#${ch.startCueIdx + 1}~#${ch.endCueIdx + 1}`;
          const compactTitle = ch.shortTitle.length > 12 ? `${ch.shortTitle.slice(0, 11)}…` : ch.shortTitle;
          if (ch.chNum === 0) {
            return `
              <button type="button" class="narration-chapter-tab${isInitiallyActive ? " active" : ""}" data-ch-num="0" data-start-cue="${ch.startCueIdx}" data-end-cue="${ch.endCueIdx}" data-comp-start-ms="${ch.startMs}" data-next-comp-start-ms="${nextCompStartMs}" data-start-ms="${ch.startMs}" data-video-start-ms="${ch.videoStartMs}" data-end-ms="${ch.endMs}" title="${escapeHtmlAttr(ch.fullTitle)} (${cueRange} · ${startSec}s~)">
                <span class="ch-badge">🎬 오프닝</span>
                <span class="ch-meta">${cueRange}</span>
              </button>`;
          }
          return `
            <button type="button" class="narration-chapter-tab${isInitiallyActive ? " active" : ""}" data-ch-num="${ch.chNum}" data-start-cue="${ch.startCueIdx}" data-end-cue="${ch.endCueIdx}" data-comp-start-ms="${ch.startMs}" data-next-comp-start-ms="${nextCompStartMs}" data-start-ms="${ch.startMs}" data-video-start-ms="${ch.videoStartMs}" data-end-ms="${ch.endMs}" title="Ch.${ch.chNum} [${escapeHtmlAttr(ch.slug)}] ${escapeHtmlAttr(ch.fullTitle)} (${cueRange} · ${startSec}s~)">
              <span class="ch-badge">Ch.${ch.chNum}</span>
              <span>${escapeHtmlAttr(compactTitle)}</span>
              <span class="ch-meta">${cueRange}</span>
            </button>`;
        })
        .join("");

      chapterTabsBar.innerHTML = `
        <div class="narration-chapter-tabs-list">
          ${tabsHtml}
          <button type="button" class="btn btn-sm btn-outline" id="btn-rebuild-merged-from-chapters" title="원본 챕터 시나리오들의 최신 영상·대본을 다시 불러와 병합 시나리오를 재빌드합니다" style="margin-left:auto;padding:2px 8px;font-size:10.5px;font-weight:700;height:24px;">🔄 병합본 재빌드</button>
        </div>
      `;

      const isMergedScenario = Array.isArray(narration?.mergedFromSlugs) && narration.mergedFromSlugs.length > 0;
      chapterTabsBar.querySelectorAll(".narration-chapter-tab").forEach((tabBtn) => {
        tabBtn.addEventListener("click", () => {
          chapterTabsBar.querySelectorAll(".narration-chapter-tab").forEach((b) => b.classList.remove("active"));
          tabBtn.classList.add("active");

          const startCueIdx = Number(tabBtn.dataset.startCue || 0);
          const startMs = Number(tabBtn.dataset.compStartMs ?? tabBtn.dataset.startMs ?? 0);
          const videoStartMs = Number(tabBtn.dataset.videoStartMs || startMs);

          if (videoPlayer && videoPlayer.duration) {
            stopRealtimeHoldAndAudio();
            const targetSec =
              currentVideoMode === "rendered" || isMergedScenario ? startMs / 1000 : videoStartMs / 1000;
            realtimeHoldState.isProgrammaticSeek = true;
            videoPlayer.currentTime = Math.max(0, Math.min(targetSec, (videoPlayer.duration || targetSec) - 0.1));
            updateVideoProgressUI();
            chapterTabsBar.querySelectorAll(".narration-chapter-tab").forEach((b) => b.classList.toggle("active", b === tabBtn));
          }
          scrollTimelineToCompMs(startMs, true);

          const targetDivider = container.querySelector(`.narration-chapter-divider[data-start-cue="${startCueIdx}"]`);
          const targetRow = container.querySelector(`.narration-cue-row[data-orig-idx="${startCueIdx}"]`);
          const scrollEl = targetDivider || targetRow;
          if (scrollEl) {
            scrollEl.scrollIntoView({ behavior: "smooth", block: "start" });
          }
          if (targetRow) {
            targetRow.classList.remove("cue-flash-highlight");
            void targetRow.offsetWidth;
            targetRow.classList.add("cue-flash-highlight");
          }
        });
      });

      const rebuildBtn = chapterTabsBar.querySelector("#btn-rebuild-merged-from-chapters");
      if (rebuildBtn) {
        rebuildBtn.addEventListener("click", () => {
          handleRebuildMergedScenario(narration.mergedFromSlugs);
        });
      }
    } else {
      chapterTabsBar.classList.add("hidden");
      chapterTabsBar.innerHTML = "";
    }
  }

  const styleLabels = {
    manual: "📘 정석 매뉴얼",
    friendly: "😊 친절 가이드",
    presentation: "🎙️ 시연 발표",
    compact: "⚡ 핵심 브리핑",
  };
  const styleBadgeText = styleLabels[narration.style || "manual"] || "📘 정석 매뉴얼";
  const totalHoldMs = narration.cues.reduce((acc, c) => acc + Math.max(0, Number(c.effectiveDeltaMs || 0)), 0);

  if (statusBadge) {
    statusBadge.textContent = `${narration.cues.length}구간`;
    statusBadge.style.background = "var(--ok-soft)";
    statusBadge.style.color = "var(--ok)";
  }

  container.innerHTML = "";
  const isMergedScenario = Array.isArray(narration?.mergedFromSlugs) && narration.mergedFromSlugs.length > 0;

  narration.cues.forEach((cue, idx) => {
    const chapterStartInfo = chapterStartMap.get(idx);
    if (chapterStartInfo) {
      const divider = document.createElement("div");
      divider.className = "narration-chapter-divider";
      divider.dataset.startCue = String(idx);
      const chStartSec = ((chapterStartInfo.startMs || 0) / 1000).toFixed(1);
      const chEndSec = ((chapterStartInfo.endMs || 0) / 1000).toFixed(1);
      divider.innerHTML = `
        <div class="narration-chapter-divider-left">
          <span class="narration-chapter-divider-tag">CHAPTER ${String(chapterStartInfo.chNum).padStart(2, "0")}</span>
          <span class="narration-chapter-divider-title">${escapeHtmlAttr(chapterStartInfo.fullTitle)}</span>
          <span class="narration-chapter-divider-meta">(${escapeHtmlAttr(chapterStartInfo.slug)})</span>
        </div>
        <div class="narration-chapter-divider-left">
          <span class="narration-chapter-divider-meta">구간 #${chapterStartInfo.startCueIdx + 1} ~ #${chapterStartInfo.endCueIdx + 1} (${chStartSec}s ~ ${chEndSec}s)</span>
          <button type="button" class="btn btn-sm btn-outline btn-jump-chapter-start" style="padding:2px 8px;font-size:11px;">▶ 챕터 시작점 이동</button>
        </div>
      `;
      const jumpChBtn = divider.querySelector(".btn-jump-chapter-start");
      if (jumpChBtn) {
        jumpChBtn.addEventListener("click", () => {
          const tabBtn = chapterTabsBar?.querySelector(
            `.narration-chapter-tab[data-ch-num="${chapterStartInfo.chNum}"]`
          );
          if (tabBtn) tabBtn.click();
        });
      }
      container.appendChild(divider);
    }

    const isBridgeCue = Boolean(
      cue._isAutoBridgeCue ||
        (idx >= 2 && /사용법에\s*대해\s*알아보겠습니다\.?$/.test(String(cue.text || "").trim()))
    );
    const isOpeningCue = isMergedScenario
      ? Boolean(idx <= 1 || chapterStartMap.has(idx))
      : Boolean(!isBridgeCue && (cue.isIntro || (idx === 0 && (cue.videoStartMs ?? cue.startMs ?? 0) <= 600)));

    const row = document.createElement("div");
    row.className = "narration-cue-row";
    row.dataset.origIdx = String(idx);
    row.dataset.isIntro = isOpeningCue ? "true" : "false";
    row.dataset.isAutoBridgeCue = isBridgeCue ? "true" : "false";
    row.dataset.extraHoldMs = String(cue.extraHoldMs || 0);
    row.dataset.compStartMs = String(cue.startMs || 0);
    row.dataset.compEndMs = String(cue.endMs || 0);
    row.dataset.lastSyncedText = String(cue.text || "").trim();

    const anchorSec = ((cue.videoStartMs ?? cue.startMs ?? 0) / 1000).toFixed(1);
    const compStartSec = ((cue.startMs || 0) / 1000).toFixed(1);
    const compEndSec = ((cue.endMs || 0) / 1000).toFixed(1);
    const audioFileName = cue.audioFile ? cue.audioFile.split("/").pop() : null;
    const extraHoldMs = Number(cue.extraHoldMs || 0);

    row.innerHTML = `
      <span style="font-size: 0.78em; font-weight: 700; color: var(--accent); min-width: 24px; font-family: var(--font-mono);">#${idx + 1}</span>
      ${
        isBridgeCue
          ? `<span class="status-tag status-tag-rendered" title="다음 챕터 세부 목차 슬라이드로 전환하는 브릿지 안내 멘트" style="font-size: 0.7em; padding: 2px 6px;">🔗 전환</span>`
          : isOpeningCue
          ? `<span class="status-tag status-tag-eye" title="영상 시작 시 어떤 매뉴얼인지 안내하는 오프닝 소개 구간" style="font-size: 0.7em; padding: 2px 6px;">🎬 오프닝</span>`
          : ""
      }
      <input type="number" step="0.1" min="0" class="cue-start-input" value="${anchorSec}" title="원본 녹화 영상 기준 동작 시점(초) — 변경 시 시간순으로 자동 정렬 및 전체 싱크가 재계산됩니다"
        style="width: 54px; padding: 5px 4px; border-radius: 4px; font-size: 0.8em; text-align: center; font-family: var(--font-mono); flex-shrink: 0;" />
      <span style="font-size: 0.75em; color: var(--accent); min-width: 72px; cursor: pointer; font-family: var(--font-mono); font-weight: 600; white-space: nowrap; flex-shrink: 0;" class="cue-jump-time" title="클릭하여 비디오 해당 구간으로 이동 (실제 동기화 재생 구간: ${compStartSec}s ~ ${compEndSec}s)">➔ ${compStartSec}~${compEndSec}s</span>
      <input type="text" class="cue-text-input" value="${(cue.text || "").replace(/"/g, "&quot;")}" placeholder="나레이션 대본 문장을 입력하세요 (길어져도 음성 속도가 빨라지지 않고 화면 구간이 자동 연장됩니다)"
        style="flex: 1 1 0%; min-width: 0; width: 100%; padding: 6px 10px; border-radius: 4px; font-size: 0.88em;" />
      <span class="cue-sync-badge-wrap" style="flex-shrink: 0;">${buildCueSyncBadgeHtml(cue)}</span>
      <div class="cue-row-primary-actions">
        ${
          audioFileName
            ? `<button type="button" class="btn btn-sm btn-outline btn-play-cue" title="합성된 음성 미리듣기">▶</button>`
            : ""
        }
        <button type="button" class="btn btn-sm btn-outline btn-delete-cue" title="구간 삭제">✕</button>
      </div>
      <div class="cue-floating-toolbar" title="구간 홀드(늘리기/줄이기) 및 앞·뒤 행 추가">
        <div class="cue-stretch-controls">
          <button type="button" class="btn-cue-stretch stretch-minus" data-stretch="-500" title="구간 0.5초 줄이기 (대본 음성 길이 이하로는 줄어들지 않음)">-0.5s</button>
          <button type="button" class="btn-cue-stretch stretch-plus" data-stretch="500" title="구간 0.5초 늘리기 (화면 홀드 연장)">+0.5s</button>
          <button type="button" class="btn-cue-stretch stretch-plus" data-stretch="1000" title="구간 1.0초 늘리기 (화면 홀드 연장)">+1.0s</button>
          ${
            extraHoldMs !== 0
              ? `<button type="button" class="btn-cue-stretch stretch-reset" data-stretch="reset" title="수동 늘리기/줄이기 초기화 (0.0s)">초기화</button>`
              : ""
          }
        </div>
        <span class="cue-floating-sep"></span>
        <button type="button" class="btn-cue-float-action btn-insert-cue-before" title="이 구간 바로 위(이전 시점)에 새 대본 구간 끼워넣기">+위 추가</button>
        <button type="button" class="btn-cue-float-action btn-insert-cue-after" title="이 구간 바로 아래(다음 시점)에 새 대본 구간 끼워넣기">+아래 추가</button>
      </div>
    `;

    const startInput = row.querySelector(".cue-start-input");
    if (startInput) {
      startInput.addEventListener("change", () => {
        const updated = collectNarrationFromUI({ sortByStartTime: true });
        if (scenarioDetailsCache[selectedScenario]) {
          scenarioDetailsCache[selectedScenario].narration = updated;
          syncScenarioTimelineInMemory(scenarioDetailsCache[selectedScenario]);
        }
        renderNarrationStudio(scenarioDetailsCache[selectedScenario]);
        renderTimelineVisual(scenarioDetailsCache[selectedScenario]);
        markNarrationUnapplied("대본 시작 시점(초)이 변경되었습니다. 최종 영상 파일에 반영하려면 [지금 영상에 즉시 반영]을 눌러주세요.");
        saveNarrationTimingQuick();
      });
    }

    const textInput = row.querySelector(".cue-text-input");
    if (textInput) {
      textInput.addEventListener("input", () => {
        // 1) Instant 0ms preview of auto-hold & subsequent cue sync while typing
        const updated = collectNarrationFromUI({ sortByStartTime: false });
        if (scenarioDetailsCache[selectedScenario]) {
          scenarioDetailsCache[selectedScenario].narration = updated;
          syncScenarioTimelineInMemory(scenarioDetailsCache[selectedScenario]);
          const allRows = container.querySelectorAll(".narration-cue-row");
          scenarioDetailsCache[selectedScenario].narration.cues.forEach((sc, sIdx) => {
            const rEl = allRows[sIdx];
            if (!rEl) return;
            rEl.dataset.compStartMs = String(sc.startMs || 0);
            rEl.dataset.compEndMs = String(sc.endMs || 0);
            const jEl = rEl.querySelector(".cue-jump-time");
            if (jEl) {
              const cs = ((sc.startMs || 0) / 1000).toFixed(1);
              const ce = ((sc.endMs || 0) / 1000).toFixed(1);
              jEl.textContent = `➔ ${cs}~${ce}s`;
            }
            const bWrap = rEl.querySelector(".cue-sync-badge-wrap");
            if (bWrap) bWrap.innerHTML = buildCueSyncBadgeHtml(sc);
          });
          renderTimelineVisual(scenarioDetailsCache[selectedScenario]);
        }
        // 2) Automatically synthesize modified cue via Edge-TTS & lock in exact audio duration + video length after 850ms idle
        const newVal = textInput.value.trim();
        if (newVal && newVal !== row.dataset.lastSyncedText) {
          scheduleAutoSynthesizeAndFit(idx, 850);
        }
      });

      textInput.addEventListener("change", () => {
        const newVal = textInput.value.trim();
        if (newVal && newVal !== row.dataset.lastSyncedText) {
          runAutoSynthesizeAndFitNow(idx);
        }
      });

      textInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          const newVal = textInput.value.trim();
          if (newVal && newVal !== row.dataset.lastSyncedText) {
            runAutoSynthesizeAndFitNow(idx);
          }
          textInput.blur();
        }
      });
    }

    row.querySelectorAll(".btn-cue-stretch").forEach((btn) => {
      btn.addEventListener("click", () => {
        const action = btn.getAttribute("data-stretch");
        const curExtra = Number(row.dataset.extraHoldMs || 0);
        const nextExtra = action === "reset" ? 0 : Math.max(-5000, Math.min(30000, curExtra + Number(action || 0)));
        row.dataset.extraHoldMs = String(nextExtra);

        const updated = collectNarrationFromUI({ sortByStartTime: false });
        if (scenarioDetailsCache[selectedScenario]) {
          scenarioDetailsCache[selectedScenario].narration = updated;
          syncScenarioTimelineInMemory(scenarioDetailsCache[selectedScenario]);
        }
        renderNarrationStudio(scenarioDetailsCache[selectedScenario]);
        renderTimelineVisual(scenarioDetailsCache[selectedScenario]);
        updateJsonViewer("narration");
        markNarrationUnapplied("구간 홀드(늘리기/줄이기) 길이가 변경되었습니다. 최종 영상에 확정하려면 [지금 영상에 즉시 반영]을 눌러주세요.");
        saveNarrationTimingQuick();
      });
    });

    const jumpEl = row.querySelector(".cue-jump-time");
    if (jumpEl) {
      jumpEl.addEventListener("click", () => {
        const compStartMs = Number(row.dataset.compStartMs) || 0;
        if (videoPlayer && videoPlayer.duration) {
          stopRealtimeHoldAndAudio();
          const rawStartSec = Number(row.querySelector(".cue-start-input").value) || 0;
          const targetSec =
            currentVideoMode === "rendered" || isMergedScenario ? compStartMs / 1000 : rawStartSec;
          if (currentVideoMode === "raw" && !isMergedScenario) {
            syncCompletedHoldRegionsForSeek(rawStartSec, Math.max(0, compStartMs - 150));
          }
          realtimeHoldState.isProgrammaticSeek = true;
          videoPlayer.currentTime = targetSec;
          realtimeHoldState.isProgrammaticResume = true;
          videoPlayer.play().catch(() => {
            realtimeHoldState.isProgrammaticResume = false;
          });
        }
        scrollTimelineToCompMs(compStartMs, true);
      });
    }

    const insertBeforeBtn = row.querySelector(".btn-insert-cue-before");
    if (insertBeforeBtn) {
      insertBeforeBtn.addEventListener("click", () => {
        insertNarrationCueRelative(idx, "before");
      });
    }

    const insertAfterBtn = row.querySelector(".btn-insert-cue-after");
    if (insertAfterBtn) {
      insertAfterBtn.addEventListener("click", () => {
        insertNarrationCueRelative(idx, "after");
      });
    }

    const playBtn = row.querySelector(".btn-play-cue");
    if (playBtn && audioFileName) {
      playBtn.addEventListener("click", () => {
        if (activePreviewAudio) {
          activePreviewAudio.pause();
          activePreviewAudio = null;
        }
        const url = `/api/narration/audio/${selectedScenario}/${audioFileName}?t=${Date.now()}`;
        activePreviewAudio = new Audio(url);
        activePreviewAudio.play().catch((err) => console.warn("오디오 재생 실패:", err));
      });
    }

    const delBtn = row.querySelector(".btn-delete-cue");
    if (delBtn) {
      delBtn.addEventListener("click", () => {
        row.remove();
        const updated = collectNarrationFromUI();
        if (scenarioDetailsCache[selectedScenario]) {
          scenarioDetailsCache[selectedScenario].narration = updated;
          syncScenarioTimelineInMemory(scenarioDetailsCache[selectedScenario]);
        }
        renderNarrationStudio(scenarioDetailsCache[selectedScenario]);
        renderTimelineVisual(scenarioDetailsCache[selectedScenario]);
        markNarrationUnapplied("대본 구간이 삭제되었습니다. 영상 및 음성 싱크를 확정하려면 [지금 영상에 즉시 반영]을 눌러주세요.");
        saveNarrationTimingQuick();
      });
    }

    container.appendChild(row);
  });

  if (focusIndex !== null) {
    const targetRows = container.querySelectorAll(".narration-cue-row");
    const targetRow = targetRows[focusIndex];
    if (targetRow) {
      targetRow.scrollIntoView({ behavior: "smooth", block: "nearest" });
      const textInput = targetRow.querySelector(".cue-text-input");
      if (textInput) {
        textInput.focus();
        textInput.select();
      }
    }
  }
}

function collectNarrationFromUI(options = {}) {
  const details = scenarioDetailsCache[selectedScenario];
  const existing = details?.narration || details?.editPlan?.narration || {};
  const styleSelect = document.getElementById("narration-style-select");
  const voiceSelect = document.getElementById("narration-voice-select");
  const pitchSelect = document.getElementById("narration-pitch-select");
  const rateSelect = document.getElementById("narration-rate-select");
  const enabledToggle = document.getElementById("narration-enabled-toggle");
  const subtitleToggle = document.getElementById("narration-subtitle-toggle");
  const tocToggle = document.getElementById("narration-toc-toggle");
  const rows = document.querySelectorAll("#narration-cues-container .narration-cue-row");

  const rawCues = [];
  rows.forEach((row, idx) => {
    const startSec = parseFloat(row.querySelector(".cue-start-input")?.value || "0");
    const text = (row.querySelector(".cue-text-input")?.value || "").trim();
    if (!text) return;
    const origIdx = Number(row.dataset.origIdx ?? idx);
    const prevCue = existing.cues?.[origIdx] || {};
    const videoStartMs = Math.max(0, Math.round(startSec * 1000));
    const textUnchanged = prevCue.text === text;
    const estDurMs = textUnchanged && prevCue.audioDurationMs ? prevCue.audioDurationMs : Math.max(1800, text.length * 145);
    const extraHoldMs = Number(row.dataset.extraHoldMs ?? prevCue.extraHoldMs ?? 0);
    const isAutoBridgeCue = row.dataset.isAutoBridgeCue === "true" || Boolean(prevCue._isAutoBridgeCue);
    rawCues.push({
      videoStartMs,
      startMs: videoStartMs,
      endMs: videoStartMs + estDurMs,
      text,
      isIntro: row.dataset.isIntro === "true" || prevCue.isIntro || false,
      ...(isAutoBridgeCue ? { _isAutoBridgeCue: true } : {}),
      extraHoldMs,
      audioFile: textUnchanged ? prevCue.audioFile : undefined,
      audioDurationMs: textUnchanged ? prevCue.audioDurationMs : undefined,
      _ttsSig: textUnchanged ? prevCue._ttsSig : undefined,
    });
  });

  if (options.sortByStartTime) {
    rawCues.sort((a, b) => a.videoStartMs - b.videoStartMs);
  }

  const cues = rawCues.map((c, i) => ({
    ...c,
    id: i + 1,
  }));

  const showIntroToc = tocToggle ? tocToggle.checked : existing.showIntroToc ?? true;
  const tocEditorEl = document.getElementById("narration-intro-toc-editor");
  let introToc = existing.introToc ? { ...existing.introToc, enabled: showIntroToc } : undefined;
  if (tocEditorEl && showIntroToc && tocEditorEl.querySelector("#toc-title-input")) {
    const badgeVal = (tocEditorEl.querySelector("#toc-badge-input")?.value || "").trim();
    const titleVal = (tocEditorEl.querySelector("#toc-title-input")?.value || "").trim();
    const summaryVal = (tocEditorEl.querySelector("#toc-summary-input")?.value || "").trim();
    const itemRows = tocEditorEl.querySelectorAll(".intro-toc-item-row");
    const items = [];
    itemRows.forEach((r) => {
      const t = (r.querySelector(".toc-item-title-input")?.value || "").trim();
      const d = (r.querySelector(".toc-item-desc-input")?.value || "").trim();
      if (t || d) {
        items.push({ title: t || "주요 단계", description: d || "" });
      }
    });
    const fallbackToc = deriveDefaultIntroToc({ ...existing, cues });
    introToc = {
      enabled: showIntroToc,
      badge: badgeVal || fallbackToc.badge,
      title: titleVal || fallbackToc.title,
      summary: summaryVal || fallbackToc.summary,
      items: items.length > 0 ? items : fallbackToc.items,
    };
  }

  return {
    slug: selectedScenario,
    style: styleSelect ? styleSelect.value : existing.style || "manual",
    voice: voiceSelect ? voiceSelect.value : existing.voice || "ko-KR-SunHiNeural",
    pitch: pitchSelect ? pitchSelect.value : existing.pitch || "+0Hz",
    rate: rateSelect ? rateSelect.value : existing.rate || "+5%",
    enabled: enabledToggle ? enabledToggle.checked : true,
    showSubtitles: subtitleToggle ? subtitleToggle.checked : true,
    showIntroToc,
    ...(introToc ? { introToc } : {}),
    ...(existing.siteBrand ? { siteBrand: existing.siteBrand } : {}),
    ...(existing.introBakedIntoVideo !== undefined ? { introBakedIntoVideo: existing.introBakedIntoVideo } : {}),
    ...(existing.bakedIntroDurationMs !== undefined ? { bakedIntroDurationMs: existing.bakedIntroDurationMs } : {}),
    ...(existing._bakedSlideSig ? { _bakedSlideSig: existing._bakedSlideSig } : {}),
    ...(Array.isArray(existing.mergedFromSlugs) ? { mergedFromSlugs: existing.mergedFromSlugs } : {}),
    updatedAt: new Date().toISOString(),
    cues,
  };
}

async function handleGenerateNarration() {
  if (!selectedScenario) {
    alert("먼저 좌측에서 시나리오를 선택해주세요.");
    return;
  }
  const btn = document.getElementById("btn-generate-narration");
  const style = document.getElementById("narration-style-select")?.value || "manual";
  const voice = document.getElementById("narration-voice-select")?.value || "ko-KR-SunHiNeural";
  const pitch = document.getElementById("narration-pitch-select")?.value || STYLE_RECOMMENDED_PITCH[style] || "+0Hz";
  const rate = document.getElementById("narration-rate-select")?.value || "+5%";
  const enabled = document.getElementById("narration-enabled-toggle")?.checked ?? true;
  const showSubtitles = document.getElementById("narration-subtitle-toggle")?.checked ?? true;
  const showIntroToc = document.getElementById("narration-toc-toggle")?.checked ?? true;

  if (btn) {
    btn.disabled = true;
    btn.textContent = "⏳ AI 대본·목차 생성 & 음성·슬라이드 영상 합성 중...";
  }
  stopRealtimeHoldAndAudio();
  if (typeof releaseVideoFileLock === "function") {
    await releaseVideoFileLock();
  }
  try {
    const res = await fetch(`/api/narration/${selectedScenario}/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ style, voice, pitch, rate, enabled, showSubtitles, showIntroToc }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "생성 실패");

    if (scenarioDetailsCache[selectedScenario]) {
      scenarioDetailsCache[selectedScenario].narration = data.narration;
      if (data.moments) {
        scenarioDetailsCache[selectedScenario].moments = data.moments;
      }
      if (data.editPlan) {
        scenarioDetailsCache[selectedScenario].editPlan = data.editPlan;
      } else if (scenarioDetailsCache[selectedScenario].editPlan) {
        scenarioDetailsCache[selectedScenario].editPlan.narration = data.narration;
      }
      syncScenarioTimelineInMemory(scenarioDetailsCache[selectedScenario]);
    }
    window.__forcePreviewIntroToc = false;
    await clearNarrationUnapplied();
    setVideoMode("raw", scenarioDetailsCache[selectedScenario]);
    renderNarrationStudio(scenarioDetailsCache[selectedScenario]);
    renderTimelineVisual(scenarioDetailsCache[selectedScenario]);
    renderMomentsStepList(scenarioDetailsCache[selectedScenario]);
    updateJsonViewer("narration");
    fetchScenarios();
  } catch (err) {
    alert(`나레이션 생성 오류: ${err.message}`);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "✨ AI 대본 생성 & 음성 합성";
    }
  }
}

function insertNarrationCueRelative(targetIdx, position) {
  if (!selectedScenario) return;
  const current = collectNarrationFromUI();
  const cues = current.cues;
  const refCue = cues[targetIdx];
  if (!refCue) return;

  const refAnchor = refCue.videoStartMs ?? refCue.startMs ?? 200;
  let newStartMs = 200;
  let insertIndex = targetIdx;

  if (position === "before") {
    const prevCue = targetIdx > 0 ? cues[targetIdx - 1] : null;
    const prevAnchor = prevCue ? prevCue.videoStartMs ?? prevCue.startMs ?? 0 : 0;
    if (!prevCue) {
      newStartMs = Math.max(100, Math.round(refAnchor / 2));
      if (refAnchor < 1200) {
        refCue.videoStartMs = Math.max(refAnchor, newStartMs + 800);
      }
    } else {
      newStartMs = Math.round((prevAnchor + refAnchor) / 2);
    }
    insertIndex = targetIdx;
  } else {
    const nextCue = targetIdx < cues.length - 1 ? cues[targetIdx + 1] : null;
    const nextAnchor = nextCue ? nextCue.videoStartMs ?? nextCue.startMs ?? refAnchor + 2500 : null;
    if (!nextCue) {
      newStartMs = refAnchor + 2000;
    } else {
      newStartMs = Math.round((refAnchor + nextAnchor) / 2);
    }
    insertIndex = targetIdx + 1;
  }

  cues.splice(insertIndex, 0, {
    id: insertIndex + 1,
    videoStartMs: newStartMs,
    startMs: newStartMs,
    endMs: newStartMs + 2400,
    text: "새 나레이션 대본을 입력하세요.",
    isIntro: insertIndex === 0 && newStartMs <= 600,
    extraHoldMs: 0,
  });

  current.cues = cues.map((c, idx) => ({ ...c, id: idx + 1 }));
  if (scenarioDetailsCache[selectedScenario]) {
    scenarioDetailsCache[selectedScenario].narration = current;
    syncScenarioTimelineInMemory(scenarioDetailsCache[selectedScenario]);
  }
  markNarrationUnapplied("새 대본 구간이 추가되었습니다. 문장 입력 후 [지금 영상에 즉시 반영] 또는 [💾 대본 저장 & 재합성]을 눌러주세요.");
  renderNarrationStudio(scenarioDetailsCache[selectedScenario], insertIndex);
  renderTimelineVisual(scenarioDetailsCache[selectedScenario]);
}

function handleAddNarrationIntro() {
  if (!selectedScenario) return;
  const current = collectNarrationFromUI();
  const style = document.getElementById("narration-style-select")?.value || current.style || "manual";
  const introStartMs = 200;
  const introEndMs = 2800;

  if (current.cues.length > 0 && (current.cues[0].videoStartMs ?? current.cues[0].startMs) < 500) {
    current.cues[0].videoStartMs = Math.max(800, current.cues[0].videoStartMs || 800);
  }

  current.cues.unshift({
    id: 1,
    videoStartMs: introStartMs,
    startMs: introStartMs,
    endMs: introEndMs,
    text: getOpeningTemplateByStyle(style),
    isIntro: true,
    extraHoldMs: 0,
  });
  current.cues = current.cues.map((c, idx) => ({ ...c, id: idx + 1 }));

  if (scenarioDetailsCache[selectedScenario]) {
    scenarioDetailsCache[selectedScenario].narration = current;
    syncScenarioTimelineInMemory(scenarioDetailsCache[selectedScenario]);
  }
  markNarrationUnapplied("오프닝 대본 구간이 추가되었습니다. 음성(TTS) 및 슬라이드 합성을 위해 [지금 영상에 즉시 반영]을 눌러주세요.", {
    needsSlideBake: true,
  });
  renderNarrationStudio(scenarioDetailsCache[selectedScenario], 0);
  renderTimelineVisual(scenarioDetailsCache[selectedScenario]);
}

function handleAddNarrationCue() {
  if (!selectedScenario) return;
  const current = collectNarrationFromUI();
  const playheadMs =
    videoPlayer && Number.isFinite(videoPlayer.currentTime) && videoPlayer.currentTime > 0.1
      ? Math.round(
          currentVideoMode === "rendered"
            ? compTimeMsToVideoTimeMs(videoPlayer.currentTime * 1000, scenarioDetailsCache[selectedScenario]?.editPlan)
            : videoPlayer.currentTime * 1000
        )
      : null;

  let nextStartMs;
  let insertIndex = current.cues.length;

  if (playheadMs !== null) {
    nextStartMs = playheadMs;
    const foundIdx = current.cues.findIndex((c) => (c.videoStartMs ?? c.startMs) > nextStartMs);
    insertIndex = foundIdx === -1 ? current.cues.length : foundIdx;
  } else {
    const lastCue = current.cues[current.cues.length - 1];
    nextStartMs = lastCue ? (lastCue.videoStartMs ?? lastCue.startMs) + 2000 : 200;
    insertIndex = current.cues.length;
  }

  current.cues.splice(insertIndex, 0, {
    id: insertIndex + 1,
    videoStartMs: nextStartMs,
    startMs: nextStartMs,
    endMs: nextStartMs + 2500,
    text: "새 나레이션 대본을 입력하세요.",
    isIntro: insertIndex === 0 && nextStartMs <= 600,
    extraHoldMs: 0,
  });
  current.cues = current.cues.map((c, idx) => ({ ...c, id: idx + 1 }));

  if (scenarioDetailsCache[selectedScenario]) {
    scenarioDetailsCache[selectedScenario].narration = current;
    syncScenarioTimelineInMemory(scenarioDetailsCache[selectedScenario]);
  }
  markNarrationUnapplied("새 대본 구간이 추가되었습니다. 문장 입력 후 [지금 영상에 즉시 반영] 또는 [💾 대본 저장 & 재합성]을 눌러주세요.");
  renderNarrationStudio(scenarioDetailsCache[selectedScenario], insertIndex);
  renderTimelineVisual(scenarioDetailsCache[selectedScenario]);
}

async function handleSaveNarration() {
  if (!selectedScenario) return;
  const btn = document.getElementById("btn-save-narration");
  const narration = collectNarrationFromUI({ sortByStartTime: true });
  const prevSec = videoPlayer && Number.isFinite(videoPlayer.currentTime) ? videoPlayer.currentTime : 0;

  if (btn) {
    btn.disabled = true;
    btn.textContent = "⏳ 정속 음성 재합성 & 싱크 계산 중...";
  }
  stopRealtimeHoldAndAudio();
  if (typeof releaseVideoFileLock === "function") {
    await releaseVideoFileLock();
  }
  try {
    const res = await fetch(`/api/narration/${selectedScenario}/save`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        narration,
        synthesize: true,
        bakeSlide: Boolean(unappliedNarrationState.needsSlideBake),
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "저장 실패");

    await clearNarrationUnapplied();

    if (scenarioDetailsCache[selectedScenario]) {
      const prevSig = scenarioDetailsCache[selectedScenario].narration?._bakedSlideSig;
      scenarioDetailsCache[selectedScenario].narration = data.narration;
      if (data.moments) {
        scenarioDetailsCache[selectedScenario].moments = data.moments;
      }
      if (data.editPlan) {
        scenarioDetailsCache[selectedScenario].editPlan = data.editPlan;
      } else if (scenarioDetailsCache[selectedScenario].editPlan) {
        scenarioDetailsCache[selectedScenario].editPlan.narration = data.narration;
      }
      syncScenarioTimelineInMemory(scenarioDetailsCache[selectedScenario]);
      if (
        (data.narration?._bakedSlideSig && data.narration._bakedSlideSig !== prevSig) ||
        data.renderedVideoUpdated ||
        videoPlayer?.dataset?.fileLockReleased === "1"
      ) {
        setVideoMode(currentVideoMode, scenarioDetailsCache[selectedScenario], unappliedNarrationState.renderInfo);
        if (videoPlayer && prevSec > 0.5) {
          videoPlayer.addEventListener(
            "loadedmetadata",
            () => {
              videoPlayer.currentTime = Math.min(prevSec, Math.max(0, (videoPlayer.duration || prevSec) - 0.2));
            },
            { once: true }
          );
        }
      }
    }
    renderNarrationStudio(scenarioDetailsCache[selectedScenario]);
    renderTimelineVisual(scenarioDetailsCache[selectedScenario]);
    renderMomentsStepList(scenarioDetailsCache[selectedScenario]);
    updateJsonViewer("narration");
    fetchScenarios();
  } catch (err) {
    alert(`대본 저장 오류: ${err.message}`);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "💾 대본 저장 & 재합성";
    }
  }
}

// 9. Generate Browse Plan via Gemini (with 2-Stage Code Explorer Agent & Video Directing)
async function handleGeneratePlan() {
  const prompt = promptInput.value.trim();
  if (!prompt) {
    alert("시나리오 상세 설명을 입력해주세요.");
    promptInput.focus();
    return;
  }

  const targetProjectPath = "";
  const targetUrl = targetBaseUrlInput.value.trim();

  btnGenerate.disabled = true;
  generateBtnText.textContent = "AI 시나리오 연출 중...";

  if (aiProgressBar) {
    aiProgressBar.classList.remove("hidden");
    if (aiProgressText) {
      aiProgressText.textContent = "🌐 [Live Web 모드] 실시간 대상 웹 서비스 URL 기반 시나리오 연출 중...";
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

    // Show automatic prompt normalization feedback if the backend refined the prompt
    const polishFeedbackEl = document.getElementById("prompt-polish-feedback");
    if (data.normalizedPrompt && data.normalizedPrompt !== prompt && polishFeedbackEl) {
      polishFeedbackEl.style.display = "block";
      polishFeedbackEl.innerHTML = `✨ <b>자동 정석 포맷 보정 적용됨:</b> ${data.normalizedPrompt}`;
    }

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

const PROMPT_CHAIN_PRESETS = {
  "eap-full": {
    slug: "eap-minutes-draft-submit",
    prompt:
      "전자결재 -> 결재 작성 -> 검색으로 '회의록' 검색 -> '회의록' 결재업무 카드 선택 후 작성 클릭 -> 제목에 '테스트 회의록 결재 부탁드립니다.' 입력 -> 결재분류 폴더 버튼 선택 -> 결재분류 팝업에서 '테스트' 선택 -> 결재분류 팝업에서 확인 클릭 -> 기안의견에 '승인 부탁드립니다.' 입력 -> 문서 내용에 '금일 회의 완료' 입력 -> 결재선 탭 선택 -> 결재선 선택 버튼 클릭 -> 결재선 선택 팝업에서 '테스트' 부서 선택 -> 결재선 선택 팝업에서 'test001' 체크박스 선택 -> 결재선 선택 팝업에서 첫번째 '합의' 버튼 선택 -> 결재선 선택 팝업에서 'test002'를 두번째 결재칸으로 드래그 앤 드롭 -> 결재선 선택 팝업에서 확인 클릭 -> 결재상신 버튼 클릭 -> 결재현황 클릭 -> 제일 최근 결재 문서 제목 클릭",
  },
  "eap-approve": {
    slug: "eap-pending-doc-approve",
    prompt:
      "전자결재 -> 결재대기함 클릭 -> 목록에서 첫 번째 결재 대기 문서 제목 클릭 -> 문서 본문 및 결재선 확인 -> 상단 '결재' 버튼 클릭 -> 결재 팝업에서 '승인' 선택 -> 결재 의견에 '검토 완료하여 승인합니다.' 입력 -> 결재 팝업에서 확인 클릭 -> 결재종결함 클릭 -> 제일 최근 결재 문서 제목 클릭",
  },
  "scd-reg": {
    slug: "scd-weekly-meeting-reg",
    prompt:
      "일정관리 -> 좌측 상단 '일정 등록' 버튼 클릭 -> 일정 등록 팝업에서 일정 제목에 '주간 프로젝트 점검 회의' 입력 -> 장소에 '대회의실' 입력 -> 내용에 '스프린트 진행 현황 및 이슈 공유' 입력 -> 일정 등록 팝업 하단 '저장' 버튼 클릭 -> 캘린더 화면에서 등록된 '주간 프로젝트 점검 회의' 일정 클릭하여 상세 확인",
  },
  "rmg-res": {
    slug: "rmg-room-reservation",
    prompt:
      "자원예약 -> 좌측 상단 '예약 신청' 버튼 클릭 -> 자원 선택 버튼 클릭 -> 자원 선택 팝업에서 '대회의실' 선택 후 확인 클릭 -> 제목에 '신규 서비스 아키텍처 리뷰' 입력 -> 사용시간 확인 -> 신청사유에 '부서간 기술 검토 회의' 입력 -> 하단 '저장' 버튼 클릭 -> 내 예약 목록에서 등록된 예약 내역 클릭하여 확인",
  },
  "doc-reg": {
    slug: "doc-security-guide-reg",
    prompt:
      "문서관리 -> 좌측 상단 '문서 등록' 버튼 클릭 -> 문서함 선택 팝업에서 첫 번째 문서함 선택 후 확인 클릭 -> 문서 제목에 '2026년 정보보안 운영 지침' 입력 -> 본문 에디터에 '전사 정보보안 규정 개정안 안내입니다.' 입력 -> 상단 '저장' 버튼 클릭 -> 목록에서 방금 등록된 문서 제목 클릭하여 상세 조회",
  },
  "search-view": {
    slug: "bod-notice-search-view",
    prompt:
      "게시판 -> 좌측 트리에서 '공지사항' 클릭 -> 목록의 첫 번째 게시글 제목으로 검색창에 검색어 입력 후 검색 버튼 클릭 -> 검색된 결과 목록에서 첫 번째 게시글 제목 클릭 -> 게시글 본문 상세 내용 스크롤 확인 -> '목록' 버튼 클릭하여 복귀",
  },
};

async function handlePolishPrompt(useLLM = false) {
  const raw = promptInput ? promptInput.value.trim() : "";
  if (!raw) {
    alert("먼저 시나리오 흐름이나 설명을 입력하거나 상단 예시/조립 칩을 클릭해주세요.");
    if (promptInput) promptInput.focus();
    return;
  }

  const btnPolish = document.getElementById("btn-polish-prompt");
  const feedbackEl = document.getElementById("prompt-polish-feedback");
  if (btnPolish) {
    btnPolish.disabled = true;
    btnPolish.textContent = "⏳ 정석 포맷 변환 중...";
  }

  try {
    const res = await fetch("/api/ai/polish-prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: raw, useLLM }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "프롬프트 정제 실패");

    if (data.normalizedPrompt && promptInput) {
      promptInput.value = data.normalizedPrompt;
    }

    if (feedbackEl) {
      feedbackEl.style.display = "block";
      const hints = Array.isArray(data.addedHints) && data.addedHints.length > 0
        ? data.addedHints.join(" | ")
        : "작은따옴표(' ') 타겟/입력값 구분 및 화살표(->) 단계 체인 정규화 완료";
      feedbackEl.innerHTML = `✨ <b>정석 포맷 다듬기 완료 (${data.steps ? data.steps.length : 0}단계):</b> ${hints}`;
    }
  } catch (err) {
    alert("프롬프트 다듬기 오류: " + err.message);
  } finally {
    if (btnPolish) {
      btnPolish.disabled = false;
      btnPolish.textContent = "🪄 정석 포맷 다듬기";
    }
  }
}

// 9.5 Way A: Live Eyedropper & Action Demonstration Recorder
let recorderEventSource = null;
let recorderFinishing = false;

function renderRecorderLiveEvents(status) {
  const statusTextEl = document.getElementById("recorder-modal-status-text");
  const badgeEl = document.getElementById("recorder-events-badge");
  const listEl = document.getElementById("recorder-events-list");

  if (statusTextEl && status.statusMessage) {
    statusTextEl.textContent = status.statusMessage;
  }
  const events = Array.isArray(status.events) ? status.events : [];
  if (badgeEl) {
    badgeEl.textContent = `${events.length}개 감지됨`;
  }
  if (!listEl) return;

  if (events.length === 0) {
    listEl.innerHTML = `
      <div style="color: var(--text-muted); text-align: center; padding: 32px 0;">
        브라우저에서 클릭·입력·드래그를 수행하면 여기에 실시간으로 실제 DOM 셀렉터와 동작이 기록됩니다.
      </div>
    `;
    return;
  }

  listEl.innerHTML = events
    .map((ev) => {
      const badgeColor =
        ev.kind === "click" || ev.kind === "rightclick"
          ? "var(--run)"
          : ev.kind === "type" || ev.kind === "selectOption"
          ? "var(--accent)"
          : ev.kind === "dragAndDrop" || ev.kind === "upload"
          ? "var(--warn)"
          : "var(--ok)";
      const kindLabel =
        ev.kind === "click"
          ? "💧 클릭"
          : ev.kind === "rightclick"
          ? "🖱️ 우클릭"
          : ev.kind === "hover"
          ? "👆 호버"
          : ev.kind === "type"
          ? "⌨️ 입력"
          : ev.kind === "selectOption"
          ? "📋 선택"
          : ev.kind === "upload"
          ? "📎 첨부"
          : ev.kind === "dragAndDrop"
          ? "✊ 드래그"
          : "🖱️ 동작";
      const safeLabel = escapeHtmlAttr(ev.label || "");
      const safeText = ev.text ? ` <strong style="color:var(--accent);">'${escapeHtmlAttr(ev.text)}'</strong>` : "";
      const safeSel = escapeHtmlAttr(ev.selector || "");
      const safeIframe = ev.iframe ? ` <span style="color:var(--text-muted);">[${escapeHtmlAttr(ev.iframe)}]</span>` : "";
      return `
        <div style="display:flex; align-items:center; gap:8px; padding:6px 10px; background:var(--card); border:1px solid var(--stroke); border-left:3px solid ${badgeColor}; border-radius:4px;">
          <span style="color:${badgeColor}; font-weight:700; min-width:68px; white-space:nowrap;">#${ev.seq} ${kindLabel}</span>
          <span style="color:var(--text-main); font-weight:500;">${safeLabel}${safeText}</span>
          <span style="margin-left:auto; color:var(--text-muted); font-size:0.85em; max-width:240px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${safeSel}">${safeSel}${safeIframe}</span>
        </div>
      `;
    })
    .join("");
  listEl.scrollTop = listEl.scrollHeight;
}

async function startLiveDemoRecorder() {
  const modalOverlay = document.getElementById("recorder-modal-overlay");
  const btnConfirm = document.getElementById("btn-confirm-recorder-done");
  const url = targetBaseUrlInput ? targetBaseUrlInput.value.trim() : "";
  const slug = slugInput ? slugInput.value.trim() : "";

  recorderFinishing = false;
  if (modalOverlay) modalOverlay.classList.remove("hidden");
  if (btnConfirm) {
    btnConfirm.disabled = false;
    btnConfirm.textContent = "✅ 시범 완료 및 AI 시나리오 변환";
  }

  // Connect SSE for live event updates
  if (recorderEventSource) recorderEventSource.close();
  recorderEventSource = new EventSource("/api/recorder/stream");
  recorderEventSource.onmessage = (event) => {
    try {
      const status = JSON.parse(event.data);
      renderRecorderLiveEvents(status);
      if (status.finishedByBrowserHud && !recorderFinishing) {
        finishLiveDemoRecorder();
      }
    } catch (e) {
      console.warn("Recorder SSE parse error:", e);
    }
  };

  try {
    const res = await fetch("/api/recorder/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: url || undefined, slug: slug || undefined }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "스포이드 브라우저 실행 실패");
    if (data.status) renderRecorderLiveEvents(data.status);
  } catch (err) {
    alert("스포이드 시범 모드 시작 실패: " + err.message);
    cancelLiveDemoRecorder();
  }
}

async function finishLiveDemoRecorder() {
  if (recorderFinishing) return;
  recorderFinishing = true;

  const modalOverlay = document.getElementById("recorder-modal-overlay");
  const btnConfirm = document.getElementById("btn-confirm-recorder-done");
  const statusTextEl = document.getElementById("recorder-modal-status-text");

  if (btnConfirm) {
    btnConfirm.disabled = true;
    btnConfirm.textContent = "⏳ AI가 시나리오로 정제 중...";
  }
  if (statusTextEl) {
    statusTextEl.textContent = "✨ 캡처된 실제 DOM 셀렉터와 동작을 바탕으로 AI가 시나리오를 구성하고 있습니다...";
  }

  try {
    const slug = slugInput ? slugInput.value.trim() : "";
    const customTitleHint = promptInput ? promptInput.value.trim() : "";
    const dirSelect = document.getElementById("directing-style-select");
    const directingStyle = dirSelect ? dirSelect.value : "standard";
    const res = await fetch("/api/recorder/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slug: slug || undefined,
        customTitleHint: customTitleHint || undefined,
        directingStyle,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "시나리오 변환 실패");

    if (recorderEventSource) {
      recorderEventSource.close();
      recorderEventSource = null;
    }
    if (modalOverlay) modalOverlay.classList.add("hidden");

    if (!data.events || data.events.length === 0) {
      alert("감지된 클릭/입력 동작이 없습니다. 브라우저에서 최소 1개 이상의 동작을 수행해주세요.");
      return;
    }

    currentPlan = data.plan;
    currentSlug = data.suggestedSlug;
    currentExplanation = data.explanation;

    if (slugInput) slugInput.value = currentSlug;
    if (promptInput && data.canonicalPrompt) {
      promptInput.value = data.canonicalPrompt;
    }

    const polishFeedbackEl = document.getElementById("prompt-polish-feedback");
    if (polishFeedbackEl) {
      polishFeedbackEl.classList.remove("hidden");
      polishFeedbackEl.style.display = "block";
      polishFeedbackEl.innerHTML = `💧 <b>스포이드 시범 감지 완료 (${data.events.length}개 실제 동작 ➔ ${data.plan.actions.length}개 액션 정제):</b> 모든 셀렉터와 iframe이 실제 화면 DOM에서 100% 정확하게 추출되었습니다!`;
    }

    if (planSlugBadge) planSlugBadge.textContent = `시나리오: ${currentSlug} 💧 (스포이드 실측 완료 · 자동 저장됨)`;
    if (explanationText) explanationText.textContent = currentExplanation;

    renderActionCards();
    fetchScenarios();
    fetchStatus();

    const editorCardEl = document.querySelector(".editor-card");
    if (editorCardEl) {
      editorCardEl.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  } catch (err) {
    alert("시범 동작 변환 중 오류: " + err.message);
    if (modalOverlay) modalOverlay.classList.add("hidden");
  } finally {
    recorderFinishing = false;
  }
}

async function cancelLiveDemoRecorder() {
  if (recorderEventSource) {
    recorderEventSource.close();
    recorderEventSource = null;
  }
  const modalOverlay = document.getElementById("recorder-modal-overlay");
  if (modalOverlay) modalOverlay.classList.add("hidden");
  await fetch("/api/recorder/cancel", { method: "POST" }).catch(() => {});
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
      cards[startIndex].style.borderColor = "var(--accent)";
      cards[startIndex].style.background = "var(--accent-soft)";
      setTimeout(() => {
        cards[startIndex].style.borderColor = "";
        cards[startIndex].style.background = "";
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
      cards[validIndex].style.borderColor = "var(--accent)";
      cards[validIndex].style.background = "var(--accent-soft)";
      setTimeout(() => {
        cards[validIndex].style.borderColor = "";
        cards[validIndex].style.background = "";
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
      cards[toIndex].style.borderColor = "var(--accent)";
      cards[toIndex].style.background = "var(--accent-soft)";
      setTimeout(() => {
        cards[toIndex].style.borderColor = "";
        cards[toIndex].style.background = "";
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

function extractHumanTargetLabel(act) {
  if (!act) return "";
  const sel = String(act.selector || "");
  const patterns = [
    /:text-is\(['"]([^'"]+)['"]\)/,
    /:has-text\(['"]([^'"]+)['"]\)/,
    /\[title\*?=['"]([^'"]+)['"]\]/,
    /\[value=['"]([^'"]+)['"]\]/,
    /\[placeholder\*?=['"]([^'"]+)['"]\]/,
  ];
  for (const re of patterns) {
    const m = sel.match(re);
    if (m && m[1] && m[1].trim()) {
      return m[1].trim();
    }
  }
  const desc = String(act.description || "");
  const qMatch = desc.match(/'([^']+)'/);
  if (qMatch && qMatch[1] && qMatch[1].trim()) {
    return qMatch[1].trim();
  }
  const bMatch = desc.match(/\[([^\]]+)\]/);
  if (bMatch && bMatch[1] && bMatch[1].trim()) {
    return bMatch[1].trim();
  }
  const html = String(act.targetHtml || "");
  if (html) {
    const attrMatch = html.match(/(?:title|placeholder|alt|aria-label)=["']([^"']{1,40})["']/i);
    if (attrMatch && attrMatch[1] && attrMatch[1].trim()) {
      return attrMatch[1].trim();
    }
    const textOnly = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (textOnly && textOnly.length <= 36) {
      return textOnly;
    }
  }
  const idMatch = sel.match(/#([a-zA-Z0-9_-]{2,40})/);
  if (idMatch && idMatch[1]) {
    return `#${idMatch[1]}`;
  }
  return "";
}

function applyHumanTargetLabelChange(act, newTargetRaw) {
  const newTarget = String(newTargetRaw || "").trim();
  if (!newTarget) return;
  const oldTarget = act._lastHumanTarget || extractHumanTargetLabel(act);
  const safeNew = newTarget.replace(/'/g, "");

  if (oldTarget && oldTarget !== newTarget && act.selector && act.selector.includes(oldTarget)) {
    const rawParts = act.selector
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const updatedParts = [];
    for (const part of rawParts) {
      if ((part.includes(":nth-of-type(") || part.includes(":nth-child(")) && !part.includes(oldTarget)) {
        continue;
      }
      const replaced = part
        .split(`'${oldTarget}'`).join(`'${safeNew}'`)
        .split(`"${oldTarget}"`).join(`"${safeNew}"`)
        .replace(/:nth-of-type\(\d+\)/g, "")
        .replace(/:nth-child\(\d+\)/g, "");
      if (replaced.trim()) {
        updatedParts.push(replaced.trim());
      }
    }
    if (updatedParts.length > 0) {
      act.selector = updatedParts.join(", ");
    } else {
      act.selector = `button:has-text('${safeNew}'):visible, a:has-text('${safeNew}'):visible, [title='${safeNew}']:visible, :text-is('${safeNew}'):visible`;
    }
    delete act.targetHtml;
    if (act.description && act.description.includes(oldTarget)) {
      act.description = act.description.split(oldTarget).join(newTarget);
    } else {
      act.description = `'${newTarget}' 클릭`;
    }
  } else if (!act.selector || !act.selector.trim() || oldTarget !== newTarget) {
    act.selector = `button:has-text('${safeNew}'):visible, a:has-text('${safeNew}'):visible, [title='${safeNew}']:visible, :text-is('${safeNew}'):visible`;
    delete act.targetHtml;
    if (!act.description || act.description === "새 액션" || (oldTarget && act.description.includes(oldTarget))) {
      act.description =
        oldTarget && act.description && act.description.includes(oldTarget)
          ? act.description.split(oldTarget).join(newTarget)
          : `'${newTarget}' 클릭`;
    }
  }
  act._lastHumanTarget = newTarget;
}

// Render Editable Action Cards (1-Line Human Storyboard View)
function renderActionCards() {
  const explanationBoxEl = document.getElementById("explanation-box");
  actionsList.innerHTML = "";
  if (!currentPlan || !currentPlan.actions || currentPlan.actions.length === 0) {
    if (planStatsPills) planStatsPills.innerHTML = "";
    if (explanationBoxEl) {
      explanationBoxEl.classList.remove("compact-explanation", "hidden");
    }
    actionsList.innerHTML = `
      <div class="empty-state">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/></svg>
        <p>생성되거나 불러온 액션 플랜이 없습니다.</p>
        <span>상단 [💧 브라우저 띄워서 시범 보이기]로 시연하거나 [📂 기존 시나리오 빠른 불러오기]를 선택해보세요.</span>
        <button class="btn btn-sm btn-secondary" style="margin-top: 10px;" id="btn-empty-add-action">+ 첫 번째 액션 추가</button>
      </div>`;
    const btnEmptyAdd = document.getElementById("btn-empty-add-action");
    if (btnEmptyAdd) btnEmptyAdd.addEventListener("click", () => insertActionAt(0));
    return;
  }

  if (explanationBoxEl) {
    if (currentSlug) {
      explanationBoxEl.classList.remove("hidden");
      explanationBoxEl.classList.add("compact-explanation");
    } else {
      explanationBoxEl.classList.add("hidden");
    }
  }

  // Update Plan Breakdown Stats Pills
  if (planStatsPills) {
    const acts = currentPlan.actions;
    const clickCount = acts.filter((a) => a.type === "click" || a.type === "rightclick" || a.type === "dblclick" || a.type === "hover").length;
    const typeCount = acts.filter((a) => a.type === "type").length;
    const uploadCount = acts.filter((a) => a.type === "upload").length;
    const dragCount = acts.filter((a) => a.type === "dragAndDrop" || (a.sourceSelector && a.targetSelector)).length;
    const waitCount = acts.filter((a) => a.type === "wait").length;
    planStatsPills.innerHTML = [
      `<span class="plan-stat-pill">총 ${acts.length}단계</span>`,
      clickCount > 0 ? `<span class="plan-stat-pill" style="color:var(--run);">🖱️ 클릭 ${clickCount}</span>` : "",
      typeCount > 0 ? `<span class="plan-stat-pill" style="color:var(--ok);">⌨️ 입력 ${typeCount}</span>` : "",
      uploadCount > 0 ? `<span class="plan-stat-pill" style="color:var(--accent);">📎 첨부 ${uploadCount}</span>` : "",
      dragCount > 0 ? `<span class="plan-stat-pill" style="color:var(--warn);">✊ 드래그 ${dragCount}</span>` : "",
      waitCount > 0 ? `<span class="plan-stat-pill" style="color:var(--neutral);">⏳ 대기 ${waitCount}</span>` : "",
    ]
      .filter(Boolean)
      .join("");
  }

  const totalActions = currentPlan.actions.length;

  currentPlan.actions.forEach((act, idx) => {
    if (act.type === "click" && act.sourceSelector && act.targetSelector) {
      act.type = "dragAndDrop";
    } else if (act.type === "click" && act.filePath) {
      act.type = "upload";
    }

    const card = document.createElement("div");
    card.className = "action-item-card storyboard-card";
    if (compactWaitsEnabled && act.type === "wait") {
      card.classList.add("compact-wait-card");
    }
    card.draggable = true;
    card.dataset.index = idx;

    const isMissingSelector =
      act.type === "dragAndDrop"
        ? (!act.sourceSelector || act.sourceSelector.trim() === "") ||
          (!act.targetSelector || act.targetSelector.trim() === "")
        : act.type !== "wait" && act.type !== "navigate" && (!act.selector || act.selector.trim() === "");
    if (isMissingSelector) {
      card.classList.add("needs-selector");
    }

    const badgeClass = `badge-${act.type}`;
    const humanTarget = extractHumanTargetLabel(act);
    act._lastHumanTarget = humanTarget;
    const waitSecVal = ((act.ms || 2000) / 1000).toFixed(1).replace(/\.0$/, "");

    let inlineValueHtml = "";
    if (act.type === "type") {
      const displayVal = (act.text || "").replace(/\n/g, " ↵ ");
      const tagLabel = act.pressEnter ? "📝 입력+⏎엔터" : act.text === "" ? "⌫ 지우기" : "📝 입력값";
      inlineValueHtml = `
        <div class="storyboard-inline-field storyboard-type-field">
          <span class="storyboard-field-tag">${tagLabel}</span>
          <input type="text" class="storyboard-inline-input" placeholder="⌫ 비워두면 기존 내용 지우기 (백스페이스)" value="${escapeHtmlAttr(displayVal)}" data-field="text">
        </div>
      `;
    } else if (act.type === "wait") {
      inlineValueHtml = `
        <div class="storyboard-inline-field storyboard-wait-field">
          <span class="storyboard-field-tag">⏱️ 대기</span>
          <input type="number" step="0.5" min="0.1" max="30" class="storyboard-wait-input" value="${waitSecVal}" data-field="waitSec">
          <span class="storyboard-unit">초</span>
        </div>
      `;
    } else if (act.type === "upload") {
      const fileDisplay = act.filePath || act.text || "";
      inlineValueHtml = `
        <div class="storyboard-inline-field storyboard-type-field">
          <span class="storyboard-field-tag">📎 첨부파일</span>
          <input type="text" class="storyboard-inline-input" placeholder="파일 경로 또는 파일명 (예: 샘플문서.pdf)" value="${escapeHtmlAttr(fileDisplay)}" data-field="filePath">
        </div>
      `;
    } else if (act.type === "click" || act.type === "rightclick" || act.type === "hover" || act.type === "dblclick") {
      inlineValueHtml = `
        <div class="storyboard-inline-field storyboard-target-field" title="클릭할 버튼이나 메뉴의 글자를 수정하면 내부 셀렉터가 자동으로 변경됩니다">
          <span class="storyboard-field-tag">🎯 대상 글자</span>
          <input type="text" class="storyboard-inline-input storyboard-target-input" placeholder="${isMissingSelector ? "누를 버튼/메뉴 이름 입력 (예: 저장)" : "자동 감지됨 (글자 수정 가능)"}" value="${escapeHtmlAttr(humanTarget)}" data-field="humanTarget">
        </div>
      `;
    }

    card.innerHTML = `
      <div class="action-top-row storyboard-main-row">
        <div class="action-drag-handle" title="드래그하여 순서 변경">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <circle cx="9" cy="6" r="2"/><circle cx="15" cy="6" r="2"/>
            <circle cx="9" cy="12" r="2"/><circle cx="15" cy="12" r="2"/>
            <circle cx="9" cy="18" r="2"/><circle cx="15" cy="18" r="2"/>
          </svg>
        </div>
        <span class="action-index">#${idx + 1}</span>
        <select class="action-badge ${badgeClass}" data-field="type">
          <option value="click" ${act.type === "click" ? "selected" : ""}>🖱️ 클릭</option>
          <option value="type" ${act.type === "type" ? "selected" : ""}>⌨️ 입력</option>
          <option value="upload" ${act.type === "upload" ? "selected" : ""}>📎 파일 첨부</option>
          <option value="wait" ${act.type === "wait" ? "selected" : ""}>⏳ 대기</option>
          <option value="hover" ${act.type === "hover" ? "selected" : ""}>👆 마우스 올리기</option>
          <option value="dragAndDrop" ${act.type === "dragAndDrop" ? "selected" : ""}>✊ 드래그 이동</option>
          <option value="rightclick" ${act.type === "rightclick" ? "selected" : ""}>🖱️ 우클릭</option>
          <option value="dblclick" ${act.type === "dblclick" ? "selected" : ""}>🖱️ 더블클릭</option>
          <option value="navigate" ${act.type === "navigate" ? "selected" : ""}>🌐 페이지 이동</option>
        </select>

        <input type="text" class="storyboard-desc-input" placeholder="단계 설명 (예: '결재' 메뉴 클릭)" value="${escapeHtmlAttr(act.description || "")}" data-field="description">

        ${inlineValueHtml}

        <div class="action-card-controls">
          ${act.type !== "wait" ? `<button type="button" class="action-ctrl-btn btn-toggle-raw-selector" title="고급: 내부 CSS 셀렉터 확인/수정">🔧</button>` : ""}
          <button type="button" class="action-delete-btn" title="이 단계 삭제">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
          </button>
        </div>
      </div>

      <div class="action-floating-toolbar">
        <button type="button" class="btn-action-float action-move-up" title="위로 이동" ${idx === 0 ? "disabled" : ""}>▲ 위로</button>
        <button type="button" class="btn-action-float action-move-down" title="아래로 이동" ${idx === totalActions - 1 ? "disabled" : ""}>▼ 아래로</button>
        <span class="cue-floating-sep"></span>
        <button type="button" class="btn-action-float action-dup-btn" title="이 단계 복제">📋 복제</button>
        <button type="button" class="btn-action-float action-insert-btn" title="바로 아래에 새 단계 추가">+ 아래 추가</button>
      </div>

      ${act.type !== "wait" ? `
      <div class="storyboard-raw-drawer hidden">
        ${act.type === "dragAndDrop" ? `
          <div class="raw-drawer-row">
            <span class="raw-drawer-label">출발 셀렉터</span>
            <input type="text" value="${escapeHtmlAttr(act.sourceSelector || act.selector || "")}" data-field="sourceSelector" placeholder="드래그할 출발 요소 셀렉터">
            <span class="raw-drawer-label">도착 셀렉터</span>
            <input type="text" value="${escapeHtmlAttr(act.targetSelector || "")}" data-field="targetSelector" placeholder="드롭할 대상 영역 셀렉터">
          </div>
        ` : `
          <div class="raw-drawer-row">
            <span class="raw-drawer-label">내부 타겟 셀렉터 (자동 생성됨)</span>
            <input type="text" value="${escapeHtmlAttr(act.selector || "")}" data-field="selector" placeholder="스포이드 또는 대상 글자 입력 시 자동 생성됩니다">
          </div>
        `}
      </div>` : ""}
    `;

    const btnToggleRaw = card.querySelector(".btn-toggle-raw-selector");
    const rawDrawer = card.querySelector(".storyboard-raw-drawer");
    if (btnToggleRaw && rawDrawer) {
      btnToggleRaw.addEventListener("click", () => {
        rawDrawer.classList.toggle("hidden");
        btnToggleRaw.classList.toggle("active-toggle", !rawDrawer.classList.contains("hidden"));
      });
    }

    const descInputEl = card.querySelector('[data-field="description"]');
    const selInputEl = card.querySelector('[data-field="selector"]');

    card.querySelectorAll("[data-field]").forEach((input) => {
      input.addEventListener("input", () => {
        const field = input.getAttribute("data-field");
        if (field === "humanTarget") {
          applyHumanTargetLabelChange(act, input.value);
          if (descInputEl) descInputEl.value = act.description || "";
          if (selInputEl) selInputEl.value = act.selector || "";
          card.classList.remove("needs-selector");
        } else if (field === "text") {
          act.text = input.value.replace(/\s*↵\s*/g, "\n");
          if (act.description && /\('[^']*'\)$/.test(act.description)) {
            act.description = act.description.replace(/\('[^']*'\)$/, `('${input.value}')`);
            if (descInputEl) descInputEl.value = act.description;
          }
        } else if (field === "filePath") {
          act.filePath = input.value.trim();
        } else if (field === "waitSec") {
          const sec = parseFloat(input.value);
          if (!isNaN(sec) && sec > 0) {
            act.ms = Math.round(sec * 1000);
          }
        } else if (field === "selector" || field === "sourceSelector" || field === "targetSelector") {
          act[field] = input.value;
          if (field === "sourceSelector") act.selector = input.value;
          if (input.value.trim().length > 0) {
            card.classList.remove("needs-selector");
          }
        } else if (field === "description") {
          act.description = input.value;
        }
      });

      input.addEventListener("change", () => {
        const field = input.getAttribute("data-field");
        if (field === "type") {
          act.type = input.value;
          renderActionCards();
        } else if (field === "filePath") {
          act.filePath = input.value.trim();
        } else if (field === "waitSec") {
          const sec = parseFloat(input.value);
          act.ms = !isNaN(sec) && sec > 0 ? Math.round(sec * 1000) : 2000;
        }
      });
    });

    // Control Button Listeners
    card.querySelector(".action-move-up").addEventListener("click", () => moveAction(idx, idx - 1));
    card.querySelector(".action-move-down").addEventListener("click", () => moveAction(idx, idx + 1));
    card.querySelector(".action-dup-btn")?.addEventListener("click", () => duplicateAction(idx));
    card.querySelector(".action-insert-btn").addEventListener("click", () => insertActionAt(idx + 1));
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
  });
}

// 10.5 Sync DOM Card Inputs to currentPlan
function syncCardsToPlan() {
  if (!currentPlan || !currentPlan.actions) return;
  const cards = actionsList.querySelectorAll(".action-item-card");
  cards.forEach((card) => {
    const idxAttr = card.getAttribute("data-index");
    if (idxAttr === null) return;
    const idx = parseInt(idxAttr, 10);
    const act = currentPlan.actions[idx];
    if (!act) return;
    card.querySelectorAll("input, select, textarea").forEach((inp) => {
      const field = inp.getAttribute("data-field");
      if (!field || field === "humanTarget") return;
      if (field === "waitSec") {
        const sec = parseFloat(inp.value);
        if (!isNaN(sec) && sec > 0) {
          act.ms = Math.round(sec * 1000);
        }
      } else if (inp.type === "checkbox") {
        act[field] = inp.checked;
      } else if (inp.type === "number") {
        act[field] = parseInt(inp.value, 10);
      } else if (field === "text") {
        act.text = inp.value.replace(/\s*↵\s*/g, "\n");
      } else {
        act[field] = inp.value;
        if (field === "sourceSelector") {
          act.selector = inp.value;
        }
      }
    });
    if (act.type === "click" && act.sourceSelector && act.targetSelector) {
      act.type = "dragAndDrop";
    } else if (act.type === "click" && act.filePath) {
      act.type = "upload";
    }
  });
}

function resolveOrAutoGenerateSlug() {
  let slug = (slugInput ? slugInput.value.trim() : "") || currentSlug;
  if (!slug && currentPlan && Array.isArray(currentPlan.actions) && currentPlan.actions.length > 0) {
    const now = new Date();
    const pad2 = (n) => String(n).padStart(2, "0");
    slug = `custom-plan-${pad2(now.getMonth() + 1)}${pad2(now.getDate())}-${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`;
    currentSlug = slug;
    if (slugInput) slugInput.value = slug;
    if (planSlugBadge) planSlugBadge.textContent = `📌 ${slug}`;
  }
  return slug;
}

// 11. Save Plan
async function handleSavePlan(silent = false) {
  const isSilent = typeof silent === "boolean" ? silent : false;
  syncCardsToPlan();
      if (!currentPlan || !Array.isArray(currentPlan.actions) || currentPlan.actions.length === 0) {
        if (!isSilent) alert("저장할 액션 플랜이 없습니다. 먼저 스포이드로 시범을 보이거나 액션을 추가해주세요.");
        return false;
      }
      const slug = resolveOrAutoGenerateSlug();
      if (!slug) {
        if (!isSilent) alert("시나리오 식별자(Slug)를 입력해주세요.");
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
          if (btnSavePlan) {
            const originalText = btnSavePlan.textContent;
            btnSavePlan.textContent = "✅ 플랜 저장 완료!";
            btnSavePlan.style.background = "var(--ok)";
            btnSavePlan.style.color = "#fff";
            setTimeout(() => {
              btnSavePlan.textContent = originalText || "💾 플랜 저장";
              btnSavePlan.style.background = "";
              btnSavePlan.style.color = "";
            }, 2000);
          }
          if (!isSilent) {
            alert(`'${slug}' 브라우징 플랜이 성공적으로 저장되었습니다!`);
          }
          fetchScenarios();
          return true;
        }
      } catch (err) {
        if (!isSilent) alert("저장 실패: " + err.message);
        return false;
      }
      return false;
    }

// 12. Run Pipeline (Record & Edit)
async function handleRunPipeline() {
      syncCardsToPlan();
      const slug = resolveOrAutoGenerateSlug();
      if (!slug) {
        alert("녹화할 시나리오를 선택하거나 액션을 추가해주세요.");
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
          .filter(({ act }) => {
            if (act.type === "wait" || act.type === "navigate") return false;
            if (act.type === "dragAndDrop" || (act.sourceSelector && act.targetSelector)) {
              return (!act.sourceSelector || act.sourceSelector.trim() === "") ||
                     (!act.targetSelector || act.targetSelector.trim() === "");
            }
            return !act.selector || act.selector.trim() === "";
          });

        if (missingActions.length > 0) {
          const summaryList = missingActions
            .slice(0, 3)
            .map(({ index, act }) => `• #${index} [${act.description || act.type}]`)
            .join("\n");
          const moreText = missingActions.length > 3 ? ` 외 ${missingActions.length - 3}개` : "";

          const proceed = await showAppConfirm(
            `⚠️ 다음 ${missingActions.length}개 액션의 셀렉터가 비어 있습니다:\n\n${summaryList}${moreText}\n\n셀렉터가 비어있어도 화면 텍스트로 자동 추론을 시도하지만, 직접 지정하는 것이 가장 정확합니다.\n\n이대로 계속 녹화를 진행하시겠습니까?`
          );

          if (!proceed) {
            // Scroll to the first missing card and focus its selector input
            const firstMissingIndex = missingActions[0].index - 1;
            const targetCard = actionsList.querySelector(`[data-index="${firstMissingIndex}"]`);
            if (targetCard) {
              targetCard.scrollIntoView({ behavior: "smooth", block: "center" });
              const selInput = targetCard.querySelector('[data-field="selector"], [data-field="sourceSelector"]');
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

// 12-2. Run Video Render (Scenario-Isolated Background Remotion Render)
async function handleRenderVideo(targetSlug = null) {
      const slug = targetSlug || slugInput.value.trim() || currentSlug || selectedScenario;
      if (!slug) {
        alert("렌더링할 시나리오를 선택하거나 Slug를 입력해주세요.");
        return;
      }

      // Pre-check scenario details
      const details = scenarioDetailsCache[slug];
      if (details && !details.hasVideo) {
        alert(`'${slug}' 시나리오의 원본 녹화 비디오가 없습니다.\n먼저 [브라우저 녹화 실행] 또는 [즉시 재녹화]로 녹화를 완료해주세요.`);
        return;
      }

      const fps = renderFpsSelect && renderFpsSelect.value === "60" ? 60 : 30;
      renderDockDismissedTaskId = null;

      try {
        const res = await fetch("/api/render/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slug, fps }),
        });

        const data = await res.json();
        if (!data.success) {
          throw new Error(data.error || "렌더링 요청 실패");
        }

        if (data.task && (data.task.status === "running" || !activeRenderTask)) {
          activeRenderTask = data.task;
        }
        if (Array.isArray(data.queue)) {
          renderQueueList = data.queue;
        }
        updateRenderUI(true);
      } catch (err) {
        alert(`❌ 백그라운드 렌더링 시작 실패: ${err.message}`);
      }
    }

async function handleStopRender(slug = null) {
      try {
        const res = await fetch("/api/render/stop", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(slug ? { slug } : {}),
        });
        const data = await res.json();
        activeRenderTask = data.task || null;
        renderQueueList = Array.isArray(data.queue) ? data.queue : [];
        updateRenderUI(true);
      } catch (err) {
        console.error("Failed to stop background render:", err);
      }
    }

function updateRenderUI(forceRebuildCards = false) {
      const isRunning =
        activeRenderTask && (activeRenderTask.status === "running" || activeRenderTask.status === "queued");

      if (btnPlayerRender) {
        if (isRunning && selectedScenario && activeRenderTask.slug === selectedScenario) {
          const pct = Number(activeRenderTask.progress || 0);
          btnPlayerRender.textContent = `⏳ 렌더링 중 (${pct}%)`;
          btnPlayerRender.disabled = true;
        } else if (
          selectedScenario &&
          Array.isArray(renderQueueList) &&
          renderQueueList.some((q) => q && q.slug === selectedScenario)
        ) {
          btnPlayerRender.textContent = "🕒 렌더링 대기열 등록됨";
          btnPlayerRender.disabled = true;
        } else if (isRunning) {
          btnPlayerRender.textContent = "🎞️ MP4 렌더링 (대기열)";
          btnPlayerRender.disabled = false;
        } else {
          btnPlayerRender.textContent = "🎞️ MP4 렌더링";
          btnPlayerRender.disabled = false;
        }
      }

      if (forceRebuildCards) {
        renderScenarioList();
      } else if (isRunning && activeRenderTask.slug) {
        const cardBadge = document.querySelector(
          `.status-tag[data-render-badge="${CSS.escape(activeRenderTask.slug)}"]`
        );
        if (cardBadge) {
          cardBadge.textContent = `⏳ 렌더링 ${activeRenderTask.progress || 0}%`;
        }
      }

      const playerLiveBadge = document.getElementById("player-live-render-badge");
      if (playerLiveBadge && isRunning && activeRenderTask.slug === selectedScenario) {
        playerLiveBadge.textContent = `⏳ 렌더링 ${activeRenderTask.progress || 0}% (${
          activeRenderTask.fps || 30
        }fps)`;
      }

      if (!backgroundRenderDock) return;

      if (isRunning) {
        backgroundRenderDock.classList.remove("hidden", "dock-completed", "dock-failed");
        const pct = Math.min(100, Math.max(0, Number(activeRenderTask.progress || 0)));
        if (renderDockTitle) renderDockTitle.textContent = "백그라운드 렌더링 진행 중";
        if (renderDockSlug) renderDockSlug.textContent = activeRenderTask.slug || "-";
        if (renderDockFps) renderDockFps.textContent = `${activeRenderTask.fps || 30}fps`;
        if (renderDockQueue) {
          const qLen = Array.isArray(renderQueueList) ? renderQueueList.length : 0;
          renderDockQueue.textContent = `대기 ${qLen}`;
          renderDockQueue.classList.toggle("hidden", qLen === 0);
        }
        if (renderDockProgressFill) {
          renderDockProgressFill.style.width = `${pct}%`;
        }
        if (renderDockDetail) {
          const framesText =
            activeRenderTask.totalFrames > 0
              ? `${activeRenderTask.renderedFrames || 0}/${activeRenderTask.totalFrames}f`
              : "번들 준비 중";
          renderDockDetail.textContent = `${pct}% (${framesText}) · 다른 시나리오 녹화/편집 가능`;
        }
        if (btnStopRenderDock) btnStopRenderDock.classList.remove("hidden");
        if (btnOpenRenderedDock) btnOpenRenderedDock.classList.add("hidden");
        if (btnDownloadRenderDock) btnDownloadRenderDock.classList.add("hidden");
        if (btnCloseRenderDock) btnCloseRenderDock.classList.add("hidden");
        return;
      }

      if (lastCompletedRenderTask && renderDockDismissedTaskId !== lastCompletedRenderTask.id) {
        const doneTask = lastCompletedRenderTask;
        backgroundRenderDock.classList.remove("hidden");
        if (renderDockSlug) renderDockSlug.textContent = doneTask.slug || "-";
        if (renderDockFps) renderDockFps.textContent = `${doneTask.fps || 30}fps`;
        if (renderDockQueue) renderDockQueue.classList.add("hidden");
        if (btnStopRenderDock) btnStopRenderDock.classList.add("hidden");
        if (btnCloseRenderDock) btnCloseRenderDock.classList.remove("hidden");

        if (doneTask.status === "completed") {
          backgroundRenderDock.classList.add("dock-completed");
          backgroundRenderDock.classList.remove("dock-failed");
          if (renderDockTitle) renderDockTitle.textContent = "✅ 최종 MP4 렌더링 완료";
          if (renderDockProgressFill) renderDockProgressFill.style.width = "100%";
          const elapsedSec =
            doneTask.endTime && doneTask.startTime
              ? ((doneTask.endTime - doneTask.startTime) / 1000).toFixed(1)
              : null;
          if (renderDockDetail) {
            renderDockDetail.textContent = elapsedSec
              ? `'${doneTask.slug}' 합성 완료 (${elapsedSec}초 소요)`
              : `'${doneTask.slug}' 합성 완료`;
          }
          if (btnOpenRenderedDock) {
            btnOpenRenderedDock.classList.remove("hidden");
            btnOpenRenderedDock.dataset.slug = doneTask.slug;
          }
          if (btnDownloadRenderDock) {
            btnDownloadRenderDock.classList.remove("hidden");
            btnDownloadRenderDock.href = `/api/download/${doneTask.slug}`;
            btnDownloadRenderDock.download = `${doneTask.slug}-final.mp4`;
          }
        } else {
          backgroundRenderDock.classList.add("dock-failed");
          backgroundRenderDock.classList.remove("dock-completed");
          if (renderDockTitle) {
            renderDockTitle.textContent =
              doneTask.status === "stopped" ? "⏹️ 백그라운드 렌더링 취소됨" : "❌ 백그라운드 렌더링 실패";
          }
          if (renderDockDetail) {
            renderDockDetail.textContent =
              doneTask.status === "stopped"
                ? `'${doneTask.slug}' 렌더링이 취소되었습니다.`
                : `'${doneTask.slug}' 렌더링 중 오류가 발생했습니다.`;
          }
          if (btnOpenRenderedDock) btnOpenRenderedDock.classList.add("hidden");
          if (btnDownloadRenderDock) btnDownloadRenderDock.classList.add("hidden");
        }
        return;
      }

      backgroundRenderDock.classList.add("hidden");
    }

// 13. SSE for Terminal Logs & Isolated Background Render Events
function initSSE() {
      if (sseSource) sseSource.close();
      sseSource = new EventSource("/api/record/stream");

      sseSource.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === "render-snapshot") {
            activeRenderTask = data.task || null;
            renderQueueList = Array.isArray(data.queue) ? data.queue : [];
            updateRenderUI(true);
            return;
          }
          if (data.type === "render-progress" || data.type === "render-log") {
            if (data.task) {
              activeRenderTask = data.task;
            } else if (activeRenderTask && (!data.slug || activeRenderTask.slug === data.slug)) {
              if (typeof data.percent === "number") activeRenderTask.progress = data.percent;
              if (typeof data.renderedFrames === "number") activeRenderTask.renderedFrames = data.renderedFrames;
              if (typeof data.totalFrames === "number") activeRenderTask.totalFrames = data.totalFrames;
            }
            if (Array.isArray(data.queue)) {
              renderQueueList = data.queue;
            }
            updateRenderUI(false);
            return;
          }
          if (data.type === "render-status") {
            const rTask = data.task;
            renderQueueList = Array.isArray(data.queue) ? data.queue : [];
            if (rTask && (rTask.status === "running" || rTask.status === "queued")) {
              activeRenderTask = rTask;
              updateRenderUI(true);
            } else if (rTask) {
              lastCompletedRenderTask = rTask;
              if (activeRenderTask && activeRenderTask.id === rTask.id) {
                activeRenderTask = null;
              }
              if (rTask.status === "completed") {
                delete scenarioDetailsCache[rTask.slug];
                fetchScenarios();
                fetchStatus();
                // If the user is currently viewing this exact scenario in Studio and not playing raw video, refresh its rendered badge & download button without switching tabs
                if (selectedScenario === rTask.slug) {
                  const isUserPlaying = videoPlayer && !videoPlayer.paused;
                  if (!isUserPlaying) {
                    selectScenario(rTask.slug, "rendered");
                  } else {
                    fetch(`/api/render/info/${rTask.slug}`)
                      .then((r) => (r.ok ? r.json() : null))
                      .then((rInfo) => {
                        if (rInfo && rInfo.exists && btnDownloadVideo) {
                          btnDownloadVideo.classList.remove("hidden");
                          btnDownloadVideo.href = rInfo.downloadUrl;
                          btnDownloadVideo.download = `${rTask.slug}-final.mp4`;
                          const sizeMb = ((rInfo.fileSizeBytes || 0) / (1024 * 1024)).toFixed(1);
                          btnDownloadVideo.innerHTML = `💾 다운로드 <small>(${sizeMb}MB)</small>`;
                        }
                      })
                      .catch(() => {});
                  }
                }
              }
              updateRenderUI(true);
            }
            return;
          }

          if (data.type === "log") {
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
                terminalStatusText.textContent = `실행 중 (${data.task.slug})`;
              }
            }
          } else if (data.type === "status") {
            if (data.task.status === "completed") {
              terminalStatusText.textContent = "녹화 완료";
              if (terminalLoginBanner) terminalLoginBanner.style.display = "none";
              if (data.task.slug) {
                delete scenarioDetailsCache[data.task.slug];
              }
              fetchScenarios();
              fetchStatus();
              setTimeout(() => {
                if (data.task.slug) {
                  delete scenarioDetailsCache[data.task.slug];
                }
                selectScenario(data.task.slug, "raw");
                switchTab("tab-scenarios");
              }, 1500);
            } else if (data.task.status === "failed") {
              terminalStatusText.textContent = "녹화 실패";
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
        // Also signal interactive login orchestrator
        fetch("/api/auth/complete", { method: "POST" }).catch(() => {});

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
      if (btnValidateProject) btnValidateProject.addEventListener("click", handleSaveConfig);
      if (btnGenerate) btnGenerate.addEventListener("click", handleGeneratePlan);
      if (btnSavePlan) btnSavePlan.addEventListener("click", () => handleSavePlan(false));
      if (btnRunPipeline) btnRunPipeline.addEventListener("click", handleRunPipeline);
      if (btnRenderVideo) {
        btnRenderVideo.addEventListener("click", () => handleRenderVideo());
      }
      if (btnPlayerRender) {
        btnPlayerRender.addEventListener("click", () => handleRenderVideo(selectedScenario));
      }
      if (btnStopRenderDock) {
        btnStopRenderDock.addEventListener("click", () => handleStopRender());
      }
      if (btnCloseRenderDock) {
        btnCloseRenderDock.addEventListener("click", () => {
          if (lastCompletedRenderTask) {
            renderDockDismissedTaskId = lastCompletedRenderTask.id;
          }
          if (backgroundRenderDock) backgroundRenderDock.classList.add("hidden");
        });
      }
      if (btnOpenRenderedDock) {
        btnOpenRenderedDock.addEventListener("click", () => {
          const targetSlug = btnOpenRenderedDock.dataset.slug || lastCompletedRenderTask?.slug;
          if (targetSlug) {
            switchTab("tab-scenarios");
            selectScenario(targetSlug, "rendered");
          }
        });
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
          if (promptInput) promptInput.value = "";
          if (slugInput) slugInput.value = "";
          const polishFeedbackEl = document.getElementById("prompt-polish-feedback");
          if (polishFeedbackEl) polishFeedbackEl.style.display = "none";
          if (promptInput) promptInput.focus();
        });
      }

      // Method 1-A: Canonical Arrow-Chain Preset Chips
      document.querySelectorAll(".prompt-preset-chip").forEach((chip) => {
        chip.addEventListener("click", () => {
          const key = chip.getAttribute("data-preset-key") || chip.getAttribute("data-chain-preset");
          const preset = PROMPT_CHAIN_PRESETS[key];
          if (!preset || !promptInput) return;
          promptInput.value = preset.prompt;
          if (slugInput && !slugInput.value.trim()) {
            slugInput.value = preset.slug;
          }
          const polishFeedbackEl = document.getElementById("prompt-polish-feedback");
          if (polishFeedbackEl) {
            polishFeedbackEl.classList.remove("hidden");
            polishFeedbackEl.style.display = "block";
            polishFeedbackEl.innerHTML = `📋 <b>[${chip.textContent.trim()}] 정석 화살표 체인 템플릿 적용됨</b> — 작은따옴표(' ') 안의 양식명·제목·결재자만 원하시는 값으로 바꿔 바로 생성하세요.`;
          }
          promptInput.focus();
        });
      });

      // Method 1-B: Interactive Step-Chain Builder Chips (appends " -> <step>")
      document.querySelectorAll(".prompt-step-chip").forEach((chip) => {
        chip.addEventListener("click", () => {
          const stepText = chip.getAttribute("data-step");
          if (!stepText || !promptInput) return;
          const current = promptInput.value.trim();
          if (!current) {
            promptInput.value = stepText;
          } else if (current.endsWith("->")) {
            promptInput.value = `${current} ${stepText}`;
          } else {
            promptInput.value = `${current} -> ${stepText}`;
          }
          promptInput.focus();
          promptInput.scrollTop = promptInput.scrollHeight;
        });
      });

      // Method 2: One-Click Prompt Polisher Button ("🪄 정석 포맷 다듬기")
      const btnPolishPrompt = document.getElementById("btn-polish-prompt");
      if (btnPolishPrompt) {
        btnPolishPrompt.addEventListener("click", (e) => {
          // Shift+Click uses LLM deep refinement; regular click uses instant deterministic + smart refinement
          handlePolishPrompt(Boolean(e.shiftKey));
        });
      }

      // Way A: Live Eyedropper & Action Demonstration Recorder Bindings
      const btnLiveDemoRecorder = document.getElementById("btn-live-demo-recorder");
      const btnConfirmRecorderDone = document.getElementById("btn-confirm-recorder-done");
      const btnCancelRecorderModal = document.getElementById("btn-cancel-recorder-modal");
      const btnCloseRecorderModal = document.getElementById("btn-close-recorder-modal");

      if (btnLiveDemoRecorder) {
        btnLiveDemoRecorder.addEventListener("click", () => {
          startLiveDemoRecorder();
        });
      }
      if (btnConfirmRecorderDone) {
        btnConfirmRecorderDone.addEventListener("click", () => {
          finishLiveDemoRecorder();
        });
      }
      if (btnCancelRecorderModal) {
        btnCancelRecorderModal.addEventListener("click", () => {
          cancelLiveDemoRecorder();
        });
      }
      if (btnCloseRecorderModal) {
        btnCloseRecorderModal.addEventListener("click", () => {
          cancelLiveDemoRecorder();
        });
      }

      const pillAiEl = document.getElementById("pill-ai");
      if (pillAiEl) {
        pillAiEl.addEventListener("click", () => {
          openAiUsageModal();
        });
      }

      document.querySelectorAll(".ai-mode-seg-btn").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          const targetMode = btn.getAttribute("data-ai-mode");
          if (targetMode === "api" || targetMode === "cli") {
            switchAiExecutionModeQuick(targetMode);
          }
        });
      });

      if (pillGw) {
        pillGw.addEventListener("click", () => {
          switchTab("tab-generator");
          const details = targetBaseUrlInput.closest("details");
          if (details) details.open = true;
          targetBaseUrlInput.focus();
          targetBaseUrlInput.select();
        });
      }

      const pillAuth = document.getElementById("pill-auth");
      const loginModalOverlay = document.getElementById("login-modal-overlay");
      const btnCloseLoginModal = document.getElementById("btn-close-login-modal");
      const btnCancelLoginModal = document.getElementById("btn-cancel-login-modal");
      const btnConfirmLoginDone = document.getElementById("btn-confirm-login-done");
      const loginModalStatusText = document.getElementById("login-modal-status-text");

      const closeLoginModal = () => {
        if (loginModalOverlay) loginModalOverlay.classList.add("hidden");
      };

      if (btnCloseLoginModal) {
        btnCloseLoginModal.addEventListener("click", () => {
          fetch("/api/auth/complete", { method: "POST" }).catch(() => {});
          closeLoginModal();
        });
      }

      if (btnCancelLoginModal) {
        btnCancelLoginModal.addEventListener("click", () => {
          fetch("/api/auth/complete", { method: "POST" }).catch(() => {});
          closeLoginModal();
        });
      }

      if (btnConfirmLoginDone) {
        btnConfirmLoginDone.addEventListener("click", async () => {
          if (loginModalStatusText) {
            loginModalStatusText.textContent = "⏳ 세션 저장 및 브라우저 창 닫는 중...";
          }
          btnConfirmLoginDone.disabled = true;
          try {
            await fetch("/api/auth/complete", { method: "POST" });
          } catch (e) {
            console.error("로그인 완료 신호 전송 실패:", e);
          } finally {
            setTimeout(() => {
              btnConfirmLoginDone.disabled = false;
            }, 1000);
          }
        });
      }

      if (pillAuth) {
        pillAuth.addEventListener("click", async () => {
          let url = targetBaseUrlInput ? targetBaseUrlInput.value.trim() : "";
          if (url && !/^https?:\/\//i.test(url)) {
            url = "http://" + url;
            targetBaseUrlInput.value = url;
          }

          const authLabel = document.getElementById("pill-auth-label");
          if (authLabel) authLabel.textContent = "로그인 창 여는 중...";

          // Open interactive login modal
          if (loginModalOverlay) {
            loginModalOverlay.classList.remove("hidden");
            if (loginModalStatusText) {
              loginModalStatusText.textContent = `브라우저 창(${url || '설정 URL'})에서 로그인 대기 중... 완료 후 버튼을 눌러주세요`;
            }
          }

          try {
            const res = await fetch("/api/auth/login", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ url: url || undefined }),
            });
            const result = await res.json();
            closeLoginModal();

            if (result.success) {
              alert("🎉 로그인 세션이 성공적으로 저장되었습니다!");
            } else {
              alert(result.message || "로그인이 완료되지 않았습니다.");
            }
          } catch (e) {
            closeLoginModal();
            alert("로그인 요청 실패: " + e.message);
          } finally {
            fetchStatus();
          }
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

      if (btnAddAction) {
        btnAddAction.addEventListener("click", () => {
          const targetIdx = currentPlan && currentPlan.actions ? currentPlan.actions.length : 0;
          insertActionAt(targetIdx);
        });
      }

      const btnClearPlan = document.getElementById("btn-clear-plan");
      if (btnClearPlan) {
        btnClearPlan.addEventListener("click", () => {
          currentPlan = {
            url: targetBaseUrlInput ? targetBaseUrlInput.value.trim() || "https://gwdev.bc.ac.kr/" : "https://gwdev.bc.ac.kr/",
            viewport: { width: 1920, height: 1080 },
            requiresLogin: true,
            actions: [],
          };
          currentSlug = "";
          if (slugInput) slugInput.value = "";
          if (editorScenarioSelect) editorScenarioSelect.value = "";
          if (planSlugBadge) planSlugBadge.textContent = "시나리오 미선택";
          if (explanationText) {
            explanationText.textContent =
              "상단 [💧 브라우저 띄워서 시범 보이기]로 동작을 시연하거나, 드롭다운에서 기존 시나리오를 선택하면 단계별 액션 카드가 표시됩니다.";
          }
          renderActionCards();
        });
      }

      if (btnClearTerminal) {
        btnClearTerminal.addEventListener("click", () => {
          if (terminalOutput) terminalOutput.innerHTML = "";
        });
      }

      if (btnStopTask) {
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
      }

      if (btnSetActive) {
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
      }

      if (btnReRecord) {
        btnReRecord.addEventListener("click", () => {
          if (!selectedScenario) return;
          loadScenarioIntoEditor(selectedScenario, true);
        });
      }

      if (btnDirectRerecord) {
        btnDirectRerecord.addEventListener("click", async () => {
          if (!selectedScenario) {
            alert("먼저 재녹화할 시나리오를 선택해주세요.");
            return;
          }
          const slug = selectedScenario;
          switchTab("tab-terminal");
          appendTerminalLog(`🚀 '${slug}' 시나리오 즉시 재녹화 파이프라인 요청 중...`, "system-line");
          try {
            const res = await fetch("/api/scenarios/record", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                slug,
                headed: headedToggle ? headedToggle.checked : true,
                login: loginToggle ? loginToggle.checked : false,
              }),
            });
            const data = await res.json();
            if (!data.success) throw new Error(data.error);
            if (terminalStatusText) terminalStatusText.textContent = `실행 중 (${slug})`;
          } catch (err) {
            appendTerminalLog(`❌ 재녹화 시작 실패: ${err.message}`, "log-error");
          }
        });
      }

      if (editorScenarioSelect) {
        editorScenarioSelect.addEventListener("change", (e) => {
          const slug = e.target.value;
          if (slug) {
            loadScenarioIntoEditor(slug, false);
          }
        });
      }

      if (btnToggleCompactWaits) {
        btnToggleCompactWaits.addEventListener("click", () => {
          compactWaitsEnabled = !compactWaitsEnabled;
          btnToggleCompactWaits.classList.toggle("active-toggle", compactWaitsEnabled);
          btnToggleCompactWaits.textContent = compactWaitsEnabled
            ? "⏳ 대기(WAIT) 간소화"
            : "⏳ 대기(WAIT) 전체 펼침";
          renderActionCards();
        });
      }

      // Scenario Library Search & Filter Chips
      if (scenarioSearchInput) {
        scenarioSearchInput.addEventListener("input", (e) => {
          scenarioSearchQuery = e.target.value || "";
          renderScenarioList();
        });
      }

      scenarioFilterChips.forEach((chip) => {
        chip.addEventListener("click", () => {
          scenarioFilterChips.forEach((c) => c.classList.remove("active"));
          chip.classList.add("active");
          scenarioFilterMode = chip.getAttribute("data-filter") || "all";
          renderScenarioList();
        });
      });

      // Studio Workspace Sub-Tabs (Moments / Narration / JSON)
      studioSubtabBtns.forEach((btn) => {
        btn.addEventListener("click", () => {
          const targetId = btn.getAttribute("data-subtab");
          studioSubtabBtns.forEach((b) => b.classList.toggle("active", b === btn));
          studioSubtabPanes.forEach((p) => p.classList.toggle("active", p.id === targetId));
        });
      });

      // Video Player Timecode, Playhead & Step Sync (including Real-Time Hold/Stretch Preview)
      if (videoPlayer) {
        videoPlayer.addEventListener("timeupdate", updateVideoPlaybackSync);
        videoPlayer.addEventListener("loadedmetadata", () => {
          stopRealtimeHoldAndAudio();
          updateVideoPlaybackSync();
        });
        videoPlayer.addEventListener("play", () => {
          if (realtimeHoldState.isProgrammaticResume) {
            realtimeHoldState.isProgrammaticResume = false;
            startRealtimePreviewLoop();
            return;
          }
          // If user manually clicked play while a hold was active, complete the current hold and continue forward
          if (realtimeHoldState.active) {
            if (realtimeHoldState.regionIdx >= 0) {
              realtimeHoldState.completedRegions.add(realtimeHoldState.regionIdx);
            }
            realtimeHoldState.active = false;
            realtimeHoldState.isProgrammaticPause = false;
            realtimeHoldState.regionIdx = -1;
            const badgeEl = document.getElementById("live-timewarp-badge");
            if (badgeEl) badgeEl.classList.add("hidden");
          }
          // If playing from the very start of the video, reset completed hold & cue sets
          if ((videoPlayer.currentTime || 0) <= 0.15) {
            realtimeHoldState.completedRegions.clear();
            realtimeHoldState.playedCueIds.clear();
            realtimeHoldState.lastPlayedCueId = null;
          }
          startRealtimePreviewLoop();
        });
        videoPlayer.addEventListener("pause", () => {
          if (realtimeHoldState.isProgrammaticPause || realtimeHoldState.active) {
            realtimeHoldState.isProgrammaticPause = false;
            return;
          }
          // User manually paused playback: preserve completed hold regions so unpausing doesn't re-trigger past holds
          stopRealtimeHoldAndAudio(true);
          updateVideoPlaybackSync();
        });
        videoPlayer.addEventListener("seeking", () => {
          if (realtimeHoldState.isProgrammaticSeek) {
            realtimeHoldState.isProgrammaticSeek = false;
            return;
          }
          // Genuine user scrub on native video player controls
          realtimeHoldState.active = false;
          realtimeHoldState.isProgrammaticPause = false;
          realtimeHoldState.isProgrammaticResume = false;
          realtimeHoldState.regionIdx = -1;
          if (activePreviewAudio) {
            try {
              activePreviewAudio.pause();
            } catch {}
            activePreviewAudio = null;
          }
          const badgeEl = document.getElementById("live-timewarp-badge");
          if (badgeEl) badgeEl.classList.add("hidden");
          syncCompletedHoldRegionsForSeek(videoPlayer.currentTime || 0, null);
        });
        videoPlayer.addEventListener("ended", () => {
          stopRealtimeHoldAndAudio();
          updateVideoPlaybackSync();
        });
      }

      if (videoSpeedSelect && videoPlayer) {
        videoSpeedSelect.addEventListener("change", () => {
          const spd = parseFloat(videoSpeedSelect.value) || 1.0;
          videoPlayer.playbackRate = spd;
          if (activePreviewAudio) activePreviewAudio.playbackRate = spd;
        });
      }

      if (btnTimelineZoomIn) {
        btnTimelineZoomIn.addEventListener("click", () => {
          const next = timelineZoomLevel < 2 ? timelineZoomLevel + 0.5 : Math.round(timelineZoomLevel * 1.4 * 2) / 2;
          setTimelineZoom(next);
        });
      }
      if (btnTimelineZoomOut) {
        btnTimelineZoomOut.addEventListener("click", () => {
          const next = timelineZoomLevel <= 2 ? timelineZoomLevel - 0.5 : Math.round((timelineZoomLevel / 1.4) * 2) / 2;
          setTimelineZoom(next);
        });
      }
      if (timelineZoomPresetBtns && timelineZoomPresetBtns.length > 0) {
        timelineZoomPresetBtns.forEach((btn) => {
          btn.addEventListener("click", () => {
            const z = parseFloat(btn.getAttribute("data-zoom") || "1");
            setTimelineZoom(z);
          });
        });
      }

      if (timelineBarWrapper && videoPlayer) {
        const getStageRect = () => (timelineVisualBar || timelineBarWrapper).getBoundingClientRect();

        const clientXToRawSec = (clientX) => {
          const rect = getStageRect();
          const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / Math.max(1, rect.width)));
          const details = scenarioDetailsCache[selectedScenario];
          const editPlan = details?.editPlan;
          const narration = details?.narration || editPlan?.narration;
          const isMergedScenario =
            (Array.isArray(narration?.mergedFromSlugs) && narration.mergedFromSlugs.length > 0) ||
            (Array.isArray(details?.browsePlan?.mergedFromSlugs) && details.browsePlan.mergedFromSlugs.length > 0);
          if (currentVideoMode === "raw" && !isMergedScenario && editPlan?.totalDurationFrames) {
            const fps = Number(editPlan.fps || 60);
            const compTotalMs = (editPlan.totalDurationFrames / fps) * 1000;
            const targetCompMs = ratio * compTotalMs;
            const targetRawMs = compTimeMsToVideoTimeMs(targetCompMs, editPlan);
            return Math.min(videoPlayer.duration || 0, Math.max(0, targetRawMs / 1000));
          }
          return ratio * (videoPlayer.duration || 0);
        };

        const wheelTarget = timelineScrollViewport || timelineBarWrapper;
        wheelTarget.addEventListener(
          "wheel",
          (e) => {
            if (e.ctrlKey || e.metaKey) {
              e.preventDefault();
              const vpRect = wheelTarget.getBoundingClientRect();
              const cursorOffsetX = Math.max(0, Math.min(vpRect.width, e.clientX - vpRect.left));
              const anchorRatio = (wheelTarget.scrollLeft + cursorOffsetX) / Math.max(1, wheelTarget.scrollWidth);
              const factor = e.deltaY < 0 ? 1.25 : 0.8;
              setTimelineZoom(timelineZoomLevel * factor, anchorRatio, cursorOffsetX);
            }
          },
          { passive: false }
        );

        timelineBarWrapper.addEventListener("mousedown", (e) => {
          if (e.target && e.target.closest && e.target.closest(".timeline-track-labels")) return;
          if (!e.shiftKey || !videoPlayer.duration) return;
          e.preventDefault();
          const startRawSec = clientXToRawSec(e.clientX);
          timelineDragCutState = { startRawSec, moved: false };
        });

        window.addEventListener("mousemove", (e) => {
          if (!timelineDragCutState || !videoPlayer.duration) return;
          timelineDragCutState.moved = true;
          const curRawSec = clientXToRawSec(e.clientX);
          const inSec = Math.min(timelineDragCutState.startRawSec, curRawSec);
          const outSec = Math.max(timelineDragCutState.startRawSec, curRawSec);
          const cutInInput = document.getElementById("cut-in-input");
          const cutOutInput = document.getElementById("cut-out-input");
          if (cutInInput) cutInInput.value = inSec.toFixed(1);
          if (cutOutInput) cutOutInput.value = outSec.toFixed(1);
          updateCutSelectionUI();
        });

        window.addEventListener("mouseup", () => {
          if (timelineDragCutState) {
            setTimeout(() => {
              timelineDragCutState = null;
            }, 30);
          }
        });

        timelineBarWrapper.addEventListener("click", (e) => {
          if (e.target && e.target.closest && e.target.closest(".timeline-track-labels")) return;
          if (!videoPlayer.duration) return;
          if (timelineDragCutState && timelineDragCutState.moved) return;
          const wasPlaying = !videoPlayer.paused || realtimeHoldState.active;
          stopRealtimeHoldAndAudio();
          const rect = getStageRect();
          const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / Math.max(1, rect.width)));
          const details = scenarioDetailsCache[selectedScenario];
          const editPlan = details?.editPlan;
          const narration = details?.narration || editPlan?.narration;
          const isMergedScenario =
            (Array.isArray(narration?.mergedFromSlugs) && narration.mergedFromSlugs.length > 0) ||
            (Array.isArray(details?.browsePlan?.mergedFromSlugs) && details.browsePlan.mergedFromSlugs.length > 0);
          if (currentVideoMode === "raw" && !isMergedScenario && editPlan?.totalDurationFrames) {
            const fps = Number(editPlan.fps || 60);
            const compTotalMs = (editPlan.totalDurationFrames / fps) * 1000;
            const targetCompMs = ratio * compTotalMs;
            const targetRawMs = compTimeMsToVideoTimeMs(targetCompMs, editPlan);
            const targetRawSec = Math.min(videoPlayer.duration, Math.max(0, targetRawMs / 1000));
            syncCompletedHoldRegionsForSeek(targetRawSec, targetCompMs);
            realtimeHoldState.isProgrammaticSeek = true;
            videoPlayer.currentTime = targetRawSec;
          } else {
            realtimeHoldState.isProgrammaticSeek = true;
            videoPlayer.currentTime = ratio * videoPlayer.duration;
          }
          if (wasPlaying) {
            realtimeHoldState.isProgrammaticResume = true;
            videoPlayer.play().catch(() => {
              realtimeHoldState.isProgrammaticResume = false;
            });
          }
          updateVideoPlaybackSync();
        });
      }

      const btnSetCutIn = document.getElementById("btn-set-cut-in");
      const btnSetCutOut = document.getElementById("btn-set-cut-out");
      const cutInInput = document.getElementById("cut-in-input");
      const cutOutInput = document.getElementById("cut-out-input");
      const btnPreviewCutRange = document.getElementById("btn-preview-cut-range");
      const btnClearCutRange = document.getElementById("btn-clear-cut-range");
      const btnApplyVideoCut = document.getElementById("btn-apply-video-cut");
      const btnUndoVideoCut = document.getElementById("btn-undo-video-cut");
      const btnRestoreOrigVideo = document.getElementById("btn-restore-orig-video");

      if (btnSetCutIn) btnSetCutIn.addEventListener("click", handleSetCutInFromPlayhead);
      if (btnSetCutOut) btnSetCutOut.addEventListener("click", handleSetCutOutFromPlayhead);
      if (cutInInput) cutInInput.addEventListener("input", updateCutSelectionUI);
      if (cutOutInput) cutOutInput.addEventListener("input", updateCutSelectionUI);
      if (btnPreviewCutRange) btnPreviewCutRange.addEventListener("click", handlePreviewCutRange);
      if (btnClearCutRange) btnClearCutRange.addEventListener("click", handleClearCutRange);
      if (btnApplyVideoCut) btnApplyVideoCut.addEventListener("click", handleApplyVideoCut);
      if (btnUndoVideoCut) btnUndoVideoCut.addEventListener("click", () => handleRestoreVideoCut("undo"));
      if (btnRestoreOrigVideo) btnRestoreOrigVideo.addEventListener("click", () => handleRestoreVideoCut("orig"));

      if (btnCopyJson && jsonViewerContent) {
        btnCopyJson.addEventListener("click", () => {
          const txt = jsonViewerContent.textContent || "";
          navigator.clipboard.writeText(txt).then(() => {
            const orig = btnCopyJson.textContent;
            btnCopyJson.textContent = "✅ 복사 완료!";
            setTimeout(() => {
              btnCopyJson.textContent = orig || "📋 JSON 복사";
            }, 1500);
          });
        });
      }

      jsonTabBtns.forEach((btn) => {
        btn.addEventListener("click", () => {
          updateJsonViewer(btn.getAttribute("data-json"));
        });
      });

      const narrationStyleSelect = document.getElementById("narration-style-select");
      const narrationPitchSelect = document.getElementById("narration-pitch-select");
      const narrationVoiceSelect = document.getElementById("narration-voice-select");
      const narrationRateSelect = document.getElementById("narration-rate-select");
      if (narrationStyleSelect && narrationPitchSelect) {
        narrationStyleSelect.addEventListener("change", () => {
          const recPitch = STYLE_RECOMMENDED_PITCH[narrationStyleSelect.value];
          if (recPitch) {
            narrationPitchSelect.value = recPitch;
          }
          const hasCues = document.querySelectorAll("#narration-cues-container .narration-cue-row").length > 0;
          if (hasCues) runAutoSynthesizeAndFitNow();
        });
      }
      [narrationVoiceSelect, narrationRateSelect, narrationPitchSelect].forEach((sel) => {
        if (sel) {
          sel.addEventListener("change", () => {
            const hasCues = document.querySelectorAll("#narration-cues-container .narration-cue-row").length > 0;
            if (hasCues) runAutoSynthesizeAndFitNow();
          });
        }
      });

      const narrationEnabledToggle = document.getElementById("narration-enabled-toggle");
      const narrationSubtitleToggle = document.getElementById("narration-subtitle-toggle");
      const narrationTocToggle = document.getElementById("narration-toc-toggle");
      [narrationEnabledToggle, narrationSubtitleToggle, narrationTocToggle].forEach((chk) => {
        if (chk) {
          chk.addEventListener("change", () => {
            if (!selectedScenario || !scenarioDetailsCache[selectedScenario]) return;
            const updated = collectNarrationFromUI({ sortByStartTime: false });
            scenarioDetailsCache[selectedScenario].narration = updated;
            if (scenarioDetailsCache[selectedScenario].editPlan) {
              scenarioDetailsCache[selectedScenario].editPlan.narration = updated;
            }
            renderIntroTocEditor(scenarioDetailsCache[selectedScenario], updated);
            updateVideoProgressUI();
            updateJsonViewer("narration");
            markNarrationUnapplied("음성·자막·목차 표시 설정이 변경되었습니다. 영상에 반영하려면 [지금 영상에 즉시 반영]을 눌러주세요.", {
              needsSlideBake: chk === narrationTocToggle,
            });
            saveNarrationTimingQuick();
          });
        }
      });

      const btnGenerateNarration = document.getElementById("btn-generate-narration");
      if (btnGenerateNarration) {
        btnGenerateNarration.addEventListener("click", handleGenerateNarration);
      }

      const btnAddNarrationIntro = document.getElementById("btn-add-narration-intro");
      if (btnAddNarrationIntro) {
        btnAddNarrationIntro.addEventListener("click", handleAddNarrationIntro);
      }

      const btnAddNarrationCue = document.getElementById("btn-add-narration-cue");
      if (btnAddNarrationCue) {
        btnAddNarrationCue.addEventListener("click", handleAddNarrationCue);
      }

      const btnSaveNarration = document.getElementById("btn-save-narration");
      if (btnSaveNarration) {
        btnSaveNarration.addEventListener("click", handleSaveNarration);
      }

      // UI Diet Collapsible Toolbars & Drawers (Cut Editor / Voice Options / Intro TOC / Brand)
      const btnToggleCutEditor = document.getElementById("btn-toggle-cut-editor");
      if (btnToggleCutEditor) {
        btnToggleCutEditor.addEventListener("click", () => toggleCutEditorBar());
      }

      const btnToggleVoiceOptions = document.getElementById("btn-toggle-voice-options");
      const voiceOptionsDrawer = document.getElementById("narration-voice-options-drawer");
      if (btnToggleVoiceOptions && voiceOptionsDrawer) {
        btnToggleVoiceOptions.addEventListener("click", () => {
          const isOpen = voiceOptionsDrawer.classList.contains("hidden");
          voiceOptionsDrawer.classList.toggle("hidden", !isOpen);
          btnToggleVoiceOptions.classList.toggle("active", isOpen);
        });
      }

      for (const selId of ["narration-voice-select", "narration-rate-select", "narration-style-select", "narration-pitch-select"]) {
        const selEl = document.getElementById(selId);
        if (selEl) {
          selEl.addEventListener("change", updateVoiceOptionsSummaryUI);
        }
      }
      updateVoiceOptionsSummaryUI();

      const btnToggleIntroTocDrawer = document.getElementById("btn-toggle-intro-toc-drawer");
      if (btnToggleIntroTocDrawer) {
        btnToggleIntroTocDrawer.addEventListener("click", () => {
          const tocEl = document.getElementById("narration-intro-toc-editor");
          if (!tocEl) return;
          isIntroTocDrawerOpen = !isIntroTocDrawerOpen;
          tocEl.classList.toggle("hidden", !isIntroTocDrawerOpen);
          btnToggleIntroTocDrawer.classList.toggle("active", isIntroTocDrawerOpen);
          btnToggleIntroTocDrawer.textContent = isIntroTocDrawerOpen
            ? "📑 오프닝 목차 ▴"
            : "📑 오프닝 목차 ▾";
        });
      }

      const btnToggleBrandDrawer = document.getElementById("btn-toggle-brand-drawer");
      if (btnToggleBrandDrawer) {
        btnToggleBrandDrawer.addEventListener("click", () => {
          const brandEl = document.getElementById("narration-site-brand-bar");
          if (!brandEl) return;
          isSiteBrandDrawerOpen = !isSiteBrandDrawerOpen;
          if (isSiteBrandDrawerOpen) {
            isSiteBrandEditorExpanded = true;
          }
          const details = scenarioDetailsCache[selectedScenario];
          renderSiteBrandBar(details, details?.narration);
        });
      }

      // Rendered Video Chapter Merger Bindings
      const btnToggleMergeDrawer = document.getElementById("btn-toggle-merge-drawer");
      if (btnToggleMergeDrawer) {
        btnToggleMergeDrawer.addEventListener("click", () => toggleMergeDrawer());
      }

      // Disk Storage Optimizer Bindings
      const btnToggleStorageDrawer = document.getElementById("btn-toggle-storage-drawer");
      if (btnToggleStorageDrawer) {
        btnToggleStorageDrawer.addEventListener("click", () => toggleStorageDrawer());
      }

      const btnRefreshStorageStats = document.getElementById("btn-refresh-storage-stats");
      if (btnRefreshStorageStats) {
        btnRefreshStorageStats.addEventListener("click", () => loadStorageStats());
      }

      const btnExecuteStorageCleanup = document.getElementById("btn-execute-storage-cleanup");
      if (btnExecuteStorageCleanup) {
        btnExecuteStorageCleanup.addEventListener("click", handleExecuteStorageCleanup);
      }

      for (const chkId of [
        "chk-storage-hardlinks",
        "chk-storage-temp",
        "chk-storage-orphan",
        "chk-storage-undo",
      ]) {
        const chkEl = document.getElementById(chkId);
        if (chkEl) {
          chkEl.addEventListener("change", updateSelectedStorageReclaimUI);
        }
      }
      loadStorageStats();

      const btnClearMergeQueue = document.getElementById("btn-clear-merge-queue");
      if (btnClearMergeQueue) {
        btnClearMergeQueue.addEventListener("click", clearMergeQueue);
      }

      const btnExecuteVideoMerge = document.getElementById("btn-execute-video-merge");
      if (btnExecuteVideoMerge) {
        btnExecuteVideoMerge.addEventListener("click", handleExecuteVideoMerge);
      }

      // Scenario Library Sidebar Collapse / Expand Toggle
      const scenariosGridEl = document.getElementById("scenarios-grid");
      const btnCollapseLibrary = document.getElementById("btn-collapse-library");
      const btnExpandLibrary = document.getElementById("btn-expand-library");

      const applyLibraryCollapsed = (collapsed) => {
        if (!scenariosGridEl) return;
        scenariosGridEl.classList.toggle("library-collapsed", Boolean(collapsed));
        if (btnExpandLibrary) {
          btnExpandLibrary.classList.toggle("hidden", !collapsed);
        }
        localStorage.setItem("screen_demo_library_collapsed", collapsed ? "true" : "false");
      };

      if (localStorage.getItem("screen_demo_library_collapsed") === "true") {
        applyLibraryCollapsed(true);
      }

      if (btnCollapseLibrary) {
        btnCollapseLibrary.addEventListener("click", () => {
          applyLibraryCollapsed(true);
          requestAnimationFrame(autoFitStudioLeftWidth);
        });
      }
      if (btnExpandLibrary) {
        btnExpandLibrary.addEventListener("click", () => {
          applyLibraryCollapsed(false);
          requestAnimationFrame(autoFitStudioLeftWidth);
        });
      }
      document.querySelectorAll('[data-tab="tab-scenarios"]').forEach((tabBtn) => {
        tabBtn.addEventListener("click", () => setTimeout(autoFitStudioLeftWidth, 40));
      });

      // Side-by-Side Wide Studio Layout Toggle & Draggable Splitter
      const playerStudioSplitEl = document.getElementById("player-studio-split");
      const btnToggleStudioLayout = document.getElementById("btn-toggle-studio-layout");
      const studioSplitResizer = document.getElementById("studio-split-resizer");

      const autoFitStudioLeftWidth = () => {
        if (!playerStudioSplitEl || playerStudioSplitEl.classList.contains("layout-stacked")) return;
        const customPct = parseFloat(localStorage.getItem("screen_demo_studio_left_custom_pct") || "NaN");
        if (Number.isFinite(customPct) && customPct >= 36 && customPct <= 72) {
          playerStudioSplitEl.style.setProperty("--studio-left-width", `${customPct.toFixed(1)}%`);
          return;
        }
        const splitRect = playerStudioSplitEl.getBoundingClientRect();
        if (splitRect.width <= 600 || splitRect.height <= 300) return;
        const modeBarEl = document.getElementById("video-mode-container");
        const timelineSectionEl = playerStudioSplitEl.querySelector(".timeline-visual-section");
        const unappliedBannerEl = document.getElementById("narration-unapplied-banner");
        const modeH = modeBarEl ? modeBarEl.getBoundingClientRect().height : 40;
        const timelineH = timelineSectionEl ? timelineSectionEl.getBoundingClientRect().height : 185;
        const bannerH =
          unappliedBannerEl && !unappliedBannerEl.classList.contains("hidden")
            ? unappliedBannerEl.getBoundingClientRect().height + 6
            : 0;
        const availVideoH = Math.max(200, splitRect.height - modeH - timelineH - bannerH - 4);
        const idealLeftPx = availVideoH * (16 / 9) + 8;
        const minRightPx = 485;
        const maxAllowedLeftPx = Math.max(420, splitRect.width - minRightPx);
        const targetLeftPx = Math.min(maxAllowedLeftPx, idealLeftPx);
        const idealPct = Math.min(64, Math.max(42, (targetLeftPx / splitRect.width) * 100));
        playerStudioSplitEl.style.setProperty("--studio-left-width", `${idealPct.toFixed(1)}%`);
      };

      const applyStudioLayoutMode = (mode) => {
        if (!playerStudioSplitEl) return;
        const isStacked = mode === "stacked";
        playerStudioSplitEl.classList.toggle("layout-stacked", isStacked);
        if (btnToggleStudioLayout) {
          btnToggleStudioLayout.classList.toggle("active", !isStacked);
          btnToggleStudioLayout.textContent = isStacked ? "⊟ 상하 뷰" : "◫ 와이드 뷰";
        }
        localStorage.setItem("screen_demo_studio_layout", isStacked ? "stacked" : "split");
        if (!isStacked) {
          requestAnimationFrame(autoFitStudioLeftWidth);
        }
      };

      const savedLayoutMode = localStorage.getItem("screen_demo_studio_layout") || "split";
      applyStudioLayoutMode(savedLayoutMode);
      window.addEventListener("resize", () => requestAnimationFrame(autoFitStudioLeftWidth));
      if (typeof ResizeObserver === "function" && playerStudioSplitEl) {
        const ro = new ResizeObserver(() => requestAnimationFrame(autoFitStudioLeftWidth));
        const tlSec = playerStudioSplitEl.querySelector(".timeline-visual-section");
        if (tlSec) ro.observe(tlSec);
        const bannerEl = document.getElementById("narration-unapplied-banner");
        if (bannerEl) ro.observe(bannerEl);
      }
      setTimeout(autoFitStudioLeftWidth, 120);

      if (btnToggleStudioLayout) {
        btnToggleStudioLayout.addEventListener("click", () => {
          const currentlyStacked = playerStudioSplitEl && playerStudioSplitEl.classList.contains("layout-stacked");
          applyStudioLayoutMode(currentlyStacked ? "split" : "stacked");
        });
      }

      if (studioSplitResizer && playerStudioSplitEl) {
        let isDraggingSplit = false;

        studioSplitResizer.addEventListener("mousedown", (e) => {
          if (playerStudioSplitEl.classList.contains("layout-stacked")) return;
          isDraggingSplit = true;
          studioSplitResizer.classList.add("dragging");
          document.body.style.cursor = "col-resize";
          document.body.style.userSelect = "none";
          e.preventDefault();
        });

        window.addEventListener("mousemove", (e) => {
          if (!isDraggingSplit || !playerStudioSplitEl) return;
          const rect = playerStudioSplitEl.getBoundingClientRect();
          if (rect.width <= 400) return;
          const relX = e.clientX - rect.left;
          const pct = Math.min(72, Math.max(36, (relX / rect.width) * 100));
          playerStudioSplitEl.style.setProperty("--studio-left-width", `${pct.toFixed(1)}%`);
          localStorage.setItem("screen_demo_studio_left_custom_pct", pct.toFixed(1));
        });

        window.addEventListener("mouseup", () => {
          if (!isDraggingSplit) return;
          isDraggingSplit = false;
          studioSplitResizer.classList.remove("dragging");
          document.body.style.cursor = "";
          document.body.style.userSelect = "";
        });

        studioSplitResizer.addEventListener("dblclick", () => {
          localStorage.removeItem("screen_demo_studio_left_custom_pct");
          autoFitStudioLeftWidth();
        });
      }

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

      // Auto-refresh scenario list & active scenario when browser window regains focus (e.g. after CLI recording)
      window.addEventListener("focus", () => {
        fetchScenarios();
      });
    }

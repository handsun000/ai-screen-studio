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
const btnDownloadVideo = document.getElementById("btn-download-video");
const btnModeRaw = document.getElementById("btn-mode-raw");
const btnModeRendered = document.getElementById("btn-mode-rendered");
const videoModeBadge = document.getElementById("video-mode-badge");
let currentVideoMode = "raw"; // "raw" | "rendered"
const timelineBarWrapper = document.getElementById("timeline-bar-wrapper");
const timelineVisualBar = document.getElementById("timeline-visual-bar");
const timelinePlayhead = document.getElementById("timeline-playhead");
const timelineStats = document.getElementById("timeline-stats");
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
    dot.style.background = "var(--success-color)";
    dot.style.boxShadow = "0 0 8px var(--success-glow)";
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

// 4. API Status
async function fetchStatus() {
  try {
    const res = await fetch("/api/status");
    const data = await res.json();

    if (activeSlugLabel) {
      activeSlugLabel.textContent = data.activeSlug || "none";
    }

    const pillAi = document.getElementById("pill-ai");
    if (data.geminiApiKeySet) {
      pillAi.innerHTML = `<span class="status-dot"></span><span>${data.geminiModel}</span>`;
      pillAi.title = `API Key: ${data.geminiApiKeyPreview}`;
    } else {
      pillAi.innerHTML = `<span class="status-dot" style="background:#EF4444"></span><span>Gemini Key 미설정</span>`;
    }

    const pillAuth = document.getElementById("pill-auth");
    const authDot = document.getElementById("auth-status-dot");
    const authLabel = document.getElementById("pill-auth-label");
    if (pillAuth && authLabel) {
      if (data.hasAuthSession) {
        if (authDot) authDot.style.background = "#10B981";
        authLabel.textContent = "로그인 활성";
        pillAuth.title = `인증 세션: ${data.authSessionPath || "auth.json"} (클릭하여 계정 변경/재로그인)`;
      } else {
        if (authDot) authDot.style.background = "#F59E0B";
        authLabel.textContent = "로그인 필요 (클릭)";
        pillAuth.title = "저장된 세션이 없습니다. 클릭하여 브라우저에서 1회 로그인합니다.";
      }
    }
  } catch (err) {
    console.error("fetchStatus failed:", err);
  }
}

// 5. Scenarios List & Quick Search / Filter
async function fetchScenarios() {
  try {
    const res = await fetch("/api/scenarios");
    const data = await res.json();
    allScenariosList = data.scenarios || [];

    // Populate Tab 1 Quick Scenario Loader Dropdown
    if (editorScenarioSelect) {
      const prevVal = editorScenarioSelect.value || currentSlug || "";
      editorScenarioSelect.innerHTML = `<option value="">📂 기존 시나리오 빠른 불러오기 (${allScenariosList.length}개)...</option>`;
      allScenariosList.forEach((s) => {
        const opt = document.createElement("option");
        opt.value = s.slug;
        const shortFlow = s.flowSummary
          ? s.flowSummary.length > 32
            ? s.flowSummary.slice(0, 32) + "…"
            : s.flowSummary
          : `${s.actionsCount}단계`;
        opt.textContent = `${s.slug} — ${shortFlow}`;
        editorScenarioSelect.appendChild(opt);
      });
      if (prevVal) editorScenarioSelect.value = prevVal;
    }

    renderScenarioList();

    // Auto-select most recent scenario
    if (!selectedScenario && allScenariosList.length > 0) {
      selectScenario(allScenariosList[0].slug);
    }
  } catch (err) {
    console.error("fetchScenarios failed:", err);
  }
}

function renderScenarioList() {
  if (!scenarioCardsContainer) return;

  const query = (scenarioSearchQuery || "").trim().toLowerCase();
  const filtered = allScenariosList.filter((s) => {
    if (scenarioFilterMode === "rendered" && !s.hasRenderedVideo) return false;
    if (scenarioFilterMode === "recorded" && !s.hasVideo) return false;
    if (scenarioFilterMode === "eyedropper" && !s.recordedByEyedropper) return false;
    if (query) {
      const slugMatch = (s.slug || "").toLowerCase().includes(query);
      const flowMatch = (s.flowSummary || "").toLowerCase().includes(query);
      return slugMatch || flowMatch;
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
        조건에 맞는 시나리오가 없습니다.<br>검색어나 필터 칩을 변경해보세요.
      </div>
    `;
    return;
  }

  filtered.forEach((s) => {
    const item = document.createElement("div");
    item.className = "scenario-item";
    item.dataset.slug = s.slug;
    if (selectedScenario === s.slug) item.classList.add("selected");

    const statusBadgeHtml = s.hasRenderedVideo
      ? '<span class="status-tag status-tag-rendered" title="줌/커서 합성 최종 MP4 완료">✨ 최종본</span>'
      : s.hasVideo
      ? '<span class="status-tag status-tag-raw" title="원본 브라우저 녹화 완료">📹 녹화됨</span>'
      : '<span class="status-tag status-tag-empty">녹화 전</span>';

    const mergedBadgeHtml =
      Array.isArray(s.mergedFromSlugs) && s.mergedFromSlugs.length > 0
        ? `<span class="status-tag status-tag-merged" title="병합된 챕터: ${escapeHtmlAttr(s.mergedFromSlugs.join(" + "))}">🔗 병합본</span>`
        : "";

    const queueIdx = videoMergeQueue.indexOf(s.slug);
    const mergeBtnHtml = s.hasRenderedVideo
      ? `<button type="button" class="btn-card-merge ${queueIdx >= 0 ? "in-queue" : ""}" title="${
          queueIdx >= 0
            ? `현재 합치기 목록 #${queueIdx + 1}번에 담겨 있습니다 (클릭 시 해제)`
            : "이 최종 렌더링 영상을 합치기(병합) 목록에 추가합니다"
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

    item.addEventListener("click", () => selectScenario(s.slug));
    scenarioCardsContainer.appendChild(item);
  });

  renderMergeQueueUI();
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
      videoMergeQueue.length > 0 ? `🔗 영상 합치기 (${videoMergeQueue.length})` : "🔗 영상 합치기";
  }

  if (execBtn) {
    execBtn.disabled = videoMergeQueue.length < 2;
  }

  if (!listEl) return;
  listEl.innerHTML = "";

  if (videoMergeQueue.length === 0) {
    listEl.innerHTML = `<div class="merge-queue-empty">선택된 영상이 없습니다. 아래 [✨ 최종본] 카드에서 [🔗 합치기+]를 눌러 추가하세요.</div>`;
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
    alert("합칠 최종본 영상을 최소 2개 이상 선택해주세요.");
    return;
  }

  const slugInputEl = document.getElementById("merge-output-slug-input");
  const execBtn = document.getElementById("btn-execute-video-merge");
  const outputSlug = slugInputEl ? slugInputEl.value.trim() : "";

  const origBtnHtml = execBtn ? execBtn.innerHTML : "";
  if (execBtn) {
    execBtn.disabled = true;
    execBtn.innerHTML = "⏳ 영상 병합 중...";
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
    const res = await fetch(`/api/scenarios/${slug}`);
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
      const renderRes = await fetch(`/api/render/info/${slug}`);
      if (renderRes.ok) {
        renderInfo = await renderRes.json();
      }
    } catch {}

    // Render Status Badges in Player Header
    if (playerStatusBadges) {
      const badges = [];
      if (details.browsePlan?.recordedByEyedropper) {
        badges.push('<span class="status-tag status-tag-eye">💧 스포이드 실측</span>');
      }
      if (renderInfo.exists) {
        badges.push('<span class="status-tag status-tag-rendered">✨ 최종 MP4 보유</span>');
      } else if (details.hasVideo) {
        badges.push('<span class="status-tag status-tag-raw">📹 원본 녹화본 보유</span>');
      } else {
        badges.push('<span class="status-tag status-tag-empty">녹화 전</span>');
      }
      const hasTts = Boolean(details.narration?.cues?.length || details.editPlan?.narration?.cues?.length);
      if (hasTts) {
        badges.push('<span class="status-tag status-tag-tts">🎙️ AI 나레이션 포함</span>');
      }
      playerStatusBadges.innerHTML = badges.join("");
    }

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
        btnDownloadVideo.innerHTML = `💾 최종 MP4 다운로드 <small>(${sizeMb}MB)</small>`;
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

function setVideoMode(mode, details = null, renderInfo = null) {
  if (!selectedScenario) return;
  const slug = selectedScenario;
  const d = details || scenarioDetailsCache[slug] || {};

  currentVideoMode = mode;

  if (btnModeRaw) btnModeRaw.classList.toggle("active", mode === "raw");
  if (btnModeRendered) btnModeRendered.classList.toggle("active", mode === "rendered");

  if (mode === "rendered") {
    const hasRendered = renderInfo ? renderInfo.exists : d.hasRenderedVideo || false;
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

function computeTimeRegionsAndSyncCuesJS(cues, rawTotalMs, fps, momentsList = []) {
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

    const autoHoldMs = Math.max(0, minSpeechWindowMs - rawGapMs);
    const extraHoldMs = Math.round(Number(c.extraHoldMs || 0));

    const baseWindowMs = Math.max(rawGapMs, minSpeechWindowMs);
    const minAllowedWindowMs = Math.max(minSpeechWindowMs, Math.max(300, Math.round(rawGapMs * 0.25)));
    const compGapMs = Math.max(minAllowedWindowMs, baseWindowMs + extraHoldMs);
    const effectiveDeltaMs = compGapMs - rawGapMs;

    const rawFrames = Math.max(1, vEndF - vStartF);
    const compFrames = Math.max(1, Math.round((compGapMs / 1000) * fps));
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
    if (Math.abs(deltaFrames) <= 1 || rawFrames < 4) {
      appendRegion(vStartF, vEndF, cStartF, cEndF, cueId);
    } else if (deltaFrames > 1) {
      const holdRawF = Math.min(Math.max(2, Math.round(0.08 * fps)), Math.max(1, Math.floor(rawFrames / 4)));
      let holdVStart = vStartF;
      let holdVEnd = vStartF + holdRawF;
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
  const momentsDurMs = Number(details.moments?.totalDurationMs || 0);
  const rawTotalMs =
    rawFrames > 0
      ? Math.round((rawFrames / fps) * 1000)
      : momentsDurMs > 0
      ? momentsDurMs
      : videoPlayer && videoPlayer.duration
      ? Math.round(videoPlayer.duration * 1000)
      : 15000;

  const synced = computeTimeRegionsAndSyncCuesJS(
    narration.cues,
    rawTotalMs,
    fps,
    details.moments?.moments || []
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
        details.narration = data.narration;
        if (data.editPlan) {
          details.editPlan = data.editPlan;
        } else if (details.editPlan) {
          details.editPlan.narration = data.narration;
        }
        syncScenarioTimelineInMemory(details);

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
  if (videoPlayer && !videoPlayer.paused) {
    videoPlayer.pause();
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
  if (videoPlayer && !videoPlayer.paused) {
    videoPlayer.pause();
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
    alert(`영상 복원 실패: ${err.message}`);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = origLabel;
    }
  }
}

// 7. Timeline Visual Bar & Step-by-Step Moment Cards
function renderTimelineVisual(details) {
  if (!timelineVisualBar) return;
  timelineVisualBar.innerHTML = "";
  if (timelinePlayhead) timelinePlayhead.style.left = "0%";

  syncScenarioTimelineInMemory(details);

  const editPlan = details.editPlan;
  const moments = details.moments;
  const narration = details.narration || editPlan?.narration || null;

  if (!editPlan || !editPlan.totalDurationFrames) {
    if (timelineStats) timelineStats.textContent = "녹화 후 타임라인 생성됨";
    return;
  }

  const totalFrames = editPlan.totalDurationFrames;
  const rawFrames = editPlan.rawDurationFrames || totalFrames;
  const fps = editPlan.fps || 60;
  const totalMs = (totalFrames / fps) * 1000;
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

  // 1) Draw Zoom Segments (mapped onto unified composition timeline)
  segments.forEach((seg) => {
    const compStartMs = videoTimeMsToCompTimeMs((seg.startFrame / fps) * 1000, editPlan);
    const compEndMs = videoTimeMsToCompTimeMs((seg.endFrame / fps) * 1000, editPlan);
    const leftPercent = Math.min(99.5, Math.max(0, (compStartMs / totalMs) * 100));
    const widthPercent = Math.max(0.8, ((compEndMs - compStartMs) / totalMs) * 100);

    const block = document.createElement("div");
    block.className = "segment-block";
    block.style.left = `${leftPercent}%`;
    block.style.width = `${Math.min(100 - leftPercent, widthPercent)}%`;
    block.title = `[줌 ${seg.zoom}x] ${seg.description || "확대 구간"} (${(compStartMs / 1000).toFixed(1)}s ~ ${(
      compEndMs / 1000
    ).toFixed(1)}s)`;
    timelineVisualBar.appendChild(block);
  });

  // 1.5) Draw Hold / Time-Stretch Regions on timeline
  timeRegions.forEach((reg) => {
    const cSpanF = (reg.compEndFrame || 0) - (reg.compStartFrame || 0);
    if (cSpanF < 6) return;
    if (reg.speed < 0.25 || reg.speed > 1.15) {
      const startMs = (reg.compStartFrame / fps) * 1000;
      const endMs = (reg.compEndFrame / fps) * 1000;
      const leftPercent = Math.min(99.5, Math.max(0, (startMs / totalMs) * 100));
      const widthPercent = Math.max(0.8, ((endMs - startMs) / totalMs) * 100);

      const hBlock = document.createElement("div");
      hBlock.className = "hold-segment-block";
      hBlock.style.left = `${leftPercent}%`;
      hBlock.style.width = `${Math.min(100 - leftPercent, widthPercent)}%`;
      const durSec = ((endMs - startMs) / 1000).toFixed(1);
      hBlock.title =
        reg.speed < 0.25
          ? `⏸️ [구간 늘리기(홀드) +${durSec}s] 대본 #${reg.cueId || ""} 싱크 맞춤 구간 (${(startMs / 1000).toFixed(1)}s ~ ${(endMs / 1000).toFixed(1)}s)`
          : `⚡ [구간 단축 ${reg.speed.toFixed(2)}x] 대본 #${reg.cueId || ""} (${(startMs / 1000).toFixed(1)}s ~ ${(endMs / 1000).toFixed(1)}s)`;
      timelineVisualBar.appendChild(hBlock);
    }
  });

  // 2) Draw Narration TTS Segments at bottom of timeline
  cues.forEach((cue, idx) => {
    const startMs = cue.startMs || 0;
    const endMs = cue.endMs || startMs + 2000;
    const leftPercent = Math.min(99, Math.max(0, (startMs / totalMs) * 100));
    const widthPercent = Math.max(1.2, ((endMs - startMs) / totalMs) * 100);

    const nBlock = document.createElement("div");
    nBlock.className = "narration-segment-block";
    nBlock.style.left = `${leftPercent}%`;
    nBlock.style.width = `${Math.min(100 - leftPercent, widthPercent)}%`;
    const deltaLabel =
      (cue.effectiveDeltaMs || 0) >= 100
        ? ` [구간 +${((cue.effectiveDeltaMs || 0) / 1000).toFixed(1)}s 연장]`
        : (cue.effectiveDeltaMs || 0) <= -100
        ? ` [구간 ${((cue.effectiveDeltaMs || 0) / 1000).toFixed(1)}s 단축]`
        : "";
    nBlock.title = `[나레이션 #${idx + 1}] "${cue.text}" (${(startMs / 1000).toFixed(1)}s ~ ${(endMs / 1000).toFixed(1)}s)${deltaLabel}`;
    timelineVisualBar.appendChild(nBlock);
  });

  // 3) Draw Interactive Action / Click Moment Markers (mapped onto unified composition timeline)
  interactiveMoments.forEach((m, i) => {
    const compMomentMs = videoTimeMsToCompTimeMs(m.timestamp || 0, editPlan);
    const leftPercent = Math.min(99.5, Math.max(0, (compMomentMs / totalMs) * 100));
    const marker = document.createElement("div");
    marker.className = "moment-marker";
    marker.style.left = `${leftPercent}%`;
    marker.title = `[#${i + 1} ${(m.type || "click").toUpperCase()}] ${m.description || ""} (싱크 ${(
      compMomentMs / 1000
    ).toFixed(1)}s / 원본 ${((m.timestamp || 0) / 1000).toFixed(1)}s)`;

    marker.addEventListener("click", (e) => {
      e.stopPropagation();
      if (videoPlayer && videoPlayer.duration) {
        stopRealtimeHoldAndAudio();
        const rawSec = (m.timestamp || 0) / 1000;
        if (currentVideoMode === "raw") {
          syncCompletedHoldRegionsForSeek(rawSec, compMomentMs);
        }
        realtimeHoldState.isProgrammaticSeek = true;
        videoPlayer.currentTime = currentVideoMode === "rendered" ? compMomentMs / 1000 : rawSec;
        realtimeHoldState.isProgrammaticResume = true;
        videoPlayer.play().catch(() => {
          realtimeHoldState.isProgrammaticResume = false;
        });
      }
    });

    timelineVisualBar.appendChild(marker);
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
            <span style="color:#38BDF8; font-family:var(--font-mono); font-size:0.74rem; margin-right:4px;">#${idx + 1} ${typeUpper}</span>
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
          if (currentVideoMode === "raw") {
            syncCompletedHoldRegionsForSeek(targetRawSec, compMs);
          }
          realtimeHoldState.isProgrammaticSeek = true;
          videoPlayer.currentTime = currentVideoMode === "rendered" ? compMs / 1000 : targetRawSec;
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
          <span style="color:#A5B4FC; font-family:var(--font-mono); font-size:0.74rem; margin-right:4px;">${(act.type || "CLICK").toUpperCase()}</span>
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

  if (currentVideoMode === "raw" && editPlan && Array.isArray(editPlan.timeRegions) && editPlan.timeRegions.length > 0) {
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
      // Check if we entered an uncompleted hold region
      let triggeredHold = false;
      for (let rIdx = 0; rIdx < regions.length; rIdx++) {
        const r = regions[rIdx];
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

    if (subEl) {
      if (narration?.showSubtitles !== false && speakingCue && speakingCue.text) {
        subEl.classList.remove("hidden");
        subEl.textContent = speakingCue.text;
      } else {
        subEl.classList.add("hidden");
      }
    }

    if (isPlayingOrHolding && narration?.enabled !== false && speakingCue && speakingCue.audioFile) {
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
  }

  // Highlight active moment card
  if (momentsStepList) {
    const cards = momentsStepList.querySelectorAll(".moment-step-card[data-timestamp-ms]");
    let activeCard = null;
    cards.forEach((c) => {
      const tMs = parseFloat(c.dataset.timestampMs || "0");
      const isNear = Math.abs(rawCurSec * 1000 - tMs) <= 900;
      c.classList.toggle("active-moment", isNear);
      if (isNear) activeCard = c;
    });
    if (activeCard && (!videoPlayer.paused || realtimeHoldState.active)) {
      activeCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }

  // Highlight active narration cue row using synced composition time
  const cueRows = document.querySelectorAll("#narration-cues-container .narration-cue-row");
  cueRows.forEach((row) => {
    const startMs = parseFloat(row.dataset.compStartMs || "0");
    const endMs = parseFloat(row.dataset.compEndMs || String(startMs + 2500));
    const isSpeaking = compCurMs >= startMs && compCurMs <= endMs + 150;
    row.classList.toggle("active-cue", isSpeaking);
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
    ).toFixed(1)}s — 뒤따르는 대본·카메라 줌·커서 싱크가 자동으로 함께 이동합니다">⏱️ 구간 +${(effDelta / 1000).toFixed(
      1
    )}s (수동 +${(extraHold / 1000).toFixed(1)}s)</span>`;
  }
  if (effDelta <= -100) {
    return `<span class="cue-sync-badge badge-shrink" title="수동 구간 줄이기 적용됨 (대본 음성 길이 이하로는 줄어들지 않아 음성이 절대 잘리지 않습니다)">⚡ 구간 ${(
      effDelta / 1000
    ).toFixed(1)}s 단축</span>`;
  }
  if (autoHold >= 100) {
    return `<span class="cue-sync-badge badge-auto-hold" title="대본이 원본 동작 간격보다 길어 음성 속도를 빠르게 왜곡하지 않고 화면을 자동으로 +${(
      effDelta / 1000
    ).toFixed(1)}s 홀드(연장)하여 싱크를 맞춥니다">⏳ 대본맞춤 +${(effDelta / 1000).toFixed(1)}s 자동연장</span>`;
  }
  return `<span class="cue-sync-badge badge-normal" title="원본 영상 길이 안에서 정상 속도로 대본이 재생됩니다">1.0x 정속</span>`;
}

function renderNarrationStudio(details, focusIndex = null) {
  const container = document.getElementById("narration-cues-container");
  const statusBadge = document.getElementById("narration-status-badge");
  const styleSelect = document.getElementById("narration-style-select");
  const voiceSelect = document.getElementById("narration-voice-select");
  const pitchSelect = document.getElementById("narration-pitch-select");
  const rateSelect = document.getElementById("narration-rate-select");
  const enabledToggle = document.getElementById("narration-enabled-toggle");
  const subtitleToggle = document.getElementById("narration-subtitle-toggle");

  if (!container) return;

  syncScenarioTimelineInMemory(details);

  const narration = details?.narration || details?.editPlan?.narration || null;
  if (!narration || !Array.isArray(narration.cues) || narration.cues.length === 0) {
    if (statusBadge) {
      statusBadge.textContent = "대본 없음";
      statusBadge.style.background = "rgba(148, 163, 184, 0.16)";
      statusBadge.style.color = "#cbd5e1";
    }
    container.innerHTML = `
      <div class="studio-empty-box">
        상단에서 <strong>말투(문체)</strong>와 <strong>음성/억양 톤</strong>을 선택한 뒤 <strong>[✨ AI 대본(오프닝 포함) 생성 &amp; 음성 합성]</strong>을 누르면, 영상 시작 시 어떤 매뉴얼인지 소개하는 오프닝 멘트와 단계별 나레이션이 자동 생성됩니다.
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

  const styleLabels = {
    manual: "📘 정석 매뉴얼",
    friendly: "😊 친절 가이드",
    presentation: "🎙️ 시연 발표",
    compact: "⚡ 핵심 브리핑",
  };
  const styleBadgeText = styleLabels[narration.style || "manual"] || "📘 정석 매뉴얼";
  const totalHoldMs = narration.cues.reduce((acc, c) => acc + Math.max(0, Number(c.effectiveDeltaMs || 0)), 0);

  if (statusBadge) {
    const holdText = totalHoldMs >= 200 ? ` · ⏱️싱크연장 +${(totalHoldMs / 1000).toFixed(1)}s` : "";
    statusBadge.textContent = `${narration.cues.length}구간 · ${styleBadgeText}${holdText}`;
    statusBadge.style.background = "rgba(16, 185, 129, 0.2)";
    statusBadge.style.color = "#6ee7b7";
  }

  container.innerHTML = "";
  narration.cues.forEach((cue, idx) => {
    const row = document.createElement("div");
    row.className = "narration-cue-row";
    row.dataset.origIdx = String(idx);
    row.dataset.isIntro = cue.isIntro ? "true" : "false";
    row.dataset.extraHoldMs = String(cue.extraHoldMs || 0);
    row.dataset.compStartMs = String(cue.startMs || 0);
    row.dataset.compEndMs = String(cue.endMs || 0);
    row.dataset.lastSyncedText = String(cue.text || "").trim();

    const anchorSec = ((cue.videoStartMs ?? cue.startMs ?? 0) / 1000).toFixed(1);
    const compStartSec = ((cue.startMs || 0) / 1000).toFixed(1);
    const compEndSec = ((cue.endMs || 0) / 1000).toFixed(1);
    const audioFileName = cue.audioFile ? cue.audioFile.split("/").pop() : null;
    const isOpeningCue = Boolean(cue.isIntro || (idx === 0 && (cue.videoStartMs ?? cue.startMs ?? 0) <= 600));
    const extraHoldMs = Number(cue.extraHoldMs || 0);

    row.innerHTML = `
      <span style="font-size: 0.78em; font-weight: 700; color: #818cf8; min-width: 24px; font-family: var(--font-mono);">#${idx + 1}</span>
      ${
        isOpeningCue
          ? `<span class="status-tag status-tag-eye" title="영상 시작 시 어떤 매뉴얼인지 안내하는 오프닝 소개 구간" style="font-size: 0.7em; padding: 2px 6px;">🎬 오프닝</span>`
          : ""
      }
      <input type="number" step="0.1" min="0" class="cue-start-input" value="${anchorSec}" title="원본 녹화 영상 기준 동작 시점(초) — 변경 시 시간순으로 자동 정렬 및 전체 싱크가 재계산됩니다"
        style="width: 60px; padding: 5px 5px; border-radius: 6px; border: 1px solid var(--border-subtle); background: var(--bg-input); color: #e2e8f0; font-size: 0.8em; text-align: center; font-family: var(--font-mono);" />
      <span style="font-size: 0.76em; color: #38bdf8; min-width: 78px; cursor: pointer; font-family: var(--font-mono); white-space: nowrap;" class="cue-jump-time" title="클릭하여 비디오 해당 구간으로 이동 (실제 동기화 재생 구간: ${compStartSec}s ~ ${compEndSec}s)">➔ ${compStartSec}~${compEndSec}s</span>
      <input type="text" class="cue-text-input" value="${(cue.text || "").replace(/"/g, "&quot;")}" placeholder="나레이션 대본 문장을 입력하세요 (길어져도 음성 속도가 빨라지지 않고 화면 구간이 자동 연장됩니다)"
        style="flex: 1; min-width: 170px; padding: 7px 10px; border-radius: 6px; border: 1px solid var(--border-subtle); background: var(--bg-input); color: #f8fafc; font-size: 0.88em;" />
      <span class="cue-sync-badge-wrap">${buildCueSyncBadgeHtml(cue)}</span>
      <div class="cue-stretch-controls" title="이 구간의 영상 길이를 실시간으로 늘리거나 줄입니다 (뒤따르는 모든 대본·카메라 줌·커서 싱크 자동 재정렬)">
        <button type="button" class="btn-cue-stretch stretch-minus" data-stretch="-500" title="구간 0.5초 줄이기 (대본 음성 길이 이하로는 줄어들지 않음)">-0.5s</button>
        <button type="button" class="btn-cue-stretch stretch-plus" data-stretch="500" title="구간 0.5초 늘리기 (화면 홀드 연장)">+0.5s</button>
        <button type="button" class="btn-cue-stretch stretch-plus" data-stretch="1000" title="구간 1.0초 늘리기 (화면 홀드 연장)">+1.0s</button>
        ${
          extraHoldMs !== 0
            ? `<button type="button" class="btn-cue-stretch stretch-reset" data-stretch="reset" title="수동 늘리기/줄이기 초기화 (0.0s)">초기화</button>`
            : ""
        }
      </div>
      <div style="display: inline-flex; align-items: center; gap: 4px;">
        <button type="button" class="btn btn-sm btn-outline btn-insert-cue-before" title="이 구간 바로 위(이전 시점)에 새 대본 구간 끼워넣기" style="padding: 4px 6px; font-size: 0.72em; color: #93c5fd;">+위</button>
        <button type="button" class="btn btn-sm btn-outline btn-insert-cue-after" title="이 구간 바로 아래(다음 시점)에 새 대본 구간 끼워넣기" style="padding: 4px 6px; font-size: 0.72em; color: #93c5fd;">+아래</button>
        ${
          audioFileName
            ? `<button type="button" class="btn btn-sm btn-outline btn-play-cue" title="합성된 음성 미리듣기" style="padding: 4px 8px; font-size: 0.74em;">▶️ 듣기</button>`
            : ""
        }
        <button type="button" class="btn btn-sm btn-outline btn-delete-cue" title="구간 삭제" style="padding: 4px 7px; font-size: 0.76em; color: #f87171;">✕</button>
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
        saveNarrationTimingQuick();
      });
    });

    const jumpEl = row.querySelector(".cue-jump-time");
    if (jumpEl) {
      jumpEl.addEventListener("click", () => {
        if (videoPlayer && videoPlayer.duration) {
          stopRealtimeHoldAndAudio();
          const compStartMs = Number(row.dataset.compStartMs) || 0;
          const rawStartSec = Number(row.querySelector(".cue-start-input").value) || 0;
          const targetSec = currentVideoMode === "rendered" ? compStartMs / 1000 : rawStartSec;
          if (currentVideoMode === "raw") {
            syncCompletedHoldRegionsForSeek(rawStartSec, Math.max(0, compStartMs - 150));
          }
          realtimeHoldState.isProgrammaticSeek = true;
          videoPlayer.currentTime = targetSec;
          realtimeHoldState.isProgrammaticResume = true;
          videoPlayer.play().catch(() => {
            realtimeHoldState.isProgrammaticResume = false;
          });
        }
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
    rawCues.push({
      videoStartMs,
      startMs: videoStartMs,
      endMs: videoStartMs + estDurMs,
      text,
      isIntro: row.dataset.isIntro === "true" || prevCue.isIntro || false,
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

  return {
    slug: selectedScenario,
    style: styleSelect ? styleSelect.value : existing.style || "manual",
    voice: voiceSelect ? voiceSelect.value : existing.voice || "ko-KR-SunHiNeural",
    pitch: pitchSelect ? pitchSelect.value : existing.pitch || "+0Hz",
    rate: rateSelect ? rateSelect.value : existing.rate || "+5%",
    enabled: enabledToggle ? enabledToggle.checked : true,
    showSubtitles: subtitleToggle ? subtitleToggle.checked : true,
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

  if (btn) {
    btn.disabled = true;
    btn.textContent = "⏳ AI 대본(오프닝+스타일) 생성 & 음성 합성 중...";
  }
  try {
    const res = await fetch(`/api/narration/${selectedScenario}/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ style, voice, pitch, rate, enabled, showSubtitles }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "생성 실패");

    if (scenarioDetailsCache[selectedScenario]) {
      scenarioDetailsCache[selectedScenario].narration = data.narration;
      if (data.editPlan) {
        scenarioDetailsCache[selectedScenario].editPlan = data.editPlan;
      } else if (scenarioDetailsCache[selectedScenario].editPlan) {
        scenarioDetailsCache[selectedScenario].editPlan.narration = data.narration;
      }
      syncScenarioTimelineInMemory(scenarioDetailsCache[selectedScenario]);
    }
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
  renderNarrationStudio(scenarioDetailsCache[selectedScenario], insertIndex);
  renderTimelineVisual(scenarioDetailsCache[selectedScenario]);
}

async function handleSaveNarration() {
  if (!selectedScenario) return;
  const btn = document.getElementById("btn-save-narration");
  const narration = collectNarrationFromUI({ sortByStartTime: true });

  if (btn) {
    btn.disabled = true;
    btn.textContent = "⏳ 정속 음성 재합성 & 싱크 계산 중...";
  }
  try {
    const res = await fetch(`/api/narration/${selectedScenario}/save`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ narration, synthesize: true }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "저장 실패");

    if (scenarioDetailsCache[selectedScenario]) {
      scenarioDetailsCache[selectedScenario].narration = data.narration;
      if (data.editPlan) {
        scenarioDetailsCache[selectedScenario].editPlan = data.editPlan;
      } else if (scenarioDetailsCache[selectedScenario].editPlan) {
        scenarioDetailsCache[selectedScenario].editPlan.narration = data.narration;
      }
      syncScenarioTimelineInMemory(scenarioDetailsCache[selectedScenario]);
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
        ev.kind === "click"
          ? "#38bdf8"
          : ev.kind === "type"
          ? "#a855f7"
          : ev.kind === "dragAndDrop"
          ? "#f59e0b"
          : "#10b981";
      const kindLabel =
        ev.kind === "click"
          ? "💧 클릭"
          : ev.kind === "type"
          ? "⌨️ 입력"
          : ev.kind === "dragAndDrop"
          ? "✊ 드래그"
          : "🖱️ 동작";
      const textPart = ev.text ? ` <strong style="color:#fde047;">'${ev.text}'</strong>` : "";
      const iframePart = ev.iframe ? ` <span style="color:#94a3b8;">[${ev.iframe}]</span>` : "";
      return `
        <div style="display:flex; align-items:center; gap:8px; padding:5px 8px; background:rgba(15,23,42,0.85); border-left:3px solid ${badgeColor}; border-radius:4px;">
          <span style="color:${badgeColor}; font-weight:700; min-width:64px;">#${ev.seq} ${kindLabel}</span>
          <span style="color:#f8fafc; font-weight:500;">${ev.label}${textPart}</span>
          <span style="margin-left:auto; color:#64748b; font-size:0.85em; max-width:240px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${(ev.selector || "").replace(/"/g, "&quot;")}">${ev.selector}${iframePart}</span>
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

function extractHumanTargetLabel(act) {
  if (!act) return "";
  const sel = String(act.selector || "");
  const patterns = [
    /:text-is\(['"]([^'"]+)['"]\)/,
    /:has-text\(['"]([^'"]+)['"]\)/,
    /\[title\*?=['"]([^'"]+)['"]\]/,
    /\[value=['"]([^'"]+)['"]\]/,
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
  actionsList.innerHTML = "";
  if (!currentPlan || !currentPlan.actions || currentPlan.actions.length === 0) {
    if (planStatsPills) planStatsPills.innerHTML = "";
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

  // Update Plan Breakdown Stats Pills
  if (planStatsPills) {
    const acts = currentPlan.actions;
    const clickCount = acts.filter((a) => a.type === "click" || a.type === "dblclick" || a.type === "hover").length;
    const typeCount = acts.filter((a) => a.type === "type").length;
    const uploadCount = acts.filter((a) => a.type === "upload").length;
    const dragCount = acts.filter((a) => a.type === "dragAndDrop" || (a.sourceSelector && a.targetSelector)).length;
    const waitCount = acts.filter((a) => a.type === "wait").length;
    planStatsPills.innerHTML = [
      `<span class="plan-stat-pill">총 ${acts.length}단계</span>`,
      clickCount > 0 ? `<span class="plan-stat-pill" style="color:#22D3EE;">🖱️ 클릭 ${clickCount}</span>` : "",
      typeCount > 0 ? `<span class="plan-stat-pill" style="color:#34D399;">⌨️ 입력 ${typeCount}</span>` : "",
      uploadCount > 0 ? `<span class="plan-stat-pill" style="color:#C084FC;">📎 첨부 ${uploadCount}</span>` : "",
      dragCount > 0 ? `<span class="plan-stat-pill" style="color:#FB923C;">✊ 드래그 ${dragCount}</span>` : "",
      waitCount > 0 ? `<span class="plan-stat-pill" style="color:#FBBF24;">⏳ 대기 ${waitCount}</span>` : "",
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
    } else if (act.type === "click" || act.type === "hover" || act.type === "dblclick") {
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
          <option value="dblclick" ${act.type === "dblclick" ? "selected" : ""}>🖱️ 더블클릭</option>
          <option value="navigate" ${act.type === "navigate" ? "selected" : ""}>🌐 페이지 이동</option>
        </select>

        <input type="text" class="storyboard-desc-input" placeholder="단계 설명 (예: '결재' 메뉴 클릭)" value="${escapeHtmlAttr(act.description || "")}" data-field="description">

        ${inlineValueHtml}

        <div class="action-card-controls">
          <button type="button" class="action-ctrl-btn action-move-up" title="위로 이동" ${idx === 0 ? "disabled" : ""}>▲</button>
          <button type="button" class="action-ctrl-btn action-move-down" title="아래로 이동" ${idx === totalActions - 1 ? "disabled" : ""}>▼</button>
          <button type="button" class="action-ctrl-btn action-ctrl-insert action-insert-btn" title="바로 아래에 새 단계 추가">+ 추가</button>
          ${act.type !== "wait" ? `<button type="button" class="action-ctrl-btn btn-toggle-raw-selector" title="고급: 내부 CSS 셀렉터 확인/수정">🔧</button>` : ""}
          <button type="button" class="action-delete-btn" title="이 단계 삭제">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
          </button>
        </div>
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

// 11. Save Plan
async function handleSavePlan(silent = false) {
  const isSilent = typeof silent === "boolean" ? silent : false;
  syncCardsToPlan();
      const slug = slugInput.value.trim() || currentSlug;
      if (!slug) {
        if (!isSilent) alert("시나리오 식별자(Slug)를 입력해주세요.");
        return false;
      }
      if (!currentPlan) {
        if (!isSilent) alert("저장할 플랜이 없습니다.");
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
            btnSavePlan.style.background = "#10b981";
            setTimeout(() => {
              btnSavePlan.textContent = originalText || "💾 플랜 저장";
              btnSavePlan.style.background = "";
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

          const proceed = confirm(
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

      if (timelineBarWrapper && videoPlayer) {
        const clientXToRawSec = (clientX) => {
          const rect = timelineBarWrapper.getBoundingClientRect();
          const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
          const details = scenarioDetailsCache[selectedScenario];
          const editPlan = details?.editPlan;
          if (currentVideoMode === "raw" && editPlan?.totalDurationFrames) {
            const fps = Number(editPlan.fps || 60);
            const compTotalMs = (editPlan.totalDurationFrames / fps) * 1000;
            const targetCompMs = ratio * compTotalMs;
            const targetRawMs = compTimeMsToVideoTimeMs(targetCompMs, editPlan);
            return Math.min(videoPlayer.duration || 0, Math.max(0, targetRawMs / 1000));
          }
          return ratio * (videoPlayer.duration || 0);
        };

        timelineBarWrapper.addEventListener("mousedown", (e) => {
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
          if (!videoPlayer.duration) return;
          if (timelineDragCutState && timelineDragCutState.moved) return;
          const wasPlaying = !videoPlayer.paused || realtimeHoldState.active;
          stopRealtimeHoldAndAudio();
          const rect = timelineBarWrapper.getBoundingClientRect();
          const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
          const details = scenarioDetailsCache[selectedScenario];
          const editPlan = details?.editPlan;
          if (currentVideoMode === "raw" && editPlan?.totalDurationFrames) {
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

      // Rendered Video Chapter Merger Bindings
      const btnToggleMergeDrawer = document.getElementById("btn-toggle-merge-drawer");
      if (btnToggleMergeDrawer) {
        btnToggleMergeDrawer.addEventListener("click", () => toggleMergeDrawer());
      }

      const btnClearMergeQueue = document.getElementById("btn-clear-merge-queue");
      if (btnClearMergeQueue) {
        btnClearMergeQueue.addEventListener("click", clearMergeQueue);
      }

      const btnExecuteVideoMerge = document.getElementById("btn-execute-video-merge");
      if (btnExecuteVideoMerge) {
        btnExecuteVideoMerge.addEventListener("click", handleExecuteVideoMerge);
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
    }

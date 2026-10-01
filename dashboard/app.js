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
const btnGenerate = document.getElementById("btn-generate");
const generateBtnText = document.getElementById("generate-btn-text");

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
const btnSavePlan = document.getElementById("btn-save-plan");
const btnRunPipeline = document.getElementById("btn-run-pipeline");

const scenarioCardsContainer = document.getElementById("scenario-cards-container");
const scenariosCount = document.getElementById("scenarios-count");
const playerTitle = document.getElementById("player-title");
const playerMeta = document.getElementById("player-meta");
const videoPlayer = document.getElementById("demo-video-player");
const videoEmpty = document.getElementById("video-empty");
const btnSetActive = document.getElementById("btn-set-active");
const btnReRecord = document.getElementById("btn-re-record");
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
  try {
    const res = await fetch("/api/templates");
    const data = await res.json();
    const templates = data.templates || [];

    templateCardsGrid.innerHTML = "";

    templates.forEach((tmpl, idx) => {
      const card = document.createElement("div");
      card.className = `template-card ${idx === 0 ? "active" : ""}`;
      card.innerHTML = `
        <span class="template-icon">${tmpl.icon}</span>
        <div class="template-card-body">
          <h4>${tmpl.name.split("(")[0].trim()}</h4>
          <p title="${tmpl.description}">${tmpl.description}</p>
        </div>
      `;

      card.addEventListener("click", () => {
        document.querySelectorAll(".template-card").forEach((c) => c.classList.remove("active"));
        card.classList.add("active");

        promptInput.value = tmpl.promptTemplate;
        slugInput.value = tmpl.id;
        promptInput.focus();

        // Render phases preview
        phasesStepsList.innerHTML = "";
        tmpl.phases.forEach((phase) => {
          const chip = document.createElement("span");
          chip.className = "phase-chip";
          chip.textContent = phase;
          phasesStepsList.appendChild(chip);
        });
      });

      templateCardsGrid.appendChild(card);
    });

    // Auto-select first template on load
    if (templates.length > 0 && !promptInput.value) {
      promptInput.value = templates[0].promptTemplate;
      slugInput.value = templates[0].id;
      phasesStepsList.innerHTML = "";
      templates[0].phases.forEach((phase) => {
        const chip = document.createElement("span");
        chip.className = "phase-chip";
        chip.textContent = phase;
        phasesStepsList.appendChild(chip);
      });
    }
  } catch (err) {
    console.error("fetchTemplates failed:", err);
  }
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
  } else {
    pillProjectName.textContent = "프로젝트 미연결";
    dot.style.background = "var(--danger-color)";
    dot.style.boxShadow = "0 0 8px rgba(239, 68, 68, 0.4)";
    projectStatusText.textContent = "경로 확인 필요 (존재하지 않음)";
    metaProjectType.textContent = analysis.sourceSummary;
    metaDocsTags.innerHTML = '<span style="color:var(--danger-color)">경로가 올바르지 않습니다</span>';
  }
}

async function handleSaveConfig() {
  const targetProjectPath = targetProjectPathInput.value.trim();
  const targetBaseUrl = targetBaseUrlInput.value.trim();

  if (!targetProjectPath) {
    alert("타겟 프로젝트 경로를 입력해주세요.");
    return;
  }

  btnValidateProject.disabled = true;
  btnValidateProject.textContent = "검증 중...";

  try {
    const res = await fetch("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetProjectPath, targetBaseUrl }),
    });

    const data = await res.json();
    updateProjectAnalysisUI(data.analysis);

    if (data.analysis.exists) {
      alert(`타겟 프로젝트가 성공적으로 변경되었습니다!\n- 프로젝트: ${data.analysis.projectName}\n- 경로: ${data.analysis.path}\n- 타입: ${data.analysis.projectType}`);
    } else {
      alert(`경고: 입력하신 경로가 존재하지 않습니다.\n${targetProjectPath}`);
    }
  } catch (err) {
    alert("설정 저장 실패: " + err.message);
  } finally {
    btnValidateProject.disabled = false;
    btnValidateProject.textContent = "🔍 검증 및 연결";
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
async function selectScenario(slug) {
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

    if (details.hasVideo) {
      videoEmpty.style.display = "none";
      videoPlayer.style.display = "block";
      videoPlayer.src = `${details.videoUrl}?t=${Date.now()}`;
    } else {
      videoEmpty.style.display = "flex";
      videoPlayer.style.display = "none";
      videoPlayer.src = "";
    }

    renderTimelineVisual(details);
    updateJsonViewer("browse");
  } catch (err) {
    console.error("selectScenario failed:", err);
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

// 9. Generate Browse Plan via Gemini (with dynamic project & URL)
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
  generateBtnText.textContent = "Gemini 소스코드/문서 분석 및 플랜 생성 중...";

  try {
    const slug = slugInput.value.trim();
    const directingStyle = directingStyleSelect ? directingStyleSelect.value : "standard";
    const res = await fetch("/api/scenarios/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt,
        slug,
        targetProjectPath,
        targetUrl,
        directingStyle,
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
    planSlugBadge.textContent = `시나리오: ${currentSlug}`;
    explanationText.textContent = currentExplanation;

    renderActionCards();
  } catch (err) {
    alert("Gemini 플랜 생성 중 오류: " + err.message);
  } finally {
    btnGenerate.disabled = false;
    generateBtnText.textContent = "Gemini로 시나리오 생성";
  }
}

// 10. Render Editable Action Cards
function renderActionCards() {
  actionsList.innerHTML = "";
  if (!currentPlan || !currentPlan.actions || currentPlan.actions.length === 0) {
    actionsList.innerHTML = `
      <div class="empty-state">
        <p>생성된 액션이 없습니다.</p>
      </div>`;
    return;
  }

  currentPlan.actions.forEach((act, idx) => {
    const card = document.createElement("div");
    card.className = "action-item-card";

    const badgeClass = `badge-${act.type}`;

    card.innerHTML = `
      <div class="action-top-row">
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
          <input type="text" placeholder="액션 설명 (한글)" value="${act.description || ""}" data-field="description" style="width: 280px; font-weight: 500;">
        </div>
        <button class="action-delete-btn" title="삭제">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
        </button>
      </div>

      <div class="action-inputs-grid">
        ${act.type !== "wait" ? `<input type="text" placeholder="CSS 셀렉터 (예: #svc_lst a:has-text('결재'))" value="${act.selector || ""}" data-field="selector">` : ""}
        ${act.type === "wait" ? `<input type="number" placeholder="대기 시간(ms)" value="${act.ms || 2000}" data-field="ms">` : ""}
        ${act.type === "type" ? `<input type="text" placeholder="입력할 텍스트" value="${act.text || ""}" data-field="text">` : ""}
        ${act.type !== "wait" ? `<input type="text" placeholder="iFrame 셀렉터 (옵션)" value="${act.iframe || ""}" data-field="iframe">` : ""}
      </div>

      <div class="action-options-row">
        <label><input type="checkbox" data-field="optional" ${act.optional ? "checked" : ""}> Optional (실패해도 계속)</label>
        <label><input type="checkbox" data-field="force" ${act.force ? "checked" : ""}> Force Click</label>
      </div>
    `;

    // Bind Change Handlers
    card.querySelectorAll("[data-field]").forEach((input) => {
      input.addEventListener("change", (e) => {
        const field = input.getAttribute("data-field");
        if (input.type === "checkbox") {
          act[field] = input.checked;
        } else if (input.type === "number") {
          act[field] = parseInt(input.value, 10);
        } else {
          act[field] = input.value;
          if (field === "type") renderActionCards();
        }
      });
    });

    // Delete handler
    card.querySelector(".action-delete-btn").addEventListener("click", () => {
      currentPlan.actions.splice(idx, 1);
      renderActionCards();
    });

    actionsList.appendChild(card);
  });
}

// 11. Save Plan
async function handleSavePlan() {
  const slug = slugInput.value.trim() || currentSlug;
  if (!slug) {
    alert("시나리오 식별자(Slug)를 입력해주세요.");
    return;
  }
  if (!currentPlan) {
    alert("저장할 플랜이 없습니다.");
    return;
  }

  try {
    const res = await fetch("/api/scenarios/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug, plan: currentPlan }),
    });
    const data = await res.json();
    if (data.success) {
      alert(`'${slug}' 브라우징 플랜이 성공적으로 저장되었습니다!`);
      fetchScenarios();
    }
  } catch (err) {
    alert("저장 실패: " + err.message);
  }
}

// 12. Run Pipeline (Record & Edit)
async function handleRunPipeline() {
  const slug = slugInput.value.trim() || currentSlug;
  if (!slug) {
    alert("시나리오 식별자(Slug)를 입력해주세요.");
    return;
  }

  // Auto save first
  await handleSavePlan();

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

// 13. SSE for Terminal Logs
function initSSE() {
  if (sseSource) sseSource.close();
  sseSource = new EventSource("/api/record/stream");

  sseSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
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
          fetchScenarios();
          fetchStatus();
          setTimeout(() => {
            selectScenario(data.task.slug);
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

  if (btnClearPrompt) {
    btnClearPrompt.addEventListener("click", () => {
      promptInput.value = "";
      slugInput.value = "";
      promptInput.focus();
    });
  }

  pillGw.addEventListener("click", () => {
    switchTab("tab-generator");
    targetProjectPathInput.focus();
    targetProjectPathInput.select();
  });

  btnAddAction.addEventListener("click", () => {
    const targetUrl = targetBaseUrlInput.value.trim() || "https://gwdev.bc.ac.kr/";
    if (!currentPlan) {
      currentPlan = {
        url: targetUrl,
        viewport: { width: 1920, height: 1080 },
        requiresLogin: true,
        actions: [],
      };
    }
    currentPlan.actions.push({
      type: "click",
      selector: "",
      description: "새 액션",
    });
    renderActionCards();
  });

  btnClearTerminal.addEventListener("click", () => {
    terminalOutput.innerHTML = "";
  });

  btnStopTask.addEventListener("click", async () => {
    await fetch("/api/scenarios/stop", { method: "POST" });
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

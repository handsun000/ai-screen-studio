import express, { type Request, type Response } from "express";
import cors from "cors";
import * as path from "path";
import * as fs from "fs";
import * as dotenv from "dotenv";
import {
  generateBrowsePlanWithGemini,
  normalizeUserPrompt,
  polishPromptWithAI,
} from "../src/services/geminiPlanner";
import {
  listScenarios,
  getScenarioDetails,
  saveBrowsePlan,
  deleteScenario,
  setActiveSlug,
  getActiveSlug,
} from "../src/services/scenarioManager";
import { recordRunner } from "../src/services/recordRunner";
import { renderRunner } from "../src/services/renderRunner";
import { getConfig, updateConfig, analyzeProject } from "../src/services/configManager";
import { UNIVERSAL_TUTORIAL_TEMPLATES } from "../src/services/tutorialTemplates";

import {
  findExistingAuthSession,
  isSessionValid,
  launchInteractiveLogin,
  getAuthFilePath,
  ensureSessionForSlug,
  syncAuthSession,
  triggerLoginComplete,
  normalizeTargetUrl,
} from "../src/services/authManager";
import { actionRecorderService } from "../src/services/actionRecorderService";
import {
  getVideoEditStatus,
  cutVideoSegment,
  restoreVideoBackup,
  mergeRenderedVideos,
} from "../src/services/videoEditorService";
import {
  generateNarrationScript,
  getNarration,
  saveNarrationFile,
  synthesizeNarrationAudio,
} from "../src/services/narrationService";
import { getAiUsageSummary, resetAiUsageStore } from "../src/services/aiUsageTracker";
import { detectAvailableClis, generateAiContent } from "../src/services/aiClient";

dotenv.config({ override: true });

const app = express();
const PORT = process.env.DASHBOARD_PORT || 3333;
const ROOT_DIR = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT_DIR, "data");

app.use(cors());
app.use(express.json({ limit: "10mb" }));

// 1. Health & Config Status API
app.get("/api/status", (_req: Request, res: Response) => {
  const apiKey = process.env.GEMINI_API_KEY || "";
  const config = getConfig();
  const analysis = analyzeProject(config.targetProjectPath);

  const existingAuth = findExistingAuthSession();
  let hasAuth = false;
  if (existingAuth && fs.existsSync(existingAuth)) {
    try {
      const raw = JSON.parse(fs.readFileSync(existingAuth, "utf-8"));
      const cookies = raw.cookies || [];
      hasAuth = cookies.length > 0;
    } catch {
      hasAuth = false;
    }
  }

  res.json({
    geminiApiKeySet: !!apiKey,
    geminiApiKeyPreview: apiKey ? apiKey.substring(0, 8) + "..." : "미설정",
    geminiModel: config.geminiModel,
    aiMode: config.aiMode,
    aiCliProvider: config.aiCliProvider,
    aiCliModel: config.aiCliModel,
    availableClis: detectAvailableClis(),
    targetProjectPath: config.targetProjectPath,
    targetProjectExists: analysis.exists,
    targetBaseUrl: config.targetBaseUrl,
    hasAuthSession: hasAuth,
    authSessionPath: existingAuth,
    activeSlug: getActiveSlug(),
    analysis,
    aiUsage: getAiUsageSummary(),
  });
});

// 1-B. AI Token Usage, Cost & Execution Mode APIs
app.get("/api/ai-usage", (_req: Request, res: Response) => {
  const config = getConfig();
  const apiKey = process.env.GEMINI_API_KEY || "";
  res.json({
    ...getAiUsageSummary(),
    aiMode: config.aiMode,
    aiCliProvider: config.aiCliProvider,
    aiCliModel: config.aiCliModel,
    geminiModel: config.geminiModel,
    geminiApiKeySet: !!apiKey,
    geminiApiKeyPreview: apiKey ? apiKey.substring(0, 8) + "..." : "미설정",
    availableClis: detectAvailableClis(),
  });
});

app.post("/api/ai-usage/reset", (_req: Request, res: Response) => {
  res.json(resetAiUsageStore());
});

app.post("/api/ai-mode", (req: Request, res: Response) => {
  try {
    const { aiMode, aiCliProvider, aiCliModel, geminiModel } = req.body || {};
    const updated = updateConfig({
      aiMode,
      aiCliProvider,
      aiCliModel,
      geminiModel,
    });
    console.log(
      `[Dashboard AI Mode] 실행 모드 변경: ${updated.aiMode.toUpperCase()} (${
        updated.aiMode === "cli" ? `${updated.aiCliProvider}/${updated.aiCliModel}` : updated.geminiModel
      })`
    );
    res.json({
      success: true,
      config: updated,
      availableClis: detectAvailableClis(),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/ai-mode/test", async (req: Request, res: Response) => {
  try {
    const { aiMode, aiCliProvider, aiCliModel } = req.body || {};
    const startMs = Date.now();
    const result = await generateAiContent({
      feature: "AI 연결 테스트",
      prompt: 'Respond with ONLY this JSON object: {"status":"ok","engine":"ready"}',
      temperature: 0,
      jsonMode: true,
      forceMode: aiMode,
      cliProviderOverride: aiCliProvider,
      cliModelOverride: aiCliModel,
      timeoutMs: 30_000,
    });
    res.json({
      success: true,
      elapsedMs: Date.now() - startMs,
      mode: result.mode,
      modelUsed: result.modelUsed,
      responseText: result.text,
    });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: err.message || "AI 연결 테스트 실패",
    });
  }
});

// Auth Session Management APIs
app.get("/api/auth/status", async (req: Request, res: Response) => {
  try {
    const config = getConfig();
    const url = (req.query.url as string) || config.targetBaseUrl || "https://gwdev.unison.co.kr";
    const slug = (req.query.slug as string) || undefined;
    const authPath = findExistingAuthSession(slug);

    if (!authPath) {
      res.json({ authenticated: false, message: "저장된 인증 세션이 없습니다." });
      return;
    }

    const valid = await isSessionValid(url, authPath);
    res.json({
      authenticated: valid,
      authPath,
      message: valid ? "로그인 세션이 유효합니다." : "로그인 세션이 만료되었습니다.",
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/auth/login", async (req: Request, res: Response) => {
  try {
    const rawUrl = (req.body.url || "").trim();
    const config = getConfig();
    const url = normalizeTargetUrl(rawUrl || config.targetBaseUrl || "http://gwdev.apple21.co.kr/");

    // Automatically persist the new targetBaseUrl if changed
    if (rawUrl && url !== config.targetBaseUrl) {
      updateConfig({ targetBaseUrl: url });
      console.log(`[Dashboard Config] 타겟 접속 URL 동기화 및 갱신: ${url}`);
    }

    const slug = req.body.slug;
    const targetAuth = getAuthFilePath(slug);

    console.log(`\n======================================================`);
    console.log(`🌐 [로그인 창 실행 요청]`);
    console.log(`   - 접속 URL: ${url}`);
    console.log(`   - 세션 파일: ${targetAuth}`);
    console.log(`======================================================`);

    const success = await launchInteractiveLogin(
      url,
      targetAuth,
      (msg) => console.log(`[Auth Login] ${msg}`),
      { isServer: true }
    );

    res.json({
      success,
      authPath: targetAuth,
      message: success ? "로그인이 성공적으로 완료되었습니다." : "로그인이 완료되지 않았습니다.",
    });
  } catch (err: any) {
    console.error(`[Auth API 오류]`, err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/auth/complete", (_req: Request, res: Response) => {
  const triggered = triggerLoginComplete();
  res.json({ success: triggered, message: triggered ? "로그인 완료 신호가 전송되었습니다." : "대기 중인 로그인 창이 없습니다." });
});

// Dynamic Config Management APIs
app.get("/api/config", (_req: Request, res: Response) => {
  const config = getConfig();
  const analysis = analyzeProject(config.targetProjectPath);
  res.json({ config, analysis });
});

app.post("/api/config", (req: Request, res: Response) => {
  try {
    const updated = updateConfig(req.body);
    const analysis = analyzeProject(updated.targetProjectPath);
    console.log(`[Dashboard Config] 타겟 설정 변경: ${updated.targetProjectPath || '(Live URL 모드)'} (${updated.targetBaseUrl})`);
    res.json({ success: true, config: updated, analysis });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/project/validate", (req: Request, res: Response) => {
  const { path: checkPath } = req.body;
  const analysis = analyzeProject(checkPath);
  res.json({ analysis });
});

// Universal Tutorial Scenario Templates API
app.get("/api/templates", (_req: Request, res: Response) => {
  res.json({ templates: UNIVERSAL_TUTORIAL_TEMPLATES });
});

// 2. Scenario List API
app.get("/api/scenarios", (_req: Request, res: Response) => {
  try {
    const list = listScenarios();
    res.json({ scenarios: list, activeSlug: getActiveSlug() });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Scenario Details & Delete API
app.get("/api/scenarios/:slug", (req: Request, res: Response) => {
  try {
    const slug = req.params.slug as string;
    const details = getScenarioDetails(slug);
    res.json({ ...details, videoEditStatus: getVideoEditStatus(slug) });
  } catch (err: any) {
    res.status(404).json({ error: err.message });
  }
});

app.delete("/api/scenarios/:slug", (req: Request, res: Response) => {
  try {
    const slug = (req.params.slug as string || "").trim();
    if (!slug) {
      res.status(400).json({ error: "삭제할 시나리오 ID가 필요합니다." });
      return;
    }

    const activeRecord = recordRunner.getCurrentTask();
    if (activeRecord && activeRecord.status === "running" && activeRecord.slug === slug) {
      res.status(400).json({ error: `현재 '${slug}' 시나리오가 녹화 실행 중입니다. 먼저 녹화를 중단한 뒤 삭제해주세요.` });
      return;
    }

    // If this scenario is currently rendering or queued in background, cancel its render first
    renderRunner.stopCurrentTask(slug);

    const result = deleteScenario(slug);
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message || "시나리오 삭제 실패" });
  }
});

let currentAiProgress = "";
const aiProgressListeners = new Set<(msg: string) => void>();

function notifyAiProgress(msg: string) {
  currentAiProgress = msg;
  for (const listener of aiProgressListeners) {
    try {
      listener(msg);
    } catch {}
  }
}

// SSE stream for AI generation progress
app.get("/api/gemini/stream-progress", (req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  if (currentAiProgress) {
    res.write(`data: ${JSON.stringify({ progress: currentAiProgress })}\n\n`);
  }

  const listener = (msg: string) => {
    res.write(`data: ${JSON.stringify({ progress: msg })}\n\n`);
  };

  aiProgressListeners.add(listener);
  req.on("close", () => {
    aiProgressListeners.delete(listener);
  });
});

// 3.5 Prompt Polishing & Step-Chain Normalizer API
app.post("/api/ai/polish-prompt", async (req: Request, res: Response) => {
  try {
    const rawPrompt = (req.body.prompt || "").trim();
    if (!rawPrompt) {
      res.status(400).json({ error: "다듬을 시나리오 문장을 입력해주세요." });
      return;
    }
    const result = await polishPromptWithAI(rawPrompt);
    res.json(result);
  } catch (err: any) {
    const fallback = normalizeUserPrompt(req.body.prompt || "");
    res.json(fallback);
  }
});

// 3.6 Way A: Live Eyedropper & Action Demonstration Recorder APIs
app.post("/api/recorder/start", async (req: Request, res: Response) => {
  try {
    const { url, slug } = req.body || {};
    const status = await actionRecorderService.startRecordingSession({ url, slug });
    res.json({ success: true, status });
  } catch (err: any) {
    console.error("[Recorder Start Error]", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/recorder/status", (_req: Request, res: Response) => {
  res.json(actionRecorderService.getStatus());
});

app.get("/api/recorder/stream", (req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  res.write(`data: ${JSON.stringify(actionRecorderService.getStatus())}\n\n`);

  const unsubscribe = actionRecorderService.onStatusChange((status) => {
    res.write(`data: ${JSON.stringify(status)}\n\n`);
  });

  req.on("close", () => {
    unsubscribe();
  });
});

app.post("/api/recorder/stop", async (req: Request, res: Response) => {
  try {
    const { customTitleHint, slug, directingStyle } = req.body || {};
    const result = await actionRecorderService.stopAndBuildScenario({ customTitleHint, slug, directingStyle });
    if (result.events && result.events.length > 0 && result.suggestedSlug && result.plan) {
      try {
        saveBrowsePlan(result.suggestedSlug, result.plan);
        ensureSessionForSlug(result.suggestedSlug);
      } catch (saveErr: any) {
        console.warn("[Recorder Auto-Save Warning]", saveErr.message);
      }
    }
    res.json({ success: true, ...result });
  } catch (err: any) {
    console.error("[Recorder Stop Error]", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/recorder/cancel", async (_req: Request, res: Response) => {
  try {
    await actionRecorderService.stopRecordingSession(false);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 4. Gemini AI Plan Generation API (supports dynamic project path, URL overrides, and directing style)
app.post("/api/scenarios/generate", async (req: Request, res: Response) => {
  try {
    const { prompt, slug, moduleHint, targetProjectPath, targetUrl, directingStyle, depth, bypassCache } = req.body;
    if (!prompt) {
      res.status(400).json({ error: "시나리오 설명(prompt)을 입력해주세요." });
      return;
    }

    const currentConfig = getConfig();
    const effectivePath = targetProjectPath !== undefined ? targetProjectPath : currentConfig.targetProjectPath;
    const effectiveUrl = targetUrl || currentConfig.targetBaseUrl;

    console.log(`\n[Dashboard API] Generating plan:`);
    console.log(`  - Prompt: "${prompt}"`);
    console.log(`  - Directing Style: ${directingStyle || "standard"}`);
    console.log(`  - Scenario Depth:  ${depth || "standard"}`);
    console.log(`  - Target Path: ${effectivePath || "(None - Live URL Direct Mode)"}`);
    console.log(`  - Target URL:  ${effectiveUrl}`);
    console.log(`  - Bypass Cache: ${!!bypassCache}`);

    notifyAiProgress("🚀 [시작] Gemini 2단계 AI 에이전트 초기화 중...");

    const result = await generateBrowsePlanWithGemini({
      prompt,
      slug,
      moduleHint,
      targetProjectPath: effectivePath,
      targetUrl: effectiveUrl,
      directingStyle,
      depth,
      bypassCache: !!bypassCache,
      onProgress: (msg) => {
        console.log(`[AI Pipeline] ${msg}`);
        notifyAiProgress(msg);
        recordRunner.emit("log", { taskId: "ai-pipeline", line: msg });
      },
    });

    notifyAiProgress("✅ [완료] 브라우징 플랜 및 연출 시퀀스 생성 완료!");
    if (result && result.suggestedSlug) {
      try {
        ensureSessionForSlug(result.suggestedSlug);
      } catch {}
    }
    res.json(result);
  } catch (err: any) {
    console.error("[Dashboard API] Generate error:", err);
    notifyAiProgress(`❌ [오류] 시나리오 생성 실패: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// 5. Save Browse Plan API
app.post("/api/scenarios/save", (req: Request, res: Response) => {
  try {
    const { slug, plan } = req.body;
    if (!slug || !plan) {
      res.status(400).json({ error: "slug와 plan이 모두 필요합니다." });
      return;
    }

    const saved = saveBrowsePlan(slug, plan);
    try {
      ensureSessionForSlug(slug);
    } catch {}
    res.json(saved);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 6. Record Pipeline Execution API
app.post("/api/scenarios/record", (req: Request, res: Response) => {
  try {
    const { slug, headed, login } = req.body;
    if (!slug) {
      res.status(400).json({ error: "slug가 필요합니다." });
      return;
    }

    // Ensure session is propagated to the scenario folder before recording starts
    try {
      ensureSessionForSlug(slug);
    } catch {}

    const task = recordRunner.startRecord(slug, { headed, login });
    res.json({ success: true, task });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Stop current recording task (isolated from background rendering)
app.post("/api/scenarios/stop", (_req: Request, res: Response) => {
  const recordStopped = recordRunner.stopCurrentTask();
  res.json({ success: recordStopped });
});

// Render Video with Remotion APIs (Scenario-Isolated Background Queue)
app.post("/api/render/start", (req: Request, res: Response) => {
  try {
    const { slug, fps } = req.body || {};
    if (!slug) {
      res.status(400).json({ error: "slug가 필요합니다." });
      return;
    }

    const targetFps: 30 | 60 = Number(fps) === 60 ? 60 : 30;
    const task = renderRunner.startRender(slug, { fps: targetFps });
    res.json({ success: true, task, queue: renderRunner.getQueue() });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/render/stop", (req: Request, res: Response) => {
  const { slug } = req.body || {};
  const stopped = renderRunner.stopCurrentTask(typeof slug === "string" ? slug : undefined);
  res.json({
    success: stopped,
    task: renderRunner.getCurrentTask(),
    queue: renderRunner.getQueue(),
  });
});

app.get("/api/render/status", (_req: Request, res: Response) => {
  const task = renderRunner.getCurrentTask();
  const queue = renderRunner.getQueue();
  res.json({ task, queue });
});

app.get("/api/render/info/:slug", (req: Request, res: Response) => {
  const slug = req.params.slug as string;
  const info = renderRunner.getRenderInfo(slug);
  res.json(info);
});

// Get current recording task status
app.get("/api/record/status", (_req: Request, res: Response) => {
  const task = recordRunner.getCurrentTask();
  res.json({ task });
});

// Send Input (Enter / Text) to Record Process
app.post("/api/record/input", (req: Request, res: Response) => {
  try {
    const { input } = req.body || {};
    const success = recordRunner.sendInput(input !== undefined ? input : "\n");
    if (success) {
      res.json({ success: true, message: "입력이 프로세스로 전송되었습니다." });
    } else {
      res.status(400).json({
        success: false,
        error: "현재 실행 중인 녹화 프로세스가 없거나 입력을 받을 수 없는 상태입니다.",
      });
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// SSE Stream for Live Recording & Isolated Background Rendering Events
app.get("/api/record/stream", (req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  // Send current recording task snapshot first
  const currentRecordTask = recordRunner.getCurrentTask();
  if (currentRecordTask) {
    res.write(`data: ${JSON.stringify({ type: "snapshot", task: currentRecordTask })}\n\n`);
  }

  // Send current background render snapshot separately
  const currentRenderTask = renderRunner.getCurrentTask();
  const currentRenderQueue = renderRunner.getQueue();
  if (currentRenderTask || currentRenderQueue.length > 0) {
    res.write(
      `data: ${JSON.stringify({
        type: "render-snapshot",
        task: currentRenderTask,
        queue: currentRenderQueue,
      })}\n\n`
    );
  }

  const recordLogHandler = (data: { taskId: string; line: string }) => {
    res.write(`data: ${JSON.stringify({ type: "log", ...data })}\n\n`);
  };

  const recordStatusHandler = (task: any) => {
    res.write(`data: ${JSON.stringify({ type: "status", task })}\n\n`);
  };

  const renderLogHandler = (data: {
    taskId: string;
    slug?: string;
    line: string;
    isProgress?: boolean;
    percent?: number;
    renderedFrames?: number;
    totalFrames?: number;
  }) => {
    if (data.isProgress) {
      res.write(
        `data: ${JSON.stringify({
          type: "render-progress",
          ...data,
          task: renderRunner.getCurrentTask(),
          queue: renderRunner.getQueue(),
        })}\n\n`
      );
    } else {
      res.write(
        `data: ${JSON.stringify({
          type: "render-log",
          ...data,
          task: renderRunner.getCurrentTask(),
          queue: renderRunner.getQueue(),
        })}\n\n`
      );
    }
  };

  const renderStatusHandler = (task: any) => {
    res.write(
      `data: ${JSON.stringify({
        type: "render-status",
        task,
        queue: renderRunner.getQueue(),
      })}\n\n`
    );
  };

  recordRunner.on("log", recordLogHandler);
  recordRunner.on("status", recordStatusHandler);
  renderRunner.on("log", renderLogHandler);
  renderRunner.on("status", renderStatusHandler);

  req.on("close", () => {
    recordRunner.off("log", recordLogHandler);
    recordRunner.off("status", recordStatusHandler);
    renderRunner.off("log", renderLogHandler);
    renderRunner.off("status", renderStatusHandler);
  });
});

// 7. Activate Scenario in Root.tsx
app.post("/api/scenarios/activate", (req: Request, res: Response) => {
  try {
    const { slug } = req.body;
    if (!slug) {
      res.status(400).json({ error: "slug가 필요합니다." });
      return;
    }
    const success = setActiveSlug(slug);
    res.json({ success, activeSlug: getActiveSlug() });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

function streamMp4File(filePath: string, req: Request, res: Response) {
  if (!fs.existsSync(filePath)) {
    res.status(404).send("비디오 파일을 찾을 수 없습니다.");
    return;
  }

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    let end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    if (end >= fileSize) end = fileSize - 1;

    if (isNaN(start) || start >= fileSize || start < 0 || end < start) {
      res.writeHead(416, {
        "Content-Range": `bytes */${fileSize}`,
      });
      res.end();
      return;
    }

    const chunksize = end - start + 1;
    const file = fs.createReadStream(filePath, { start, end });
    file.on("error", () => {
      if (!res.headersSent) res.status(404).end();
    });
    const head = {
      "Content-Range": `bytes ${start}-${end}/${fileSize}`,
      "Accept-Ranges": "bytes",
      "Content-Length": chunksize,
      "Content-Type": "video/mp4",
    };
    res.writeHead(206, head);
    file.pipe(res);
  } else {
    const head = {
      "Content-Length": fileSize,
      "Content-Type": "video/mp4",
    };
    res.writeHead(200, head);
    const file = fs.createReadStream(filePath);
    file.on("error", () => {
      if (!res.headersSent) res.status(404).end();
    });
    file.pipe(res);
  }
}

// 8. Stream Raw Recording Video
app.get("/api/video/:slug", (req: Request, res: Response) => {
  const slug = req.params.slug as string;
  const videoPath = path.join(DATA_DIR, slug, "recording.mp4");
  streamMp4File(videoPath, req, res);
});

// 9. Stream Rendered (Final Composed) Video
app.get("/api/rendered-video/:slug", (req: Request, res: Response) => {
  const slug = req.params.slug as string;
  const renderedPath = path.join(ROOT_DIR, "output", `${slug}.mp4`);
  streamMp4File(renderedPath, req, res);
});

// 10. Direct Download Final MP4
app.get("/api/download/:slug", (req: Request, res: Response) => {
  const slug = req.params.slug as string;
  const renderedPath = path.join(ROOT_DIR, "output", `${slug}.mp4`);

  if (!fs.existsSync(renderedPath)) {
    res.status(404).send(`렌더링된 최종 영상 'output/${slug}.mp4'를 찾을 수 없습니다. 먼저 렌더링을 실행해주세요.`);
    return;
  }

  const filename = `${slug}-final.mp4`;
  res.download(renderedPath, filename, (err) => {
    if (err) {
      console.error("다운로드 에러:", err);
      if (!res.headersSent) res.status(500).send("다운로드 중 오류가 발생했습니다.");
    }
  });
});

// 11. AI Narration Script & Edge Neural TTS APIs
app.get("/api/narration/:slug", (req: Request, res: Response) => {
  try {
    const slug = req.params.slug as string;
    const narration = getNarration(slug);
    res.json({ narration });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/narration/:slug/generate", async (req: Request, res: Response) => {
  try {
    const slug = req.params.slug as string;
    const { voice, rate, pitch, style, enabled, showSubtitles } = req.body || {};
    const narration = await generateNarrationScript(slug, {
      voice,
      rate,
      pitch,
      style,
      enabled,
      showSubtitles,
      synthesizeAudio: true,
    });
    const editPlanPath = path.join(DATA_DIR, slug, "edit-plan.json");
    const editPlan = fs.existsSync(editPlanPath) ? JSON.parse(fs.readFileSync(editPlanPath, "utf-8")) : undefined;
    res.json({ success: true, narration, editPlan });
  } catch (err: any) {
    console.error("[Narration Generate Error]", err);
    res.status(500).json({ error: err.message || "AI 대본 생성 중 오류가 발생했습니다." });
  }
});

app.post("/api/narration/:slug/save", (req: Request, res: Response) => {
  try {
    const slug = req.params.slug as string;
    const { narration, synthesize } = req.body || {};
    if (!narration) {
      res.status(400).json({ error: "저장할 대본 데이터가 없습니다." });
      return;
    }
    let saved = saveNarrationFile(slug, narration);
    if (synthesize !== false) {
      saved = synthesizeNarrationAudio(slug, saved.voice, saved.rate, saved.pitch) || saved;
    }
    const editPlanPath = path.join(DATA_DIR, slug, "edit-plan.json");
    const editPlan = fs.existsSync(editPlanPath) ? JSON.parse(fs.readFileSync(editPlanPath, "utf-8")) : undefined;
    res.json({ success: true, narration: saved, editPlan });
  } catch (err: any) {
    console.error("[Narration Save Error]", err);
    res.status(500).json({ error: err.message || "대본 저장 및 음성 합성 중 오류가 발생했습니다." });
  }
});

app.get("/api/narration/audio/:slug/:filename", (req: Request, res: Response) => {
  const slug = req.params.slug as string;
  const filename = path.basename(req.params.filename as string);
  const audioPath = path.join(DATA_DIR, slug, "audio", filename);
  if (!fs.existsSync(audioPath)) {
    res.status(404).send("오디오 파일을 찾을 수 없습니다.");
    return;
  }
  res.setHeader("Content-Type", "audio/mpeg");
  res.setHeader("Cache-Control", "no-store");
  fs.createReadStream(audioPath).pipe(res);
});

// 12. Direct Video Cut & Undo/Restore APIs
app.get("/api/video-edit/:slug/status", (req: Request, res: Response) => {
  try {
    const slug = req.params.slug as string;
    res.json({ status: getVideoEditStatus(slug) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/video-edit/:slug/cut", (req: Request, res: Response) => {
  try {
    const slug = req.params.slug as string;
    const { startSec, endSec } = req.body || {};
    const result = cutVideoSegment(slug, Number(startSec), Number(endSec));
    res.json(result);
  } catch (err: any) {
    console.error("[Video Cut Error]", err);
    res.status(400).json({ error: err.message || "구간 잘라내기 중 오류가 발생했습니다." });
  }
});

app.post("/api/video-edit/:slug/restore", (req: Request, res: Response) => {
  try {
    const slug = req.params.slug as string;
    const mode = req.body?.mode === "orig" ? "orig" : "undo";
    const result = restoreVideoBackup(slug, mode);
    res.json(result);
  } catch (err: any) {
    console.error("[Video Restore Error]", err);
    res.status(400).json({ error: err.message || "영상 복원 중 오류가 발생했습니다." });
  }
});

// 13. Rendered Videos Lossless Chapter Merge (Concat) API
app.post("/api/video-edit/merge", (req: Request, res: Response) => {
  try {
    const { slugs, outputSlug } = req.body || {};
    const result = mergeRenderedVideos({ slugs, outputSlug });
    res.json(result);
  } catch (err: any) {
    console.error("[Video Merge Error]", err);
    res.status(400).json({ error: err.message || "렌더링된 영상 합치기 중 오류가 발생했습니다." });
  }
});

// Static frontend serving
const DASHBOARD_DIR = path.join(ROOT_DIR, "dashboard");
app.use(express.static(DASHBOARD_DIR));

// Fallback to index.html for SPA routing
app.use((_req: Request, res: Response) => {
  const indexPath = path.join(DASHBOARD_DIR, "index.html");
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.send("Dashboard UI is building. Please refresh in a moment.");
  }
});

app.listen(PORT, () => {
  const config = getConfig();
  console.log(`\n======================================================`);
  console.log(`🎬 Screen Demo AI Studio Web Dashboard Started!`);
  console.log(`👉 http://localhost:${PORT}`);
  console.log(`   - Google AI Studio: ${config.geminiModel} (Connected)`);
  console.log(`   - Target Project:   ${config.targetProjectPath || '(None - Live URL Direct Mode)'}`);
  console.log(`   - Target URL:       ${config.targetBaseUrl}`);
  console.log(`======================================================\n`);
});

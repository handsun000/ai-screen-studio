import express, { type Request, type Response } from "express";
import cors from "cors";
import * as path from "path";
import * as fs from "fs";
import * as dotenv from "dotenv";
import { generateBrowsePlanWithGemini } from "../src/services/geminiPlanner";
import {
  listScenarios,
  getScenarioDetails,
  saveBrowsePlan,
  setActiveSlug,
  getActiveSlug,
} from "../src/services/scenarioManager";
import { recordRunner } from "../src/services/recordRunner";
import { renderRunner } from "../src/services/renderRunner";
import { getConfig, updateConfig, analyzeProject } from "../src/services/configManager";
import { UNIVERSAL_TUTORIAL_TEMPLATES } from "../src/services/tutorialTemplates";

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

  // Check auth session file in any scenario or root data
  const hasAuth =
    fs.existsSync(path.join(DATA_DIR, "approval-draft", "auth.json")) ||
    fs.existsSync(path.join(DATA_DIR, "login-and-install", "auth.json")) ||
    fs.existsSync(path.join(DATA_DIR, "auth.json"));

  res.json({
    geminiApiKeySet: !!apiKey,
    geminiApiKeyPreview: apiKey ? apiKey.substring(0, 8) + "..." : "미설정",
    geminiModel: config.geminiModel,
    targetProjectPath: config.targetProjectPath,
    targetProjectExists: analysis.exists,
    targetBaseUrl: config.targetBaseUrl,
    hasAuthSession: hasAuth,
    activeSlug: getActiveSlug(),
    analysis,
  });
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

// 3. Scenario Details API
app.get("/api/scenarios/:slug", (req: Request, res: Response) => {
  try {
    const slug = req.params.slug as string;
    const details = getScenarioDetails(slug);
    res.json(details);
  } catch (err: any) {
    res.status(404).json({ error: err.message });
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

    const task = recordRunner.startRecord(slug, { headed, login });
    res.json({ success: true, task });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Stop current task (record or render)
app.post("/api/scenarios/stop", (_req: Request, res: Response) => {
  const recordStopped = recordRunner.stopCurrentTask();
  const renderStopped = renderRunner.stopCurrentTask();
  res.json({ success: recordStopped || renderStopped });
});

// Render Video with Remotion APIs
app.post("/api/render/start", (req: Request, res: Response) => {
  try {
    const { slug } = req.body;
    if (!slug) {
      res.status(400).json({ error: "slug가 필요합니다." });
      return;
    }

    const task = renderRunner.startRender(slug);
    res.json({ success: true, task });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/render/stop", (_req: Request, res: Response) => {
  const stopped = renderRunner.stopCurrentTask();
  res.json({ success: stopped });
});

app.get("/api/render/status", (_req: Request, res: Response) => {
  const task = renderRunner.getCurrentTask();
  res.json({ task });
});

app.get("/api/render/info/:slug", (req: Request, res: Response) => {
  const slug = req.params.slug as string;
  const info = renderRunner.getRenderInfo(slug);
  res.json(info);
});

// Get current task status
app.get("/api/record/status", (_req: Request, res: Response) => {
  const task = recordRunner.getCurrentTask() || renderRunner.getCurrentTask();
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

// SSE Stream for Live Recording & Rendering Logs
app.get("/api/record/stream", (req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  // Send current task snapshot first
  const currentTask = recordRunner.getCurrentTask() || renderRunner.getCurrentTask();
  if (currentTask) {
    res.write(`data: ${JSON.stringify({ type: "snapshot", task: currentTask })}\n\n`);
  }

  const logHandler = (data: { taskId: string; line: string }) => {
    res.write(`data: ${JSON.stringify({ type: "log", ...data })}\n\n`);
  };

  const statusHandler = (task: any) => {
    res.write(`data: ${JSON.stringify({ type: "status", task })}\n\n`);
  };

  recordRunner.on("log", logHandler);
  recordRunner.on("status", statusHandler);
  renderRunner.on("log", logHandler);
  renderRunner.on("status", statusHandler);

  req.on("close", () => {
    recordRunner.off("log", logHandler);
    recordRunner.off("status", statusHandler);
    renderRunner.off("log", logHandler);
    renderRunner.off("status", statusHandler);
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

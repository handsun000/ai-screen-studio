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
import { getConfig, updateConfig, analyzeProject } from "../src/services/configManager";
import { UNIVERSAL_TUTORIAL_TEMPLATES } from "../src/services/tutorialTemplates";

dotenv.config();

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
    console.log(`[Dashboard Config] 타겟 프로젝트 변경: ${updated.targetProjectPath} (${updated.targetBaseUrl})`);
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
    const details = getScenarioDetails(req.params.slug);
    res.json(details);
  } catch (err: any) {
    res.status(404).json({ error: err.message });
  }
});

// 4. Gemini AI Plan Generation API (supports dynamic project path, URL overrides, and directing style)
app.post("/api/scenarios/generate", async (req: Request, res: Response) => {
  try {
    const { prompt, slug, moduleHint, targetProjectPath, targetUrl, directingStyle } = req.body;
    if (!prompt) {
      res.status(400).json({ error: "시나리오 설명(prompt)을 입력해주세요." });
      return;
    }

    const currentConfig = getConfig();
    const effectivePath = targetProjectPath || currentConfig.targetProjectPath;
    const effectiveUrl = targetUrl || currentConfig.targetBaseUrl;

    console.log(`\n[Dashboard API] Generating plan:`);
    console.log(`  - Prompt: "${prompt}"`);
    console.log(`  - Directing Style: ${directingStyle || "standard"}`);
    console.log(`  - Target Path: ${effectivePath}`);
    console.log(`  - Target URL:  ${effectiveUrl}`);

    const result = await generateBrowsePlanWithGemini({
      prompt,
      slug,
      moduleHint,
      targetProjectPath: effectivePath,
      targetUrl: effectiveUrl,
      directingStyle,
    });

    res.json(result);
  } catch (err: any) {
    console.error("[Dashboard API] Generate error:", err);
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

// Stop current task
app.post("/api/scenarios/stop", (_req: Request, res: Response) => {
  const stopped = recordRunner.stopCurrentTask();
  res.json({ success: stopped });
});

// Get current task status
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

// SSE Stream for Live Recording Logs
app.get("/api/record/stream", (req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  // Send current task snapshot first
  const currentTask = recordRunner.getCurrentTask();
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

  req.on("close", () => {
    recordRunner.off("log", logHandler);
    recordRunner.off("status", statusHandler);
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

// 8. Stream Video with HTTP 206 Range Support
app.get("/api/video/:slug", (req: Request, res: Response) => {
  const slug = req.params.slug;
  const videoPath = path.join(DATA_DIR, slug, "recording.mp4");

  if (!fs.existsSync(videoPath)) {
    res.status(404).send("Video file not found");
    return;
  }

  const stat = fs.statSync(videoPath);
  const fileSize = stat.size;
  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunksize = end - start + 1;
    const file = fs.createReadStream(videoPath, { start, end });
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
    fs.createReadStream(videoPath).pipe(res);
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
  console.log(`   - Target Project:   ${config.targetProjectPath}`);
  console.log(`   - Target URL:       ${config.targetBaseUrl}`);
  console.log(`======================================================\n`);
});

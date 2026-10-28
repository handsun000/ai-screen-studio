const { app, BrowserWindow, ipcMain, nativeTheme, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const http = require("http");
const { spawn, execSync } = require("child_process");

const ROOT_DIR = path.resolve(__dirname, "..");
const ICON_PATH = path.join(ROOT_DIR, "assets", "icon.ico");
const PRELOAD_PATH = path.join(__dirname, "desktop-preload.cjs");
const PORT = process.env.DASHBOARD_PORT || 3333;
const DASHBOARD_URL = `http://localhost:${PORT}`;

let mainWindow = null;
let serverProcess = null;
let spawnedByDesktop = false;

app.setName("Screen Demo Studio");
if (process.platform === "win32") {
  app.setAppUserModelId("com.screendemo.studio");
}

const gotSingleLock = app.requestSingleInstanceLock();
if (!gotSingleLock) {
  app.quit();
  process.exit(0);
}

app.on("second-instance", () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

function applyOverlayTheme(theme) {
  const isDark = theme === "dark";
  nativeTheme.themeSource = isDark ? "dark" : "light";
  if (mainWindow && !mainWindow.isDestroyed() && typeof mainWindow.setTitleBarOverlay === "function") {
    try {
      mainWindow.setTitleBarOverlay({
        color: isDark ? "#272727" : "#f9f9f9",
        symbolColor: isDark ? "#ffffff" : "#1a1a1a",
        height: 51,
      });
    } catch {
      // ignore if unsupported on older OS builds
    }
  }
}

ipcMain.on("desktop:set-theme", (_event, theme) => {
  applyOverlayTheme(theme);
});

function checkServerReady() {
  return new Promise((resolve) => {
    const req = http.get(`${DASHBOARD_URL}/api/ai-usage`, { timeout: 1200 }, (res) => {
      const ct = String(res.headers["content-type"] || "");
      res.resume();
      resolve(res.statusCode === 200 && ct.includes("application/json"));
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

function killStalePortServer() {
  if (process.platform !== "win32") return;
  try {
    const out = execSync(
      `powershell -NoProfile -Command "(Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue).OwningProcess"`,
      { encoding: "utf8", windowsHide: true }
    ).trim();
    const pid = parseInt(out.split(/\r?\n/)[0], 10);
    if (pid && pid > 0) {
      console.log(`[Desktop] Killing stale server process PID ${pid} on port ${PORT}...`);
      execSync(`taskkill /pid ${pid} /T /F`, { stdio: "ignore", windowsHide: true });
    }
  } catch {
    // ignore if none
  }
}

async function ensureBackendServer() {
  const alreadyRunning = await checkServerReady();
  if (alreadyRunning) {
    console.log(`[Desktop] Existing up-to-date dashboard server detected at ${DASHBOARD_URL}`);
    return true;
  }

  killStalePortServer();

  console.log(`[Desktop] Starting dashboard server on port ${PORT}...`);
  const tsxCli = path.join(ROOT_DIR, "node_modules", "tsx", "dist", "cli.mjs");
  const serverScript = path.join(ROOT_DIR, "scripts", "dashboard-server.ts");
  const defaultNode = "C:\\Program Files\\nodejs\\node.exe";
  const nodeBin = fs.existsSync(defaultNode) ? defaultNode : "node";

  serverProcess = spawn(nodeBin, [tsxCli, "watch", serverScript], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      DESKTOP_APP: "1",
    },
    stdio: "ignore",
    windowsHide: true,
  });
  spawnedByDesktop = true;

  for (let i = 0; i < 60; i++) {
    const ready = await checkServerReady();
    if (ready) {
      console.log(`[Desktop] Dashboard server is ready at ${DASHBOARD_URL}`);
      return true;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

function stopBackendServer() {
  if (!serverProcess || !spawnedByDesktop) return;
  try {
    if (process.platform === "win32" && serverProcess.pid) {
      execSync(`taskkill /pid ${serverProcess.pid} /T /F`, { stdio: "ignore", windowsHide: true });
    } else {
      serverProcess.kill("SIGTERM");
    }
  } catch {
    // ignore cleanup errors
  }
  serverProcess = null;
}

function getSplashDataUrl() {
  const html = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<style>
  body {
    margin: 0;
    height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    background: #f3f3f3;
    color: #1a1a1a;
    font-family: "Segoe UI Variable Text", "Pretendard Variable", "Malgun Gothic", sans-serif;
    user-select: none;
    -webkit-app-region: drag;
  }
  .logo-card {
    width: 84px;
    height: 84px;
    margin-bottom: 18px;
    filter: drop-shadow(0 8px 20px rgba(0, 95, 184, 0.25));
    animation: pulse 1.8s ease-in-out infinite;
  }
  h1 {
    margin: 0 0 6px;
    font-size: 20px;
    font-weight: 700;
    letter-spacing: -0.02em;
  }
  h1 span { color: #005fb8; }
  p {
    margin: 0;
    font-size: 13px;
    color: #5c5c5c;
  }
  @keyframes pulse {
    0%, 100% { transform: scale(1); }
    50% { transform: scale(1.04); }
  }
</style>
</head>
<body>
  <svg class="logo-card" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bgA" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#0086F0"/>
        <stop offset="55%" stop-color="#005FB8"/>
        <stop offset="100%" stop-color="#003E7E"/>
      </linearGradient>
    </defs>
    <rect x="24" y="24" width="464" height="464" rx="108" fill="url(#bgA)"/>
    <rect x="88" y="144" width="232" height="224" rx="42" fill="#FFFFFF"/>
    <path d="M338 214 L412 162 C424 153 440 162 440 177 L440 335 C440 350 424 359 412 350 L338 298 Z" fill="#FFFFFF"/>
    <path d="M174 210 C174 202 183 197 190 202 L254 246 C260 250 260 262 254 266 L190 310 C183 315 174 310 174 302 Z" fill="#005FB8"/>
  </svg>
  <h1>Screen Demo <span>Studio</span></h1>
  <p>로컬 AI 스튜디오 엔진을 준비하고 있습니다...</p>
</body>
</html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    title: "Screen Demo Studio",
    width: 1540,
    height: 940,
    minWidth: 1120,
    minHeight: 720,
    backgroundColor: "#f3f3f3",
    icon: ICON_PATH,
    autoHideMenuBar: true,
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#f9f9f9",
      symbolColor: "#1a1a1a",
      height: 51,
    },
    show: false,
    webPreferences: {
      preload: PRELOAD_PATH,
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.once("ready-to-show", () => {
    if (mainWindow) mainWindow.show();
  });

  // Sync overlay theme whenever page finishes loading
  mainWindow.webContents.on("did-finish-load", async () => {
    try {
      const currentTheme = await mainWindow.webContents.executeJavaScript(
        `document.documentElement.setAttribute("data-desktop", "true");
         localStorage.getItem("screen_demo_theme") || document.documentElement.getAttribute("data-theme") || "light";`
      );
      applyOverlayTheme(currentTheme);
    } catch {
      // ignore on splash screen
    }
  });

  // Open external target links in default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(DASHBOARD_URL)) {
      shell.openExternal(url);
      return { action: "deny" };
    }
    return { action: "allow" };
  });

  // Keyboard shortcuts for convenience (F5 Reload, F12 DevTools)
  mainWindow.webContents.on("before-input-event", (event, input) => {
    if (input.type === "keyDown") {
      if (input.key === "F5" || (input.control && input.key.toLowerCase() === "r")) {
        event.preventDefault();
        mainWindow.webContents.reload();
      } else if (input.key === "F12" || (input.control && input.shift && input.key.toLowerCase() === "i")) {
        event.preventDefault();
        mainWindow.webContents.toggleDevTools();
      }
    }
  });

  const isAlreadyUp = await checkServerReady();
  if (!isAlreadyUp) {
    await mainWindow.loadURL(getSplashDataUrl());
    await ensureBackendServer();
  }

  await mainWindow.loadURL(DASHBOARD_URL);

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  stopBackendServer();
  app.quit();
});

app.on("before-quit", () => {
  stopBackendServer();
});

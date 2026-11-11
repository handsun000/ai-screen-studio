import * as fs from "fs";
import * as path from "path";
import * as https from "https";
import { execSync, spawnSync } from "child_process";

const ROOT_DIR = path.resolve(__dirname, "..");
const RESOURCES_DIR = path.join(ROOT_DIR, "resources");
const BIN_DIR = path.join(RESOURCES_DIR, "bin");
const FFMPEG_TARGET_DIR = path.join(BIN_DIR, "ffmpeg");
const PYTHON_TARGET_DIR = path.join(BIN_DIR, "python");
const BROWSER_TARGET_DIR = path.join(BIN_DIR, "browser");

function downloadFile(url: string, destPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    const request = (targetUrl: string) => {
      https
        .get(targetUrl, (response) => {
          if (
            response.statusCode &&
            response.statusCode >= 300 &&
            response.statusCode < 400 &&
            response.headers.location
          ) {
            // Handle HTTP redirects
            request(response.headers.location);
            return;
          }
          if (response.statusCode !== 200) {
            file.close();
            fs.unlinkSync(destPath);
            reject(new Error(`다운로드 실패 (${response.statusCode}): ${targetUrl}`));
            return;
          }
          response.pipe(file);
          file.on("finish", () => {
            file.close(() => resolve());
          });
        })
        .on("error", (err) => {
          file.close();
          try {
            if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
          } catch {}
          reject(err);
        });
    };
    request(url);
  });
}

function findExecutable(name: string): string {
  try {
    const out = execSync(`where.exe ${name}`, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const firstLine = out.split(/\r?\n/)[0]?.trim();
    if (firstLine && fs.existsSync(firstLine)) return firstLine;
  } catch {}
  return "";
}

async function bundleFFmpeg() {
  console.log("\n[1/3] 🎬 FFmpeg & FFprobe 번들링 준비 중...");
  fs.mkdirSync(FFMPEG_TARGET_DIR, { recursive: true });

  const targetFfmpeg = path.join(FFMPEG_TARGET_DIR, "ffmpeg.exe");
  const targetFfprobe = path.join(FFMPEG_TARGET_DIR, "ffprobe.exe");

  if (fs.existsSync(targetFfmpeg) && fs.existsSync(targetFfprobe)) {
    console.log("  ✓ resources/bin/ffmpeg 에 이미 ffmpeg.exe 및 ffprobe.exe 가 준비되어 있습니다.");
    return;
  }

  const srcFfmpeg = findExecutable("ffmpeg");
  const srcFfprobe = findExecutable("ffprobe");

  if (!srcFfmpeg || !srcFfprobe) {
    throw new Error(
      "호스트 시스템에서 ffmpeg 또는 ffprobe를 찾을 수 없습니다. winget install Gyan.FFmpeg 등으로 먼저 설치해주세요."
    );
  }

  console.log(`  - 복사 중: ${srcFfmpeg} -> ${targetFfmpeg}`);
  fs.copyFileSync(srcFfmpeg, targetFfmpeg);

  console.log(`  - 복사 중: ${srcFfprobe} -> ${targetFfprobe}`);
  fs.copyFileSync(srcFfprobe, targetFfprobe);

  console.log("  ✓ FFmpeg & FFprobe 복사 완료!");
}

async function bundlePython() {
  console.log("\n[2/3] 🐍 윈도우용 Embedded Python (포터블 무설치) 번들링 준비 중...");
  fs.mkdirSync(PYTHON_TARGET_DIR, { recursive: true });

  const pythonExe = path.join(PYTHON_TARGET_DIR, "python.exe");
  if (fs.existsSync(pythonExe)) {
    // Check if edge-tts is already installed
    const chk = spawnSync(pythonExe, ["-c", "import edge_tts; print(edge_tts.__version__)"], {
      encoding: "utf-8",
    });
    if (chk.status === 0 && chk.stdout.trim()) {
      console.log(`  ✓ Embedded Python 환경 준비 완료 (edge-tts v${chk.stdout.trim()})`);
      return;
    }
  }

  const zipPath = path.join(BIN_DIR, "python-embed.zip");
  const embedUrl = "https://www.python.org/ftp/python/3.11.9/python-3.11.9-embed-amd64.zip";

  console.log(`  - Python 3.11.9 Embed 패키지 다운로드 중 (약 10MB)...`);
  await downloadFile(embedUrl, zipPath);

  console.log(`  - 압축 해제 중 -> ${PYTHON_TARGET_DIR}`);
  execSync(`powershell -NoProfile -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${PYTHON_TARGET_DIR}' -Force"`);
  try {
    fs.unlinkSync(zipPath);
  } catch {}

  // Enable 'import site' in python311._pth so pip and site-packages can be loaded
  const pthFile = path.join(PYTHON_TARGET_DIR, "python311._pth");
  if (fs.existsSync(pthFile)) {
    let pthContent = fs.readFileSync(pthFile, "utf-8");
    pthContent = pthContent.replace(/#\s*import\s+site/g, "import site");
    if (!pthContent.includes("import site")) {
      pthContent += "\nimport site\n";
    }
    fs.writeFileSync(pthFile, pthContent, "utf-8");
  }

  // Download and run get-pip.py
  const getPipPath = path.join(PYTHON_TARGET_DIR, "get-pip.py");
  console.log("  - pip 부트스트랩(get-pip.py) 다운로드 중...");
  await downloadFile("https://bootstrap.pypa.io/get-pip.py", getPipPath);

  console.log("  - pip 설치 실행 중...");
  execSync(`"${pythonExe}" "${getPipPath}" --no-warn-script-location`, {
    cwd: PYTHON_TARGET_DIR,
    stdio: "inherit",
  });
  try {
    fs.unlinkSync(getPipPath);
  } catch {}

  // Install edge-tts into embedded python
  console.log("  - edge-tts 라이브러리 설치 중 (음성 합성용)...");
  execSync(`"${pythonExe}" -m pip install --no-warn-script-location edge-tts`, {
    cwd: PYTHON_TARGET_DIR,
    stdio: "inherit",
  });

  console.log("  ✓ Embedded Python 및 edge-tts 번들링 완료!");
}

async function bundleBrowser() {
  console.log("\n[3/3] 🌐 Playwright Chromium 브라우저 번들링 준비 중...");
  fs.mkdirSync(BROWSER_TARGET_DIR, { recursive: true });

  const localAppData = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || "", "AppData", "Local");
  const hostPlaywrightDir = path.join(localAppData, "ms-playwright");

  if (!fs.existsSync(hostPlaywrightDir)) {
    throw new Error(`호스트 ms-playwright 디렉터리를 찾을 수 없습니다: ${hostPlaywrightDir}`);
  }

  // Find chromium folder (e.g. chromium-1243 or chromium-1234)
  const entries = fs.readdirSync(hostPlaywrightDir);
  const chromiumDirs = entries
    .filter((e) => e.startsWith("chromium-") && !e.includes("headless"))
    .sort()
    .reverse();

  if (chromiumDirs.length === 0) {
    throw new Error("설치된 Playwright Chromium 폴더를 찾을 수 없습니다. npx playwright install chromium 을 먼저 실행해주세요.");
  }

  const selectedChromium = chromiumDirs[0];
  const versionSuffix = selectedChromium.replace("chromium-", "");

  // Find latest ffmpeg and winldd folders in ms-playwright for Playwright's recordVideo engine
  const ffmpegDirs = entries.filter((e) => e.startsWith("ffmpeg-")).sort().reverse();
  const selectedFfmpeg = ffmpegDirs[0] || "ffmpeg-1011";

  const winlddDirs = entries.filter((e) => e.startsWith("winldd-")).sort().reverse();
  const selectedWinldd = winlddDirs[0] || "winldd-1007";

  const targetDirs = [
    selectedChromium,
    `chromium_headless_shell-${versionSuffix}`,
    selectedFfmpeg,
    selectedWinldd,
  ];

  for (const dirName of targetDirs) {
    const srcPath = path.join(hostPlaywrightDir, dirName);
    const targetPath = path.join(BROWSER_TARGET_DIR, dirName);

    if (fs.existsSync(targetPath)) {
      console.log(`  ✓ resources/bin/browser/${dirName} 에 이미 준비되어 있습니다.`);
      continue;
    }

    if (!fs.existsSync(srcPath)) {
      console.log(`  ⚠️ 호스트에 ${dirName} 폴더가 없습니다 (건너뜀).`);
      continue;
    }

    console.log(`  - 복사 중 (${dirName} -> ${targetPath})...`);
    try {
      execSync(`robocopy "${srcPath}" "${targetPath}" /E /NFL /NDL /NJH /NJS /nc /ns /np`, {
        stdio: "ignore",
      });
    } catch (robocopyErr: any) {
      if (robocopyErr.status && robocopyErr.status > 7) {
        throw robocopyErr;
      }
    }
    console.log(`  ✓ ${dirName} 복사 완료!`);
  }
}

async function main() {
  console.log("======================================================");
  console.log("📦 Screen Demo Studio 단독 실행용 포터블 리소스 번들러");
  console.log("======================================================");

  try {
    await bundleFFmpeg();
    await bundlePython();
    await bundleBrowser();

    console.log("\n🎉 모든 핵심 부품(FFmpeg, Python, Chromium)이 resources/bin 에 준비되었습니다!");
    console.log("   - 위치: " + BIN_DIR);
  } catch (err: any) {
    console.error("\n❌ 리소스 번들링 실패:", err.message || err);
    process.exit(1);
  }
}

main();

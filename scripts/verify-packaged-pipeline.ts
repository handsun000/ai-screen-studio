import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";
// @ts-ignore
const { setupBundledEnvironment } = require("./bundled-env.cjs");

const ROOT_DIR = path.resolve(__dirname, "..");
const envResult = setupBundledEnvironment(ROOT_DIR);
const TMP_DIR = path.join(ROOT_DIR, "tmp", "packaged-test");
const MOCK_SLUG_DIR = path.join(TMP_DIR, "mock-test");

if (fs.existsSync(TMP_DIR)) {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
}
fs.mkdirSync(MOCK_SLUG_DIR, { recursive: true });

let passedCount = 0;
let failedCount = 0;

function report(step: string, ok: boolean, detail: string) {
  if (ok) {
    passedCount++;
    console.log(`✅ [PASS] ${step.padEnd(30)} : ${detail}`);
  } else {
    failedCount++;
    console.error(`❌ [FAIL] ${step.padEnd(30)} : ${detail}`);
  }
}

async function runAllTests() {
  console.log("======================================================================");
  console.log("🧪 Screen Demo Studio 무설치 배포 패키지 전 기능 종합 검증");
  console.log("======================================================================");
  console.log(`- 번들 리소스 위치 : ${envResult.activeBinDir}`);
  console.log(`- PATH 최우선순위  : ${process.env.PATH?.split(";")[0]}`);
  console.log(`- 브라우저 저장소  : ${process.env.PLAYWRIGHT_BROWSERS_PATH}\n`);

  // 1. 번들 바이너리 존재 검증
  const ffmpegExe = path.join(envResult.activeBinDir, "ffmpeg", "ffmpeg.exe");
  const ffprobeExe = path.join(envResult.activeBinDir, "ffmpeg", "ffprobe.exe");
  const pythonExe = path.join(envResult.activeBinDir, "python", "python.exe");
  const browserDir = path.join(envResult.activeBinDir, "browser");

  report(
    "1. 포터블 FFmpeg 바이너리",
    fs.existsSync(ffmpegExe) && fs.existsSync(ffprobeExe),
    `ffmpeg.exe (${fs.existsSync(ffmpegExe) ? "존재" : "누락"}) · ffprobe.exe (${fs.existsSync(ffprobeExe) ? "존재" : "누락"})`
  );

  report(
    "2. 포터블 Python 바이너리",
    fs.existsSync(pythonExe),
    `python.exe (${fs.existsSync(pythonExe) ? "존재" : "누락"})`
  );

  // 2. Playwright 전용 녹화 엔진 검증
  const pwFfmpegDir = fs.readdirSync(browserDir).find((d) => d.startsWith("ffmpeg-"));
  const pwFfmpegExe = pwFfmpegDir ? path.join(browserDir, pwFfmpegDir, "ffmpeg-win64.exe") : "";
  report(
    "3. Playwright 비디오 녹화 엔진",
    Boolean(pwFfmpegExe && fs.existsSync(pwFfmpegExe)),
    pwFfmpegExe ? `${pwFfmpegDir}/ffmpeg-win64.exe 정상 탑재` : "녹화용 ffmpeg 바이너리 누락"
  );

  // 3. Playwright 비디오 녹화 (recordVideo) 및 브라우저 실행 테스트
  const { chromium } = require("playwright");
  let recordSuccess = false;
  let recordVideoPath = "";
  try {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      recordVideo: { dir: MOCK_SLUG_DIR },
    });
    const page = await context.newPage();
    await page.setContent("<html><body style='background:#1a1a2e;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;'><h1>Screen Demo Studio Verification</h1></body></html>");
    await page.waitForTimeout(800);
    const video = page.video();
    recordVideoPath = video ? await video.path() : "";
    await context.close();
    await browser.close();
    recordSuccess = Boolean(recordVideoPath && fs.existsSync(recordVideoPath));
  } catch (err: any) {
    report("4. 브라우저 비디오 녹화", false, `Playwright 녹화 에러: ${err.message}`);
  }
  if (recordSuccess) {
    report("4. 브라우저 비디오 녹화", true, `WebM 녹화 완료 (${path.basename(recordVideoPath)}, ${fs.statSync(recordVideoPath).size} bytes)`);
  }

  // 4. FFmpeg WebM -> MP4 트랜스코딩 테스트
  const testMp4Path = path.join(MOCK_SLUG_DIR, "recording.mp4");
  let transcodeSuccess = false;
  if (recordSuccess && fs.existsSync(recordVideoPath)) {
    const ffRes = spawnSync(
      ffmpegExe,
      ["-y", "-i", recordVideoPath, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", testMp4Path],
      { encoding: "utf-8", timeout: 15000 }
    );
    transcodeSuccess = fs.existsSync(testMp4Path) && fs.statSync(testMp4Path).size > 1000;
    report(
      "5. FFmpeg 비디오 인코딩",
      transcodeSuccess,
      transcodeSuccess ? `MP4 인코딩 성공 (${fs.statSync(testMp4Path).size} bytes)` : `인코딩 실패: ${ffRes.stderr?.slice(0, 100)}`
    );
  } else {
    report("5. FFmpeg 비디오 인코딩", false, "녹화 원본 파일 부재로 건너뜀");
  }

  // 5. 모의 moments.json 생성 후 build-edit-plan.py 실행 테스트
  const mockMoments = {
    metadata: {
      fps: 60,
      totalDurationMs: 1500,
      viewport: { width: 1280, height: 720 },
    },
    moments: [
      {
        id: "moment-1",
        type: "click",
        timestampMs: 300,
        videoTimestampMs: 300,
        frame: 18,
        x: 640,
        y: 360,
        stayedInArea: true,
      },
      {
        id: "moment-2",
        type: "click",
        timestampMs: 900,
        videoTimestampMs: 900,
        frame: 54,
        x: 640,
        y: 360,
        stayedInArea: false,
      },
    ],
  };
  fs.writeFileSync(path.join(MOCK_SLUG_DIR, "moments.json"), JSON.stringify(mockMoments, null, 2), "utf-8");

  const buildPlanRes = spawnSync(
    pythonExe,
    ["scripts/build-edit-plan.py", MOCK_SLUG_DIR],
    { cwd: ROOT_DIR, encoding: "utf-8", timeout: 10000 }
  );
  const editPlanPath = path.join(MOCK_SLUG_DIR, "edit-plan.json");
  const editPlanSuccess = fs.existsSync(editPlanPath);
  report(
    "6. 줌/팬 편집 플랜 생성기",
    editPlanSuccess,
    editPlanSuccess ? `edit-plan.json 생성 완료` : `생성 실패: ${buildPlanRes.stderr || buildPlanRes.stdout}`
  );

  // 6. Edge-TTS 음성 합성 테스트
  const testAudioPath = path.join(MOCK_SLUG_DIR, "test-tts.mp3");
  const ttsRes = spawnSync(
    pythonExe,
    ["-m", "edge_tts", "--text", "화면 데모 스튜디오 무설치 배포 패키지 음성 합성 테스트입니다.", "--write-media", testAudioPath, "--voice", "ko-KR-SunHiNeural"],
    { cwd: ROOT_DIR, encoding: "utf-8", timeout: 15000 }
  );
  const ttsSuccess = fs.existsSync(testAudioPath) && fs.statSync(testAudioPath).size > 1000;
  report(
    "7. AI 음성 합성 (Edge-TTS)",
    ttsSuccess,
    ttsSuccess ? `정상 생성 (${fs.statSync(testAudioPath).size} bytes)` : `합성 실패: ${ttsRes.stderr || ttsRes.stdout}`
  );

  // 7. FFmpeg 비디오 컷/트림 테스트 (videoEditorService 핵심 로직)
  const cutMp4Path = path.join(MOCK_SLUG_DIR, "cut-test.mp4");
  const cutRes = spawnSync(
    ffmpegExe,
    ["-y", "-ss", "0.1", "-to", "0.6", "-i", testMp4Path, "-c", "copy", cutMp4Path],
    { encoding: "utf-8", timeout: 10000 }
  );
  const cutSuccess = fs.existsSync(cutMp4Path) && fs.statSync(cutMp4Path).size > 500;
  report(
    "8. FFmpeg 구간 컷 편집 엔진",
    cutSuccess,
    cutSuccess ? `0.5초 구간 무손실 고속 절단 성공 (${fs.statSync(cutMp4Path).size} bytes)` : `컷 편집 실패: ${cutRes.stderr}`
  );

  // 8. Remotion 렌더러 CLI 검증
  const remotionCli = path.join(ROOT_DIR, "node_modules", "@remotion", "cli", "remotion-cli.js");
  const remotionRes = spawnSync(
    process.execPath,
    [remotionCli, "--help"],
    {
      cwd: ROOT_DIR,
      encoding: "utf-8",
      timeout: 10000,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    }
  );
  const remotionOk = remotionRes.status === 0 && (remotionRes.stdout || "").includes("remotion");
  report(
    "9. Remotion 렌더러 CLI 엔진",
    remotionOk,
    remotionOk ? "Remotion CLI 정상 구동 확인" : `실행 오류: ${remotionRes.stderr || "응답 없음"}`
  );

  // 임시 테스트 파일 정리
  try {
    if (fs.existsSync(TMP_DIR)) {
      fs.rmSync(TMP_DIR, { recursive: true, force: true });
    }
  } catch {}

  console.log("\n----------------------------------------------------------------------");
  console.log(`📊 종합 검증 결과: 총 ${passedCount + failedCount}개 항목 중 ✅ 정상 ${passedCount}건 · ❌ 오류 ${failedCount}건`);
  console.log("======================================================================");

  if (failedCount > 0) {
    process.exit(1);
  }
}

runAllTests().catch((err) => {
  console.error("검증 스크립트 치명적 예외:", err);
  process.exit(1);
});

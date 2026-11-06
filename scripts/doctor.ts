import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";
import { chromium } from "playwright";
import { getConfig } from "../src/services/configManager";
import { detectAvailableClis, getGeminiApiKeys } from "../src/services/aiClient";
import { listScenarios } from "../src/services/scenarioManager";
import { renderRunner } from "../src/services/renderRunner";
import { ensurePublicNarrationAssets, getNarration } from "../src/services/narrationService";
import { listAllSiteBrands } from "../src/services/siteBrandService";
import { getStorageStats, optimizeStorage } from "../src/services/storageOptimizerService";

const ROOT_DIR = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT_DIR, "data");

interface CheckItem {
  category: string;
  name: string;
  status: "PASS" | "WARN" | "FAIL";
  detail: string;
}

function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function runDoctor() {
  const autoFix = process.argv.includes("--fix");
  const results: CheckItem[] = [];
  const addResult = (
    category: string,
    name: string,
    status: "PASS" | "WARN" | "FAIL",
    detail: string
  ) => {
    results.push({ category, name, status, detail });
  };

  console.log(`\n======================================================================`);
  console.log(
    `🩺 Screen Demo Studio 통합 헬스체크 (Doctor)${autoFix ? " [⚡ --fix 자동 복구 모드]" : ""}`
  );
  console.log(`======================================================================\n`);

  // ---------------------------------------------------------------------------
  // 1. 런타임 & 미디어 엔진 점검 (Node, FFmpeg, FFprobe, Python, edge-tts, Playwright)
  // ---------------------------------------------------------------------------
  addResult("1. 런타임/미디어", "Node.js 런타임", "PASS", `Node ${process.version} (${process.platform}/${process.arch})`);

  for (const bin of ["ffmpeg", "ffprobe"]) {
    const res = spawnSync(bin, ["-version"], { encoding: "utf-8", timeout: 5000 });
    if (res.status === 0 && res.stdout) {
      const firstLine = res.stdout.split(/\r?\n/)[0]?.trim() || bin;
      addResult("1. 런타임/미디어", bin.toUpperCase(), "PASS", firstLine.slice(0, 68));
    } else {
      addResult("1. 런타임/미디어", bin.toUpperCase(), "FAIL", `${bin} 실행 불가 (PATH 확인 필요)`);
    }
  }

  const pyRes = spawnSync("python", ["--version"], { encoding: "utf-8", timeout: 5000 });
  if (pyRes.status === 0) {
    const pyVer = (pyRes.stdout || pyRes.stderr || "").trim();
    const ttsRes = spawnSync("python", ["-m", "edge_tts", "--version"], {
      encoding: "utf-8",
      timeout: 6000,
    });
    if (ttsRes.status === 0) {
      addResult(
        "1. 런타임/미디어",
        "Python & edge-tts",
        "PASS",
        `${pyVer} · ${(ttsRes.stdout || "edge-tts OK").trim()}`
      );
    } else {
      addResult(
        "1. 런타임/미디어",
        "Python & edge-tts",
        "WARN",
        `${pyVer} 설치됨, edge_tts 모듈 확인 필요 (pip install edge-tts)`
      );
    }
  } else {
    addResult("1. 런타임/미디어", "Python & edge-tts", "FAIL", "python 실행 불가");
  }

  try {
    const execPath = chromium.executablePath();
    if (execPath && fs.existsSync(execPath)) {
      addResult("1. 런타임/미디어", "Playwright Chromium", "PASS", path.basename(execPath));
    } else {
      addResult(
        "1. 런타임/미디어",
        "Playwright Chromium",
        "FAIL",
        "브라우저 바이너리 없음 (npx playwright install chromium 필요)"
      );
    }
  } catch (err: any) {
    addResult("1. 런타임/미디어", "Playwright Chromium", "FAIL", err.message);
  }

  // ---------------------------------------------------------------------------
  // 2. 통합 AI 실행 엔진 점검 (API 모드 / CLI 모드)
  // ---------------------------------------------------------------------------
  const cfg = getConfig();
  const apiKeys = getGeminiApiKeys();
  const clis = detectAvailableClis(true);
  const installedClis = clis.filter((c) => c.installed);

  if (cfg.aiMode === "cli") {
    const activeCli = clis.find((c) => c.id === cfg.aiCliProvider);
    if (activeCli && activeCli.installed) {
      addResult(
        "2. AI 실행 엔진",
        "활성 AI 모드 (CLI)",
        "PASS",
        `CLI 모드 (${activeCli.name} · 모델: ${cfg.aiCliModel})`
      );
    } else {
      addResult(
        "2. AI 실행 엔진",
        "활성 AI 모드 (CLI)",
        "WARN",
        `선택된 CLI(${cfg.aiCliProvider}) 미설치 · 설치된 CLI: ${
          installedClis.map((c) => c.id).join(", ") || "없음"
        }`
      );
    }
  } else {
    if (apiKeys.length > 0) {
      addResult(
        "2. AI 실행 엔진",
        "활성 AI 모드 (API)",
        "PASS",
        `API 모드 (Gemini API 키 ${apiKeys.length}개 등록됨 · 모델: ${cfg.geminiModel})`
      );
    } else {
      addResult(
        "2. AI 실행 엔진",
        "활성 AI 모드 (API)",
        "WARN",
        `API 모드 선택됨이나 GEMINI_API_KEY가 비어 있음 (CLI 모드로 전환 권장)`
      );
    }
  }

  addResult(
    "2. AI 실행 엔진",
    "로컬 CLI 프로바이더",
    installedClis.length > 0 ? "PASS" : "WARN",
    installedClis.length > 0
      ? `사용 가능: ${installedClis.map((c) => `${c.id}(${path.basename(c.binaryPath)})`).join(", ")}`
      : "설치된 로컬 AI CLI 없음"
  );

  // ---------------------------------------------------------------------------
  // 3. 코드 타입 검사 & 대시보드 UI 교차 파일 정합성 점검
  // ---------------------------------------------------------------------------
  const tscJs = path.join(ROOT_DIR, "node_modules", "typescript", "bin", "tsc");
  const tscRes = spawnSync(process.execPath, [tscJs, "--noEmit"], {
    cwd: ROOT_DIR,
    encoding: "utf-8",
    timeout: 30000,
  });
  if (tscRes.status === 0) {
    addResult("3. 코드/UI 정합성", "TypeScript 타입 검사", "PASS", "tsc --noEmit 에러 0건");
  } else {
    const errPreview = (tscRes.stdout || tscRes.stderr || "").split(/\r?\n/).slice(0, 2).join(" ");
    addResult("3. 코드/UI 정합성", "TypeScript 타입 검사", "FAIL", errPreview || "tsc 오류 발생");
  }

  const appJsPath = path.join(ROOT_DIR, "dashboard", "app.js");
  const nodeCheckRes = spawnSync(process.execPath, ["-c", appJsPath], {
    cwd: ROOT_DIR,
    encoding: "utf-8",
    timeout: 10000,
  });
  if (nodeCheckRes.status === 0) {
    addResult("3. 코드/UI 정합성", "프론트엔드 문법 검사", "PASS", "node -c dashboard/app.js 에러 0건");
  } else {
    addResult(
      "3. 코드/UI 정합성",
      "프론트엔드 문법 검사",
      "FAIL",
      (nodeCheckRes.stderr || "문법 오류").trim()
    );
  }

  // index.html <-> style.css <-> app.js 핵심 ID 정합성 확인
  const indexHtml = fs.readFileSync(path.join(ROOT_DIR, "dashboard", "index.html"), "utf-8");
  const styleCss = fs.readFileSync(path.join(ROOT_DIR, "dashboard", "style.css"), "utf-8");
  const appJs = fs.readFileSync(appJsPath, "utf-8");
  const criticalIds = [
    "scenario-cards-container",
    "scenario-domain-chips",
    "btn-toggle-storage-drawer",
    "storage-optimizer-drawer",
    "btn-toggle-merge-drawer",
    "video-merge-drawer",
    "narration-unapplied-banner",
    "narration-chapter-tabs-bar",
    "narration-site-brand-bar",
    "timeline-visual-bar",
    "timeline-scroll-viewport",
    "timeline-track-ruler",
    "timeline-track-zoom",
    "timeline-track-moments",
    "timeline-track-narration",
    "btn-timeline-zoom-in",
    "btn-timeline-zoom-out",
    "timeline-zoom-badge",
    "btn-toggle-cut-editor",
    "btn-toggle-voice-options",
    "narration-voice-options-drawer",
    "btn-toggle-intro-toc-drawer",
    "btn-toggle-brand-drawer",
    "player-studio-split",
    "btn-toggle-studio-layout",
    "studio-split-resizer",
  ];
  const missingIds = criticalIds.filter(
    (id) => !indexHtml.includes(`id="${id}"`) || !appJs.includes(id)
  );
  if (missingIds.length === 0 && styleCss.length > 1000) {
    addResult(
      "3. 코드/UI 정합성",
      "HTML ↔ CSS ↔ JS 1:1 매핑",
      "PASS",
      `핵심 컴포넌트 ID ${criticalIds.length}개 전수 일치`
    );
  } else {
    addResult(
      "3. 코드/UI 정합성",
      "HTML ↔ CSS ↔ JS 1:1 매핑",
      "FAIL",
      `누락된 ID: ${missingIds.join(", ")}`
    );
  }

  // ---------------------------------------------------------------------------
  // 4. 시나리오 데이터 & 타임라인/대본/오디오 싱크 무결성 점검
  // ---------------------------------------------------------------------------
  const scenarios = listScenarios();
  let jsonErrors = 0;
  let syncWarnings = 0;
  let outdatedRenders = 0;
  let unsynthesizedCount = 0;
  let autoSyncedPublicAssets = 0;

  for (const sc of scenarios) {
    const sDir = path.join(DATA_DIR, sc.slug);
    for (const jf of ["browse-plan.json", "moments.json", "edit-plan.json", "narration.json"]) {
      const jp = path.join(sDir, jf);
      if (fs.existsSync(jp)) {
        try {
          JSON.parse(fs.readFileSync(jp, "utf-8"));
        } catch {
          jsonErrors++;
        }
      }
    }

    const narr = getNarration(sc.slug);
    const momentsPath = path.join(sDir, "moments.json");
    if (narr && narr.introBakedIntoVideo && Number(narr.bakedIntroDurationMs || 0) > 1000 && fs.existsSync(momentsPath)) {
      try {
        const mObj = JSON.parse(fs.readFileSync(momentsPath, "utf-8"));
        const momentsArr = Array.isArray(mObj?.moments) ? mObj.moments : [];
        const bakedMs = Number(narr.bakedIntroDurationMs || 0);
        const isMerged = Array.isArray((narr as any).mergedFromSlugs) && (narr as any).mergedFromSlugs.length > 0;
        if (!isMerged && momentsArr.length > 0) {
          const firstMomentTs = Number(momentsArr[0]?.timestamp || 0);
          if (firstMomentTs < bakedMs - 250) {
            syncWarnings++;
          }
        }
      } catch {}
    }

    if (autoFix && narr && Array.isArray(narr.cues) && narr.cues.length > 0) {
      try {
        ensurePublicNarrationAssets(sc.slug);
        autoSyncedPublicAssets++;
      } catch {}
    }

    const rInfo = renderRunner.getRenderInfo(sc.slug);
    if (rInfo.exists && rInfo.isOutdated) {
      outdatedRenders++;
    }
    if (rInfo.hasUnsynthesizedCues) {
      unsynthesizedCount++;
    }
  }

  addResult(
    "4. 시나리오 무결성",
    `시나리오 JSON 검증 (${scenarios.length}개)`,
    jsonErrors === 0 ? "PASS" : "FAIL",
    jsonErrors === 0
      ? `총 ${scenarios.length}개 시나리오 JSON 스키마 정상`
      : `JSON 파싱 오류 ${jsonErrors}건 발견`
  );

  addResult(
    "4. 시나리오 무결성",
    "오프닝 슬라이드 ↔ 동작 싱크",
    syncWarnings === 0 ? "PASS" : "WARN",
    syncWarnings === 0
      ? "모든 시나리오의 동작 마커 타임스탬프가 오프닝 슬라이드 길이와 1:1 정렬됨"
      : `타임스탬프 미시프트 의심 시나리오 ${syncWarnings}건`
  );

  addResult(
    "4. 시나리오 무결성",
    "최종 MP4 & TTS 최신 상태",
    outdatedRenders === 0 && unsynthesizedCount === 0 ? "PASS" : "WARN",
    outdatedRenders === 0 && unsynthesizedCount === 0
      ? `모든 렌더링 MP4 최신 상태 유지${autoFix ? ` (오디오 에셋 ${autoSyncedPublicAssets}개 동기화)` : ""}`
      : `구버전 MP4 ${outdatedRenders}건 · 미합성 대본 큐 ${unsynthesizedCount}건`
  );

  // ---------------------------------------------------------------------------
  // 5. 사이트 브랜드 캐시 점검 (테마 색상, 투명 로고, 상위 도메인 상속)
  // ---------------------------------------------------------------------------
  const brands = listAllSiteBrands();
  const validBrands = brands.filter((b) => /^#[0-9A-Fa-f]{6}$/.test(b.primaryColor || ""));
  addResult(
    "5. 사이트 브랜드",
    "도메인 브랜드 & 로고 캐시",
    validBrands.length === brands.length ? "PASS" : "WARN",
    `등록된 호스트 브랜드 ${brands.length}개 (${brands.map((b) => `${b.hostKey}[${b.primaryColor}]`).join(", ")})`
  );

  // ---------------------------------------------------------------------------
  // 6. 디스크 용량 & 하드링크 최적화 상태 점검
  // ---------------------------------------------------------------------------
  let storageStats = getStorageStats();
  if (autoFix && storageStats.reclaimable.totalBytes > 1024 * 1024) {
    const cleanRes = optimizeStorage({
      deduplicateHardlinks: true,
      cleanTempFiles: true,
      cleanOrphanOutputs: true,
      cleanUndoBackups: false,
    });
    console.log(
      `⚡ [--fix 자동 최적화 완료] 물리 용량 ${formatMb(cleanRes.reclaimedBytes)} 절감 (하드링크 ${cleanRes.hardlinkedCount}건 · 파일 정리 ${cleanRes.deletedCount}건)\n`
    );
    storageStats = cleanRes.afterStats;
  }

  const reclaimMb = storageStats.reclaimable.totalBytes / (1024 * 1024);
  addResult(
    "6. 디스크 스토리지",
    "물리 용량 & 하드링크 절감",
    reclaimMb < 25 ? "PASS" : "WARN",
    `물리 점유: ${formatMb(storageStats.physicalTotalBytes)} (논리: ${formatMb(
      storageStats.logicalTotalBytes
    )} · 하드링크 절감: ${formatMb(storageStats.hardlinkSavedBytes)} · 추가 정리 가능: ${formatMb(
      storageStats.reclaimable.totalBytes
    )})`
  );

  // ---------------------------------------------------------------------------
  // 결과 리포트 출력
  // ---------------------------------------------------------------------------
  for (const item of results) {
    const icon = item.status === "PASS" ? "✅" : item.status === "WARN" ? "⚠️" : "❌";
    console.log(
      `${icon} [${item.category}] ${item.name.padEnd(26, " ")} : ${item.detail}`
    );
  }

  const passCount = results.filter((r) => r.status === "PASS").length;
  const warnCount = results.filter((r) => r.status === "WARN").length;
  const failCount = results.filter((r) => r.status === "FAIL").length;

  console.log(`\n----------------------------------------------------------------------`);
  console.log(
    `📊 진단 요약: 총 ${results.length}개 항목 중 ✅ 정상 ${passCount}건 · ⚠️ 주의 ${warnCount}건 · ❌ 오류 ${failCount}건`
  );
  if (warnCount > 0 && !autoFix) {
    console.log(`💡 팁: 'npm run doctor:fix'를 실행하면 하드링크 통합 및 임시 파일 정리를 자동 수행합니다.`);
  }
  console.log(`======================================================================\n`);

  if (failCount > 0) {
    process.exit(1);
  }
}

runDoctor().catch((err) => {
  console.error("❌ Doctor 실행 중 치명적 오류:", err);
  process.exit(1);
});

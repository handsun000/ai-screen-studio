import * as fs from "fs";
import * as path from "path";
import { bundle } from "@remotion/bundler";
import { renderStill, selectComposition } from "@remotion/renderer";
import type { MomentsFile, EditPlan } from "../src/types";

async function main() {
  const slug = process.argv[2] || "approval-draft";
  const dataDir = path.resolve(__dirname, "..", "data", slug);
  const momentsPath = path.join(dataDir, "moments.json");
  const editPlanPath = path.join(dataDir, "edit-plan.json");

  if (!fs.existsSync(momentsPath)) {
    console.error(`moments.json not found at ${momentsPath}`);
    process.exit(1);
  }

  const momentsData: MomentsFile = JSON.parse(fs.readFileSync(momentsPath, "utf-8"));
  const editPlan: EditPlan = JSON.parse(fs.readFileSync(editPlanPath, "utf-8"));

  const clickMoments = momentsData.moments.filter((m) => m.type === "click" && m.cursor);
  console.log(`\n======================================================`);
  console.log(`🔍 [Verify Sync] 검증 대상: "${slug}" (총 ${clickMoments.length}개 클릭 액션)`);
  console.log(`======================================================\n`);

  const outDir = path.resolve(__dirname, "..", "scratch", `verify_${slug}`);
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  console.log("Remotion 프로젝트 번들링 중...");
  const entry = path.resolve(__dirname, "..", "src", "index.ts");
  const bundleLocation = await bundle({ entryPoint: entry });

  const composition = await selectComposition({
    serveUrl: bundleLocation,
    id: "ScreenDemo",
  });

  const fps = editPlan.fps || 60;
  // Sample up to 6 key clicks across the video (first, middle, last, etc.)
  const sampleIndices = [
    0,
    Math.floor(clickMoments.length * 0.2),
    Math.floor(clickMoments.length * 0.4),
    Math.floor(clickMoments.length * 0.6),
    Math.floor(clickMoments.length * 0.8),
    clickMoments.length - 1,
  ];
  const uniqueIndices = Array.from(new Set(sampleIndices)).filter((i) => i >= 0 && i < clickMoments.length);

  for (const idx of uniqueIndices) {
    const m = clickMoments[idx];
    const clickFrame = Math.round((m.timestamp / 1000) * fps);

    console.log(`\n[검증 #${m.id}] ${m.description}`);
    console.log(`  - 타임스탬프: ${m.timestamp}ms (프레임: ${clickFrame})`);
    console.log(`  - 커서 좌표: (${m.cursor?.x}, ${m.cursor?.y})`);

    // Render frame at click
    const clickImg = path.join(outDir, `moment_${m.id}_frame_${clickFrame}.png`);
    await renderStill({
      composition,
      serveUrl: bundleLocation,
      frame: clickFrame,
      output: clickImg,
    });
    console.log(`  - 캡처 완료: ${clickImg}`);
  }

  console.log(`\n======================================================`);
  console.log(`✅ 검증 프레임 캡처 완료! (${outDir})`);
  console.log(`======================================================\n`);
}

main().catch(console.error);

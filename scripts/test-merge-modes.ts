import fs from "fs";
import path from "path";
import { mergeRenderedVideos } from "../src/services/videoEditorService";

const ROOT_DIR = path.resolve(__dirname, "..");

async function runMergeTests() {
  console.log("======================================================================");
  console.log("🧪 1. [단일 영상 병합 (Single Mode)] 테스트 시작: login + document");
  console.log("======================================================================");

  const testSingleSlug = "test-merged-single";
  const singleResult = await mergeRenderedVideos({
    slugs: ["login", "document"],
    outputSlug: testSingleSlug,
    mergeMode: "single",
  });

  console.log("결과:", singleResult);
  if (!singleResult.success) {
    throw new Error("단일 영상 병합 실패!");
  }

  const outSingleMp4 = path.join(ROOT_DIR, "output", `${testSingleSlug}.mp4`);
  if (!fs.existsSync(outSingleMp4)) {
    throw new Error(`출력 파일이 없습니다: ${outSingleMp4}`);
  }

  console.log(`✅ 생성된 단일 영상 길이: ${singleResult.totalDurationSec.toFixed(2)}초`);

  const singleNarrPath = path.join(ROOT_DIR, "data", testSingleSlug, "narration.json");
  const singleNarr = JSON.parse(fs.readFileSync(singleNarrPath, "utf-8"));
  console.log(`✅ narration.json mergeMode: ${singleNarr.mergeMode}`);
  console.log(`✅ introBakedIntoVideo: ${singleNarr.introBakedIntoVideo}`);
  console.log(`✅ bakedIntroDurationMs: ${singleNarr.bakedIntroDurationMs}ms`);

  const introCues = singleNarr.cues.filter((c: any) => c.isIntro);
  const bodyCues = singleNarr.cues.filter((c: any) => !c.isIntro);
  console.log(`✅ 오프닝 슬라이드 큐 개수: ${introCues.length}개 (정확히 1개여야 함)`);
  console.log(`✅ 본문 대본 큐 개수: ${bodyCues.length}개`);

  if (introCues.length !== 1) {
    throw new Error(`오프닝 슬라이드 큐가 1개가 아닙니다: ${introCues.length}`);
  }

  console.log("\n======================================================================");
  console.log("🧪 2. [챕터별 종합 매뉴얼 (Chapters Mode)] 테스트: login + document");
  console.log("======================================================================");

  const testChaptersSlug = "test-merged-chapters";
  const chaptersResult = await mergeRenderedVideos({
    slugs: ["login", "document"],
    outputSlug: testChaptersSlug,
    mergeMode: "chapters",
  });

  console.log("결과:", chaptersResult);
  if (!chaptersResult.success) {
    throw new Error("챕터별 종합 매뉴얼 병합 실패!");
  }

  const outChaptersMp4 = path.join(ROOT_DIR, "output", `${testChaptersSlug}.mp4`);
  if (!fs.existsSync(outChaptersMp4)) {
    throw new Error(`출력 파일이 없습니다: ${outChaptersMp4}`);
  }

  console.log(`✅ 생성된 챕터 종합 영상 길이: ${chaptersResult.totalDurationSec.toFixed(2)}초`);

  const chaptersNarrPath = path.join(ROOT_DIR, "data", testChaptersSlug, "narration.json");
  const chaptersNarr = JSON.parse(fs.readFileSync(chaptersNarrPath, "utf-8"));
  const chaptersIntroCues = chaptersNarr.cues.filter((c: any) => c.isIntro);
  console.log(`✅ 챕터 모드 오프닝 슬라이드 큐 개수: ${chaptersIntroCues.length}개 (표지+대목차 2개)`);

  console.log("\n======================================================================");
  console.log("🧹 3. 테스트 임시 데이터 정리");
  console.log("======================================================================");

  for (const s of [testSingleSlug, testChaptersSlug]) {
    const d = path.join(ROOT_DIR, "data", s);
    const o = path.join(ROOT_DIR, "output", `${s}.mp4`);
    const p = path.join(ROOT_DIR, "public", "narration", s);
    if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
    if (fs.existsSync(o)) fs.rmSync(o, { force: true });
    if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
  }

  console.log("🎉 모든 병합 모드(단일 영상 완성 & 챕터 종합 매뉴얼) 검증 완료! (0 오류)");
}

runMergeTests().catch((err) => {
  console.error("❌ 검증 실패:", err);
  process.exit(1);
});

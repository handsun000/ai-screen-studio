import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";
import { getNarration, saveNarrationFile } from "./narrationService";

const ROOT_DIR = path.resolve(__dirname, "..", "..");
const DATA_DIR = path.join(ROOT_DIR, "data");
const PUBLIC_DIR = path.join(ROOT_DIR, "public");

export interface VideoEditStatus {
  hasOriginalBackup: boolean;
  hasUndoBackup: boolean;
  durationSec: number;
  originalDurationSec?: number;
}

export interface VideoCutResult {
  success: boolean;
  oldDurationSec: number;
  newDurationSec: number;
  cutDurationSec: number;
  editStatus: VideoEditStatus;
  moments?: any;
  editPlan?: any;
  narration?: any;
}

export interface VideoMergeResult {
  success: boolean;
  outputSlug: string;
  mergedSlugs: string[];
  totalDurationSec: number;
  fileSizeBytes: number;
  videoUrl: string;
  downloadUrl: string;
  usedFastCopy: boolean;
}

function probeVideoDurationSec(mp4Path: string): number {
  if (!fs.existsSync(mp4Path)) return 0;
  try {
    const res = spawnSync(
      "ffprobe",
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        mp4Path,
      ],
      { encoding: "utf-8" }
    );
    if (res.status === 0 && res.stdout) {
      const val = parseFloat(res.stdout.trim());
      if (Number.isFinite(val) && val > 0) {
        return Number(val.toFixed(3));
      }
    }
  } catch {}
  return 0;
}

export function getVideoEditStatus(slug: string): VideoEditStatus {
  const sDir = path.join(DATA_DIR, slug);
  const mp4Path = path.join(sDir, "recording.mp4");
  const origMp4Path = path.join(sDir, "recording.orig.mp4");
  const undoMp4Path = path.join(sDir, "recording.undo.mp4");

  const hasOriginalBackup = fs.existsSync(origMp4Path);
  const hasUndoBackup = fs.existsSync(undoMp4Path);
  const durationSec = probeVideoDurationSec(mp4Path);
  const originalDurationSec = hasOriginalBackup ? probeVideoDurationSec(origMp4Path) : undefined;

  return {
    hasOriginalBackup,
    hasUndoBackup,
    durationSec,
    originalDurationSec,
  };
}

function backupFilesBeforeEdit(sDir: string) {
  const files = ["recording.mp4", "moments.json", "edit-plan.json", "narration.json"];

  // 1) Save untouched original backup (.orig) on very first edit
  const origMp4 = path.join(sDir, "recording.orig.mp4");
  if (!fs.existsSync(origMp4) && fs.existsSync(path.join(sDir, "recording.mp4"))) {
    for (const f of files) {
      const src = path.join(sDir, f);
      const ext = path.extname(f);
      const base = path.basename(f, ext);
      const dst = path.join(sDir, `${base}.orig${ext}`);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, dst);
      }
    }
  }

  // 2) Save single-step undo backup (.undo) before every edit
  for (const f of files) {
    const src = path.join(sDir, f);
    const ext = path.extname(f);
    const base = path.basename(f, ext);
    const dst = path.join(sDir, `${base}.undo${ext}`);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dst);
    } else if (fs.existsSync(dst)) {
      try {
        fs.unlinkSync(dst);
      } catch {}
    }
  }
}

function syncPublicRecordingCopy(slug: string, mp4Path: string) {
  const pubMp4 = path.join(PUBLIC_DIR, `${slug}-recording.mp4`);
  if (fs.existsSync(PUBLIC_DIR) && fs.existsSync(mp4Path)) {
    try {
      fs.copyFileSync(mp4Path, pubMp4);
    } catch {}
  }
}

export function cutVideoSegment(slug: string, rawStartSec: number, rawEndSec: number): VideoCutResult {
  const sDir = path.join(DATA_DIR, slug);
  const mp4Path = path.join(sDir, "recording.mp4");
  if (!fs.existsSync(mp4Path)) {
    throw new Error(`'${slug}' 시나리오의 원본 녹화 파일(recording.mp4)이 존재하지 않습니다.`);
  }

  const totalDurSec = probeVideoDurationSec(mp4Path);
  if (totalDurSec <= 0.5) {
    throw new Error("비디오 길이를 확인할 수 없거나 영상이 너무 짧습니다.");
  }

  const startSec = Math.max(0, Number(Number(rawStartSec || 0).toFixed(3)));
  const endSec = Math.min(totalDurSec, Number(Number(rawEndSec || 0).toFixed(3)));
  const cutDurSec = Number((endSec - startSec).toFixed(3));

  if (cutDurSec < 0.2) {
    throw new Error("잘라낼 구간은 최소 0.2초 이상이어야 합니다.");
  }
  if (totalDurSec - cutDurSec < 1.0) {
    throw new Error("영상을 모두 잘라낼 수 없습니다. 최소 1초 이상의 영상이 남아야 합니다.");
  }

  // Backup current & original state before modifying
  backupFilesBeforeEdit(sDir);

  const tmpOut = path.join(sDir, "recording_cut_tmp.mp4");
  const keepHead = startSec > 0.08;
  const keepTail = endSec < totalDurSec - 0.08;

  let ffmpegArgs: string[] = [];
  if (!keepHead && keepTail) {
    // Cut from beginning: keep [endSec, totalDurSec]
    ffmpegArgs = [
      "-y",
      "-v",
      "error",
      "-ss",
      endSec.toFixed(3),
      "-i",
      mp4Path,
      "-vf",
      "fps=30",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "18",
      "-pix_fmt",
      "yuv420p",
      "-g",
      "30",
      "-an",
      "-movflags",
      "+faststart",
      tmpOut,
    ];
  } else if (keepHead && !keepTail) {
    // Cut until end: keep [0, startSec]
    ffmpegArgs = [
      "-y",
      "-v",
      "error",
      "-i",
      mp4Path,
      "-t",
      startSec.toFixed(3),
      "-vf",
      "fps=30",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "18",
      "-pix_fmt",
      "yuv420p",
      "-g",
      "30",
      "-an",
      "-movflags",
      "+faststart",
      tmpOut,
    ];
  } else {
    // Cut middle: keep [0, startSec] + [endSec, totalDurSec]
    const filterComplex = `[0:v]trim=start=0:end=${startSec.toFixed(3)},setpts=PTS-STARTPTS[v0];[0:v]trim=start=${endSec.toFixed(
      3
    )},setpts=PTS-STARTPTS[v1];[v0][v1]concat=n=2:v=1:a=0,fps=30[outv]`;
    ffmpegArgs = [
      "-y",
      "-v",
      "error",
      "-i",
      mp4Path,
      "-filter_complex",
      filterComplex,
      "-map",
      "[outv]",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "18",
      "-pix_fmt",
      "yuv420p",
      "-g",
      "30",
      "-movflags",
      "+faststart",
      tmpOut,
    ];
  }

  const ffRes = spawnSync("ffmpeg", ffmpegArgs, { encoding: "utf-8" });
  if (ffRes.status !== 0 || !fs.existsSync(tmpOut)) {
    throw new Error(`FFmpeg 컷 편집 실패: ${ffRes.stderr || "알 수 없는 오류"}`);
  }

  fs.renameSync(tmpOut, mp4Path);
  syncPublicRecordingCopy(slug, mp4Path);

  const newDurSec = probeVideoDurationSec(mp4Path) || Math.max(1, Number((totalDurSec - cutDurSec).toFixed(3)));
  const newDurMs = Math.round(newDurSec * 1000);
  const startMs = Math.round(startSec * 1000);
  const endMs = Math.round(endSec * 1000);
  const cutDurMs = Math.max(0, endMs - startMs);

  // 1) Ripple-update moments.json
  const momentsPath = path.join(sDir, "moments.json");
  let momentsData: any = null;
  if (fs.existsSync(momentsPath)) {
    try {
      momentsData = JSON.parse(fs.readFileSync(momentsPath, "utf-8"));
      if (Array.isArray(momentsData.moments)) {
        const updatedMoments: any[] = [];
        for (const m of momentsData.moments) {
          const ts = Number(m.timestamp || 0);
          if (ts <= startMs) {
            updatedMoments.push({ ...m });
          } else if (ts >= endMs) {
            updatedMoments.push({
              ...m,
              timestamp: Math.max(startMs, Math.min(newDurMs, ts - cutDurMs)),
            });
          }
          // Moments strictly inside (startMs, endMs) were inside the cut clip and are removed
        }
        momentsData.moments = updatedMoments.map((m, idx) => ({
          ...m,
          id: idx + 1,
        }));
      }
      momentsData.metadata = {
        ...(momentsData.metadata || {}),
        totalDurationMs: newDurMs,
        calibratedToVideoDurationMs: newDurMs,
      };
      fs.writeFileSync(momentsPath, JSON.stringify(momentsData, null, 2), "utf-8");
    } catch (e) {
      console.warn("[VideoCut] moments.json 업데이트 경고:", e);
    }
  }

  // 2) Temporarily clear narration.json's stale timeRegions before rebuilding edit-plan.json,
  // then ripple-shift narration cues and re-save so timeRegions are recalculated for the new video length!
  const existingNarration = getNarration(slug);
  const editPlanPath = path.join(sDir, "edit-plan.json");

  // Run build-edit-plan.py to regenerate zoom segments & rawDurationFrames
  spawnSync("python", [path.join(ROOT_DIR, "scripts", "build-edit-plan.py"), slug, "--keep-last"], {
    cwd: ROOT_DIR,
    stdio: "ignore",
  });

  // Update edit-plan.json rawDurationFrames to exact new video duration
  let editPlan: any = null;
  if (fs.existsSync(editPlanPath)) {
    try {
      editPlan = JSON.parse(fs.readFileSync(editPlanPath, "utf-8"));
      const fps = Number(editPlan.fps || 60);
      const exactRawFrames = Math.max(60, Math.round(newDurSec * fps));
      editPlan.rawDurationFrames = exactRawFrames;
      editPlan.totalDurationFrames = exactRawFrames;
      delete editPlan.timeRegions;
      fs.writeFileSync(editPlanPath, JSON.stringify(editPlan, null, 2), "utf-8");
    } catch {}
  }

  // 3) Ripple-update narration.json if present
  let updatedNarration: any = null;
  if (existingNarration && Array.isArray(existingNarration.cues) && existingNarration.cues.length > 0) {
    const origCues = existingNarration.cues;
    const filteredCues = origCues.filter((c, idx) => {
      if (origCues.length <= 1) return true;
      const vStart = Number(c.videoStartMs ?? c.startMs ?? 0);
      const nextStart =
        idx < origCues.length - 1
          ? Number(origCues[idx + 1].videoStartMs ?? origCues[idx + 1].startMs ?? vStart + 2500)
          : totalDurSec * 1000;
      const vEnd = Number(c.videoEndMs ?? Math.max(vStart + 500, nextStart));
      const span = Math.max(200, vEnd - vStart);
      const overlapStart = Math.max(startMs, vStart);
      const overlapEnd = Math.min(endMs, vEnd);
      const overlap = Math.max(0, overlapEnd - overlapStart);
      // If >= 85% of this non-intro cue's video segment was deleted by the cut, remove the deleted step's cue
      if (!c.isIntro && vStart >= startMs - 250 && vEnd <= endMs + 250 && overlap / span >= 0.85) {
        return false;
      }
      return true;
    });

    const shiftedCues = filteredCues.map((c, idx) => {
      const vStart = Number(c.videoStartMs ?? c.startMs ?? 0);
      let newVStart = vStart;
      if (vStart >= endMs) {
        newVStart = Math.max(0, vStart - cutDurMs);
      } else if (vStart > startMs) {
        newVStart = startMs;
      }
      newVStart = Math.min(Math.max(0, newDurMs - 300), newVStart);
      return {
        ...c,
        id: idx + 1,
        videoStartMs: newVStart,
        startMs: newVStart,
      };
    });
    updatedNarration = saveNarrationFile(slug, {
      ...existingNarration,
      cues: shiftedCues,
    });
  }

  if (fs.existsSync(editPlanPath)) {
    try {
      editPlan = JSON.parse(fs.readFileSync(editPlanPath, "utf-8"));
    } catch {}
  }

  return {
    success: true,
    oldDurationSec: totalDurSec,
    newDurationSec: newDurSec,
    cutDurationSec: cutDurSec,
    editStatus: getVideoEditStatus(slug),
    moments: momentsData,
    editPlan,
    narration: updatedNarration,
  };
}

export function restoreVideoBackup(slug: string, mode: "undo" | "orig"): VideoCutResult {
  const sDir = path.join(DATA_DIR, slug);
  const suffix = mode === "orig" ? ".orig" : ".undo";
  const srcMp4 = path.join(sDir, `recording${suffix}.mp4`);

  if (!fs.existsSync(srcMp4)) {
    throw new Error(
      mode === "orig"
        ? "복원할 최초 원본 백업 파일이 없습니다."
        : "되돌릴 직전 편집 백업 파일이 없습니다."
    );
  }

  const mp4Path = path.join(sDir, "recording.mp4");
  const oldDurSec = probeVideoDurationSec(mp4Path);

  const files = ["recording.mp4", "moments.json", "edit-plan.json", "narration.json"];
  for (const f of files) {
    const ext = path.extname(f);
    const base = path.basename(f, ext);
    const backupFile = path.join(sDir, `${base}${suffix}${ext}`);
    const targetFile = path.join(sDir, f);
    if (fs.existsSync(backupFile)) {
      fs.copyFileSync(backupFile, targetFile);
      if (mode === "undo") {
        try {
          fs.unlinkSync(backupFile);
        } catch {}
      }
    }
  }

  // If restored to original, clean up both .orig and .undo backups so state is clean
  if (mode === "orig") {
    for (const sfx of [".orig", ".undo"]) {
      for (const f of files) {
        const ext = path.extname(f);
        const base = path.basename(f, ext);
        const bf = path.join(sDir, `${base}${sfx}${ext}`);
        if (fs.existsSync(bf)) {
          try {
            fs.unlinkSync(bf);
          } catch {}
        }
      }
    }
  }

  syncPublicRecordingCopy(slug, mp4Path);
  const newDurSec = probeVideoDurationSec(mp4Path);

  const readJsonSafe = (p: string) => {
    if (!fs.existsSync(p)) return undefined;
    try {
      return JSON.parse(fs.readFileSync(p, "utf-8"));
    } catch {
      return undefined;
    }
  };

  return {
    success: true,
    oldDurationSec: oldDurSec,
    newDurationSec: newDurSec,
    cutDurationSec: Number((oldDurSec - newDurSec).toFixed(3)),
    editStatus: getVideoEditStatus(slug),
    moments: readJsonSafe(path.join(sDir, "moments.json")),
    editPlan: readJsonSafe(path.join(sDir, "edit-plan.json")),
    narration: readJsonSafe(path.join(sDir, "narration.json")),
  };
}

interface ProbedStreamMeta {
  durationSec: number;
  width: number;
  height: number;
  videoCodec: string;
  hasAudio: boolean;
}

function probeClipMeta(mp4Path: string): ProbedStreamMeta {
  const durationSec = probeVideoDurationSec(mp4Path);
  let width = 1920;
  let height = 1080;
  let videoCodec = "h264";
  let hasAudio = false;

  try {
    const res = spawnSync(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "stream=codec_name,codec_type,width,height",
        "-of",
        "json",
        mp4Path,
      ],
      { encoding: "utf-8" }
    );
    if (res.status === 0 && res.stdout) {
      const parsed = JSON.parse(res.stdout);
      const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
      for (const s of streams) {
        if (s.codec_type === "video") {
          width = Number(s.width || 1920);
          height = Number(s.height || 1080);
          videoCodec = String(s.codec_name || "h264");
        } else if (s.codec_type === "audio") {
          hasAudio = true;
        }
      }
    }
  } catch {}

  return { durationSec, width, height, videoCodec, hasAudio };
}

function mapRawFrameToCompFrame(rawFrame: number, editPlan: any): number {
  const regions = editPlan?.timeRegions;
  if (!Array.isArray(regions) || regions.length === 0) {
    return rawFrame;
  }
  for (const r of regions) {
    const vStart = Number(r.videoStartFrame || 0);
    const vEnd = Number(r.videoEndFrame || 0);
    const cStart = Number(r.compStartFrame || 0);
    const cEnd = Number(r.compEndFrame || 0);
    if (rawFrame >= vStart && rawFrame <= vEnd) {
      const vSpan = vEnd - vStart;
      if (vSpan <= 0) return cStart;
      const ratio = (rawFrame - vStart) / vSpan;
      return Math.round(cStart + ratio * (cEnd - cStart));
    }
  }
  const last = regions[regions.length - 1];
  if (rawFrame > Number(last.videoEndFrame || 0)) {
    return Number(last.compEndFrame || 0) + (rawFrame - Number(last.videoEndFrame || 0));
  }
  return rawFrame;
}

export function mergeRenderedVideos(options: {
  slugs: string[];
  outputSlug?: string;
}): VideoMergeResult {
  const rawSlugs = Array.isArray(options?.slugs)
    ? options.slugs.map((s) => String(s || "").trim()).filter(Boolean)
    : [];

  if (rawSlugs.length < 2) {
    throw new Error("합칠 시나리오 영상을 최소 2개 이상 선택해주세요.");
  }

  const outputDir = path.join(ROOT_DIR, "output");
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Validate all source rendered MP4 files exist
  const sourceFiles: { slug: string; mp4Path: string; meta: ProbedStreamMeta }[] = [];
  for (const slug of rawSlugs) {
    const mp4Path = path.join(outputDir, `${slug}.mp4`);
    if (!fs.existsSync(mp4Path)) {
      throw new Error(
        `'${slug}' 시나리오의 최종 렌더링 영상(output/${slug}.mp4)이 없습니다. 먼저 해당 시나리오의 [🎞️ 최종 MP4 렌더링]을 완료해주세요.`
      );
    }
    const meta = probeClipMeta(mp4Path);
    if (meta.durationSec <= 0.1) {
      throw new Error(`'${slug}' 렌더링 영상(output/${slug}.mp4)의 길이를 읽을 수 없습니다.`);
    }
    sourceFiles.push({ slug, mp4Path, meta });
  }

  // Sanitize or generate target outputSlug
  let targetSlug = (options.outputSlug || "")
    .trim()
    .replace(/\.mp4$/i, "")
    .replace(/[^a-zA-Z0-9가-힣_-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (!targetSlug) {
    const suffix = String(Date.now()).slice(-6);
    targetSlug = `merged-demo-${suffix}`;
  }

  if (rawSlugs.includes(targetSlug)) {
    targetSlug = `${targetSlug}-merged`;
  }

  const outMp4Path = path.join(outputDir, `${targetSlug}.mp4`);
  const tmpOutPath = path.join(outputDir, `${targetSlug}_concat_tmp.mp4`);
  const concatListPath = path.join(outputDir, `${targetSlug}_concat_list.txt`);

  // Check if all clips share identical video & audio specs for 0.5s lossless stream copy (-c copy)
  const firstMeta = sourceFiles[0].meta;
  const canTryFastCopy = sourceFiles.every(
    (item) =>
      item.meta.hasAudio === firstMeta.hasAudio &&
      item.meta.videoCodec === firstMeta.videoCodec &&
      item.meta.width === firstMeta.width &&
      item.meta.height === firstMeta.height
  );

  let usedFastCopy = false;

  if (canTryFastCopy) {
    try {
      const listContent = sourceFiles
        .map((item) => {
          const normalized = item.mp4Path.replace(/\\/g, "/").replace(/'/g, "'\\''");
          return `file '${normalized}'`;
        })
        .join("\n");
      fs.writeFileSync(concatListPath, listContent, "utf-8");

      const copyRes = spawnSync(
        "ffmpeg",
        [
          "-y",
          "-v",
          "error",
          "-f",
          "concat",
          "-safe",
          "0",
          "-i",
          concatListPath,
          "-c",
          "copy",
          "-movflags",
          "+faststart",
          tmpOutPath,
        ],
        { encoding: "utf-8" }
      );

      if (copyRes.status === 0 && fs.existsSync(tmpOutPath) && probeVideoDurationSec(tmpOutPath) > 0.5) {
        usedFastCopy = true;
      }
    } catch {} finally {
      if (fs.existsSync(concatListPath)) {
        try {
          fs.unlinkSync(concatListPath);
        } catch {}
      }
    }
  }

  // Fallback: Normalized filter_complex concat if stream specs differ or fast copy failed
  if (!usedFastCopy) {
    const inputArgs: string[] = ["-y", "-v", "error"];
    for (const item of sourceFiles) {
      inputArgs.push("-i", item.mp4Path);
    }

    const filterParts: string[] = [];
    const concatInputs: string[] = [];

    sourceFiles.forEach((item, idx) => {
      filterParts.push(
        `[${idx}:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,fps=60,format=yuv420p,setpts=PTS-STARTPTS[v${idx}]`
      );
      if (item.meta.hasAudio) {
        filterParts.push(
          `[${idx}:a]aformat=sample_rates=48000:channel_layouts=stereo,asetpts=PTS-STARTPTS[a${idx}]`
        );
      } else {
        const dur = Math.max(0.2, item.meta.durationSec).toFixed(3);
        filterParts.push(
          `anullsrc=channel_layout=stereo:sample_rate=48000,atrim=0:${dur},asetpts=PTS-STARTPTS[a${idx}]`
        );
      }
      concatInputs.push(`[v${idx}][a${idx}]`);
    });

    filterParts.push(`${concatInputs.join("")}concat=n=${sourceFiles.length}:v=1:a=1[outv][outa]`);

    const reencodeArgs = [
      ...inputArgs,
      "-filter_complex",
      filterParts.join(";"),
      "-map",
      "[outv]",
      "-map",
      "[outa]",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "18",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-movflags",
      "+faststart",
      tmpOutPath,
    ];

    const ffRes = spawnSync("ffmpeg", reencodeArgs, { encoding: "utf-8" });
    if (ffRes.status !== 0 || !fs.existsSync(tmpOutPath)) {
      throw new Error(`FFmpeg 영상 병합 실패: ${ffRes.stderr || "알 수 없는 오류"}`);
    }
  }

  if (fs.existsSync(outMp4Path)) {
    try {
      fs.unlinkSync(outMp4Path);
    } catch {}
  }
  fs.renameSync(tmpOutPath, outMp4Path);

  // Create combined scenario folder in data/<targetSlug>/ so it appears in the Scenario Library with full timeline & download support
  const mergedDataDir = path.join(DATA_DIR, targetSlug);
  if (!fs.existsSync(mergedDataDir)) {
    fs.mkdirSync(mergedDataDir, { recursive: true });
  }
  const mergedAudioDir = path.join(mergedDataDir, "audio");
  const publicNarrationDir = path.join(PUBLIC_DIR, "narration", targetSlug);
  if (!fs.existsSync(mergedAudioDir)) fs.mkdirSync(mergedAudioDir, { recursive: true });
  if (!fs.existsSync(publicNarrationDir)) fs.mkdirSync(publicNarrationDir, { recursive: true });

  // Copy merged MP4 to data/<targetSlug>/recording.mp4 as well so raw/rendered player modes both work
  const mergedRecordingPath = path.join(mergedDataDir, "recording.mp4");
  try {
    fs.copyFileSync(outMp4Path, mergedRecordingPath);
    syncPublicRecordingCopy(targetSlug, mergedRecordingPath);
  } catch {}

  const fps = 60;
  let cumulativeMs = 0;
  let cumulativeFrames = 0;

  const combinedActions: any[] = [];
  const combinedMoments: any[] = [];
  const combinedSegments: any[] = [];
  const combinedCues: any[] = [];
  let firstBaseUrl = "";
  let voice = "ko-KR-SunHiNeural";
  let rate = "+5%";
  let pitch = "+0Hz";
  let style: any = "manual";

  sourceFiles.forEach((item, chapterIdx) => {
    const chSlug = item.slug;
    const chDir = path.join(DATA_DIR, chSlug);
    const chDurSec = item.meta.durationSec;
    const chDurMs = Math.round(chDurSec * 1000);
    const chDurFrames = Math.round(chDurSec * fps);

    const readJson = (f: string) => {
      const p = path.join(chDir, f);
      if (!fs.existsSync(p)) return null;
      try {
        return JSON.parse(fs.readFileSync(p, "utf-8"));
      } catch {
        return null;
      }
    };

    const bp = readJson("browse-plan.json");
    const ep = readJson("edit-plan.json");
    const mm = readJson("moments.json");
    const nr = readJson("narration.json") || ep?.narration;

    if (bp) {
      if (!firstBaseUrl && bp.baseUrl) firstBaseUrl = bp.baseUrl;
      if (Array.isArray(bp.actions)) {
        bp.actions.forEach((act: any, idx: number) => {
          combinedActions.push({
            ...act,
            description:
              idx === 0
                ? `[챕터 ${chapterIdx + 1}: ${chSlug}] ${act.description || act.type}`
                : act.description,
          });
        });
      }
    }

    if (mm && Array.isArray(mm.moments)) {
      const chFps = Number(ep?.fps || 60);
      for (const m of mm.moments) {
        const rawTsMs = Number(m.timestamp || 0);
        const rawFrame = Math.round((rawTsMs / 1000) * chFps);
        const compFrame = mapRawFrameToCompFrame(rawFrame, ep);
        const compTsMs = Math.min(chDurMs, Math.max(0, Math.round((compFrame / chFps) * 1000)));
        combinedMoments.push({
          ...m,
          id: combinedMoments.length + 1,
          timestamp: cumulativeMs + compTsMs,
          description: `[챕터 ${chapterIdx + 1}: ${chSlug}] ${m.description || m.action || "동작"}`,
        });
      }
    } else {
      // Add at least a chapter marker moment at the start of the chapter
      combinedMoments.push({
        id: combinedMoments.length + 1,
        action: "click",
        timestamp: cumulativeMs + 200,
        x: 960,
        y: 540,
        description: `🎬 챕터 ${chapterIdx + 1} 시작: ${chSlug}`,
      });
    }

    if (ep && Array.isArray(ep.segments)) {
      for (const seg of ep.segments) {
        const sStart = mapRawFrameToCompFrame(Number(seg.startFrame || 0), ep);
        const sEnd = mapRawFrameToCompFrame(Number(seg.endFrame || 0), ep);
        if (sEnd > sStart) {
          combinedSegments.push({
            ...seg,
            startFrame: cumulativeFrames + Math.min(chDurFrames, sStart),
            endFrame: cumulativeFrames + Math.min(chDurFrames, sEnd),
            description: `[${chSlug}] ${seg.description || ""}`.trim(),
          });
        }
      }
    }

    if (nr && Array.isArray(nr.cues)) {
      if (chapterIdx === 0) {
        if (nr.voice) voice = nr.voice;
        if (nr.rate) rate = nr.rate;
        if (nr.pitch) pitch = nr.pitch;
        if (nr.style) style = nr.style;
      }
      nr.cues.forEach((cue: any, cIdx: number) => {
        const cStartMs = Number(cue.compStartMs ?? cue.startMs ?? cue.videoStartMs ?? 0);
        const cEndMs = Number(cue.compEndMs ?? cue.endMs ?? cue.videoEndMs ?? cStartMs + 2500);
        const shiftedStartMs = cumulativeMs + Math.min(chDurMs, Math.max(0, cStartMs));
        const shiftedEndMs = cumulativeMs + Math.min(chDurMs, Math.max(cStartMs + 300, cEndMs));

        let newAudioFile = cue.audioFile;
        if (cue.audioFile) {
          const baseName = path.basename(cue.audioFile);
          const srcAudio = path.join(chDir, "audio", baseName);
          const newFileName = `ch${chapterIdx + 1}_${String(cIdx + 1).padStart(2, "0")}_${baseName}`;
          if (fs.existsSync(srcAudio)) {
            try {
              fs.copyFileSync(srcAudio, path.join(mergedAudioDir, newFileName));
              fs.copyFileSync(srcAudio, path.join(publicNarrationDir, newFileName));
              newAudioFile = `narration/${targetSlug}/${newFileName}`;
            } catch {}
          }
        }

        combinedCues.push({
          ...cue,
          id: combinedCues.length + 1,
          isIntro: chapterIdx === 0 && Boolean(cue.isIntro),
          startMs: shiftedStartMs,
          endMs: shiftedEndMs,
          videoStartMs: shiftedStartMs,
          videoEndMs: shiftedEndMs,
          compStartMs: shiftedStartMs,
          compEndMs: shiftedEndMs,
          autoHoldMs: 0,
          extraHoldMs: 0,
          audioFile: newAudioFile,
        });
      });
    }

    cumulativeMs += chDurMs;
    cumulativeFrames += chDurFrames;
  });

  const actualTotalDurSec = probeVideoDurationSec(outMp4Path) || Number((cumulativeMs / 1000).toFixed(3));
  const actualTotalMs = Math.round(actualTotalDurSec * 1000);
  const actualTotalFrames = Math.max(60, Math.round(actualTotalDurSec * fps));

  const mergedBrowsePlan = {
    baseUrl: firstBaseUrl || "https://gwdev.bc.ac.kr",
    viewport: { width: 1920, height: 1080 },
    recordedByEyedropper: true,
    mergedFromSlugs: rawSlugs,
    actions:
      combinedActions.length > 0
        ? combinedActions
        : rawSlugs.map((s, idx) => ({
            type: "click",
            description: `🔗 챕터 ${idx + 1}: ${s}`,
          })),
  };
  fs.writeFileSync(
    path.join(mergedDataDir, "browse-plan.json"),
    JSON.stringify(mergedBrowsePlan, null, 2),
    "utf-8"
  );

  const mergedMomentsFile = {
    moments: combinedMoments,
    cursorTrajectory: [],
    metadata: {
      totalDurationMs: actualTotalMs,
      calibratedToVideoDurationMs: actualTotalMs,
      viewport: { width: 1920, height: 1080 },
      recordedAt: new Date().toISOString(),
      mergedFromSlugs: rawSlugs,
    },
  };
  fs.writeFileSync(
    path.join(mergedDataDir, "moments.json"),
    JSON.stringify(mergedMomentsFile, null, 2),
    "utf-8"
  );

  const mergedNarration =
    combinedCues.length > 0
      ? {
          enabled: true,
          showSubtitles: true,
          style,
          voice,
          rate,
          pitch,
          cues: combinedCues,
          updatedAt: new Date().toISOString(),
        }
      : undefined;

  if (mergedNarration) {
    fs.writeFileSync(
      path.join(mergedDataDir, "narration.json"),
      JSON.stringify(mergedNarration, null, 2),
      "utf-8"
    );
  }

  const mergedEditPlan: any = {
    fps,
    width: 1920,
    height: 1080,
    totalDurationFrames: actualTotalFrames,
    rawDurationFrames: actualTotalFrames,
    segments: combinedSegments,
    cursorStyle: {
      size: 24,
      color: "#000000",
      rippleColor: "rgba(59, 130, 246, 0.45)",
      rippleRadius: 36,
    },
    ...(mergedNarration ? { narration: mergedNarration } : {}),
  };
  fs.writeFileSync(
    path.join(mergedDataDir, "edit-plan.json"),
    JSON.stringify(mergedEditPlan, null, 2),
    "utf-8"
  );

  const stat = fs.statSync(outMp4Path);

  return {
    success: true,
    outputSlug: targetSlug,
    mergedSlugs: rawSlugs,
    totalDurationSec: actualTotalDurSec,
    fileSizeBytes: stat.size,
    videoUrl: `/api/rendered-video/${targetSlug}`,
    downloadUrl: `/api/download/${targetSlug}`,
    usedFastCopy,
  };
}

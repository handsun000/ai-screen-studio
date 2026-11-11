import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";
import { getNarration, saveNarrationFile } from "./narrationService";
import { ensureSiteBrandForScenario } from "./siteBrandService";
import {
  bakeOpeningSlideIntoRecording,
  buildCoverSlideHtmlDocument,
  buildSlideHtmlDocument,
  encodeSlidePngToMp4,
  ensureRenderedBaseVideo,
  fastApplyNarrationToRenderedMp4,
  renderSlideHtmlToPng,
} from "./slideVideoComposer";
import { linkOrCopyFileSafe, replaceFileSafeWithNewInode } from "./storageOptimizerService";
import type { IntroTocConfig, IntroTocItem } from "../types";

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
        try {
          if (fs.existsSync(dst)) fs.unlinkSync(dst);
        } catch {}
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
      try {
        if (fs.existsSync(dst)) fs.unlinkSync(dst);
      } catch {}
      fs.copyFileSync(src, dst);
    } else if (fs.existsSync(dst)) {
      try {
        fs.unlinkSync(dst);
      } catch {}
    }
  }
}

function syncPublicRecordingCopy(slug: string, mp4Path: string) {
  try {
    const pubVideosDir = path.join(PUBLIC_DIR, "videos");
    fs.mkdirSync(pubVideosDir, { recursive: true });
    linkOrCopyFileSafe(mp4Path, path.join(pubVideosDir, `${slug}.mp4`));
  } catch {}
}

/**
 * Safely replaces targetPath with tmpPath on Windows without failing with EPERM/EBUSY
 * when the browser <video> element or an HTTP Range stream holds a read handle on targetPath,
 * while detaching any existing hardlink inode first.
 */
function replaceFileSafeWindows(tmpPath: string, targetPath: string) {
  replaceFileSafeWithNewInode(tmpPath, targetPath);
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
  const srcMeta = probeClipMeta(mp4Path);

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
      ...(srcMeta.hasAudio ? ["-c:a", "aac", "-b:a", "192k"] : ["-an"]),
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
      ...(srcMeta.hasAudio ? ["-c:a", "aac", "-b:a", "192k"] : ["-an"]),
      "-movflags",
      "+faststart",
      tmpOut,
    ];
  } else {
    // Cut middle: keep [0, startSec] + [endSec, totalDurSec]
    const filterComplex = srcMeta.hasAudio
      ? `[0:v]trim=start=0:end=${startSec.toFixed(3)},setpts=PTS-STARTPTS[v0];[0:a]atrim=start=0:end=${startSec.toFixed(
          3
        )},asetpts=PTS-STARTPTS[a0];[0:v]trim=start=${endSec.toFixed(
          3
        )},setpts=PTS-STARTPTS[v1];[0:a]atrim=start=${endSec.toFixed(
          3
        )},asetpts=PTS-STARTPTS[a1];[v0][a0][v1][a1]concat=n=2:v=1:a=1[outvraw][outa];[outvraw]fps=30[outv]`
      : `[0:v]trim=start=0:end=${startSec.toFixed(3)},setpts=PTS-STARTPTS[v0];[0:v]trim=start=${endSec.toFixed(
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
      ...(srcMeta.hasAudio ? ["-map", "[outa]", "-c:a", "aac", "-b:a", "192k"] : []),
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

  replaceFileSafeWindows(tmpOut, mp4Path);
  syncPublicRecordingCopy(slug, mp4Path);
  const bpCutCheckPath = path.join(sDir, "browse-plan.json");
  let isMergedOnCut = false;
  if (fs.existsSync(bpCutCheckPath)) {
    try {
      const bpObj = JSON.parse(fs.readFileSync(bpCutCheckPath, "utf-8"));
      if (Array.isArray(bpObj?.mergedFromSlugs) && bpObj.mergedFromSlugs.length > 0) {
        isMergedOnCut = true;
      }
    } catch {}
  }
  const staleRenderedOnCut = path.join(ROOT_DIR, "output", `${slug}.mp4`);
  if (isMergedOnCut) {
    try {
      linkOrCopyFileSafe(mp4Path, staleRenderedOnCut);
      linkOrCopyFileSafe(mp4Path, path.join(sDir, "merged.orig.mp4"));
    } catch {}
  } else {
    for (const stalePath of [
      staleRenderedOnCut,
      path.join(sDir, "rendered.base.mp4"),
      path.join(sDir, "rendered.base.json"),
    ]) {
      if (fs.existsSync(stalePath)) {
        try {
          fs.unlinkSync(stalePath);
        } catch {}
      }
    }
  }

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
      if (mode === "undo") {
        replaceFileSafeWithNewInode(backupFile, targetFile);
      } else {
        try {
          if (fs.existsSync(targetFile)) fs.unlinkSync(targetFile);
        } catch {}
        fs.copyFileSync(backupFile, targetFile);
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
  const bpRestoreCheckPath = path.join(sDir, "browse-plan.json");
  let isMergedOnRestore = false;
  if (fs.existsSync(bpRestoreCheckPath)) {
    try {
      const bpObj = JSON.parse(fs.readFileSync(bpRestoreCheckPath, "utf-8"));
      if (Array.isArray(bpObj?.mergedFromSlugs) && bpObj.mergedFromSlugs.length > 0) {
        isMergedOnRestore = true;
      }
    } catch {}
  }
  const staleRenderedOnRestore = path.join(ROOT_DIR, "output", `${slug}.mp4`);
  if (isMergedOnRestore) {
    try {
      linkOrCopyFileSafe(mp4Path, staleRenderedOnRestore);
      linkOrCopyFileSafe(mp4Path, path.join(sDir, "merged.orig.mp4"));
    } catch {}
  } else {
    for (const stalePath of [
      staleRenderedOnRestore,
      path.join(sDir, "rendered.base.mp4"),
      path.join(sDir, "rendered.base.json"),
    ]) {
      if (fs.existsSync(stalePath)) {
        try {
          fs.unlinkSync(stalePath);
        } catch {}
      }
    }
  }
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
  rFrameRate: string;
  hasAudio: boolean;
}

function probeClipMeta(mp4Path: string): ProbedStreamMeta {
  const durationSec = probeVideoDurationSec(mp4Path);
  let width = 1920;
  let height = 1080;
  let videoCodec = "h264";
  let rFrameRate = "30/1";
  let hasAudio = false;

  try {
    const res = spawnSync(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "stream=codec_name,codec_type,width,height,r_frame_rate",
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
          if (s.r_frame_rate) rFrameRate = String(s.r_frame_rate);
        } else if (s.codec_type === "audio") {
          hasAudio = true;
        }
      }
    }
  } catch {}

  return { durationSec, width, height, videoCodec, rFrameRate, hasAudio };
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

function mixScenarioNarrationAudioIntoRawVideo(
  slug: string,
  rawMp4Path: string,
  outTempMp4Path: string,
  cuesFilter?: (cue: any) => boolean,
  delayOffsetMs: number = 0
): string {
  const sDir = path.join(DATA_DIR, slug);
  const narration = getNarration(slug);
  if (!narration || !Array.isArray(narration.cues) || narration.cues.length === 0) {
    return rawMp4Path;
  }

  const cuesToUse = cuesFilter ? narration.cues.filter(cuesFilter) : narration.cues;
  const audioInputs: { path: string; delayMs: number }[] = [];
  for (let i = 0; i < cuesToUse.length; i++) {
    const c = cuesToUse[i];
    if (!c.audioFile) continue;
    const mp3Path = path.join(sDir, "audio", path.basename(c.audioFile));
    if (fs.existsSync(mp3Path)) {
      const origStart = Number(c.videoStartMs ?? c.startMs ?? 0);
      const delayMs = Math.max(0, Math.round(origStart - delayOffsetMs));
      audioInputs.push({ path: mp3Path, delayMs });
    }
  }

  if (audioInputs.length === 0) {
    return rawMp4Path;
  }

  const meta = probeClipMeta(rawMp4Path);
  const durStr = Math.max(1.0, meta.durationSec).toFixed(3);
  const args: string[] = ["-y", "-v", "error", "-i", rawMp4Path];
  for (const ai of audioInputs) {
    args.push("-i", ai.path);
  }

  const filterParts: string[] = [
    `anullsrc=channel_layout=stereo:sample_rate=48000,atrim=0:${durStr},asetpts=PTS-STARTPTS[abg]`,
  ];
  const mixLabels: string[] = ["[abg]"];
  audioInputs.forEach((ai, idx) => {
    const inIdx = idx + 1;
    const d = ai.delayMs;
    filterParts.push(
      `[${inIdx}:a]aformat=sample_rates=48000:channel_layouts=stereo,adelay=${d}|${d}[a${inIdx}]`
    );
    mixLabels.push(`[a${inIdx}]`);
  });
  filterParts.push(
    `${mixLabels.join("")}amix=inputs=${mixLabels.length}:duration=first:dropout_transition=0,volume=${mixLabels.length}[outa]`
  );

  args.push(
    "-filter_complex",
    filterParts.join(";"),
    "-map",
    "0:v:0",
    "-map",
    "[outa]",
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-movflags",
    "+faststart",
    outTempMp4Path
  );

  const res = spawnSync("ffmpeg", args, { encoding: "utf-8" });
  if (res.status === 0 && fs.existsSync(outTempMp4Path)) {
    return outTempMp4Path;
  }
  return rawMp4Path;
}

function getScenarioPureBodyVideo(
  slug: string,
  targetSlug: string,
  outputDir: string,
  tempCleanupFiles: string[]
): { bodyMp4Path: string; introDurationMs: number } {
  const scDir = path.join(DATA_DIR, slug);
  const rawRecMp4Path = path.join(scDir, "recording.mp4");
  const bodyMp4Path = path.join(scDir, "recording.body.mp4");
  const chNarration = getNarration(slug);
  const hasIntroBaked = Boolean(
    chNarration?.introBakedIntoVideo && Number(chNarration?.bakedIntroDurationMs || 0) > 0
  );
  const introDurationMs = hasIntroBaked ? Number(chNarration!.bakedIntroDurationMs) : 0;

  if (fs.existsSync(bodyMp4Path)) {
    return { bodyMp4Path, introDurationMs };
  }
  if (fs.existsSync(rawRecMp4Path)) {
    if (introDurationMs > 0) {
      const ss = (introDurationMs / 1000).toFixed(3);
      const trimmedTmp = path.join(outputDir, `${targetSlug}_${slug}_body_extracted.mp4`);
      tempCleanupFiles.push(trimmedTmp);
      spawnSync("ffmpeg", ["-y", "-v", "error", "-ss", ss, "-i", rawRecMp4Path, "-c", "copy", trimmedTmp]);
      if (fs.existsSync(trimmedTmp)) {
        return { bodyMp4Path: trimmedTmp, introDurationMs };
      }
    }
    return { bodyMp4Path: rawRecMp4Path, introDurationMs: 0 };
  }
  throw new Error(`'${slug}' 시나리오의 영상 파일이 없습니다.`);
}

async function mergeAsSingleVideo(params: {
  rawSlugs: string[];
  targetSlug: string;
  mergedDataDir: string;
  mergedAudioDir: string;
  publicNarrationDir: string;
  outputDir: string;
  tempCleanupFiles: string[];
}): Promise<VideoMergeResult> {
  const { rawSlugs, targetSlug, mergedDataDir, mergedAudioDir, publicNarrationDir, outputDir, tempCleanupFiles } = params;

  // 1. Prepare source body clips
  const sourceFiles: {
    slug: string;
    mp4Path: string;
    meta: ProbedStreamMeta;
    bodyDurationSec: number;
    introDurationMs: number;
  }[] = [];

  for (const slug of rawSlugs) {
    const bodyInfo = getScenarioPureBodyVideo(slug, targetSlug, outputDir, tempCleanupFiles);
    const mixedTmp = path.join(outputDir, `${targetSlug}_ch_${slug}_body_mixed.mp4`);
    const finalMp4 = mixScenarioNarrationAudioIntoRawVideo(
      slug,
      bodyInfo.bodyMp4Path,
      mixedTmp,
      (c) => !c.isIntro,
      bodyInfo.introDurationMs
    );
    if (finalMp4 === mixedTmp) tempCleanupFiles.push(mixedTmp);
    const meta = probeClipMeta(finalMp4);
    if (meta.durationSec <= 0.1) {
      throw new Error(`'${slug}' 본문 영상의 길이를 읽을 수 없습니다.`);
    }
    sourceFiles.push({
      slug,
      mp4Path: finalMp4,
      meta,
      bodyDurationSec: meta.durationSec,
      introDurationMs: bodyInfo.introDurationMs,
    });
  }

  // 2. Build Single Unified Opening Slide
  const siteBrand = await ensureSiteBrandForScenario(rawSlugs[0]);
  let voice = "ko-KR-SunHiNeural";
  let rate = "+5%";
  let pitch = "+0Hz";
  let style: any = "manual";

  const chapterShortNames: string[] = [];
  const singleTocItems: IntroTocItem[] = [];

  rawSlugs.forEach((slug, idx) => {
    const chNarration = getNarration(slug);
    if (idx === 0 && chNarration) {
      if (chNarration.voice) voice = chNarration.voice;
      if (chNarration.rate) rate = chNarration.rate;
      if (chNarration.pitch) pitch = chNarration.pitch;
      if (chNarration.style) style = chNarration.style;
    }
    const chTitle =
      chNarration?.introToc?.title && !/^live\s+demo\s+\d+$/i.test(chNarration.introToc.title)
        ? chNarration.introToc.title
        : slug.replace(/[-_]+/g, " ");
    const chSummary =
      chNarration?.introToc?.summary ||
      (Array.isArray(chNarration?.introToc?.items) && chNarration!.introToc!.items.length > 0
        ? chNarration!.introToc!.items.map((it) => it.title || it.description).slice(0, 3).join(", ") +
          " 과정을 안내합니다."
        : `${chTitle}의 주요 기능과 처리 절차를 진행합니다.`);

    chapterShortNames.push(chTitle);
    singleTocItems.push({
      title: `${idx + 1}단계: ${chTitle}`,
      description: chSummary,
    });
  });

  const shortModuleLabels = chapterShortNames.map((name) => {
    const cleaned = name
      .replace(/\s*(?:사용\s*매뉴얼|매뉴얼|가이드|안내)+$/g, "")
      .replace(/\s+(?:및|와|과)$/g, "")
      .trim();
    return cleaned || name;
  });

  const firstMeta = sourceFiles[0].meta;
  const targetW = Math.floor((firstMeta.width || 1920) / 2) * 2;
  const targetH = Math.floor((firstMeta.height || 1080) / 2) * 2;

  const unifiedTitle =
    shortModuleLabels.length <= 2
      ? `${shortModuleLabels.join(" 및 ")} 매뉴얼`
      : `${shortModuleLabels[0]} 외 ${shortModuleLabels.length - 1}개 과정 통합 매뉴얼`;

  const singleOpeningText = `${siteBrand.siteName} ${unifiedTitle} 안내 영상을 시작합니다. ${shortModuleLabels.join(
    ", "
  )} 순서로 진행됩니다.`;

  const singleAudioFileName = "single_intro.mp3";
  const singleAudioMp3Path = path.join(mergedAudioDir, singleAudioFileName);
  const publicSingleAudioPath = path.join(publicNarrationDir, singleAudioFileName);

  try {
    spawnSync(
      "python",
      [
        "-m",
        "edge_tts",
        "--voice",
        voice,
        `--rate=${rate}`,
        `--pitch=${pitch}`,
        "--text",
        singleOpeningText,
        "--write-media",
        singleAudioMp3Path,
      ],
      { cwd: ROOT_DIR, encoding: "utf-8", timeout: 25000 }
    );
    if (fs.existsSync(singleAudioMp3Path)) {
      fs.copyFileSync(singleAudioMp3Path, publicSingleAudioPath);
    }
  } catch (ttsErr) {
    console.warn("[Single Intro TTS] 오프닝 음성 합성 경고:", ttsErr);
  }

  const singleAudioDurSec = fs.existsSync(singleAudioMp3Path)
    ? probeVideoDurationSec(singleAudioMp3Path) || 4.2
    : 4.0;
  const singleDurationSec = Number(Math.max(4.0, singleAudioDurSec + 0.6).toFixed(3));
  const singleDurationMs = Math.round(singleDurationSec * 1000);

  const singleSlidePngPath = path.join(mergedDataDir, "single-intro-slide.png");
  const singleSlideMp4Path = path.join(outputDir, `${targetSlug}_single_intro.mp4`);
  tempCleanupFiles.push(singleSlideMp4Path);

  const singleTocConfig: IntroTocConfig = {
    enabled: true,
    badge: siteBrand.manualBadge || "그룹웨어 사용 매뉴얼",
    title: unifiedTitle,
    summary: `총 ${rawSlugs.length}개 단계(${shortModuleLabels.join(" ➜ ")})의 상세 사용 방법을 순서대로 안내합니다.`,
    items: singleTocItems.slice(0, 8),
    siteBrand,
  };

  const singleSlideHtml = buildSlideHtmlDocument({
    toc: singleTocConfig,
    siteBrand,
    width: targetW,
    height: targetH,
    mode: "detail",
    subtitleText: singleOpeningText,
  });
  await renderSlideHtmlToPng(singleSlideHtml, singleSlidePngPath, targetW, targetH);

  encodeSlidePngToMp4({
    pngPath: singleSlidePngPath,
    outMp4Path: singleSlideMp4Path,
    durationSec: singleDurationSec,
    width: targetW,
    height: targetH,
    fps: 60,
    audioMp3Path: fs.existsSync(singleAudioMp3Path) ? singleAudioMp3Path : undefined,
  });

  // 3. Concat all clips: [Single Intro Slide] + [Slug 1 Body] + [Slug 2 Body] + ...
  const singleSlideClipMeta = probeClipMeta(singleSlideMp4Path);
  const allClipsToConcat: { slug: string; mp4Path: string; meta: ProbedStreamMeta }[] = [
    { slug: "__single_intro__", mp4Path: singleSlideMp4Path, meta: singleSlideClipMeta },
    ...sourceFiles.map((s) => ({ slug: s.slug, mp4Path: s.mp4Path, meta: s.meta })),
  ];

  const outMp4Path = path.join(outputDir, `${targetSlug}.mp4`);
  const tmpOutPath = path.join(outputDir, `${targetSlug}_concat_tmp.mp4`);

  const inputArgs: string[] = ["-y", "-v", "error"];
  for (const item of allClipsToConcat) {
    inputArgs.push("-i", item.mp4Path);
  }

  const filterParts: string[] = [];
  const concatInputs: string[] = [];

  allClipsToConcat.forEach((item, idx) => {
    filterParts.push(
      `[${idx}:v]scale=${targetW}:${targetH}:force_original_aspect_ratio=decrease,pad=${targetW}:${targetH}:(ow-iw)/2:(oh-ih)/2,fps=60,format=yuv420p,setpts=PTS-STARTPTS[v${idx}]`
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

  filterParts.push(`${concatInputs.join("")}concat=n=${allClipsToConcat.length}:v=1:a=1[outv][outa]`);

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
  for (const tf of tempCleanupFiles) {
    try {
      if (fs.existsSync(tf)) fs.unlinkSync(tf);
    } catch {}
  }

  if (ffRes.status !== 0 || !fs.existsSync(tmpOutPath)) {
    throw new Error(`FFmpeg 단일 영상 병합 실패: ${ffRes.stderr || "알 수 없는 오류"}`);
  }

  replaceFileSafeWindows(tmpOutPath, outMp4Path);

  const mergedRecordingPath = path.join(mergedDataDir, "recording.mp4");
  const mergedOrigPath = path.join(mergedDataDir, "merged.orig.mp4");
  try {
    linkOrCopyFileSafe(outMp4Path, mergedRecordingPath);
    linkOrCopyFileSafe(outMp4Path, mergedOrigPath);
    syncPublicRecordingCopy(targetSlug, mergedRecordingPath);
  } catch {}

  // 4. Timeline Mapping
  const fps = 60;
  const totalFrontIntroMs = singleDurationMs;
  let cumulativeMs = totalFrontIntroMs;
  let cumulativeFrames = Math.round(singleDurationSec * fps);

  const combinedActions: any[] = [];
  const combinedMoments: any[] = [];
  const combinedSegments: any[] = [];
  const combinedCues: any[] = [
    {
      id: 1,
      isIntro: true,
      text: singleOpeningText,
      startMs: 200,
      endMs: Math.max(1500, singleDurationMs - 200),
      videoStartMs: 200,
      videoEndMs: singleDurationMs,
      compStartMs: 200,
      compEndMs: Math.max(1500, singleDurationMs - 200),
      audioDurationMs: Math.round(singleAudioDurSec * 1000),
      autoHoldMs: 0,
      extraHoldMs: 0,
      effectiveDeltaMs: 0,
      playbackRate: 1.0,
      audioFile: fs.existsSync(singleAudioMp3Path)
        ? `narration/${targetSlug}/${singleAudioFileName}`
        : undefined,
    },
  ];
  let firstBaseUrl = "";

  sourceFiles.forEach((item, chapterIdx) => {
    const chSlug = item.slug;
    const chDir = path.join(DATA_DIR, chSlug);
    const chDurSec = item.meta.durationSec;
    const chDurMs = Math.round(chDurSec * 1000);
    const chDurFrames = Math.round(chDurSec * fps);
    const introOffsetMs = item.introDurationMs;

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
    const mmBody = readJson("moments.body.json");
    const mm = mmBody || readJson("moments.json");
    const nr = readJson("narration.json") || ep?.narration;

    if (bp) {
      if (!firstBaseUrl && bp.baseUrl) firstBaseUrl = bp.baseUrl;
      if (Array.isArray(bp.actions)) {
        bp.actions.forEach((act: any, idx: number) => {
          combinedActions.push({
            ...act,
            description:
              idx === 0
                ? `[${chapterIdx + 1}단계: ${chSlug}] ${act.description || act.type}`
                : act.description,
          });
        });
      }
    }

    if (mm && Array.isArray(mm.moments)) {
      const chFps = Number(ep?.fps || 60);
      for (const m of mm.moments) {
        let rawTsMs = Number(m.timestamp || 0);
        if (!mmBody && introOffsetMs > 0) {
          rawTsMs = Math.max(0, rawTsMs - introOffsetMs);
        }
        const rawFrame = Math.round((rawTsMs / 1000) * chFps);
        const compFrame = mapRawFrameToCompFrame(rawFrame, ep);
        const compTsMs = Math.min(chDurMs, Math.max(0, Math.round((compFrame / chFps) * 1000)));
        combinedMoments.push({
          ...m,
          id: combinedMoments.length + 1,
          timestamp: cumulativeMs + compTsMs,
          description: `[${chapterIdx + 1}단계: ${chSlug}] ${m.description || m.action || "동작"}`,
        });
      }
    } else {
      combinedMoments.push({
        id: combinedMoments.length + 1,
        action: "click",
        timestamp: cumulativeMs + 200,
        x: 960,
        y: 540,
        description: `🎬 ${chapterIdx + 1}단계 시작: ${chSlug}`,
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
      const bodyCues = nr.cues.filter((c: any) => !c.isIntro);
      bodyCues.forEach((cue: any, cIdx: number) => {
        let cStartMs = Number(cue.compStartMs ?? cue.startMs ?? cue.videoStartMs ?? 0);
        let cEndMs = Number(cue.compEndMs ?? cue.endMs ?? cue.videoEndMs ?? cStartMs + 2500);
        if (!mmBody && introOffsetMs > 0) {
          cStartMs = Math.max(0, cStartMs - introOffsetMs);
          cEndMs = Math.max(cStartMs + 300, cEndMs - introOffsetMs);
        }
        const shiftedStartMs = cumulativeMs + Math.min(chDurMs, Math.max(0, cStartMs));
        const shiftedEndMs = cumulativeMs + Math.min(chDurMs, Math.max(cStartMs + 300, cEndMs));

        let newAudioFile = cue.audioFile;
        if (cue.audioFile) {
          const baseName = path.basename(cue.audioFile);
          const srcAudio = path.join(chDir, "audio", baseName);
          const newFileName = `step${chapterIdx + 1}_${String(cIdx + 1).padStart(2, "0")}_${baseName}`;
          if (fs.existsSync(srcAudio)) {
            try {
              const dstMergedAudio = path.join(mergedAudioDir, newFileName);
              try {
                if (fs.existsSync(dstMergedAudio)) fs.unlinkSync(dstMergedAudio);
              } catch {}
              fs.copyFileSync(srcAudio, dstMergedAudio);
              linkOrCopyFileSafe(dstMergedAudio, path.join(publicNarrationDir, newFileName));
              newAudioFile = `narration/${targetSlug}/${newFileName}`;
            } catch {}
          }
        }

        combinedCues.push({
          ...cue,
          id: combinedCues.length + 1,
          isIntro: false,
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
    baseUrl: firstBaseUrl || "",
    viewport: { width: 1920, height: 1080 },
    recordedByEyedropper: true,
    mergedFromSlugs: rawSlugs,
    mergeMode: "single",
    actions:
      combinedActions.length > 0
        ? combinedActions
        : rawSlugs.map((s, idx) => ({
            type: "click",
            description: `🔗 ${idx + 1}단계: ${s}`,
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
      mergeMode: "single",
    },
  };
  fs.writeFileSync(
    path.join(mergedDataDir, "moments.json"),
    JSON.stringify(mergedMomentsFile, null, 2),
    "utf-8"
  );

  const mergedNarrationFile = {
    slug: targetSlug,
    enabled: true,
    showSubtitles: true,
    showIntroToc: true,
    introToc: singleTocConfig,
    siteBrand,
    introBakedIntoVideo: true,
    bakedIntroDurationMs: totalFrontIntroMs,
    mergedFromSlugs: rawSlugs,
    mergeMode: "single",
    style,
    voice,
    rate,
    pitch,
    cues: combinedCues,
    updatedAt: new Date().toISOString(),
  };

  fs.writeFileSync(
    path.join(mergedDataDir, "merged.orig.json"),
    JSON.stringify(
      {
        mergedFromSlugs: rawSlugs,
        mergeMode: "single",
        totalFrontIntroMs,
        cues: combinedCues,
      },
      null,
      2
    ),
    "utf-8"
  );
  saveNarrationFile(targetSlug, mergedNarrationFile as any);

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
    narration: mergedNarrationFile,
  };
  fs.writeFileSync(
    path.join(mergedDataDir, "edit-plan.json"),
    JSON.stringify(mergedEditPlan, null, 2),
    "utf-8"
  );

  const finalDurSec = probeVideoDurationSec(outMp4Path) || actualTotalDurSec;
  const stat = fs.statSync(outMp4Path);

  return {
    success: true,
    outputSlug: targetSlug,
    mergedSlugs: rawSlugs,
    totalDurationSec: finalDurSec,
    fileSizeBytes: stat.size,
    videoUrl: `/api/rendered-video/${targetSlug}`,
    downloadUrl: `/api/download/${targetSlug}`,
    usedFastCopy: false,
  };
}

export async function mergeRenderedVideos(options: {
  slugs: string[];
  outputSlug?: string;
  mergeMode?: "single" | "chapters" | "auto";
}): Promise<VideoMergeResult> {
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

  const mergedDataDir = path.join(DATA_DIR, targetSlug);
  if (!fs.existsSync(mergedDataDir)) {
    fs.mkdirSync(mergedDataDir, { recursive: true });
  }
  const mergedAudioDir = path.join(mergedDataDir, "audio");
  const publicNarrationDir = path.join(PUBLIC_DIR, "narration", targetSlug);
  if (!fs.existsSync(mergedAudioDir)) fs.mkdirSync(mergedAudioDir, { recursive: true });
  if (!fs.existsSync(publicNarrationDir)) fs.mkdirSync(publicNarrationDir, { recursive: true });

  const tempCleanupFiles: string[] = [];

  // Determine effective merge mode
  let effectiveMode: "single" | "chapters" =
    options.mergeMode === "single" || options.mergeMode === "chapters"
      ? options.mergeMode
      : "single";

  if (options.mergeMode === "auto" || !options.mergeMode) {
    const allHaveSlides = rawSlugs.every((slug) => {
      const nr = getNarration(slug);
      return (
        nr &&
        nr.showIntroToc !== false &&
        nr.introToc?.enabled !== false &&
        (Boolean(nr.introBakedIntoVideo) || Number(nr.bakedIntroDurationMs || 0) > 0)
      );
    });
    // Case 2 (all have slides): chapters
    // Case 1 (neither has slide) & Case 3 (mixed): single
    effectiveMode = allHaveSlides ? "chapters" : "single";
  }
  console.log(`[Video Merge] 병합 모드: ${effectiveMode.toUpperCase()} (${options.mergeMode || "auto"} 요청)`);

  if (effectiveMode === "single") {
    return await mergeAsSingleVideo({
      rawSlugs,
      targetSlug,
      mergedDataDir,
      mergedAudioDir,
      publicNarrationDir,
      outputDir,
      tempCleanupFiles,
    });
  }

  // Validate all source MP4 files (rendered output/<slug>.mp4 preferred; fallback to slide-baked data/<slug>/recording.mp4)
  const sourceFiles: { slug: string; mp4Path: string; meta: ProbedStreamMeta }[] = [];
  for (const slug of rawSlugs) {
    const renderedMp4Path = path.join(outputDir, `${slug}.mp4`);
    const rawRecMp4Path = path.join(DATA_DIR, slug, "recording.mp4");
    let usePath = "";

    // 각 시나리오의 세부내용 슬라이드가 최신 Contents 단독 레이아웃(contents-only-v2)인지 확인 및 자동 갱신
    const chNarrationBefore = getNarration(slug) as any;
    const needsSlideLayoutUpgrade =
      chNarrationBefore &&
      chNarrationBefore.showIntroToc !== false &&
      (!chNarrationBefore._bakedSlideSig ||
        !String(chNarrationBefore._bakedSlideSig).includes("contents-only-v2"));

    if (needsSlideLayoutUpgrade && fs.existsSync(rawRecMp4Path)) {
      try {
        await bakeOpeningSlideIntoRecording(slug, { force: true });
        if (fs.existsSync(renderedMp4Path)) {
          await ensureRenderedBaseVideo(slug);
          await fastApplyNarrationToRenderedMp4(slug);
        }
      } catch (upErr) {
        console.warn(`[Merge] '${slug}' 세부내용 슬라이드 레이아웃 자동 업그레이드 경고:`, upErr);
      }
    }

    const isRenderedFresh =
      fs.existsSync(renderedMp4Path) &&
      (!fs.existsSync(rawRecMp4Path) ||
        fs.statSync(renderedMp4Path).mtimeMs + 2000 >= fs.statSync(rawRecMp4Path).mtimeMs);

    if (isRenderedFresh) {
      usePath = renderedMp4Path;
    } else if (fs.existsSync(rawRecMp4Path)) {
      try {
        await bakeOpeningSlideIntoRecording(slug);
      } catch {}
      const mixedTmp = path.join(outputDir, `${targetSlug}_ch_${slug}_mixed.mp4`);
      usePath = mixScenarioNarrationAudioIntoRawVideo(slug, rawRecMp4Path, mixedTmp);
      if (usePath === mixedTmp) {
        tempCleanupFiles.push(mixedTmp);
      }
    } else {
      throw new Error(
        `'${slug}' 시나리오의 영상 파일(output/${slug}.mp4 또는 data/${slug}/recording.mp4)이 없습니다.`
      );
    }

    const meta = probeClipMeta(usePath);
    if (meta.durationSec <= 0.1) {
      throw new Error(`'${slug}' 영상의 길이를 읽을 수 없습니다.`);
    }
    sourceFiles.push({ slug, mp4Path: usePath, meta });
  }

  // 1. [첫장: 그룹웨어 사용 매뉴얼 표지 슬라이드] + [둘째장: 각 시나리오의 큰 타이틀 슬라이드(Master Contents)] 생성
  const siteBrand = await ensureSiteBrandForScenario(rawSlugs[0]);
  let voice = "ko-KR-SunHiNeural";
  let rate = "+5%";
  let pitch = "+0Hz";
  let style: any = "manual";

  const masterItems: IntroTocItem[] = [];
  const chapterShortNames: string[] = [];

  rawSlugs.forEach((slug, idx) => {
    const chNarration = getNarration(slug);
    if (idx === 0 && chNarration) {
      if (chNarration.voice) voice = chNarration.voice;
      if (chNarration.rate) rate = chNarration.rate;
      if (chNarration.pitch) pitch = chNarration.pitch;
      if (chNarration.style) style = chNarration.style;
    }
    const chTitle =
      chNarration?.introToc?.title && !/^live\s+demo\s+\d+$/i.test(chNarration.introToc.title)
        ? chNarration.introToc.title
        : slug.replace(/[-_]+/g, " ");
    const chSummary =
      chNarration?.introToc?.summary ||
      (Array.isArray(chNarration?.introToc?.items) && chNarration!.introToc!.items.length > 0
        ? chNarration!.introToc!.items.map((it) => it.title || it.description).slice(0, 3).join(", ") +
          " 과정을 안내합니다."
        : `${chTitle}의 주요 기능과 처리 절차를 안내합니다.`);

    chapterShortNames.push(chTitle);
    masterItems.push({
      title: chTitle,
      description: chSummary,
    });
  });

  const shortModuleLabels = chapterShortNames.map((name) => {
    const cleaned = name
      .replace(/\s*(?:사용\s*매뉴얼|매뉴얼|가이드|안내)+$/g, "")
      .replace(/\s+(?:및|와|과)$/g, "")
      .trim();
    return cleaned || name;
  });

  const firstMeta = sourceFiles[0].meta;
  const targetW = Math.floor((firstMeta.width || 1920) / 2) * 2;
  const targetH = Math.floor((firstMeta.height || 1080) / 2) * 2;

  // (1) 첫장: 그룹웨어 사용 매뉴얼 표지 페이지 (Cover Slide)
  const coverOpeningText = `${siteBrand.siteName} 그룹웨어 사용 매뉴얼 영상을 시작합니다.`;
  const coverAudioFileName = "ch0_00_cover_intro.mp3";
  const coverAudioMp3Path = path.join(mergedAudioDir, coverAudioFileName);
  const publicCoverAudioPath = path.join(publicNarrationDir, coverAudioFileName);

  try {
    spawnSync(
      "python",
      [
        "-m",
        "edge_tts",
        "--voice",
        voice,
        `--rate=${rate}`,
        `--pitch=${pitch}`,
        "--text",
        coverOpeningText,
        "--write-media",
        coverAudioMp3Path,
      ],
      { cwd: ROOT_DIR, encoding: "utf-8", timeout: 25000 }
    );
    if (fs.existsSync(coverAudioMp3Path)) {
      fs.copyFileSync(coverAudioMp3Path, publicCoverAudioPath);
    }
  } catch (ttsErr) {
    console.warn("[Cover Intro TTS] 표지 오프닝 음성 합성 경고:", ttsErr);
  }

  const coverAudioDurSec = fs.existsSync(coverAudioMp3Path)
    ? probeVideoDurationSec(coverAudioMp3Path) || 4.2
    : 4.0;
  const coverDurationSec = Number(Math.max(4.0, coverAudioDurSec + 0.6).toFixed(3));
  const coverDurationMs = Math.round(coverDurationSec * 1000);

  const coverSlidePngPath = path.join(mergedDataDir, "master-cover-slide.png");
  const coverSlideMp4Path = path.join(outputDir, `${targetSlug}_master_cover.mp4`);
  tempCleanupFiles.push(coverSlideMp4Path);

  const coverSlideHtml = buildCoverSlideHtmlDocument({
    siteBrand,
    title: "그룹웨어 사용 매뉴얼",
    subtitle: `${siteBrand.siteName} 주요 업무 모듈별 핵심 기능 및 표준 사용 절차를 안내합니다.`,
    chapterTitles: shortModuleLabels,
    width: targetW,
    height: targetH,
    subtitleText: coverOpeningText,
  });
  await renderSlideHtmlToPng(coverSlideHtml, coverSlidePngPath, targetW, targetH);

  encodeSlidePngToMp4({
    pngPath: coverSlidePngPath,
    outMp4Path: coverSlideMp4Path,
    durationSec: coverDurationSec,
    width: targetW,
    height: targetH,
    fps: 60,
    audioMp3Path: fs.existsSync(coverAudioMp3Path) ? coverAudioMp3Path : undefined,
  });

  // (2) 둘째장: 각 시나리오의 큰 타이틀 슬라이드 (Master Contents Slide)
  const masterToc: IntroTocConfig = {
    enabled: true,
    badge: siteBrand.manualBadge || "그룹웨어 사용 매뉴얼",
    title: `${siteBrand.siteName} 주요 시나리오 목차`,
    summary: `총 ${rawSlugs.length}개 주요 시나리오(${shortModuleLabels.join(" · ")})의 핵심 개념과 상세 사용 방법을 순서대로 안내합니다.`,
    items: masterItems.slice(0, 8),
    siteBrand,
  };

  const masterOpeningText = `이번 통합 매뉴얼은 ${shortModuleLabels.join(
    ", "
  )} 등 총 ${rawSlugs.length}개 시나리오로 구성되어 있습니다. 각 시나리오의 세부 목차와 실습 영상을 순서대로 살펴보겠습니다.`;

  const masterAudioFileName = "ch0_01_master_intro.mp3";
  const masterAudioMp3Path = path.join(mergedAudioDir, masterAudioFileName);
  const publicMasterAudioPath = path.join(publicNarrationDir, masterAudioFileName);

  try {
    spawnSync(
      "python",
      [
        "-m",
        "edge_tts",
        "--voice",
        voice,
        `--rate=${rate}`,
        `--pitch=${pitch}`,
        "--text",
        masterOpeningText,
        "--write-media",
        masterAudioMp3Path,
      ],
      { cwd: ROOT_DIR, encoding: "utf-8", timeout: 25000 }
    );
    if (fs.existsSync(masterAudioMp3Path)) {
      fs.copyFileSync(masterAudioMp3Path, publicMasterAudioPath);
    }
  } catch (ttsErr) {
    console.warn("[Master Intro TTS] 전체 목차 음성 합성 경고:", ttsErr);
  }

  const masterAudioDurSec = fs.existsSync(masterAudioMp3Path)
    ? probeVideoDurationSec(masterAudioMp3Path) || 6.5
    : 5.5;
  const masterIntroDurationSec = Number(Math.max(4.8, masterAudioDurSec + 0.7).toFixed(3));
  const masterIntroDurationMs = Math.round(masterIntroDurationSec * 1000);

  const masterSlidePngPath = path.join(mergedDataDir, "master-intro-slide.png");
  const masterSlideMp4Path = path.join(outputDir, `${targetSlug}_master_intro.mp4`);
  tempCleanupFiles.push(masterSlideMp4Path);

  const masterSlideHtml = buildSlideHtmlDocument({
    toc: masterToc,
    siteBrand,
    width: targetW,
    height: targetH,
    headerLabel: "Contents",
    subtitleText: masterOpeningText,
    mode: "chapter-titles",
  });
  await renderSlideHtmlToPng(masterSlideHtml, masterSlidePngPath, targetW, targetH);

  encodeSlidePngToMp4({
    pngPath: masterSlidePngPath,
    outMp4Path: masterSlideMp4Path,
    durationSec: masterIntroDurationSec,
    width: targetW,
    height: targetH,
    fps: 60,
    audioMp3Path: fs.existsSync(masterAudioMp3Path) ? masterAudioMp3Path : undefined,
  });

  const coverClipMeta = probeClipMeta(coverSlideMp4Path);
  const masterClipMeta = probeClipMeta(masterSlideMp4Path);
  const allClipsToConcat: { slug: string; mp4Path: string; meta: ProbedStreamMeta }[] = [
    { slug: "__master_cover__", mp4Path: coverSlideMp4Path, meta: coverClipMeta },
    { slug: "__master_intro__", mp4Path: masterSlideMp4Path, meta: masterClipMeta },
    ...sourceFiles,
  ];

  const outMp4Path = path.join(outputDir, `${targetSlug}.mp4`);
  const tmpOutPath = path.join(outputDir, `${targetSlug}_concat_tmp.mp4`);

  const inputArgs: string[] = ["-y", "-v", "error"];
  for (const item of allClipsToConcat) {
    inputArgs.push("-i", item.mp4Path);
  }

  const filterParts: string[] = [];
  const concatInputs: string[] = [];

  allClipsToConcat.forEach((item, idx) => {
    filterParts.push(
      `[${idx}:v]scale=${targetW}:${targetH}:force_original_aspect_ratio=decrease,pad=${targetW}:${targetH}:(ow-iw)/2:(oh-ih)/2,fps=60,format=yuv420p,setpts=PTS-STARTPTS[v${idx}]`
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

  filterParts.push(`${concatInputs.join("")}concat=n=${allClipsToConcat.length}:v=1:a=1[outv][outa]`);

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
  for (const tf of tempCleanupFiles) {
    try {
      if (fs.existsSync(tf)) fs.unlinkSync(tf);
    } catch {}
  }

  if (ffRes.status !== 0 || !fs.existsSync(tmpOutPath)) {
    throw new Error(`FFmpeg 영상 병합 실패: ${ffRes.stderr || "알 수 없는 오류"}`);
  }

  const usedFastCopy = false;
  replaceFileSafeWindows(tmpOutPath, outMp4Path);

  // Hardlink merged MP4 to data/<targetSlug>/recording.mp4 and merged.orig.mp4 so raw/rendered player modes and post-merge cue additions work with 0 duplicate disk usage
  const mergedRecordingPath = path.join(mergedDataDir, "recording.mp4");
  const mergedOrigPath = path.join(mergedDataDir, "merged.orig.mp4");
  try {
    linkOrCopyFileSafe(outMp4Path, mergedRecordingPath);
    linkOrCopyFileSafe(outMp4Path, mergedOrigPath);
    syncPublicRecordingCopy(targetSlug, mergedRecordingPath);
  } catch {}

  const fps = 60;
  const totalFrontIntroMs = coverDurationMs + masterIntroDurationMs;
  const totalFrontIntroSec = coverDurationSec + masterIntroDurationSec;
  let cumulativeMs = totalFrontIntroMs;
  let cumulativeFrames = Math.round(totalFrontIntroSec * fps);

  const combinedActions: any[] = [];
  const combinedMoments: any[] = [];
  const combinedSegments: any[] = [];
  const combinedCues: any[] = [
    {
      id: 1,
      isIntro: true,
      text: coverOpeningText,
      startMs: 200,
      endMs: Math.max(1500, coverDurationMs - 200),
      videoStartMs: 200,
      videoEndMs: coverDurationMs,
      compStartMs: 200,
      compEndMs: Math.max(1500, coverDurationMs - 200),
      audioDurationMs: Math.round(coverAudioDurSec * 1000),
      autoHoldMs: 0,
      extraHoldMs: 0,
      effectiveDeltaMs: 0,
      playbackRate: 1.0,
      audioFile: fs.existsSync(coverAudioMp3Path)
        ? `narration/${targetSlug}/${coverAudioFileName}`
        : undefined,
    },
    {
      id: 2,
      isIntro: true,
      text: masterOpeningText,
      startMs: coverDurationMs + 200,
      endMs: coverDurationMs + Math.max(1500, masterIntroDurationMs - 200),
      videoStartMs: coverDurationMs + 200,
      videoEndMs: totalFrontIntroMs,
      compStartMs: coverDurationMs + 200,
      compEndMs: coverDurationMs + Math.max(1500, masterIntroDurationMs - 200),
      audioDurationMs: Math.round(masterAudioDurSec * 1000),
      autoHoldMs: 0,
      extraHoldMs: 0,
      effectiveDeltaMs: 0,
      playbackRate: 1.0,
      audioFile: fs.existsSync(masterAudioMp3Path)
        ? `narration/${targetSlug}/${masterAudioFileName}`
        : undefined,
    },
  ];
  let firstBaseUrl = "";

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
              const dstMergedAudio = path.join(mergedAudioDir, newFileName);
              try {
                if (fs.existsSync(dstMergedAudio)) fs.unlinkSync(dstMergedAudio);
              } catch {}
              // 챕터 시나리오와 병합 시나리오 간에는 독립 복사본을 두어 원본 챕터 대본 수정 시 병합본이 변조되지 않도록 보호하고,
              // 병합 시나리오 내부(data/<targetSlug>/audio <-> public/narration/<targetSlug>)만 하드링크로 연결합니다.
              fs.copyFileSync(srcAudio, dstMergedAudio);
              linkOrCopyFileSafe(dstMergedAudio, path.join(publicNarrationDir, newFileName));
              newAudioFile = `narration/${targetSlug}/${newFileName}`;
            } catch {}
          }
        }

        combinedCues.push({
          ...cue,
          id: combinedCues.length + 1,
          isIntro: Boolean(cue.isIntro),
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

    // 다음 챕터로 넘어갈 때 어떤 메뉴에 대해 안내할지 브릿지 오프닝 대본 자동 생성 및 TTS 합성
    if (chapterIdx < sourceFiles.length - 1) {
      const nextLabel =
        shortModuleLabels[chapterIdx + 1] ||
        chapterShortNames[chapterIdx + 1] ||
        rawSlugs[chapterIdx + 1];
      const bridgeText = `${nextLabel} 사용법에 대해 알아보겠습니다.`;
      const bridgeAudioFileName = `ch${chapterIdx + 1}_99_bridge_next.mp3`;
      const bridgeAudioMp3Path = path.join(mergedAudioDir, bridgeAudioFileName);
      const publicBridgeAudioPath = path.join(publicNarrationDir, bridgeAudioFileName);

      try {
        spawnSync(
          "python",
          [
            "-m",
            "edge_tts",
            "--voice",
            voice,
            `--rate=${rate}`,
            `--pitch=${pitch}`,
            "--text",
            bridgeText,
            "--write-media",
            bridgeAudioMp3Path,
          ],
          { cwd: ROOT_DIR, encoding: "utf-8", timeout: 25000 }
        );
        if (fs.existsSync(bridgeAudioMp3Path)) {
          fs.copyFileSync(bridgeAudioMp3Path, publicBridgeAudioPath);
        }
      } catch (bErr) {
        console.warn(`[Bridge TTS] 챕터 ${chapterIdx + 1} 전환 대본 음성 합성 경고:`, bErr);
      }

      const bridgeAudioDurSec = fs.existsSync(bridgeAudioMp3Path)
        ? probeVideoDurationSec(bridgeAudioMp3Path) || 3.4
        : 3.4;
      const bridgeAudioDurMs = Math.round(bridgeAudioDurSec * 1000);
      const prevCue = combinedCues[combinedCues.length - 1];
      const prevVoiceEndMs = prevCue
        ? Number(prevCue.videoStartMs || 0) + Number(prevCue.audioDurationMs || 0)
        : cumulativeMs;
      const chapterEndMs = cumulativeMs + chDurMs;
      const bridgeStartMs = Math.min(
        chapterEndMs - 300,
        Math.max(prevVoiceEndMs + 100, chapterEndMs - 600)
      );

      combinedCues.push({
        id: combinedCues.length + 1,
        isIntro: false,
        text: bridgeText,
        startMs: bridgeStartMs,
        endMs: bridgeStartMs + bridgeAudioDurMs,
        videoStartMs: bridgeStartMs,
        videoEndMs: chapterEndMs,
        compStartMs: bridgeStartMs,
        compEndMs: bridgeStartMs + bridgeAudioDurMs,
        audioDurationMs: bridgeAudioDurMs,
        autoHoldMs: Math.max(0, bridgeAudioDurMs - Math.max(200, chapterEndMs - bridgeStartMs) + 180),
        extraHoldMs: 0,
         _isAutoBridgeCue: true,
        audioFile: fs.existsSync(bridgeAudioMp3Path)
          ? `narration/${targetSlug}/${bridgeAudioFileName}`
          : undefined,
      });
    }

    cumulativeMs += chDurMs;
    cumulativeFrames += chDurFrames;
  });

  const actualTotalDurSec = probeVideoDurationSec(outMp4Path) || Number((cumulativeMs / 1000).toFixed(3));
  const actualTotalMs = Math.round(actualTotalDurSec * 1000);
  const actualTotalFrames = Math.max(60, Math.round(actualTotalDurSec * fps));

  const mergedBrowsePlan = {
    baseUrl: firstBaseUrl || "",
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
          slug: targetSlug,
          enabled: true,
          showSubtitles: true,
          showIntroToc: true,
          introToc: masterToc,
          siteBrand,
          introBakedIntoVideo: true,
          bakedIntroDurationMs: totalFrontIntroMs,
          mergedFromSlugs: rawSlugs,
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
      path.join(mergedDataDir, "merged.orig.json"),
      JSON.stringify(
        {
          mergedFromSlugs: rawSlugs,
          totalFrontIntroMs,
          cues: combinedCues.filter((c) => !c._isAutoBridgeCue),
        },
        null,
        2
      ),
      "utf-8"
    );
    saveNarrationFile(targetSlug, mergedNarration as any);
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
    ...(mergedNarration ? { narration: getNarration(targetSlug) || mergedNarration } : {}),
  };
  fs.writeFileSync(
    path.join(mergedDataDir, "edit-plan.json"),
    JSON.stringify(mergedEditPlan, null, 2),
    "utf-8"
  );

  if (mergedNarration) {
    try {
      await fastApplyNarrationToRenderedMp4(targetSlug);
    } catch (applyErr) {
      console.warn(`[Merge] 챕터 전환 브릿지 대본 영상 합성 경고:`, applyErr);
    }
  }

  const finalDurSec = probeVideoDurationSec(outMp4Path) || actualTotalDurSec;
  const stat = fs.statSync(outMp4Path);

  return {
    success: true,
    outputSlug: targetSlug,
    mergedSlugs: rawSlugs,
    totalDurationSec: finalDurSec,
    fileSizeBytes: stat.size,
    videoUrl: `/api/rendered-video/${targetSlug}`,
    downloadUrl: `/api/download/${targetSlug}`,
    usedFastCopy,
  };
}

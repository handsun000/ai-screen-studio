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

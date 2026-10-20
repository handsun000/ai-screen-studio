"""
Calibrate moments.json timestamps to the exact video timeline of recording.mp4,
and ensure recording.mp4 is encoded as a Constant Frame Rate (CFR 30fps) H.264 MP4.

Why this exists:
1. Playwright's recordVideo outputs a variable-frame-rate (VFR) VP8 WebM file and starts its
   t=0 clock only when the browser compositor emits the first screencast frame (often 100ms-1,000ms
   after Date.now() in scripts/record.ts).
2. Seeking VFR VP8 WebM files in Remotion's <OffthreadVideo> causes frame drift and keyframe
   snapping errors.
3. This script:
   - Transcodes VFR WebM/MP4 files into genuine CFR 30fps H.264 MP4 with 1-second GOP (-g 30).
   - Detects the exact frame onset of the DOM click ripple (__demo_click_visualizer__) around
     each click/type moment in recording.mp4.
   - Shifts and snaps moment timestamps in moments.json so SyntheticCursor clicks on the exact
     frame the click occurs in the video.
   - Updates metadata.totalDurationMs to match the exact video duration and rebuilds edit-plan.json.

Usage:
    python scripts/calibrate-moments.py <slug> [--force]
    python scripts/calibrate-moments.py --all [--force]
"""

import sys
import json
import shutil
import statistics
import subprocess
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT_DIR / "data"


def get_video_info(mp4_path: Path):
    cmd = [
        "ffprobe",
        "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "format=duration,format_name:stream=codec_name,r_frame_rate,avg_frame_rate",
        "-of", "json",
        str(mp4_path),
    ]
    out = subprocess.check_output(cmd)
    info = json.loads(out)
    stream = (info.get("streams") or [{}])[0]
    fmt = info.get("format") or {}
    duration_sec = float(fmt.get("duration") or 0.0)
    codec = stream.get("codec_name", "")
    fmt_name = fmt.get("format_name", "")
    r_fps = stream.get("r_frame_rate", "")
    avg_fps = stream.get("avg_frame_rate", "")
    return {
        "duration_ms": int(round(duration_sec * 1000)),
        "codec": codec,
        "format_name": fmt_name,
        "r_frame_rate": r_fps,
        "avg_frame_rate": avg_fps,
    }


def ensure_cfr_h264_mp4(mp4_path: Path) -> dict:
    info = get_video_info(mp4_path)
    is_genuine_mp4 = (
        info["codec"] == "h264"
        and "webm" not in info["format_name"].lower()
        and info["r_frame_rate"] in ("30/1", "60/1")
    )
    if is_genuine_mp4:
        return info

    tmp_out = mp4_path.with_name("recording_cfr_tmp.mp4")
    print(f"  [CFR 변환] {mp4_path.parent.name}/recording.mp4 ({info['codec']} / {info['format_name']}) -> CFR 30fps H.264 MP4 변환 중...")
    cmd = [
        "ffmpeg",
        "-y",
        "-v", "error",
        "-i", str(mp4_path),
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", "18",
        "-vf", "fps=30",
        "-pix_fmt", "yuv420p",
        "-g", "30",
        "-movflags", "+faststart",
        str(tmp_out),
    ]
    subprocess.check_call(cmd)
    shutil.move(str(tmp_out), str(mp4_path))
    return get_video_info(mp4_path)


def detect_ripple_diff_ms(mp4_path: Path, cx: int, cy: int, ts_ms: int, video_duration_ms: int):
    if ts_ms <= 0 or ts_ms > video_duration_ms + 2500:
        return None, 0

    start_s = max(0.0, (ts_ms - 1800) / 1000.0)
    x1 = max(0, min(1920 - 32, int(cx) - 16))
    y1 = max(0, min(1080 - 32, int(cy) - 16))

    cmd = [
        "ffmpeg",
        "-v", "error",
        "-ss", f"{start_s:.3f}",
        "-i", str(mp4_path),
        "-t", "2.4",
        "-vf", f"fps=30,crop=32:32:{x1}:{y1}",
        "-f", "rawvideo",
        "-pix_fmt", "rgb24",
        "-",
    ]
    try:
        raw = subprocess.check_output(cmd)
    except Exception:
        return None, 0

    frame_sz = 32 * 32 * 3
    n_frames = len(raw) // frame_sz
    if n_frames < 5:
        return None, 0

    best_f = 0
    best_score = -1
    scores = [0] * n_frames

    for f in range(3, n_frames):
        chunk = raw[f * frame_sz : (f + 1) * frame_sz]
        prev = raw[(f - 3) * frame_sz : (f - 2) * frame_sz]
        blue_hits = 0
        max_db = 0
        for p in range(0, frame_sz, 3):
            r, g, b = chunk[p], chunk[p + 1], chunk[p + 2]
            pr, pg, pb = prev[p], prev[p + 1], prev[p + 2]
            if b >= 165 and (b - r) >= 40 and b > g:
                db = (b - r) - (pb - pr)
                if db >= 25:
                    blue_hits += 1
                    if db > max_db:
                        max_db = db
        score = max_db + blue_hits * 2
        scores[f] = score
        if score > best_score:
            best_score = score
            best_f = f

    if best_score < 120:
        return None, best_score

    onset_f = best_f
    while onset_f > 1 and scores[onset_f - 1] >= max(60, best_score * 0.45):
        onset_f -= 1

    ripple_ms = int(round(start_s * 1000 + onset_f * (1000.0 / 30.0)))
    return ripple_ms - ts_ms, best_score


def calibrate_scenario(slug: str, force: bool = False) -> bool:
    s_dir = DATA_DIR / slug
    mp4_path = s_dir / "recording.mp4"
    mom_path = s_dir / "moments.json"

    if not mp4_path.exists() or not mom_path.exists():
        return False

    info = ensure_cfr_h264_mp4(mp4_path)
    vid_ms = info["duration_ms"]
    if vid_ms <= 0:
        return False

    mdata = json.loads(mom_path.read_text(encoding="utf-8"))
    meta = mdata.get("metadata", {})
    moments = mdata.get("moments", [])

    already_calibrated = (
        not force
        and meta.get("calibratedToVideoDurationMs") == vid_ms
        and meta.get("totalDurationMs") == vid_ms
    )

    if not already_calibrated and moments:
        detected = {}
        valid_diffs = []
        for idx, m in enumerate(moments):
            if m.get("type") in ("click", "dblclick", "type") and m.get("cursor"):
                cx = m["cursor"].get("x", 0)
                cy = m["cursor"].get("y", 0)
                ts = m.get("timestamp", 0)
                if cx > 0 and cy > 0 and ts > 0:
                    diff_ms, score = detect_ripple_diff_ms(mp4_path, cx, cy, ts, vid_ms)
                    if diff_ms is not None and -2000 <= diff_ms <= 600:
                        detected[idx] = (diff_ms, score)
                        valid_diffs.append(diff_ms)

        median_diff = int(round(statistics.median(valid_diffs))) if len(valid_diffs) >= 2 else 0

        # Filter inliers within 160ms of median_diff to compute a rock-solid global offset
        inliers = [d for d in valid_diffs if abs(d - median_diff) <= 160]
        if inliers:
            median_diff = int(round(statistics.median(inliers)))

        # Apply calibration only when at least 3 click ripples consistently agree on the offset
        if len(inliers) >= 3 and (abs(median_diff) >= 25 or len(inliers) >= 5):
            print(f"  [Sync 보정] {slug}: 비디오 길이={vid_ms}ms (기존={meta.get('totalDurationMs')}ms), 중앙 오프셋={median_diff:+d}ms ({len(inliers)}/{len(valid_diffs)} 클릭 매칭)")
            prev_ts = 0
            for idx, m in enumerate(moments):
                orig_ts = int(round(m.get("timestamp", 0)))
                if orig_ts <= 0:
                    continue
                shift = median_diff
                if idx in detected:
                    d_ms, _sc = detected[idx]
                    if abs(d_ms - median_diff) <= 150:
                        shift = d_ms
                new_ts = max(prev_ts + 33, min(vid_ms, orig_ts + shift))
                m["timestamp"] = new_ts
                prev_ts = new_ts
        else:
            # Clamp any overflow timestamps to video duration
            for m in moments:
                if m.get("timestamp", 0) > vid_ms:
                    m["timestamp"] = vid_ms

        meta["totalDurationMs"] = vid_ms
        meta["calibratedToVideoDurationMs"] = vid_ms
        mdata["metadata"] = meta
        mom_path.write_text(json.dumps(mdata, indent=2, ensure_ascii=False), encoding="utf-8")

    # Always rebuild edit-plan.json with the improved segment generator
    subprocess.check_call(
        [sys.executable, str(ROOT_DIR / "scripts" / "build-edit-plan.py"), slug, "--keep-last"]
    )
    return True


def main():
    if len(sys.argv) < 2:
        print("Usage: python scripts/calibrate-moments.py <slug|--all> [--force]")
        sys.exit(1)

    force = "--force" in sys.argv
    target = sys.argv[1]

    if target == "--all":
        count = 0
        for d in sorted(DATA_DIR.iterdir()):
            if d.is_dir() and (d / "recording.mp4").exists() and (d / "moments.json").exists():
                if calibrate_scenario(d.name, force=force):
                    count += 1
        print(f"\n[OK] 총 {count}개 시나리오의 CFR H.264 비디오 변환, 타임스탬프 프레임 동기화 및 edit-plan 재생성을 완료했습니다.")
    else:
        raw_slug = target.rstrip("/\\")
        slug = Path(raw_slug).name if ("/" in raw_slug or "\\" in raw_slug) else raw_slug
        calibrate_scenario(slug, force=force)


if __name__ == "__main__":
    main()

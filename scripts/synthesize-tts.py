"""
Synthesize Korean Neural TTS audio clips for a scenario's narration.json using edge-tts.

- Generates MP3 files in data/<slug>/audio/cue-XX.mp3 at the exact user-selected speaking rate
  (NEVER artificially speeds up the voice when a script is long!)
- Copies MP3 files to public/narration/<slug>/cue-XX.mp3 for Remotion staticFile()
- Measures exact MP3 duration via ffprobe and computes frame-accurate video timeRegions
  (automatic hold for long scripts + manual extraHoldMs stretch/shrink) so narration,
  video frames, camera zoom, and cursor movements stay 100% synchronized.
- Syncs updated narration metadata and timeRegions into data/<slug>/narration.json and data/<slug>/edit-plan.json

Usage:
    python scripts/synthesize-tts.py <slug> [--voice ko-KR-SunHiNeural] [--rate +5%] [--pitch +0Hz]
"""

import asyncio
import json
import shutil
import subprocess
import sys
from pathlib import Path

import edge_tts

ROOT_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT_DIR / "data"
PUBLIC_DIR = ROOT_DIR / "public"


def get_audio_duration_ms(mp3_path: Path) -> int:
    try:
        res = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                str(mp3_path),
            ],
            capture_output=True,
            text=True,
            timeout=10,
        )
        val = float((res.stdout or "").strip())
        if val > 0:
            return round(val * 1000)
    except Exception:
        pass
    return 2000


async def synthesize_single_cue(text: str, voice: str, rate: str, pitch: str, out_path: Path):
    communicate = edge_tts.Communicate(text=text, voice=voice, rate=rate, pitch=pitch)
    await communicate.save(str(out_path))


def compute_time_regions_and_sync_cues(cues: list[dict], raw_total_ms: int, fps: int = 60) -> tuple[list[dict], int, int]:
    raw_total_ms = max(1000, int(round(raw_total_ms)))
    raw_total_frames = max(1, int(round((raw_total_ms / 1000.0) * fps)))

    if not cues:
        default_regions = [
            {
                "videoStartFrame": 0,
                "videoEndFrame": raw_total_frames,
                "compStartFrame": 0,
                "compEndFrame": raw_total_frames,
                "speed": 1.0,
            }
        ]
        return default_regions, raw_total_frames, raw_total_frames

    # 1. Ensure each cue has a raw video anchor (videoStartMs)
    for cue in cues:
        v_start = cue.get("videoStartMs")
        if v_start is None:
            v_start = cue.get("startMs", 0)
        cue["videoStartMs"] = max(0, min(raw_total_ms - 150, int(round(v_start))))
        cue["extraHoldMs"] = int(round(cue.get("extraHoldMs") or 0))

    cues.sort(key=lambda c: c.get("videoStartMs", 0))
    min_v = 0
    for idx, cue in enumerate(cues):
        cue["id"] = idx + 1
        if cue["videoStartMs"] < min_v:
            cue["videoStartMs"] = min(raw_total_ms - 100, min_v)
        min_v = cue["videoStartMs"] + 100

    def ms_to_raw_f(ms: int) -> int:
        return max(0, min(raw_total_frames, int(round((ms / 1000.0) * fps))))

    time_regions: list[dict] = []
    comp_cursor_f = 0

    first_v_f = ms_to_raw_f(cues[0]["videoStartMs"])
    if first_v_f > 0:
        time_regions.append(
            {
                "videoStartFrame": 0,
                "videoEndFrame": first_v_f,
                "compStartFrame": 0,
                "compEndFrame": first_v_f,
                "speed": 1.0,
            }
        )
        comp_cursor_f = first_v_f

    n_cues = len(cues)
    for i, cue in enumerate(cues):
        v_start_ms = cue["videoStartMs"]
        v_end_ms = cues[i + 1]["videoStartMs"] if (i + 1 < n_cues) else max(v_start_ms + 200, raw_total_ms)
        v_end_ms = max(v_start_ms + 100, v_end_ms)
        cue["videoEndMs"] = v_end_ms

        raw_gap_ms = max(100, v_end_ms - v_start_ms)
        audio_dur_ms = int(round(cue.get("audioDurationMs") or 0))
        speech_pad_ms = 260 if (i == n_cues - 1) else 180
        min_speech_window_ms = (audio_dur_ms + speech_pad_ms) if audio_dur_ms > 0 else 400

        auto_hold_ms = max(0, min_speech_window_ms - raw_gap_ms)
        extra_hold_ms = int(round(cue.get("extraHoldMs") or 0))

        base_window_ms = max(raw_gap_ms, min_speech_window_ms)
        min_allowed_window_ms = max(min_speech_window_ms, max(300, int(round(raw_gap_ms * 0.25))))
        comp_gap_ms = max(min_allowed_window_ms, base_window_ms + extra_hold_ms)
        effective_delta_ms = comp_gap_ms - raw_gap_ms

        cue["autoHoldMs"] = auto_hold_ms
        cue["extraHoldMs"] = extra_hold_ms
        cue["effectiveDeltaMs"] = effective_delta_ms
        cue["playbackRate"] = 1.0

        v_start_f = ms_to_raw_f(v_start_ms)
        v_end_f = raw_total_frames if (i == n_cues - 1) else ms_to_raw_f(v_end_ms)
        if v_end_f <= v_start_f:
            v_end_f = min(raw_total_frames, v_start_f + 1)

        raw_frames = max(1, v_end_f - v_start_f)
        comp_frames = max(1, int(round((comp_gap_ms / 1000.0) * fps)))
        delta_frames = comp_frames - raw_frames

        cue["startMs"] = int(round((comp_cursor_f / float(fps)) * 1000.0))
        cue_dur_for_sub = audio_dur_ms if audio_dur_ms > 0 else min(comp_gap_ms, 2500)
        cue["endMs"] = cue["startMs"] + cue_dur_for_sub

        if abs(delta_frames) <= 1:
            speed = round(float(raw_frames) / float(comp_frames), 5)
            time_regions.append(
                {
                    "videoStartFrame": v_start_f,
                    "videoEndFrame": v_end_f,
                    "compStartFrame": comp_cursor_f,
                    "compEndFrame": comp_cursor_f + comp_frames,
                    "speed": speed,
                    "cueId": cue["id"],
                }
            )
        elif delta_frames > 1:
            is_intro = bool(cue.get("isIntro") or (i == 0 and v_start_ms <= 600))
            hold_raw_f = (
                1
                if is_intro
                else min(max(2, int(round(0.08 * fps))), max(1, raw_frames // 4))
            )
            if is_intro:
                hold_v_start = v_start_f
                hold_v_end = min(v_end_f, v_start_f + hold_raw_f)
            else:
                tail_glide_f = min(int(round(0.45 * fps)), max(0, raw_frames - hold_raw_f - 2))
                hold_v_end = v_end_f - tail_glide_f
                hold_v_start = max(v_start_f, hold_v_end - hold_raw_f)

            pre_raw_f = hold_v_start - v_start_f
            act_hold_raw_f = max(1, hold_v_end - hold_v_start)
            post_raw_f = v_end_f - hold_v_end
            hold_comp_f = act_hold_raw_f + delta_frames
            c_cur = comp_cursor_f

            if pre_raw_f > 0:
                time_regions.append(
                    {
                        "videoStartFrame": v_start_f,
                        "videoEndFrame": hold_v_start,
                        "compStartFrame": c_cur,
                        "compEndFrame": c_cur + pre_raw_f,
                        "speed": 1.0,
                        "cueId": cue["id"],
                    }
                )
                c_cur += pre_raw_f

            time_regions.append(
                {
                    "videoStartFrame": hold_v_start,
                    "videoEndFrame": hold_v_end,
                    "compStartFrame": c_cur,
                    "compEndFrame": c_cur + hold_comp_f,
                    "speed": round(float(act_hold_raw_f) / float(hold_comp_f), 5),
                    "cueId": cue["id"],
                }
            )
            c_cur += hold_comp_f

            if post_raw_f > 0:
                time_regions.append(
                    {
                        "videoStartFrame": hold_v_end,
                        "videoEndFrame": v_end_f,
                        "compStartFrame": c_cur,
                        "compEndFrame": c_cur + post_raw_f,
                        "speed": 1.0,
                        "cueId": cue["id"],
                    }
                )
                c_cur += post_raw_f
        else:
            speed = round(float(raw_frames) / float(comp_frames), 5)
            time_regions.append(
                {
                    "videoStartFrame": v_start_f,
                    "videoEndFrame": v_end_f,
                    "compStartFrame": comp_cursor_f,
                    "compEndFrame": comp_cursor_f + comp_frames,
                    "speed": speed,
                    "cueId": cue["id"],
                }
            )

        comp_cursor_f += comp_frames

    total_comp_frames = max(1, comp_cursor_f)
    return time_regions, total_comp_frames, raw_total_frames


async def process_narration(
    slug: str,
    override_voice: str | None = None,
    override_rate: str | None = None,
    override_pitch: str | None = None,
):
    scenario_dir = DATA_DIR / slug
    narration_path = scenario_dir / "narration.json"
    if not narration_path.exists():
        print(f"[TTS] narration.json not found for '{slug}'")
        return False

    with open(narration_path, encoding="utf-8") as f:
        narration = json.load(f)

    voice = override_voice or narration.get("voice") or "ko-KR-SunHiNeural"
    base_rate = override_rate or narration.get("rate") or "+5%"
    base_pitch = override_pitch or narration.get("pitch") or "+0Hz"

    narration["voice"] = voice
    narration["rate"] = base_rate
    narration["pitch"] = base_pitch

    cues = narration.get("cues") or []
    audio_dir = scenario_dir / "audio"
    public_audio_dir = PUBLIC_DIR / "narration" / slug
    audio_dir.mkdir(parents=True, exist_ok=True)
    public_audio_dir.mkdir(parents=True, exist_ok=True)

    # Sort cues by videoStartMs (or startMs if videoStartMs is not set yet)
    for cue in cues:
        if cue.get("videoStartMs") is None:
            cue["videoStartMs"] = cue.get("startMs", 0)
    cues.sort(key=lambda c: c.get("videoStartMs", 0))
    for idx, cue in enumerate(cues):
        cue["id"] = idx + 1

    # Synthesize cues at the exact user-selected base_rate & base_pitch (never artificially sped up!)
    # Smart incremental TTS: reuse existing MP3 when text, voice, rate, pitch, and cue slot are unchanged
    tasks = []
    cue_paths: list[tuple[dict, Path, bool]] = []
    for cue in cues:
        text = (cue.get("text") or "").strip()
        if not text:
            continue
        mp3_name = f"cue-{cue['id']:02d}.mp3"
        mp3_path = audio_dir / mp3_name
        rel_public = f"narration/{slug}/{mp3_name}"
        tts_sig = f"{voice}|{base_rate}|{base_pitch}|{text}"
        can_reuse = (
            mp3_path.exists()
            and mp3_path.stat().st_size > 100
            and cue.get("audioFile") == rel_public
            and bool(cue.get("audioDurationMs"))
            and (cue.get("_ttsSig") is None or cue.get("_ttsSig") == tts_sig)
        )
        cue["_ttsSig"] = tts_sig
        cue_paths.append((cue, mp3_path, not can_reuse))
        if not can_reuse:
            tasks.append(synthesize_single_cue(text, voice, base_rate, base_pitch, mp3_path))

    if tasks:
        await asyncio.gather(*tasks)

    for cue, mp3_path, was_synthesized in cue_paths:
        dur_ms = get_audio_duration_ms(mp3_path) if was_synthesized or not cue.get("audioDurationMs") else int(cue["audioDurationMs"])
        cue["audioDurationMs"] = dur_ms
        cue["playbackRate"] = 1.0
        rel_public = f"narration/{slug}/{mp3_path.name}"
        pub_target = public_audio_dir / mp3_path.name
        if was_synthesized or not pub_target.exists():
            shutil.copy2(mp3_path, pub_target)
        cue["audioFile"] = rel_public

    # Determine raw video duration from moments.json or edit-plan.json
    raw_total_ms = 15000
    fps = 60
    moments_path = scenario_dir / "moments.json"
    edit_plan_path = scenario_dir / "edit-plan.json"
    edit_plan = None

    if edit_plan_path.exists():
        try:
            with open(edit_plan_path, encoding="utf-8") as ef:
                edit_plan = json.load(ef)
            fps = int(edit_plan.get("fps") or 60)
            raw_frames = edit_plan.get("rawDurationFrames") or edit_plan.get("totalDurationFrames")
            if raw_frames:
                raw_total_ms = int(round((float(raw_frames) / float(fps)) * 1000.0))
        except Exception:
            pass

    if moments_path.exists():
        try:
            with open(moments_path, encoding="utf-8") as mf:
                m_data = json.load(mf)
            m_dur = (m_data.get("metadata") or {}).get("totalDurationMs")
            if m_dur and int(m_dur) > 0:
                raw_total_ms = int(m_dur)
        except Exception:
            pass

    time_regions, total_comp_frames, raw_total_frames = compute_time_regions_and_sync_cues(
        cues, raw_total_ms, fps
    )

    with open(narration_path, "w", encoding="utf-8") as f:
        json.dump(narration, f, indent=2, ensure_ascii=False)

    # Also embed synced narration & timeRegions into edit-plan.json so Remotion gets updated timeline immediately
    if edit_plan is not None:
        try:
            edit_plan["rawDurationFrames"] = raw_total_frames
            edit_plan["totalDurationFrames"] = total_comp_frames
            edit_plan["timeRegions"] = time_regions
            edit_plan["narration"] = narration
            with open(edit_plan_path, "w", encoding="utf-8") as ef:
                json.dump(edit_plan, ef, indent=2, ensure_ascii=False)
        except Exception as e:
            print(f"[TTS] Warning updating edit-plan.json: {e}")

    stretch_sec = (total_comp_frames - raw_total_frames) / float(fps)
    print(
        f"[TTS] Synthesized {len(cue_paths)} cues for '{slug}' "
        f"(voice={voice}, rate={base_rate}, pitch={base_pitch}, "
        f"raw={raw_total_frames / fps:.1f}s -> synced={total_comp_frames / fps:.1f}s, delta={stretch_sec:+.1f}s)"
    )
    return True


def main():
    if len(sys.argv) < 2:
        print("Usage: python scripts/synthesize-tts.py <slug> [--voice ko-KR-SunHiNeural] [--rate +5%] [--pitch +0Hz]")
        sys.exit(1)

    slug = sys.argv[1].strip()
    voice = None
    rate = None
    pitch = None
    for i, arg in enumerate(sys.argv):
        if arg == "--voice" and i + 1 < len(sys.argv):
            voice = sys.argv[i + 1]
        elif arg == "--rate" and i + 1 < len(sys.argv):
            rate = sys.argv[i + 1]
        elif arg == "--pitch" and i + 1 < len(sys.argv):
            pitch = sys.argv[i + 1]

    ok = asyncio.run(process_narration(slug, voice, rate, pitch))
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()

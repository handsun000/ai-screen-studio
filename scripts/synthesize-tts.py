"""
Synthesize Korean Neural TTS audio clips for a scenario's narration.json using edge-tts.

- Generates MP3 files in data/<slug>/audio/cue-XX.mp3
- Copies MP3 files to public/narration/<slug>/cue-XX.mp3 for Remotion staticFile()
- Measures exact MP3 duration via ffprobe and automatically adjusts speaking rate if a cue
  would overlap the next cue's startMs
- Syncs updated narration metadata into data/<slug>/narration.json and data/<slug>/edit-plan.json

Usage:
    python scripts/synthesize-tts.py <slug> [--voice ko-KR-SunHiNeural] [--rate +5%]
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


def parse_rate_percent(rate_str: str) -> int:
    try:
        cleaned = rate_str.strip().replace("%", "").replace("+", "")
        return int(cleaned)
    except Exception:
        return 5


async def synthesize_single_cue(text: str, voice: str, rate: str, pitch: str, out_path: Path):
    communicate = edge_tts.Communicate(text=text, voice=voice, rate=rate, pitch=pitch)
    await communicate.save(str(out_path))


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
    base_rate_num = parse_rate_percent(base_rate)

    narration["voice"] = voice
    narration["rate"] = base_rate
    narration["pitch"] = base_pitch

    cues = narration.get("cues") or []
    audio_dir = scenario_dir / "audio"
    public_audio_dir = PUBLIC_DIR / "narration" / slug
    audio_dir.mkdir(parents=True, exist_ok=True)
    public_audio_dir.mkdir(parents=True, exist_ok=True)

    # Sort cues by startMs
    cues.sort(key=lambda c: c.get("startMs", 0))
    for idx, cue in enumerate(cues):
        cue["id"] = idx + 1

    # Pass 1: Synthesize all cues in parallel at base_rate & base_pitch
    tasks = []
    cue_paths: list[tuple[dict, Path]] = []
    for cue in cues:
        text = (cue.get("text") or "").strip()
        if not text:
            continue
        mp3_name = f"cue-{cue['id']:02d}.mp3"
        mp3_path = audio_dir / mp3_name
        cue_paths.append((cue, mp3_path))
        tasks.append(synthesize_single_cue(text, voice, base_rate, base_pitch, mp3_path))

    if tasks:
        await asyncio.gather(*tasks)

    # Pass 2: Check durations and prevent overlap with subsequent cues
    re_synth_tasks = []
    for i, (cue, mp3_path) in enumerate(cue_paths):
        dur_ms = get_audio_duration_ms(mp3_path)
        cue["audioDurationMs"] = dur_ms
        cue["playbackRate"] = 1.0

        if i + 1 < len(cue_paths):
            next_cue = cue_paths[i + 1][0]
            available_ms = max(600, next_cue["startMs"] - cue["startMs"] - 120)
            if dur_ms > available_ms:
                ratio = dur_ms / available_ms
                # Re-synthesize faster (up to +35%) so speech fits naturally inside its window
                boost_pct = min(35, max(base_rate_num + 10, round((ratio - 1.0) * 100 + base_rate_num + 5)))
                faster_rate = f"+{boost_pct}%"
                re_synth_tasks.append((cue, mp3_path, faster_rate, available_ms))

    if re_synth_tasks:
        await asyncio.gather(
            *[
                synthesize_single_cue(cue["text"].strip(), voice, faster_rate, base_pitch, mp3_path)
                for (cue, mp3_path, faster_rate, _) in re_synth_tasks
            ]
        )
        for cue, mp3_path, _, available_ms in re_synth_tasks:
            dur_ms = get_audio_duration_ms(mp3_path)
            cue["audioDurationMs"] = dur_ms

    # Finalize startMs / endMs so no two audio clips overlap even if a sentence is still long
    cursor_ms = 0
    for cue, mp3_path in cue_paths:
        if cue["startMs"] < cursor_ms:
            cue["startMs"] = cursor_ms
        dur_ms = cue.get("audioDurationMs") or 2000
        cue["endMs"] = cue["startMs"] + dur_ms
        cursor_ms = cue["endMs"] + 100

        rel_public = f"narration/{slug}/{mp3_path.name}"
        shutil.copy2(mp3_path, public_audio_dir / mp3_path.name)
        cue["audioFile"] = rel_public

    with open(narration_path, "w", encoding="utf-8") as f:
        json.dump(narration, f, indent=2, ensure_ascii=False)

    # Also embed into edit-plan.json so Remotion gets updated narration immediately
    edit_plan_path = scenario_dir / "edit-plan.json"
    if edit_plan_path.exists():
        try:
            with open(edit_plan_path, encoding="utf-8") as ef:
                edit_plan = json.load(ef)
            edit_plan["narration"] = narration
            with open(edit_plan_path, "w", encoding="utf-8") as ef:
                json.dump(edit_plan, ef, indent=2, ensure_ascii=False)
        except Exception as e:
            print(f"[TTS] Warning updating edit-plan.json: {e}")

    print(f"[TTS] Synthesized {len(cue_paths)} cues for '{slug}' (voice={voice}, rate={base_rate}, pitch={base_pitch})")
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

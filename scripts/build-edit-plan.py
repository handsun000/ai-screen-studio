"""
Auto-generate an edit-plan.json from moments.json.

Applies the zoom rules we've established:
- Drags: no zoom (stay at default 1x so viewer sees full viewport)
- Clicks with stayedInArea=True in sequence: cluster into one zoom segment
  with zoomTargetEnd panning between first and last click
- Typing: zoom to cursor position from preceding click
- Isolated clicks (stayedInArea=False or no annotation): individual zoom segment
- Scrolls, keys: no zoom segments (they happen within existing context)
- Last click always dropped (OBS stop recording button)
- Exclude zones: rectangular regions where clicks get no zoom

Usage:
    python scripts/build-edit-plan.py <slug> [--fps 60] [--zoom 1.6] [--type-zoom 1.8]
           [--exclude x,y,w,h] [--exclude x,y,w,h] ...

Example:
    python scripts/build-edit-plan.py TSI-PlayerStart --exclude 400,50,150,60
"""

import sys
import json
from pathlib import Path

if len(sys.argv) < 2:
    print("Usage: python scripts/build-edit-plan.py <slug> [--fps 60] [--zoom 1.6] [--type-zoom 1.8] [--exclude x,y,w,h]")
    sys.exit(1)

raw_slug = sys.argv[1].rstrip("/\\")
if raw_slug.startswith("data/") or raw_slug.startswith("data\\"):
    slug = Path(raw_slug).name
else:
    slug = raw_slug

fps = 60
default_zoom = 1.18
type_zoom = 1.18
cluster_radius = 280  # px: cluster consecutive clicks within the same UI area
exclude_zones = []  # list of (x, y, w, h) rectangles

keep_last = "--keep-last" in sys.argv or True  # Always preserve final click in automated studio recordings
if "--drop-last" in sys.argv:
    keep_last = False

for i, arg in enumerate(sys.argv):
    if arg == "--fps" and i + 1 < len(sys.argv):
        fps = int(sys.argv[i + 1])
    if arg == "--zoom" and i + 1 < len(sys.argv):
        default_zoom = float(sys.argv[i + 1])
    if arg == "--type-zoom" and i + 1 < len(sys.argv):
        type_zoom = float(sys.argv[i + 1])
    if arg == "--exclude" and i + 1 < len(sys.argv):
        parts = sys.argv[i + 1].split(",")
        exclude_zones.append((int(parts[0]), int(parts[1]), int(parts[2]), int(parts[3])))

data_dir = Path(__file__).parent.parent / "data" / slug
moments_path = data_dir / "moments.json"

if not moments_path.exists():
    print(f"  ERROR: {moments_path} not found")
    sys.exit(1)

with open(moments_path, encoding="utf-8") as f:
    moments_data = json.load(f)

moments = list(moments_data["moments"])
metadata = moments_data["metadata"]
total_ms = metadata["totalDurationMs"]
total_frames = max(1, round(total_ms / 1000 * fps))


def ms_to_frame(ms):
    return max(0, min(total_frames, round(ms / 1000 * fps)))


def dist(a, b):
    return ((a["x"] - b["x"]) ** 2 + (a["y"] - b["y"]) ** 2) ** 0.5


def in_exclude_zone(cursor):
    """Check if a cursor position falls inside any exclude zone."""
    if not cursor:
        return False
    for (zx, zy, zw, zh) in exclude_zones:
        if zx <= cursor["x"] <= zx + zw and zy <= cursor["y"] <= zy + zh:
            return True
    return False


# Drop the last click only if explicitly requested via --drop-last (OBS mode)
if not keep_last:
    for idx in range(len(moments) - 1, -1, -1):
        if moments[idx]["type"] == "click":
            dropped = moments.pop(idx)
            print(f"  Dropped last click: id={dropped['id']} at ({dropped['cursor']['x']},{dropped['cursor']['y']}) (OBS stop button)")
            break

# Report exclude zones
if exclude_zones:
    excluded_count = 0
    for m in moments:
        if m["type"] == "click" and in_exclude_zone(m.get("cursor")):
            excluded_count += 1
            print(f"  Excluding click id={m['id']} at ({m['cursor']['x']},{m['cursor']['y']}) (in exclude zone)")
    print(f"  {excluded_count} click(s) in exclude zones (no zoom)")


def find_next_action_ms(start_idx):
    for k in range(start_idx, len(moments)):
        mk = moments[k]
        if mk["type"] in ("click", "dblclick", "upload", "type", "drag", "dragAndDrop", "scroll") and mk.get("cursor"):
            return mk["timestamp"]
    return None


# Step 1: Build individual action segments from moments so every click & typing location
# is accurately represented as a camera keyframe.
segments = []
i = 0
while i < len(moments):
    m = moments[i]

    # Skip drags, scrolls, key presses, waits (no zoom target override)
    if m["type"] in ("drag", "dragAndDrop", "scroll", "key", "wait", "navigate", "script", "scrape"):
        i += 1
        continue

    # Typing: extend preceding click on the same input field, or create a dedicated typing segment
    if m["type"] == "type":
        cursor = m.get("cursor")
        if cursor and not in_exclude_zone(cursor):
            type_start_ms = m["timestamp"]
            type_end_ms = m["timestamp"]
            all_keys = m.get("keys", "")
            while i + 1 < len(moments) and moments[i + 1]["type"] in ("type", "key"):
                i += 1
                type_end_ms = moments[i]["timestamp"]
                if moments[i].get("keys"):
                    all_keys += moments[i]["keys"]

            # Estimate actual typing completion time (40ms/char in record.ts + post-type hold)
            typing_duration_ms = max(800, len(all_keys) * 45 + 500)
            est_end_ms = type_end_ms + typing_duration_ms
            next_act_ms = find_next_action_ms(i + 1)
            if next_act_ms is not None:
                est_end_ms = min(est_end_ms, max(type_start_ms + 400, next_act_ms - 350))

            end_frame = ms_to_frame(est_end_ms)

            prev_seg = segments[-1] if segments else None
            prev_target = prev_seg.get("zoomTarget") if prev_seg else None
            same_input = (
                prev_seg is not None
                and prev_target is not None
                and dist(prev_target, cursor) <= 220
                and (ms_to_frame(type_start_ms) - prev_seg["endFrame"]) <= round(2.5 * fps)
            )
            if same_input:
                prev_seg["endFrame"] = max(prev_seg["endFrame"], end_frame)
                prev_seg["zoom"] = max(prev_seg["zoom"], type_zoom)
                prev_seg["description"] += f" + typing: {all_keys[:30]}"
            else:
                segments.append({
                    "momentId": m["id"],
                    "startFrame": ms_to_frame(type_start_ms),
                    "endFrame": max(ms_to_frame(type_start_ms) + round(0.4 * fps), end_frame),
                    "speed": 1.0,
                    "zoom": type_zoom,
                    "zoomTarget": cursor,
                    "easeInFrames": 18,
                    "easeOutFrames": 20,
                    "description": f"Typing: {all_keys[:30]}",
                })
        i += 1
        continue

    # Click / DblClick / Upload
    if m["type"] in ("click", "dblclick", "upload", "hover"):
        if m["type"] == "hover":
            # Hover is tracked by cursor; only create a zoom segment if isolated from clicks
            i += 1
            continue

        cursor = m.get("cursor")
        if not cursor or in_exclude_zone(cursor):
            i += 1
            continue

        cluster = [m]
        j = i + 1

        # Only cluster consecutive clicks if they are in the same UI neighborhood
        # and explicitly marked stayedInArea=True
        while j < len(moments):
            next_m = moments[j]
            if next_m["type"] in ("scroll", "key", "wait"):
                j += 1
                continue
            if next_m["type"] != "click":
                break
            next_cursor = next_m.get("cursor")
            if not next_cursor:
                break
            prev_click = cluster[-1]
            if prev_click.get("stayedInArea") is not True:
                break
            if dist(prev_click["cursor"], next_cursor) > cluster_radius:
                break
            cluster.append(next_m)
            j += 1

        first = cluster[0]
        last = cluster[-1]
        first_cursor = first["cursor"]

        if first.get("noZoom"):
            i = j
            continue

        HOLD_FRAMES = round(0.95 * fps)
        start_f = ms_to_frame(first["timestamp"])
        end_f = max(start_f + round(0.35 * fps), ms_to_frame(last["timestamp"]) + HOLD_FRAMES)

        xs = [c["cursor"]["x"] for c in cluster]
        ys = [c["cursor"]["y"] for c in cluster]
        center_cursor = {
            "x": round((min(xs) + max(xs)) / 2),
            "y": round((min(ys) + max(ys)) / 2),
        }

        seg = {
            "momentId": first["id"],
            "startFrame": start_f,
            "endFrame": end_f,
            "speed": 1.0,
            "zoom": default_zoom,
            "zoomTarget": center_cursor,
            "easeInFrames": 18,
            "easeOutFrames": 20,
            "description": f"Click cluster ({len(cluster)} clicks)" if len(cluster) > 1
                else f"Click at ({first_cursor['x']}, {first_cursor['y']})",
        }

        segments.append(seg)
        i = j
        continue

    i += 1


def in_central_deadzone(pos):
    return 480 <= pos["x"] <= 1440 and 330 <= pos["y"] <= 750


# Step 2: Group consecutive segments in the same visual region into calm, stationary tripod shots
# so the screen does not sway left/right on every individual mouse movement.
merged = []
for seg in sorted(segments, key=lambda s: s["startFrame"]):
    seg["_points"] = [dict(seg["zoomTarget"])]
    if not merged:
        merged.append(seg)
        continue

    prev = merged[-1]
    seg_pos = seg["zoomTarget"]
    gap_frames = seg["startFrame"] - prev["endFrame"]

    combined_pts = prev["_points"] + [seg_pos]
    min_x = min(p["x"] for p in combined_pts)
    max_x = max(p["x"] for p in combined_pts)
    min_y = min(p["y"] for p in combined_pts)
    max_y = max(p["y"] for p in combined_pts)

    both_central = all(in_central_deadzone(p) for p in combined_pts)
    same_region = (max_x - min_x) <= 520 and (max_y - min_y) <= 320

    if gap_frames <= round(5.5 * fps) and (both_central or same_region):
        # Same UI region or central modal workspace -> keep camera completely steady in one segment
        prev["endFrame"] = max(prev["endFrame"], seg["endFrame"])
        prev["_points"] = combined_pts
        prev["zoomTarget"] = {
            "x": round((min_x + max_x) / 2),
            "y": round((min_y + max_y) / 2),
        }
        prev["zoom"] = max(prev["zoom"], seg["zoom"])
        prev["description"] += f" + {seg['description']}"
    else:
        # Genuinely different screen region -> smooth camera transition
        min_hold = prev["startFrame"] + round(0.28 * fps)
        ideal_prev_end = seg["startFrame"] - round(0.45 * fps)
        if prev["endFrame"] > ideal_prev_end:
            prev["endFrame"] = max(min_hold, min(prev["endFrame"], seg["startFrame"] - 2, ideal_prev_end))
        merged.append(seg)

for seg in merged:
    seg.pop("_points", None)
    seg.pop("zoomTargetEnd", None)

# Extend the final segment slightly so the viewer can see the final state clearly
if merged:
    merged[-1]["endFrame"] = min(total_frames, merged[-1]["endFrame"] + round(0.5 * fps))

# Step 3: Output
edit_plan = {
    "totalDurationFrames": total_frames,
    "fps": fps,
    "defaultZoom": 1.0,
    "segments": merged,
}

if "cursor" in metadata and metadata["cursor"]:
    edit_plan["cursor"] = dict(metadata["cursor"])

narration_path = data_dir / "narration.json"
if narration_path.exists():
    try:
        with open(narration_path, encoding="utf-8") as nf:
            edit_plan["narration"] = json.load(nf)
    except Exception:
        pass

out_path = data_dir / "edit-plan.json"
with open(out_path, "w", encoding="utf-8") as f:
    json.dump(edit_plan, f, indent=2, ensure_ascii=False)

print(f"\n  Build Edit Plan")
print(f"  Slug: {slug}")
print(f"  Moments: {len(moments)}")
print(f"  Total frames: {total_frames} ({total_ms / 1000:.1f}s at {fps}fps)")
print(f"  Segments generated: {len(merged)}")
print()
for s in merged:
    target_end = f" -> ({s['zoomTargetEnd']['x']},{s['zoomTargetEnd']['y']})" if s.get("zoomTargetEnd") else ""
    print(f"    [{s['startFrame']:>5d}-{s['endFrame']:>5d}] {s['zoom']}x "
          f"@ ({s['zoomTarget']['x']},{s['zoomTarget']['y']}){target_end} "
          f"  {s['description']}")

print(f"\n  Wrote {out_path}")


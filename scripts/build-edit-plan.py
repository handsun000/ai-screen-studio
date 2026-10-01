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

slug = sys.argv[1]
fps = 60
default_zoom = 1.3
type_zoom = 1.4
cluster_radius = 300  # px, matches NEIGHBORHOOD_RADIUS in log-inputs.py
exclude_zones = []  # list of (x, y, w, h) rectangles

keep_last = "--keep-last" in sys.argv

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

moments = moments_data["moments"]
metadata = moments_data["metadata"]
total_ms = metadata["totalDurationMs"]
total_frames = round(total_ms / 1000 * fps)


def ms_to_frame(ms):
    return round(ms / 1000 * fps)


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


# Drop the last click only if OBS mode (not keep_last)
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

# Step 1: Build action groups from moments
# Group consecutive clicks that stayed in area into clusters.
# Attach typing moments to the preceding click.

segments = []
i = 0
while i < len(moments):
    m = moments[i]

    # Skip drags, scrolls, key presses (no zoom)
    if m["type"] in ("drag", "scroll", "key"):
        i += 1
        continue

    # Typing: extend the previous segment if it exists, otherwise create one
    if m["type"] == "type":
        cursor = m.get("cursor")
        if cursor and not in_exclude_zone(cursor):
            # Collect consecutive type moments
            type_end = m["timestamp"]
            all_keys = m.get("keys", "")
            while i + 1 < len(moments) and moments[i + 1]["type"] in ("type", "key"):
                i += 1
                type_end = moments[i]["timestamp"]
                if moments[i].get("keys"):
                    all_keys += moments[i]["keys"]

            end_frame = ms_to_frame(type_end) + ms_to_frame(1200)

            # Try to extend the previous click segment to cover typing
            prev_target = segments[-1]["zoomTarget"] if segments else None
            same_pos = (prev_target and
                        prev_target["x"] == cursor["x"] and
                        prev_target["y"] == cursor["y"])
            if segments and same_pos:
                segments[-1]["endFrame"] = end_frame
                segments[-1]["zoom"] = max(segments[-1]["zoom"], type_zoom)
                segments[-1]["description"] += f" + typing: {all_keys[:30]}"
            else:
                raw_start = ms_to_frame(m["timestamp"] - 600)
                start_frame = max(ms_to_frame(2000), raw_start) if m["timestamp"] >= 2000 else max(0, raw_start)
                segments.append({
                    "momentId": m["id"],
                    "startFrame": start_frame,
                    "endFrame": end_frame,
                    "speed": 1.0,
                    "zoom": type_zoom,
                    "zoomTarget": cursor,
                    "easeInFrames": 25,
                    "easeOutFrames": 25,
                    "description": f"Typing: {all_keys[:30]}",
                })
        i += 1
        continue

    # Click: check if part of a cluster
    if m["type"] == "click":
        cursor = m.get("cursor")
        if not cursor or in_exclude_zone(cursor):
            i += 1
            continue

        cluster = [m]
        j = i + 1

        # Look ahead for nearby clicks that stayed in area.
        # Stop at any non-click actionable moment (type, drag) so those
        # get processed by their own handlers.
        while j < len(moments):
            next_m = moments[j]

            # Skip scroll and key events (no zoom impact)
            if next_m["type"] in ("scroll", "key"):
                j += 1
                continue

            # Stop at typing, drags, or non-click events
            if next_m["type"] != "click":
                break

            next_cursor = next_m.get("cursor")
            if not next_cursor:
                break

            # Previous click must have stayedInArea=True to continue cluster.
            # Missing annotation or False both break the chain.
            prev_click = cluster[-1]
            if prev_click.get("stayedInArea") is not True:
                break

            # Check if this click is near the last click in the cluster
            prev_cursor = prev_click["cursor"]
            if dist(prev_cursor, next_cursor) > cluster_radius:
                break

            cluster.append(next_m)
            j += 1

        first = cluster[0]
        last = cluster[-1]
        first_cursor = first["cursor"]
        last_cursor = last["cursor"]

        # Give at least 2.0s of full-screen view before zooming
        raw_start = ms_to_frame(first["timestamp"] - 600)
        start_frame = max(ms_to_frame(2000), raw_start) if first["timestamp"] >= 2000 else max(0, raw_start)

        # Skip zoom if explicitly marked noZoom
        if first.get("noZoom"):
            i = j
            continue

        # Check if this click causes page navigation (e.g. menu navigation, page change, login, home return)
        # When navigating to a new page, keep the camera in full wide view (no zoom) so the viewer can recognize the new screen
        is_page_navigation = False
        desc = (first.get("description") or "").lower()
        if any(k in desc for k in ["이동", "페이지", "복귀", "홈", "로그인", "login"]):
            is_page_navigation = True
        elif j < len(moments) and moments[j].get("type") == "wait":
            next_wait = moments[j]
            if j + 1 < len(moments):
                wait_span = moments[j + 1]["timestamp"] - next_wait["timestamp"]
                if wait_span >= 2000:
                    is_page_navigation = True

        if is_page_navigation:
            print(f"  [No Zoom] Page navigation click: id={first['id']} ({first.get('description')})")
            i = j
            continue

        # For closing/submit clicks, ease out quickly (15 frames = 0.25s)
        is_closing = any(k in desc for k in ["닫기", "close", "제출", "submit", "저장", "save"])
        post_click_frames = 15 if is_closing else ms_to_frame(1200)

        seg = {
            "momentId": first["id"],
            "startFrame": start_frame,
            "endFrame": ms_to_frame(last["timestamp"]) + post_click_frames,
            "speed": 1.0,
            "zoom": default_zoom,
            "zoomTarget": first_cursor,
            "easeInFrames": 25,
            "easeOutFrames": 25,
            "description": f"Click cluster ({len(cluster)} clicks)" if len(cluster) > 1
                else f"Click at ({first_cursor['x']}, {first_cursor['y']})",
        }

        # If cluster has multiple clicks, add zoomTargetEnd for panning
        if len(cluster) > 1 and dist(first_cursor, last_cursor) > 20:
            seg["zoomTargetEnd"] = last_cursor

        segments.append(seg)

        # Skip past all moments in the cluster
        i = j
        continue

    i += 1

# Step 2: Merge overlapping segments
merged = []
for seg in sorted(segments, key=lambda s: s["startFrame"]):
    if merged and seg["startFrame"] <= merged[-1]["endFrame"]:
        # Extend the previous segment
        prev = merged[-1]
        prev["endFrame"] = max(prev["endFrame"], seg["endFrame"])
        if seg.get("zoomTargetEnd"):
            prev["zoomTargetEnd"] = seg["zoomTargetEnd"]
        prev["zoom"] = max(prev["zoom"], seg["zoom"])
        prev["description"] += f" + {seg['description']}"
    else:
        merged.append(seg)

# Step 3: Output
edit_plan = {
    "totalDurationFrames": total_frames,
    "fps": fps,
    "defaultZoom": 1.0,
    "segments": merged,
}

if "cursor" in metadata and metadata["cursor"]:
    edit_plan["cursor"] = metadata["cursor"]

out_path = data_dir / "edit-plan.json"
with open(out_path, "w", encoding="utf-8") as f:
    json.dump(edit_plan, f, indent=2)

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

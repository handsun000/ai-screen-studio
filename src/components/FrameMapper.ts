import type { EditPlan, EditSegment, TimeRegion } from "../types";

export function getSegmentAtFrame(
  frame: number,
  editPlan: EditPlan
): EditSegment | null {
  let best: EditSegment | null = null;
  let bestSpan = Infinity;

  for (const seg of editPlan.segments) {
    if (frame >= seg.startFrame && frame <= seg.endFrame) {
      const span = seg.endFrame - seg.startFrame;
      if (span < bestSpan) {
        best = seg;
        bestSpan = span;
      }
    }
  }
  return best;
}

export function frameToVideoTime(
  frame: number,
  editPlan: EditPlan
): number {
  const { fps, segments, timeRegions } = editPlan;

  if (timeRegions && timeRegions.length > 0) {
    if (frame <= timeRegions[0].compStartFrame) {
      return Math.max(0, timeRegions[0].videoStartFrame / fps);
    }
    for (const r of timeRegions) {
      if (frame >= r.compStartFrame && frame <= r.compEndFrame) {
        const videoFrame = r.videoStartFrame + (frame - r.compStartFrame) * r.speed;
        return Math.max(0, videoFrame / fps);
      }
    }
    const last = timeRegions[timeRegions.length - 1];
    const extraFrames = Math.max(0, frame - last.compEndFrame);
    return Math.max(0, (last.videoEndFrame + extraFrames) / fps);
  }

  const maxSpan = editPlan.totalDurationFrames;
  const actionSegments = segments
    .filter((s) => s.endFrame - s.startFrame < maxSpan)
    .sort((a, b) => a.startFrame - b.startFrame);

  const hasVariableSpeed = actionSegments.some((s) => s.speed !== 1.0);
  if (actionSegments.length === 0 || !hasVariableSpeed) {
    return frame / fps;
  }

  let videoTimeMs = 0;
  let lastEndFrame = 0;

  for (const seg of actionSegments) {
    if (frame <= lastEndFrame) break;

    const gapStart = lastEndFrame;
    const gapEnd = seg.startFrame;
    if (frame <= gapEnd) {
      const gapFrames = frame - gapStart;
      videoTimeMs += (gapFrames / fps) * 1000;
      return videoTimeMs / 1000;
    }
    videoTimeMs += ((gapEnd - gapStart) / fps) * 1000;

    if (frame <= seg.endFrame) {
      const segFrames = frame - seg.startFrame;
      videoTimeMs += (segFrames / fps) * seg.speed * 1000;
      return videoTimeMs / 1000;
    }
    const fullSegFrames = seg.endFrame - seg.startFrame;
    videoTimeMs += (fullSegFrames / fps) * seg.speed * 1000;

    lastEndFrame = seg.endFrame;
  }

  const remaining = frame - lastEndFrame;
  videoTimeMs += (remaining / fps) * 1000;

  return videoTimeMs / 1000;
}

export function videoFrameToCompFrameExact(
  videoFrame: number,
  editPlan: EditPlan
): number {
  const { timeRegions } = editPlan;
  if (!timeRegions || timeRegions.length === 0) {
    return videoFrame;
  }

  if (videoFrame <= timeRegions[0].videoStartFrame) {
    return timeRegions[0].compStartFrame;
  }

  for (const r of timeRegions) {
    if (r.videoEndFrame <= r.videoStartFrame) continue;
    if (videoFrame >= r.videoStartFrame && videoFrame <= r.videoEndFrame) {
      const rawSpan = Math.max(1e-6, r.videoEndFrame - r.videoStartFrame);
      const progress = Math.max(0, Math.min(1, (videoFrame - r.videoStartFrame) / rawSpan));
      return r.compStartFrame + progress * (r.compEndFrame - r.compStartFrame);
    }
  }

  const last = timeRegions[timeRegions.length - 1];
  const extra = Math.max(0, videoFrame - last.videoEndFrame);
  return last.compEndFrame + extra;
}

export function videoFrameToCompFrame(
  videoFrame: number,
  editPlan: EditPlan
): number {
  return Math.round(videoFrameToCompFrameExact(videoFrame, editPlan));
}

export function videoTimeMsToCompTimeMs(
  videoTimeMs: number,
  editPlan: EditPlan
): number {
  const fps = editPlan.fps || 60;
  const rawFrame = (videoTimeMs / 1000) * fps;
  const compFrame = videoFrameToCompFrameExact(rawFrame, editPlan);
  return (compFrame / fps) * 1000;
}

export function mergeContiguousTimeRegions(regions?: TimeRegion[]): TimeRegion[] {
  if (!regions || regions.length === 0) return [];
  const merged: TimeRegion[] = [];
  for (const r of regions) {
    if (r.compEndFrame <= r.compStartFrame || r.videoEndFrame <= r.videoStartFrame) {
      continue;
    }
    const prev = merged[merged.length - 1];
    if (
      prev &&
      Math.abs(prev.speed - 1.0) < 0.001 &&
      Math.abs(r.speed - 1.0) < 0.001 &&
      prev.compEndFrame === r.compStartFrame &&
      prev.videoEndFrame === r.videoStartFrame
    ) {
      prev.compEndFrame = r.compEndFrame;
      prev.videoEndFrame = r.videoEndFrame;
    } else {
      merged.push({ ...r });
    }
  }
  return merged;
}

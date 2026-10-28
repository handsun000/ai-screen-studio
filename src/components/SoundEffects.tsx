import React from "react";
import { Audio, Sequence, staticFile } from "remotion";
import type { EditPlan, MomentsFile } from "../types";
import { videoFrameToCompFrame } from "./FrameMapper";

const BASE_FPS = 30;

const CLICK_SOUNDS = [
  staticFile("sfx/click-1.mp3"),
  staticFile("sfx/click-2.mp3"),
  staticFile("sfx/click-3.mp3"),
];

const WHOOSH_IN_SOUNDS = [
  staticFile("sfx/whoosh-in-1.mp3"),
  staticFile("sfx/whoosh-in-2.mp3"),
];

const WHOOSH_OUT_SOUNDS = [
  staticFile("sfx/whoosh-out-1.mp3"),
  staticFile("sfx/whoosh-out-2.mp3"),
];

const WHOOSH_PAN_SOUND = staticFile("sfx/whoosh-pan.mp3");

interface SoundEffectsProps {
  editPlan: EditPlan;
  moments: MomentsFile;
  clickVolume?: number;
  whooshVolume?: number;
}

interface SfxEvent {
  frame: number;
  src: string;
  volume: number;
}

/**
 * Check if two segments will pan between each other (same logic as CameraTransform).
 */
function willPanBetween(
  prev: { endFrame: number; easeOutFrames?: number; zoom: number; zoomTarget: unknown },
  next: { startFrame: number; easeInFrames?: number; zoom: number; zoomTarget: unknown },
  fps: number,
  _fpsScale: number
): boolean {
  if (!prev.zoomTarget || !next.zoomTarget) return false;
  if (prev.zoom <= 1 || next.zoom <= 1) return false;
  const gapSeconds = Math.max(0, next.startFrame - prev.endFrame) / fps;
  return gapSeconds <= 10.0;
}

export const SoundEffects: React.FC<SoundEffectsProps> = ({
  editPlan,
  moments,
  clickVolume = 0.3,
  whooshVolume = 0.1,
}) => {
  const fpsScale = editPlan.fps / BASE_FPS;
  const events: SfxEvent[] = [];

  // Click sounds on click moments (mapped through timeRegions to composition frames)
  const clickMoments = moments.moments.filter(
    (m) => m.type === "click" || m.type === "rightclick" || m.type === "dblclick"
  );
  clickMoments.forEach((m, idx) => {
    const rawFrame = (m.timestamp / 1000) * editPlan.fps;
    const frame = videoFrameToCompFrame(rawFrame, editPlan);
    events.push({
      frame,
      src: CLICK_SOUNDS[idx % CLICK_SOUNDS.length],
      volume: clickVolume,
    });
  });

  // Camera whooshes from zoom segments (mapped through timeRegions to composition frames)
  const zoomSegments = editPlan.segments
    .filter((s) => s.zoomTarget && s.zoom > 1)
    .map((s) => {
      const compStart = videoFrameToCompFrame(s.startFrame, editPlan);
      const compEnd = Math.max(compStart + 1, videoFrameToCompFrame(s.endFrame, editPlan));
      return {
        ...s,
        startFrame: compStart,
        endFrame: compEnd,
      };
    });

  for (let i = 0; i < zoomSegments.length; i++) {
    const seg = zoomSegments[i];
    const prevSeg = i > 0 ? zoomSegments[i - 1] : null;
    const nextSeg = i < zoomSegments.length - 1 ? zoomSegments[i + 1] : null;
    const easeIn = Math.round((seg.easeInFrames ?? 15) * fpsScale);

    // Panning from previous: use pan whoosh
    const panFromPrev = prevSeg && willPanBetween(prevSeg, seg, editPlan.fps, fpsScale);
    if (panFromPrev) {
      const boundary = Math.round((prevSeg.endFrame + seg.startFrame) / 2);
      const compPanFrame = boundary - Math.round(8 * fpsScale);
      events.push({
        frame: Math.max(0, compPanFrame),
        src: WHOOSH_PAN_SOUND,
        volume: whooshVolume * 0.8,
      });
    } else {
      // Zoom in whoosh
      events.push({
        frame: Math.max(0, seg.startFrame - easeIn),
        src: WHOOSH_IN_SOUNDS[i % WHOOSH_IN_SOUNDS.length],
        volume: whooshVolume,
      });
    }

    // Zoom out whoosh (only if not panning to next)
    const panToNext = nextSeg && willPanBetween(seg, nextSeg, editPlan.fps, fpsScale);
    if (!panToNext) {
      events.push({
        frame: Math.max(0, seg.endFrame),
        src: WHOOSH_OUT_SOUNDS[i % WHOOSH_OUT_SOUNDS.length],
        volume: whooshVolume,
      });
    }
  }

  return (
    <>
      {events.map((evt, idx) => (
        <Sequence key={idx} from={Math.max(0, evt.frame)}>
          <Audio src={evt.src} volume={evt.volume} />
        </Sequence>
      ))}
    </>
  );
};

import React from "react";
import { AbsoluteFill, Audio, Sequence, staticFile, useCurrentFrame } from "remotion";
import type { EditPlan, NarrationCue } from "../types";
import { frameToVideoTime } from "./FrameMapper";

interface NarrationTrackProps {
  editPlan: EditPlan;
}

const FADE_IN_MS = 140;
const FADE_OUT_MS = 160;

export const NarrationTrack: React.FC<NarrationTrackProps> = ({ editPlan }) => {
  const frame = useCurrentFrame();
  const narration = editPlan.narration;

  if (!narration || !narration.cues || narration.cues.length === 0) {
    return null;
  }

  const playAudio = narration.enabled !== false;
  const showSubtitles = narration.showSubtitles !== false;

  if (!playAudio && !showSubtitles) {
    return null;
  }

  const videoTimeMs = frameToVideoTime(frame, editPlan) * 1000;

  let activeCue: NarrationCue | null = null;
  let subtitleOpacity = 0;

  if (showSubtitles) {
    for (const cue of narration.cues) {
      if (videoTimeMs >= cue.startMs && videoTimeMs <= cue.endMs) {
        activeCue = cue;
        const intoMs = videoTimeMs - cue.startMs;
        const remainMs = cue.endMs - videoTimeMs;
        const fadeIn = Math.min(1, Math.max(0, intoMs / FADE_IN_MS));
        const fadeOut = Math.min(1, Math.max(0, remainMs / FADE_OUT_MS));
        subtitleOpacity = Math.min(fadeIn, fadeOut);
        break;
      }
    }
  }

  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      {playAudio &&
        narration.cues.map((cue) => {
          if (!cue.audioFile) return null;
          const startFrame = Math.max(0, Math.round((cue.startMs / 1000) * editPlan.fps));
          const endFrame = Math.max(startFrame + 6, Math.round((cue.endMs / 1000) * editPlan.fps));
          const durationFrames = Math.max(10, endFrame - startFrame + 15);
          return (
            <Sequence
              key={`narration-audio-${cue.id}`}
              from={startFrame}
              durationInFrames={durationFrames}
            >
              <Audio src={staticFile(cue.audioFile)} volume={1.0} />
            </Sequence>
          );
        })}

      {showSubtitles && activeCue && subtitleOpacity > 0.02 && (
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 36,
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
            padding: "0 48px",
            opacity: subtitleOpacity,
            transform: `translateY(${Math.round((1 - subtitleOpacity) * 6)}px)`,
          }}
        >
          <div
            style={{
              maxWidth: 1420,
              background: "rgba(15, 23, 42, 0.86)",
              border: "1px solid rgba(148, 163, 184, 0.32)",
              borderRadius: 12,
              padding: "12px 28px",
              boxShadow: "0 12px 32px rgba(0, 0, 0, 0.45)",
              color: "#F8FAFC",
              fontFamily:
                "'Pretendard', 'Noto Sans KR', 'Malgun Gothic', 'Apple SD Gothic Neo', sans-serif",
              fontSize: 27,
              fontWeight: 600,
              letterSpacing: "-0.01em",
              lineHeight: 1.42,
              textAlign: "center",
              wordBreak: "keep-all",
            }}
          >
            {activeCue.text}
          </div>
        </div>
      )}
    </AbsoluteFill>
  );
};

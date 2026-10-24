import React from "react";
import { AbsoluteFill, OffthreadVideo, Sequence, staticFile } from "remotion";
import { Background } from "./backgrounds/Background";
import { FloatingWindow, WINDOW_WIDTH, WINDOW_HEIGHT } from "./components/FloatingWindow";
import { SyntheticCursor } from "./components/SyntheticCursor";
import { CameraTransform } from "./components/CameraTransform";
import { SoundEffects } from "./components/SoundEffects";
import { NarrationTrack } from "./components/NarrationTrack";
import { mergeContiguousTimeRegions } from "./components/FrameMapper";
import type { EditPlan, MomentsFile } from "./types";

const WIDTH = 1920;
const HEIGHT = 1080;

interface ScreenDemoProps {
  editPlan: EditPlan;
  moments: MomentsFile;
  videoFileName: string;
  showCursor?: boolean;
  showSfx?: boolean;
}

export const ScreenDemo: React.FC<ScreenDemoProps> = ({
  editPlan,
  moments,
  videoFileName,
  showCursor = true,
  showSfx = true,
}) => {
  const videoSrc = staticFile(videoFileName);
  const mergedRegions = mergeContiguousTimeRegions(editPlan.timeRegions);
  const hasTimeWarp = mergedRegions.some((r) => Math.abs(r.speed - 1.0) > 0.001);

  return (
    <AbsoluteFill>
      <Background />

      <CameraTransform
        editPlan={editPlan}
        moments={moments.moments}
        canvasWidth={WIDTH}
        canvasHeight={HEIGHT}
        viewportWidth={moments.metadata.viewportWidth}
        viewportHeight={moments.metadata.viewportHeight}
      >
        <FloatingWindow width={WIDTH} height={HEIGHT}>
          {hasTimeWarp ? (
            mergedRegions.map((region, idx) => (
              <Sequence
                key={`video-region-${idx}-${region.compStartFrame}`}
                from={region.compStartFrame}
                durationInFrames={Math.max(1, region.compEndFrame - region.compStartFrame)}
                layout="none"
              >
                <OffthreadVideo
                  src={videoSrc}
                  startFrom={region.videoStartFrame}
                  playbackRate={Math.max(0.0005, region.speed)}
                  muted
                  style={{
                    width: WINDOW_WIDTH,
                    height: WINDOW_HEIGHT,
                    objectFit: "cover",
                  }}
                />
              </Sequence>
            ))
          ) : (
            <OffthreadVideo
              src={videoSrc}
              startFrom={0}
              playbackRate={1}
              muted
              style={{
                width: WINDOW_WIDTH,
                height: WINDOW_HEIGHT,
                objectFit: "cover",
              }}
            />
          )}
          {showCursor && (
            <SyntheticCursor
              moments={moments.moments}
              metadata={moments.metadata}
              editPlan={editPlan}
              windowWidth={WINDOW_WIDTH}
              windowHeight={WINDOW_HEIGHT}
              viewportWidth={moments.metadata.viewportWidth}
              viewportHeight={moments.metadata.viewportHeight}
            />
          )}
        </FloatingWindow>
      </CameraTransform>

      <NarrationTrack editPlan={editPlan} />

      {showSfx && (
        <SoundEffects editPlan={editPlan} moments={moments} />
      )}
    </AbsoluteFill>
  );
};

import React from "react";
import { Composition } from "remotion";
import { ScreenDemo } from "./ScreenDemo";
import type { EditPlan, MomentsFile } from "./types";

const FALLBACK_EDIT_PLAN: EditPlan = {
  totalDurationFrames: 300,
  rawDurationFrames: 300,
  fps: 30,
  defaultZoom: 1.0,
  segments: [],
};

const FALLBACK_MOMENTS: MomentsFile = {
  metadata: {
    url: "",
    viewportWidth: 1920,
    viewportHeight: 1080,
    totalDurationMs: 10000,
    recordingStart: new Date(0).toISOString(),
  },
  moments: [],
};

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="ScreenDemo"
        component={ScreenDemo as unknown as React.ComponentType<Record<string, unknown>>}
        durationInFrames={FALLBACK_EDIT_PLAN.totalDurationFrames}
        fps={FALLBACK_EDIT_PLAN.fps}
        width={1920}
        height={1080}
        defaultProps={{
          editPlan: FALLBACK_EDIT_PLAN,
          moments: FALLBACK_MOMENTS,
          videoFileName: "recording.mp4",
          showCursor: true,
          showSfx: false,
        }}
        calculateMetadata={({ props }) => {
          const dynamicEditPlan = (props?.editPlan as EditPlan | undefined) || FALLBACK_EDIT_PLAN;
          const targetFps = Math.max(1, Number(dynamicEditPlan.fps) || 30);
          const targetDurationFrames = Math.max(1, Math.round(Number(dynamicEditPlan.totalDurationFrames) || 300));
          return {
            fps: targetFps,
            durationInFrames: targetDurationFrames,
            props,
          };
        }}
      />
    </>
  );
};

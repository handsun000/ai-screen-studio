import React from "react";
import { useCurrentFrame, interpolate, Easing } from "remotion";
import type { EditPlan, EditSegment, CursorPosition, Moment } from "../types";
import { WINDOW_WIDTH, WINDOW_HEIGHT } from "./FloatingWindow";
import { frameToVideoTime } from "./FrameMapper";
import { getCursorState } from "./SyntheticCursor";

interface CameraTransformProps {
  editPlan: EditPlan;
  moments?: Moment[];
  canvasWidth: number;
  canvasHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  children: React.ReactNode;
}

interface ZoomState {
  scale: number;
  translateX: number;
  translateY: number;
}

/**
 * Base FPS for ease duration authoring. Ease frame counts in the edit plan
 * are authored assuming this FPS. At higher FPS, they scale proportionally
 * so the animation takes the same wall-clock time.
 */
const BASE_FPS = 30;

// Central deadzone (in canvas px around screen center):
// Any click/type inside this central workspace region keeps translateX = 0 / translateY = 0
// so the camera stays locked like a tripod instead of swaying left/right on every mouse move.
const DEADZONE_SCREEN_X = 500;
const DEADZONE_SCREEN_Y = 220;
const MAX_CAMERA_PAN_X = 42;
const MAX_CAMERA_PAN_Y = 28;

function applyDeadzone(delta: number, deadzone: number): number {
  if (Math.abs(delta) <= deadzone) return 0;
  return delta > 0 ? delta - deadzone : delta + deadzone;
}

function computeTranslate(
  point: CursorPosition,
  zoom: number,
  canvasWidth: number,
  canvasHeight: number,
  viewportWidth: number,
  viewportHeight: number
): { translateX: number; translateY: number } {
  const windowLeft = (canvasWidth - WINDOW_WIDTH) / 2;
  const windowTop = (canvasHeight - WINDOW_HEIGHT) / 2;
  const scaleX = WINDOW_WIDTH / viewportWidth;
  const scaleY = WINDOW_HEIGHT / viewportHeight;

  const targetScreenX = windowLeft + point.x * scaleX;
  const targetScreenY = windowTop + point.y * scaleY;
  const centerX = canvasWidth / 2;
  const centerY = canvasHeight / 2;

  const rawDx = applyDeadzone(centerX - targetScreenX, DEADZONE_SCREEN_X);
  const rawDy = applyDeadzone(centerY - targetScreenY, DEADZONE_SCREEN_Y);

  let tx = rawDx * zoom * 0.35;
  let ty = rawDy * zoom * 0.35;

  // Clamp translation so the scaled window edges never pull inside the canvas AND never sway wildly
  const maxTx = Math.min(MAX_CAMERA_PAN_X, Math.max(0, (WINDOW_WIDTH * zoom - canvasWidth) / 2));
  const maxTy = Math.min(MAX_CAMERA_PAN_Y, Math.max(0, (WINDOW_HEIGHT * zoom - canvasHeight) / 2));

  tx = Math.max(-maxTx, Math.min(maxTx, tx));
  ty = Math.max(-maxTy, Math.min(maxTy, ty));

  return {
    translateX: tx,
    translateY: ty,
  };
}

function computeZoomTarget(
  seg: EditSegment,
  canvasWidth: number,
  canvasHeight: number,
  viewportWidth: number,
  viewportHeight: number
): { maxTranslateX: number; maxTranslateY: number } {
  const target = seg.zoomTarget;
  if (!target) return { maxTranslateX: 0, maxTranslateY: 0 };
  const { translateX, translateY } = computeTranslate(
    target,
    seg.zoom,
    canvasWidth,
    canvasHeight,
    viewportWidth,
    viewportHeight
  );
  return { maxTranslateX: translateX, maxTranslateY: translateY };
}

/**
 * Determine whether two consecutive zoom segments should smoothly glide/pan between each other
 * rather than zooming all the way out to 1.0x and back in.
 */
function shouldGlideBetween(
  prev: EditSegment,
  next: EditSegment,
  fps: number
): boolean {
  if (!prev.zoomTarget || !next.zoomTarget) return false;
  if (prev.zoom <= 1 || next.zoom <= 1) return false;
  const gapSeconds = Math.max(0, next.startFrame - prev.endFrame) / fps;
  return gapSeconds <= 10.0;
}

/**
 * Compute the transition window [panStart, panEnd] for gliding from seg[i] to seg[i+1].
 * Ensures the camera arrives at seg[i+1]'s target slightly before seg[i+1].startFrame.
 */
function getPanWindow(
  prev: EditSegment,
  next: EditSegment,
  fps: number
): { panStart: number; panEnd: number } {
  const preArrivalFrames = Math.max(1, Math.round(0.06 * fps));
  const panEnd = Math.max(prev.startFrame + 2, next.startFrame - preArrivalFrames);

  // Calm, smooth tripod pan (~0.62s) when moving between genuinely distinct regions
  const idealPanFrames = Math.round(0.62 * fps);
  const minHoldFrames = Math.round(0.25 * fps);
  const maxAvailablePan = Math.max(4, panEnd - (prev.startFrame + minHoldFrames));
  const panDuration = Math.min(idealPanFrames, maxAvailablePan);
  const panStart = Math.max(prev.startFrame, panEnd - panDuration);

  return { panStart, panEnd };
}

function getCameraState(
  frame: number,
  editPlan: EditPlan,
  canvasWidth: number,
  canvasHeight: number,
  viewportWidth: number,
  viewportHeight: number
): ZoomState {
  const defaultState: ZoomState = { scale: 1, translateX: 0, translateY: 0 };
  const fps = editPlan.fps;
  const fpsScale = fps / BASE_FPS;
  const zoomSegments = editPlan.segments.filter(
    (s) => s.zoomTarget && s.zoom > 1
  );

  if (zoomSegments.length === 0) return defaultState;

  for (let i = 0; i < zoomSegments.length; i++) {
    const seg = zoomSegments[i];
    const prevSeg = i > 0 ? zoomSegments[i - 1] : null;
    const nextSeg = i < zoomSegments.length - 1 ? zoomSegments[i + 1] : null;

    const glideFromPrev = Boolean(prevSeg && shouldGlideBetween(prevSeg, seg, fps));
    const glideToNext = Boolean(nextSeg && shouldGlideBetween(seg, nextSeg, fps));

    const easeIn = Math.round((seg.easeInFrames ?? 18) * fpsScale);
    const easeOut = Math.round((seg.easeOutFrames ?? 20) * fpsScale);

    const { maxTranslateX, maxTranslateY } = computeZoomTarget(
      seg,
      canvasWidth,
      canvasHeight,
      viewportWidth,
      viewportHeight
    );

    const holdStart = glideFromPrev
      ? getPanWindow(prevSeg!, seg, fps).panEnd
      : seg.startFrame;

    const nextPan = glideToNext ? getPanWindow(seg, nextSeg!, fps) : null;
    const holdEnd = nextPan ? nextPan.panStart : seg.endFrame;

    // 1. Ease-in from 1.0x (only if not gliding from previous segment)
    if (!glideFromPrev) {
      const zoomStart = seg.startFrame - easeIn;
      if (frame >= zoomStart && frame < seg.startFrame) {
        const t = interpolate(frame, [zoomStart, seg.startFrame], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
          easing: Easing.out(Easing.cubic),
        });
        return {
          scale: 1 + (seg.zoom - 1) * t,
          translateX: maxTranslateX * t,
          translateY: maxTranslateY * t,
        };
      }
    }

    // 2. Hold completely steady on current segment target (zero intra-segment drift)
    if (frame >= holdStart && frame <= holdEnd) {
      return {
        scale: seg.zoom,
        translateX: maxTranslateX,
        translateY: maxTranslateY,
      };
    }

    // 3. Smooth glide to next segment (if the next segment actually shifts camera translation)
    if (glideToNext && nextPan) {
      if (frame > nextPan.panStart && frame <= nextPan.panEnd) {
        const toTarget = computeZoomTarget(
          nextSeg!,
          canvasWidth,
          canvasHeight,
          viewportWidth,
          viewportHeight
        );
        const t = interpolate(frame, [nextPan.panStart, nextPan.panEnd], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
          easing: Easing.inOut(Easing.cubic),
        });

        const scale = seg.zoom + (nextSeg!.zoom - seg.zoom) * t;

        return {
          scale,
          translateX:
            maxTranslateX +
            (toTarget.maxTranslateX - maxTranslateX) * t,
          translateY:
            maxTranslateY +
            (toTarget.maxTranslateY - maxTranslateY) * t,
        };
      }
    }

    // 4. Ease-out back to 1.0x (only if not gliding to next segment)
    if (!glideToNext) {
      const zoomEnd = seg.endFrame + easeOut;
      if (frame > seg.endFrame && frame <= zoomEnd) {
        const t = interpolate(frame, [seg.endFrame, zoomEnd], [1, 0], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
          easing: Easing.in(Easing.cubic),
        });
        return {
          scale: 1 + (seg.zoom - 1) * t,
          translateX: maxTranslateX * t,
          translateY: maxTranslateY * t,
        };
      }
    }
  }

  return defaultState;
}

export const CameraTransform: React.FC<CameraTransformProps> = ({
  editPlan,
  canvasWidth,
  canvasHeight,
  viewportWidth,
  viewportHeight,
  children,
}) => {
  const frame = useCurrentFrame();
  const { scale, translateX, translateY } = getCameraState(
    frame,
    editPlan,
    canvasWidth,
    canvasHeight,
    viewportWidth,
    viewportHeight
  );

  return (
    <div
      style={{
        position: "absolute",
        width: canvasWidth,
        height: canvasHeight,
        transform: `translate(${translateX}px, ${translateY}px) scale(${scale})`,
        transformOrigin: "center center",
      }}
    >
      {children}
    </div>
  );
};


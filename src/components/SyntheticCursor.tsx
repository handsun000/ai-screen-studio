import React from "react";
import { useCurrentFrame, Easing } from "remotion";
import type { Moment, MomentsMetadata } from "../types";
import {
  CURSOR_PATH,
  CURSOR_WIDTH,
  CURSOR_HEIGHT,
  CLICK_SCALE_MIN,
} from "../styles/cursor";
import type { EditPlan } from "../types";
import { frameToVideoTime } from "./FrameMapper";

interface SyntheticCursorProps {
  moments: Moment[];
  metadata?: MomentsMetadata;
  editPlan: EditPlan;
  windowWidth: number;
  windowHeight: number;
  viewportWidth: number;
  viewportHeight: number;
}

// Duration (ms) the cursor takes to glide to the next target.
// 450ms provides an intentional, snappy, human-like motion.
const TRAVEL_DURATION_MS = 450;
const LEAD_IN_DURATION_MS = 600;
const CLICK_ANIMATION_MS = 350;
const POST_ACTION_HOLD_MS = 700;
const FADE_DURATION_MS = 300;
const PRE_TRAVEL_FADE_IN_MS = 350;

function getCursorState(
  videoTimeMs: number,
  moments: Moment[]
): {
  x: number;
  y: number;
  opacity: number;
  isClick: boolean;
  clickProgress: number;
} {
  const cursorMoments = moments.filter(
    (m) =>
      m.cursor &&
      m.cursor.x > 0 &&
      m.cursor.y > 0 &&
      (m.type === "click" ||
        m.type === "dblclick" ||
        m.type === "hover" ||
        m.type === "scroll" ||
        m.type === "type")
  );

  if (cursorMoments.length === 0) {
    return { x: 0, y: 0, opacity: 0, isClick: false, clickProgress: 0 };
  }

  const firstAction = cursorMoments[0];
  const firstTime = firstAction.timestamp;

  let x: number = 960;
  let y: number = 540;
  let opacity: number = 0;

  if (videoTimeMs < firstTime) {
    // Before lead-in: keep cursor hidden during introduction/page loading
    const leadStart = Math.max(0, firstTime - LEAD_IN_DURATION_MS);
    if (videoTimeMs < leadStart) {
      return { x: 0, y: 0, opacity: 0, isClick: false, clickProgress: 0 };
    }

    // Lead-in: smooth glide and fade-in from screen center to the first target
    const t = (videoTimeMs - leadStart) / (firstTime - leadStart || 1);
    const eased = Easing.out(Easing.cubic)(Math.min(1, Math.max(0, t)));
    x = 960 + (firstAction.cursor!.x - 960) * eased;
    y = 540 + (firstAction.cursor!.y - 540) * eased;
    opacity = Math.min(1, Math.max(0, t));
    return { x, y, opacity, isClick: false, clickProgress: 0 };
  }

  // Find which action we're at or between
  let currentIdx = 0;
  for (let i = 0; i < cursorMoments.length; i++) {
    if (cursorMoments[i].timestamp <= videoTimeMs) {
      currentIdx = i;
    }
  }

  const current = cursorMoments[currentIdx];
  const next = cursorMoments[currentIdx + 1];

  if (!next) {
    // After last action: hold position briefly, then fade out completely during outro
    x = current.cursor!.x;
    y = current.cursor!.y;
    const elapsed = videoTimeMs - current.timestamp;
    if (elapsed <= POST_ACTION_HOLD_MS) {
      opacity = 1.0;
    } else if (elapsed <= POST_ACTION_HOLD_MS + FADE_DURATION_MS) {
      opacity = 1.0 - (elapsed - POST_ACTION_HOLD_MS) / FADE_DURATION_MS;
    } else {
      opacity = 0;
    }
  } else {
    // Hold at current position, then glide to next target in the last TRAVEL_DURATION_MS
    const gap = next.timestamp - current.timestamp;
    const travelDuration = Math.min(TRAVEL_DURATION_MS, Math.max(100, gap));
    const moveStart = next.timestamp - travelDuration;
    const fadeInStart = moveStart - PRE_TRAVEL_FADE_IN_MS;
    const fadeOutStart = current.timestamp + POST_ACTION_HOLD_MS;

    if (videoTimeMs < moveStart) {
      // Resting at current position
      x = current.cursor!.x;
      y = current.cursor!.y;
    } else {
      // Gliding towards next position
      const t = (videoTimeMs - moveStart) / travelDuration;
      const eased = Easing.inOut(Easing.cubic)(Math.min(1, Math.max(0, t)));
      x = current.cursor!.x + (next.cursor!.x - current.cursor!.x) * eased;
      y = current.cursor!.y + (next.cursor!.y - current.cursor!.y) * eased;
    }

    // Smart idle visibility: if there is an extended pause (>= 1.4s) between actions,
    // fade the cursor out to avoid cluttering the screen, and fade it back in right before moving.
    if (fadeInStart > fadeOutStart + 300) {
      if (videoTimeMs <= fadeOutStart) {
        opacity = 1.0;
      } else if (videoTimeMs < fadeOutStart + FADE_DURATION_MS) {
        opacity = 1.0 - (videoTimeMs - fadeOutStart) / FADE_DURATION_MS;
      } else if (videoTimeMs < fadeInStart) {
        opacity = 0;
      } else if (videoTimeMs < moveStart) {
        opacity = (videoTimeMs - fadeInStart) / (moveStart - fadeInStart || 1);
      } else {
        opacity = 1.0;
      }
    } else {
      opacity = 1.0;
    }
  }

  // Click animation: begins precisely at m.timestamp and lasts 350ms
  let isClick = false;
  let clickProgress = 0;
  for (const m of cursorMoments) {
    if (m.type === "click" || m.type === "dblclick") {
      const elapsed = videoTimeMs - m.timestamp;
      if (elapsed >= 0 && elapsed < CLICK_ANIMATION_MS) {
        isClick = true;
        clickProgress = elapsed / CLICK_ANIMATION_MS;
        opacity = 1.0;
        break;
      }
    }
  }

  return { x, y, opacity: Math.max(0, Math.min(1, opacity)), isClick, clickProgress };
}

export const SyntheticCursor: React.FC<SyntheticCursorProps> = ({
  moments,
  editPlan,
  windowWidth,
  windowHeight,
  viewportWidth,
  viewportHeight,
}) => {
  const frame = useCurrentFrame();
  const videoTimeSec = frameToVideoTime(frame, editPlan);
  const videoTimeMs = videoTimeSec * 1000;

  const { x, y, opacity, isClick, clickProgress } = getCursorState(
    videoTimeMs,
    moments
  );

  if (opacity <= 0.001) return null;

  // Scale cursor coords from viewport space to window space
  const scaleX = windowWidth / viewportWidth;
  const scaleY = windowHeight / viewportHeight;
  const screenX = x * scaleX;
  const screenY = y * scaleY;

  // Click scale animation: press down, hold, then spring back
  let cursorScale = 1;
  if (isClick) {
    if (clickProgress < 0.25) {
      // Pressing down: 1.0 -> CLICK_SCALE_MIN
      cursorScale = 1 - (1 - CLICK_SCALE_MIN) * (clickProgress / 0.25);
    } else if (clickProgress < 0.55) {
      // Holding pressed
      cursorScale = CLICK_SCALE_MIN;
    } else {
      // Releasing back to 1.0
      cursorScale =
        CLICK_SCALE_MIN +
        (1 - CLICK_SCALE_MIN) * ((clickProgress - 0.55) / 0.45);
    }
  }

  // Click ring animation: expands outward and fades
  const ringOpacity = isClick ? Math.max(0, 0.7 * (1 - clickProgress)) : 0;
  const ringScale = isClick ? 1 + clickProgress * 1.8 : 1;

  return (
    <div
      style={{
        position: "absolute",
        left: screenX,
        top: screenY,
        transform: `translate(-2px, -2px)`,
        pointerEvents: "none",
        zIndex: 100,
        opacity: Math.max(0, Math.min(1, opacity)),
      }}
    >
      {isClick && ringOpacity > 0 && (
        <div
          style={{
            position: "absolute",
            left: 2,
            top: 2,
            width: 20,
            height: 20,
            borderRadius: "50%",
            border: "2px solid rgba(255,255,255,0.85)",
            opacity: ringOpacity,
            transform: `translate(-50%, -50%) scale(${ringScale})`,
          }}
        />
      )}
      <svg
        width={CURSOR_WIDTH}
        height={CURSOR_HEIGHT}
        viewBox="0 0 28 36"
        fill="none"
        style={{
          transform: `scale(${cursorScale})`,
          transformOrigin: "top left",
        }}
      >
        <path
          d={CURSOR_PATH}
          fill={isClick && clickProgress < 0.55 ? "#333333" : "#FFFFFF"}
          stroke="#333333"
          strokeWidth={2}
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
};

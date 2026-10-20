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
// 420ms provides an intentional, snappy, human-like motion.
const TRAVEL_DURATION_MS = 420;
const LEAD_IN_DURATION_MS = 600;
const PRE_CLICK_REST_MS = 80;
const CLICK_LEAD_MS = 60;
const CLICK_ANIMATION_MS = 320;
const DRAG_DURATION_MS = 600;
const POST_ACTION_HOLD_MS = 900;
const FADE_DURATION_MS = 350;
const PRE_TRAVEL_FADE_IN_MS = 350;
// Only fade cursor out during very long idle pauses (>= 8 seconds)
const IDLE_FADE_THRESHOLD_MS = 8000;
const TYPE_HIDE_DELAY_MS = 220;
const TYPE_FADE_OUT_MS = 180;
const TYPE_FADE_IN_LEAD_MS = 140;

function isSameInputSpot(a: { x: number; y: number } | undefined, b: { x: number; y: number } | undefined): boolean {
  if (!a || !b) return false;
  return Math.hypot(a.x - b.x, a.y - b.y) <= 56;
}

function isMomentClickable(m: Moment, prev: Moment | undefined): boolean {
  if (m.type === "click" || m.type === "dblclick" || m.type === "upload") return true;
  if (m.type === "type" && m.cursor) {
    // In record.ts, 'type' clicks the input box to focus it unless the immediately preceding moment
    // already clicked the exact same spot.
    if (
      prev &&
      (prev.type === "click" || prev.type === "dblclick" || prev.type === "type") &&
      isSameInputSpot(prev.cursor, m.cursor) &&
      m.timestamp - prev.timestamp <= 3500
    ) {
      return false;
    }
    return true;
  }
  return false;
}

export function getCursorState(
  videoTimeMs: number,
  moments: Moment[]
): {
  x: number;
  y: number;
  opacity: number;
  isClick: boolean;
  clickProgress: number;
} {
  const cursorMoments = moments.filter((m) => {
    if (m.type === "drag" || m.type === "dragAndDrop") {
      return Boolean((m.dragFrom && m.dragTo) || (m.cursor && m.cursor.x > 0 && m.cursor.y > 0));
    }
    return Boolean(
      m.cursor &&
        m.cursor.x > 0 &&
        m.cursor.y > 0 &&
        (m.type === "click" ||
          m.type === "dblclick" ||
          m.type === "upload" ||
          m.type === "hover" ||
          m.type === "scroll" ||
          m.type === "type")
    );
  });

  if (cursorMoments.length === 0) {
    return { x: 0, y: 0, opacity: 0, isClick: false, clickProgress: 0 };
  }

  const getStartPos = (m: Moment) => m.dragFrom || m.cursor || { x: 960, y: 540 };
  const getEndPos = (m: Moment) => m.dragTo || m.cursor || { x: 960, y: 540 };

  const firstAction = cursorMoments[0];
  const firstPos = getStartPos(firstAction);
  const firstArrivalTime = Math.max(0, firstAction.timestamp - PRE_CLICK_REST_MS);

  let x: number = 960;
  let y: number = 540;
  let opacity: number = 0;

  if (videoTimeMs < firstAction.timestamp) {
    const leadStart = Math.max(0, firstArrivalTime - LEAD_IN_DURATION_MS);
    if (videoTimeMs < leadStart) {
      return { x: 0, y: 0, opacity: 0, isClick: false, clickProgress: 0 };
    }

    if (videoTimeMs >= firstArrivalTime) {
      x = firstPos.x;
      y = firstPos.y;
      opacity = 1.0;
    } else {
      const span = Math.max(1, firstArrivalTime - leadStart);
      const t = (videoTimeMs - leadStart) / span;
      const eased = Easing.out(Easing.cubic)(Math.min(1, Math.max(0, t)));
      x = 960 + (firstPos.x - 960) * eased;
      y = 540 + (firstPos.y - 540) * eased;
      opacity = Math.min(1, Math.max(0, t * 1.25));
    }

    // Check if the first action's click lead-in has already begun (within CLICK_LEAD_MS before firstAction.timestamp)
    const firstClickElapsed = videoTimeMs - (firstAction.timestamp - CLICK_LEAD_MS);
    if (
      isMomentClickable(firstAction, undefined) &&
      firstClickElapsed >= 0 &&
      firstClickElapsed < CLICK_ANIMATION_MS
    ) {
      return {
        x,
        y,
        opacity: 1.0,
        isClick: true,
        clickProgress: firstClickElapsed / CLICK_ANIMATION_MS,
      };
    }

    return { x, y, opacity, isClick: false, clickProgress: 0 };
  }

  // Find which action we're at or between
  let currentIdx = 0;
  for (let i = 0; i < cursorMoments.length; i++) {
    if (cursorMoments[i].timestamp <= videoTimeMs) {
      currentIdx = i;
    }
  }

  const prev = currentIdx > 0 ? cursorMoments[currentIdx - 1] : undefined;
  const current = cursorMoments[currentIdx];
  const next = cursorMoments[currentIdx + 1];
  const currentStartPos = getStartPos(current);
  const currentEndPos = getEndPos(current);
  const isCurrentDrag =
    (current.type === "drag" || current.type === "dragAndDrop") &&
    Boolean(current.dragFrom && current.dragTo);

  // If currently executing a drag gesture, interpolate from dragFrom to dragTo
  if (isCurrentDrag && videoTimeMs <= current.timestamp + DRAG_DURATION_MS) {
    const dt = (videoTimeMs - current.timestamp) / DRAG_DURATION_MS;
    const eased = Easing.inOut(Easing.cubic)(Math.min(1, Math.max(0, dt)));
    x = currentStartPos.x + (currentEndPos.x - currentStartPos.x) * eased;
    y = currentStartPos.y + (currentEndPos.y - currentStartPos.y) * eased;
    return {
      x,
      y,
      opacity: 1.0,
      isClick: true,
      clickProgress: 0.35, // Hold pressed during drag
    };
  }

  const currentRestTime = isCurrentDrag
    ? current.timestamp + DRAG_DURATION_MS
    : current.timestamp;

  // Determine whether the cursor should hide for typing:
  // Case 1: current is 'type' -> hide cursor while typing is happening.
  // Case 2: current is 'click' on an input box and next is 'type' on the exact same input box ->
  //         fade cursor out right after the click finishes so it is already out of the way before typing begins!
  const nextIsSameSpotType =
    Boolean(next && next.type === "type" && isSameInputSpot(currentEndPos, getStartPos(next)));
  const currentIsType = current.type === "type";
  const currentAlreadyHiddenFromPrevClick =
    currentIsType &&
    Boolean(
      prev &&
        (prev.type === "click" || prev.type === "dblclick" || prev.type === "type") &&
        isSameInputSpot(getEndPos(prev), currentStartPos) &&
        current.timestamp - prev.timestamp <= 3500
    );

  if (!next) {
    // After last action: hold position briefly (or hide immediately if typing), then fade out
    x = currentEndPos.x;
    y = currentEndPos.y;
    const elapsed = videoTimeMs - currentRestTime;
    if (currentIsType) {
      if (currentAlreadyHiddenFromPrevClick) {
        opacity = 0;
      } else if (elapsed <= TYPE_HIDE_DELAY_MS) {
        opacity = 1.0;
      } else if (elapsed <= TYPE_HIDE_DELAY_MS + TYPE_FADE_OUT_MS) {
        opacity = 1.0 - (elapsed - TYPE_HIDE_DELAY_MS) / TYPE_FADE_OUT_MS;
      } else {
        opacity = 0;
      }
    } else if (elapsed <= POST_ACTION_HOLD_MS) {
      opacity = 1.0;
    } else if (elapsed <= POST_ACTION_HOLD_MS + FADE_DURATION_MS) {
      opacity = 1.0 - (elapsed - POST_ACTION_HOLD_MS) / FADE_DURATION_MS;
    } else {
      opacity = 0;
    }
  } else {
    const nextStartPos = getStartPos(next);
    const rawGap = Math.max(60, next.timestamp - currentRestTime);
    // Arrive at the target PRE_CLICK_REST_MS (80ms) BEFORE next.timestamp so the cursor
    // visibly lands on the button and presses down right as the DOM click fires.
    const restBeforeNext = rawGap >= 220 ? PRE_CLICK_REST_MS : Math.round(rawGap * 0.25);
    const arrivalTime = Math.max(currentRestTime + 40, next.timestamp - restBeforeNext);
    const availableForTravel = Math.max(60, arrivalTime - currentRestTime);
    const travelDuration = Math.min(
      TRAVEL_DURATION_MS,
      Math.max(80, Math.round(availableForTravel * 0.78))
    );
    const moveStart = Math.max(currentRestTime, arrivalTime - travelDuration);

    if (videoTimeMs < moveStart) {
      // Resting at current position after completing the previous action
      x = currentEndPos.x;
      y = currentEndPos.y;
    } else if (videoTimeMs < arrivalTime) {
      // Gliding smoothly towards next target
      const t = (videoTimeMs - moveStart) / Math.max(1, arrivalTime - moveStart);
      const eased = Easing.inOut(Easing.cubic)(Math.min(1, Math.max(0, t)));
      x = currentEndPos.x + (nextStartPos.x - currentEndPos.x) * eased;
      y = currentEndPos.y + (nextStartPos.y - currentEndPos.y) * eased;
    } else {
      // Arrived at next target — resting squarely on the button right before click
      x = nextStartPos.x;
      y = nextStartPos.y;
    }

    if (nextIsSameSpotType) {
      // Input field was just clicked (or typed) and the next moment is typing on the same spot:
      // fade out right after the click ripple so the input box is completely unobstructed.
      if (currentAlreadyHiddenFromPrevClick) {
        opacity = 0;
      } else {
        const fadeOutStart = currentRestTime + TYPE_HIDE_DELAY_MS;
        if (videoTimeMs <= fadeOutStart) {
          opacity = 1.0;
        } else if (videoTimeMs < fadeOutStart + TYPE_FADE_OUT_MS) {
          opacity = 1.0 - (videoTimeMs - fadeOutStart) / TYPE_FADE_OUT_MS;
        } else {
          opacity = 0;
        }
      }
    } else if (currentIsType) {
      // Currently typing: keep cursor hidden during text entry, then smoothly fade back in
      // right as the cursor starts moving toward the next UI element.
      const fadeInStart = Math.max(currentRestTime, moveStart - TYPE_FADE_IN_LEAD_MS);
      const fadeInEnd = Math.min(arrivalTime, moveStart + 120);

      if (videoTimeMs >= fadeInEnd) {
        opacity = 1.0;
      } else if (videoTimeMs >= fadeInStart) {
        opacity = (videoTimeMs - fadeInStart) / Math.max(1, fadeInEnd - fadeInStart);
      } else if (currentAlreadyHiddenFromPrevClick) {
        opacity = 0;
      } else {
        const fadeOutStart = currentRestTime + TYPE_HIDE_DELAY_MS;
        if (videoTimeMs <= fadeOutStart) {
          opacity = 1.0;
        } else if (videoTimeMs < fadeOutStart + TYPE_FADE_OUT_MS) {
          opacity = 1.0 - (videoTimeMs - fadeOutStart) / TYPE_FADE_OUT_MS;
        } else {
          opacity = 0;
        }
      }
    } else if (rawGap >= IDLE_FADE_THRESHOLD_MS) {
      const fadeOutStart = currentRestTime + POST_ACTION_HOLD_MS;
      const fadeInStart = moveStart - PRE_TRAVEL_FADE_IN_MS;
      if (videoTimeMs <= fadeOutStart) {
        opacity = 1.0;
      } else if (videoTimeMs < fadeOutStart + FADE_DURATION_MS) {
        opacity = 1.0 - (videoTimeMs - fadeOutStart) / FADE_DURATION_MS;
      } else if (videoTimeMs < fadeInStart) {
        opacity = 0;
      } else if (videoTimeMs < moveStart) {
        opacity = (videoTimeMs - fadeInStart) / Math.max(1, moveStart - fadeInStart);
      } else {
        opacity = 1.0;
      }
    } else {
      opacity = 1.0;
    }
  }

  // Click animation: begins CLICK_LEAD_MS (60ms) before m.timestamp so the cursor
  // reaches full press-down at m.timestamp (exact frame of DOM click)
  let isClick = false;
  let clickProgress = 0;
  for (let i = 0; i < cursorMoments.length; i++) {
    const m = cursorMoments[i];
    const prevM = i > 0 ? cursorMoments[i - 1] : undefined;
    if (isMomentClickable(m, prevM)) {
      const clickStart = m.timestamp - CLICK_LEAD_MS;
      const elapsed = videoTimeMs - clickStart;
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

  // Click scale animation: press down (0 -> 0.22), hold pressed (0.22 -> 0.55), release (0.55 -> 1.0)
  let cursorScale = 1;
  if (isClick) {
    if (clickProgress < 0.22) {
      cursorScale = 1 - (1 - CLICK_SCALE_MIN) * (clickProgress / 0.22);
    } else if (clickProgress < 0.55) {
      cursorScale = CLICK_SCALE_MIN;
    } else {
      cursorScale =
        CLICK_SCALE_MIN +
        (1 - CLICK_SCALE_MIN) * ((clickProgress - 0.55) / 0.45);
    }
  }

  // Click ring animation: starts expanding as press hits bottom (progress >= 0.15)
  const ringProgress = isClick ? Math.max(0, (clickProgress - 0.12) / 0.88) : 0;
  const ringOpacity = isClick && clickProgress >= 0.12 ? Math.max(0, 0.85 * (1 - ringProgress)) : 0;
  const ringScale = 0.6 + ringProgress * 1.9;

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
            width: 26,
            height: 26,
            borderRadius: "50%",
            border: "2.5px solid rgba(59, 130, 246, 0.9)",
            backgroundColor: "rgba(147, 197, 253, 0.28)",
            boxShadow: "0 0 8px rgba(59, 130, 246, 0.45)",
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
          filter: "drop-shadow(0 2px 4px rgba(0,0,0,0.35))",
        }}
      >
        <path
          d={CURSOR_PATH}
          fill={isClick && clickProgress >= 0.15 && clickProgress < 0.55 ? "#2563EB" : "#FFFFFF"}
          stroke="#1E293B"
          strokeWidth={2}
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
};


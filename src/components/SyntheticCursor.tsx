import React from "react";
import { useCurrentFrame, Easing } from "remotion";
import type { Moment } from "../types";
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
  editPlan: EditPlan;
  windowWidth: number;
  windowHeight: number;
  viewportWidth: number;
  viewportHeight: number;
}

// Default fallback values if not specified in browse-plan/edit-plan
const DEFAULT_CURSOR_DELAY_MS = -700;
const DEFAULT_PRE_CLICK_REST_MS = 0;

// Click animation phases
const CLICK_PRESS_MS = 100;
const CLICK_RELEASE_MS = 160;

// Dynamic travel duration based on distance (Fitts's Law principle)
// Slower and smoother travel: min 350ms, max 750ms
function getTravelDuration(x1: number, y1: number, x2: number, y2: number): number {
  const d = Math.hypot(x2 - x1, y2 - y1);
  return Math.min(750, Math.max(350, Math.round(280 + Math.sqrt(d) * 14)));
}

function getCursorState(
  videoTimeMs: number,
  moments: Moment[],
  cursorDelayMs: number,
  preClickRestMs: number
): {
  x: number;
  y: number;
  visible: boolean;
  isClick: boolean;
  cursorScale: number;
  ringOpacity: number;
  ringScale: number;
} {
  const cursorMoments = moments.filter(
    (m) =>
      m.cursor &&
      m.timestamp > 0 &&
      (m.type === "click" || m.type === "hover" || m.type === "scroll" || m.type === "type")
  );

  if (cursorMoments.length === 0) {
    return {
      x: 0,
      y: 0,
      visible: false,
      isClick: false,
      cursorScale: 1,
      ringOpacity: 0,
      ringScale: 1,
    };
  }

  const getMomentTime = (m: Moment) => m.timestamp + cursorDelayMs;

  // Show cursor at lead-in start, giving breathing room at the beginning of the video
  const firstTime = getMomentTime(cursorMoments[0]);
  const leadDuration = 900;
  // If first action is after 2000ms, ensure cursor doesn't start moving before 2000ms
  const leadStart =
    firstTime >= 2000
      ? Math.max(2000, firstTime - leadDuration)
      : Math.max(0, firstTime - leadDuration);

  if (videoTimeMs < leadStart) {
    return {
      x: 0,
      y: 0,
      visible: false,
      isClick: false,
      cursorScale: 1,
      ringOpacity: 0,
      ringScale: 1,
    };
  }

  // Lead-in: glide from center to first target over leadDuration
  if (videoTimeMs < firstTime) {
    const actualLead = Math.max(100, firstTime - leadStart);
    const t = (videoTimeMs - leadStart) / actualLead;
    const eased = Easing.out(Easing.cubic)(Math.min(1, Math.max(0, t)));
    const x = 960 + (cursorMoments[0].cursor!.x - 960) * eased;
    const y = 540 + (cursorMoments[0].cursor!.y - 540) * eased;
    return {
      x,
      y,
      visible: true,
      isClick: false,
      cursorScale: 1,
      ringOpacity: 0,
      ringScale: 1,
    };
  }

  // Find which moment we're at or between
  let currentIdx = 0;
  for (let i = 0; i < cursorMoments.length; i++) {
    if (getMomentTime(cursorMoments[i]) <= videoTimeMs) {
      currentIdx = i;
    }
  }

  const current = cursorMoments[currentIdx];
  const next = cursorMoments[currentIdx + 1];

  let x: number;
  let y: number;

  if (!next) {
    // Past the last cursor moment: hold at last position
    x = current.cursor!.x;
    y = current.cursor!.y;
  } else {
    const currentT = getMomentTime(current);
    const nextT = getMomentTime(next);

    // Distance-adaptive travel and gap-aware pre-click rest
    const travelMs = getTravelDuration(
      current.cursor!.x,
      current.cursor!.y,
      next.cursor!.x,
      next.cursor!.y
    );

    // If next moment is a click, cursor must arrive BEFORE the click press begins
    const nextActionStart = next.type === "click" ? nextT - CLICK_PRESS_MS : nextT;
    const availableGap = Math.max(50, nextActionStart - currentT);
    const restMs = Math.min(preClickRestMs, availableGap * 0.25);
    const actualTravel = Math.min(travelMs, availableGap - restMs);

    const moveStart = nextActionStart - (actualTravel + restMs);
    const moveEnd = nextActionStart - restMs;

    if (videoTimeMs < moveStart) {
      // Holding at current position
      x = current.cursor!.x;
      y = current.cursor!.y;
    } else if (videoTimeMs < moveEnd) {
      // Moving toward next position
      const t = (videoTimeMs - moveStart) / actualTravel;
      const eased = Easing.inOut(Easing.cubic)(Math.min(1, Math.max(0, t)));
      x = current.cursor!.x + (next.cursor!.x - current.cursor!.x) * eased;
      y = current.cursor!.y + (next.cursor!.y - current.cursor!.y) * eased;
    } else {
      // Resting on target before the action
      x = next.cursor!.x;
      y = next.cursor!.y;
    }
  }

  // Click animation: centered so that peak click is EXACTLY at m.timestamp
  let isClick = false;
  let cursorScale = 1;
  let ringOpacity = 0;
  let ringScale = 1;

  for (const m of cursorMoments) {
    if (m.type === "click") {
      const peakTime = getMomentTime(m);
      const clickStart = peakTime - CLICK_PRESS_MS;
      const clickEnd = peakTime + CLICK_RELEASE_MS;

      if (videoTimeMs >= clickStart && videoTimeMs < clickEnd) {
        isClick = true;
        if (videoTimeMs < peakTime) {
          // Press down phase (1.0 -> CLICK_SCALE_MIN)
          const pressT = (videoTimeMs - clickStart) / CLICK_PRESS_MS;
          cursorScale = 1 - (1 - CLICK_SCALE_MIN) * pressT;
          ringOpacity = 0;
          ringScale = 1;
        } else {
          // Release phase (CLICK_SCALE_MIN -> 1.0) & ring expansion
          const releaseT = (videoTimeMs - peakTime) / CLICK_RELEASE_MS;
          cursorScale = CLICK_SCALE_MIN + (1 - CLICK_SCALE_MIN) * releaseT;
          ringOpacity = Math.max(0, 0.7 * (1 - releaseT));
          ringScale = 1 + releaseT * 2.0;
        }
        break;
      }
    }
  }

  return { x, y, visible: true, isClick, cursorScale, ringOpacity, ringScale };
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

  const cursorDelayMs =
    editPlan.cursor?.delayMs ?? DEFAULT_CURSOR_DELAY_MS;

  const preClickRestMs =
    editPlan.cursor?.preClickRestMs ?? DEFAULT_PRE_CLICK_REST_MS;

  const { x, y, visible, isClick, cursorScale, ringOpacity, ringScale } = getCursorState(
    videoTimeMs,
    moments,
    cursorDelayMs,
    preClickRestMs
  );

  if (!visible) return null;

  // Scale cursor coords from viewport space to window space
  const scaleX = windowWidth / viewportWidth;
  const scaleY = windowHeight / viewportHeight;
  const screenX = x * scaleX;
  const screenY = y * scaleY;

  return (
    <div
      style={{
        position: "absolute",
        left: screenX,
        top: screenY,
        transform: `translate(-4px, -2px)`,
        pointerEvents: "none",
        zIndex: 100,
      }}
    >
      {isClick && ringOpacity > 0 && (
        <div
          style={{
            position: "absolute",
            left: 4,
            top: 2,
            width: 20,
            height: 20,
            borderRadius: "50%",
            border: "2px solid rgba(255,255,255,0.8)",
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
        style={{ transform: `scale(${cursorScale})`, transformOrigin: "top left" }}
      >
        <path
          d={CURSOR_PATH}
          fill={isClick && cursorScale < 0.95 ? "#333333" : "#FFFFFF"}
          stroke="#333333"
          strokeWidth={2}
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
};

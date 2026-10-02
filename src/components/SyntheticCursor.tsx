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
// Playwright recordings are already time-synced with recording.mp4, so default offset is 0.
const DEFAULT_CURSOR_DELAY_MS = 0;
const DEFAULT_PRE_CLICK_REST_MS = 120;

// Click animation phases
const CLICK_PRESS_MS = 100;
const CLICK_RELEASE_MS = 160;

// Dynamic travel duration based on distance (Fitts's Law principle)
function getTravelDuration(x1: number, y1: number, x2: number, y2: number): number {
  const d = Math.hypot(x2 - x1, y2 - y1);
  return Math.min(650, Math.max(300, Math.round(240 + Math.sqrt(d) * 12)));
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
      m.cursor.x > 0 &&
      m.cursor.y > 0 &&
      (m.type === "click" || m.type === "hover" || m.type === "scroll" || m.type === "type" || m.type === "dblclick")
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

  const getMomentTime = (m: Moment) => Math.max(0, m.timestamp + cursorDelayMs);

  const firstTime = getMomentTime(cursorMoments[0]);
  const leadDuration = 800;
  const leadStart = Math.max(0, firstTime - leadDuration);

  // Hidden before lead-in start
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

  let x: number;
  let y: number;

  if (videoTimeMs < firstTime) {
    // [Phase 1: 최초 리드인] 영상 초반 중앙에서 첫 번째 대상 버튼으로 부드럽게 글라이딩 이동
    const actualLead = Math.max(100, firstTime - leadStart);
    const t = Math.min(1, Math.max(0, (videoTimeMs - leadStart) / actualLead));
    const eased = Easing.out(Easing.cubic)(t);
    x = 960 + (cursorMoments[0].cursor!.x - 960) * eased;
    y = 540 + (cursorMoments[0].cursor!.y - 540) * eased;
  } else {
    // Find which action we're at or between
    let currentIdx = 0;
    for (let i = 0; i < cursorMoments.length; i++) {
      if (getMomentTime(cursorMoments[i]) <= videoTimeMs) {
        currentIdx = i;
      }
    }

    const current = cursorMoments[currentIdx];
    const next = cursorMoments[currentIdx + 1];

    if (!next) {
      // 마지막 액션 완료 후: 마지막 위치에 자연스럽게 머무름
      x = current.cursor!.x;
      y = current.cursor!.y;
    } else {
      const currentT = getMomentTime(current);
      const nextT = getMomentTime(next);

      // 거리 기반 자연스러운 이동 시간 (최소 300ms ~ 최대 650ms)
      const travelMs = getTravelDuration(
        current.cursor!.x,
        current.cursor!.y,
        next.cursor!.x,
        next.cursor!.y
      );

      const isNextClick = next.type === "click" || next.type === "dblclick";
      const nextActionStart = isNextClick ? nextT - CLICK_PRESS_MS : nextT;
      const availableGap = Math.max(50, nextActionStart - currentT);

      // 목표 버튼 위 사전 안착 시간 (안정적인 느낌 부여)
      const settleMs = Math.min(120, Math.max(30, availableGap * 0.15));
      const actualTravel = Math.min(travelMs, Math.max(80, availableGap - settleMs));

      // moveStart: [시나리오에 있는 정보대로 마우스도 기다리고]
      // 이전 액션 이후 화면 로딩/대기 중에는 이전 위치에 가만히 머물러 있음
      const moveStart = nextActionStart - (actualTravel + settleMs);
      const moveEnd = nextActionStart - settleMs;

      if (videoTimeMs < moveStart) {
        // 대기 상태 (이전 위치 유지)
        x = current.cursor!.x;
        y = current.cursor!.y;
      } else if (videoTimeMs < moveEnd) {
        // [클릭하기 전에 움직여서]: 목표 버튼으로 부드럽게 곡선 이동
        const t = (videoTimeMs - moveStart) / actualTravel;
        const eased = Easing.inOut(Easing.cubic)(Math.min(1, Math.max(0, t)));
        x = current.cursor!.x + (next.cursor!.x - current.cursor!.x) * eased;
        y = current.cursor!.y + (next.cursor!.y - current.cursor!.y) * eased;
      } else {
        // [목표 버튼 안착]: 클릭 직전 목표 위치에 정확히 안착
        x = next.cursor!.x;
        y = next.cursor!.y;
      }
    }
  }

  // [클릭 시나리오일 때 클릭]: 정확한 타임스탬프에 꾹 누르고 링 이펙트 방출
  let isClick = false;
  let cursorScale = 1;
  let ringOpacity = 0;
  let ringScale = 1;

  for (const m of cursorMoments) {
    if (m.type === "click" || m.type === "dblclick") {
      const peakTime = getMomentTime(m);
      const clickStart = peakTime - CLICK_PRESS_MS;
      const clickEnd = peakTime + CLICK_RELEASE_MS;

      if (videoTimeMs >= clickStart && videoTimeMs < clickEnd) {
        isClick = true;
        if (videoTimeMs < peakTime) {
          // 누름 단계 (1.0 -> 0.88)
          const pressT = (videoTimeMs - clickStart) / CLICK_PRESS_MS;
          cursorScale = 1 - (1 - CLICK_SCALE_MIN) * pressT;
          ringOpacity = 0;
          ringScale = 1;
        } else {
          // 릴리즈 단계 (0.88 -> 1.0) & 링 확산 애니메이션
          const releaseT = (videoTimeMs - peakTime) / CLICK_RELEASE_MS;
          cursorScale = CLICK_SCALE_MIN + (1 - CLICK_SCALE_MIN) * releaseT;
          ringOpacity = Math.max(0, 0.8 * (1 - releaseT));
          ringScale = 1 + releaseT * 2.2;
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

  const rawDelayMs = editPlan.cursor?.delayMs ?? DEFAULT_CURSOR_DELAY_MS;
  // Safety guard: legacy +800 or -700 hardcoded values from old templates are normalized to 0
  const cursorDelayMs = rawDelayMs === 800 || rawDelayMs === -700 ? 0 : rawDelayMs;

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
        transform: `translate(-2px, -2px)`,
        pointerEvents: "none",
        zIndex: 100,
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

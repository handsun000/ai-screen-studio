import React from "react";

interface FloatingWindowProps {
  width: number;
  height: number;
  windowWidth?: number;
  windowHeight?: number;
  fullBleed?: boolean;
  children?: React.ReactNode;
}

export const WINDOW_WIDTH = 1632;
export const WINDOW_HEIGHT = 918;
export const WINDOW_BORDER_RADIUS = 12;

export function getFloatingWindowDimensions(
  viewportWidth?: number,
  viewportHeight?: number
): { windowWidth: number; windowHeight: number } {
  const vw = viewportWidth && viewportWidth > 0 ? viewportWidth : 1920;
  const vh = viewportHeight && viewportHeight > 0 ? viewportHeight : 1080;
  const aspect = vw / vh;
  const boxAspect = WINDOW_WIDTH / WINDOW_HEIGHT;
  if (Math.abs(aspect - boxAspect) < 0.005) {
    return { windowWidth: WINDOW_WIDTH, windowHeight: WINDOW_HEIGHT };
  }
  if (aspect >= boxAspect) {
    return {
      windowWidth: WINDOW_WIDTH,
      windowHeight: Math.round(WINDOW_WIDTH / aspect),
    };
  }
  return {
    windowWidth: Math.round(WINDOW_HEIGHT * aspect),
    windowHeight: WINDOW_HEIGHT,
  };
}

export const FloatingWindow: React.FC<FloatingWindowProps> = ({
  width,
  height,
  windowWidth = WINDOW_WIDTH,
  windowHeight = WINDOW_HEIGHT,
  fullBleed = false,
  children,
}) => {
  const effectiveW = fullBleed ? width : windowWidth;
  const effectiveH = fullBleed ? height : windowHeight;
  return (
    <div
      style={{
        position: "absolute",
        left: (width - effectiveW) / 2,
        top: (height - effectiveH) / 2,
        width: effectiveW,
        height: effectiveH,
        borderRadius: fullBleed ? 0 : WINDOW_BORDER_RADIUS,
        overflow: "hidden",
        boxShadow: fullBleed ? "none" : "0 24px 80px rgba(0,0,0,0.5)",
      }}
    >
      {children}
    </div>
  );
};

import React from "react";

interface FloatingWindowProps {
  width: number;
  height: number;
  windowWidth?: number;
  windowHeight?: number;
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
  children,
}) => {
  return (
    <div
      style={{
        position: "absolute",
        left: (width - windowWidth) / 2,
        top: (height - windowHeight) / 2,
        width: windowWidth,
        height: windowHeight,
        borderRadius: WINDOW_BORDER_RADIUS,
        overflow: "hidden",
        boxShadow: "0 24px 80px rgba(0,0,0,0.5)",
      }}
    >
      {children}
    </div>
  );
};

// -- Browse Plan (input to record script) --

export interface BrowsePlanAction {
  type: "navigate" | "click" | "dblclick" | "hover" | "scroll" | "wait" | "script" | "type" | "upload";
  filePath?: string;
  force?: boolean;
  url?: string;
  selector?: string;
  iframe?: string;
  text?: string;
  optional?: boolean;
  deltaY?: number;
  ms?: number;
  js?: string;
  description: string;
  cursorOffset?: { x: number; y: number };
}

export interface CursorSettings {
  delayMs?: number;
  preClickRestMs?: number;
}

export interface BrowsePlan {
  url: string;
  viewport: { width: number; height: number };
  requiresLogin?: boolean;
  cursor?: CursorSettings;
  actions: BrowsePlanAction[];
}

// -- Moments (output from record script) --

export interface MomentsMetadata {
  url: string;
  viewportWidth: number;
  viewportHeight: number;
  totalDurationMs: number;
  recordingStart: string;
  cursor?: CursorSettings;
}

export interface CursorPosition {
  x: number;
  y: number;
}

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Moment {
  id: number;
  type: "navigate" | "click" | "dblclick" | "hover" | "scroll" | "wait" | "script" | "drag" | "type" | "key" | "upload";
  timestamp: number;
  url?: string;
  cursor?: CursorPosition;
  target?: BoundingBox;
  scrollDelta?: { x: number; y: number };
  dragFrom?: CursorPosition;
  dragTo?: CursorPosition;
  keys?: string;
  stayedInArea?: boolean;
  maxDriftPx?: number;
  description: string;
}

export interface MomentsFile {
  metadata: MomentsMetadata;
  moments: Moment[];
}

// -- Edit Plan (drives Remotion composition) --

export interface TimeRegion {
  videoStartFrame: number;
  videoEndFrame: number;
  compStartFrame: number;
  compEndFrame: number;
  speed: number;
}

export interface EditSegment {
  momentId: number;
  startFrame: number;
  endFrame: number;
  speed: number;
  zoom: number;
  zoomTarget: CursorPosition | null;
  zoomTargetEnd?: CursorPosition;
  easeInFrames?: number;
  easeOutFrames?: number;
  description: string;
}

export interface EditPlan {
  totalDurationFrames: number;
  fps: number;
  defaultZoom: number;
  timeRegions?: TimeRegion[];
  segments: EditSegment[];
  cursor?: CursorSettings;
}

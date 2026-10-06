// -- Browse Plan (input to record script) --

export interface BrowsePlanAction {
  type: "navigate" | "click" | "dblclick" | "hover" | "scroll" | "wait" | "script" | "type" | "upload" | "scrape";
  filePath?: string;
  force?: boolean;
  url?: string;
  selector?: string;
  iframe?: string;
  text?: string;
  /** @deprecated 건너뛰기(optional) 기능 제거됨 - 모든 액션은 100% 실제로 실행되어야 합니다. */
  optional?: boolean;
  deltaY?: number;
  ms?: number;
  js?: string;
  description: string;
  cursorOffset?: { x: number; y: number };

  // Method 2: Dynamic Live Data Scraping & Variable Linking
  scrapeAs?: string;           // Variable name to store scraped text (e.g. "docTitle", "userName")
  useScraped?: string;         // Variable name to read text from for typing or matching (or "auto")
  dynamicFrom?: string;        // Specific selector to directly scrape live text from before typing
  dynamicStrategy?: "first-row-title" | "first-row-user" | "first-tree-node" | "auto";
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
  type: "navigate" | "click" | "dblclick" | "hover" | "scroll" | "wait" | "script" | "drag" | "type" | "key" | "upload" | "scrape";
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

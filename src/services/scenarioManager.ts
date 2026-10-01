import * as fs from "fs";
import * as path from "path";
import type { BrowsePlan, EditPlan, MomentsFile } from "../types";

const DATA_DIR = path.resolve(__dirname, "..", "..", "data");
const ROOT_TSX_PATH = path.resolve(__dirname, "..", "Root.tsx");

export interface ScenarioSummary {
  slug: string;
  hasBrowsePlan: boolean;
  hasMoments: boolean;
  hasEditPlan: boolean;
  hasVideo: boolean;
  videoSizeBytes?: number;
  actionsCount: number;
  zoomSegmentsCount: number;
  durationSec?: number;
  isActive: boolean;
  lastModified?: string;
}

export function getActiveSlug(): string {
  if (!fs.existsSync(ROOT_TSX_PATH)) return "";
  const content = fs.readFileSync(ROOT_TSX_PATH, "utf-8");
  const match = content.match(/from\s+["']\.\.\/data\/([^/]+)\/edit-plan\.json["']/);
  return match ? match[1] : "";
}

export function setActiveSlug(slug: string): boolean {
  if (!fs.existsSync(ROOT_TSX_PATH)) return false;
  let content = fs.readFileSync(ROOT_TSX_PATH, "utf-8");

  // Replace import paths
  content = content.replace(
    /from\s+["']\.\.\/data\/[^/]+\/edit-plan\.json["']/,
    `from "../data/${slug}/edit-plan.json"`
  );
  content = content.replace(
    /from\s+["']\.\.\/data\/[^/]+\/moments\.json["']/,
    `from "../data/${slug}/moments.json"`
  );

  fs.writeFileSync(ROOT_TSX_PATH, content, "utf-8");
  return true;
}

export function listScenarios(): ScenarioSummary[] {
  if (!fs.existsSync(DATA_DIR)) return [];

  const activeSlug = getActiveSlug();
  const entries = fs.readdirSync(DATA_DIR, { withFileTypes: true });

  const list: ScenarioSummary[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;

    const slug = entry.name;
    const dirPath = path.join(DATA_DIR, slug);

    const browsePlanPath = path.join(dirPath, "browse-plan.json");
    const momentsPath = path.join(dirPath, "moments.json");
    const editPlanPath = path.join(dirPath, "edit-plan.json");
    const videoPath = path.join(dirPath, "recording.mp4");

    const hasBrowsePlan = fs.existsSync(browsePlanPath);
    const hasMoments = fs.existsSync(momentsPath);
    const hasEditPlan = fs.existsSync(editPlanPath);
    const hasVideo = fs.existsSync(videoPath);

    let actionsCount = 0;
    let zoomSegmentsCount = 0;
    let durationSec = 0;
    let videoSizeBytes = 0;
    let lastModified = "";

    if (hasBrowsePlan) {
      try {
        const bp: BrowsePlan = JSON.parse(fs.readFileSync(browsePlanPath, "utf-8"));
        actionsCount = bp.actions?.length || 0;
      } catch {}
    }

    if (hasEditPlan) {
      try {
        const ep: EditPlan = JSON.parse(fs.readFileSync(editPlanPath, "utf-8"));
        zoomSegmentsCount = ep.segments?.length || 0;
        durationSec = ep.fps ? ep.totalDurationFrames / ep.fps : 0;
      } catch {}
    }

    if (hasVideo) {
      try {
        const stat = fs.statSync(videoPath);
        videoSizeBytes = stat.size;
        lastModified = stat.mtime.toISOString();
      } catch {}
    }

    list.push({
      slug,
      hasBrowsePlan,
      hasMoments,
      hasEditPlan,
      hasVideo,
      videoSizeBytes,
      actionsCount,
      zoomSegmentsCount,
      durationSec: Math.round(durationSec * 10) / 10,
      isActive: slug === activeSlug,
      lastModified,
    });
  }

  return list.sort((a, b) => (b.isActive ? 1 : 0) - (a.isActive ? 1 : 0));
}

export function getScenarioDetails(slug: string) {
  const dirPath = path.join(DATA_DIR, slug);
  if (!fs.existsSync(dirPath)) {
    throw new Error(`Scenario '${slug}' not found in data directory`);
  }

  let browsePlan: BrowsePlan | null = null;
  let moments: MomentsFile | null = null;
  let editPlan: EditPlan | null = null;

  const browsePlanPath = path.join(dirPath, "browse-plan.json");
  const momentsPath = path.join(dirPath, "moments.json");
  const editPlanPath = path.join(dirPath, "edit-plan.json");
  const videoPath = path.join(dirPath, "recording.mp4");

  if (fs.existsSync(browsePlanPath)) {
    try {
      browsePlan = JSON.parse(fs.readFileSync(browsePlanPath, "utf-8"));
    } catch {}
  }
  if (fs.existsSync(momentsPath)) {
    try {
      moments = JSON.parse(fs.readFileSync(momentsPath, "utf-8"));
    } catch {}
  }
  if (fs.existsSync(editPlanPath)) {
    try {
      editPlan = JSON.parse(fs.readFileSync(editPlanPath, "utf-8"));
    } catch {}
  }

  return {
    slug,
    browsePlan,
    moments,
    editPlan,
    hasVideo: fs.existsSync(videoPath),
    videoUrl: `/api/video/${slug}`,
    isActive: slug === getActiveSlug(),
  };
}

export function saveBrowsePlan(slug: string, plan: BrowsePlan) {
  const dirPath = path.join(DATA_DIR, slug);
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }

  const browsePlanPath = path.join(dirPath, "browse-plan.json");
  fs.writeFileSync(browsePlanPath, JSON.stringify(plan, null, 2), "utf-8");
  return { success: true, path: browsePlanPath };
}

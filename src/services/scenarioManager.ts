import * as fs from "fs";
import * as path from "path";
import type { BrowsePlan, EditPlan, MomentsFile, SiteBrandProfile } from "../types";
import { ensureSessionForSlug } from "./authManager";
import { sanitizeBrowsePlan } from "./planSanitizer";
import {
  getBaseDomainFromHostKey,
  resolveSiteBrandForScenario,
  syncBrandAssetsToPublicAndDashboard,
} from "./siteBrandService";

const DATA_DIR = path.resolve(__dirname, "..", "..", "data");
const BRANDS_ROOT = path.join(DATA_DIR, "_site_brands");
let currentActiveSlug = "";

export interface ScenarioSummary {
  slug: string;
  hasBrowsePlan: boolean;
  hasMoments: boolean;
  hasEditPlan: boolean;
  hasVideo: boolean;
  videoSizeBytes?: number;
  hasRenderedVideo?: boolean;
  renderedVideoSizeBytes?: number;
  hasNarration?: boolean;
  recordedByEyedropper?: boolean;
  mergedFromSlugs?: string[];
  flowSummary?: string;
  actionsCount: number;
  zoomSegmentsCount: number;
  durationSec?: number;
  isActive: boolean;
  lastModified?: string;
  domainKey?: string;
  hostKey?: string;
  siteName?: string;
  primaryColor?: string;
  logoUrl?: string;
}

export function extractHostAndDomainKey(rawUrlOrHost?: string): { hostKey: string; domainKey: string } {
  const raw = String(rawUrlOrHost || "").trim();
  if (!raw) return { hostKey: "", domainKey: "" };

  let host = raw;
  try {
    const parsed = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
    host = parsed.hostname || raw;
  } catch {
    host = raw
      .replace(/^https?:\/\//i, "")
      .split("/")[0]
      .split(":")[0]
      .replace(/_\d+$/, "");
  }

  const cleanHost = host
    .replace(/_\d+$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9.-]/g, "");
  if (!cleanHost) return { hostKey: "", domainKey: "" };

  if (/^\d+\.\d+\.\d+\.\d+$/.test(cleanHost) || cleanHost === "localhost") {
    return { hostKey: cleanHost, domainKey: cleanHost };
  }

  const parts = cleanHost.split(".").filter(Boolean);
  if (parts.length <= 2) {
    return { hostKey: cleanHost, domainKey: cleanHost };
  }

  const lastTwo = `${parts[parts.length - 2]}.${parts[parts.length - 1]}`;
  const multiLevelTlds = new Set([
    "ac.kr",
    "co.kr",
    "go.kr",
    "or.kr",
    "ne.kr",
    "re.kr",
    "pe.kr",
    "hs.kr",
    "ms.kr",
    "es.kr",
    "sc.kr",
    "kg.kr",
    "co.jp",
    "ac.jp",
    "ne.jp",
    "or.jp",
    "co.uk",
    "org.uk",
    "ac.uk",
    "com.au",
    "edu.au",
    "com.cn",
    "edu.cn",
  ]);

  const domainKey =
    multiLevelTlds.has(lastTwo) && parts.length >= 3
      ? `${parts[parts.length - 3]}.${lastTwo}`
      : lastTwo;

  return { hostKey: cleanHost, domainKey };
}

function loadMasterBrandMaps(): {
  byHost: Map<string, SiteBrandProfile>;
  byDomain: Map<string, SiteBrandProfile>;
} {
  const byHost = new Map<string, SiteBrandProfile>();
  const byDomain = new Map<string, SiteBrandProfile>();

  if (!fs.existsSync(BRANDS_ROOT)) {
    return { byHost, byDomain };
  }

  try {
    const entries = fs.readdirSync(BRANDS_ROOT, { withFileTypes: true });
    for (const ent of entries) {
      if (!ent.isDirectory() || ent.name.startsWith(".") || ent.name.startsWith("_")) continue;
      const brandPath = path.join(BRANDS_ROOT, ent.name, "brand.json");
      if (!fs.existsSync(brandPath)) continue;
      try {
        const brand: SiteBrandProfile = JSON.parse(fs.readFileSync(brandPath, "utf-8"));
        const synced = syncBrandAssetsToPublicAndDashboard(ent.name);
        if (synced.logoUrl) brand.logoUrl = synced.logoUrl;
        if (synced.heroThumbUrl) brand.heroThumbUrl = synced.heroThumbUrl;

        const { hostKey, domainKey } = extractHostAndDomainKey(brand.hostKey || ent.name || brand.originUrl);
        if (hostKey) byHost.set(hostKey, brand);
        byHost.set(ent.name.toLowerCase(), brand);
        if (domainKey) {
          const existing = byDomain.get(domainKey);
          if (!existing || (!existing.logoUrl && brand.logoUrl)) {
            byDomain.set(domainKey, brand);
          }
        }
      } catch {}
    }
  } catch {}

  return { byHost, byDomain };
}

export function getActiveSlug(): string {
  return currentActiveSlug;
}

export function setActiveSlug(slug: string): boolean {
  if (!slug) return false;
  currentActiveSlug = slug;
  return true;
}

export function listScenarios(): ScenarioSummary[] {
  if (!fs.existsSync(DATA_DIR)) return [];

  const activeSlug = getActiveSlug();
  const entries = fs.readdirSync(DATA_DIR, { withFileTypes: true });
  const { byHost: brandsByHost, byDomain: brandsByDomain } = loadMasterBrandMaps();

  const list: ScenarioSummary[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name.startsWith("_")) continue;

    const slug = entry.name;
    const dirPath = path.join(DATA_DIR, slug);

    const browsePlanPath = path.join(dirPath, "browse-plan.json");
    const momentsPath = path.join(dirPath, "moments.json");
    const editPlanPath = path.join(dirPath, "edit-plan.json");
    const narrationPath = path.join(dirPath, "narration.json");
    const videoPath = path.join(dirPath, "recording.mp4");
    const renderedVideoPath = path.join(path.resolve(__dirname, "..", "..", "output"), `${slug}.mp4`);

    const hasBrowsePlan = fs.existsSync(browsePlanPath);
    const hasMoments = fs.existsSync(momentsPath);
    const hasEditPlan = fs.existsSync(editPlanPath);
    const hasNarration = fs.existsSync(narrationPath);
    const hasVideo = fs.existsSync(videoPath);
    let hasRenderedVideo = fs.existsSync(renderedVideoPath);

    if (!hasBrowsePlan && !hasMoments && !hasEditPlan && !hasNarration && !hasVideo && !hasRenderedVideo) {
      continue;
    }

    let actionsCount = 0;
    let zoomSegmentsCount = 0;
    let durationSec = 0;
    let videoSizeBytes = 0;
    let renderedVideoSizeBytes = 0;
    let lastModified = "";
    let recordedByEyedropper = false;
    let mergedFromSlugs: string[] | undefined = undefined;
    let flowSummary = "";
    let candidateUrl = "";
    let inlineBrand: SiteBrandProfile | null = null;

    if (hasNarration) {
      try {
        const nar: any = JSON.parse(fs.readFileSync(narrationPath, "utf-8"));
        if (Array.isArray(nar?.mergedFromSlugs) && nar.mergedFromSlugs.length > 0) {
          mergedFromSlugs = nar.mergedFromSlugs;
        }
        const sb = nar?.siteBrand || nar?.introToc?.siteBrand;
        if (sb && typeof sb === "object" && (sb.hostKey || sb.originUrl)) {
          inlineBrand = sb;
          candidateUrl = sb.originUrl || sb.hostKey || "";
        }
      } catch {}
    }

    if (hasBrowsePlan) {
      try {
        const bp: any = JSON.parse(fs.readFileSync(browsePlanPath, "utf-8"));
        actionsCount = bp.actions?.length || 0;
        recordedByEyedropper = Boolean(bp.recordedByEyedropper || bp.actions?.some((a: any) => a.recordedByEyedropper));
        if (Array.isArray(bp.mergedFromSlugs) && bp.mergedFromSlugs.length > 0) {
          mergedFromSlugs = bp.mergedFromSlugs;
        }
        const stat = fs.statSync(browsePlanPath);
        lastModified = stat.mtime.toISOString();

        if (!candidateUrl && (!mergedFromSlugs || mergedFromSlugs.length === 0)) {
          const firstNavUrl = bp.actions?.find((a: any) => a?.url && /^https?:\/\//i.test(String(a.url)))?.url;
          candidateUrl = firstNavUrl || bp.baseUrl || bp.url || "";
        }

        if (mergedFromSlugs && mergedFromSlugs.length > 0) {
          flowSummary = `🔗 챕터 병합 (${mergedFromSlugs.length}개): ${mergedFromSlugs.join(" ➔ ")}`;
        } else {
          // Build a concise human-readable flow summary from non-wait actions
          const meaningfulSteps = (bp.actions || [])
            .filter((a: any) => a.type !== "wait")
            .map((a: any) => {
              const d = (a.description || "").trim();
              const quoted = d.match(/'([^']+)'/);
              if (quoted && quoted[1].length >= 2 && quoted[1].length <= 18) {
                return a.type === "type" ? `'${quoted[1]}' 입력` : quoted[1];
              }
              return d.replace(/\s*(?:메뉴\/링크\s*클릭|버튼\s*클릭|클릭|반응\s*대기)$/g, "").slice(0, 18);
            })
            .filter(Boolean);
          const dedupedSteps: string[] = [];
          for (const s of meaningfulSteps) {
            if (dedupedSteps[dedupedSteps.length - 1] !== s) {
              dedupedSteps.push(s);
            }
          }
          if (dedupedSteps.length > 0) {
            const picked =
              dedupedSteps.length <= 4
                ? dedupedSteps
                : [dedupedSteps[0], dedupedSteps[1], dedupedSteps[2], dedupedSteps[dedupedSteps.length - 1]];
            flowSummary = picked.join(" ➔ ");
          }
        }
      } catch {}
    }

    if (!candidateUrl && mergedFromSlugs && mergedFromSlugs.length > 0) {
      for (const chSlug of mergedFromSlugs) {
        const chNarPath = path.join(DATA_DIR, chSlug, "narration.json");
        const chBpPath = path.join(DATA_DIR, chSlug, "browse-plan.json");
        if (fs.existsSync(chNarPath)) {
          try {
            const chNar = JSON.parse(fs.readFileSync(chNarPath, "utf-8"));
            const chSb = chNar?.siteBrand || chNar?.introToc?.siteBrand;
            if (chSb && (chSb.hostKey || chSb.originUrl)) {
              if (!inlineBrand) inlineBrand = chSb;
              candidateUrl = chSb.originUrl || chSb.hostKey || "";
              break;
            }
          } catch {}
        }
        if (fs.existsSync(chBpPath)) {
          try {
            const chBp = JSON.parse(fs.readFileSync(chBpPath, "utf-8"));
            const chUrl =
              chBp?.actions?.find((a: any) => a?.url && /^https?:\/\//i.test(String(a.url)))?.url ||
              chBp?.baseUrl ||
              chBp?.url ||
              "";
            if (chUrl) {
              candidateUrl = chUrl;
              break;
            }
          } catch {}
        }
      }
    }

    if (!candidateUrl && hasMoments) {
      try {
        const mom: any = JSON.parse(fs.readFileSync(momentsPath, "utf-8"));
        candidateUrl = mom?.metadata?.baseUrl || mom?.url || "";
      } catch {}
    }

    const { hostKey, domainKey } = extractHostAndDomainKey(
      inlineBrand?.hostKey || inlineBrand?.originUrl || candidateUrl
    );
    const matchedBrand =
      (hostKey && brandsByHost.get(hostKey)) ||
      (domainKey && brandsByDomain.get(domainKey)) ||
      inlineBrand ||
      null;

    const resolvedSiteName =
      matchedBrand?.siteName && matchedBrand.siteName !== "그룹웨어"
        ? matchedBrand.siteName
        : domainKey || hostKey || "기타 시나리오";
    const resolvedPrimaryColor = matchedBrand?.primaryColor || "#0068FF";
    const resolvedLogoUrl = matchedBrand?.logoUrl || undefined;

    if (hasEditPlan) {
      try {
        const ep: EditPlan = JSON.parse(fs.readFileSync(editPlanPath, "utf-8"));
        zoomSegmentsCount = ep.segments?.length || 0;
        durationSec = ep.fps ? ep.totalDurationFrames / ep.fps : 0;
      } catch {}
    }

    let videoMtimeMs = 0;
    if (hasVideo) {
      try {
        const stat = fs.statSync(videoPath);
        videoSizeBytes = stat.size;
        videoMtimeMs = stat.mtimeMs;
        if (!lastModified || stat.mtime.toISOString() > lastModified) {
          lastModified = stat.mtime.toISOString();
        }
      } catch {}
    }

    if (hasRenderedVideo) {
      try {
        const stat = fs.statSync(renderedVideoPath);
        renderedVideoSizeBytes = stat.size;
        if (!lastModified || stat.mtime.toISOString() > lastModified) {
          lastModified = stat.mtime.toISOString();
        }
      } catch {
        hasRenderedVideo = false;
      }
    }

    list.push({
      slug,
      hasBrowsePlan,
      hasMoments,
      hasEditPlan,
      hasNarration,
      hasVideo,
      videoSizeBytes,
      hasRenderedVideo,
      renderedVideoSizeBytes,
      recordedByEyedropper,
      mergedFromSlugs,
      flowSummary,
      actionsCount,
      zoomSegmentsCount,
      durationSec: Math.round(durationSec * 10) / 10,
      isActive: slug === activeSlug,
      lastModified,
      domainKey: domainKey || "other",
      hostKey: hostKey || domainKey || "other",
      siteName: resolvedSiteName,
      primaryColor: resolvedPrimaryColor,
      logoUrl: resolvedLogoUrl,
    });
  }

  return list.sort((a, b) => {
    return (b.lastModified || "").localeCompare(a.lastModified || "");
  });
}

export function getScenarioDetails(slug: string) {
  const dirPath = path.join(DATA_DIR, slug);
  if (!fs.existsSync(dirPath)) {
    throw new Error(`Scenario '${slug}' not found in data directory`);
  }

  let browsePlan: any = null;
  let moments: MomentsFile | null = null;
  let editPlan: EditPlan | null = null;

  const browsePlanPath = path.join(dirPath, "browse-plan.json");
  const momentsPath = path.join(dirPath, "moments.json");
  const editPlanPath = path.join(dirPath, "edit-plan.json");
  const videoPath = path.join(dirPath, "recording.mp4");

  if (fs.existsSync(browsePlanPath)) {
    try {
      const rawPlan = JSON.parse(fs.readFileSync(browsePlanPath, "utf-8"));
      if (Array.isArray(rawPlan.mergedFromSlugs) && rawPlan.mergedFromSlugs.length > 0) {
        browsePlan = rawPlan;
      } else {
        const { plan: sanitized } = sanitizeBrowsePlan(rawPlan);
        browsePlan = sanitized;
      }
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

  const renderedVideoPath = path.join(path.resolve(__dirname, "..", "..", "output"), `${slug}.mp4`);
  const hasRenderedVideo = fs.existsSync(renderedVideoPath);

  const narrationPath = path.join(dirPath, "narration.json");
  let narration = null;
  if (fs.existsSync(narrationPath)) {
    try {
      narration = JSON.parse(fs.readFileSync(narrationPath, "utf-8"));
    } catch {}
  }

  const siteBrand = resolveSiteBrandForScenario(slug);
  const baseDomain = getBaseDomainFromHostKey(siteBrand.hostKey || siteBrand.originUrl);
  if (narration && typeof narration === "object" && (!narration.siteBrand || !narration.siteBrand.logoUrl)) {
    narration.siteBrand = siteBrand;
  }

  return {
    slug,
    browsePlan,
    moments,
    editPlan,
    narration,
    siteBrand,
    baseDomain,
    hasVideo: fs.existsSync(videoPath),
    videoUrl: `/api/video/${slug}`,
    hasRenderedVideo,
    renderedVideoUrl: hasRenderedVideo ? `/api/rendered-video/${slug}` : null,
    downloadUrl: hasRenderedVideo ? `/api/download/${slug}` : null,
    isActive: slug === getActiveSlug(),
  };
}

export function saveBrowsePlan(slug: string, plan: BrowsePlan) {
  const dirPath = path.join(DATA_DIR, slug);
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }

  const { plan: sanitized } = sanitizeBrowsePlan(plan);
  const browsePlanPath = path.join(dirPath, "browse-plan.json");
  fs.writeFileSync(browsePlanPath, JSON.stringify(sanitized, null, 2), "utf-8");

  // Automatically attach active auth session so recording never asks for login again
  try {
    ensureSessionForSlug(slug);
  } catch {}

  return { success: true, path: browsePlanPath, plan: sanitized };
}

export function deleteScenario(slug: string): { success: boolean; slug: string } {
  const cleanSlug = (slug || "").trim();
  if (!cleanSlug || !/^[a-zA-Z0-9_-]+$/.test(cleanSlug)) {
    throw new Error("유효하지 않은 시나리오 ID(slug)입니다.");
  }

  const rootDir = path.resolve(__dirname, "..", "..");
  const dirPath = path.join(DATA_DIR, cleanSlug);
  const renderedVideoPath = path.join(rootDir, "output", `${cleanSlug}.mp4`);
  const publicVideoPath = path.join(rootDir, "public", "videos", `${cleanSlug}.mp4`);
  const publicNarrationDir = path.join(rootDir, "public", "narration", cleanSlug);
  const bundleNarrationDir = path.join(
    rootDir,
    "node_modules",
    ".cache",
    "screen-demo-remotion-bundle",
    "public",
    "narration",
    cleanSlug
  );

  if (!fs.existsSync(dirPath) && !fs.existsSync(renderedVideoPath)) {
    throw new Error(`삭제할 시나리오('${cleanSlug}')가 존재하지 않습니다.`);
  }

  if (fs.existsSync(dirPath)) {
    fs.rmSync(dirPath, { recursive: true, force: true });
  }
  for (const vp of [renderedVideoPath, publicVideoPath]) {
    if (fs.existsSync(vp)) {
      try {
        fs.unlinkSync(vp);
      } catch {}
    }
  }
  for (const nd of [publicNarrationDir, bundleNarrationDir]) {
    if (fs.existsSync(nd)) {
      try {
        fs.rmSync(nd, { recursive: true, force: true });
      } catch {}
    }
  }

  if (currentActiveSlug === cleanSlug) {
    currentActiveSlug = "";
  }

  return { success: true, slug: cleanSlug };
}

import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";
import { chromium } from "playwright";
import type { BrowsePlan, MomentsFile, SiteBrandProfile } from "../types";
import { getConfig } from "./configManager";
import { generateAiContent } from "./aiClient";

const ROOT_DIR = path.resolve(__dirname, "..", "..");
const DATA_DIR = path.join(ROOT_DIR, "data");
const BRANDS_ROOT = path.join(DATA_DIR, "_site_brands");
const PUBLIC_SITES_DIR = path.join(ROOT_DIR, "public", "assets", "sites");
const DASHBOARD_SITES_DIR = path.join(ROOT_DIR, "dashboard", "assets", "sites");

export function getHostKeyFromUrl(rawUrl?: string): string {
  const fallbackUrl = getConfig().targetBaseUrl || "http://localhost";
  const candidate = (rawUrl || fallbackUrl).trim();
  try {
    const parsed = new URL(candidate.startsWith("http") ? candidate : `https://${candidate}`);
    const hostPort = parsed.port ? `${parsed.hostname}_${parsed.port}` : parsed.hostname;
    return hostPort.replace(/[^a-zA-Z0-9._-]/g, "_").toLowerCase() || "default_site";
  } catch {
    return (
      candidate
        .replace(/^https?:\/\//i, "")
        .split("/")[0]
        .replace(/[^a-zA-Z0-9._-]/g, "_")
        .toLowerCase() || "default_site"
    );
  }
}

export function getBaseDomainFromHostKey(rawUrlOrHost?: string): string {
  const raw = String(rawUrlOrHost || "").trim();
  if (!raw) return "";

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
  if (!cleanHost) return "";

  if (/^\d+\.\d+\.\d+\.\d+$/.test(cleanHost) || cleanHost === "localhost") {
    return cleanHost;
  }

  const parts = cleanHost.split(".").filter(Boolean);
  if (parts.length <= 2) {
    return cleanHost;
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

  return multiLevelTlds.has(lastTwo) && parts.length >= 3
    ? `${parts[parts.length - 3]}.${lastTwo}`
    : lastTwo;
}

export function deriveSecondaryAndAccentColors(primaryHex: string): {
  secondaryColor: string;
  accentColor: string;
} {
  const clean = normalizeHexColor(primaryHex, "#0068FF");
  const r = parseInt(clean.slice(1, 3), 16) || 0;
  const g = parseInt(clean.slice(3, 5), 16) || 104;
  const b = parseInt(clean.slice(5, 7), 16) || 255;

  const toHex = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  const secondaryColor = `#${toHex(r * 0.84)}${toHex(g * 0.76)}${toHex(b * 0.76)}`.toUpperCase();
  const accentColor = `#${toHex(Math.min(255, r * 1.06 + 18))}${toHex(
    Math.min(255, g * 1.12 + 24)
  )}${toHex(Math.min(255, b * 1.15 + 28))}`.toUpperCase();

  return { secondaryColor, accentColor };
}

export function findBestSiblingBrandForBaseDomain(hostKey: string): {
  siblingHostKey: string;
  profile: SiteBrandProfile;
  logoPath?: string;
  heroPath?: string;
} | null {
  const baseDomain = getBaseDomainFromHostKey(hostKey);
  if (!baseDomain || !fs.existsSync(BRANDS_ROOT)) return null;

  let best: {
    score: number;
    siblingHostKey: string;
    profile: SiteBrandProfile;
    logoPath?: string;
    heroPath?: string;
  } | null = null;

  try {
    const entries = fs.readdirSync(BRANDS_ROOT, { withFileTypes: true });
    for (const ent of entries) {
      if (!ent.isDirectory() || ent.name.startsWith(".") || ent.name.startsWith("_")) continue;
      const candHostKey = ent.name;
      const candDomain = getBaseDomainFromHostKey(candHostKey);
      if (candDomain !== baseDomain) continue;

      const brandJsonPath = path.join(BRANDS_ROOT, candHostKey, "brand.json");
      if (!fs.existsSync(brandJsonPath)) continue;

      try {
        const profile: SiteBrandProfile = JSON.parse(fs.readFileSync(brandJsonPath, "utf-8"));
        const candLogo = path.join(BRANDS_ROOT, candHostKey, "logo.png");
        const candHero = path.join(BRANDS_ROOT, candHostKey, "hero.png");
        const hasLogo = fs.existsSync(candLogo) && fs.statSync(candLogo).size > 100;
        const hasHero = fs.existsSync(candHero) && fs.statSync(candHero).size > 500;
        const hasRealSiteName = Boolean(profile.siteName && profile.siteName !== "그룹웨어");
        const isDullFallback = profile.primaryColor === "#814804";

        let score = 0;
        if (hasLogo) score += 100;
        if (hasRealSiteName) score += 50;
        if (profile.primaryColor && !isDullFallback && profile.primaryColor !== "#0068FF") score += 30;
        if (hasHero) score += 15;
        if (candHostKey !== hostKey) score += 5;

        if (!best || score > best.score) {
          best = {
            score,
            siblingHostKey: candHostKey,
            profile,
            logoPath: hasLogo ? candLogo : undefined,
            heroPath: hasHero ? candHero : undefined,
          };
        }
      } catch {}
    }
  } catch {}

  return best
    ? {
        siblingHostKey: best.siblingHostKey,
        profile: best.profile,
        logoPath: best.logoPath,
        heroPath: best.heroPath,
      }
    : null;
}

function normalizeHexColor(input: string | undefined, fallback: string): string {
  const clean = String(input || "").trim();
  if (/^#[0-9a-fA-F]{6}$/.test(clean)) {
    return clean.toUpperCase();
  }
  if (/^#[0-9a-fA-F]{3}$/.test(clean)) {
    const r = clean[1];
    const g = clean[2];
    const b = clean[3];
    return `#${r}${r}${g}${g}${b}${b}`.toUpperCase();
  }
  return fallback;
}

function stripVersionInfo(text: string): string {
  return String(text || "")
    .replace(/\b(?:ver\.?|v\.?)\s*\d+(?:\.\d+)*\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function syncBrandAssetsToPublicAndDashboard(hostKey: string): {
  logoUrl?: string;
  heroThumbUrl?: string;
} {
  const brandDir = path.join(BRANDS_ROOT, hostKey);
  const pubDir = path.join(PUBLIC_SITES_DIR, hostKey);
  const dashDir = path.join(DASHBOARD_SITES_DIR, hostKey);

  fs.mkdirSync(pubDir, { recursive: true });
  fs.mkdirSync(dashDir, { recursive: true });

  let logoUrl: string | undefined;
  let heroThumbUrl: string | undefined;

  const srcLogo = path.join(brandDir, "logo.png");
  if (fs.existsSync(srcLogo) && fs.statSync(srcLogo).size > 100) {
    try {
      fs.copyFileSync(srcLogo, path.join(pubDir, "logo.png"));
      fs.copyFileSync(srcLogo, path.join(dashDir, "logo.png"));
      logoUrl = `/assets/sites/${hostKey}/logo.png`;
    } catch {}
  }

  const srcHero = path.join(brandDir, "hero.png");
  if (fs.existsSync(srcHero) && fs.statSync(srcHero).size > 500) {
    try {
      fs.copyFileSync(srcHero, path.join(pubDir, "hero.png"));
      fs.copyFileSync(srcHero, path.join(dashDir, "hero.png"));
      heroThumbUrl = `/assets/sites/${hostKey}/hero.png`;
    } catch {}
  }

  return { logoUrl, heroThumbUrl };
}

export function getCachedSiteBrand(rawUrl?: string): SiteBrandProfile | null {
  const hostKey = getHostKeyFromUrl(rawUrl);
  const brandDir = path.join(BRANDS_ROOT, hostKey);
  const brandJsonPath = path.join(brandDir, "brand.json");
  const logoPath = path.join(brandDir, "logo.png");
  const heroPath = path.join(brandDir, "hero.png");

  const sibling = findBestSiblingBrandForBaseDomain(hostKey);

  if (!fs.existsSync(brandJsonPath)) {
    if (sibling) {
      fs.mkdirSync(brandDir, { recursive: true });
      if (sibling.logoPath && !fs.existsSync(logoPath)) {
        try {
          fs.copyFileSync(sibling.logoPath, logoPath);
        } catch {}
      }
      if (sibling.heroPath && !fs.existsSync(heroPath)) {
        try {
          fs.copyFileSync(sibling.heroPath, heroPath);
        } catch {}
      }
      const synced = syncBrandAssetsToPublicAndDashboard(hostKey);
      const inherited: SiteBrandProfile = {
        ...sibling.profile,
        hostKey,
        originUrl: rawUrl || sibling.profile.originUrl,
        logoUrl: synced.logoUrl || sibling.profile.logoUrl,
        heroThumbUrl: synced.heroThumbUrl || sibling.profile.heroThumbUrl,
      };
      try {
        fs.writeFileSync(brandJsonPath, JSON.stringify(inherited, null, 2), "utf-8");
      } catch {}
      return inherited;
    }
    return null;
  }

  try {
    const profile: SiteBrandProfile = JSON.parse(fs.readFileSync(brandJsonPath, "utf-8"));
    let updatedBySibling = false;

    if (sibling && sibling.siblingHostKey !== hostKey) {
      if (sibling.logoPath && (!fs.existsSync(logoPath) || fs.statSync(logoPath).size <= 100)) {
        try {
          fs.copyFileSync(sibling.logoPath, logoPath);
          updatedBySibling = true;
        } catch {}
      }
      if (
        (!profile.siteName || profile.siteName === "그룹웨어") &&
        sibling.profile.siteName &&
        sibling.profile.siteName !== "그룹웨어"
      ) {
        profile.siteName = sibling.profile.siteName;
        updatedBySibling = true;
      }
      if (
        (profile.primaryColor === "#814804" || !profile.primaryColor) &&
        sibling.profile.primaryColor &&
        sibling.profile.primaryColor !== "#814804"
      ) {
        profile.primaryColor = sibling.profile.primaryColor;
        profile.secondaryColor = sibling.profile.secondaryColor;
        profile.accentColor = sibling.profile.accentColor;
        updatedBySibling = true;
      }
    }

    const synced = syncBrandAssetsToPublicAndDashboard(hostKey);
    if (synced.logoUrl) profile.logoUrl = synced.logoUrl;
    if (synced.heroThumbUrl) profile.heroThumbUrl = synced.heroThumbUrl;

    if (updatedBySibling) {
      try {
        fs.writeFileSync(brandJsonPath, JSON.stringify(profile, null, 2), "utf-8");
      } catch {}
    }

    return profile;
  } catch {
    return null;
  }
}

/**
 * 실시간 브라우저 녹화 중(로그인 완료 후 메인 화면 진입 시점) 대상 사이트의
 * 실제 화면 썸네일(hero.png), 로고(logo.png), 테마 컬러를 마스터 폴더에 캡처합니다.
 */
export async function captureSiteBrandFromLivePage(page: any, targetUrl: string): Promise<void> {
  try {
    const hostKey = getHostKeyFromUrl(targetUrl || page.url());
    const brandDir = path.join(BRANDS_ROOT, hostKey);
    fs.mkdirSync(brandDir, { recursive: true });

    const heroPath = path.join(brandDir, "hero.png");
    const logoPath = path.join(brandDir, "logo.png");
    const domMetaPath = path.join(brandDir, "dom-meta.json");

    // 이미 마스터 썸네일과 브랜드 JSON이 모두 존재하면 재캡처 생략 (마스터 유지)
    if (fs.existsSync(heroPath) && fs.existsSync(path.join(brandDir, "brand.json"))) {
      return;
    }

    // HUD가 있다면 잠시 숨김 후 깨끗한 사이트 화면 캡처
    await page
      .evaluate(() => {
        const hud = document.getElementById("__sd_recorder_hud");
        if (hud) hud.style.display = "none";
      })
      .catch(() => {});

    await page.screenshot({ path: heroPath, type: "png" }).catch(() => {});

    await page
      .evaluate(() => {
        const hud = document.getElementById("__sd_recorder_hud");
        if (hud) hud.style.display = "";
      })
      .catch(() => {});

    // (로고 이미지는 ensureSiteBrandForScenario의 extractVisualBrandFromHeroPng에서
    //  배경 투명화 및 브랜드 컬러 매팅 처리를 거쳐 logo.png로 정밀 생성됨)

    // 페이지 타이틀 및 대표 헤더/버튼 테마 색상 추출 (tsx __name 헬퍼 주입 방지를 위해 문자열 평가식 사용)
    const domMeta = await page
      .evaluate(`(() => {
        function rgbToHex(rgbStr) {
          const m = String(rgbStr || "").match(/rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)(?:,\\s*([\\d.]+))?\\)/i);
          if (!m) return null;
          const r = Number(m[1]);
          const g = Number(m[2]);
          const b = Number(m[3]);
          const a = m[4] !== undefined ? Number(m[4]) : 1;
          if (a < 0.2) return null;
          const max = Math.max(r, g, b);
          const min = Math.min(r, g, b);
          if (max > 242 && min > 235) return null;
          if (max < 25) return null;
          if (max - min < 18) return null;
          return (
            "#" +
            [r, g, b]
              .map(function(v) { return v.toString(16).padStart(2, "0"); })
              .join("")
              .toUpperCase()
          );
        }

        const sampledColors = [];
        const probeSelectors = [
          "#header",
          "header",
          ".gnb",
          ".lnb",
          ".nav",
          ".btn_pri",
          ".btn-primary",
          "button.primary",
          ".active"
        ];
        for (let i = 0; i < probeSelectors.length; i++) {
          const el = document.querySelector(probeSelectors[i]);
          if (el) {
            const st = window.getComputedStyle(el);
            const bg = rgbToHex(st.backgroundColor || "");
            if (bg && sampledColors.indexOf(bg) === -1) sampledColors.push(bg);
            const col = rgbToHex(st.color || "");
            if (col && sampledColors.indexOf(col) === -1) sampledColors.push(col);
          }
        }

        const logoImg = document.querySelector(".logo img, #logo img, header img");
        const logoBox = document.querySelector(".logo, #logo, header h1");
        const logoAlt = logoImg && logoImg.alt ? String(logoImg.alt).trim() : "";
        const logoText = logoBox && logoBox.innerText ? String(logoBox.innerText).trim() : "";

        return {
          title: document.title || "",
          url: location.href,
          logoAlt: logoAlt,
          logoText: logoText,
          sampledColors: sampledColors
        };
      })()`)
      .catch(() => null);

    if (domMeta) {
      fs.writeFileSync(domMetaPath, JSON.stringify(domMeta, null, 2), "utf-8");
    }

    syncBrandAssetsToPublicAndDashboard(hostKey);
  } catch (err) {
    console.warn("[SiteBrand] 실시간 페이지 브랜드 캡처 경고:", err);
  }
}

function extractHeroFrameFromVideoIfNeeded(slug: string, heroDestPath: string): boolean {
  if (fs.existsSync(heroDestPath) && fs.statSync(heroDestPath).size > 500) {
    return true;
  }
  const sDir = path.join(DATA_DIR, slug);
  const bodyMp4 = path.join(sDir, "recording.body.mp4");
  const rawMp4 = path.join(sDir, "recording.mp4");
  const sourceVideo = fs.existsSync(bodyMp4) ? bodyMp4 : rawMp4;
  if (!fs.existsSync(sourceVideo)) return false;

  // 비디오 길이 확인 후 로그인 이후 메인 화면 시점(약 25% 지점 또는 15초 지점) 프레임 추출
  let seekSec = 8;
  try {
    const probe = spawnSync(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", sourceVideo],
      { encoding: "utf-8" }
    );
    const dur = parseFloat((probe.stdout || "").trim());
    if (Number.isFinite(dur) && dur > 4) {
      seekSec = Math.min(Math.max(2, dur * 0.28), Math.max(2, dur - 1));
    }
  } catch {}

  try {
    fs.mkdirSync(path.dirname(heroDestPath), { recursive: true });
    const ff = spawnSync(
      "ffmpeg",
      ["-y", "-v", "error", "-ss", seekSec.toFixed(2), "-i", sourceVideo, "-frames:v", "1", "-q:v", "2", heroDestPath],
      { encoding: "utf-8" }
    );
    return ff.status === 0 && fs.existsSync(heroDestPath) && fs.statSync(heroDestPath).size > 500;
  } catch {
    return false;
  }
}

/**
 * hero.png(실제 녹화된 사이트 화면)의 픽셀을 정밀 분석하여:
 * 1) 상단 헤더 바 및 주요 버튼의 실제 메인 브랜드 컬러(primaryColor, secondaryColor, accentColor)를 추출하고,
 * 2) 좌측 상단 로고 영역을 자동 감지·배경 투명화(및 흰색 로고의 경우 브랜드 컬러로 리컬러링)하여 logo.png로 저장합니다.
 */
async function extractVisualBrandFromHeroPng(
  heroPath: string,
  logoOutPath: string
): Promise<{
  primaryColor?: string;
  secondaryColor?: string;
  accentColor?: string;
  logoExtracted?: boolean;
}> {
  if (!fs.existsSync(heroPath)) return {};
  let browser: any = null;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const imgB64 = fs.readFileSync(heroPath).toString("base64");

    const analyzed = await page.evaluate(`(async (b64) => {
      const img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        img.src = "data:image/png;base64," + b64;
      });

      const canvas = document.createElement("canvas");
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0);

      const scanH = Math.min(img.height, 260);
      const imgData = ctx.getImageData(0, 0, img.width, scanH).data;

      const headerBuckets = {};
      const maxHeaderX = Math.min(img.width - 10, 960);
      for (let y = 4; y < Math.min(46, scanH); y += 2) {
        for (let x = 240; x < maxHeaderX; x += 3) {
          const idx = (y * img.width + x) * 4;
          const r = imgData[idx];
          const g = imgData[idx + 1];
          const b = imgData[idx + 2];
          const key = (Math.round(r / 8) * 8) + "," + (Math.round(g / 8) * 8) + "," + (Math.round(b / 8) * 8);
          if (!headerBuckets[key]) headerBuckets[key] = { count: 0, r, g, b };
          headerBuckets[key].count++;
        }
      }
      const sortedHeader = Object.values(headerBuckets).sort((a, b) => b.count - a.count);
      const topHeaderBg = sortedHeader[0] || { r: 255, g: 255, b: 255, count: 0 };

      const hMax = Math.max(topHeaderBg.r, topHeaderBg.g, topHeaderBg.b);
      const hMin = Math.min(topHeaderBg.r, topHeaderBg.g, topHeaderBg.b);
      const headerIsVivid = !(hMax > 245 && hMin > 230) && hMax >= 35 && (hMax - hMin >= 28);

      let brandRGB = null;
      if (headerIsVivid) {
        brandRGB = { r: topHeaderBg.r, g: topHeaderBg.g, b: topHeaderBg.b };
      } else {
        const vividBuckets = {};
        for (let y = 8; y < Math.min(220, scanH); y += 2) {
          for (let x = 10; x < Math.min(img.width - 10, 600); x += 3) {
            const idx = (y * img.width + x) * 4;
            const r = imgData[idx];
            const g = imgData[idx + 1];
            const b = imgData[idx + 2];
            const mx = Math.max(r, g, b);
            const mn = Math.min(r, g, b);
            if ((mx > 245 && mn > 230) || mx < 35 || (mx - mn < 28)) continue;
            const key = (Math.round(r / 10) * 10) + "," + (Math.round(g / 10) * 10) + "," + (Math.round(b / 10) * 10);
            if (!vividBuckets[key]) vividBuckets[key] = { count: 0, r, g, b };
            vividBuckets[key].count++;
          }
        }
        const bestVivid = Object.values(vividBuckets).sort((a, b) => b.count - a.count)[0];
        if (bestVivid && bestVivid.count >= 12) {
          brandRGB = { r: bestVivid.r, g: bestVivid.g, b: bestVivid.b };
        }
      }

      const pR = brandRGB ? brandRGB.r : 0;
      const pG = brandRGB ? brandRGB.g : 104;
      const pB = brandRGB ? brandRGB.b : 255;

      const primaryColor = "#" + [pR, pG, pB].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("").toUpperCase();
      const secondaryColor = "#" + [pR * 0.84, pG * 0.76, pB * 0.76].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("").toUpperCase();
      const accentColor = "#" + [Math.min(255, pR * 1.06 + 18), Math.min(255, pG * 1.12 + 24), Math.min(255, pB * 1.15 + 28)].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("").toUpperCase();

      const bgR = topHeaderBg.r;
      const bgG = topHeaderBg.g;
      const bgB = topHeaderBg.b;
      let minX = 9999;
      let minY = 9999;
      let maxX = 0;
      let maxY = 0;

      const logoScanW = Math.min(img.width, 300);
      const logoScanH = Math.min(scanH, 52);
      for (let y = 2; y < logoScanH; y++) {
        for (let x = 4; x < logoScanW; x++) {
          const idx = (y * img.width + x) * 4;
          const r = imgData[idx];
          const g = imgData[idx + 1];
          const b = imgData[idx + 2];
          const dist = Math.hypot(r - bgR, g - bgG, b - bgB);
          if (dist > 28) {
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
          }
        }
      }

      let logoDataUrl = null;
      if (maxX > minX + 20 && maxY > minY + 10) {
        const pad = 4;
        const cX = Math.max(0, minX - pad);
        const cY = Math.max(0, minY - pad);
        const cW = Math.min(img.width - cX, maxX - minX + 1 + pad * 2);
        const cH = Math.min(scanH - cY, maxY - minY + 1 + pad * 2);

        const scale = 2;
        const logoCanvas = document.createElement("canvas");
        logoCanvas.width = cW * scale;
        logoCanvas.height = cH * scale;
        const lCtx = logoCanvas.getContext("2d");
        lCtx.imageSmoothingEnabled = true;
        lCtx.imageSmoothingQuality = "high";
        lCtx.drawImage(img, cX, cY, cW, cH, 0, 0, cW * scale, cH * scale);

        const lImg = lCtx.getImageData(0, 0, logoCanvas.width, logoCanvas.height);
        const lData = lImg.data;
        const maxDistToWhite = Math.max(45, Math.hypot(255 - bgR, 255 - bgG, 255 - bgB));

        const logoBrandR = Math.round(pR * 0.94);
        const logoBrandG = Math.round(pG * 0.88);
        const logoBrandB = Math.round(pB * 0.88);

        for (let i = 0; i < lData.length; i += 4) {
          const r = lData[i];
          const g = lData[i + 1];
          const b = lData[i + 2];
          const dist = Math.hypot(r - bgR, g - bgG, b - bgB);

          if (dist < 18) {
            lData[i + 3] = 0;
          } else if (headerIsVivid) {
            const normAlpha = Math.min(1, Math.max(0, (dist - 14) / (maxDistToWhite * 0.78)));
            lData[i] = logoBrandR;
            lData[i + 1] = logoBrandG;
            lData[i + 2] = logoBrandB;
            lData[i + 3] = Math.round(normAlpha * 255);
          } else {
            const normAlpha = Math.min(1, Math.max(0, (dist - 14) / 48));
            lData[i + 3] = Math.round(normAlpha * 255);
          }
        }
        lCtx.putImageData(lImg, 0, 0);
        logoDataUrl = logoCanvas.toDataURL("image/png");
      }

      return {
        hasVividBrand: Boolean(brandRGB),
        primaryColor,
        secondaryColor,
        accentColor,
        logoDataUrl,
      };
    })(${JSON.stringify(imgB64)})`) as any;

    let logoExtracted = false;
    if (analyzed?.logoDataUrl) {
      const base64Data = analyzed.logoDataUrl.replace(/^data:image\/png;base64,/, "");
      fs.writeFileSync(logoOutPath, Buffer.from(base64Data, "base64"));
      logoExtracted = true;
    }

    return {
      primaryColor: analyzed?.hasVividBrand ? analyzed.primaryColor : undefined,
      secondaryColor: analyzed?.hasVividBrand ? analyzed.secondaryColor : undefined,
      accentColor: analyzed?.hasVividBrand ? analyzed.accentColor : undefined,
      logoExtracted,
    };
  } catch (err) {
    console.warn("[SiteBrand] hero.png 시각 브랜드 분석 경고:", err);
    return {};
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

/**
 * 시나리오의 대상 사이트 URL을 기준으로 마스터 브랜드 프로필(SiteBrandProfile)을 보장합니다.
 * 최초 1회 생성 시 실제 사이트 화면(hero.png) 픽셀에서 정확한 상단 테마 컬러와 로고(logo.png)를 추출하고,
 * AI(aiClient)를 통해 사이트명·매뉴얼 타이틀을 보강하여 마스터로 영구 캐싱합니다.
 */
export function resolveOriginUrlForScenario(slug: string): string {
  const sDir = path.join(DATA_DIR, slug);
  const bpPath = path.join(sDir, "browse-plan.json");
  const mmPath = path.join(sDir, "moments.json");
  const narPath = path.join(sDir, "narration.json");

  let bp: any = null;
  let mm: any = null;
  let nar: any = null;
  try {
    if (fs.existsSync(bpPath)) bp = JSON.parse(fs.readFileSync(bpPath, "utf-8"));
  } catch {}
  try {
    if (fs.existsSync(mmPath)) mm = JSON.parse(fs.readFileSync(mmPath, "utf-8"));
  } catch {}
  try {
    if (fs.existsSync(narPath)) nar = JSON.parse(fs.readFileSync(narPath, "utf-8"));
  } catch {}

  const inlineBrandUrl =
    nar?.siteBrand?.originUrl ||
    nar?.siteBrand?.hostKey ||
    nar?.introToc?.siteBrand?.originUrl ||
    nar?.introToc?.siteBrand?.hostKey ||
    "";
  if (inlineBrandUrl) return inlineBrandUrl;

  const mergedFromSlugs: string[] = Array.isArray(nar?.mergedFromSlugs)
    ? nar.mergedFromSlugs
    : Array.isArray(bp?.mergedFromSlugs)
    ? bp.mergedFromSlugs
    : [];

  if (mergedFromSlugs.length > 0) {
    for (const chSlug of mergedFromSlugs) {
      const chNarPath = path.join(DATA_DIR, chSlug, "narration.json");
      const chBpPath = path.join(DATA_DIR, chSlug, "browse-plan.json");
      if (fs.existsSync(chNarPath)) {
        try {
          const chNar = JSON.parse(fs.readFileSync(chNarPath, "utf-8"));
          const chUrl = chNar?.siteBrand?.originUrl || chNar?.siteBrand?.hostKey;
          if (chUrl) return chUrl;
        } catch {}
      }
      if (fs.existsSync(chBpPath)) {
        try {
          const chBp = JSON.parse(fs.readFileSync(chBpPath, "utf-8"));
          const chFirstNav = chBp?.actions?.find((a: any) => a?.url && /^https?:\/\//i.test(String(a.url)))?.url;
          const chUrl = chFirstNav || chBp?.baseUrl || chBp?.url;
          if (chUrl) return chUrl;
        } catch {}
      }
    }
  }

  const firstNavUrl = bp?.actions?.find((a: any) => a?.url && /^https?:\/\//i.test(String(a.url)))?.url;
  return (
    firstNavUrl ||
    bp?.baseUrl ||
    bp?.url ||
    mm?.metadata?.baseUrl ||
    mm?.metadata?.url ||
    mm?.url ||
    getConfig().targetBaseUrl ||
    "http://localhost"
  );
}

export function resolveSiteBrandForScenario(slug: string): SiteBrandProfile {
  const originUrl = resolveOriginUrlForScenario(slug);
  const cached = getCachedSiteBrand(originUrl);
  if (cached) {
    const narPath = path.join(DATA_DIR, slug, "narration.json");
    if (fs.existsSync(narPath)) {
      try {
        const nar = JSON.parse(fs.readFileSync(narPath, "utf-8"));
        if (!nar.siteBrand || !nar.siteBrand.logoUrl || nar.siteBrand.siteName === "그룹웨어") {
          nar.siteBrand = cached;
          fs.writeFileSync(narPath, JSON.stringify(nar, null, 2), "utf-8");
        }
      } catch {}
    }
    return cached;
  }

  const hostKey = getHostKeyFromUrl(originUrl);
  const baseDomain = getBaseDomainFromHostKey(hostKey);
  return {
    hostKey,
    originUrl,
    siteName: baseDomain || hostKey || "그룹웨어",
    manualBadge: "그룹웨어 사용 매뉴얼",
    tagline: "",
    primaryColor: "#0068FF",
    secondaryColor: "#0047B3",
    accentColor: "#0BB4FA",
    createdAt: new Date().toISOString(),
  };
}

export function updateSiteBrandForScenario(
  slug: string,
  updates: {
    siteName?: string;
    manualBadge?: string;
    primaryColor?: string;
    secondaryColor?: string;
    accentColor?: string;
    propagateToBaseDomain?: boolean;
  }
): SiteBrandProfile {
  const current = resolveSiteBrandForScenario(slug);
  const hostKey = current.hostKey || getHostKeyFromUrl(current.originUrl);
  const baseDomain = getBaseDomainFromHostKey(hostKey || current.originUrl);
  const propagate = updates.propagateToBaseDomain !== false;

  const nextSiteName =
    updates.siteName !== undefined
      ? stripVersionInfo(updates.siteName) || current.siteName || "그룹웨어"
      : current.siteName || "그룹웨어";
  const nextManualBadge =
    updates.manualBadge !== undefined
      ? stripVersionInfo(updates.manualBadge) || current.manualBadge || "그룹웨어 사용 매뉴얼"
      : current.manualBadge || "그룹웨어 사용 매뉴얼";

  const nextPrimary = normalizeHexColor(updates.primaryColor, current.primaryColor || "#0068FF");
  const primaryChanged = nextPrimary.toUpperCase() !== (current.primaryColor || "").toUpperCase();
  const derived = deriveSecondaryAndAccentColors(nextPrimary);
  const nextSecondary = updates.secondaryColor
    ? normalizeHexColor(updates.secondaryColor, derived.secondaryColor)
    : primaryChanged
    ? derived.secondaryColor
    : current.secondaryColor || derived.secondaryColor;
  const nextAccent = updates.accentColor
    ? normalizeHexColor(updates.accentColor, derived.accentColor)
    : primaryChanged
    ? derived.accentColor
    : current.accentColor || derived.accentColor;

  const targetHostKeys = new Set<string>([hostKey]);
  if (propagate && baseDomain && fs.existsSync(BRANDS_ROOT)) {
    try {
      for (const ent of fs.readdirSync(BRANDS_ROOT, { withFileTypes: true })) {
        if (!ent.isDirectory() || ent.name.startsWith(".") || ent.name.startsWith("_")) continue;
        if (getBaseDomainFromHostKey(ent.name) === baseDomain) {
          targetHostKeys.add(ent.name);
        }
      }
    } catch {}
  }

  let updatedPrimaryProfile: SiteBrandProfile = {
    ...current,
    hostKey,
    siteName: nextSiteName,
    manualBadge: nextManualBadge,
    primaryColor: nextPrimary,
    secondaryColor: nextSecondary,
    accentColor: nextAccent,
  };

  for (const hk of targetHostKeys) {
    const bDir = path.join(BRANDS_ROOT, hk);
    fs.mkdirSync(bDir, { recursive: true });
    const bJsonPath = path.join(bDir, "brand.json");
    let existingHk: Partial<SiteBrandProfile> = {};
    if (fs.existsSync(bJsonPath)) {
      try {
        existingHk = JSON.parse(fs.readFileSync(bJsonPath, "utf-8"));
      } catch {}
    }
    const synced = syncBrandAssetsToPublicAndDashboard(hk);
    const hkProfile: SiteBrandProfile = {
      hostKey: hk,
      originUrl: existingHk.originUrl || current.originUrl,
      siteName: nextSiteName,
      manualBadge: nextManualBadge,
      tagline: existingHk.tagline || "",
      primaryColor: nextPrimary,
      secondaryColor: nextSecondary,
      accentColor: nextAccent,
      logoUrl: synced.logoUrl || existingHk.logoUrl || current.logoUrl,
      heroThumbUrl: synced.heroThumbUrl || existingHk.heroThumbUrl || current.heroThumbUrl,
      createdAt: existingHk.createdAt || current.createdAt || new Date().toISOString(),
    };
    try {
      fs.writeFileSync(bJsonPath, JSON.stringify(hkProfile, null, 2), "utf-8");
    } catch {}
    if (hk === hostKey) {
      updatedPrimaryProfile = hkProfile;
    }
  }

  // Update narration.json across matching scenarios
  if (fs.existsSync(DATA_DIR)) {
    try {
      for (const ent of fs.readdirSync(DATA_DIR, { withFileTypes: true })) {
        if (!ent.isDirectory() || ent.name.startsWith(".") || ent.name.startsWith("_")) continue;
        const sSlug = ent.name;
        const isTargetSlug = sSlug === slug;
        const sOriginUrl = resolveOriginUrlForScenario(sSlug);
        const sHostKey = getHostKeyFromUrl(sOriginUrl);
        const sDomain = getBaseDomainFromHostKey(sHostKey || sOriginUrl);
        const matches = isTargetSlug || (propagate && baseDomain ? sDomain === baseDomain : sHostKey === hostKey);
        if (!matches) continue;

        const narPath = path.join(DATA_DIR, sSlug, "narration.json");
        if (fs.existsSync(narPath)) {
          try {
            const rawNar = fs.readFileSync(narPath, "utf-8");
            const nar = JSON.parse(rawNar);
            nar.siteBrand = {
              ...(nar.siteBrand || updatedPrimaryProfile),
              siteName: nextSiteName,
              manualBadge: nextManualBadge,
              primaryColor: nextPrimary,
              secondaryColor: nextSecondary,
              accentColor: nextAccent,
              logoUrl: updatedPrimaryProfile.logoUrl || nar.siteBrand?.logoUrl,
              heroThumbUrl: updatedPrimaryProfile.heroThumbUrl || nar.siteBrand?.heroThumbUrl,
            };
            if (nar.introToc && typeof nar.introToc === "object" && updates.manualBadge !== undefined) {
              nar.introToc.badge = nextManualBadge;
            }
            const nextNarStr = JSON.stringify(nar, null, 2);
            if (nextNarStr !== rawNar) {
              fs.writeFileSync(narPath, nextNarStr, "utf-8");
            }
          } catch {}
        }

        const epPath = path.join(DATA_DIR, sSlug, "edit-plan.json");
        if (fs.existsSync(epPath)) {
          try {
            const rawEp = fs.readFileSync(epPath, "utf-8");
            const ep = JSON.parse(rawEp);
            if (ep.narration && typeof ep.narration === "object") {
              ep.narration.siteBrand = {
                ...(ep.narration.siteBrand || updatedPrimaryProfile),
                siteName: nextSiteName,
                manualBadge: nextManualBadge,
                primaryColor: nextPrimary,
                secondaryColor: nextSecondary,
                accentColor: nextAccent,
                logoUrl: updatedPrimaryProfile.logoUrl || ep.narration.siteBrand?.logoUrl,
                heroThumbUrl: updatedPrimaryProfile.heroThumbUrl || ep.narration.siteBrand?.heroThumbUrl,
              };
              if (ep.narration.introToc && typeof ep.narration.introToc === "object" && updates.manualBadge !== undefined) {
                ep.narration.introToc.badge = nextManualBadge;
              }
              const nextEpStr = JSON.stringify(ep, null, 2);
              if (nextEpStr !== rawEp) {
                fs.writeFileSync(epPath, nextEpStr, "utf-8");
              }
            }
          } catch {}
        }
      }
    } catch {}
  }

  return updatedPrimaryProfile;
}

export function listAllSiteBrands(): Array<SiteBrandProfile & { baseDomain: string }> {
  const result: Array<SiteBrandProfile & { baseDomain: string }> = [];
  if (!fs.existsSync(BRANDS_ROOT)) return result;
  try {
    for (const ent of fs.readdirSync(BRANDS_ROOT, { withFileTypes: true })) {
      if (!ent.isDirectory() || ent.name.startsWith(".") || ent.name.startsWith("_")) continue;
      const bPath = path.join(BRANDS_ROOT, ent.name, "brand.json");
      if (!fs.existsSync(bPath)) continue;
      try {
        const profile: SiteBrandProfile = JSON.parse(fs.readFileSync(bPath, "utf-8"));
        const synced = syncBrandAssetsToPublicAndDashboard(ent.name);
        if (synced.logoUrl) profile.logoUrl = synced.logoUrl;
        if (synced.heroThumbUrl) profile.heroThumbUrl = synced.heroThumbUrl;
        result.push({
          ...profile,
          baseDomain: getBaseDomainFromHostKey(profile.hostKey || ent.name || profile.originUrl),
        });
      } catch {}
    }
  } catch {}
  return result;
}

/**
 * 시나리오의 대상 사이트 URL을 기준으로 마스터 브랜드 프로필(SiteBrandProfile)을 보장합니다.
 * 최초 1회 생성 시 실제 사이트 화면(hero.png) 픽셀에서 정확한 상단 테마 컬러와 로고(logo.png)를 추출하고,
 * AI(aiClient)를 통해 사이트명·매뉴얼 타이틀을 보강하여 마스터로 영구 캐싱합니다.
 */
export async function ensureSiteBrandForScenario(
  slug: string,
  options?: { forceRefresh?: boolean }
): Promise<SiteBrandProfile> {
  const sDir = path.join(DATA_DIR, slug);
  const bpPath = path.join(sDir, "browse-plan.json");

  let bp: BrowsePlan | null = null;
  try {
    if (fs.existsSync(bpPath)) bp = JSON.parse(fs.readFileSync(bpPath, "utf-8"));
  } catch {}

  const originUrl = resolveOriginUrlForScenario(slug);
  const hostKey = getHostKeyFromUrl(originUrl);
  const brandDir = path.join(BRANDS_ROOT, hostKey);
  fs.mkdirSync(brandDir, { recursive: true });

  const brandJsonPath = path.join(brandDir, "brand.json");
  const heroPath = path.join(brandDir, "hero.png");
  const logoPath = path.join(brandDir, "logo.png");
  const domMetaPath = path.join(brandDir, "dom-meta.json");

  // 비디오에서 실제 사이트 화면 썸네일(hero.png) 보장
  extractHeroFrameFromVideoIfNeeded(slug, heroPath);

  if (!options?.forceRefresh) {
    const cachedOrInherited = getCachedSiteBrand(originUrl);
    if (cachedOrInherited) {
      if (!fs.existsSync(logoPath) && fs.existsSync(heroPath)) {
        await extractVisualBrandFromHeroPng(heroPath, logoPath);
        const synced = syncBrandAssetsToPublicAndDashboard(hostKey);
        if (synced.logoUrl) cachedOrInherited.logoUrl = synced.logoUrl;
        if (synced.heroThumbUrl) cachedOrInherited.heroThumbUrl = synced.heroThumbUrl;
      }
      return cachedOrInherited;
    }
  }

  // 실제 사이트 화면(hero.png)에서 정확한 픽셀 테마 색상 및 투명 배경 로고(logo.png) 추출
  const visualExtracted = await extractVisualBrandFromHeroPng(heroPath, logoPath);
  const sibling = findBestSiblingBrandForBaseDomain(hostKey);
  if (sibling && (!fs.existsSync(logoPath) || fs.statSync(logoPath).size <= 100) && sibling.logoPath) {
    try {
      fs.copyFileSync(sibling.logoPath, logoPath);
    } catch {}
  }

  let domMeta: any = null;
  if (fs.existsSync(domMetaPath)) {
    try {
      domMeta = JSON.parse(fs.readFileSync(domMetaPath, "utf-8"));
    } catch {}
  }

  const sampleActions = (bp?.actions || [])
    .slice(0, 12)
    .map((a) => a.description)
    .filter(Boolean);

  let siteName = stripVersionInfo(
    sibling?.profile?.siteName && sibling.profile.siteName !== "그룹웨어"
      ? sibling.profile.siteName
      : domMeta?.logoAlt || domMeta?.logoText || domMeta?.title || "그룹웨어"
  );
  if (siteName.length > 22) siteName = siteName.slice(0, 22).trim();
  let manualBadge = sibling?.profile?.manualBadge || "그룹웨어 사용 매뉴얼";
  const hasGoodVisualColor =
    visualExtracted.primaryColor && visualExtracted.primaryColor !== "#814804";
  let primaryColor =
    (hasGoodVisualColor ? visualExtracted.primaryColor : undefined) ||
    sibling?.profile?.primaryColor ||
    domMeta?.sampledColors?.[0] ||
    "#0068FF";
  let secondaryColor =
    (hasGoodVisualColor ? visualExtracted.secondaryColor : undefined) ||
    sibling?.profile?.secondaryColor ||
    domMeta?.sampledColors?.[1] ||
    "#0047B3";
  let accentColor =
    (hasGoodVisualColor ? visualExtracted.accentColor : undefined) ||
    sibling?.profile?.accentColor ||
    "#0BB4FA";

  // AI(API 모드 / CLI 모드 통합)를 통해 대상 사이트 명칭 및 매뉴얼 타이틀 정제
  try {
    const prompt = `당신은 기업용 웹 애플리케이션 매뉴얼 디자인 디렉터입니다.
아래 대상 사이트 정보를 바탕으로 이 사이트(${originUrl})의 모든 매뉴얼 영상 오프닝 슬라이드에서 공통 마스터로 사용할 브랜드 메타데이터 JSON을 생성하세요.

[분석 대상 사이트 정보]
- URL: ${originUrl}
- Host Key: ${hostKey}
- 화면 픽셀에서 검출된 실제 상단 헤더 브랜드 색상: ${visualExtracted.primaryColor || "없음"}
- DOM 메타 정보: ${JSON.stringify(domMeta || {})}
- 주요 시연 액션 예시: ${JSON.stringify(sampleActions)}

[생성 규칙]
1. \`siteName\`: 대상 사이트 또는 기관/서비스의 깔끔한 명칭 (15자 이내, 예: "부천대학교", "그룹웨어 포털" 등. 버전 번호 절대 포함 금지)
2. \`manualBadge\`: 슬라이드 좌측 상단에 들어갈 매뉴얼 타이틀 (예: "그룹웨어 사용 매뉴얼" 등. Ver 7.5 같은 버전 번호나 불필요한 슬로건 절대 금지)
3. \`primaryColor\`: 화면 픽셀에서 검출된 실제 브랜드 색상(${visualExtracted.primaryColor || "#0068FF"})이 있으면 **절대 임의의 다른 계열 색상(예: 파란색 등)으로 바꾸지 말고 해당 색상을 그대로 유지**하세요.

반드시 아래 JSON 형식으로만 응답하세요:
{
  "siteName": "부천대학교",
  "manualBadge": "그룹웨어 사용 매뉴얼",
  "primaryColor": "${primaryColor}",
  "secondaryColor": "${secondaryColor}",
  "accentColor": "${accentColor}"
}`;

    const imagesBase64 = fs.existsSync(heroPath)
      ? [{ mimeType: "image/png", data: fs.readFileSync(heroPath).toString("base64") }]
      : undefined;

    const aiRes = await generateAiContent({
      feature: "사이트 마스터 슬라이드 테마 생성",
      prompt,
      imagesBase64,
      temperature: 0.1,
      jsonMode: true,
      slug,
      timeoutMs: 45_000,
    });

    const parsed = JSON.parse(aiRes.text);
    if (parsed && typeof parsed === "object") {
      if (parsed.siteName) siteName = stripVersionInfo(parsed.siteName);
      if (parsed.manualBadge) manualBadge = stripVersionInfo(parsed.manualBadge);
      // 픽셀에서 실제 브랜드 컬러가 검출된 경우 AI가 임의 색상으로 덮어쓰지 못하도록 픽셀 추출 색상 우선 보장
      if (!visualExtracted.primaryColor) {
        primaryColor = normalizeHexColor(parsed.primaryColor, primaryColor);
        secondaryColor = normalizeHexColor(parsed.secondaryColor, secondaryColor);
        accentColor = normalizeHexColor(parsed.accentColor, accentColor);
      }
    }
  } catch (err: any) {
    console.warn(`[SiteBrand AI] 기본 테마 폴백 적용 (${err?.message || err})`);
  }

  const synced = syncBrandAssetsToPublicAndDashboard(hostKey);

  const profile: SiteBrandProfile = {
    hostKey,
    originUrl,
    siteName: siteName || "그룹웨어",
    manualBadge: manualBadge || "그룹웨어 사용 매뉴얼",
    tagline: "",
    primaryColor,
    secondaryColor,
    accentColor,
    logoUrl: synced.logoUrl,
    heroThumbUrl: synced.heroThumbUrl,
    createdAt: new Date().toISOString(),
  };

  fs.writeFileSync(brandJsonPath, JSON.stringify(profile, null, 2), "utf-8");
  return profile;
}

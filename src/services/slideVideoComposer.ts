import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";
import { chromium } from "playwright";
import type { IntroTocConfig, MomentsFile, NarrationFile, SiteBrandProfile } from "../types";
import { ensureSiteBrandForScenario } from "./siteBrandService";
import { computeTimeRegionsAndSyncCues, saveNarrationFile } from "./narrationService";
import { linkOrCopyFileSafe, replaceFileSafeWithNewInode } from "./storageOptimizerService";

const ROOT_DIR = path.resolve(__dirname, "..", "..");
const DATA_DIR = path.join(ROOT_DIR, "data");
const PUBLIC_DIR = path.join(ROOT_DIR, "public");

function escapeHtml(str: string): string {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function stripVersionAndConversationalText(raw: string): string {
  return String(raw || "")
    .replace(/\b(?:ver\.?|v\.?)\s*\d+(?:\.\d+)*\b/gi, "")
    .replace(/이번\s*(?:시간|영상|매뉴얼|과정)에서는\s+[^.?!]+[.?!]?/g, "")
    .replace(/지금부터는?\s+[^.?!]+[.?!]?/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function fileToDataUri(filePath?: string): string | null {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    const ext = path.extname(filePath).toLowerCase();
    const mime =
      ext === ".svg"
        ? "image/svg+xml"
        : ext === ".jpg" || ext === ".jpeg"
        ? "image/jpeg"
        : "image/png";
    const b64 = fs.readFileSync(filePath).toString("base64");
    return `data:${mime};base64,${b64}`;
  } catch {
    return null;
  }
}

function resolveAssetDiskPath(webUrl?: string): string | undefined {
  if (!webUrl) return undefined;
  const rel = webUrl.replace(/^\/+/, "");
  const p1 = path.join(PUBLIC_DIR, rel);
  if (fs.existsSync(p1)) return p1;
  const p2 = path.join(ROOT_DIR, "dashboard", rel);
  if (fs.existsSync(p2)) return p2;
  return undefined;
}

function normalizeDisplayTitle(rawTitle: string, items?: Array<{ title?: string; description?: string }>): string {
  const clean = stripVersionAndConversationalText(rawTitle || "");
  if (clean && !/^[a-z0-9_-]+$/i.test(clean) && !/^live\s+demo\s+\d+$/i.test(clean)) {
    return clean;
  }
  const slugLower = clean.toLowerCase();
  if (slugLower.includes("taskboard")) return "태스크보드 보드 생성 및 업무 관리";
  if (slugLower.includes("board")) return "게시판 게시글 등록 및 조회";
  if (slugLower.includes("schedule") || slugLower.includes("calendar")) return "일정관리 일정 등록 및 공유";
  if (slugLower.includes("reservation") || slugLower.includes("reserve")) return "자원예약 회의실 예약 신청";
  if (slugLower.includes("note") || slugLower.includes("msg")) return "사내쪽지 작성 및 발송";
  if (slugLower.includes("address") || slugLower.includes("addr")) return "주소록 연락처 등록 및 조회";
  if (slugLower.includes("approval") || slugLower.includes("eapp")) return "전자결재 기안 및 결재 처리";
  const firstDesc = stripVersionAndConversationalText(items?.[0]?.description || items?.[0]?.title || "");
  const m = firstDesc.match(/([가-힣A-Za-z0-9\s]{2,16}?)(?:으로|로)\s*접속/);
  if (m && m[1]) {
    return `${m[1].trim()} 주요 기능 및 사용 방법`;
  }
  return clean || "그룹웨어 주요 기능 안내";
}

function normalizeDisplaySummary(rawSummary: string, displayTitle: string): string {
  const clean = stripVersionAndConversationalText(rawSummary || "")
    .replace(/(?:안내|소개|설명)\s*방법을\s*(?:안내|소개|설명)합니다/g, "방법을 안내합니다");
  if (!clean) return `${displayTitle}의 주요 메뉴 구성과 활용 방법을 안내합니다.`;
  return clean.replace(/^[a-z0-9_-]+의\s+/i, `${displayTitle}의 `);
}

export function buildCoverSlideHtmlDocument(options: {
  siteBrand: SiteBrandProfile;
  title?: string;
  subtitle?: string;
  chapterTitles?: string[];
  width?: number;
  height?: number;
  subtitleText?: string;
}): string {
  const width = options.width || 1920;
  const height = options.height || 1080;
  const { siteBrand } = options;
  const primary = siteBrand.primaryColor || "#0068FF";
  const secondary = siteBrand.secondaryColor || "#0047B3";
  const accent = siteBrand.accentColor || "#0BB4FA";

  const logoDiskPath = resolveAssetDiskPath(siteBrand.logoUrl);
  const logoDataUri = fileToDataUri(logoDiskPath);

  const mainTitle = options.title || "그룹웨어 사용 매뉴얼";
  const subTitle =
    options.subtitle ||
    `${siteBrand.siteName || "그룹웨어"} 주요 업무 모듈별 핵심 기능 및 표준 사용 절차를 안내합니다.`;
  const bottomSubtitle = String(options.subtitleText || "").trim();
  const chapterPills = (options.chapterTitles || []).slice(0, 6);

  const pillsHtml = chapterPills
    .map(
      (ch, idx) => `
      <div class="ch-pill">
        <span class="ch-pill-num">${String(idx + 1).padStart(2, "0")}</span>
        <span class="ch-pill-txt">${escapeHtml(ch)}</span>
      </div>`
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8" />
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body {
    width: ${width}px;
    height: ${height}px;
    overflow: hidden;
    font-family: 'Pretendard', 'Malgun Gothic', 'Apple SD Gothic Neo', sans-serif;
    background: #0F172A;
    position: relative;
  }
  .cover-bg {
    position: absolute;
    inset: 0;
    background: linear-gradient(135deg, ${primary} 0%, ${secondary} 58%, #0F2942 100%);
    overflow: hidden;
  }
  .mosaic-top {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 18px;
    display: flex;
  }
  .mosaic-top > div:nth-child(1) { width: 28%; background: rgba(255,255,255,0.35); }
  .mosaic-top > div:nth-child(2) { width: 22%; background: ${accent}; }
  .mosaic-top > div:nth-child(3) { width: 50%; background: rgba(0,0,0,0.18); }
  .decor-circle-1 {
    position: absolute;
    right: -140px;
    top: -160px;
    width: 780px;
    height: 780px;
    border-radius: 50%;
    background: radial-gradient(circle, rgba(255,255,255,0.16) 0%, rgba(255,255,255,0) 70%);
  }
  .decor-circle-2 {
    position: absolute;
    left: -120px;
    bottom: -220px;
    width: 680px;
    height: 680px;
    border-radius: 50%;
    background: radial-gradient(circle, rgba(255,255,255,0.10) 0%, rgba(255,255,255,0) 70%);
  }
  .cover-card {
    position: relative;
    z-index: 2;
    width: 1680px;
    height: 820px;
    margin: 96px auto 0 auto;
    background: #FFFFFF;
    border-radius: 36px;
    box-shadow: 0 36px 90px rgba(0, 0, 0, 0.34);
    display: flex;
    flex-direction: row;
    overflow: hidden;
  }
  .cover-left {
    width: 62%;
    height: 100%;
    padding: 76px 72px 72px 88px;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    background: #FFFFFF;
  }
  .brand-row {
    display: flex;
    align-items: center;
    gap: 18px;
  }
  .brand-logo-img {
    height: 54px;
    max-width: 300px;
    object-fit: contain;
  }
  .brand-site-name {
    font-size: 28px;
    font-weight: 800;
    color: ${primary};
    letter-spacing: -0.02em;
  }
  .hero-block {
    display: flex;
    flex-direction: column;
    gap: 22px;
    margin-top: -12px;
  }
  .eyebrow-badge {
    display: inline-flex;
    align-items: center;
    align-self: flex-start;
    padding: 9px 20px;
    border-radius: 999px;
    background: ${primary}15;
    border: 1.5px solid ${primary}40;
    color: ${primary};
    font-size: 20px;
    font-weight: 800;
    letter-spacing: 0.06em;
  }
  .cover-main-title {
    font-size: 84px;
    font-weight: 900;
    color: #0F2942;
    letter-spacing: -0.035em;
    line-height: 1.14;
    word-break: keep-all;
  }
  .cover-sub-title {
    font-size: 26px;
    font-weight: 500;
    color: #475569;
    letter-spacing: -0.015em;
    line-height: 1.48;
    word-break: keep-all;
    max-width: 820px;
  }
  .ch-pills-wrap {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    padding-top: 12px;
    border-top: 2px solid #E2E8F0;
  }
  .ch-pill {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    background: #F8FAFC;
    border: 1px solid #CBD5E1;
    border-radius: 12px;
    padding: 10px 18px;
  }
  .ch-pill-num {
    font-size: 17px;
    font-weight: 800;
    color: ${primary};
  }
  .ch-pill-txt {
    font-size: 19px;
    font-weight: 700;
    color: #1E293B;
  }
  .cover-right {
    width: 38%;
    height: 100%;
    background: linear-gradient(145deg, ${primary} 0%, ${secondary} 100%);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    position: relative;
    overflow: hidden;
    padding: 48px;
  }
  .cover-right-ring {
    width: 470px;
    height: 470px;
    border-radius: 50%;
    background: rgba(255, 255, 255, 0.96);
    box-shadow: 0 28px 64px rgba(15, 23, 42, 0.25);
    display: flex;
    align-items: center;
    justify-content: center;
  }
</style>
</head>
<body>
  <div class="cover-bg">
    <div class="mosaic-top"><div></div><div></div><div></div></div>
    <div class="decor-circle-1"></div>
    <div class="decor-circle-2"></div>
  </div>
  <div class="cover-card">
    <div class="cover-left">
      <div class="brand-row">
        ${
          logoDataUri
            ? `<img class="brand-logo-img" src="${logoDataUri}" alt="Site Logo" />`
            : `<span class="brand-site-name">${escapeHtml(siteBrand.siteName || "Smart Groupware")}</span>`
        }
      </div>
      <div class="hero-block">
        <div class="eyebrow-badge">OFFICIAL USER MANUAL</div>
        <div class="cover-main-title">${escapeHtml(mainTitle)}</div>
        <div class="cover-sub-title">${escapeHtml(subTitle)}</div>
      </div>
      <div class="ch-pills-wrap">
        ${
          pillsHtml ||
          `<div class="ch-pill"><span class="ch-pill-num">GUIDE</span><span class="ch-pill-txt">표준 업무 프로세스 실습 가이드</span></div>`
        }
      </div>
    </div>
    <div class="cover-right">
      <div class="cover-right-ring">
        <svg width="410" height="350" viewBox="0 0 460 390" fill="none" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <linearGradient id="bookTopGrad" x1="190" y1="115" x2="385" y2="245" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stop-color="${accent}" />
              <stop offset="100%" stop-color="${primary}" />
            </linearGradient>
            <linearGradient id="bookSpineGrad" x1="185" y1="180" x2="295" y2="305" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stop-color="${primary}" />
              <stop offset="100%" stop-color="${secondary}" />
            </linearGradient>
            <linearGradient id="loupeGlass" x1="145" y1="220" x2="215" y2="290" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stop-color="#E0F2FE" stop-opacity="0.82" />
              <stop offset="100%" stop-color="#BAE6FD" stop-opacity="0.45" />
            </linearGradient>
            <filter id="softShadow" x="-15%" y="-15%" width="135%" height="140%">
              <feDropShadow dx="10" dy="18" stdDeviation="12" flood-color="#0F172A" flood-opacity="0.14" />
            </filter>
          </defs>
          <line x1="42" y1="90" x2="112" y2="132" stroke="#10B981" stroke-width="2.5" stroke-linecap="round" opacity="0.75" />
          <line x1="88" y1="78" x2="145" y2="112" stroke="#A855F7" stroke-width="2.5" stroke-linecap="round" opacity="0.65" />
          <line x1="44" y1="128" x2="96" y2="160" stroke="${primary}" stroke-width="2.5" stroke-linecap="round" opacity="0.8" />
          <line x1="65" y1="162" x2="108" y2="188" stroke="#F59E0B" stroke-width="2.5" stroke-linecap="round" opacity="0.7" />
          <line x1="115" y1="142" x2="182" y2="182" stroke="${accent}" stroke-width="2.5" stroke-linecap="round" opacity="0.65" />
          <g filter="url(#softShadow)">
            <path d="M196 226 L304 162 L406 222 L298 286 Z" fill="${secondary}" />
            <path d="M294 278 L398 216 L398 178 L294 240 Z" fill="#F1F5F9" stroke="#CBD5E1" stroke-width="1" />
            <line x1="302" y1="252" x2="392" y2="198" stroke="#CBD5E1" stroke-width="1.5" />
            <line x1="302" y1="264" x2="392" y2="210" stroke="#CBD5E1" stroke-width="1.5" />
            <path d="M364 196 L396 177 L412 186 L380 205 Z" fill="${accent}" />
            <path d="M346 222 L378 203 L394 212 L362 231 Z" fill="#10B981" />
            <path d="M324 250 L356 231 L372 240 L340 259 Z" fill="#F97316" />
            <path d="M192 178 L302 114 L404 174 L294 238 Z" fill="url(#bookTopGrad)" />
            <path d="M192 178 C176 188, 176 218, 196 228 L294 286 C278 276, 278 248, 294 238 Z" fill="url(#bookSpineGrad)" />
          </g>
          <g filter="url(#softShadow)">
            <path d="M68 258 L178 194 L264 244 L154 308 Z" fill="#FFFFFF" stroke="#E2E8F0" stroke-width="1.5" />
            <line x1="112" y1="246" x2="176" y2="208" stroke="${primary}" stroke-width="4" stroke-linecap="round" />
            <circle cx="132" cy="258" r="3.5" fill="#64748B" />
            <line x1="142" y1="253" x2="192" y2="224" stroke="#94A3B8" stroke-width="3" stroke-linecap="round" />
            <circle cx="150" cy="269" r="3.5" fill="#64748B" />
            <line x1="160" y1="264" x2="210" y2="235" stroke="#94A3B8" stroke-width="3" stroke-linecap="round" />
            <circle cx="168" cy="280" r="3.5" fill="#64748B" />
            <line x1="178" y1="275" x2="226" y2="247" stroke="#94A3B8" stroke-width="3" stroke-linecap="round" />
          </g>
          <g filter="url(#softShadow)">
            <ellipse cx="182" cy="258" rx="38" ry="27" transform="rotate(-28 182 258)" fill="url(#loupeGlass)" stroke="#CBD5E1" stroke-width="6" />
            <path d="M204 276 L230 318" stroke="#334155" stroke-width="11" stroke-linecap="round" />
            <path d="M201 271 L208 282" stroke="#94A3B8" stroke-width="7" stroke-linecap="round" />
          </g>
        </svg>
      </div>
    </div>
  </div>
  ${
    bottomSubtitle
      ? `<div style="position:absolute;left:0;right:0;bottom:32px;display:flex;justify-content:center;align-items:center;padding:0 48px;z-index:10;pointer-events:none;">
           <div style="max-width:1320px;background:rgba(15,23,42,0.88);border:1px solid rgba(148,163,184,0.34);border-radius:12px;padding:12px 28px;box-shadow:0 12px 32px rgba(0,0,0,0.45);color:#F8FAFC;font-family:'Pretendard','Noto Sans KR','Malgun Gothic','Apple SD Gothic Neo',sans-serif;font-size:27px;font-weight:600;letter-spacing:-0.01em;line-height:1.42;text-align:center;word-break:keep-all;">
             ${escapeHtml(bottomSubtitle)}
           </div>
         </div>`
      : ""
  }
</body>
</html>`;
}

export function buildSlideHtmlDocument(options: {
  toc: IntroTocConfig;
  siteBrand: SiteBrandProfile;
  width?: number;
  height?: number;
  headerLabel?: string;
  subtitleText?: string;
  mode?: "detail" | "chapter-titles";
}): string {
  const width = options.width || 1920;
  const height = options.height || 1080;
  const { toc, siteBrand } = options;
  const headerLabel = options.headerLabel || "Contents";
  const bottomSubtitle = String(options.subtitleText || "").trim();
  const isChapterTitlesMode = options.mode === "chapter-titles";

  const primary = siteBrand.primaryColor || "#0068FF";
  const accent = siteBrand.accentColor || "#0BB4FA";
  const displayTitle = normalizeDisplayTitle(toc.title, toc.items);
  const cleanSubtitle = normalizeDisplaySummary(toc.summary || "", displayTitle);

  const logoDiskPath = resolveAssetDiskPath(siteBrand.logoUrl);
  const logoDataUri = fileToDataUri(logoDiskPath);

  const maxItems = 8;
  const items = (toc.items || []).slice(0, maxItems);
  const useTwoColGrid = items.length >= 6;
  const isCompact = items.length === 5;
  const isSpacious = items.length <= 3;
  const isShortViewport = height < 1020;

  const itemsHtml = items
    .map((item, idx) => {
      const rawTitle = stripVersionAndConversationalText(item.title || "");
      const rawDesc = stripVersionAndConversationalText(item.description || "")
        .replace(/(?:안내|소개|설명)\s*방법을\s*(?:안내|소개|설명)합니다/g, "방법을 안내합니다");
      const hasDistinctTitle =
        Boolean(rawTitle) &&
        Boolean(rawDesc) &&
        rawTitle !== rawDesc &&
        !/^(?:단계|주요\s*단계|핵심|주요\s*기능)\s*\d*$/.test(rawTitle);

      if (isChapterTitlesMode) {
        return `
          <div class="toc-card chapter-card">
            <div class="toc-num">${String(idx + 1).padStart(2, "0")}</div>
            <div class="toc-body">
              <div class="toc-item-title chapter-big-title">${escapeHtml(rawTitle || rawDesc)}</div>
              ${
                rawDesc && rawDesc !== rawTitle
                  ? `<div class="toc-item-desc">${escapeHtml(rawDesc)}</div>`
                  : ""
              }
            </div>
            <div class="chapter-tag">CHAPTER ${String(idx + 1).padStart(2, "0")}</div>
          </div>
        `;
      }

      return `
        <div class="toc-card">
          <div class="toc-num">${String(idx + 1).padStart(2, "0")}</div>
          <div class="toc-body">
            ${
              hasDistinctTitle
                ? `<div class="toc-item-title">${escapeHtml(rawTitle)}</div>
                   <div class="toc-item-desc">${escapeHtml(rawDesc)}</div>`
                : `<div class="toc-item-single">${escapeHtml(rawDesc || rawTitle)}</div>`
            }
          </div>
        </div>
      `;
    })
    .join("");

  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8" />
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body {
    width: ${width}px;
    height: ${height}px;
    overflow: hidden;
    font-family: 'Pretendard', 'Malgun Gothic', 'Apple SD Gothic Neo', sans-serif;
    background: #F4F7FC;
    display: flex;
    flex-direction: column;
    position: relative;
  }
  .top-accent {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 10px;
    background: linear-gradient(90deg, ${primary} 0%, ${accent} 100%);
  }
  .slide-container {
    width: 100%;
    height: 100%;
    max-width: 1680px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    justify-content: center;
    padding: ${
      isCompact
        ? isShortViewport
          ? "26px 80px 96px 80px"
          : "36px 80px 110px 80px"
        : isSpacious
        ? isShortViewport
          ? "44px 80px 96px 80px"
          : "56px 80px 108px 80px"
        : isShortViewport
        ? "36px 80px 108px 80px"
        : "52px 80px 120px 80px"
    };
  }
  .slide-header {
    display: flex;
    flex-direction: row;
    justify-content: space-between;
    align-items: flex-end;
    padding-bottom: ${isCompact ? "16px" : isShortViewport ? "24px" : "28px"};
    border-bottom: 2px solid #DCE5F2;
    gap: 32px;
  }
  .header-left {
    display: flex;
    flex-direction: column;
    gap: ${isCompact ? "6px" : "10px"};
  }
  .contents-label {
    font-size: ${isCompact ? "26px" : "30px"};
    font-weight: 800;
    color: ${primary};
    letter-spacing: 0.02em;
    text-transform: uppercase;
  }
  .main-title {
    font-size: ${isCompact ? "44px" : "52px"};
    font-weight: 800;
    color: #0F2942;
    letter-spacing: -0.03em;
    line-height: 1.18;
    word-break: keep-all;
  }
  .main-subtitle {
    font-size: ${isCompact ? "21px" : "24px"};
    font-weight: 500;
    color: #475569;
    letter-spacing: -0.015em;
    line-height: 1.38;
    margin-top: 2px;
    word-break: keep-all;
  }
  .header-right {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 10px;
    flex-shrink: 0;
  }
  .brand-logo-img {
    height: 44px;
    max-width: 240px;
    object-fit: contain;
  }
  .brand-site-name {
    font-size: 24px;
    font-weight: 800;
    color: ${primary};
    letter-spacing: -0.02em;
  }
  .manual-pill {
    font-size: 16px;
    font-weight: 700;
    color: #475569;
    background: #E2E8F0;
    padding: 6px 14px;
    border-radius: 999px;
  }
  .toc-list {
    margin-top: ${isCompact ? "16px" : isSpacious ? "32px" : isShortViewport ? "24px" : "28px"};
    display: ${useTwoColGrid ? "grid" : "flex"};
    ${
      useTwoColGrid
        ? "grid-template-columns: 1fr 1fr; gap: 18px 24px;"
        : `flex-direction: column; gap: ${
            isCompact
              ? isShortViewport
                ? "10px"
                : "12px"
              : isSpacious
              ? "22px"
              : isShortViewport
              ? "16px"
              : "18px"
          };`
    }
  }
  .toc-card {
    display: flex;
    align-items: center;
    gap: 26px;
    background: #FFFFFF;
    border: 1px solid #E2E8F0;
    border-radius: 18px;
    padding: ${
      isCompact
        ? isShortViewport
          ? "11px 28px"
          : "14px 32px"
        : useTwoColGrid
        ? "18px 26px"
        : isSpacious
        ? isShortViewport
          ? "24px 38px"
          : "28px 42px"
        : isShortViewport
        ? "20px 36px"
        : "23px 38px"
    };
    box-shadow: 0 10px 28px rgba(15, 41, 66, 0.05);
  }
  .toc-num {
    min-width: ${isCompact ? "48px" : "58px"};
    height: ${isCompact ? "48px" : "58px"};
    border-radius: ${isCompact ? "14px" : "16px"};
    background: ${primary}14;
    border: 1.5px solid ${primary}45;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: ${isCompact ? "22px" : "26px"};
    font-weight: 800;
    color: ${primary};
    flex-shrink: 0;
  }
  .toc-body {
    display: flex;
    flex-direction: column;
    gap: ${isCompact ? "4px" : "6px"};
    flex: 1;
  }
  .toc-item-title {
    font-size: ${isCompact ? (isShortViewport ? "24px" : "26px") : "30px"};
    font-weight: 700;
    color: #0F2942;
    letter-spacing: -0.02em;
    line-height: 1.28;
    word-break: keep-all;
  }
  .chapter-big-title {
    font-size: ${useTwoColGrid ? "28px" : "33px"};
    font-weight: 800;
    color: #0F2942;
  }
  .toc-item-desc {
    font-size: ${isCompact ? (isShortViewport ? "19px" : "20.5px") : "22.5px"};
    font-weight: 500;
    color: #475569;
    letter-spacing: -0.015em;
    line-height: 1.4;
    word-break: keep-all;
  }
  .toc-item-single {
    font-size: ${isCompact ? "25px" : "28px"};
    font-weight: 600;
    color: #1E293B;
    letter-spacing: -0.02em;
    line-height: 1.38;
    word-break: keep-all;
  }
  .chapter-tag {
    font-size: 16px;
    font-weight: 800;
    color: ${primary};
    background: ${primary}12;
    border: 1px solid ${primary}30;
    padding: 8px 16px;
    border-radius: 999px;
    letter-spacing: 0.04em;
    flex-shrink: 0;
  }
</style>
</head>
<body>
  <div class="top-accent"></div>
  <div class="slide-container">
    <div class="slide-header">
      <div class="header-left">
        <div class="contents-label">${escapeHtml(headerLabel)}</div>
        <div class="main-title">${escapeHtml(displayTitle)}</div>
        ${cleanSubtitle ? `<div class="main-subtitle">${escapeHtml(cleanSubtitle)}</div>` : ""}
      </div>
      <div class="header-right">
        ${
          logoDataUri
            ? `<img class="brand-logo-img" src="${logoDataUri}" alt="Site Logo" />`
            : `<span class="brand-site-name">${escapeHtml(siteBrand.siteName || "그룹웨어")}</span>`
        }
        <span class="manual-pill">${escapeHtml(toc.badge || siteBrand.manualBadge || "그룹웨어 사용 매뉴얼")}</span>
      </div>
    </div>
    <div class="toc-list">
      ${itemsHtml}
    </div>
  </div>
  ${
    bottomSubtitle
      ? `<div style="position:absolute;left:0;right:0;bottom:${
          isShortViewport ? "18px" : "26px"
        };display:flex;justify-content:center;align-items:center;padding:0 48px;z-index:10;pointer-events:none;">
           <div style="max-width:1320px;background:rgba(15,23,42,0.86);border:1px solid rgba(148,163,184,0.32);border-radius:12px;padding:${
             isShortViewport ? "10px 26px" : "12px 28px"
           };box-shadow:0 12px 32px rgba(0,0,0,0.45);color:#F8FAFC;font-family:'Pretendard','Noto Sans KR','Malgun Gothic','Apple SD Gothic Neo',sans-serif;font-size:${
          isShortViewport ? "24px" : "26px"
        };font-weight:600;letter-spacing:-0.01em;line-height:1.38;text-align:center;word-break:keep-all;">
             ${escapeHtml(bottomSubtitle)}
           </div>
         </div>`
      : ""
  }
</body>
</html>`;
}

export async function renderSlideHtmlToPng(
  html: string,
  outPngPath: string,
  width: number = 1920,
  height: number = 1080
): Promise<void> {
  fs.mkdirSync(path.dirname(outPngPath), { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: "load" });
    await page.screenshot({ path: outPngPath, type: "png" });
  } finally {
    await browser.close().catch(() => {});
  }
}

export function encodeSlidePngToMp4(options: {
  pngPath: string;
  outMp4Path: string;
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  audioMp3Path?: string;
}): void {
  const { pngPath, outMp4Path, durationSec, width, height, fps, audioMp3Path } = options;
  const dur = Math.max(1.5, Number(durationSec) || 4.5).toFixed(3);
  const w = Math.floor(width / 2) * 2;
  const h = Math.floor(height / 2) * 2;

  const hasAudioFile = Boolean(audioMp3Path && fs.existsSync(audioMp3Path));

  const args: string[] = ["-y", "-v", "error", "-loop", "1", "-t", dur, "-i", pngPath];
  if (hasAudioFile && audioMp3Path) {
    args.push("-i", audioMp3Path);
    args.push(
      "-filter_complex",
      `[0:v]scale=${w}:${h},fps=${fps},format=yuv420p[v];[1:a]aformat=sample_rates=48000:channel_layouts=stereo,apad=whole_dur=${dur}[a]`,
      "-map",
      "[v]",
      "-map",
      "[a]"
    );
  } else {
    args.push(
      "-f",
      "lavfi",
      "-t",
      dur,
      "-i",
      "anullsrc=channel_layout=stereo:sample_rate=48000",
      "-vf",
      `scale=${w}:${h},fps=${fps},format=yuv420p`,
      "-map",
      "0:v:0",
      "-map",
      "1:a:0"
    );
  }

  args.push(
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-tune",
    "stillimage",
    "-crf",
    "18",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-t",
    dur,
    "-movflags",
    "+faststart",
    outMp4Path
  );

  const res = spawnSync("ffmpeg", args, { encoding: "utf-8" });
  if (res.status !== 0 || !fs.existsSync(outMp4Path)) {
    throw new Error(`오프닝 슬라이드 비디오 인코딩 실패: ${res.stderr || "알 수 없는 오류"}`);
  }
}

function probeVideoMetaQuick(mp4Path: string): {
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
} {
  let durationSec = 10;
  let width = 1920;
  let height = 1080;
  let fps = 30;
  let hasAudio = false;

  try {
    const res = spawnSync(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration:stream=codec_type,width,height,r_frame_rate",
        "-of",
        "json",
        mp4Path,
      ],
      { encoding: "utf-8" }
    );
    if (res.status === 0 && res.stdout) {
      const parsed = JSON.parse(res.stdout);
      const fmtDur = parseFloat(parsed?.format?.duration || "0");
      if (Number.isFinite(fmtDur) && fmtDur > 0) durationSec = fmtDur;
      for (const s of parsed?.streams || []) {
        if (s.codec_type === "video") {
          if (s.width) width = Number(s.width);
          if (s.height) height = Number(s.height);
          if (typeof s.r_frame_rate === "string" && s.r_frame_rate.includes("/")) {
            const [num, den] = s.r_frame_rate.split("/").map(Number);
            if (num > 0 && den > 0) fps = Math.min(60, Math.max(24, Math.round(num / den)));
          }
        } else if (s.codec_type === "audio") {
          hasAudio = true;
        }
      }
    }
  } catch {}

  return { durationSec, width, height, fps, hasAudio };
}

function syncPublicRecording(slug: string, recordingMp4Path: string): void {
  try {
    const pubVideosDir = path.join(PUBLIC_DIR, "videos");
    fs.mkdirSync(pubVideosDir, { recursive: true });
    linkOrCopyFileSafe(recordingMp4Path, path.join(pubVideosDir, `${slug}.mp4`));
  } catch {}
}

/**
 * 시나리오의 오프닝 목차 슬라이드(IntroTocConfig + SiteBrandProfile)를
 * 실제 영상 구간(intro-slide.mp4)으로 렌더링하여 recording.mp4 앞단에 즉시 합성합니다.
 * 원본 순수 브라우저 녹화본은 recording.body.mp4 / moments.body.json에 보존되어
 * 언제든 목차 문구나 대본을 수정하면 1~2초 만에 슬라이드 구간만 깔끔하게 재합성됩니다.
 */
export async function bakeOpeningSlideIntoRecording(
  slug: string,
  options?: { force?: boolean; isNewRecording?: boolean }
): Promise<{
  baked: boolean;
  introDurationMs: number;
  siteBrand?: SiteBrandProfile;
}> {
  const sDir = path.join(DATA_DIR, slug);
  const recMp4Path = path.join(sDir, "recording.mp4");
  const bodyMp4Path = path.join(sDir, "recording.body.mp4");
  const momentsPath = path.join(sDir, "moments.json");
  const bodyMomentsPath = path.join(sDir, "moments.body.json");
  const narrationPath = path.join(sDir, "narration.json");
  const editPlanPath = path.join(sDir, "edit-plan.json");

  if (!fs.existsSync(recMp4Path) || !fs.existsSync(momentsPath) || !fs.existsSync(narrationPath)) {
    return { baked: false, introDurationMs: 0 };
  }

  const narration: NarrationFile & {
    _bakedSlideSig?: string;
    _cuesAreUnshiftedBody?: boolean;
    mergedFromSlugs?: string[];
  } = JSON.parse(fs.readFileSync(narrationPath, "utf-8"));

  // 통합 병합 시나리오(mergedFromSlugs)는 이미 앞단에 [표지 + 마스터 목차] 2장 슬라이드가 합성되어 있으므로
  // 단일 시나리오 슬라이드로 앞단을 덮어쓰지 않고 즉시 반환합니다.
  const bpPath = path.join(sDir, "browse-plan.json");
  let isMergedScenario = Array.isArray(narration.mergedFromSlugs) && narration.mergedFromSlugs.length > 0;
  if (!isMergedScenario && fs.existsSync(bpPath)) {
    try {
      const bp = JSON.parse(fs.readFileSync(bpPath, "utf-8"));
      if (Array.isArray(bp?.mergedFromSlugs) && bp.mergedFromSlugs.length > 0) {
        isMergedScenario = true;
      }
    } catch {}
  }
  if (isMergedScenario) {
    return {
      baked: true,
      introDurationMs: Number(narration.bakedIntroDurationMs || 0),
      siteBrand: narration.siteBrand,
    };
  }

  // 최초 실행 시 순수 본문 녹화본(recording.body.mp4 / moments.body.json) 백업 보존
  if (!fs.existsSync(bodyMp4Path)) {
    fs.copyFileSync(recMp4Path, bodyMp4Path);
  }
  if (!fs.existsSync(bodyMomentsPath)) {
    fs.copyFileSync(momentsPath, bodyMomentsPath);
  }
  const isUnshiftedCues = Boolean(narration._cuesAreUnshiftedBody || !narration.introBakedIntoVideo);
  const prevBakedMs = isUnshiftedCues ? 0 : Number(narration.bakedIntroDurationMs || 0);

  // 만약 사용자가 구간 잘라내기(cutVideoSegment)로 recording.mp4 / moments.json을 편집한 상태라면,
  // 구버전 미편집 recording.body.mp4가 편집본을 덮어쓰지 않도록 현재 편집된 본문 구간(prevBakedMs 이후)으로 동기화
  if (narration.introBakedIntoVideo && prevBakedMs > 500) {
    const prevBakedSec = Number((prevBakedMs / 1000).toFixed(3));
    const recProbe = probeVideoMetaQuick(recMp4Path);
    const bodyProbe = probeVideoMetaQuick(bodyMp4Path);
    const hasCutBackup = fs.existsSync(path.join(sDir, "recording.orig.mp4"));
    const bodyDurationMismatch = Math.abs(recProbe.durationSec - prevBakedSec - bodyProbe.durationSec) > 0.35;

    if ((hasCutBackup || bodyDurationMismatch) && recProbe.durationSec > prevBakedSec + 1.0) {
      const tmpBodyPath = path.join(sDir, "recording.body.sync_tmp.mp4");
      const ffSync = spawnSync(
        "ffmpeg",
        [
          "-y",
          "-v",
          "error",
          "-ss",
          prevBakedSec.toFixed(3),
          "-i",
          recMp4Path,
          "-c:v",
          "libx264",
          "-preset",
          "veryfast",
          "-crf",
          "18",
          "-pix_fmt",
          "yuv420p",
          ...(recProbe.hasAudio ? ["-c:a", "aac", "-b:a", "192k"] : ["-an"]),
          "-movflags",
          "+faststart",
          tmpBodyPath,
        ],
        { encoding: "utf-8" }
      );
      if (ffSync.status === 0 && fs.existsSync(tmpBodyPath)) {
        try {
          replaceFileSafeWithNewInode(tmpBodyPath, bodyMp4Path);
        } catch {}
      }
      try {
        const curMoments: MomentsFile = JSON.parse(fs.readFileSync(momentsPath, "utf-8"));
        const newBodyDurMs = Math.max(1000, Math.round((recProbe.durationSec - prevBakedSec) * 1000));
        const syncedBodyMoments: MomentsFile = {
          ...curMoments,
          metadata: {
            ...curMoments.metadata,
            totalDurationMs: newBodyDurMs,
            calibratedToVideoDurationMs: newBodyDurMs,
          } as any,
          moments: (curMoments.moments || [])
            .filter((m) => Number(m.timestamp || 0) >= prevBakedMs - 100)
            .map((m, idx) => ({
              ...m,
              id: idx + 1,
              timestamp: Math.max(0, Math.round(Number(m.timestamp || 0) - prevBakedMs)),
            })),
        };
        fs.writeFileSync(bodyMomentsPath, JSON.stringify(syncedBodyMoments, null, 2), "utf-8");
      } catch {}
    }
  }

  const bodyMoments: MomentsFile = JSON.parse(fs.readFileSync(bodyMomentsPath, "utf-8"));

  // 만약 사용자가 오프닝 목차 슬라이드를 비활성화한 경우 순수 본문으로 복원
  if (narration.showIntroToc === false || narration.introToc?.enabled === false || !narration.introToc) {
    if (narration.introBakedIntoVideo) {
      linkOrCopyFileSafe(bodyMp4Path, recMp4Path);
      fs.copyFileSync(bodyMomentsPath, momentsPath);
      syncPublicRecording(slug, recMp4Path);
      narration.introBakedIntoVideo = false;
      narration.bakedIntroDurationMs = 0;
      delete narration._bakedSlideSig;
      narration.cues = (narration.cues || []).map((c, idx) => {
        if (idx === 0) return c;
        const vStart = Math.max(0, Number(c.videoStartMs ?? c.startMs ?? 0) - prevBakedMs);
        const vEnd = Math.max(vStart + 400, Number(c.videoEndMs ?? c.endMs ?? vStart + 2500) - prevBakedMs);
        return { ...c, videoStartMs: vStart, videoEndMs: vEnd };
      });
      fs.writeFileSync(narrationPath, JSON.stringify(narration, null, 2), "utf-8");
      spawnSync("python", [path.join(ROOT_DIR, "scripts", "build-edit-plan.py"), slug, "--keep-last"], {
        cwd: ROOT_DIR,
        stdio: "ignore",
      });
    }
    return { baked: false, introDurationMs: 0 };
  }

  // 1. 대상 사이트 URL 기준 마스터 브랜드 프로필 확보 (AI 분석 + 실제 사이트 화면 썸네일/로고/테마컬러)
  const siteBrand = await ensureSiteBrandForScenario(slug);
  narration.siteBrand = siteBrand;
  narration.introToc.siteBrand = siteBrand;

  // 2. 오프닝 음성(cue 1) 길이에 맞춰 오프닝 슬라이드 표시 시간 산출
  const openingCue = narration.cues?.[0];
  let introAudioPath: string | undefined;
  let introAudioDurMs = Number(openingCue?.audioDurationMs || 0);
  if (openingCue?.audioFile) {
    const candidateAudio = path.join(sDir, "audio", path.basename(openingCue.audioFile));
    if (fs.existsSync(candidateAudio)) {
      introAudioPath = candidateAudio;
      if (!introAudioDurMs || introAudioDurMs < 500) {
        const meta = probeVideoMetaQuick(candidateAudio);
        introAudioDurMs = Math.round(meta.durationSec * 1000);
      }
    }
  }
  const introDurationMs = Math.max(4000, (introAudioDurMs || 4500) + 600);
  const introDurationSec = Number((introDurationMs / 1000).toFixed(3));

  const nextSlideSig = JSON.stringify({
    layoutVersion: "contents-only-v2",
    badge: narration.introToc.badge,
    title: narration.introToc.title,
    summary: narration.introToc.summary,
    items: narration.introToc.items,
    hostKey: siteBrand.hostKey,
    primaryColor: siteBrand.primaryColor,
    cue0Text: openingCue?.text || "",
    cue0Sig: (openingCue as any)?._ttsSig || "",
    introDurationMs,
  });

  if (
    !options?.force &&
    narration.introBakedIntoVideo &&
    prevBakedMs === introDurationMs &&
    narration._bakedSlideSig === nextSlideSig
  ) {
    return {
      baked: true,
      introDurationMs,
      siteBrand,
    };
  }

  // 3. 본문 비디오 해상도/FPS 확인 및 오프닝 슬라이드 PNG -> MP4 생성
  const bodyMeta = probeVideoMetaQuick(bodyMp4Path);
  const slidePngPath = path.join(sDir, "intro-slide.png");
  const slideMp4Path = path.join(sDir, "intro-slide.mp4");
  const tmpMergedMp4Path = path.join(sDir, "recording.slide_tmp.mp4");

  const html = buildSlideHtmlDocument({
    toc: narration.introToc,
    siteBrand,
    width: bodyMeta.width,
    height: bodyMeta.height,
    headerLabel: "Contents",
  });
  await renderSlideHtmlToPng(html, slidePngPath, bodyMeta.width, bodyMeta.height);

  encodeSlidePngToMp4({
    pngPath: slidePngPath,
    outMp4Path: slideMp4Path,
    durationSec: introDurationSec,
    width: bodyMeta.width,
    height: bodyMeta.height,
    fps: bodyMeta.fps,
    audioMp3Path: introAudioPath,
  });

  // 4. 오프닝 슬라이드(intro-slide.mp4) + 본문 녹화본(recording.body.mp4) 고속 병합
  const w = Math.floor(bodyMeta.width / 2) * 2;
  const h = Math.floor(bodyMeta.height / 2) * 2;
  const bodyDurStr = Math.max(0.5, bodyMeta.durationSec).toFixed(3);

  const filterParts: string[] = [
    `[0:v]scale=${w}:${h},fps=${bodyMeta.fps},format=yuv420p,setpts=PTS-STARTPTS[v0]`,
    `[0:a]aformat=sample_rates=48000:channel_layouts=stereo,asetpts=PTS-STARTPTS[a0]`,
    `[1:v]scale=${w}:${h},fps=${bodyMeta.fps},format=yuv420p,setpts=PTS-STARTPTS[v1]`,
  ];
  if (bodyMeta.hasAudio) {
    filterParts.push(`[1:a]aformat=sample_rates=48000:channel_layouts=stereo,asetpts=PTS-STARTPTS[a1]`);
  } else {
    filterParts.push(
      `anullsrc=channel_layout=stereo:sample_rate=48000,atrim=0:${bodyDurStr},asetpts=PTS-STARTPTS[a1]`
    );
  }
  filterParts.push(`[v0][a0][v1][a1]concat=n=2:v=1:a=1[outv][outa]`);

  const ffConcat = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-v",
      "error",
      "-i",
      slideMp4Path,
      "-i",
      bodyMp4Path,
      "-filter_complex",
      filterParts.join(";"),
      "-map",
      "[outv]",
      "-map",
      "[outa]",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "18",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-movflags",
      "+faststart",
      tmpMergedMp4Path,
    ],
    { encoding: "utf-8" }
  );

  try {
    if (fs.existsSync(slideMp4Path)) fs.unlinkSync(slideMp4Path);
  } catch {}

  if (ffConcat.status !== 0 || !fs.existsSync(tmpMergedMp4Path)) {
    throw new Error(`오프닝 슬라이드 + 본문 영상 합성 실패: ${ffConcat.stderr || "알 수 없는 오류"}`);
  }

  replaceFileSafeWithNewInode(tmpMergedMp4Path, recMp4Path);
  syncPublicRecording(slug, recMp4Path);

  // 5. moments.json 및 narration.json 타임스탬프를 오프닝 슬라이드 길이(+introDurationMs)만큼 정확히 시프트
  const newTotalMs = Math.round((bodyMoments.metadata?.totalDurationMs || bodyMeta.durationSec * 1000) + introDurationMs);
  const shiftedMoments: MomentsFile = {
    ...bodyMoments,
    metadata: {
      ...bodyMoments.metadata,
      totalDurationMs: newTotalMs,
      calibratedToVideoDurationMs: newTotalMs,
    } as any,
    moments: (bodyMoments.moments || []).map((m) => ({
      ...m,
      timestamp: Math.round(Number(m.timestamp || 0) + introDurationMs),
    })),
  };
  fs.writeFileSync(momentsPath, JSON.stringify(shiftedMoments, null, 2), "utf-8");

  // 새로 브라우저 녹화를 수행한 경우(isNewRecording: true)에만 구버전 렌더링 캐시를 초기화하고,
  // 대본/목차 수정 시에는 기존 rendered.base.mp4를 보존하여 3~5초 초고속 재합성에 활용합니다.
  if (options?.isNewRecording) {
    try {
      const staleOutputMp4 = path.join(ROOT_DIR, "output", `${slug}.mp4`);
      const staleBaseMp4 = path.join(sDir, "rendered.base.mp4");
      const staleBaseJson = path.join(sDir, "rendered.base.json");
      if (fs.existsSync(staleOutputMp4)) fs.unlinkSync(staleOutputMp4);
      if (fs.existsSync(staleBaseMp4)) fs.unlinkSync(staleBaseMp4);
      if (fs.existsSync(staleBaseJson)) fs.unlinkSync(staleBaseJson);
    } catch {}
  } else {
    try {
      await ensureRenderedBaseVideo(slug, prevBakedMs);
    } catch (e) {
      console.warn(`[FastRenderBase] '${slug}' 베이스 비디오 준비 경고:`, e);
    }
  }

  narration.cues = (narration.cues || []).map((c, idx) => {
    if (idx === 0) {
      return {
        ...c,
        isIntro: true,
        videoStartMs: 200,
        videoEndMs: introDurationMs,
        startMs: 200,
        endMs: Math.max(1500, introDurationMs - 200),
        autoHoldMs: 0,
        extraHoldMs: 0,
        effectiveDeltaMs: 0,
      };
    }
    const baseStart = Math.max(0, Number(c.videoStartMs ?? c.startMs ?? 0) - prevBakedMs);
    const baseEnd = Math.max(baseStart + 400, Number(c.videoEndMs ?? c.endMs ?? baseStart + 2500) - prevBakedMs);
    const shiftedStart = baseStart + introDurationMs;
    const shiftedEnd = baseEnd + introDurationMs;
    return {
      ...c,
      videoStartMs: shiftedStart,
      videoEndMs: shiftedEnd,
    };
  });

  narration.introBakedIntoVideo = true;
  narration.bakedIntroDurationMs = introDurationMs;
  narration._bakedSlideSig = nextSlideSig;
  delete narration._cuesAreUnshiftedBody;
  narration.updatedAt = new Date().toISOString();
  fs.writeFileSync(narrationPath, JSON.stringify(narration, null, 2), "utf-8");

  // 6. edit-plan.json 줌 세그먼트 보존(또는 최초 생성) 및 타임워프(timeRegions) 동기화
  if (prevBakedMs <= 0 || !fs.existsSync(editPlanPath)) {
    spawnSync("python", [path.join(ROOT_DIR, "scripts", "build-edit-plan.py"), slug, "--keep-last"], {
      cwd: ROOT_DIR,
      stdio: "ignore",
    });
  }

  let editPlan: any = null;
  if (fs.existsSync(editPlanPath)) {
    try {
      editPlan = JSON.parse(fs.readFileSync(editPlanPath, "utf-8"));
    } catch {}
  }
  const planFps = Number(editPlan?.fps || 60);
  if (prevBakedMs > 0 && editPlan && Array.isArray(editPlan.segments) && introDurationMs !== prevBakedMs) {
    const deltaFrames = Math.round(((introDurationMs - prevBakedMs) / 1000) * planFps);
    editPlan.segments = editPlan.segments.map((seg: any) => ({
      ...seg,
      startFrame: Math.max(0, Number(seg.startFrame || 0) + deltaFrames),
      endFrame: Math.max(1, Number(seg.endFrame || 0) + deltaFrames),
    }));
  }
  const { timeRegions, totalCompFrames, rawTotalFrames } = computeTimeRegionsAndSyncCues(
    narration.cues,
    newTotalMs,
    planFps,
    introDurationMs
  );
  narration.updatedAt = new Date().toISOString();
  fs.writeFileSync(narrationPath, JSON.stringify(narration, null, 2), "utf-8");

  if (editPlan) {
    editPlan.narration = narration;
    editPlan.timeRegions = timeRegions;
    editPlan.totalDurationFrames = totalCompFrames;
    editPlan.rawDurationFrames = rawTotalFrames;
    fs.writeFileSync(editPlanPath, JSON.stringify(editPlan, null, 2), "utf-8");
  }

  return {
    baked: true,
    introDurationMs,
    siteBrand,
  };
}

export interface RenderedBaseMeta {
  fps: number;
  width: number;
  height: number;
  bakedIntroDurationMs: number;
  totalDurationFrames: number;
  planFps: number;
  timeRegions: Array<{
    videoStartFrame: number;
    videoEndFrame: number;
    compStartFrame: number;
    compEndFrame: number;
    speed: number;
  }>;
}

async function renderSubtitleStripsBatch(
  cues: Array<{ index: number; text: string; maskExisting?: boolean }>,
  outDir: string,
  width: number = 1920,
  stripHeight: number = 180
): Promise<Map<number, string>> {
  const result = new Map<number, string>();
  if (cues.length === 0) return result;

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      viewport: { width, height: stripHeight },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    await page.setContent(
      `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8" />
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body {
    width: ${width}px;
    height: ${stripHeight}px;
    background: transparent;
    overflow: hidden;
    display: flex;
    justify-content: center;
    align-items: flex-end;
    padding: 0 48px 36px 48px;
  }
  html.mask-existing, body.mask-existing {
    background: linear-gradient(180deg, rgba(15, 23, 42, 0) 0%, rgba(15, 23, 42, 0.92) 24%, rgba(15, 23, 42, 0.98) 100%);
  }
  #sub-box {
    max-width: 1320px;
    background: rgba(15, 23, 42, 0.86);
    border: 1px solid rgba(148, 163, 184, 0.32);
    border-radius: 12px;
    padding: 12px 28px;
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
    color: #F8FAFC;
    font-family: 'Pretendard', 'Noto Sans KR', 'Malgun Gothic', 'Apple SD Gothic Neo', sans-serif;
    font-size: 27px;
    font-weight: 600;
    letter-spacing: -0.01em;
    line-height: 1.42;
    text-align: center;
    word-break: keep-all;
  }
  body.mask-existing #sub-box {
    min-width: 1260px;
    background: rgba(15, 23, 42, 0.98);
    border-color: rgba(148, 163, 184, 0.42);
  }
</style>
</head>
<body><div id="sub-box"></div></body>
</html>`,
      { waitUntil: "load" }
    );

    for (const item of cues) {
      const pngPath = path.join(outDir, `_sub_strip_${item.index}.png`);
      await page.evaluate(
        `(() => {
          document.documentElement.classList.toggle("mask-existing", Boolean(${Boolean(item.maskExisting)}));
          document.body.classList.toggle("mask-existing", Boolean(${Boolean(item.maskExisting)}));
          document.getElementById("sub-box").textContent = ${JSON.stringify(item.text)};
        })()`
      );
      await page.screenshot({
        path: pngPath,
        type: "png",
        omitBackground: true,
      });
      result.set(item.index, pngPath);
    }
  } finally {
    await browser.close().catch(() => {});
  }
  return result;
}

export async function ensureRenderedBaseVideo(
  slug: string,
  _overrideBakedIntroMs?: number
): Promise<boolean> {
  const sDir = path.join(DATA_DIR, slug);
  const baseMp4Path = path.join(sDir, "rendered.base.mp4");
  const baseJsonPath = path.join(sDir, "rendered.base.json");

  return fs.existsSync(baseMp4Path) && fs.existsSync(baseJsonPath);
}

async function fastApplyMergedScenarioNarration(
  slug: string,
  mergedFromSlugs: string[]
): Promise<{ updated: boolean; durationSec?: number; filePath?: string }> {
  const sDir = path.join(DATA_DIR, slug);
  const narrationPath = path.join(sDir, "narration.json");
  const momentsPath = path.join(sDir, "moments.json");
  const recMp4Path = path.join(sDir, "recording.mp4");
  const origMp4Path = path.join(sDir, "merged.orig.mp4");
  const origJsonPath = path.join(sDir, "merged.orig.json");
  const outMp4Path = path.join(ROOT_DIR, "output", `${slug}.mp4`);

  if (!fs.existsSync(narrationPath)) {
    return { updated: false };
  }

  if (!fs.existsSync(origMp4Path)) {
    if (fs.existsSync(outMp4Path)) {
      fs.copyFileSync(outMp4Path, origMp4Path);
    } else if (fs.existsSync(recMp4Path)) {
      fs.copyFileSync(recMp4Path, origMp4Path);
    } else {
      return { updated: false };
    }
  }

  const origProbe = probeVideoMetaQuick(origMp4Path);
  const origDurSec = origProbe.durationSec;
  if (origDurSec <= 1.0) {
    return { updated: false };
  }
  const origDurMs = Math.round(origDurSec * 1000);
  const W = Math.floor((origProbe.width || 1920) / 2) * 2;
  const H = Math.floor((origProbe.height || 1080) / 2) * 2;
  const stripHeight = 180;

  let fps = 60;
  let pixFmt = "yuvj420p";
  try {
    const sr = spawnSync(
      "ffprobe",
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=r_frame_rate,pix_fmt",
        "-of",
        "json",
        origMp4Path,
      ],
      { encoding: "utf-8" }
    );
    const st = JSON.parse(sr.stdout || "{}")?.streams?.[0];
    if (st?.pix_fmt) pixFmt = String(st.pix_fmt);
    if (st?.r_frame_rate) {
      const [num, den] = String(st.r_frame_rate).split("/").map(Number);
      if (num > 0 && den > 0) fps = Math.round(num / den);
    }
  } catch {}

  let narration: NarrationFile = JSON.parse(fs.readFileSync(narrationPath, "utf-8"));
  (narration as any).mergedFromSlugs = mergedFromSlugs;
  if ((narration as any)._bakedSlideSig) {
    delete (narration as any)._bakedSlideSig;
  }

  // moments.json의 totalDurationMs 복원 및 단일 슬라이드 오프셋 손상(예: -24.7s 조기 이동) 자동 복구
  let needsResave = false;
  const editPlanPath = path.join(sDir, "edit-plan.json");
  if (fs.existsSync(momentsPath)) {
    try {
      const mData = JSON.parse(fs.readFileSync(momentsPath, "utf-8"));
      let momentsChanged = false;
      if (Math.abs(Number(mData?.metadata?.totalDurationMs || 0) - origDurMs) > 500) {
        mData.metadata = mData.metadata || {};
        mData.metadata.totalDurationMs = origDurMs;
        mData.metadata.calibratedToVideoDurationMs = origDurMs;
        momentsChanged = true;
      }

      const bakedIntroMs = Number(narration.bakedIntroDurationMs || 0);
      const mList = Array.isArray(mData?.moments) ? mData.moments : [];
      if (bakedIntroMs >= 10000 && mList.length > 0 && Number(mList[0].timestamp || 0) < bakedIntroMs) {
        const ch0Slug = mergedFromSlugs[0];
        const ch0MomPath = ch0Slug ? path.join(DATA_DIR, ch0Slug, "moments.json") : "";
        let expectedFirstMomTs = 0;
        if (ch0MomPath && fs.existsSync(ch0MomPath)) {
          try {
            const ch0Mom = JSON.parse(fs.readFileSync(ch0MomPath, "utf-8"));
            const ch0FirstTs = Number(ch0Mom?.moments?.[0]?.timestamp || 0);
            const ch0StartInMerged = Math.max(
              bakedIntroMs - 250,
              Number(narration.cues?.[2]?.videoStartMs || bakedIntroMs) - 204
            );
            if (ch0FirstTs > 0) {
              expectedFirstMomTs = Math.round(ch0StartInMerged + ch0FirstTs);
            }
          } catch {}
        }
        const shiftMs =
          expectedFirstMomTs > Number(mList[0].timestamp || 0)
            ? expectedFirstMomTs - Number(mList[0].timestamp || 0)
            : 0;
        if (shiftMs >= 1000) {
          for (const m of mList) {
            m.timestamp = Math.max(0, Math.round(Number(m.timestamp || 0) + shiftMs));
          }
          momentsChanged = true;
          if (fs.existsSync(editPlanPath)) {
            try {
              const epData = JSON.parse(fs.readFileSync(editPlanPath, "utf-8"));
              const epFps = Number(epData?.fps || 60);
              const shiftFrames = Math.round((shiftMs / 1000) * epFps);
              if (Array.isArray(epData?.segments) && shiftFrames > 0) {
                epData.segments = epData.segments.map((seg: any) => ({
                  ...seg,
                  startFrame: Math.max(0, Number(seg.startFrame || 0) + shiftFrames),
                  endFrame: Math.max(1, Number(seg.endFrame || 0) + shiftFrames),
                }));
                fs.writeFileSync(editPlanPath, JSON.stringify(epData, null, 2), "utf-8");
              }
            } catch {}
          }
        }
      }

      if (momentsChanged) {
        fs.writeFileSync(momentsPath, JSON.stringify(mData, null, 2), "utf-8");
        needsResave = true;
      }
    } catch {}
  }

  // 기존 챕터(merged.orig.mp4)에 이미 구워져 있던 원본 대본 문장 및 TTS 시그니처 집합 수집
  const origTexts = new Set<string>();
  const origTtsSigs = new Set<string>();
  if (fs.existsSync(origJsonPath)) {
    try {
      const oj = JSON.parse(fs.readFileSync(origJsonPath, "utf-8"));
      for (const c of oj?.cues || []) {
        if (c?.text) origTexts.add(String(c.text).trim());
        if (c?._ttsSig) origTtsSigs.add(String(c._ttsSig).trim());
      }
    } catch {}
  } else {
    const snapCues: Array<{ text: string; _ttsSig?: string; videoStartMs?: number }> = [];
    for (const chSlug of mergedFromSlugs) {
      const chNarrPath = path.join(DATA_DIR, chSlug, "narration.json");
      if (fs.existsSync(chNarrPath)) {
        try {
          const chNarr = JSON.parse(fs.readFileSync(chNarrPath, "utf-8"));
          const chVoice = chNarr?.voice || "ko-KR-SunHiNeural";
          const chRate = chNarr?.rate || "+5%";
          const chPitch = chNarr?.pitch || "+0Hz";
          for (const c of chNarr?.cues || []) {
            const t = String(c?.text || "").trim();
            if (!t) continue;
            const sig = String(c?._ttsSig || `${chVoice}|${chRate}|${chPitch}|${t}`).trim();
            origTexts.add(t);
            origTtsSigs.add(sig);
            snapCues.push({ text: t, _ttsSig: sig, videoStartMs: c?.videoStartMs });
          }
        } catch {}
      }
    }
    if (snapCues.length > 0) {
      try {
        fs.writeFileSync(
          origJsonPath,
          JSON.stringify(
            {
              mergedFromSlugs,
              totalFrontIntroMs: Number(narration.bakedIntroDurationMs || 29800),
              cues: snapCues,
            },
            null,
            2
          ),
          "utf-8"
        );
      } catch {}
    }
  }
  for (const chSlug of mergedFromSlugs) {
    const chNarrPath = path.join(DATA_DIR, chSlug, "narration.json");
    if (fs.existsSync(chNarrPath)) {
      try {
        const chNarr = JSON.parse(fs.readFileSync(chNarrPath, "utf-8"));
        const chVoice = chNarr?.voice || "ko-KR-SunHiNeural";
        const chRate = chNarr?.rate || "+5%";
        const chPitch = chNarr?.pitch || "+0Hz";
        for (const c of chNarr?.cues || []) {
          const t = String(c?.text || "").trim();
          if (t) {
            origTexts.add(t);
            origTtsSigs.add(String(c?._ttsSig || `${chVoice}|${chRate}|${chPitch}|${t}`).trim());
          }
        }
      } catch {}
    }
  }
  if (narration.cues?.[0]?.text) origTexts.add(String(narration.cues[0].text).trim());
  if (narration.cues?.[1]?.text) origTexts.add(String(narration.cues[1].text).trim());

  const isAutoBridgeLine = (txt: string, cueObj?: any) =>
    Boolean(cueObj?._isAutoBridgeCue) || /사용법에\s*대해\s*알아보겠습니다\.?$/.test(txt);

  // 브릿지 큐(_isAutoBridgeCue) 및 챕터별 오프닝(isIntro) 플래그 정규화 + 음성 겹침 자동 보정
  const cuesList = Array.isArray(narration.cues) ? narration.cues : [];
  const isSingleMode = (narration as any).mergeMode === "single";
  for (let i = 0; i < cuesList.length; i++) {
    const c = cuesList[i];
    const cleanTxt = String(c.text || "").trim();
    const isBridge = i >= 2 && isAutoBridgeLine(cleanTxt, c);
    const prevIsBridge =
      i >= 3 ? isAutoBridgeLine(String(cuesList[i - 1]?.text || "").trim(), cuesList[i - 1]) : false;

    const expectedIsIntro = isSingleMode ? i === 0 : (i === 0 || i === 1 || i === 2 || prevIsBridge);
    if (Boolean(c.isIntro) !== expectedIsIntro) {
      c.isIntro = expectedIsIntro;
      needsResave = true;
    }
    if (isBridge && !(c as any)._isAutoBridgeCue) {
      (c as any)._isAutoBridgeCue = true;
      needsResave = true;
    } else if (!isBridge && (c as any)._isAutoBridgeCue) {
      delete (c as any)._isAutoBridgeCue;
      needsResave = true;
    }

    if (isBridge) {
      const prev = cuesList[i - 1];
      if (prev && !prevIsBridge) {
        const prevVoiceEndMs = Number(prev.videoStartMs || 0) + Number(prev.audioDurationMs || 0);
        const nextVStartMs =
          i + 1 < cuesList.length ? Number(cuesList[i + 1].videoStartMs || origDurMs) : origDurMs;
        if (Number(c.videoStartMs || 0) < prevVoiceEndMs && nextVStartMs >= prevVoiceEndMs + 200) {
          c.videoStartMs = Math.min(nextVStartMs - 200, prevVoiceEndMs + 80);
          needsResave = true;
        }
      }
    }
  }

  if (needsResave) {
    narration = saveNarrationFile(slug, narration);
  }

  const curVoice = narration.voice || "ko-KR-SunHiNeural";
  const curRate = narration.rate || "+5%";
  const curPitch = narration.pitch || "+0Hz";
  const finalCues = Array.isArray(narration.cues) ? narration.cues : [];
  const customCues = finalCues
    .map((c, idx) => {
      const cleanTxt = String(c.text || "").trim();
      const sig = String((c as any)._ttsSig || `${curVoice}|${curRate}|${curPitch}|${cleanTxt}`).trim();
      const isBridge = isAutoBridgeLine(cleanTxt, c);
      const textChanged = !origTexts.has(cleanTxt);
      const voiceOrTextChanged = textChanged || (origTtsSigs.size > 0 && !origTtsSigs.has(sig));
      const hasExtraHold = Math.abs(Number(c.extraHoldMs || 0)) > 50 || Number(c.autoHoldMs || 0) > 120;
      return {
        cue: c,
        idx,
        isBridge,
        textChanged,
        shouldSplice: (isSingleMode ? idx >= 1 : idx >= 2) && (isBridge || voiceOrTextChanged || hasExtraHold),
      };
    })
    .filter((item) => item.shouldSplice);

  const syncMergedOutputs = (srcMp4: string) => {
    try {
      replaceFileSafeWithNewInode(srcMp4, outMp4Path);
    } catch {
      linkOrCopyFileSafe(srcMp4, outMp4Path);
    }
    try {
      linkOrCopyFileSafe(outMp4Path, recMp4Path);
    } catch {}
    const pubVideoPath = path.join(PUBLIC_DIR, "videos", `${slug}.mp4`);
    if (fs.existsSync(path.dirname(pubVideoPath))) {
      try {
        linkOrCopyFileSafe(outMp4Path, pubVideoPath);
      } catch {}
    }
  };

  // 키프레임 목록 추출
  let keyframes: number[] = [0];
  try {
    const kRes = spawnSync(
      "ffprobe",
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "packet=pts_time,flags",
        "-of",
        "csv=p=0",
        origMp4Path,
      ],
      { encoding: "utf-8", maxBuffer: 50 * 1024 * 1024 }
    );
    const parsed = (kRes.stdout || "")
      .split(/\r?\n/)
      .filter((line) => line.includes("K"))
      .map((line) => parseFloat(line.split(",")[0]))
      .filter((n) => Number.isFinite(n) && n >= 0)
      .sort((a, b) => a - b);
    if (parsed.length > 0) keyframes = parsed;
  } catch {}

  const tempFiles: string[] = [];
  try {
    // 1. 앞단 [첫장: 표지 슬라이드(cues[0])] + [둘째장: 마스터 목차 슬라이드(cues[1])] 최신 대본·음성으로 재렌더링
    let ch0Brand: SiteBrandProfile | undefined;
    if (mergedFromSlugs[0]) {
      const ch0NarrPath = path.join(DATA_DIR, mergedFromSlugs[0], "narration.json");
      if (fs.existsSync(ch0NarrPath)) {
        try {
          ch0Brand = JSON.parse(fs.readFileSync(ch0NarrPath, "utf-8"))?.siteBrand;
        } catch {}
      }
    }
    const siteBrand =
      (ch0Brand?.logoUrl ? ch0Brand : undefined) ||
      (narration.siteBrand?.logoUrl ? narration.siteBrand : undefined) ||
      ch0Brand ||
      narration.siteBrand ||
      (await ensureSiteBrandForScenario(mergedFromSlugs[0] || slug));
    narration.siteBrand = siteBrand;

    // 통합 목차(introToc.items)가 병합 챕터 수보다 적거나 title이 비어 있다면 각 챕터의 실제 제목·요약으로 복원
    if (
      narration.introToc &&
      (!Array.isArray(narration.introToc.items) ||
        narration.introToc.items.length < mergedFromSlugs.length ||
        narration.introToc.items.some((it) => !String(it?.title || "").trim() || it.title === it.description))
    ) {
      const existingItems = Array.isArray(narration.introToc.items) ? narration.introToc.items : [];
      const rebuiltItems = mergedFromSlugs.map((chSlug, chIdx) => {
        const chNarrPath = path.join(DATA_DIR, chSlug, "narration.json");
        let chTitle = chSlug;
        let chSummary = `${chSlug}의 주요 기능과 사용 절차를 안내합니다.`;
        if (fs.existsSync(chNarrPath)) {
          try {
            const cn = JSON.parse(fs.readFileSync(chNarrPath, "utf-8"));
            if (cn?.introToc?.title) chTitle = cn.introToc.title;
            if (cn?.introToc?.summary) chSummary = cn.introToc.summary;
          } catch {}
        }
        const ex = existingItems[chIdx];
        const exTitle = String(ex?.title || "").trim();
        const exDesc = String(ex?.description || "").trim();
        const useTitle = exTitle && exTitle !== exDesc ? exTitle : chTitle;
        const useDesc = exDesc && exDesc !== useTitle ? exDesc : chSummary;
        return { title: useTitle, description: useDesc };
      });
      narration.introToc.items = rebuiltItems;
    }

    const shortModuleLabels = (narration.introToc?.items || [])
      .map((it) => {
        const rawName = String(it.title || it.description || "").trim();
        const cleaned = rawName
          .replace(/\s*(?:사용\s*매뉴얼|매뉴얼|가이드|안내)+$/g, "")
          .replace(/\s+(?:및|와|과)$/g, "")
          .trim();
        return cleaned || rawName;
      })
      .filter(Boolean);

    if (narration.introToc && shortModuleLabels.length > 0) {
      narration.introToc.summary = `총 ${mergedFromSlugs.length}개 주요 시나리오(${shortModuleLabels.join(
        " · "
      )})의 핵심 개념과 상세 사용 방법을 순서대로 안내합니다.`;
      if (!narration.introToc.title || narration.introToc.title === "그룹웨어 사용 매뉴얼") {
        narration.introToc.title = `${siteBrand.siteName} 주요 시나리오 목차`;
      }
    }

    // 만약 cues[1](통합목차 대본)에 과거 조사 잘림("접속 및, ")이 남아 있다면 자동 정제
    if (finalCues[1] && typeof finalCues[1].text === "string" && /\s+(?:및|와|과)\s*,/.test(finalCues[1].text)) {
      finalCues[1].text = finalCues[1].text.replace(/\s+(?:및|와|과)\s*,/g, ",");
      const c1Mp3 = finalCues[1].audioFile
        ? path.join(sDir, "audio", path.basename(finalCues[1].audioFile))
        : path.join(sDir, "audio", "cue-02.mp3");
      try {
        spawnSync(
          "python",
          [
            "-m",
            "edge_tts",
            "--voice",
            curVoice,
            `--rate=${curRate}`,
            `--pitch=${curPitch}`,
            "--text",
            finalCues[1].text,
            "--write-media",
            c1Mp3,
          ],
          { cwd: ROOT_DIR, encoding: "utf-8", timeout: 25000 }
        );
        if (fs.existsSync(c1Mp3)) {
          const pubC1 = path.join(PUBLIC_DIR, "narration", slug, path.basename(c1Mp3));
          fs.mkdirSync(path.dirname(pubC1), { recursive: true });
          fs.copyFileSync(c1Mp3, pubC1);
          const durSec = probeVideoMetaQuick(c1Mp3).durationSec;
          if (durSec > 1.0) {
            finalCues[1].audioDurationMs = Math.round(durSec * 1000);
            finalCues[1].endMs = Number(finalCues[1].startMs || 6900) + finalCues[1].audioDurationMs;
            finalCues[1].compEndMs = finalCues[1].endMs;
          }
          (finalCues[1] as any)._ttsSig = `${curVoice}|${curRate}|${curPitch}|${finalCues[1].text}`;
        }
      } catch {}
    }

    try {
      fs.writeFileSync(narrationPath, JSON.stringify(narration, null, 2), "utf-8");
    } catch {}

    const encodeStaticSlideToTs = (opts: {
      pngPath: string;
      durSec: number;
      mp3Path?: string;
      tsOutPath: string;
    }) => {
      const durStr = Math.max(1.5, opts.durSec).toFixed(3);
      const args: string[] = ["-y", "-v", "error", "-loop", "1", "-t", durStr, "-i", opts.pngPath];
      const hasMp3 = Boolean(opts.mp3Path && fs.existsSync(opts.mp3Path));
      if (hasMp3 && opts.mp3Path) {
        args.push("-i", opts.mp3Path);
      }
      const fGraph = hasMp3
        ? `[0:v]scale=${W}:${H},fps=${fps},format=${pixFmt},setpts=PTS-STARTPTS[v];anullsrc=channel_layout=stereo:sample_rate=48000,atrim=0:${durStr},asetpts=PTS-STARTPTS[abg];[1:a]aformat=sample_rates=48000:channel_layouts=stereo,adelay=200|200[afg];[abg][afg]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[a]`
        : `[0:v]scale=${W}:${H},fps=${fps},format=${pixFmt},setpts=PTS-STARTPTS[v];anullsrc=channel_layout=stereo:sample_rate=48000,atrim=0:${durStr},asetpts=PTS-STARTPTS[a]`;
      args.push(
        "-filter_complex",
        fGraph,
        "-map",
        "[v]",
        "-map",
        "[a]",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "18",
        "-pix_fmt",
        pixFmt,
        "-r",
        String(fps),
        "-c:a",
        "aac",
        "-ar",
        "48000",
        "-ac",
        "2",
        "-b:a",
        "192k",
        "-bsf:v",
        "h264_mp4toannexb",
        "-f",
        "mpegts",
        opts.tsOutPath
      );
      spawnSync("ffmpeg", args, { encoding: "utf-8" });
    };

    const tsSegments: string[] = [];
    let segCounter = 0;
    const bakedIntroTargetSec = Math.max(
      isSingleMode ? 3.5 : 8.0,
      Number(narration.bakedIntroDurationMs || (isSingleMode ? 5000 : 29600)) / 1000
    );
    let introEndKf = bakedIntroTargetSec;
    let bestKfDiff = 999;
    for (const kf of keyframes) {
      const d = Math.abs(kf - bakedIntroTargetSec);
      if (d < bestKfDiff && d <= 2.5) {
        bestKfDiff = d;
        introEndKf = kf;
      }
    }

    if (isSingleMode && finalCues.length >= 1 && narration.introToc) {
      const cue0 = finalCues[0];
      const singleText = String(
        cue0?.text || `${siteBrand.siteName} 동영상 매뉴얼을 시작합니다.`
      ).trim();
      const singleMp3 = cue0?.audioFile
        ? path.join(sDir, "audio", path.basename(cue0.audioFile))
        : path.join(sDir, "audio", "cue-01.mp3");

      const singleAudioSec =
        Number(cue0?.audioDurationMs || 0) > 0
          ? Number(cue0.audioDurationMs) / 1000
          : singleMp3 && fs.existsSync(singleMp3)
          ? probeVideoMetaQuick(singleMp3).durationSec || 4.2
          : 4.0;
      const singleDurSec = Math.max(
        4.0,
        Number((cue0?.videoEndMs ? cue0.videoEndMs / 1000 : singleAudioSec + 0.6).toFixed(3))
      );

      const singleSlidePngPath = path.join(sDir, "single-intro-slide.png");
      const singleHtml = buildSlideHtmlDocument({
        toc: narration.introToc,
        siteBrand,
        width: W,
        height: H,
        mode: "detail",
        subtitleText: singleText,
      });
      await renderSlideHtmlToPng(singleHtml, singleSlidePngPath, W, H);

      const singleTsPath = path.join(ROOT_DIR, "output", `${slug}_mseg_${segCounter++}.ts`);
      tempFiles.push(singleTsPath);
      encodeStaticSlideToTs({
        pngPath: singleSlidePngPath,
        durSec: singleDurSec,
        mp3Path: fs.existsSync(singleMp3) ? singleMp3 : undefined,
        tsOutPath: singleTsPath,
      });

      if (fs.existsSync(singleTsPath)) {
        tsSegments.push(singleTsPath);
      }
    } else if (finalCues.length >= 2 && narration.introToc) {
      const cue0 = finalCues[0];
      const cue1 = finalCues[1];
      const coverText = String(
        cue0?.text || `${siteBrand.siteName} 그룹웨어 사용 매뉴얼 영상을 시작합니다.`
      ).trim();
      const masterText = String(cue1?.text || "").trim();

      const coverMp3 = cue0?.audioFile
        ? path.join(sDir, "audio", path.basename(cue0.audioFile))
        : "";
      const masterMp3 = cue1?.audioFile
        ? path.join(sDir, "audio", path.basename(cue1.audioFile))
        : "";

      const coverAudioSec =
        Number(cue0?.audioDurationMs || 0) > 0
          ? Number(cue0.audioDurationMs) / 1000
          : coverMp3 && fs.existsSync(coverMp3)
          ? probeVideoMetaQuick(coverMp3).durationSec || 4.3
          : 4.3;
      const coverDurSec = Math.max(
        4.0,
        Number((cue0?.videoEndMs ? cue0.videoEndMs / 1000 : coverAudioSec + 0.6).toFixed(3))
      );
      const masterDurSec = Math.max(4.5, Number((introEndKf - coverDurSec).toFixed(3)));

      const coverPngPath = path.join(sDir, "master-cover-slide.png");
      const coverHtml = buildCoverSlideHtmlDocument({
        siteBrand,
        title: "그룹웨어 사용 매뉴얼",
        subtitle: `${siteBrand.siteName} 주요 업무 모듈별 핵심 기능 및 표준 사용 절차를 안내합니다.`,
        chapterTitles: shortModuleLabels,
        width: W,
        height: H,
        subtitleText: coverText,
      });
      await renderSlideHtmlToPng(coverHtml, coverPngPath, W, H);

      const masterPngPath = path.join(sDir, "master-intro-slide.png");
      const masterHtml = buildSlideHtmlDocument({
        toc: narration.introToc,
        siteBrand,
        width: W,
        height: H,
        headerLabel: "Contents",
        subtitleText: masterText,
        mode: "chapter-titles",
      });
      await renderSlideHtmlToPng(masterHtml, masterPngPath, W, H);

      const coverTsPath = path.join(ROOT_DIR, "output", `${slug}_mseg_${segCounter++}.ts`);
      const masterTsPath = path.join(ROOT_DIR, "output", `${slug}_mseg_${segCounter++}.ts`);
      tempFiles.push(coverTsPath, masterTsPath);

      encodeStaticSlideToTs({
        pngPath: coverPngPath,
        durSec: coverDurSec,
        mp3Path: coverMp3,
        tsOutPath: coverTsPath,
      });
      encodeStaticSlideToTs({
        pngPath: masterPngPath,
        durSec: masterDurSec,
        mp3Path: masterMp3,
        tsOutPath: masterTsPath,
      });

      if (fs.existsSync(coverTsPath) && fs.existsSync(masterTsPath)) {
        tsSegments.push(coverTsPath, masterTsPath);
      }
    }

    const stripMap =
      customCues.length > 0
        ? await renderSubtitleStripsBatch(
            customCues.map(({ cue, idx, isBridge }) => ({
              index: idx,
              text: String(cue.text || "").trim(),
              maskExisting: !isBridge,
            })),
            sDir,
            W,
            stripHeight
          )
        : new Map<number, string>();
    for (const p of stripMap.values()) {
      tempFiles.push(p);
    }

    interface CustomCueItem {
      idx: number;
      vStartSec: number;
      vEndSec: number;
      holdSec: number;
      subDurSec: number;
      pngPath?: string;
      mp3Path?: string;
    }

    const cueItems: CustomCueItem[] = customCues.map(({ cue, idx, isBridge }) => {
      const nextCue = idx + 1 < finalCues.length ? finalCues[idx + 1] : null;
      const vStartSec = Math.max(0, Math.min(origDurSec - 0.1, Number(cue.videoStartMs || 0) / 1000));
      const rawVEndSec = Math.max(
        vStartSec + 0.1,
        Math.min(origDurSec, Number(cue.videoEndMs || Number(cue.videoStartMs || 0) + 500) / 1000)
      );
      const vEndSec =
        nextCue?.isIntro && rawVEndSec - vStartSec > 0.3
          ? Math.max(vStartSec + 0.1, rawVEndSec - 0.25)
          : rawVEndSec;
      const holdSec = Math.max(
        0,
        (Number(cue.autoHoldMs || 0) + Number(cue.extraHoldMs || 0)) / 1000
      );
      const audioDurSec = Math.max(0.5, Number(cue.audioDurationMs || 2500) / 1000);
      const mp3Candidate = cue.audioFile
        ? path.join(sDir, "audio", path.basename(cue.audioFile))
        : "";
      const totalOutSpanSec = vEndSec - vStartSec + holdSec;
      const subDurSec = isBridge
        ? Math.min(totalOutSpanSec, audioDurSec + 0.25)
        : Math.min(totalOutSpanSec, Math.max(audioDurSec + 0.35, vEndSec - vStartSec));
      return {
        idx,
        vStartSec,
        vEndSec,
        holdSec,
        subDurSec,
        pngPath: stripMap.get(idx),
        mp3Path: mp3Candidate && fs.existsSync(mp3Candidate) ? mp3Candidate : undefined,
      };
    });

    interface SpliceWindow {
      kfStart: number;
      kfEnd: number;
      items: CustomCueItem[];
    }

    const minBodyStartSec = tsSegments.length >= (isSingleMode ? 1 : 2) ? introEndKf : 0;
    const windows: SpliceWindow[] = [];
    for (const item of cueItems) {
      let kfStart = minBodyStartSec;
      for (const kf of keyframes) {
        if (kf < minBodyStartSec) continue;
        if (kf <= item.vStartSec - 0.05) kfStart = kf;
        else break;
      }
      let kfEnd = origDurSec;
      for (const kf of keyframes) {
        if (kf >= item.vEndSec + 0.05) {
          kfEnd = kf;
          break;
        }
      }
      const prevWin = windows[windows.length - 1];
      if (prevWin && kfStart <= prevWin.kfEnd + 0.05) {
        prevWin.kfEnd = Math.max(prevWin.kfEnd, kfEnd);
        prevWin.items.push(item);
      } else {
        windows.push({ kfStart, kfEnd, items: [item] });
      }
    }

    let cursorSec = minBodyStartSec;

    const extractCopyTs = (startSec: number, endSec: number) => {
      const dur = endSec - startSec;
      if (dur <= 0.05) return;
      const tsPath = path.join(ROOT_DIR, "output", `${slug}_mseg_${segCounter++}.ts`);
      tempFiles.push(tsPath);
      const res = spawnSync(
        "ffmpeg",
        [
          "-y",
          "-v",
          "error",
          "-ss",
          startSec.toFixed(6),
          "-t",
          dur.toFixed(6),
          "-i",
          origMp4Path,
          "-c",
          "copy",
          "-bsf:v",
          "h264_mp4toannexb",
          "-f",
          "mpegts",
          tsPath,
        ],
        { encoding: "utf-8" }
      );
      if (res.status === 0 && fs.existsSync(tsPath)) {
        tsSegments.push(tsPath);
      }
    };

    for (const win of windows) {
      if (win.kfStart - cursorSec > 0.05) {
        extractCopyTs(cursorSec, win.kfStart);
      }

      const winDur = Math.max(0.1, win.kfEnd - win.kfStart);
      const tsPath = path.join(ROOT_DIR, "output", `${slug}_mseg_${segCounter++}.ts`);
      tempFiles.push(tsPath);

      const inArgs: string[] = [
        "-y",
        "-v",
        "error",
        "-ss",
        win.kfStart.toFixed(6),
        "-t",
        winDur.toFixed(6),
        "-i",
        origMp4Path,
      ];
      let nextInIdx = 1;
      const itemInputs = win.items.map((it) => {
        let subIn = -1;
        let audIn = -1;
        if (it.pngPath && fs.existsSync(it.pngPath)) {
          inArgs.push("-i", it.pngPath);
          subIn = nextInIdx++;
        }
        if (it.mp3Path && fs.existsSync(it.mp3Path)) {
          inArgs.push("-i", it.mp3Path);
          audIn = nextInIdx++;
        }
        return { item: it, subIn, audIn };
      });

      const fParts: string[] = [];
      const concatPairs: string[] = [];
      let localCur = 0;
      let partIdx = 0;

      for (const { item, subIn, audIn } of itemInputs) {
        const relStart = Math.max(localCur, item.vStartSec - win.kfStart);
        const relEnd = Math.min(winDur, Math.max(relStart + 0.08, item.vEndSec - win.kfStart));

        if (relStart - localCur > 0.04) {
          const gDur = relStart - localCur;
          const p = partIdx++;
          fParts.push(
            `[0:v]trim=start=${localCur.toFixed(3)}:duration=${gDur.toFixed(3)},setpts=PTS-STARTPTS,fps=${fps},scale=${W}:${H},format=${pixFmt}[v_${p}]`
          );
          fParts.push(
            `[0:a]atrim=start=${localCur.toFixed(3)}:duration=${gDur.toFixed(3)},asetpts=PTS-STARTPTS,aformat=sample_rates=48000:channel_layouts=stereo[a_${p}]`
          );
          concatPairs.push(`[v_${p}][a_${p}]`);
        }

        const vSpan = Math.max(0.05, relEnd - relStart);
        const outDur = vSpan + item.holdSec;
        const p = partIdx++;
        const tpadStr =
          item.holdSec > 0.04 ? `,tpad=stop_mode=clone:stop_duration=${item.holdSec.toFixed(3)}` : "";

        if (subIn >= 0) {
          const yPos = Math.max(0, H - stripHeight);
          fParts.push(
            `[0:v]trim=start=${relStart.toFixed(3)}:duration=${vSpan.toFixed(3)},setpts=PTS-STARTPTS${tpadStr},fps=${fps},scale=${W}:${H},format=${pixFmt}[vc_raw_${p}]`
          );
          fParts.push(
            `[vc_raw_${p}][${subIn}:v]overlay=0:${yPos}:enable='between(t,0,${item.subDurSec.toFixed(2)})',format=${pixFmt}[v_${p}]`
          );
        } else {
          fParts.push(
            `[0:v]trim=start=${relStart.toFixed(3)}:duration=${vSpan.toFixed(3)},setpts=PTS-STARTPTS${tpadStr},fps=${fps},scale=${W}:${H},format=${pixFmt}[v_${p}]`
          );
        }

        if (audIn >= 0) {
          fParts.push(
            `anullsrc=channel_layout=stereo:sample_rate=48000,atrim=0:${outDur.toFixed(3)},asetpts=PTS-STARTPTS[abg_${p}]`
          );
          fParts.push(
            `[${audIn}:a]aformat=sample_rates=48000:channel_layouts=stereo,asetpts=PTS-STARTPTS[afg_${p}]`
          );
          fParts.push(
            `[abg_${p}][afg_${p}]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[a_${p}]`
          );
        } else {
          fParts.push(
            `[0:a]atrim=start=${relStart.toFixed(3)}:duration=${vSpan.toFixed(3)},asetpts=PTS-STARTPTS,apad=whole_dur=${outDur.toFixed(3)},aformat=sample_rates=48000:channel_layouts=stereo[a_${p}]`
          );
        }

        concatPairs.push(`[v_${p}][a_${p}]`);
        localCur = relEnd;
      }

      if (winDur - localCur > 0.04) {
        const tDur = winDur - localCur;
        const p = partIdx++;
        fParts.push(
          `[0:v]trim=start=${localCur.toFixed(3)}:duration=${tDur.toFixed(3)},setpts=PTS-STARTPTS,fps=${fps},scale=${W}:${H},format=${pixFmt}[v_${p}]`
        );
        fParts.push(
          `[0:a]atrim=start=${localCur.toFixed(3)}:duration=${tDur.toFixed(3)},asetpts=PTS-STARTPTS,aformat=sample_rates=48000:channel_layouts=stereo[a_${p}]`
        );
        concatPairs.push(`[v_${p}][a_${p}]`);
      }

      fParts.push(`${concatPairs.join("")}concat=n=${concatPairs.length}:v=1:a=1[outv][outa]`);

      const wRes = spawnSync(
        "ffmpeg",
        [
          ...inArgs,
          "-filter_complex",
          fParts.join(";"),
          "-map",
          "[outv]",
          "-map",
          "[outa]",
          "-c:v",
          "libx264",
          "-preset",
          "veryfast",
          "-crf",
          "18",
          "-pix_fmt",
          pixFmt,
          "-r",
          String(fps),
          "-c:a",
          "aac",
          "-ar",
          "48000",
          "-ac",
          "2",
          "-b:a",
          "192k",
          "-bsf:v",
          "h264_mp4toannexb",
          "-f",
          "mpegts",
          tsPath,
        ],
        { encoding: "utf-8" }
      );

      if (wRes.status !== 0 || !fs.existsSync(tsPath)) {
        console.error(`[FastMergedNarration] 구간 합성 오류 (${slug}):`, wRes.stderr);
        return { updated: false };
      }
      tsSegments.push(tsPath);
      cursorSec = win.kfEnd;
    }

    if (origDurSec - cursorSec > 0.05) {
      extractCopyTs(cursorSec, origDurSec);
    }

    const listTxtPath = path.join(ROOT_DIR, "output", `${slug}_mconcat_list.txt`);
    tempFiles.push(listTxtPath);
    const listContent = tsSegments
      .map((p) => `file '${path.basename(p).replace(/'/g, "'\\''")}'`)
      .join("\n");
    fs.writeFileSync(listTxtPath, listContent, "utf-8");

    const tmpOutPath = path.join(ROOT_DIR, "output", `${slug}_mfast_out.mp4`);
    tempFiles.push(tmpOutPath);

    const cRes = spawnSync(
      "ffmpeg",
      [
        "-y",
        "-v",
        "error",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        listTxtPath,
        "-c",
        "copy",
        "-bsf:a",
        "aac_adtstoasc",
        "-movflags",
        "+faststart",
        tmpOutPath,
      ],
      { encoding: "utf-8" }
    );

    if (cRes.status !== 0 || !fs.existsSync(tmpOutPath)) {
      console.error(`[FastMergedNarration] 최종 병합 오류 (${slug}):`, cRes.stderr);
      return { updated: false };
    }

    syncMergedOutputs(tmpOutPath);
    const finalMeta = probeVideoMetaQuick(outMp4Path);
    return {
      updated: true,
      durationSec: finalMeta.durationSec,
      filePath: outMp4Path,
    };
  } finally {
    for (const tf of tempFiles) {
      try {
        if (fs.existsSync(tf)) fs.unlinkSync(tf);
      } catch {}
    }
  }
}

/**
 * 이미 렌더링된 베이스 영상(rendered.base.mp4) 위에
 * 변경된 대본 자막, 오프닝 슬라이드, TTS 오디오 및 홀드 구간을 FFmpeg로 3~5초 만에 초고속 재합성합니다.
 * (Remotion 전체 재렌더링 없이 output/<slug>.mp4 즉시 갱신)
 */
export async function fastApplyNarrationToRenderedMp4(
  slug: string
): Promise<{ updated: boolean; durationSec?: number; filePath?: string }> {
  const sDir = path.join(DATA_DIR, slug);
  const narrationPath = path.join(sDir, "narration.json");
  const bpPath = path.join(sDir, "browse-plan.json");

  let mergedFromSlugs: string[] = [];
  if (fs.existsSync(narrationPath)) {
    try {
      const nObj = JSON.parse(fs.readFileSync(narrationPath, "utf-8"));
      if (Array.isArray(nObj?.mergedFromSlugs) && nObj.mergedFromSlugs.length > 0) {
        mergedFromSlugs = nObj.mergedFromSlugs;
      }
    } catch {}
  }
  if (mergedFromSlugs.length === 0 && fs.existsSync(bpPath)) {
    try {
      const bpObj = JSON.parse(fs.readFileSync(bpPath, "utf-8"));
      if (Array.isArray(bpObj?.mergedFromSlugs) && bpObj.mergedFromSlugs.length > 0) {
        mergedFromSlugs = bpObj.mergedFromSlugs;
      }
    } catch {}
  }
  if (mergedFromSlugs.length > 0) {
    return fastApplyMergedScenarioNarration(slug, mergedFromSlugs);
  }

  const hasBase = await ensureRenderedBaseVideo(slug);
  if (!hasBase) {
    return { updated: false };
  }

  const baseMp4Path = path.join(sDir, "rendered.base.mp4");
  const baseJsonPath = path.join(sDir, "rendered.base.json");
  const editPlanPath = path.join(sDir, "edit-plan.json");
  const outMp4Path = path.join(ROOT_DIR, "output", `${slug}.mp4`);

  if (!fs.existsSync(baseMp4Path) || !fs.existsSync(baseJsonPath) || !fs.existsSync(narrationPath)) {
    return { updated: false };
  }

  const baseMeta: RenderedBaseMeta = JSON.parse(fs.readFileSync(baseJsonPath, "utf-8"));
  const narration: NarrationFile = JSON.parse(fs.readFileSync(narrationPath, "utf-8"));
  const editPlan: any = fs.existsSync(editPlanPath)
    ? JSON.parse(fs.readFileSync(editPlanPath, "utf-8"))
    : null;

  const baseProbe = probeVideoMetaQuick(baseMp4Path);
  const W = Math.floor(((baseProbe.width || baseMeta.width || 1920)) / 2) * 2;
  const H = Math.floor(((baseProbe.height || baseMeta.height || 1080)) / 2) * 2;
  const fps = baseMeta.fps || 30;
  const stripHeight = 180;

  const oldIntroSec = Math.max(0, Number(((baseMeta.bakedIntroDurationMs || 0) / 1000).toFixed(3)));
  const slidePngPath = path.join(sDir, "intro-slide-render.png");
  const hasIntroSlide =
    narration.introBakedIntoVideo !== false &&
    narration.showIntroToc !== false &&
    narration.introToc?.enabled !== false &&
    Boolean(narration.introToc);
  if (hasIntroSlide && narration.introToc) {
    const siteBrand = narration.siteBrand || (await ensureSiteBrandForScenario(slug));
    const slideHtml = buildSlideHtmlDocument({
      toc: narration.introToc,
      siteBrand,
      width: W,
      height: H,
    });
    await renderSlideHtmlToPng(slideHtml, slidePngPath, W, H);
  }
  const newIntroSec = hasIntroSlide
    ? Math.max(0, Number(((narration.bakedIntroDurationMs || 0) / 1000).toFixed(3)))
    : 0;

  const tempFiles: string[] = [];
  try {
    const inputArgs: string[] = ["-y", "-v", "error", "-i", baseMp4Path];
    let nextInputIdx = 1;
    let slideInputIdx = -1;

    if (newIntroSec > 0.5 && fs.existsSync(slidePngPath)) {
      inputArgs.push("-loop", "1", "-t", newIntroSec.toFixed(3), "-i", slidePngPath);
      slideInputIdx = nextInputIdx++;
    }

    const cues = Array.isArray(narration.cues) ? narration.cues : [];
    const showSubtitles = narration.showSubtitles !== false;
    const playAudio = narration.enabled !== false;

    const subtitleInputs: Array<{ inputIdx: number; startSec: number; endSec: number }> = [];
    if (showSubtitles && cues.length > 0) {
      const cuesToRender = cues
        .map((c, idx) => ({
          index: idx,
          text: String(c.text || "").trim(),
          startSec: Number(((c.compStartMs ?? c.startMs ?? 0) / 1000).toFixed(2)),
          endSec: Number(((c.compEndMs ?? c.endMs ?? 2500) / 1000).toFixed(2)),
        }))
        .filter((c) => c.text.length > 0 && c.endSec > c.startSec + 0.1);

      const stripMap = await renderSubtitleStripsBatch(
        cuesToRender.map((c) => ({ index: c.index, text: c.text })),
        sDir,
        W,
        stripHeight
      );

      for (const c of cuesToRender) {
        const pngPath = stripMap.get(c.index);
        if (pngPath && fs.existsSync(pngPath)) {
          tempFiles.push(pngPath);
          inputArgs.push("-i", pngPath);
          subtitleInputs.push({
            inputIdx: nextInputIdx++,
            startSec: c.startSec,
            endSec: c.endSec,
          });
        }
      }
    }

    const audioInputs: Array<{ inputIdx: number; delayMs: number }> = [];
    if (playAudio && cues.length > 0) {
      for (const c of cues) {
        if (!c.audioFile) continue;
        const mp3Path = path.join(sDir, "audio", path.basename(c.audioFile));
        if (fs.existsSync(mp3Path)) {
          inputArgs.push("-i", mp3Path);
          audioInputs.push({
            inputIdx: nextInputIdx++,
            delayMs: Math.max(0, Math.round(Number(c.compStartMs ?? c.startMs ?? 0))),
          });
        }
      }
    }

    const filterParts: string[] = [];

    // 1. 비디오 타임라인 조립 (오프닝 슬라이드 + 본문 구간 및 홀드 변경 반영)
    const oldPlanFps = Number(baseMeta.planFps || 60);
    const newPlanFps = Number(editPlan?.fps || 60);
    const oldBodyRegions = (baseMeta.timeRegions || []).filter(
      (r) => r.videoEndFrame / oldPlanFps > oldIntroSec + 0.08
    );
    const newBodyRegions = (Array.isArray(editPlan?.timeRegions) ? editPlan.timeRegions : []).filter(
      (r: any) => r.videoEndFrame / newPlanFps > newIntroSec + 0.08
    );

    let sameRegionStructure =
      oldBodyRegions.length > 0 && oldBodyRegions.length === newBodyRegions.length;
    let anyBodyHoldChanged = !sameRegionStructure;
    if (sameRegionStructure) {
      for (let i = 0; i < oldBodyRegions.length; i++) {
        const ro = oldBodyRegions[i];
        const rn = newBodyRegions[i];
        const vSpanOld = (ro.videoEndFrame - ro.videoStartFrame) / oldPlanFps;
        const vSpanNew = (rn.videoEndFrame - rn.videoStartFrame) / newPlanFps;
        if (Math.abs(vSpanOld - vSpanNew) > 0.15) {
          sameRegionStructure = false;
          anyBodyHoldChanged = true;
          break;
        }
        const holdOld = (ro.compEndFrame - ro.compStartFrame) / oldPlanFps - vSpanOld;
        const holdNew = (rn.compEndFrame - rn.compStartFrame) / newPlanFps - vSpanNew;
        if (Math.abs(holdOld - holdNew) > 0.08) {
          anyBodyHoldChanged = true;
        }
      }
    }

    const oldHasHolds = oldBodyRegions.some(
      (ro) =>
        (ro.compEndFrame - ro.compStartFrame - (ro.videoEndFrame - ro.videoStartFrame)) / oldPlanFps > 0.04
    );
    const newHasHolds = newBodyRegions.some(
      (rn: any) =>
        (rn.compEndFrame - rn.compStartFrame - (rn.videoEndFrame - rn.videoStartFrame)) / newPlanFps > 0.04
    );

    let currentVideoLabel = "[v_tl]";
    if (sameRegionStructure && anyBodyHoldChanged && oldBodyRegions.length > 0) {
      const concatLabels: string[] = [];
      if (slideInputIdx >= 0) {
        filterParts.push(
          `[${slideInputIdx}:v]scale=${W}:${H},fps=${fps},format=yuv420p,setpts=PTS-STARTPTS[v_intro]`
        );
        concatLabels.push("[v_intro]");
      }
      oldBodyRegions.forEach((ro, idx) => {
        const rn = newBodyRegions[idx];
        const startInBaseSec = Math.max(oldIntroSec, ro.compStartFrame / oldPlanFps);
        const vSpanSec = Math.max(0.05, (ro.videoEndFrame - ro.videoStartFrame) / oldPlanFps);
        const newHoldSec = Math.max(
          0,
          (rn.compEndFrame - rn.compStartFrame) / newPlanFps -
            (rn.videoEndFrame - rn.videoStartFrame) / newPlanFps
        );
        const tpadFilter =
          newHoldSec > 0.04 ? `,tpad=stop_mode=clone:stop_duration=${newHoldSec.toFixed(3)}` : "";
        filterParts.push(
          `[0:v]trim=start=${startInBaseSec.toFixed(3)}:duration=${vSpanSec.toFixed(3)},setpts=PTS-STARTPTS${tpadFilter},fps=${fps},scale=${W}:${H},format=yuv420p[vb_${idx}]`
        );
        concatLabels.push(`[vb_${idx}]`);
      });
      filterParts.push(
        `${concatLabels.join("")}concat=n=${concatLabels.length}:v=1:a=0[v_tl]`
      );
      currentVideoLabel = "[v_tl]";
    } else if (!sameRegionStructure && (oldHasHolds || newHasHolds) && newBodyRegions.length > 0) {
      // 대본 문장이 추가/삭제되어 구간 개수가 달라진 경우: 기존 홀드를 제거한 순수 1.0x 본문 스트림에서 새 홀드 구간을 재조립
      if (oldHasHolds && oldBodyRegions.length > 0) {
        const uwLabels: string[] = [];
        oldBodyRegions.forEach((ro, idx) => {
          const startInBaseSec = Math.max(oldIntroSec, ro.compStartFrame / oldPlanFps);
          const vSpanSec = Math.max(0.04, (ro.videoEndFrame - ro.videoStartFrame) / oldPlanFps);
          filterParts.push(
            `[0:v]trim=start=${startInBaseSec.toFixed(3)}:duration=${vSpanSec.toFixed(3)},setpts=PTS-STARTPTS[vuw_${idx}]`
          );
          uwLabels.push(`[vuw_${idx}]`);
        });
        filterParts.push(`${uwLabels.join("")}concat=n=${uwLabels.length}:v=1:a=0[v_unwarped]`);
      } else {
        filterParts.push(
          `[0:v]trim=start=${oldIntroSec.toFixed(3)},setpts=PTS-STARTPTS[v_unwarped]`
        );
      }

      if (newBodyRegions.length > 1) {
        const splitOut = newBodyRegions.map((_: any, idx: number) => `[vuws_${idx}]`).join("");
        filterParts.push(`[v_unwarped]split=${newBodyRegions.length}${splitOut}`);
      }

      const concatLabels: string[] = [];
      if (slideInputIdx >= 0) {
        filterParts.push(
          `[${slideInputIdx}:v]scale=${W}:${H},fps=${fps},format=yuv420p,setpts=PTS-STARTPTS[v_intro]`
        );
        concatLabels.push("[v_intro]");
      }
      newBodyRegions.forEach((rn: any, idx: number) => {
        const srcLabel = newBodyRegions.length > 1 ? `[vuws_${idx}]` : `[v_unwarped]`;
        const relStartSec = Math.max(0, rn.videoStartFrame / newPlanFps - newIntroSec);
        const vSpanSec = Math.max(0.04, (rn.videoEndFrame - rn.videoStartFrame) / newPlanFps);
        const newHoldSec = Math.max(
          0,
          (rn.compEndFrame - rn.compStartFrame) / newPlanFps - vSpanSec
        );
        const tpadFilter =
          newHoldSec > 0.04 ? `,tpad=stop_mode=clone:stop_duration=${newHoldSec.toFixed(3)}` : "";
        filterParts.push(
          `${srcLabel}trim=start=${relStartSec.toFixed(3)}:duration=${vSpanSec.toFixed(3)},setpts=PTS-STARTPTS${tpadFilter},fps=${fps},scale=${W}:${H},format=yuv420p[vnb_${idx}]`
        );
        concatLabels.push(`[vnb_${idx}]`);
      });
      filterParts.push(
        `${concatLabels.join("")}concat=n=${concatLabels.length}:v=1:a=0[v_tl]`
      );
      currentVideoLabel = "[v_tl]";
    } else if (slideInputIdx >= 0) {
      filterParts.push(
        `[${slideInputIdx}:v]scale=${W}:${H},fps=${fps},format=yuv420p,setpts=PTS-STARTPTS[v_intro]`
      );
      filterParts.push(
        `[0:v]trim=start=${oldIntroSec.toFixed(3)},setpts=PTS-STARTPTS,fps=${fps},scale=${W}:${H},format=yuv420p[v_body]`
      );
      filterParts.push(`[v_intro][v_body]concat=n=2:v=1:a=0[v_tl]`);
      currentVideoLabel = "[v_tl]";
    } else {
      filterParts.push(
        `[0:v]trim=start=${oldIntroSec.toFixed(3)},setpts=PTS-STARTPTS,fps=${fps},scale=${W}:${H},format=yuv420p[v_tl]`
      );
      currentVideoLabel = "[v_tl]";
    }

    // 2. 자막 스트립 오버레이 체인
    if (subtitleInputs.length > 0) {
      subtitleInputs.forEach((sub, idx) => {
        const nextLabel = `[v_sub_${idx}]`;
        const yPos = Math.max(0, H - stripHeight);
        filterParts.push(
          `${currentVideoLabel}[${sub.inputIdx}:v]overlay=0:${yPos}:enable='between(t,${sub.startSec},${sub.endSec})'${nextLabel}`
        );
        currentVideoLabel = nextLabel;
      });
    }

    // 3. 오디오 트랙 믹싱
    const estTotalSec = Math.max(
      2,
      editPlan?.totalDurationFrames
        ? Number(editPlan.totalDurationFrames) / Number(editPlan.fps || 60)
        : baseProbe.durationSec - oldIntroSec + newIntroSec
    );

    filterParts.push(
      `anullsrc=channel_layout=stereo:sample_rate=48000,atrim=0:${estTotalSec.toFixed(3)},asetpts=PTS-STARTPTS[aud_silent]`
    );

    let currentAudioLabel = "[aud_silent]";
    if (audioInputs.length > 0) {
      const mixLabels = ["[aud_silent]"];
      audioInputs.forEach((aud, idx) => {
        const lbl = `[aud_${idx}]`;
        filterParts.push(
          `[${aud.inputIdx}:a]aformat=sample_rates=48000:channel_layouts=stereo,adelay=${aud.delayMs}|${aud.delayMs}${lbl}`
        );
        mixLabels.push(lbl);
      });
      filterParts.push(
        `${mixLabels.join("")}amix=inputs=${mixLabels.length}:duration=first:dropout_transition=0:normalize=0[outa]`
      );
      currentAudioLabel = "[outa]";
    }

    fs.mkdirSync(path.dirname(outMp4Path), { recursive: true });
    const tmpOutPath = path.join(ROOT_DIR, "output", `${slug}_fast_tmp.mp4`);
    tempFiles.push(tmpOutPath);

    const ffArgs = [
      ...inputArgs,
      "-filter_complex",
      filterParts.join(";"),
      "-map",
      currentVideoLabel,
      "-map",
      currentAudioLabel,
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "18",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-movflags",
      "+faststart",
      tmpOutPath,
    ];

    const ffRes = spawnSync("ffmpeg", ffArgs, { encoding: "utf-8" });
    if (ffRes.status !== 0 || !fs.existsSync(tmpOutPath)) {
      console.error(`[FastRenderUpdate] FFmpeg 오류 (${slug}):`, ffRes.stderr);
      return { updated: false };
    }

    try {
      replaceFileSafeWithNewInode(tmpOutPath, outMp4Path);
    } catch {}

    const finalMeta = probeVideoMetaQuick(outMp4Path);
    return {
      updated: true,
      durationSec: finalMeta.durationSec,
      filePath: outMp4Path,
    };
  } finally {
    for (const tf of tempFiles) {
      try {
        if (fs.existsSync(tf)) fs.unlinkSync(tf);
      } catch {}
    }
  }
}

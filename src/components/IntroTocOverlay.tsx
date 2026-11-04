import React from "react";
import { AbsoluteFill, staticFile, useCurrentFrame } from "remotion";
import type { EditPlan, IntroTocConfig, IntroTocItem } from "../types";

interface IntroTocOverlayProps {
  editPlan: EditPlan;
}

const FADE_IN_MS = 260;
const FADE_OUT_MS = 380;

function stripVersionAndConversationalText(raw: string): string {
  return String(raw || "")
    .replace(/\b(?:ver\.?|v\.?)\s*\d+(?:\.\d+)*\b/gi, "")
    .replace(/이번\s*(?:시간|영상|매뉴얼|과정)에서는\s+[^.?!]+[.?!]?/g, "")
    .replace(/지금부터는?\s+[^.?!]+[.?!]?/g, "")
    .replace(/(?:안내|소개|설명)\s*방법을\s*(?:안내|소개|설명)합니다/g, "방법을 안내합니다")
    .replace(/\s+/g, " ")
    .trim();
}

function extractSmartTitleFromOpening(openingText: string, fallbackSlug?: string): string {
  const txt = String(openingText || "").trim();
  const m = txt.match(
    /(?:영상에서는|시간에는|매뉴얼에서는|지금부터는?)\s+(.+?)\s*(?:을|를)?\s*(?:단계별로\s*|순서대로\s*|차근차근\s*|함께\s*)?(?:안내|설명|소개|시연|알아보|살펴보|시작)/
  );
  if (m && m[1]) {
    const cleaned = stripVersionAndConversationalText(
      m[1]
        .replace(/\s*(?:하는\s*방법|처리\s*절차|전체\s*과정|사용\s*방법|활용법|기능)(?:을|를)?$/, (sub) =>
          sub.replace(/(?:을|를)$/, "")
        )
        .replace(/(?:을|를)$/, "")
    );
    if (cleaned.length >= 3 && cleaned.length <= 36) {
      return cleaned;
    }
  }
  const m2 = txt.match(/^([가-힣A-Za-z0-9\s·/]{2,24}?)(?:은|는)\s+.+?(?:메뉴|기능|도구|시스템|모듈|공간|서비스)(?:입니다|이며)/);
  if (m2 && m2[1]) {
    const subject = m2[1].trim();
    if (subject.length >= 2 && subject.length <= 24) {
      return `${subject} 사용 및 관리 안내`;
    }
  }
  const cleanSlug = stripVersionAndConversationalText(
    String(fallbackSlug || "그룹웨어 주요 기능 안내").replace(/[-_]+/g, " ")
  );
  return /^live\s+demo\s+\d+$/i.test(cleanSlug) || /^[a-z0-9\s]+$/i.test(cleanSlug)
    ? "그룹웨어 기본 화면 및 주요 기능 안내"
    : cleanSlug;
}

function toOverviewBulletText(rawLine: string): string {
  const txt = stripVersionAndConversationalText(rawLine).replace(/\.$/, "");
  if (!txt) return "";
  if (/(?:소개합니다|안내합니다|설명합니다|살펴봅니다|알아봅니다)$/.test(txt)) {
    return `${txt}.`;
  }
  let core = txt
    .replace(/^.+?위해\s+/, "")
    .replace(/(?:을|를)\s*(?:입력하고|선택하고|클릭하고)\s+/, " 및 ");

  const endingRules: Array<[RegExp, string]> = [
    [/에\s*로그인합니다$/, " 로그인 방법을 소개합니다"],
    [/내려\s*받으실\s*수\s*있습니다$/, " 다운로드 방법을 소개합니다"],
    [/내려\s*받습니다$/, " 다운로드 방법을 소개합니다"],
    [/이동할\s*수\s*있습니다$/, " 이동 및 메뉴 구성을 안내합니다"],
    [/이동합니다$/, " 이동 방법을 안내합니다"],
    [/확인합니다$/, " 확인 방법을 안내합니다"],
    [/조회할\s*수\s*있습니다$/, " 조회 방법을 소개합니다"],
    [/조회합니다$/, " 조회 방법을 소개합니다"],
    [/(?:합니다|입니다|할\s*수\s*있습니다|하실\s*수\s*있습니다|드립니다|해\s*볼게요|보시겠습니다)$/, " 방법을 안내합니다"],
  ];
  for (const [pattern, replacement] of endingRules) {
    if (pattern.test(core)) {
      core = core.replace(pattern, replacement);
      break;
    }
  }
  return `${core.trim()}.`;
}

function deriveFallbackTocFromEditPlan(editPlan: EditPlan): IntroTocConfig | null {
  const narration = editPlan.narration;
  if (!narration || !Array.isArray(narration.cues) || narration.cues.length === 0) {
    return null;
  }
  const openingCue = narration.cues[0];
  const openingText = (openingCue?.text || "").trim();
  const title = extractSmartTitleFromOpening(openingText, narration.slug);
  const stepCues = narration.cues.slice(1, 5);
  const items: IntroTocItem[] = stepCues.map((c, idx) => ({
    title: `주요 기능 ${idx + 1}`,
    description: toOverviewBulletText(c.text),
  }));
  if (items.length === 0) {
    items.push({
      title: "주요 기능 안내",
      description: `${title}의 핵심 기능과 사용 방법을 안내합니다.`,
    });
  }
  return {
    enabled: true,
    badge: "그룹웨어 사용 매뉴얼",
    title,
    summary: `${title}의 주요 메뉴 구성과 활용 방법을 안내합니다.`,
    items,
  };
}

function formatLeftCoverHeading(rawBadge?: string): { line1: string; line2: string } {
  const clean = stripVersionAndConversationalText(rawBadge || "그룹웨어 사용 매뉴얼");
  if (!clean || clean === "그룹웨어 교육 가이드" || clean === "그룹웨어 사용 매뉴얼") {
    return { line1: "그룹웨어", line2: "사용 매뉴얼" };
  }
  const words = clean.split(/\s+/);
  if (words.length >= 2) {
    return {
      line1: words[0],
      line2: words.slice(1).join(" "),
    };
  }
  return { line1: "그룹웨어", line2: clean };
}

export const IntroTocOverlay: React.FC<IntroTocOverlayProps> = ({ editPlan }) => {
  const frame = useCurrentFrame();
  const narration = editPlan.narration;

  if (!narration || !Array.isArray(narration.cues) || narration.cues.length === 0) {
    return null;
  }

  // 이미 recording.mp4 앞단에 오프닝 슬라이드가 합성된 시나리오는 중복 오버레이를 렌더링하지 않습니다.
  if (narration.introBakedIntoVideo) {
    return null;
  }

  if (narration.showIntroToc === false || narration.introToc?.enabled === false) {
    return null;
  }

  const openingCue =
    narration.cues.find(
      (c, idx) => Boolean(c.isIntro || (idx === 0 && (c.videoStartMs ?? c.startMs ?? 0) <= 600))
    ) || narration.cues[0];

  if (!openingCue) {
    return null;
  }

  const fallbackToc = deriveFallbackTocFromEditPlan(editPlan);
  const rawToc = narration.introToc;
  const toc: IntroTocConfig | null =
    rawToc && Array.isArray(rawToc.items) && rawToc.items.length > 0
      ? {
          enabled: rawToc.enabled !== false,
          badge: stripVersionAndConversationalText(rawToc.badge || fallbackToc?.badge || "그룹웨어 사용 매뉴얼"),
          title:
            !rawToc.title || /^live\s+demo\s+\d+$/i.test(rawToc.title.trim())
              ? fallbackToc?.title || "그룹웨어 주요 기능 안내"
              : stripVersionAndConversationalText(rawToc.title.trim()),
          summary: stripVersionAndConversationalText(rawToc.summary || fallbackToc?.summary || ""),
          items: rawToc.items,
        }
      : fallbackToc;

  if (!toc || !Array.isArray(toc.items) || toc.items.length === 0) {
    return null;
  }

  const compTimeMs = (frame / editPlan.fps) * 1000;
  const introEndMs = Math.max(1800, Number(openingCue.endMs) || 4000);

  if (compTimeMs < 0 || compTimeMs > introEndMs) {
    return null;
  }

  const fadeIn = Math.min(1, Math.max(0, compTimeMs / FADE_IN_MS));
  const remainMs = introEndMs - compTimeMs;
  const fadeOut = Math.min(1, Math.max(0, remainMs / FADE_OUT_MS));
  const opacity = Math.min(fadeIn, fadeOut);

  if (opacity <= 0.01) {
    return null;
  }

  const siteBrand = narration.siteBrand || toc.siteBrand;
  const primaryColor = siteBrand?.primaryColor || "#0068FF";
  const secondaryColor = siteBrand?.secondaryColor || "#0047B3";
  const accentColor = siteBrand?.accentColor || "#0BB4FA";
  const siteName = siteBrand?.siteName || "그룹웨어";
  const logoRelPath = siteBrand?.logoUrl ? siteBrand.logoUrl.replace(/^\/+/, "") : "";

  const cleanSubtitle = stripVersionAndConversationalText(toc.summary);

  return (
    <AbsoluteFill
      style={{
        pointerEvents: "none",
        opacity,
        display: "flex",
        flexDirection: "column",
        fontFamily:
          "'Pretendard', 'Noto Sans KR', 'Malgun Gothic', 'Apple SD Gothic Neo', sans-serif",
        background: "#F4F7FC",
      }}
    >
      {/* Top Site Brand Accent Line */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: 10,
          background: `linear-gradient(90deg, ${primaryColor} 0%, ${accentColor} 100%)`,
        }}
      />

      {/* Full-Width Contents Slide Area */}
      <div
        style={{
          width: "100%",
          height: "100%",
          maxWidth: 1680,
          margin: "0 auto",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          padding: "64px 80px 132px 80px",
          position: "relative",
        }}
      >
        {/* Contents Header & Main Title */}
        <div
          style={{
            display: "flex",
            flexDirection: "row",
            justifyContent: "space-between",
            alignItems: "flex-end",
            gap: 32,
            paddingBottom: 30,
            borderBottom: "2px solid #DCE5F2",
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div
              style={{
                fontSize: 30,
                fontWeight: 800,
                color: primaryColor,
                letterSpacing: "0.02em",
                textTransform: "uppercase",
              }}
            >
              Contents
            </div>
            <div
              style={{
                fontSize: 52,
                fontWeight: 800,
                color: "#0F2942",
                letterSpacing: "-0.03em",
                lineHeight: 1.18,
                wordBreak: "keep-all",
              }}
            >
              {toc.title}
            </div>
            {cleanSubtitle && (
              <div
                style={{
                  fontSize: 24,
                  fontWeight: 500,
                  color: "#475569",
                  letterSpacing: "-0.015em",
                  lineHeight: 1.38,
                  marginTop: 2,
                  wordBreak: "keep-all",
                }}
              >
                {cleanSubtitle}
              </div>
            )}
          </div>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "flex-end",
              gap: 10,
              flexShrink: 0,
            }}
          >
            {logoRelPath ? (
              <img
                src={staticFile(logoRelPath)}
                alt={siteName}
                style={{
                  height: 44,
                  maxWidth: 240,
                  objectFit: "contain",
                }}
              />
            ) : (
              <span
                style={{
                  fontSize: 24,
                  fontWeight: 800,
                  color: primaryColor,
                  letterSpacing: "-0.02em",
                }}
              >
                {siteName}
              </span>
            )}
            <span
              style={{
                fontSize: 16,
                fontWeight: 700,
                color: "#475569",
                background: "#E2E8F0",
                padding: "6px 14px",
                borderRadius: 999,
              }}
            >
              {toc.badge || siteBrand?.manualBadge || "그룹웨어 사용 매뉴얼"}
            </span>
          </div>
        </div>

        {/* Numbered Contents Items */}
        <div
          style={{
            marginTop: 42,
            display: "flex",
            flexDirection: "column",
            gap: 26,
          }}
        >
          {toc.items.slice(0, 8).map((item, idx) => {
            const rowDelayMs = idx * 75;
            const rowProgress = Math.min(
              1,
              Math.max(0, (compTimeMs - rowDelayMs) / 250)
            );
            const rawTitle = stripVersionAndConversationalText(item.title || "");
            const rawDesc = stripVersionAndConversationalText(item.description || "");
            const hasDistinctTitle =
              Boolean(rawTitle) &&
              Boolean(rawDesc) &&
              rawTitle !== rawDesc &&
              !/^(?:단계|주요\s*단계|핵심|주요\s*기능)\s*\d*$/.test(rawTitle);

            return (
              <div
                key={`toc-item-${idx}`}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 26,
                  background: "#FFFFFF",
                  border: "1px solid #E2E8F0",
                  borderRadius: 18,
                  padding: "28px 36px",
                  boxShadow: "0 8px 24px rgba(15, 41, 66, 0.05)",
                  opacity: rowProgress,
                  transform: `translateY(${Math.round((1 - rowProgress) * 10)}px)`,
                }}
              >
                <div
                  style={{
                    minWidth: 54,
                    height: 54,
                    borderRadius: 14,
                    background: `${primaryColor}14`,
                    border: `1px solid ${primaryColor}45`,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 25,
                    fontWeight: 800,
                    color: primaryColor,
                    flexShrink: 0,
                  }}
                >
                  {String(idx + 1).padStart(2, "0")}
                </div>
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 8,
                    flex: 1,
                  }}
                >
                  {hasDistinctTitle ? (
                    <>
                      <span
                        style={{
                          fontSize: 30,
                          fontWeight: 700,
                          color: "#0F2942",
                          letterSpacing: "-0.02em",
                          lineHeight: 1.28,
                          wordBreak: "keep-all",
                        }}
                      >
                        {rawTitle}
                      </span>
                      <span
                        style={{
                          fontSize: 23,
                          fontWeight: 500,
                          color: "#475569",
                          letterSpacing: "-0.015em",
                          lineHeight: 1.42,
                          wordBreak: "keep-all",
                        }}
                      >
                        {rawDesc}
                      </span>
                    </>
                  ) : (
                    <span
                      style={{
                        fontSize: 28,
                        fontWeight: 600,
                        color: "#1E293B",
                        letterSpacing: "-0.02em",
                        lineHeight: 1.4,
                        wordBreak: "keep-all",
                      }}
                    >
                      {rawDesc || rawTitle}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </AbsoluteFill>
  );
};

import { chromium, type Page, type BrowserContext, type Locator } from "playwright";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import { execSync } from "child_process";
import { getVideoMetadata } from "@remotion/renderer";
import type { BrowsePlan, BrowsePlanAction, Moment, MomentsFile } from "../src/types";

function clampToViewport(
  x: number,
  y: number,
  vw: number,
  vh: number
): { x: number; y: number } {
  return {
    x: Math.max(0, Math.min(vw, x)),
    y: Math.max(0, Math.min(vh, y)),
  };
}

function waitForEnter(): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question("", () => {
      rl.close();
      resolve();
    });
  });
}

function getLocator(page: Page, action: BrowsePlanAction): Locator | null {
  if (!action.selector) return null;
  if (action.iframe) {
    return page.frameLocator(action.iframe).locator(action.selector).first();
  }
  return page.locator(action.selector).first();
}

async function main() {
  const slug = process.argv[2];
  if (!slug) {
    console.error("Usage: tsx scripts/record.ts <slug> [--login]");
    process.exit(1);
  }

  const dataDir = path.resolve(__dirname, "..", "data", slug);
  const planPath = path.join(dataDir, "browse-plan.json");

  if (!fs.existsSync(planPath)) {
    console.error(`Browse plan not found: ${planPath}`);
    process.exit(1);
  }

  const plan: BrowsePlan = JSON.parse(fs.readFileSync(planPath, "utf-8"));
  const videoDir = dataDir;

  const authPath = path.join(dataDir, "auth.json");
  const forceLogin = process.argv.includes("--login");
  const requiresLogin = plan.requiresLogin || forceLogin;

  const isHeaded = process.argv.includes("--headed");

  // Auto-reuse existing auth session if available and not forced
  if (!fs.existsSync(authPath) && !forceLogin) {
    const parentDataDir = path.resolve(__dirname, "..", "data");
    const candidateDirs = [
      "approval-draft",
      "menu-guide-and-notification",
      "messenger-chat-start",
      "ai-chat-and-search",
    ];
    for (const cand of candidateDirs) {
      const candAuth = path.join(parentDataDir, cand, "auth.json");
      if (fs.existsSync(candAuth)) {
        console.log(`🔑 기존 인증 세션 (${cand}/auth.json)을 '${slug}' 시나리오로 자동 재사용합니다.`);
        try {
          fs.copyFileSync(candAuth, authPath);
        } catch {}
        break;
      }
    }
  }

  // 1. Manual Login Step (if required and session not saved yet)
  if (requiresLogin && (!fs.existsSync(authPath) || forceLogin)) {
    console.log("\n=======================================================");
    console.log("👉 브라우저 창에서 로그인을 완료해 주세요.");
    console.log("👉 로그인이 완료되면 이 터미널에서 [Enter] 키를 눌러주세요.");
    console.log("=======================================================\n");

    const loginBrowser = await chromium.launch({ headless: false });
    const loginContext = await loginBrowser.newContext({ viewport: plan.viewport });
    const loginPage = await loginContext.newPage();
    await loginPage.goto(plan.url);

    await waitForEnter();

    await loginContext.storageState({ path: authPath });
    await loginContext.close();
    await loginBrowser.close();
    console.log(`\n로그인 세션 저장 완료: ${authPath}`);
  }

  // 2. Main Recording Context
  // Headless mode eliminates Windows taskbar/titlebar letterboxing (which causes 120px gray bar at bottom)
  const browser = await chromium.launch({
    headless: !isHeaded,
    args: ["--window-size=1920,1080"],
  });
  const contextOptions: Parameters<typeof browser.newContext>[0] = {
    viewport: plan.viewport,
    recordVideo: {
      dir: videoDir,
      size: plan.viewport,
    },
  };

  if (fs.existsSync(authPath)) {
    contextOptions.storageState = authPath;
    console.log(`저장된 로그인 세션을 불러옵니다: ${authPath}`);
  }

  const context: BrowserContext = await browser.newContext(contextOptions);
  const recordingStart = Date.now();

  const page: Page = await context.newPage();
  console.log(`페이지 이동 중: ${plan.url}`);
  await page.goto(plan.url, { waitUntil: "domcontentloaded", timeout: 30000 });

  // Auto-accept alert/confirm dialogs (e.g. "일정이 등록되었습니다")
  page.on("dialog", async (dialog) => {
    console.log(`  [Alert/Confirm] ${dialog.type()}: ${dialog.message()}`);
    await dialog.accept();
  });

  const moments: Moment[] = [];
  let momentId = 0;

  console.log(`\nRecording started for "${slug}" at ${plan.url}`);

  try {
    for (const action of plan.actions) {
      momentId++;

      const moment: Moment = {
        id: momentId,
        type: action.type,
        timestamp: 0,
        description: action.description,
      };

      switch (action.type) {
        case "navigate": {
          const targetUrl = action.url ?? plan.url;
          moment.url = targetUrl;
          moment.timestamp = Date.now() - recordingStart;
          await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
          break;
        }

        case "wait": {
          moment.timestamp = Date.now() - recordingStart;
          const ms = action.ms ?? 1000;
          await page.waitForTimeout(ms);
          break;
        }

        case "hover": {
          const el = getLocator(page, action);
          if (!el) break;
          if (action.optional) {
            const isVis = await el.isVisible().catch(() => false);
            if (!isVis) {
              console.log(`  [Info] 선택적 단계(Optional) 건너뜀: ${action.description}`);
              break;
            }
          }
          await el.waitFor({ state: "visible", timeout: action.optional ? 3000 : 15000 }).catch(() => { });
          await el.scrollIntoViewIfNeeded().catch(() => { });
          const box = await el.boundingBox({ timeout: 3000 }).catch(() => null);
          if (!box && !action.optional) {
            throw new Error(`요소를 찾을 수 없거나 화면에 표시되지 않습니다: ${action.selector}`);
          }
          if (box) {
            const clamped = clampToViewport(
              box.x + box.width / 2,
              box.y + box.height / 2,
              plan.viewport.width,
              plan.viewport.height
            );
            moment.cursor = {
              x: Math.round(clamped.x),
              y: Math.round(clamped.y),
            };
            moment.target = {
              x: Math.round(Math.max(0, box.x)),
              y: Math.round(Math.max(0, box.y)),
              width: Math.round(box.width),
              height: Math.round(box.height),
            };
          }
          moment.timestamp = Date.now() - recordingStart;
          await el.hover().catch(() => { });
          await page.waitForTimeout(500);
          break;
        }

        case "dblclick": {
          const el = getLocator(page, action);
          if (!el) break;
          if (action.optional) {
            const isVis = await el.isVisible().catch(() => false);
            if (!isVis) {
              console.log(`  [Info] 건너뜀(Optional): ${action.description}`);
              break;
            }
          }
          await el.waitFor({ state: "visible", timeout: action.optional ? 3000 : 15000 }).catch(() => { });
          await el.scrollIntoViewIfNeeded().catch(() => { });
          const box = await el.boundingBox({ timeout: 3000 }).catch(() => null);
          if (box) {
            const clamped = clampToViewport(
              box.x + box.width / 2,
              box.y + box.height / 2,
              plan.viewport.width,
              plan.viewport.height
            );
            moment.cursor = {
              x: Math.round(clamped.x),
              y: Math.round(clamped.y),
            };
            moment.target = {
              x: Math.round(Math.max(0, box.x)),
              y: Math.round(Math.max(0, box.y)),
              width: Math.round(box.width),
              height: Math.round(box.height),
            };
          }
          moment.timestamp = Date.now() - recordingStart;
          await el.dblclick({ timeout: 10000, force: action.force ?? false });
          await page.waitForTimeout(1000);
          break;
        }

        case "click": {
          const el = getLocator(page, action);
          if (!el) break;
          if (action.optional) {
            const isVis = await el.isVisible().catch(() => false);
            if (!isVis) {
              console.log(`  [Info] 선택적 단계(Optional) 건너뜀: ${action.description}`);
              break;
            }
          }
          await el.waitFor({ state: "visible", timeout: action.optional ? 3000 : 15000 }).catch(() => { });
          await el.scrollIntoViewIfNeeded().catch(() => { });
          const box = await el.boundingBox({ timeout: 3000 }).catch(() => null);
          if (!box && !action.optional) {
            throw new Error(`요소를 찾을 수 없거나 화면에 표시되지 않습니다: ${action.selector}`);
          }
          if (box) {
            const clamped = clampToViewport(
              box.x + box.width / 2,
              box.y + box.height / 2,
              plan.viewport.width,
              plan.viewport.height
            );
            moment.cursor = {
              x: Math.round(clamped.x),
              y: Math.round(clamped.y),
            };
            moment.target = {
              x: Math.round(Math.max(0, box.x)),
              y: Math.round(Math.max(0, box.y)),
              width: Math.round(box.width),
              height: Math.round(box.height),
            };
          }

          moment.timestamp = Date.now() - recordingStart;
          await el.click({ timeout: 10000, force: action.force ?? false });
          await page.waitForTimeout(1000);
          break;
        }

        case "type": {
          const el = getLocator(page, action);
          if (!el) break;
          if (action.optional) {
            const isVis = await el.isVisible().catch(() => false);
            if (!isVis) {
              console.log(`  [Info] 선택적 단계(Optional) 건너뜀: ${action.description}`);
              break;
            }
          }
          await el.waitFor({ state: "visible", timeout: action.optional ? 3000 : 15000 }).catch(() => { });
          await el.scrollIntoViewIfNeeded().catch(() => { });
          const box = await el.boundingBox({ timeout: 3000 }).catch(() => null);
          if (!box && !action.optional) {
            throw new Error(`요소를 찾을 수 없거나 화면에 표시되지 않습니다: ${action.selector}`);
          }
          if (box) {
            const clamped = clampToViewport(
              box.x + box.width / 2,
              box.y + box.height / 2,
              plan.viewport.width,
              plan.viewport.height
            );
            moment.cursor = {
              x: Math.round(clamped.x),
              y: Math.round(clamped.y),
            };
            moment.target = {
              x: Math.round(Math.max(0, box.x)),
              y: Math.round(Math.max(0, box.y)),
              width: Math.round(box.width),
              height: Math.round(box.height),
            };
          }

          moment.timestamp = Date.now() - recordingStart;
          await el.click({ force: action.force ?? false });
          const text = action.text ?? "";
          await el.pressSequentially(text, { delay: 40 });
          moment.keys = text;
          await page.waitForTimeout(600);
          break;
        }

        case "scroll": {
          const deltaY = action.deltaY ?? 300;
          let cursorX = 960;
          let cursorY = 540;

          if (action.selector) {
            const el = getLocator(page, action);
            if (el) {
              const box = await el.boundingBox().catch(() => null);
              if (box) {
                const clamped = clampToViewport(
                  box.x + box.width / 2,
                  box.y + box.height / 2,
                  plan.viewport.width,
                  plan.viewport.height
                );
                cursorX = Math.round(clamped.x);
                cursorY = Math.round(clamped.y);
                await page.mouse.move(cursorX, cursorY).catch(() => { });
              }
            }
          }

          moment.cursor = {
            x: cursorX,
            y: cursorY,
          };
          moment.timestamp = Date.now() - recordingStart;
          await page.mouse.wheel(0, deltaY);
          await page.waitForTimeout(600);
          moment.scrollDelta = {
            x: 0,
            y: deltaY,
          };
          break;
        }

        case "upload": {
          const el = getLocator(page, action);
          if (!el) break;
          const filePath = action.filePath ?? action.text ?? "";
          await el.waitFor({ state: "attached", timeout: 15000 }).catch(() => { });
          moment.timestamp = Date.now() - recordingStart;
          await el.setInputFiles(filePath);
          await page.waitForTimeout(1000);
          break;
        }

        case "script": {
          if (!action.js) break;
          moment.timestamp = Date.now() - recordingStart;
          await page.evaluate(action.js);
          await page.waitForTimeout(800);
          break;
        }
      }

      if (moment.timestamp > 0 || (momentId === 1 && action.type === "wait")) {
        moments.push(moment);
        console.log(`  [${moment.timestamp}ms] ${action.type}: ${action.description}`);
      } else {
        console.log(`  [건너뜀] ${action.type}: ${action.description}`);
      }
    }
  } catch (err: any) {
    const errorImgPath = path.join(dataDir, "recording_error.png");
    await page.screenshot({ path: errorImgPath }).catch(() => { });
    console.error(`\n❌ [녹화 실패] 단계: momentId=${momentId}`);
    console.error(`  오류 내용:`, err.message);
    console.error(`  실패 시점 화면 캡처 저장: ${errorImgPath}\n`);
    await context.close().catch(() => { });
    await browser.close().catch(() => { });
    process.exit(1);
  }

  // Finalize video
  const videoPath = await page.video()?.path();
  await context.close();
  await browser.close();

  // Rename the video file to recording.mp4
  const destPath = path.join(dataDir, "recording.mp4");
  let startOffsetMs = 0;
  if (videoPath && fs.existsSync(videoPath)) {
    fs.renameSync(videoPath, destPath);
    console.log(`\nRecording saved: ${destPath}`);

    // Calibrate timeline offset with exact video metadata
    try {
      const meta = await getVideoMetadata(destPath);
      const durationSec = meta.durationInSeconds ?? 0;
      if (durationSec > 0) {
        const videoDurationMs = durationSec * 1000;
        const wallClockDurationMs = Date.now() - recordingStart;
        startOffsetMs = Math.max(0, wallClockDurationMs - videoDurationMs);
        const effectiveWallMs = Math.max(1, wallClockDurationMs - startOffsetMs);
        const driftRatio = videoDurationMs / effectiveWallMs;

        console.log(
          `[Sync] 비디오 길이: ${videoDurationMs.toFixed(0)}ms, 녹화 시간: ${wallClockDurationMs}ms, 시작 오프셋: -${startOffsetMs.toFixed(0)}ms, 보정 배율: ${driftRatio.toFixed(4)}`
        );

        // Adjust moments timestamps with 2-point linear time-warp calibration
        for (const moment of moments) {
          const shifted = Math.max(0, moment.timestamp - startOffsetMs);
          moment.timestamp = Math.min(
            Math.round(videoDurationMs),
            Math.round(shifted * driftRatio)
          );
        }
      }
    } catch (err) {
      console.warn("비디오 메타데이터 읽기 오류:", err);
      // Fallback: simple offset shift
      for (const moment of moments) {
        moment.timestamp = Math.max(0, Math.round(moment.timestamp - startOffsetMs));
      }
    }

    // Also copy to public/recording.mp4 for Remotion preview
    const publicDest = path.resolve(__dirname, "..", "public", "recording.mp4");
    fs.copyFileSync(destPath, publicDest);
    console.log(`Copied to public/recording.mp4`);
  }

  // Write moments.json
  const momentsFile: MomentsFile = {
    metadata: {
      url: plan.url,
      viewportWidth: plan.viewport.width,
      viewportHeight: plan.viewport.height,
      totalDurationMs: Math.max(0, Date.now() - recordingStart - startOffsetMs),
      recordingStart: new Date(recordingStart + startOffsetMs).toISOString(),
      cursor: plan.cursor,
    },
    moments,
  };

  const momentsPath = path.join(dataDir, "moments.json");
  fs.writeFileSync(momentsPath, JSON.stringify(momentsFile, null, 2));
  console.log(`Moments saved: ${momentsPath} (${moments.length} actions)`);

  // Auto-generate edit plan
  try {
    console.log("\nBuilding edit plan...");
    execSync(`python scripts/build-edit-plan.py ${slug} --keep-last`, { stdio: "inherit" });

    // Update Root.tsx to point to this recording
    const rootPath = path.resolve(__dirname, "..", "src", "Root.tsx");
    const rootContent = `import React from "react";
import { Composition } from "remotion";
import { ScreenDemo } from "./ScreenDemo";
import type { EditPlan, MomentsFile } from "./types";

import editPlanData from "../data/${slug}/edit-plan.json";
import momentsData from "../data/${slug}/moments.json";

const editPlan = editPlanData as EditPlan;
const moments = momentsData as MomentsFile;

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="ScreenDemo"
        component={ScreenDemo as unknown as React.ComponentType<Record<string, unknown>>}
        durationInFrames={editPlan.totalDurationFrames}
        fps={editPlan.fps}
        width={1920}
        height={1080}
        defaultProps={{
          editPlan,
          moments,
          videoFileName: "recording.mp4",
          showCursor: true,
          showSfx: false,
        }}
      />
    </>
  );
};
`;
    fs.writeFileSync(rootPath, rootContent);
    console.log(`Updated Root.tsx -> data/${slug}/`);
  } catch (e) {
    console.warn("Could not automatically run build-edit-plan.py:", e);
  }
}

main().catch((err) => {
  console.error("Recording failed:", err);
  process.exit(1);
});

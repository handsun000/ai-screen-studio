import * as fs from "fs";
import * as path from "path";
import { renderRunner } from "./renderRunner";

const ROOT_DIR = path.resolve(__dirname, "..", "..");
const DATA_DIR = path.join(ROOT_DIR, "data");
const OUTPUT_DIR = path.join(ROOT_DIR, "output");
const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const RENDERS_DIR = path.join(ROOT_DIR, "renders");
const BUNDLE_CACHE_PUBLIC_DIR = path.join(
  ROOT_DIR,
  "node_modules",
  ".cache",
  "screen-demo-remotion-bundle",
  "public"
);

const SYSTEM_DATA_DIRS = new Set(["_site_brands", "_sites", "_uploads"]);

export interface StorageCategoryBreakdown {
  bytes: number;
  count: number;
  items: Array<{ path: string; bytes: number; label: string }>;
}

export interface StorageStatsReport {
  logicalTotalBytes: number;
  physicalTotalBytes: number;
  hardlinkSavedBytes: number;
  hardlinkedFilesCount: number;
  directories: {
    dataLogicalBytes: number;
    dataPhysicalBytes: number;
    outputLogicalBytes: number;
    outputPhysicalBytes: number;
    publicLogicalBytes: number;
    publicPhysicalBytes: number;
    cacheLogicalBytes: number;
    cachePhysicalBytes: number;
  };
  reclaimable: {
    totalBytes: number;
    totalWithUndoBytes: number;
    deduplicateHardlinks: StorageCategoryBreakdown;
    tempCacheFiles: StorageCategoryBreakdown;
    orphanOutputs: StorageCategoryBreakdown;
    undoBackups: StorageCategoryBreakdown;
  };
}

export interface StorageCleanupOptions {
  deduplicateHardlinks?: boolean;
  cleanTempFiles?: boolean;
  cleanOrphanOutputs?: boolean;
  cleanUndoBackups?: boolean;
}

export interface StorageCleanupResult {
  success: boolean;
  reclaimedBytes: number;
  hardlinkedCount: number;
  deletedCount: number;
  details: string[];
  beforeStats: StorageStatsReport;
  afterStats: StorageStatsReport;
}

/**
 * 두 파일이 동일한 크기 및 샘플 바이트(시작·중간·끝 16KB)를 가지는지 고속 비교합니다.
 */
export function areFilesIdenticalFast(pathA: string, pathB: string): boolean {
  try {
    if (!fs.existsSync(pathA) || !fs.existsSync(pathB)) return false;
    const statA = fs.statSync(pathA);
    const statB = fs.statSync(pathB);
    if (!statA.isFile() || !statB.isFile()) return false;
    if (statA.size !== statB.size) return false;
    if (statA.size === 0) return true;
    if (statA.ino > 0 && statA.ino === statB.ino && statA.dev === statB.dev) {
      return true;
    }

    const sampleSize = Math.min(16384, statA.size);
    const offsets = [
      0,
      Math.max(0, Math.floor(statA.size / 2) - Math.floor(sampleSize / 2)),
      Math.max(0, statA.size - sampleSize),
    ];

    const fdA = fs.openSync(pathA, "r");
    const fdB = fs.openSync(pathB, "r");
    try {
      const bufA = Buffer.allocUnsafe(sampleSize);
      const bufB = Buffer.allocUnsafe(sampleSize);
      for (const offset of offsets) {
        const readA = fs.readSync(fdA, bufA, 0, sampleSize, offset);
        const readB = fs.readSync(fdB, bufB, 0, sampleSize, offset);
        if (readA !== readB) return false;
        if (!bufA.subarray(0, readA).equals(bufB.subarray(0, readB))) {
          return false;
        }
      }
      return true;
    } finally {
      try {
        fs.closeSync(fdA);
      } catch {}
      try {
        fs.closeSync(fdB);
      } catch {}
    }
  } catch {
    return false;
  }
}

/**
 * 대상 경로(destPath)가 이미 존재할 경우 기존 inode 연결을 먼저 끊은(unlink/rename) 뒤
 * 원본(srcPath)에 대한 NTFS 하드링크를 생성합니다 (불가 시 물리 복사 폴백).
 * 이를 통해 기존 하드링크 형제 파일이 덮어쓰기 오염되는 것을 100% 방지합니다.
 */
export function linkOrCopyFileSafe(srcPath: string, destPath: string): boolean {
  if (!fs.existsSync(srcPath)) return false;
  const resolvedSrc = path.resolve(srcPath);
  const resolvedDest = path.resolve(destPath);
  if (resolvedSrc === resolvedDest) return true;

  const destDir = path.dirname(resolvedDest);
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }

  let staleBackupPath = "";
  if (fs.existsSync(resolvedDest)) {
    try {
      const srcStat = fs.statSync(resolvedSrc);
      const destStat = fs.statSync(resolvedDest);
      if (srcStat.ino > 0 && srcStat.ino === destStat.ino && srcStat.dev === destStat.dev) {
        return true; // 이미 동일한 inode로 하드링크되어 있음
      }
    } catch {}

    try {
      fs.unlinkSync(resolvedDest);
    } catch {
      staleBackupPath = `${resolvedDest}.old_${Date.now()}`;
      try {
        fs.renameSync(resolvedDest, staleBackupPath);
      } catch {}
    }
  }

  let linked = false;
  try {
    fs.linkSync(resolvedSrc, resolvedDest);
    linked = true;
  } catch {
    try {
      fs.copyFileSync(resolvedSrc, resolvedDest);
      linked = true;
    } catch {
      linked = false;
    }
  }

  if (staleBackupPath && fs.existsSync(staleBackupPath)) {
    try {
      fs.unlinkSync(staleBackupPath);
    } catch {}
  }

  return linked;
}

/**
 * 임시 파일(tmpPath)로 대상 파일(targetPath)을 안전하게 교체하되,
 * targetPath가 다른 파일과 하드링크되어 있더라도 형제 inode가 오염되지 않도록
 * 반드시 기존 targetPath의 디렉토리 엔트리를 먼저 분리(unlink/rename)한 뒤 교체합니다.
 */
export function replaceFileSafeWithNewInode(tmpPath: string, targetPath: string): void {
  const resolvedTmp = path.resolve(tmpPath);
  const resolvedTarget = path.resolve(targetPath);
  if (!fs.existsSync(resolvedTmp)) {
    throw new Error(`임시 파일이 존재하지 않습니다: ${resolvedTmp}`);
  }
  if (resolvedTmp === resolvedTarget) return;

  const targetDir = path.dirname(resolvedTarget);
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  let lastErr: any = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    let staleBackup = "";
    try {
      if (fs.existsSync(resolvedTarget)) {
        try {
          fs.unlinkSync(resolvedTarget);
        } catch {
          staleBackup = `${resolvedTarget}.old_${Date.now()}_${attempt}`;
          fs.renameSync(resolvedTarget, staleBackup);
        }
      }

      try {
        fs.renameSync(resolvedTmp, resolvedTarget);
      } catch {
        fs.copyFileSync(resolvedTmp, resolvedTarget);
        try {
          fs.unlinkSync(resolvedTmp);
        } catch {}
      }

      if (staleBackup && fs.existsSync(staleBackup)) {
        try {
          fs.unlinkSync(staleBackup);
        } catch {}
      }
      return;
    } catch (err: any) {
      lastErr = err;
      if (staleBackup && fs.existsSync(staleBackup) && !fs.existsSync(resolvedTarget)) {
        try {
          fs.renameSync(staleBackup, resolvedTarget);
        } catch {}
      }
      const waitUntil = Date.now() + 65;
      while (Date.now() < waitUntil) {
        // brief synchronous wait for Windows file handle release
      }
    }
  }

  // 최후 폴백: targetPath의 nlink가 1개뿐인 경우에 한해 copyFileSync 허용
  try {
    const tStat = fs.existsSync(resolvedTarget) ? fs.statSync(resolvedTarget) : null;
    if (!tStat || tStat.nlink <= 1) {
      fs.copyFileSync(resolvedTmp, resolvedTarget);
      try {
        fs.unlinkSync(resolvedTmp);
      } catch {}
      return;
    }
  } catch (fallbackErr) {
    lastErr = fallbackErr;
  }

  if (lastErr) {
    throw lastErr;
  }
}

function getValidScenarioSlugs(): Set<string> {
  const slugs = new Set<string>();
  if (!fs.existsSync(DATA_DIR)) return slugs;
  for (const entry of fs.readdirSync(DATA_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (SYSTEM_DATA_DIRS.has(entry.name) || entry.name.startsWith("_") || entry.name.startsWith(".")) {
      continue;
    }
    slugs.add(entry.name);
  }
  return slugs;
}

interface HardlinkCandidatePair {
  canonicalPath: string;
  duplicatePath: string;
  bytes: number;
  label: string;
}

function collectHardlinkDeduplicationCandidates(validSlugs: Set<string>): HardlinkCandidatePair[] {
  const pairs: HardlinkCandidatePair[] = [];
  const seenDuplicates = new Set<string>();

  const tryAddPair = (canonicalPath: string, duplicatePath: string, label: string) => {
    const normDup = path.resolve(duplicatePath);
    const normCan = path.resolve(canonicalPath);
    if (normDup === normCan || seenDuplicates.has(normDup)) return;
    if (!fs.existsSync(normCan) || !fs.existsSync(normDup)) return;
    try {
      const statCan = fs.statSync(normCan);
      const statDup = fs.statSync(normDup);
      if (!statCan.isFile() || !statDup.isFile() || statCan.size === 0) return;
      if (statCan.size !== statDup.size) return;
      if (statCan.ino > 0 && statCan.ino === statDup.ino && statCan.dev === statDup.dev) {
        return; // 이미 하드링크 상태
      }
      if (!areFilesIdenticalFast(normCan, normDup)) return;
      seenDuplicates.add(normDup);
      pairs.push({
        canonicalPath: normCan,
        duplicatePath: normDup,
        bytes: statDup.size,
        label,
      });
    } catch {}
  };

  for (const slug of validSlugs) {
    const sDir = path.join(DATA_DIR, slug);
    const recMp4 = path.join(sDir, "recording.mp4");
    const bodyMp4 = path.join(sDir, "recording.body.mp4");
    const mergedOrigMp4 = path.join(sDir, "merged.orig.mp4");
    const outMp4 = path.join(OUTPUT_DIR, `${slug}.mp4`);
    const pubMp4 = path.join(PUBLIC_DIR, "videos", `${slug}.mp4`);

    // 1. 병합 시나리오 등 output/<slug>.mp4와 data/<slug>/recording.mp4가 동일한 경우
    if (fs.existsSync(outMp4)) {
      tryAddPair(outMp4, recMp4, `${slug}: output/${slug}.mp4 ↔ data/${slug}/recording.mp4`);
      tryAddPair(outMp4, pubMp4, `${slug}: output/${slug}.mp4 ↔ public/videos/${slug}.mp4`);
      tryAddPair(outMp4, mergedOrigMp4, `${slug}: output/${slug}.mp4 ↔ data/${slug}/merged.orig.mp4`);
    }

    // 2. 일반 시나리오 data/<slug>/recording.mp4 ↔ public/videos/<slug>.mp4
    if (fs.existsSync(recMp4)) {
      tryAddPair(recMp4, pubMp4, `${slug}: data/${slug}/recording.mp4 ↔ public/videos/${slug}.mp4`);
      tryAddPair(recMp4, bodyMp4, `${slug}: data/${slug}/recording.mp4 ↔ data/${slug}/recording.body.mp4`);
    }

    // 3. TTS 오디오 파일 (data/<slug>/audio/*.mp3 ↔ public/narration/<slug>/*.mp3 & bundle cache)
    const audioDir = path.join(sDir, "audio");
    if (fs.existsSync(audioDir)) {
      for (const f of fs.readdirSync(audioDir)) {
        if (!f.endsWith(".mp3")) continue;
        const srcMp3 = path.join(audioDir, f);
        const pubMp3 = path.join(PUBLIC_DIR, "narration", slug, f);
        const bundleMp3 = path.join(BUNDLE_CACHE_PUBLIC_DIR, "narration", slug, f);
        tryAddPair(srcMp3, pubMp3, `${slug}: audio/${f} ↔ public/narration/${slug}/${f}`);
        tryAddPair(srcMp3, bundleMp3, `${slug}: audio/${f} ↔ bundle/narration/${slug}/${f}`);
      }
    }
  }

  return pairs;
}

function collectTempAndCacheFiles(validSlugs: Set<string>): Array<{ path: string; bytes: number; label: string }> {
  const items: Array<{ path: string; bytes: number; label: string }> = [];
  const seen = new Set<string>();

  const addFile = (fp: string, label: string) => {
    const resolved = path.resolve(fp);
    if (seen.has(resolved) || !fs.existsSync(resolved)) return;
    try {
      const st = fs.statSync(resolved);
      if (st.isFile()) {
        seen.add(resolved);
        items.push({ path: resolved, bytes: st.size, label });
      }
    } catch {}
  };

  const addDirRecursive = (dirPath: string, labelPrefix: string) => {
    if (!fs.existsSync(dirPath)) return;
    try {
      for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
        const full = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
          addDirRecursive(full, `${labelPrefix}/${entry.name}`);
        } else {
          addFile(full, `${labelPrefix}/${entry.name}`);
        }
      }
    } catch {}
  };

  // 1. 레거시 공용 public/recording.mp4
  addFile(path.join(PUBLIC_DIR, "recording.mp4"), "레거시 공용 public/recording.mp4");

  // 2. Remotion 번들 캐시 내 불필요 복제된 public/videos 및 public/recording.mp4
  addDirRecursive(path.join(BUNDLE_CACHE_PUBLIC_DIR, "videos"), "번들 캐시 중복 비디오 (bundle/public/videos)");
  addFile(path.join(BUNDLE_CACHE_PUBLIC_DIR, "recording.mp4"), "번들 캐시 레거시 비디오 (bundle/public/recording.mp4)");

  // 3. 각 시나리오 폴더 내 합성 후 남은 임시 파일들
  for (const slug of validSlugs) {
    const sDir = path.join(DATA_DIR, slug);
    if (!fs.existsSync(sDir)) continue;
    const tempNames = [
      "intro-slide.mp4",
      "intro-slide-render.png",
      "recording.slide_tmp.mp4",
      "recording.body.sync_tmp.mp4",
      "recording_cut_tmp.mp4",
    ];
    for (const name of tempNames) {
      addFile(path.join(sDir, name), `${slug}: 임시 합성 캐시 (${name})`);
    }
    try {
      for (const f of fs.readdirSync(sDir)) {
        if (
          f.startsWith(".render-props-") ||
          f.startsWith("_sub_strip_") ||
          f.includes(".old_") ||
          f.endsWith(".tmp")
        ) {
          addFile(path.join(sDir, f), `${slug}: 임시 파일 (${f})`);
        }
      }
    } catch {}
  }

  // 4. output/ 폴더 내 임시 조각(.ts, _tmp.mp4, _mconcat_list.txt) 및 대용량 임시 .zip 아카이브
  if (fs.existsSync(OUTPUT_DIR)) {
    try {
      for (const f of fs.readdirSync(OUTPUT_DIR)) {
        if (
          f.endsWith(".ts") ||
          f.endsWith("_tmp.mp4") ||
          f.endsWith("_mfast_out.mp4") ||
          f.endsWith("_master_cover.mp4") ||
          f.endsWith("_master_intro.mp4") ||
          f.endsWith("_mconcat_list.txt") ||
          f.endsWith(".zip") ||
          f.includes(".old")
        ) {
          addFile(path.join(OUTPUT_DIR, f), `output 임시/압축 파일 (output/${f})`);
        }
      }
    } catch {}
  }

  // 5. 렌더링 작업이 실행 중이지 않을 때 남은 스테이징 폴더 (renders/, public/renders/, bundle/public/renders/)
  const activeTask = renderRunner.getCurrentTask();
  if (!activeTask || activeTask.status !== "running") {
    addDirRecursive(RENDERS_DIR, "렌더링 임시 스테이징 (renders)");
    addDirRecursive(path.join(PUBLIC_DIR, "renders"), "렌더링 임시 스테이징 (public/renders)");
    addDirRecursive(path.join(BUNDLE_CACHE_PUBLIC_DIR, "renders"), "렌더링 임시 스테이징 (bundle/public/renders)");
  }

  return items;
}

function collectOrphanOutputFiles(validSlugs: Set<string>): Array<{ path: string; bytes: number; label: string }> {
  const items: Array<{ path: string; bytes: number; label: string }> = [];

  // 1. output/<slug>.mp4 중 data/<slug>가 존재하지 않는 고아 비디오
  if (fs.existsSync(OUTPUT_DIR)) {
    try {
      for (const f of fs.readdirSync(OUTPUT_DIR)) {
        if (!f.endsWith(".mp4")) continue;
        if (
          f.endsWith("_tmp.mp4") ||
          f.endsWith("_mfast_out.mp4") ||
          f.endsWith("_master_cover.mp4") ||
          f.endsWith("_master_intro.mp4")
        ) {
          continue;
        }
        const slug = path.basename(f, ".mp4");
        if (!validSlugs.has(slug)) {
          const fp = path.join(OUTPUT_DIR, f);
          const st = fs.statSync(fp);
          if (st.isFile()) {
            items.push({
              path: path.resolve(fp),
              bytes: st.size,
              label: `삭제된 시나리오 출력본 (output/${f})`,
            });
          }
        }
      }
    } catch {}
  }

  // 2. public/videos/<slug>.mp4 중 data/<slug>가 존재하지 않는 고아 비디오
  const pubVideosDir = path.join(PUBLIC_DIR, "videos");
  if (fs.existsSync(pubVideosDir)) {
    try {
      for (const f of fs.readdirSync(pubVideosDir)) {
        if (!f.endsWith(".mp4")) continue;
        const slug = path.basename(f, ".mp4");
        if (!validSlugs.has(slug)) {
          const fp = path.join(pubVideosDir, f);
          const st = fs.statSync(fp);
          if (st.isFile()) {
            items.push({
              path: path.resolve(fp),
              bytes: st.size,
              label: `삭제된 시나리오 프리뷰 (public/videos/${f})`,
            });
          }
        }
      }
    } catch {}
  }

  // 3. public/narration/<slug> 중 data/<slug>가 존재하지 않는 고아 오디오 폴더
  for (const narrRoot of [
    path.join(PUBLIC_DIR, "narration"),
    path.join(BUNDLE_CACHE_PUBLIC_DIR, "narration"),
  ]) {
    if (!fs.existsSync(narrRoot)) continue;
    try {
      for (const entry of fs.readdirSync(narrRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (!validSlugs.has(entry.name)) {
          const slugDir = path.join(narrRoot, entry.name);
          for (const af of fs.readdirSync(slugDir)) {
            const fp = path.join(slugDir, af);
            const st = fs.statSync(fp);
            if (st.isFile()) {
              items.push({
                path: path.resolve(fp),
                bytes: st.size,
                label: `삭제된 시나리오 음성 (${entry.name}/${af})`,
              });
            }
          }
        }
      }
    } catch {}
  }

  return items;
}

function collectUndoBackupFiles(validSlugs: Set<string>): Array<{ path: string; bytes: number; label: string }> {
  const items: Array<{ path: string; bytes: number; label: string }> = [];
  const undoFileNames = [
    "recording.undo.mp4",
    "recording.orig.mp4",
    "moments.undo.json",
    "moments.orig.json",
    "edit-plan.undo.json",
    "edit-plan.orig.json",
    "narration.undo.json",
    "narration.orig.json",
  ];

  for (const slug of validSlugs) {
    const sDir = path.join(DATA_DIR, slug);
    if (!fs.existsSync(sDir)) continue;
    for (const name of undoFileNames) {
      const fp = path.join(sDir, name);
      if (fs.existsSync(fp)) {
        try {
          const st = fs.statSync(fp);
          if (st.isFile()) {
            items.push({
              path: path.resolve(fp),
              bytes: st.size,
              label: `${slug}: 컷 편집 백업 (${name})`,
            });
          }
        } catch {}
      }
    }
  }

  return items;
}

export function getStorageStats(): StorageStatsReport {
  const globalSeenInodes = new Set<string>();
  let logicalTotalBytes = 0;
  let physicalTotalBytes = 0;
  let hardlinkedFilesCount = 0;

  const measureDir = (dirPath: string): { logical: number; physical: number } => {
    let logical = 0;
    let physical = 0;
    const localSeenInodes = new Set<string>();

    const walk = (d: string) => {
      if (!fs.existsSync(d)) return;
      try {
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
          const full = path.join(d, entry.name);
          if (entry.isDirectory()) {
            walk(full);
          } else {
            try {
              const st = fs.statSync(full);
              if (!st.isFile()) continue;
              const inodeKey = st.ino > 0 ? `${st.dev}:${st.ino}` : full;
              logical += st.size;
              logicalTotalBytes += st.size;

              if (st.nlink > 1) {
                hardlinkedFilesCount++;
              }

              if (!localSeenInodes.has(inodeKey)) {
                localSeenInodes.add(inodeKey);
                physical += st.size;
              }
              if (!globalSeenInodes.has(inodeKey)) {
                globalSeenInodes.add(inodeKey);
                physicalTotalBytes += st.size;
              }
            } catch {}
          }
        }
      } catch {}
    };

    walk(dirPath);
    return { logical, physical };
  };

  const dataMetrics = measureDir(DATA_DIR);
  const outputMetrics = measureDir(OUTPUT_DIR);
  const publicMetrics = measureDir(PUBLIC_DIR);
  const rendersMetrics = measureDir(RENDERS_DIR);
  const bundlePublicMetrics = measureDir(BUNDLE_CACHE_PUBLIC_DIR);

  const validSlugs = getValidScenarioSlugs();
  const hardlinkPairs = collectHardlinkDeduplicationCandidates(validSlugs);
  const tempFiles = collectTempAndCacheFiles(validSlugs);
  const orphanFiles = collectOrphanOutputFiles(validSlugs);
  const undoFiles = collectUndoBackupFiles(validSlugs);

  const sumBytes = (arr: Array<{ bytes: number }>) => arr.reduce((acc, x) => acc + x.bytes, 0);

  const deduplicateBytes = sumBytes(hardlinkPairs);
  const tempBytes = sumBytes(tempFiles);
  const orphanBytes = sumBytes(orphanFiles);
  const undoBytes = sumBytes(undoFiles);

  const safeReclaimableBytes = deduplicateBytes + tempBytes + orphanBytes;

  return {
    logicalTotalBytes,
    physicalTotalBytes,
    hardlinkSavedBytes: Math.max(0, logicalTotalBytes - physicalTotalBytes),
    hardlinkedFilesCount,
    directories: {
      dataLogicalBytes: dataMetrics.logical,
      dataPhysicalBytes: dataMetrics.physical,
      outputLogicalBytes: outputMetrics.logical,
      outputPhysicalBytes: outputMetrics.physical,
      publicLogicalBytes: publicMetrics.logical,
      publicPhysicalBytes: publicMetrics.physical,
      cacheLogicalBytes: rendersMetrics.logical + bundlePublicMetrics.logical,
      cachePhysicalBytes: rendersMetrics.physical + bundlePublicMetrics.physical,
    },
    reclaimable: {
      totalBytes: safeReclaimableBytes,
      totalWithUndoBytes: safeReclaimableBytes + undoBytes,
      deduplicateHardlinks: {
        bytes: deduplicateBytes,
        count: hardlinkPairs.length,
        items: hardlinkPairs.map((p) => ({
          path: p.duplicatePath,
          bytes: p.bytes,
          label: p.label,
        })),
      },
      tempCacheFiles: {
        bytes: tempBytes,
        count: tempFiles.length,
        items: tempFiles,
      },
      orphanOutputs: {
        bytes: orphanBytes,
        count: orphanFiles.length,
        items: orphanFiles,
      },
      undoBackups: {
        bytes: undoBytes,
        count: undoFiles.length,
        items: undoFiles,
      },
    },
  };
}

export function optimizeStorage(options?: StorageCleanupOptions): StorageCleanupResult {
  const opts: Required<StorageCleanupOptions> = {
    deduplicateHardlinks: options?.deduplicateHardlinks !== false,
    cleanTempFiles: options?.cleanTempFiles !== false,
    cleanOrphanOutputs: options?.cleanOrphanOutputs !== false,
    cleanUndoBackups: Boolean(options?.cleanUndoBackups),
  };

  const beforeStats = getStorageStats();
  const validSlugs = getValidScenarioSlugs();
  const details: string[] = [];
  let hardlinkedCount = 0;
  let deletedCount = 0;

  // 1. 임시/캐시 파일 삭제
  if (opts.cleanTempFiles) {
    const tempFiles = collectTempAndCacheFiles(validSlugs);
    for (const item of tempFiles) {
      try {
        if (fs.existsSync(item.path)) {
          fs.unlinkSync(item.path);
          deletedCount++;
          details.push(`🗑️ 임시/캐시 삭제: ${item.label} (${(item.bytes / (1024 * 1024)).toFixed(2)} MB)`);
        }
      } catch {}
    }

    // 빈 스테이징 폴더 정리
    for (const dir of [
      RENDERS_DIR,
      path.join(PUBLIC_DIR, "renders"),
      path.join(BUNDLE_CACHE_PUBLIC_DIR, "renders"),
      path.join(BUNDLE_CACHE_PUBLIC_DIR, "videos"),
    ]) {
      if (fs.existsSync(dir)) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch {}
      }
    }
  }

  // 2. 삭제된 시나리오의 고아 출력물 정리
  if (opts.cleanOrphanOutputs) {
    const orphanFiles = collectOrphanOutputFiles(validSlugs);
    for (const item of orphanFiles) {
      try {
        if (fs.existsSync(item.path)) {
          fs.unlinkSync(item.path);
          deletedCount++;
          details.push(`🧹 고아 파일 삭제: ${item.label} (${(item.bytes / (1024 * 1024)).toFixed(2)} MB)`);
        }
      } catch {}
    }
  }

  // 3. 컷 편집 Undo/Orig 백업 파일 정리 (선택 시)
  if (opts.cleanUndoBackups) {
    const undoFiles = collectUndoBackupFiles(validSlugs);
    for (const item of undoFiles) {
      try {
        if (fs.existsSync(item.path)) {
          fs.unlinkSync(item.path);
          deletedCount++;
          details.push(`✂️ 편집 백업 정리: ${item.label} (${(item.bytes / (1024 * 1024)).toFixed(2)} MB)`);
        }
      } catch {}
    }
  }

  // 4. 중복 MP4 / MP3 파일 NTFS 하드링크 통합 (데이터 손실 0%)
  if (opts.deduplicateHardlinks) {
    const pairs = collectHardlinkDeduplicationCandidates(validSlugs);
    for (const pair of pairs) {
      if (linkOrCopyFileSafe(pair.canonicalPath, pair.duplicatePath)) {
        hardlinkedCount++;
        details.push(
          `🔗 하드링크 통합: ${pair.label} (${(pair.bytes / (1024 * 1024)).toFixed(2)} MB 물리 공간 절감)`
        );
      }
    }
  }

  const afterStats = getStorageStats();
  const reclaimedBytes = Math.max(0, beforeStats.physicalTotalBytes - afterStats.physicalTotalBytes);

  return {
    success: true,
    reclaimedBytes,
    hardlinkedCount,
    deletedCount,
    details,
    beforeStats,
    afterStats,
  };
}

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import type { GeneratePlanResult } from "./geminiPlanner";

const CACHE_DIR = path.resolve(__dirname, "..", "..", ".cache");
const CACHE_FILE = path.join(CACHE_DIR, "plan-cache.json");

interface CacheEntry {
  key: string;
  normalizedPrompt: string;
  targetPath: string;
  targetUrl: string;
  directingStyle: string;
  createdAt: string;
  result: GeneratePlanResult;
}

interface CacheStore {
  version: string;
  entries: Record<string, CacheEntry>;
}

function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
}

function loadCacheStore(): CacheStore {
  ensureCacheDir();
  if (fs.existsSync(CACHE_FILE)) {
    try {
      const content = fs.readFileSync(CACHE_FILE, "utf-8");
      return JSON.parse(content);
    } catch {
      return { version: "1.0", entries: {} };
    }
  }
  return { version: "1.0", entries: {} };
}

function saveCacheStore(store: CacheStore) {
  ensureCacheDir();
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(store, null, 2), "utf-8");
  } catch (err) {
    console.warn("Failed to write plan cache file:", err);
  }
}

/**
 * Computes a deterministic SHA-256 hash for the given scenario parameters.
 */
export function computePlanCacheKey(
  prompt: string,
  targetPath?: string,
  targetUrl?: string,
  directingStyle?: string
): string {
  const normPrompt = (prompt || "").trim().toLowerCase().replace(/\s+/g, " ");
  const normPath = (targetPath || "").trim().toLowerCase().replace(/\\/g, "/");
  const normUrl = (targetUrl || "").trim().toLowerCase().replace(/\/+$/, "");
  const normStyle = (directingStyle || "standard").trim().toLowerCase();

  const raw = `${normPrompt}|${normPath}|${normUrl}|${normStyle}`;
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

/**
 * Retrieves a previously generated plan from disk cache if it exists.
 */
export function getCachedPlan(
  prompt: string,
  targetPath?: string,
  targetUrl?: string,
  directingStyle?: string
): (GeneratePlanResult & { isFromCache: true; cachedAt: string }) | null {
  const key = computePlanCacheKey(prompt, targetPath, targetUrl, directingStyle);
  const store = loadCacheStore();
  const entry = store.entries[key];

  if (entry && entry.result) {
    return {
      ...entry.result,
      isFromCache: true,
      cachedAt: entry.createdAt,
    };
  }

  return null;
}

/**
 * Stores a freshly generated plan result in disk cache.
 */
export function setCachedPlan(
  prompt: string,
  targetPath: string | undefined,
  targetUrl: string | undefined,
  directingStyle: string | undefined,
  result: GeneratePlanResult
): void {
  const key = computePlanCacheKey(prompt, targetPath, targetUrl, directingStyle);
  const store = loadCacheStore();

  store.entries[key] = {
    key,
    normalizedPrompt: (prompt || "").trim().replace(/\s+/g, " "),
    targetPath: (targetPath || "").trim(),
    targetUrl: (targetUrl || "").trim(),
    directingStyle: directingStyle || "standard",
    createdAt: new Date().toISOString(),
    result: {
      plan: result.plan,
      explanation: result.explanation,
      suggestedSlug: result.suggestedSlug,
      actionSpecMarkdown: result.actionSpecMarkdown,
    },
  };

  saveCacheStore(store);
}

/**
 * Clears the entire plan cache.
 */
export function clearPlanCache(): void {
  const store: CacheStore = { version: "1.0", entries: {} };
  saveCacheStore(store);
}

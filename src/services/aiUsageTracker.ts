import * as fs from "fs";
import * as path from "path";

const USAGE_FILE_PATH = path.resolve(process.cwd(), "data", "ai-usage.json");
const KRW_PER_USD = 1400; // 환율 기준 (1 USD = 1,400 KRW)

export interface AiCallRecord {
  id: string;
  timestamp: string; // ISO string
  dateKey: string; // YYYY-MM-DD (local time)
  feature: string; // 예: "시나리오 생성", "AI 대본 생성", "셀렉터 자가치유", "프롬프트 다듬기"
  model: string;
  mode?: "api" | "cli";
  slug?: string;
  promptTokens: number;
  outputTokens: number;
  thoughtTokens: number;
  totalTokens: number;
  costUsd: number;
  costKrw: number;
}

export interface AiUsageBucket {
  calls: number;
  promptTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  costKrw: number;
}

export interface AiUsageStore {
  total: AiUsageBucket;
  daily: Record<string, AiUsageBucket>;
  history: AiCallRecord[];
}

function getLocalDateKey(d = new Date()): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function createEmptyBucket(): AiUsageBucket {
  return {
    calls: 0,
    promptTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    costKrw: 0,
  };
}

function getModelRatesPerMillion(model: string): { inputPerM: number; outputPerM: number } {
  const m = (model || "").toLowerCase();
  if (m.includes("pro")) {
    return { inputPerM: 1.25, outputPerM: 10.0 };
  }
  if (m.includes("lite")) {
    return { inputPerM: 0.075, outputPerM: 0.3 };
  }
  if (m.includes("2.0-flash")) {
    return { inputPerM: 0.1, outputPerM: 0.4 };
  }
  // Default Gemini Flash (2.5-flash / 3.x-flash)
  return { inputPerM: 0.15, outputPerM: 0.6 };
}

export function loadAiUsageStore(): AiUsageStore {
  try {
    if (fs.existsSync(USAGE_FILE_PATH)) {
      const raw = JSON.parse(fs.readFileSync(USAGE_FILE_PATH, "utf-8"));
      return {
        total: raw.total || createEmptyBucket(),
        daily: raw.daily || {},
        history: Array.isArray(raw.history) ? raw.history : [],
      };
    }
  } catch {
    // ignore corrupt file and reinitialize
  }
  return {
    total: createEmptyBucket(),
    daily: {},
    history: [],
  };
}

function saveAiUsageStore(store: AiUsageStore): void {
  try {
    const dir = path.dirname(USAGE_FILE_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(USAGE_FILE_PATH, JSON.stringify(store, null, 2), "utf-8");
  } catch (err) {
    console.warn("[AI Usage Tracker] 파일 저장 실패:", err);
  }
}

export function recordAiUsage(params: {
  feature: string;
  model: string;
  mode?: "api" | "cli";
  usageMetadata?: any;
  slug?: string;
  fallbackPromptChars?: number;
  fallbackOutputChars?: number;
}): AiCallRecord {
  const meta = params.usageMetadata || {};
  const mode: "api" | "cli" = params.mode || (String(params.model || "").startsWith("[CLI]") ? "cli" : "api");

  const promptTokens =
    Number(meta.promptTokenCount) ||
    Number(meta.input_tokens) ||
    Math.max(1, Math.round((params.fallbackPromptChars || 0) / 3.5));
  const candidatesTokens =
    Number(meta.candidatesTokenCount) ||
    Number(meta.output_tokens) ||
    Math.max(1, Math.round((params.fallbackOutputChars || 0) / 3.5));
  const thoughtTokens = Number(meta.thoughtsTokenCount) || Number(meta.thinking_tokens) || 0;
  const outputTokens = candidatesTokens + (meta.output_tokens ? 0 : thoughtTokens);
  const totalTokens = Number(meta.totalTokenCount) || Number(meta.total_tokens) || promptTokens + outputTokens;

  let costUsd = 0;
  let costKrw = 0;
  if (mode !== "cli") {
    const { inputPerM, outputPerM } = getModelRatesPerMillion(params.model);
    costUsd = (promptTokens / 1_000_000) * inputPerM + (outputTokens / 1_000_000) * outputPerM;
    costKrw = costUsd * KRW_PER_USD;
  }

  const now = new Date();
  const dateKey = getLocalDateKey(now);

  const record: AiCallRecord = {
    id: `${now.getTime()}-${Math.random().toString(36).slice(2, 6)}`,
    timestamp: now.toISOString(),
    dateKey,
    feature: params.feature,
    model: params.model,
    mode,
    slug: params.slug,
    promptTokens,
    outputTokens,
    thoughtTokens,
    totalTokens,
    costUsd: Number(costUsd.toFixed(6)),
    costKrw: Number(costKrw.toFixed(2)),
  };

  const store = loadAiUsageStore();

  // Update total
  store.total.calls += 1;
  store.total.promptTokens += promptTokens;
  store.total.outputTokens += outputTokens;
  store.total.totalTokens += totalTokens;
  store.total.costUsd = Number((store.total.costUsd + costUsd).toFixed(6));
  store.total.costKrw = Number((store.total.costKrw + costKrw).toFixed(2));

  // Update daily
  if (!store.daily[dateKey]) {
    store.daily[dateKey] = createEmptyBucket();
  }
  const dayBucket = store.daily[dateKey];
  dayBucket.calls += 1;
  dayBucket.promptTokens += promptTokens;
  dayBucket.outputTokens += outputTokens;
  dayBucket.totalTokens += totalTokens;
  dayBucket.costUsd = Number((dayBucket.costUsd + costUsd).toFixed(6));
  dayBucket.costKrw = Number((dayBucket.costKrw + costKrw).toFixed(2));

  // Prepend to history (keep latest 100 records)
  store.history.unshift(record);
  if (store.history.length > 100) {
    store.history = store.history.slice(0, 100);
  }

  saveAiUsageStore(store);

  if (mode === "cli") {
    console.log(
      `  💻 [AI CLI 실행] ${record.feature} (${record.model}) — 입력 ${promptTokens.toLocaleString()} + 출력 ${outputTokens.toLocaleString()} = 총 ${totalTokens.toLocaleString()} 토큰 | CLI 로그인 모드 (API 요금 ₩0)`
    );
  } else {
    console.log(
      `  💰 [AI API 사용량] ${record.feature} (${record.model}) — 입력 ${promptTokens.toLocaleString()} + 출력 ${outputTokens.toLocaleString()} = 총 ${totalTokens.toLocaleString()} 토큰 | 예상 요금: $${record.costUsd.toFixed(5)} (약 ${record.costKrw.toFixed(2)}원)`
    );
  }

  return record;
}

export function getAiUsageSummary() {
  const store = loadAiUsageStore();
  const todayKey = getLocalDateKey();
  const today = store.daily[todayKey] || createEmptyBucket();
  return {
    todayKey,
    today,
    total: store.total,
    recentHistory: store.history.slice(0, 30),
    exchangeRateKrw: KRW_PER_USD,
  };
}

export function resetAiUsageStore() {
  const empty: AiUsageStore = {
    total: createEmptyBucket(),
    daily: {},
    history: [],
  };
  saveAiUsageStore(empty);
  return getAiUsageSummary();
}

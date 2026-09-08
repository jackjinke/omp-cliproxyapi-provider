import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";

export interface CPAModel {
  id: string;
  name: string;
  isCodex: boolean;
  isClaude: boolean;
  reasoning: boolean;
  thinking?: {
    mode: "effort";
    efforts: string[];
    effortMap: Record<string, string>;
    defaultLevel?: string;
  };
  thinkingLevelMap?: Record<string, string>;
  preferWebsockets?: boolean;
  input: ("text" | "image")[];
  supportsTools: boolean;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  contextWindow: number;
  maxTokens: number;
  compat: {
    supportsReasoningParams: boolean;
    supportsReasoningEffort: boolean;
    supportsStrictMode: boolean;
  };
}

export interface CPACatalog {
  models: CPAModel[];
}

/**
 * Per-model metadata overrides from `cliproxyapi.yml`. New fields slot in by
 * extending this interface and OVERRIDABLE_MODEL_FIELDS together.
 */
export interface CPAModelOverride {
  contextWindow?: number;
  maxTokens?: number;
}

export interface CPAConfig {
  apiKey: string;
  baseUrl: string;
  startupTimeoutMs: number;
  codexTransport: Set<string>;
  effortOverrides: Record<string, string[]>;
  modelOverrides: Record<string, CPAModelOverride>;
}

export interface ModelsDevModelInfo {
  contextWindow?: number;
  maxTokens?: number;
  input?: ("text" | "image")[];
  reasoning?: boolean;
  supportsTools?: boolean;
}

/**
 * Flat lookup over the models.dev catalog, keyed `<provider>/<model>` with all
 * parts normalized to `a-z0-9`. Deliberately provider-scoped only: resellers
 * report conflicting limits for the same bare model id, so cross-provider
 * guessing is worse than the fallback.
 */
export type ModelsDevIndex = Record<string, ModelsDevModelInfo>;

const DEFAULT_BASE_URL = "http://127.0.0.1:8317";
const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const SUPPORTED_EFFORTS: Record<string, true> = {
  minimal: true,
  low: true,
  medium: true,
  high: true,
  xhigh: true,
  max: true,
};
const FALLBACK_CONTEXT_WINDOW = 128_000;
const FALLBACK_MAX_TOKENS = 16_384;

const MODELS_DEV_URL = "https://models.dev/api.json";
const MODELS_DEV_CACHE_FILE = "cliproxyapi.models-dev.cache.json";
const MODELS_DEV_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/** Model fields a `models:` override entry may set; extend to support more. */
const OVERRIDABLE_MODEL_FIELDS = ["contextWindow", "maxTokens"] as const;

type Environment = Record<string, string | undefined>;

export function cliproxyapiConfigPath(environment: Environment = process.env): string {
  const override = environment.PI_CODING_AGENT_DIR;
  if (override) return join(override, "cliproxyapi.yml");
  return join(homedir(), ".omp", "agent", "cliproxyapi.yml");
}

function normalizeEfforts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((effort) => String(effort).trim().toLowerCase())
    .filter((effort) => effort in SUPPORTED_EFFORTS);
}

export function readConfig(
  environment: Environment = process.env,
  configPath: string = cliproxyapiConfigPath(environment),
): CPAConfig {
  const apiKey = environment.CLIPROXYAPI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("CLIPROXYAPI_API_KEY is required for the CLIProxyAPI extension");
  }

  const config: CPAConfig = {
    apiKey,
    baseUrl: (environment.CLIPROXYAPI_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, ""),
    startupTimeoutMs: normalizeTimeout(environment.CLIPROXYAPI_STARTUP_TIMEOUT_MS),
    codexTransport: new Set(),
    effortOverrides: {},
    modelOverrides: {},
  };

  if (existsSync(configPath)) {
    const raw = readFileSync(configPath, "utf8");
    const parsed = parseYaml(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        const normalizedKey = key.trim();
        if (!normalizedKey) continue;
        if (normalizedKey === "models") {
          config.modelOverrides = parseModelOverrides(value);
          continue;
        }
        if (normalizedKey === "codex_transport") {
          if (Array.isArray(value)) {
            for (const entry of value) {
              const id = String(entry).trim();
              if (id) config.codexTransport.add(id);
            }
          }
          continue;
        }
        const efforts = normalizeEfforts(value);
        if (efforts.length > 0) config.effortOverrides[normalizedKey] = efforts;
      }
    }
  }

  return config;
}

function normalizeTimeout(raw: string | undefined): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_STARTUP_TIMEOUT_MS;
}

/**
 * Parses the `models:` map. Unknown fields are ignored so newer config files
 * keep loading on older extension versions; new override fields are added by
 * extending OVERRIDABLE_MODEL_FIELDS.
 */
function parseModelOverrides(value: unknown): Record<string, CPAModelOverride> {
  const overrides: Record<string, CPAModelOverride> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return overrides;
  for (const [modelId, fields] of Object.entries(value as Record<string, unknown>)) {
    const id = modelId.trim();
    if (!id || !fields || typeof fields !== "object" || Array.isArray(fields)) continue;
    const override: CPAModelOverride = {};
    for (const field of OVERRIDABLE_MODEL_FIELDS) {
      const parsed = Number((fields as Record<string, unknown>)[field]);
      if (Number.isFinite(parsed) && parsed > 0) override[field] = Math.floor(parsed);
    }
    overrides[id] = override;
  }
  return overrides;
}

async function fetchEntriesOnce(
  config: CPAConfig,
  path: string,
  listKey: "models" | "data",
  fetcher: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
): Promise<unknown[]> {
  const response = await fetcher(`${config.baseUrl}${path}`, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
  });
  if (!response.ok) {
    throw new Error(`CLIProxyAPI ${path} failed with HTTP ${response.status}`);
  }
  const payload = (await response.json()) as Record<string, unknown>;
  return firstArray(payload?.[listKey]);
}

async function fetchWithTimeout(
  config: CPAConfig,
  path: string,
  listKey: "models" | "data",
  fetcher: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
): Promise<unknown[]> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      fetchEntriesOnce(config, path, listKey, fetcher),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`CLIProxyAPI ${path} timed out after ${config.startupTimeoutMs}ms`)),
          config.startupTimeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchViaCurl(config: CPAConfig, path: string, listKey: "models" | "data"): Promise<unknown[]> {
  return await new Promise<unknown[]>((resolve, reject) => {
    const child = spawn(
      "curl",
      [
        "-sS",
        "-m",
        String(Math.max(1, Math.ceil(config.startupTimeoutMs / 1000))),
        "-H",
        `Authorization: Bearer ${config.apiKey}`,
        "-H",
        "Accept: application/json",
        `${config.baseUrl}${path}`,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code: number | null) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `curl exited with code ${code ?? "unknown"}`));
        return;
      }
      try {
        const payload = JSON.parse(stdout) as Record<string, unknown>;
        resolve(firstArray(payload?.[listKey]));
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

async function fetchEntriesWithRecovery(
  config: CPAConfig,
  path: string,
  listKey: "models" | "data",
  fetcher: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
): Promise<unknown[]> {
  try {
    return await fetchWithTimeout(config, path, listKey, fetcher);
  } catch (error) {
    if (!isRetryableDiscoveryError(error)) throw error;
  }
  try {
    return await fetchWithTimeout(config, path, listKey, fetcher);
  } catch (error) {
    if (!isRetryableDiscoveryError(error)) throw error;
  }
  return await fetchViaCurl(config, path, listKey);
}

function isRetryableDiscoveryError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /unexpected token|JSON Parse error|failed to parse|timed out/i.test(error.message);
}

function normalizeModelsDevKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function indexModelsDevPayload(payload: unknown): ModelsDevIndex {
  const index: ModelsDevIndex = {};
  if (!payload || typeof payload !== "object") return index;
  for (const [providerId, provider] of Object.entries(payload as Record<string, unknown>)) {
    if (!provider || typeof provider !== "object") continue;
    const models = (provider as Record<string, unknown>).models;
    if (!models || typeof models !== "object") continue;
    for (const [modelId, entry] of Object.entries(models as Record<string, unknown>)) {
      if (!entry || typeof entry !== "object") continue;
      const record = entry as Record<string, unknown>;
      const limit = firstRecord(record.limit);
      const modalities = firstRecord(record.modalities);
      const info: ModelsDevModelInfo = {
        contextWindow: firstInteger(limit?.context),
        maxTokens: firstInteger(limit?.output),
        input: firstArray(modalities?.input).length > 0 ? normalizeInputModalities(modalities?.input) : undefined,
        reasoning: typeof record.reasoning === "boolean" ? record.reasoning : undefined,
        supportsTools: typeof record.tool_call === "boolean" ? record.tool_call : undefined,
      };
      const scopedKey = `${normalizeModelsDevKey(providerId)}/${normalizeModelsDevKey(modelId)}`;
      index[scopedKey] ??= info;
      const name = firstString(record.name);
      if (name) index[`${normalizeModelsDevKey(providerId)}/${normalizeModelsDevKey(name)}`] ??= info;
    }
  }
  return index;
}

interface ModelsDevCacheFile {
  fetchedAt: number;
  index: ModelsDevIndex;
}

/**
 * Loads the models.dev catalog with a six-hour cache. Expired entries are
 * returned immediately while the cache refreshes for subsequent discoveries.
 * Without a readable cache, discovery waits for the initial fetch.
 */
async function loadModelsDevIndex(
  config: CPAConfig,
  configPath: string,
  fetcher: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
): Promise<ModelsDevIndex | null> {
  const cachePath = join(dirname(configPath), MODELS_DEV_CACHE_FILE);
  let stale: ModelsDevIndex | null = null;
  if (existsSync(cachePath)) {
    try {
      const cached = JSON.parse(readFileSync(cachePath, "utf8")) as ModelsDevCacheFile;
      if (cached && typeof cached === "object" && cached.index && typeof cached.index === "object") {
        if (Date.now() - cached.fetchedAt < MODELS_DEV_CACHE_TTL_MS) return cached.index;
        stale = cached.index;
      }
    } catch {
      // Unreadable cache is rebuilt from the network below.
    }
  }

  const refresh = refreshModelsDevIndex(config, cachePath, fetcher);
  return stale ?? await refresh;
}

async function refreshModelsDevIndex(
  config: CPAConfig,
  cachePath: string,
  fetcher: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
): Promise<ModelsDevIndex | null> {
  try {
    let timeout: NodeJS.Timeout | undefined;
    const response = await Promise.race([
      fetcher(MODELS_DEV_URL, { headers: { Accept: "application/json" } }),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`models.dev catalog timed out after ${config.startupTimeoutMs}ms`)),
          config.startupTimeoutMs,
        );
      }),
    ]).finally(() => clearTimeout(timeout));
    if (!response.ok) throw new Error(`models.dev catalog failed with HTTP ${response.status}`);
    const index = indexModelsDevPayload(await response.json());
    try {
      writeFileSync(cachePath, JSON.stringify({ fetchedAt: Date.now(), index } satisfies ModelsDevCacheFile));
    } catch {
      // Cache writes are best-effort; enrichment still applies this run.
    }
    return index;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[cliproxyapi] models.dev catalog refresh failed: ${message}`);
    return null;
  }
}

async function loadModelOwners(
  config: CPAConfig,
  fetcher: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
): Promise<Map<string, string>> {
  const owners = new Map<string, string>();
  try {
    const entries = await fetchEntriesWithRecovery(config, "/v1/models", "data", fetcher);
    for (const value of entries) {
      const entry = firstRecord(value);
      const id = firstString(entry?.id);
      const owner = firstString(entry?.owned_by);
      if (id && owner) owners.set(id, owner);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[cliproxyapi] model owner discovery failed; provider-scoped enrichment unavailable: ${message}`);
  }
  return owners;
}

export async function discoverModels(
  config: CPAConfig,
  fetcher: (input: string | URL | Request, init?: RequestInit) => Promise<Response> = fetch,
  configPath?: string,
): Promise<CPACatalog> {
  const payload = await fetchEntriesWithRecovery(config, "/v1/models?client_version=pi", "models", fetcher);
  const entries = payload.filter((value): value is Record<string, unknown> => {
    const entry = firstRecord(value);
    return entry !== undefined && firstString(entry.slug) !== undefined;
  });
  let modelsDev: ModelsDevIndex | null = null;
  if (entries.length > 0 && configPath) {
    const needsOwners = entries.some((entry) => firstString(entry.owned_by) === undefined);
    const [index, owners] = await Promise.all([
      loadModelsDevIndex(config, configPath, fetcher),
      needsOwners ? loadModelOwners(config, fetcher) : Promise.resolve(new Map<string, string>()),
    ]);
    modelsDev = index;
    for (const entry of entries) {
      entry.owned_by ??= owners.get(String(entry.slug));
    }
  }
  const models = normalizeCatalog(entries, config, modelsDev ?? undefined).models;
  if (models.length === 0) {
    throw new Error(
      "CLIProxyAPI returned no usable models; configure at least one upstream provider first",
    );
  }
  return { models };
}

function firstRecord(...values: unknown[]): Record<string, unknown> | undefined {
  for (const value of values) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  }
  return undefined;
}

function firstArray(...values: unknown[]): unknown[] {
  for (const value of values) {
    if (Array.isArray(value)) return value;
  }
  return [];
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function firstInteger(...values: unknown[]): number | undefined {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  }
  return undefined;
}

function normalizeInputModalities(value: unknown): ("text" | "image")[] {
  // Host Model input types are limited to text and image.
  const modalities = firstArray(value)
    .map((item) => String(item).toLowerCase())
    .filter((item): item is "text" | "image" => item === "text" || item === "image");
  return modalities.length > 0 ? [...new Set(modalities)] : ["text"];
}

function parseEfforts(
  entry: Record<string, unknown>,
  config: CPAConfig,
  id: string,
): string[] {
  const override = config.effortOverrides[id] ?? config.effortOverrides["*"];
  if (!Array.isArray(entry.supported_reasoning_levels)) {
    return override && override.length > 0 ? override : [...DEFAULT_EFFORTS];
  }
  const efforts = normalizeEfforts(entry.supported_reasoning_levels.map((value) => firstRecord(value)?.effort));
  return [...new Set([...efforts, ...(override ?? [])])];
}

function applyModelOverrides(model: CPAModel, config: CPAConfig): void {
  const merged: CPAModelOverride = {
    ...config.modelOverrides["*"],
    ...config.modelOverrides[model.id],
  };
  for (const field of OVERRIDABLE_MODEL_FIELDS) {
    const value = merged[field];
    if (value !== undefined) model[field] = value;
  }
}

export function extractCPAModel(
  entry: Record<string, unknown>,
  config: CPAConfig,
  modelsDev?: ModelsDevIndex,
): CPAModel | null {
  const id = firstString(entry.slug);
  if (!id) return null;
  const name = firstString(entry.display_name) ?? id;
  const owner = normalizeModelsDevKey(firstString(entry.owned_by) ?? "");
  const metadata = owner && modelsDev ? (
    modelsDev[`${owner}/${normalizeModelsDevKey(id)}`] ??
    modelsDev[`${owner}/${normalizeModelsDevKey(name)}`]
  ) : undefined;

  const isClaude = id.startsWith("claude-");
  const isCodex =
    id.startsWith("gpt-") ||
    id.startsWith("codex-") ||
    id.includes("/gpt-") ||
    config.codexTransport.has(id);

  // Explicit empty effort lists must not acquire fallback levels. Image models
  // can inherit a Codex template's effort list without supporting reasoning.
  const reasoning = config.effortOverrides[id] !== undefined || (
    metadata?.reasoning ?? (!id.startsWith("gpt-image") && (
      firstArray(entry.supported_reasoning_levels).length > 0 ||
      (isCodex && !Array.isArray(entry.supported_reasoning_levels))
    ))
  );
  const efforts = reasoning ? parseEfforts(entry, config, id) : [];
  const effortMap = Object.fromEntries(efforts.map((effort) => [effort, effort]));
  const defaultLevel = firstString(entry.default_reasoning_level);

  const model: CPAModel = {
    id,
    name,
    isCodex,
    isClaude,
    reasoning,
    thinking: efforts.length > 0 ? {
      mode: "effort",
      efforts,
      effortMap,
      defaultLevel: defaultLevel && efforts.includes(defaultLevel) ? defaultLevel : undefined,
    } : undefined,
    thinkingLevelMap: efforts.length > 0 ? effortMap : undefined,
    input: metadata?.input ?? normalizeInputModalities(entry.input_modalities),
    supportsTools: metadata?.supportsTools ?? true,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: metadata?.contextWindow ?? firstInteger(entry.context_window, entry.max_context_window) ?? FALLBACK_CONTEXT_WINDOW,
    maxTokens: metadata?.maxTokens ?? firstInteger(entry.max_tokens) ?? FALLBACK_MAX_TOKENS,
    compat: {
      supportsReasoningParams: reasoning,
      supportsReasoningEffort: reasoning,
      supportsStrictMode: false,
    },
  };
  if (isCodex && typeof entry.prefer_websockets === "boolean") {
    model.preferWebsockets = entry.prefer_websockets;
  }
  applyModelOverrides(model, config);
  return model;
}

export function normalizeCatalog(
  entries: unknown[],
  config: CPAConfig,
  modelsDev?: ModelsDevIndex,
): CPACatalog {
  const models: CPAModel[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const model = extractCPAModel(entry as Record<string, unknown>, config, modelsDev);
    if (model) models.push(model);
  }
  return { models };
}

export interface CPADiscovery {
  config: CPAConfig;
  catalog: CPACatalog;
}

/**
 * Loads config and discovers the catalog, returning null on any failure after
 * logging a warning. Hosts call this so a down CLIProxyAPI never blocks startup.
 */
export async function tryDiscoverModels(
  environment: Environment = process.env,
  fetcher: (input: string | URL | Request, init?: RequestInit) => Promise<Response> = fetch,
  configPath?: string,
): Promise<CPADiscovery | null> {
  const resolvedConfigPath = configPath ?? cliproxyapiConfigPath(environment);
  let config: CPAConfig;
  try {
    config = readConfig(environment, resolvedConfigPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/CLIPROXYAPI_API_KEY is required/.test(message)) {
      console.warn(`[cliproxyapi] ${message}`);
    }
    return null;
  }

  try {
    const catalog = await discoverModels(config, fetcher, resolvedConfigPath);
    return { config, catalog };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `[cliproxyapi] startup discovery failed; continuing without provider: ${message}`,
    );
    return null;
  }
}

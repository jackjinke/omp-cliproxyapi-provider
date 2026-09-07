import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

export interface CPAModel {
  id: string;
  name: string;
  /** CLIProxyAPI channel the model routes to (claude, codex, kimi, gemini, …). */
  channel: string;
  isCodex: boolean;
  isClaude: boolean;
  reasoning: boolean;
  thinking?: {
    mode: "effort";
    efforts: string[];
    effortMap: Record<string, string>;
  };
  thinkingLevelMap?: Record<string, string>;
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

export interface CPAConfig {
  apiKey: string;
  baseUrl: string;
  startupTimeoutMs: number;
  codexTransport: Set<string>;
  effortOverrides: Record<string, string[]>;
}

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

/**
 * CLIProxyAPI disguises non-Claude model IDs in Anthropic-shaped model listings
 * as `claude-fable-5-dd-` + the reversed ID, so Claude Code accepts them. This
 * extension is not Claude Code: decode them back to the routing IDs.
 */
const CLAUDE_DD_PREFIX = "claude-fable-5-dd-";

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
  };

  if (existsSync(configPath)) {
    const raw = readFileSync(configPath, "utf8");
    const parsed = parseYaml(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        const normalizedKey = key.trim();
        if (!normalizedKey) continue;
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

export function decodeClaudeDDId(id: string): string {
  if (!id.startsWith(CLAUDE_DD_PREFIX)) return id;
  const encoded = id.slice(CLAUDE_DD_PREFIX.length);
  if (!encoded) return id;
  return [...encoded].reverse().join("");
}

async function fetchModelsOnce(
  config: CPAConfig,
  path: string,
  fetcher: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
): Promise<CPAModel[]> {
  const response = await fetcher(`${config.baseUrl}${path}`, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${config.apiKey}`,
      // Selects CPA's rich Anthropic-shaped model listing instead of the
      // four-field OpenAI listing on the same /v1/models route.
      "Anthropic-Version": "2023-06-01",
    },
  });
  if (!response.ok) {
    throw new Error(`CLIProxyAPI ${path} failed with HTTP ${response.status}`);
  }
  const payload = (await response.json()) as { data?: unknown };
  const entries = Array.isArray(payload?.data) ? payload.data : [];
  return normalizeCatalog(entries, config).models;
}

async function fetchWithTimeout(
  config: CPAConfig,
  path: string,
  fetcher: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
): Promise<CPAModel[]> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      fetchModelsOnce(config, path, fetcher),
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

async function fetchViaCurl(config: CPAConfig, path: string): Promise<CPAModel[]> {
  return await new Promise<CPAModel[]>((resolve, reject) => {
    const child = spawn(
      "curl",
      [
        "-sS",
        "-m",
        String(Math.max(1, Math.ceil(config.startupTimeoutMs / 1000))),
        "-H",
        `Authorization: Bearer ${config.apiKey}`,
        "-H",
        "Anthropic-Version: 2023-06-01",
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
        const payload = JSON.parse(stdout) as { data?: unknown };
        const entries = Array.isArray(payload?.data) ? payload.data : [];
        resolve(normalizeCatalog(entries, config).models);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

async function fetchWithRecovery(
  config: CPAConfig,
  path: string,
  fetcher: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
): Promise<CPAModel[]> {
  try {
    return await fetchWithTimeout(config, path, fetcher);
  } catch (error) {
    if (!isRetryableDiscoveryError(error)) throw error;
  }
  try {
    return await fetchWithTimeout(config, path, fetcher);
  } catch (error) {
    if (!isRetryableDiscoveryError(error)) throw error;
  }
  return await fetchViaCurl(config, path);
}

function isRetryableDiscoveryError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /unexpected token|JSON Parse error|failed to parse|timed out/i.test(error.message);
}

export async function discoverModels(
  config: CPAConfig,
  fetcher: (input: string | URL | Request, init?: RequestInit) => Promise<Response> = fetch,
): Promise<CPACatalog> {
  const models = await fetchWithRecovery(config, "/v1/models", fetcher);
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

function normalizeInputModalities(entry: Record<string, unknown>): ("text" | "image")[] {
  // Host Model input types are limited to text and image.
  const modalities = firstArray(
    entry.supportedInputModalities,
    entry.supported_input_modalities,
    entry.input_modalities,
  )
    .map((value) => String(value).toLowerCase())
    .filter((value): value is "text" | "image" => value === "text" || value === "image");
  if (modalities.length > 0) return [...new Set(modalities)];
  if (entry.vision === true) return ["text", "image"];
  return ["text"];
}

function normalizeEffortTiers(
  entry: Record<string, unknown>,
  thinking: Record<string, unknown> | undefined,
): string[] {
  const candidates = firstArray(thinking?.levels, firstRecord(entry.capabilities)?.effort_tiers);
  const supported = candidates
    .map((value) => String(value).trim().toLowerCase())
    .filter((value) => value in SUPPORTED_EFFORTS);
  return [...new Set(supported)];
}

function parseEfforts(
  entry: Record<string, unknown>,
  config: CPAConfig,
  id: string,
  thinking: Record<string, unknown> | undefined,
): string[] {
  const override = config.effortOverrides[id] ?? config.effortOverrides["*"];
  const efforts = normalizeEffortTiers(entry, thinking);
  if (efforts.length === 0) return override && override.length > 0 ? override : [...DEFAULT_EFFORTS];
  if (!override || override.length === 0) return efforts;

  const allowed: Record<string, true> = {};
  for (const effort of efforts) allowed[effort] = true;
  const extras = override.filter((effort) => !(effort in allowed));
  return [...efforts, ...extras];
}

export function extractCPAModel(
  entry: Record<string, unknown>,
  config: CPAConfig,
): CPAModel | null {
  const rawId = firstString(entry.id, entry.name);
  if (!rawId) return null;
  const id = decodeClaudeDDId(rawId);
  if (!id) return null;

  const channel = firstString(entry.type, entry.channel)?.toLowerCase() ?? "";
  const owner = firstString(entry.owned_by)?.toLowerCase() ?? "";
  const thinking = firstRecord(entry.thinking);

  const isClaude = channel === "claude" || id.startsWith("claude-");
  const isCodex =
    channel === "codex" ||
    owner === "codex" ||
    id.startsWith("gpt-") ||
    id.startsWith("codex-") ||
    id.includes("/gpt-") ||
    config.codexTransport.has(id);

  // Registry-backed entries carry `thinking`; Codex-family models arriving via
  // proxied upstream listings (type "model", no thinking block) still support
  // reasoning effort, except the gpt-image family. An exact-id effort override
  // also opts a model into reasoning.
  const reasoning =
    thinking !== undefined ||
    config.effortOverrides[id] !== undefined ||
    (isCodex && !id.startsWith("gpt-image"));

  const efforts = reasoning ? parseEfforts(entry, config, id, thinking) : [];
  const effortMap = Object.fromEntries(efforts.map((effort) => [effort, effort]));

  return {
    id,
    name: firstString(entry.display_name, entry.displayName) ?? id,
    channel,
    isCodex,
    isClaude,
    reasoning,
    thinking: reasoning ? { mode: "effort", efforts, effortMap } : undefined,
    thinkingLevelMap: reasoning ? effortMap : undefined,
    input: normalizeInputModalities(entry),
    supportsTools: true,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow:
      firstInteger(
        entry.context_length,
        entry.max_input_tokens,
        entry.context_window,
        entry.inputTokenLimit, // gemini-family channels
      ) ?? FALLBACK_CONTEXT_WINDOW,
    maxTokens:
      firstInteger(
        entry.max_completion_tokens,
        entry.max_output_tokens,
        entry.max_tokens,
        entry.outputTokenLimit, // gemini-family channels
      ) ?? FALLBACK_MAX_TOKENS,
    compat: {
      supportsReasoningParams: reasoning,
      supportsReasoningEffort: reasoning,
      supportsStrictMode: false,
    },
  };
}

export function normalizeCatalog(entries: unknown[], config: CPAConfig): CPACatalog {
  const models: CPAModel[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const model = extractCPAModel(entry as Record<string, unknown>, config);
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
  let config: CPAConfig;
  try {
    config = readConfig(environment, configPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/CLIPROXYAPI_API_KEY is required/.test(message)) {
      console.warn(`[cliproxyapi] ${message}`);
    }
    return null;
  }

  try {
    const catalog = await discoverModels(config, fetcher);
    return { config, catalog };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `[cliproxyapi] startup discovery failed; continuing without provider: ${message}`,
    );
    return null;
  }
}

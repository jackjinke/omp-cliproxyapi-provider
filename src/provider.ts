import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Effort } from "@oh-my-pi/pi-catalog";
import type { FetchImpl } from "@oh-my-pi/pi-ai";
import type { ProviderModelConfig } from "@oh-my-pi/pi-coding-agent";

export const PROVIDER_ID = "cliproxyapi";
export const PROVIDER_NAME = "CLIProxyAPI";
export const DEFAULT_BASE_URL = "http://127.0.0.1:8317";
export const CONFIG_FILE_NAME = "cliproxyapi.json";
export const CREDENTIAL_TTL_MS = 100 * 365 * 24 * 60 * 60 * 1000;

const FETCH_TIMEOUT_MS = 15_000;
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;
const SUPPORTED_EFFORTS = [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max] as const;
type SupportedEffort = (typeof SUPPORTED_EFFORTS)[number];

export interface CliproxyConfig {
  baseUrl?: string;
  apiKey?: string;
  [key: string]: unknown;
}

export interface ResolvedSettings {
  agentDir: string;
  baseUrl: string;
  apiKey?: string;
}

interface CatalogModel {
  slug?: unknown;
  id?: unknown;
  display_name?: unknown;
  name?: unknown;
  context_window?: unknown;
  max_context_window?: unknown;
  input_modalities?: unknown;
  supported_reasoning_levels?: unknown;
  visibility?: unknown;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export function agentDirectory(environment: Record<string, string | undefined> = process.env): string {
  return environment.PI_CODING_AGENT_DIR?.trim() || join(environment.HOME?.trim() || homedir(), ".omp", "agent");
}

export function configPath(agentDir: string): string {
  return join(agentDir, CONFIG_FILE_NAME);
}

export function readConfig(agentDir: string): CliproxyConfig {
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath(agentDir), "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${CONFIG_FILE_NAME} must contain a JSON object`);
    }
    const record = Object.fromEntries(Object.entries(parsed));
    const baseUrl = record.baseUrl;
    const apiKey = record.apiKey;
    if (baseUrl !== undefined && nonEmptyString(baseUrl) === undefined) {
      throw new Error(`${CONFIG_FILE_NAME} field "baseUrl" must be a non-empty string`);
    }
    if (apiKey !== undefined && nonEmptyString(apiKey) === undefined) {
      throw new Error(`${CONFIG_FILE_NAME} field "apiKey" must be a non-empty string`);
    }
    return {
      ...record,
      ...(typeof baseUrl === "string" ? { baseUrl } : {}),
      ...(typeof apiKey === "string" ? { apiKey } : {}),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

export function writeConfig(agentDir: string, values: Pick<CliproxyConfig, "baseUrl" | "apiKey">): void {
  const path = configPath(agentDir);
  mkdirSync(dirname(path), { recursive: true });
  const config = { ...readConfig(agentDir), ...values };
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
}

export function resolveSettings(
  environment: Record<string, string | undefined> = process.env,
  explicitAgentDir?: string,
): ResolvedSettings {
  const agentDir = explicitAgentDir ?? agentDirectory(environment);
  const config = readConfig(agentDir);
  return {
    agentDir,
    baseUrl: nonEmptyString(environment.CLIPROXYAPI_BASE_URL) ?? nonEmptyString(config.baseUrl) ?? DEFAULT_BASE_URL,
    apiKey: nonEmptyString(environment.CLIPROXYAPI_API_KEY) ?? nonEmptyString(config.apiKey),
  };
}

export function resolveEndpoints(baseUrlInput: string): { inferenceBaseUrl: string; modelsUrl: string } {
  let raw = baseUrlInput.trim();
  if (!raw) throw new Error("CLIProxyAPI base URL is empty");
  if (!/^https?:\/\//i.test(raw)) raw = `http://${raw}`;

  const url = new URL(raw);
  let path = url.pathname.replace(/\/+$/, "");
  if (!path || path === "/") {
    path = "/backend-api";
  } else if (path === "/v1" || path.endsWith("/v1")) {
    path = `${path.slice(0, -3)}/backend-api`;
  } else if (!path.endsWith("/backend-api")) {
    path = `${path}/backend-api`;
  }

  const rootPath = path.slice(0, -"/backend-api".length);
  return {
    inferenceBaseUrl: `${url.origin}${path}/`,
    modelsUrl: `${url.origin}${rootPath}/v1/models?client_version=pi`,
  };
}

function catalogEntries(payload: unknown): CatalogModel[] {
  const values = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object" && "models" in payload && Array.isArray(payload.models)
      ? payload.models
      : payload && typeof payload === "object" && "data" in payload && Array.isArray(payload.data)
        ? payload.data
        : [];
  return values.filter((value): value is CatalogModel => Boolean(value) && typeof value === "object" && !Array.isArray(value));
}

function reasoningEfforts(model: CatalogModel): SupportedEffort[] {
  if (!Array.isArray(model.supported_reasoning_levels)) return [];
  const values = new Set<string>();
  for (const entry of model.supported_reasoning_levels) {
    const rawEffort = entry && typeof entry === "object" && "effort" in entry ? entry.effort : entry;
    const effort = nonEmptyString(rawEffort);
    if (effort) values.add(effort.toLowerCase());
  }
  return SUPPORTED_EFFORTS.filter(effort => values.has(effort));
}

function inputModalities(model: CatalogModel): Array<"text" | "image"> {
  const hasImage = Array.isArray(model.input_modalities)
    && model.input_modalities.some(value => nonEmptyString(value)?.toLowerCase() === "image");
  return hasImage ? ["text", "image"] : ["text"];
}

export function mapCatalogModel(model: CatalogModel): ProviderModelConfig | null {
  const id = nonEmptyString(model.slug) ?? nonEmptyString(model.id);
  if (!id || nonEmptyString(model.visibility)?.toLowerCase() === "hide") return null;

  const efforts = reasoningEfforts(model);
  return {
    id,
    name: nonEmptyString(model.display_name) ?? nonEmptyString(model.name) ?? id,
    reasoning: efforts.length > 0,
    ...(efforts.length > 0 ? { thinking: { mode: "effort" as const, efforts } } : {}),
    input: inputModalities(model),
    cost: { ...ZERO_COST },
    contextWindow: positiveInteger(model.context_window, positiveInteger(model.max_context_window, 128_000)),
    maxTokens: 16_384,
  };
}

export async function fetchModels(
  baseUrl: string,
  apiKey: string,
  fetcher: FetchImpl = fetch,
): Promise<ProviderModelConfig[]> {
  const { modelsUrl } = resolveEndpoints(baseUrl);
  const response = await fetcher(modelsUrl, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 200);
    throw new Error(`CLIProxyAPI models request failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return [];
  }
  return catalogEntries(payload).map(mapCatalogModel).filter((model): model is ProviderModelConfig => model !== null);
}

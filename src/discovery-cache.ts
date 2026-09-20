import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CPAConfig, CPAModel } from "./shared.ts";

// Increment when catalog normalization changes: cached rows already include overrides.
const CACHE_VERSION = 1;

export function catalogCachePath(config: CPAConfig, configPath: string): string {
  const scope = createHash("sha256").update(JSON.stringify([
    CACHE_VERSION, config.baseUrl, config.codexBaseUrl, config.apiKey, config.modelOverrides,
  ])).digest("hex");
  return join(dirname(configPath), "cliproxyapi-catalog", `${scope}.json`);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validModel(value: unknown): value is CPAModel {
  if (!record(value)) return false;
  if (typeof value.id !== "string" || !value.id.trim() || typeof value.name !== "string") return false;
  if (!["isCodex", "isClaude", "reasoning", "supportsTools"].every(key => typeof value[key] === "boolean")) return false;
  if (!finite(value.contextWindow) || !value.contextWindow || !finite(value.maxTokens) || !value.maxTokens) return false;
  if (!Array.isArray(value.input) || !value.input.length || !value.input.every(item => item === "text" || item === "image")) return false;
  const { cost, compat } = value;
  if (!record(cost) || !["input", "output", "cacheRead", "cacheWrite"].every(key => finite(cost[key]))) return false;
  if (!record(compat) || !["supportsReasoningParams", "supportsReasoningEffort", "supportsStrictMode"].every(key => typeof compat[key] === "boolean")) return false;
  if (value.preferWebsockets !== undefined && typeof value.preferWebsockets !== "boolean") return false;
  if (value.thinking !== undefined) {
    const thinking = value.thinking;
    if (!record(thinking) || thinking.mode !== "effort" || !Array.isArray(thinking.efforts)) return false;
    const efforts = ["minimal", "low", "medium", "high", "xhigh", "max"];
    if (!thinking.efforts.length || !thinking.efforts.every(effort => typeof effort === "string" && efforts.includes(effort))) return false;
    if (!record(thinking.effortMap) || !Object.values(thinking.effortMap).every(effort => typeof effort === "string")) return false;
    if (thinking.defaultLevel !== undefined && !thinking.efforts.includes(thinking.defaultLevel)) return false;
  }
  // Cached catalogs never carry transport, credentials, or arbitrary server fields.
  return Object.keys(value).every(key => ["id", "name", "isCodex", "isClaude", "reasoning", "supportsTools", "contextWindow", "maxTokens", "input", "cost", "compat", "preferWebsockets", "thinking"].includes(key));
}

export function readCatalogCache(path: string): CPAModel[] | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!record(value) || value.version !== CACHE_VERSION || !Array.isArray(value.models) || !value.models.length) return undefined;
    if (!value.models.every(validModel)) return undefined;
    if (new Set(value.models.map(model => model.id)).size !== value.models.length) return undefined;
    return value.models;
  } catch {
    return undefined;
  }
}

export function writeCatalogCache(path: string, models: CPAModel[]): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(temporary, JSON.stringify({ version: CACHE_VERSION, models }), { mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

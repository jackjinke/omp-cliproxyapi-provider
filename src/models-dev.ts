import { readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FetchImpl } from "@oh-my-pi/pi-ai";
import { isJsonObject, type JsonObject } from "./type-guards.ts";

const MODELS_DEV_URL = "https://models.dev/api.json";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export interface ModelIdentity {
  id: string;
  owner?: string;
}

export interface ExternalModelMetadata {
  name?: string;
  reasoning?: boolean;
  efforts?: string[];
  input?: Array<"text" | "image">;
  contextWindow?: number;
  maxTokens?: number;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
}


function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function providerKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function modelsDevCachePath(): string {
  return join(tmpdir(), "omp-cliproxyapi-provider-models-dev.json");
}

function isModelsDevCatalog(value: unknown): value is JsonObject {
  if (!isJsonObject(value)) return false;
  return Object.values(value).some(provider => isJsonObject(provider) && isJsonObject(provider.models));
}

function readCatalogFile(path: string): JsonObject | undefined {
  try {
    const catalog: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isModelsDevCatalog(catalog) ? catalog : undefined;
  } catch {
    return undefined;
  }
}

function readFreshCatalog(path: string): JsonObject | undefined {
  try {
    if (Date.now() - statSync(path).mtimeMs > CACHE_TTL_MS) return undefined;
    return readCatalogFile(path);
  } catch {
    return undefined;
  }
}

function writeCatalogFile(path: string, catalog: unknown): void {
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, JSON.stringify(catalog), "utf8");
  renameSync(temporaryPath, path);
}

async function loadCatalog(fetcher: FetchImpl, cacheFile: string): Promise<JsonObject | undefined> {
  const fresh = readFreshCatalog(cacheFile);
  if (fresh !== undefined) return fresh;

  const stale = readCatalogFile(cacheFile);
  try {
    const response = await fetcher(MODELS_DEV_URL, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`models.dev returned HTTP ${response.status}`);
    const catalog: unknown = await response.json();
    if (!isModelsDevCatalog(catalog)) throw new Error("models.dev returned an invalid catalog");
    writeCatalogFile(cacheFile, catalog);
    return catalog;
  } catch {
    return stale;
  }
}

function effortValues(model: JsonObject): string[] | undefined {
  if (!Array.isArray(model.reasoning_options)) return undefined;
  const efforts: string[] = [];
  for (const option of model.reasoning_options) {
    if (!isJsonObject(option) || option.type !== "effort" || !Array.isArray(option.values)) continue;
    for (const value of option.values) {
      const effort = stringValue(value)?.toLowerCase();
      if (effort && !efforts.includes(effort)) efforts.push(effort);
    }
  }
  return efforts.length > 0 ? efforts : undefined;
}

function inputModalities(model: JsonObject): Array<"text" | "image"> | undefined {
  if (!isJsonObject(model.modalities) || !Array.isArray(model.modalities.input)) return undefined;
  const hasImage = model.modalities.input.some(value => stringValue(value)?.toLowerCase() === "image");
  return hasImage ? ["text", "image"] : ["text"];
}

function modelCost(model: JsonObject): ExternalModelMetadata["cost"] {
  if (!isJsonObject(model.cost)) return undefined;
  const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : 0;
  return {
    input: number(model.cost.input),
    output: number(model.cost.output),
    cacheRead: number(model.cost.cache_read),
    cacheWrite: number(model.cost.cache_write),
  };
}

function normalizeMetadata(model: JsonObject): ExternalModelMetadata {
  const limit = isJsonObject(model.limit) ? model.limit : {};
  return {
    name: stringValue(model.name),
    reasoning: typeof model.reasoning === "boolean" ? model.reasoning : undefined,
    efforts: effortValues(model),
    input: inputModalities(model),
    contextWindow: positiveNumber(limit.context),
    maxTokens: positiveNumber(limit.output),
    cost: modelCost(model),
  };
}

function providerModels(catalog: JsonObject): Map<string, JsonObject> {
  const providers = new Map<string, JsonObject>();
  for (const [catalogId, value] of Object.entries(catalog)) {
    if (!isJsonObject(value) || !isJsonObject(value.models)) continue;
    const models = value.models;
    const aliases = [catalogId, stringValue(value.id), stringValue(value.name)].filter(
      (alias): alias is string => Boolean(alias),
    );
    for (const alias of aliases) providers.set(providerKey(alias), models);
  }
  return providers;
}

function findProviderModel(models: JsonObject, rawId: string): JsonObject | undefined {
  const separator = rawId.indexOf("/");
  const candidates = separator < 0 ? [rawId] : [rawId, rawId.slice(separator + 1)];
  for (const candidate of candidates) {
    const direct = models[candidate];
    if (isJsonObject(direct)) return direct;
    for (const value of Object.values(models)) {
      if (isJsonObject(value) && stringValue(value.id) === candidate) return value;
    }
  }
  return undefined;
}

export async function loadModelsDevMetadata(
  models: readonly ModelIdentity[],
  fetcher: FetchImpl = fetch,
  cacheFile: string = modelsDevCachePath(),
): Promise<Map<string, ExternalModelMetadata>> {
  const catalog = await loadCatalog(fetcher, cacheFile);
  if (!catalog) return new Map();

  const providers = providerModels(catalog);
  const metadata = new Map<string, ExternalModelMetadata>();
  for (const model of models) {
    if (!model.owner) continue;
    const provider = providers.get(providerKey(model.owner));
    if (!provider) continue;
    const match = findProviderModel(provider, model.id);
    if (match) metadata.set(model.id, normalizeMetadata(match));
  }
  return metadata;
}

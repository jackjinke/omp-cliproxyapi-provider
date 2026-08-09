import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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

export interface ModelMetadataOverride {
  modelId: string;
  overrideWith: string;
  contextWindow?: number;
  displayName?: string;
}

export interface ModelsDevMetadataMatches {
  automatic: Map<string, ExternalModelMetadata>;
  overridden: Map<string, ExternalModelMetadata>;
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

export function parseModelMetadataOverrides(
  value: unknown,
  fieldName = "modelMetadataOverrides",
): ModelMetadataOverride[] {
  if (!Array.isArray(value)) throw new Error(`${fieldName} must be an array`);

  const seen = new Set<string>();
  return value.map((entry, index) => {
    const entryName = `${fieldName}[${index}]`;
    if (!isJsonObject(entry)) throw new Error(`${entryName} must be an object`);
    const unsupported = Object.keys(entry).filter(
      key => !["modelId", "overrideWith", "contextWindow", "displayName"].includes(key),
    );
    if (unsupported.length > 0) throw new Error(`${entryName} contains unsupported field "${unsupported[0]}"`);

    const modelId = stringValue(entry.modelId);
    if (!modelId) throw new Error(`${entryName}.modelId must be a non-empty string`);
    if (seen.has(modelId)) throw new Error(`${fieldName} contains duplicate modelId "${modelId}"`);
    seen.add(modelId);

    const overrideWith = stringValue(entry.overrideWith);
    const separator = overrideWith?.indexOf("/") ?? -1;
    if (!overrideWith || separator <= 0 || separator === overrideWith.length - 1) {
      throw new Error(`${entryName}.overrideWith must use "provider/model" format`);
    }

    const contextWindow = entry.contextWindow;
    if (
      contextWindow !== undefined
      && (typeof contextWindow !== "number" || !Number.isInteger(contextWindow) || contextWindow <= 0)
    ) {
      throw new Error(`${entryName}.contextWindow must be a positive integer`);
    }
    const displayName = entry.displayName === undefined ? undefined : stringValue(entry.displayName);
    if (entry.displayName !== undefined && !displayName) {
      throw new Error(`${entryName}.displayName must be a non-empty string`);
    }

    return {
      modelId,
      overrideWith,
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(displayName ? { displayName } : {}),
    };
  });
}

export const DEFAULT_MODEL_METADATA_OVERRIDES = parseModelMetadataOverrides(
  JSON.parse(readFileSync(new URL("./model-metadata-overrides.json", import.meta.url), "utf8")),
  "default model metadata overrides",
);

export function mergeModelMetadataOverrides(
  userOverrides: readonly ModelMetadataOverride[] = [],
): ModelMetadataOverride[] {
  const merged = new Map(DEFAULT_MODEL_METADATA_OVERRIDES.map(override => [override.modelId, override]));
  for (const override of userOverrides) merged.set(override.modelId, override);
  return [...merged.values()];
}

export function modelsDevCachePath(agentDir: string): string {
  return join(agentDir, "tmp", "models.dev.json");
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
  mkdirSync(dirname(path), { recursive: true });
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
  cacheFile: string,
  fetcher: FetchImpl = fetch,
  overrides: readonly ModelMetadataOverride[] = DEFAULT_MODEL_METADATA_OVERRIDES,
): Promise<ModelsDevMetadataMatches> {
  const automatic = new Map<string, ExternalModelMetadata>();
  const overridden = new Map<string, ExternalModelMetadata>();
  const catalog = await loadCatalog(fetcher, cacheFile);
  if (!catalog) return { automatic, overridden };

  const providers = providerModels(catalog);
  const overridesByModel = new Map(overrides.map(override => [override.modelId, override]));
  for (const model of models) {
    if (model.owner) {
      const provider = providers.get(providerKey(model.owner));
      const match = provider ? findProviderModel(provider, model.id) : undefined;
      if (match) automatic.set(model.id, normalizeMetadata(match));
    }

    const override = overridesByModel.get(model.id);
    if (!override) continue;
    const separator = override.overrideWith.indexOf("/");
    const provider = providers.get(providerKey(override.overrideWith.slice(0, separator)));
    const match = provider ? findProviderModel(provider, override.overrideWith.slice(separator + 1)) : undefined;
    if (!match) continue;
    const metadata = normalizeMetadata(match);
    overridden.set(model.id, {
      ...metadata,
      ...(override.contextWindow !== undefined ? { contextWindow: override.contextWindow } : {}),
      ...(override.displayName !== undefined ? { name: override.displayName } : {}),
    });
  }
  return { automatic, overridden };
}

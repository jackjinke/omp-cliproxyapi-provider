import type { Effort, Model } from "@oh-my-pi/pi-ai";
import { catalogCachePath, readCatalogCache, writeCatalogCache } from "./discovery-cache.ts";
import {
  cliproxyapiConfigPath,
  discoverModels,
  readConfig,
  type CPAConfig,
  type CPAModel,
} from "./shared.ts";

export type ThinkingLevel = "off" | `${Effort}`;

// Keep only the host surface this extension consumes; tests need no full session.
export interface OmpExtensionAPI {
  registerProvider(name: string, config: OmpProviderConfig): void;
  getThinkingLevel(): ThinkingLevel | undefined;
  setThinkingLevel(level: ThinkingLevel): void;
  setModel(model: Model): Promise<boolean>;
  on(event: string, handler: (event: unknown, context: unknown) => unknown): void;
  registerCommand?(name: string, options: {
    description?: string;
    handler: (args: string, context: { ui: { notify(message: string, type?: "info" | "warning" | "error"): void } }) => Promise<void>;
  }): void;
}

export type OmpProviderModel = CPAModel & Partial<Pick<Model, "api" | "baseUrl" | "useResponsesLite" | "remoteCompaction">>;

export interface OmpProviderConfig {
  baseUrl: string;
  apiKey: string;
  api: Model["api"];
  models: OmpProviderModel[];
}

interface OmpModelIdentity {
  provider?: string;
  id?: string;
}

/**
 * pi-ai's Codex transport unconditionally appends `/codex/responses` to any
 * non-Codex base URL. Terminating the path with `?` parks that suffix in the
 * query string, so both HTTP and WebSocket connections keep using CLIProxyAPI's
 * `/v1/responses` endpoint.
 */
function codexBaseUrl(baseUrl: string): string {
  return `${baseUrl}/v1/responses?via=`;
}

/**
 * Models outside the known Claude/Codex families default to chat completions.
 * The Pi catalog's connection preferences do not identify an upstream protocol.
 */
const GENERIC_API = "openai-completions";

const PROVIDER_NAME = "cliproxyapi";

function buildOmpModels(models: CPAModel[], config: CPAConfig): OmpProviderModel[] {
  return models.map((model) => {
    if (model.isClaude) {
      // CPA's Anthropic surface; the host transport strips the provider's
      // trailing /v1 and appends /v1/messages itself.
      return { ...model, api: "anthropic-messages" };
    }
    if (model.isCodex) {
      return {
        ...model,
        api: "openai-codex-responses",
        baseUrl: config.codexBaseUrl ?? codexBaseUrl(config.baseUrl),
        // OMP enriches known Codex ids (gpt-5.6-luna/sol/terra, gpt-6-astra)
        // from its bundled catalog, which flags them useResponsesLite. The
        // lite path then ignores this model's baseUrl and reuses the host's
        // Codex provider session — hijacking the request to another gateway.
        useResponsesLite: false,
        remoteCompaction: {
          enabled: true,
          api: "openai-codex-responses",
          // CPA's own /responses/compact returns a generate response rather
          // than a compaction item, so only V2 streaming compaction is wired.
          v2StreamingEnabled: true,
          v2Endpoint: config.codexBaseUrl ? `${config.codexBaseUrl}/codex/responses` : `${config.baseUrl}/v1/responses`,
        },
      };
    }
    return { ...model, api: GENERIC_API };
  });
}

function extractModelIdentity(model: unknown): OmpModelIdentity | null {
  if (!model || typeof model !== "object") return null;
  const candidate = model as Record<string, unknown>;
  return {
    provider: typeof candidate.provider === "string" ? candidate.provider : undefined,
    id: typeof candidate.id === "string" ? candidate.id : undefined,
  };
}

export async function activateOmp(
  api: OmpExtensionAPI,
  environment: Record<string, string | undefined> = process.env,
  fetcher: (input: string | URL | Request, init?: RequestInit) => Promise<Response> = fetch,
): Promise<void> {
  if (!environment.CLIPROXYAPI_API_KEY?.trim()) return;
  const configPath = cliproxyapiConfigPath(environment);
  const config = readConfig(environment, configPath);
  // Discovery is optional; a failed catalog refresh must not remove authentication.
  const provider: OmpProviderConfig = {
    baseUrl: `${config.baseUrl}/v1`,
    apiKey: config.apiKey,
    api: GENERIC_API,
    models: [],
  };
  api.registerProvider(PROVIDER_NAME, provider);

  const cachePath = catalogCachePath(config, configPath);
  const discoveryStamp = Symbol("cliproxyapi.discovered");
  let catalogGeneration = 0;
  let modelCache = new Map<string, OmpProviderModel>();
  let inFlight: Promise<number> | undefined;

  function registerModels(models: CPAModel[]): void {
    const built = buildOmpModels(models, config);
    api.registerProvider(PROVIDER_NAME, { ...provider, models: built });
    modelCache = new Map(built.map(model => [model.id, model]));
    catalogGeneration++;
  }

  function refresh(): Promise<number> {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const catalog = await discoverModels(config, fetcher, configPath);
      registerModels(catalog.models);
      try {
        writeCatalogCache(cachePath, catalog.models);
      } catch (error) {
        console.warn(`[cliproxyapi] could not persist catalog: ${error instanceof Error ? error.message : String(error)}`);
      }
      return catalog.models.length;
    })().finally(() => { inFlight = undefined; });
    return inFlight;
  }

  api.registerCommand?.("cliproxyapi-refresh", {
    description: "Refresh the CLIProxyAPI model catalog",
    async handler(_args, context) {
      try {
        const count = await refresh();
        context.ui.notify(`CLIProxyAPI catalog refreshed (${count} models).`, "info");
      } catch (error) {
        context.ui.notify(`CLIProxyAPI refresh failed; keeping the last catalog: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });

  /**
   * Startup model selection happens before extension providers register, so a
   * persisted `cliproxyapi/…` default arrives as a provisional model carrying
   * only its id. Re-selecting through `api.setModel` after registration lets
   * the host reconcile native image input and catalog capabilities. Switching
   * sessions or models can supply another unreconciled model object: OMP's
   * selector rebuilds registered models with the provider-level baseUrl. Run
   * the same hydration before each turn so selection cannot lose the route.
   */
  async function rebindModel(_event: unknown, context: unknown): Promise<void> {
    const ctx = context as { model?: unknown };
    const identity = extractModelIdentity(ctx?.model);
    if (!identity || identity.provider !== PROVIDER_NAME || !identity.id) return;
    const builtModel = modelCache.get(identity.id);
    if (!builtModel) return;
    const target = ctx.model as Record<PropertyKey, unknown>;
    const generation = catalogGeneration;
    if (target[discoveryStamp] === generation) return;
    Object.assign(target, { thinking: undefined, preferWebsockets: undefined, remoteCompaction: undefined, useResponsesLite: undefined }, builtModel);
    // Replace foreign URLs with the provider endpoint; an absent URL lets the
    // host fall back to the upstream endpoint while still sending the CPA key.
    if (builtModel.baseUrl === undefined) target.baseUrl = `${config.baseUrl}/v1`;
    // setModel applies the catalog default; hydration must retain the session's effort.
    const level = api.getThinkingLevel();
    try {
      if (await api.setModel(ctx.model as Model)) target[discoveryStamp] = generation;
    } finally {
      if (level !== undefined) api.setThinkingLevel(level);
    }
  }

  api.on("session_start", rebindModel);
  api.on("session_switch", rebindModel);
  api.on("before_agent_start", rebindModel);

  const cached = readCatalogCache(cachePath);
  if (cached) registerModels(cached);
  const discovery = refresh().catch(error => {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[cliproxyapi] model discovery failed; authentication${cached ? " and cached models remain" : " remains"} registered: ${message}`);
  });
  if (!cached) await discovery;
}

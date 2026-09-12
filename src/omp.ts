import {
  cliproxyapiConfigPath,
  discoverModels,
  readConfig,
  type CPAConfig,
  type CPAModel,
} from "./shared.ts";

export interface OmpExtensionAPI {
  registerProvider(name: string, config: OmpProviderConfig): void;
  getThinkingLevel(): string;
  setThinkingLevel(level: string): void;
  setModel(model: unknown): Promise<boolean>;
  on(event: string, handler: (event: unknown, context: unknown) => unknown): void;
}

export interface OmpProviderModel extends CPAModel {
  api?: string;
  baseUrl?: string;
  useResponsesLite?: boolean;
  remoteCompaction?: {
    enabled: boolean;
    api: string;
    endpoint?: string;
    v2StreamingEnabled?: boolean;
    v2Endpoint?: string;
  };
}

export interface OmpProviderConfig {
  name: string;
  baseUrl: string;
  apiKey: string;
  api: string;
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
        baseUrl: codexBaseUrl(config.baseUrl),
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
          v2Endpoint: `${config.baseUrl}/v1/responses`,
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
    name: "CLIProxyAPI",
    baseUrl: `${config.baseUrl}/v1`,
    apiKey: config.apiKey,
    api: GENERIC_API,
    models: [],
  };
  api.registerProvider(PROVIDER_NAME, provider);

  let ompModels: OmpProviderModel[];
  try {
    const catalog = await discoverModels(config, fetcher, configPath);
    ompModels = buildOmpModels(catalog.models, config);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[cliproxyapi] model discovery failed; authentication remains registered: ${message}`);
    return;
  }

  const discoveryStamp = Symbol("cliproxyapi.discovered");
  // Cache the built host models — including per-model api/baseUrl/compaction —
  // because the startup rebind below must overwrite every transport field. A
  // provisional startup model can inherit a recently-used same-id variant from
  // another provider (e.g. omniroute's codex baseUrl), and assigning only
  // catalog metadata leaves that polluted baseUrl in place.
  const modelCache = new Map<string, OmpProviderModel>(ompModels.map((model) => [model.id, model]));

  api.registerProvider(PROVIDER_NAME, { ...provider, models: ompModels });

  /**
   * Startup model selection happens before extension providers register, so a
   * persisted `cliproxyapi/…` default arrives as a provisional model carrying
   * only its id. Re-selecting through `api.setModel` after registration lets
   * the host reconcile native image input and catalog capabilities. Switching
   * sessions in a long-lived host brings in another unreconciled model object,
   * so the same rebind runs on session_switch.
   */
  async function rebindStartupModel(_event: unknown, context: unknown): Promise<void> {
    const ctx = context as { model?: unknown };
    const identity = extractModelIdentity(ctx?.model);
    if (!identity || identity.provider !== PROVIDER_NAME || !identity.id) return;
    const builtModel = modelCache.get(identity.id);
    if (!builtModel) return;
    const target = ctx.model as Record<PropertyKey, unknown>;
    if (target[discoveryStamp]) return;
    Object.assign(target, builtModel);
    // Replace foreign URLs with the provider endpoint; an absent URL lets the
    // host fall back to the upstream endpoint while still sending the CPA key.
    if (builtModel.baseUrl === undefined) target.baseUrl = `${config.baseUrl}/v1`;
    // setModel applies the catalog default; hydration must retain the session's effort.
    const level = api.getThinkingLevel();
    try {
      if (await api.setModel(ctx.model)) target[discoveryStamp] = true;
    } finally {
      api.setThinkingLevel(level);
    }
  }

  api.on("session_start", rebindStartupModel);
  api.on("session_switch", rebindStartupModel);
}

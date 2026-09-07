import {
  cliproxyapiConfigPath,
  tryDiscoverModels,
  type CPAConfig,
  type CPAModel,
} from "./shared.ts";

export interface OmpExtensionAPI {
  registerProvider(name: string, config: OmpProviderConfig): void;
  getThinkingLevel(): string;
  setModel(model: unknown): Promise<boolean>;
  on(event: string, handler: (event: unknown, context: unknown) => unknown): void;
}

export interface OmpProviderModel extends CPAModel {
  api?: string;
  baseUrl?: string;
  preferWebsockets?: boolean;
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
  return `${baseUrl}/v1/responses?cliproxyapi-codex=`;
}

/**
 * Every remaining channel (kimi, glm/bigmodel, deepseek, opencode-go, …) is
 * spoken to its upstream over chat completions by CPA's executors, so asking
 * for Responses or Messages client-side would only add a translation hop.
 */
const GENERIC_API = "openai-completions";

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
        preferWebsockets: false,
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
  const discovery = await tryDiscoverModels(environment, fetcher, cliproxyapiConfigPath(environment));
  if (!discovery) return;
  const { config, catalog } = discovery;

  const discoveryStamp = Symbol("cliproxyapi.discovered");
  // Cache the built host models — including per-model api/baseUrl/compaction —
  // because the startup rebind below must overwrite every transport field. A
  // provisional startup model can inherit a recently-used same-id variant from
  // another provider (e.g. omniroute's codex baseUrl), and assigning only
  // catalog metadata leaves that polluted baseUrl in place.
  const ompModels = buildOmpModels(catalog.models, config);
  const modelCache = new Map<string, OmpProviderModel>(ompModels.map((model) => [model.id, model]));

  api.registerProvider("cpa", {
    name: "CLIProxyAPI",
    baseUrl: `${config.baseUrl}/v1`,
    apiKey: config.apiKey,
    api: GENERIC_API,
    models: ompModels,
  });

  /**
   * Startup model selection happens before extension providers register, so a
   * persisted `cpa/…` default arrives as a provisional model carrying
   * only its id. Re-selecting through `api.setModel` after registration lets
   * the host reconcile native image input and catalog capabilities.
   */
  function rebindStartupModel(_event: unknown, context: unknown): void {
    const ctx = context as { model?: unknown };
    const identity = extractModelIdentity(ctx?.model);
    if (!identity || identity.provider !== "cpa" || !identity.id) return;
    const builtModel = modelCache.get(identity.id);
    if (!builtModel) return;
    const target = ctx.model as Record<PropertyKey, unknown>;
    if (target[discoveryStamp]) return;
    Object.assign(target, builtModel);
    // Fields the built model does not define must not survive from the
    // provisional variant — a foreign codex baseUrl is the known case.
    if (builtModel.baseUrl === undefined) delete target.baseUrl;
    target[discoveryStamp] = true;
    void api.setModel(ctx.model).catch(() => {});
  }

  api.on("session_start", rebindStartupModel);
}

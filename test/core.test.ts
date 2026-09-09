import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activateOmp, type OmpExtensionAPI, type OmpProviderConfig } from "../src/omp.ts";
import {
  cliproxyapiConfigPath,
  extractCPAModel,
  normalizeCatalog,
  readConfig,
  tryDiscoverModels,
  type CPAConfig,
  type ModelsDevIndex,
} from "../src/shared.ts";

interface RegisteredProvider {
  name: string;
  config: OmpProviderConfig;
}

type FakeHandler = (event: { payload?: unknown }, context: FakeContext) => unknown;

class FakeHost implements OmpExtensionAPI {
  readonly providers: RegisteredProvider[] = [];
  readonly handlers = new Map<string, FakeHandler[]>();
  thinkingLevel = "high";
  setModelCalls: unknown[] = [];

  registerProvider(name: string, config: OmpProviderConfig): void {
    this.providers.push({ name, config });
  }

  getThinkingLevel(): string {
    return this.thinkingLevel;
  }

  async setModel(model: unknown): Promise<boolean> {
    this.setModelCalls.push(model);
    return true;
  }

  on(event: string, handler: FakeHandler): void {
    const existing = this.handlers.get(event) ?? [];
    existing.push(handler);
    this.handlers.set(event, existing);
  }

  async emit(event: string, context: FakeContext, payload?: unknown): Promise<void> {
    for (const handler of this.handlers.get(event) ?? []) {
      await handler({ payload }, context);
    }
  }
}

interface FakeContextModel {
  provider?: string;
  id?: string;
  name?: string;
  input?: string[];
  contextWindow?: number;
  [key: string]: unknown;
}

interface FakeContext {
  model?: FakeContextModel;
  [key: string]: unknown;
}

function fakeContext(model?: FakeContextModel): FakeContext {
  return { model };
}

/**
 * Config discovery falls back to `$HOME/.omp/agent` when `PI_CODING_AGENT_DIR`
 * is unset, so tests that omit it would read the developer's real
 * `cliproxyapi.yml`. Every activation test pins an empty directory to keep
 * defaults deterministic.
 */
function isolatedEnv(extra: Record<string, string> = {}): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), "cliproxyapi-test-"));
  return { PI_CODING_AGENT_DIR: dir, ...extra };
}

function envWithConfig(configYaml: string, extra: Record<string, string> = {}): Record<string, string> {
  const environment = isolatedEnv(extra);
  writeFileSync(join(environment.PI_CODING_AGENT_DIR as string, "cliproxyapi.yml"), configYaml);
  return environment;
}

function testConfig(overrides: Partial<CPAConfig> = {}): CPAConfig {
  return {
    apiKey: "test-key",
    baseUrl: "http://127.0.0.1:8317",
    startupTimeoutMs: 15000,
    modelOverrides: {},
    ...overrides,
  };
}

/** Pi/Codex client catalog entries, without channel or provider metadata. */
const CLAUDE_ENTRY = {
  slug: "claude-opus-4-6",
  display_name: "Claude Opus 4.6",
  context_window: 200000,
  max_tokens: 64000,
  supported_reasoning_levels: ["low", "medium", "high", "max"].map((effort) => ({ effort })),
  input_modalities: ["text", "image"],
};

const CODEX_ENTRY = {
  slug: "gpt-5.3-codex",
  display_name: "GPT-5.3 Codex",
  context_window: 400000,
  max_context_window: 1000000,
  max_tokens: 128000,
  supported_reasoning_levels: ["low", "medium", "high", "xhigh"].map((effort) => ({ effort })),
  input_modalities: ["text", "image"],
  prefer_websockets: true,
  use_responses_lite: true,
};

const KIMI_ENTRY = {
  slug: "kimi-k3-256k",
  display_name: "Kimi K3 256K",
  context_window: 262144,
  max_tokens: 32768,
  supported_reasoning_levels: ["low", "medium", "high"].map((effort) => ({ effort })),
  input_modalities: ["text", "image"],
};

const SPARSE_ENTRY = {
  slug: "deepseek-v3.2",
  display_name: "DeepSeek V3.2",
};

function makeModelsResponse(entries: unknown[]): Response {
  return new Response(
    JSON.stringify({ models: entries }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

describe("shared catalog logic", () => {
  test("reads env config with defaults", () => {
    const config = readConfig(isolatedEnv({ CLIPROXYAPI_API_KEY: "abc" }));
    expect(config.apiKey).toBe("abc");
    expect(config.baseUrl).toBe("http://127.0.0.1:8317");
    expect(config.startupTimeoutMs).toBe(15000);
  });

  test("requires CLIPROXYAPI_API_KEY", () => {
    expect(() => readConfig(isolatedEnv())).toThrow("CLIPROXYAPI_API_KEY is required");
  });

  test("reads model overrides from yaml", () => {
    const environment = envWithConfig(
      [
        "models:",
        "  combo/coding:",
        "    codex_transport: true",
        "  \"*\":",
        "    efforts: [low, medium]",
        "  kimi-k3-256k:",
        "    efforts: [low, high]",
      ].join("\n"),
      { CLIPROXYAPI_API_KEY: "abc" },
    );
    const config = readConfig(environment);
    expect(config.modelOverrides["combo/coding"]?.codexTransport).toBe(true);
    expect(config.modelOverrides["*"]?.efforts).toEqual(["low", "medium"]);
    expect(config.modelOverrides["kimi-k3-256k"]?.efforts).toEqual(["low", "high"]);
  });

  test("normalizes Pi catalog capabilities", () => {
    const { models } = normalizeCatalog([CLAUDE_ENTRY, CODEX_ENTRY, KIMI_ENTRY], testConfig());
    const [claude, codex, kimi] = models;

    expect(claude.contextWindow).toBe(200000);
    expect(claude.maxTokens).toBe(64000);
    expect(claude.name).toBe("Claude Opus 4.6");
    expect(claude.thinking?.efforts).toEqual(["low", "medium", "high", "max"]);
    expect(claude.input).toEqual(["text", "image"]);
    expect(claude.isClaude).toBe(true);
    expect(claude.isCodex).toBe(false);

    expect(codex.contextWindow).toBe(400000);
    expect(codex.thinking?.efforts).toEqual(["low", "medium", "high", "xhigh"]);
    expect(codex.isCodex).toBe(true);
    expect(codex.isClaude).toBe(false);

    expect(kimi.thinking?.efforts).toEqual(["low", "medium", "high"]);
    expect(kimi.isClaude).toBe(false);
    expect(kimi.isCodex).toBe(false);
  });

  test("drops unsupported effort tiers", () => {
    const entry = {
      ...CODEX_ENTRY,
      supported_reasoning_levels: ["auto", "none", "ultra", "low", "high"].map((effort) => ({ effort })),
    };
    const [model] = normalizeCatalog([entry], testConfig()).models;
    expect(model.thinking?.efforts).toEqual(["low", "high"]);
  });

  test("explicit empty and unsupported effort lists do not invent selectable levels", () => {
    const [empty, unsupported] = normalizeCatalog([
      { ...CODEX_ENTRY, supported_reasoning_levels: [] },
      { ...CODEX_ENTRY, supported_reasoning_levels: [{ effort: "ultra" }] },
    ], testConfig()).models;
    expect(empty.reasoning).toBe(false);
    expect(empty.thinking).toBeUndefined();
    expect(unsupported.reasoning).toBe(true);
    expect(unsupported.thinking).toBeUndefined();
  });

  test("applies effort overrides as additive extras", () => {
    const config = testConfig({ modelOverrides: { "*": { efforts: ["minimal"] } } });
    const [model] = normalizeCatalog([CLAUDE_ENTRY], config).models;
    expect(model.thinking?.efforts).toEqual(["low", "medium", "high", "max", "minimal"]);
  });

  test("fills conservative defaults for sparse entries", () => {
    const [model] = normalizeCatalog([SPARSE_ENTRY], testConfig()).models;
    expect(model.contextWindow).toBe(128000);
    expect(model.maxTokens).toBe(16384);
    expect(model.reasoning).toBe(false);
    expect(model.thinking).toBeUndefined();
    expect(model.input).toEqual(["text"]);
  });

  test("infers claude and codex wires from ids without channel metadata", () => {
    const bare = (slug: string) => ({ slug });
    const config = testConfig();
    expect(extractCPAModel(bare("claude-sonnet-4-5"), config)?.isClaude).toBe(true);
    expect(extractCPAModel(bare("gpt-5"), config)?.isCodex).toBe(true);
    expect(extractCPAModel(bare("glm-5"), config)?.isClaude).toBe(false);
  });

  test("honors per-model codex_transport opt-in", () => {
    const config = testConfig({ modelOverrides: { "custom/o3-pool": { codexTransport: true } } });
    expect(extractCPAModel({ slug: "custom/o3-pool" }, config)?.isCodex).toBe(true);
  });

  test("Codex models without effort metadata retain the fallback levels", () => {
    const sparse = {
      slug: "gpt-5.5",
      display_name: "GPT 5.5",
      context_window: 272000,
      max_tokens: 128000,
    };
    const [model] = normalizeCatalog([sparse], testConfig()).models;
    expect(model.isCodex).toBe(true);
    expect(model.reasoning).toBe(true);
    expect(model.thinking?.efforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(model.contextWindow).toBe(272000);
    expect(model.maxTokens).toBe(128000);
  });

  test("codex- prefix ids select the codex wire", () => {
    const [model] = normalizeCatalog([{ slug: "codex-auto-review" }], testConfig()).models;
    expect(model.isCodex).toBe(true);
    expect(model.reasoning).toBe(true);
  });

  test("gpt-image models stay non-reasoning", () => {
    const [model] = normalizeCatalog([{ ...CODEX_ENTRY, slug: "gpt-image-2" }], testConfig()).models;
    expect(model.isCodex).toBe(true);
    expect(model.reasoning).toBe(false);
    expect(model.thinking).toBeUndefined();
  });

  test("an exact-id effort override opts a model into reasoning", () => {
    const config = testConfig({ modelOverrides: { "deepseek-v3.2": { efforts: ["low", "high"] } } });
    const [model] = normalizeCatalog([SPARSE_ENTRY], config).models;
    expect(model.reasoning).toBe(true);
    expect(model.thinking?.efforts).toEqual(["low", "high"]);
  });

  test("wildcard effort overrides do not invent reasoning", () => {
    const config = testConfig({ modelOverrides: { "*": { efforts: ["low"] } } });
    const [model] = normalizeCatalog([SPARSE_ENTRY], config).models;
    expect(model.reasoning).toBe(false);
  });

  test("supports maximum-context fallback and filters non-image modalities", () => {
    const gemini = {
      slug: "gemini-2.5-pro",
      display_name: "Gemini 2.5 Pro",
      max_context_window: 1048576,
      max_tokens: 65536,
      supported_reasoning_levels: [{ effort: "high" }],
      input_modalities: ["text", "image", "audio", "video"],
    };
    const [model] = normalizeCatalog([gemini], testConfig()).models;
    expect(model.contextWindow).toBe(1048576);
    expect(model.maxTokens).toBe(65536);
    expect(model.thinking?.efforts).toEqual(["high"]);
    expect(model.input).toEqual(["text", "image"]);
  });

  test("drops unusable entries", () => {
    const { models } = normalizeCatalog([{ display_name: "no id" }, null, 42], testConfig());
    expect(models).toHaveLength(0);
  });
});

describe("OMP adapter", () => {
  test("registers provider with per-model wires", async () => {
    const host = new FakeHost();
    const environment = isolatedEnv({ CLIPROXYAPI_API_KEY: "abc" });
    await activateOmp(host, environment, async () =>
      makeModelsResponse([CLAUDE_ENTRY, CODEX_ENTRY, KIMI_ENTRY, SPARSE_ENTRY]),
    );

    expect(host.providers).toHaveLength(1);
    const provider = host.providers[0];
    expect(provider.name).toBe("cliproxyapi");
    expect(provider.config.name).toBe("CLIProxyAPI");
    expect(provider.config.baseUrl).toBe("http://127.0.0.1:8317/v1");
    expect(provider.config.apiKey).toBe("abc");
    expect(provider.config.api).toBe("openai-completions");

    const byId = new Map(provider.config.models.map((model) => [String(model.id), model]));
    expect(byId.get("claude-opus-4-6")?.api).toBe("anthropic-messages");
    expect(byId.get("kimi-k3-256k")?.api).toBe("openai-completions");
    expect(byId.get("deepseek-v3.2")?.api).toBe("openai-completions");

    const codex = byId.get("gpt-5.3-codex");
    expect(codex?.api).toBe("openai-codex-responses");
    expect(String(codex?.baseUrl)).toContain("?via=");
    const compaction = codex?.remoteCompaction as Record<string, unknown>;
    expect(compaction.enabled).toBe(true);
    expect(compaction.v2StreamingEnabled).toBe(true);
    expect(compaction.v2Endpoint).toBe("http://127.0.0.1:8317/v1/responses");
    expect(compaction.endpoint).toBeUndefined();
  });

  test("codex base url keeps /v1/responses as the request path", async () => {
    const host = new FakeHost();
    const environment = isolatedEnv({ CLIPROXYAPI_API_KEY: "abc", CLIPROXYAPI_BASE_URL: "http://cpa:8317" });
    await activateOmp(host, environment, async () => makeModelsResponse([CODEX_ENTRY]));
    const codex = host.providers[0].config.models[0];
    const url = new URL(String(codex?.baseUrl));
    expect(url.pathname).toBe("/v1/responses");
    // pi-ai appends /codex/responses after this base; parked in the query it
    // never reaches CPA's router as a path segment.
    expect(url.search).toBe("?via=");
  });

  test("Pi discovery preserves exact slugs and applies supported capability hints", async () => {
    const host = new FakeHost();
    const astra = {
      ...CODEX_ENTRY,
      slug: "gpt-6-astra",
      display_name: "GPT 6.0 Astra",
      default_reasoning_level: "medium",
      supported_reasoning_levels: ["low", "medium", "high", "xhigh", "max", "ultra"].map((effort) => ({ effort })),
    };
    await activateOmp(host, isolatedEnv({ CLIPROXYAPI_API_KEY: "abc" }), async (input, init) => {
      const url = new URL(String(input));
      if (url.hostname === "models.dev") return new Response("{}");
      if (url.pathname === "/v1/models" && !url.search) return new Response('{"data":[]}');
      const headers = new Headers(init?.headers);
      if (url.pathname !== "/v1/models" || url.searchParams.get("client_version") !== "pi" ||
        headers.has("Anthropic-Version") || headers.get("Authorization") !== "Bearer abc") {
        return new Response("wrong model-list protocol", { status: 400 });
      }
      return makeModelsResponse([
        astra,
        { ...astra, slug: "GPT-6 Astra", display_name: "gpt-6-astra", prefer_websockets: false },
        { ...KIMI_ENTRY, prefer_websockets: true, use_responses_lite: true },
      ]);
    });
    const models = host.providers[0].config.models;
    const canonical = models.find((model) => model.id === "gpt-6-astra")!;
    expect(canonical.name).toBe("GPT 6.0 Astra");
    expect(canonical.input).toEqual(["text", "image"]);
    expect(canonical.thinking?.efforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(canonical.thinking?.defaultLevel).toBe("medium");
    expect(canonical.preferWebsockets).toBe(true);
    expect(canonical.useResponsesLite).toBe(false);
    const alias = models.find((model) => model.id === "GPT-6 Astra")!;
    expect(alias.name).toBe("gpt-6-astra");
    expect(alias.api).toBe("openai-completions");
    const kimi = models.find((model) => model.id === KIMI_ENTRY.slug)!;
    expect(kimi.api).toBe("openai-completions");
    expect(kimi.preferWebsockets).toBeUndefined();
    expect(kimi.useResponsesLite).toBeUndefined();
  });

  test("an explicit false WebSocket preference survives Codex registration", async () => {
    const host = new FakeHost();
    await activateOmp(host, isolatedEnv({ CLIPROXYAPI_API_KEY: "abc" }), async () =>
      makeModelsResponse([{ ...CODEX_ENTRY, prefer_websockets: false }]),
    );
    expect(host.providers[0].config.models[0].preferWebsockets).toBe(false);
  });

  test("continues without provider when discovery fails", async () => {
    const host = new FakeHost();
    const environment = isolatedEnv({ CLIPROXYAPI_API_KEY: "abc" });
    await activateOmp(host, environment, async () => {
      throw new Error("connection refused");
    });
    expect(host.providers).toHaveLength(0);
  });

  test("hydrates a provisional startup model from the catalog", async () => {
    const host = new FakeHost();
    const environment = isolatedEnv({ CLIPROXYAPI_API_KEY: "abc" });
    await activateOmp(host, environment, async () =>
      makeModelsResponse([KIMI_ENTRY, CLAUDE_ENTRY]),
    );
    const provisional: FakeContextModel = { provider: "cliproxyapi", id: "kimi-k3-256k" };
    await host.emit("session_start", fakeContext(provisional));
    expect(provisional.contextWindow).toBe(262144);
    expect(host.setModelCalls).toHaveLength(1);
  });

  test("rebind overwrites a foreign codex baseUrl on the provisional model", async () => {
    const host = new FakeHost();
    const environment = isolatedEnv({ CLIPROXYAPI_API_KEY: "abc" });
    await activateOmp(host, environment, async () => makeModelsResponse([CODEX_ENTRY]));
    // Provisional startup model polluted by a recently-used same-id variant
    // from another provider (observed: omniroute's codex baseUrl survives
    // startup resolution and would hijack the request away from CPA).
    const provisional: FakeContextModel = {
      provider: "cliproxyapi",
      id: "gpt-5.3-codex",
      baseUrl: "http://or.sorcery.link:20128/v1/responses?omniroute-codex=",
    };
    await host.emit("session_start", fakeContext(provisional));
    expect(String(provisional.baseUrl)).toContain("?via=");
    expect(provisional.api).toBe("openai-codex-responses");
    expect(host.setModelCalls).toHaveLength(1);
  });

  test("rebind drops a foreign baseUrl when the built model has none", async () => {
    const host = new FakeHost();
    const environment = isolatedEnv({ CLIPROXYAPI_API_KEY: "abc" });
    await activateOmp(host, environment, async () => makeModelsResponse([KIMI_ENTRY]));
    const provisional: FakeContextModel = {
      provider: "cliproxyapi",
      id: "kimi-k3-256k",
      baseUrl: "http://or.sorcery.link:20128/v1",
    };
    await host.emit("session_start", fakeContext(provisional));
    expect(provisional.baseUrl).toBeUndefined();
    expect(provisional.api).toBe("openai-completions");
  });

  test("ignores startup models from other providers", async () => {
    const host = new FakeHost();
    const environment = isolatedEnv({ CLIPROXYAPI_API_KEY: "abc" });
    await activateOmp(host, environment, async () => makeModelsResponse([KIMI_ENTRY]));
    const provisional: FakeContextModel = { provider: "omniroute", id: "kimi-k3-256k" };
    await host.emit("session_start", fakeContext(provisional));
    expect(provisional.contextWindow).toBeUndefined();
    expect(host.setModelCalls).toHaveLength(0);
  });

  test("rebinds again when switching to another cliproxyapi session", async () => {
    const host = new FakeHost();
    const environment = isolatedEnv({ CLIPROXYAPI_API_KEY: "abc" });
    await activateOmp(host, environment, async () => makeModelsResponse([KIMI_ENTRY]));
    const first: FakeContextModel = { provider: "cliproxyapi", id: "kimi-k3-256k" };
    await host.emit("session_start", fakeContext(first));
    const switched: FakeContextModel = { provider: "cliproxyapi", id: "kimi-k3-256k" };
    await host.emit("session_switch", fakeContext(switched));
    expect(switched.contextWindow).toBe(262144);
    expect(host.setModelCalls).toHaveLength(2);
  });
});

describe("models.dev enrichment and overrides", () => {
  /** Sparse Pi entry with owner metadata joined from the ordinary listing. */
  const COMPAT_ENTRY = {
    slug: "glm-4.7",
    display_name: "GLM 4.7",
    owned_by: "zhipu",
    supported_reasoning_levels: ["low", "medium", "high"].map((effort) => ({ effort })),
  };

  function makeModelsDevResponse(providers: Record<string, Record<string, unknown>>): Response {
    return new Response(
      JSON.stringify(
        Object.fromEntries(
          Object.entries(providers).map(([id, models]) => [id, { id, name: id, models }]),
        ),
      ),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }

  test("parses models overrides, ignoring unknown fields", () => {
    const environment = envWithConfig(`
models:
  glm-4.7:
    contextWindow: 200000
    maxTokens: 128000
    futureField: 42
  "*":
    contextWindow: 100000
`, { CLIPROXYAPI_API_KEY: "abc" });
    const config = readConfig(environment);
    expect(config.modelOverrides["glm-4.7"]).toEqual({ contextWindow: 200000, maxTokens: 128000 });
    expect(config.modelOverrides["*"]).toEqual({ contextWindow: 100000 });
  });

  test("overrides apply to first-party channels and merge wildcard with exact", () => {
    const config = testConfig({
      modelOverrides: { "*": { maxTokens: 4096 }, "claude-opus-4-6": { contextWindow: 150000 } },
    });
    const [model] = normalizeCatalog([CLAUDE_ENTRY], config).models;
    expect(model.contextWindow).toBe(150000);
    expect(model.maxTokens).toBe(4096);
  });

  test("models.dev enriches matching providers while unmatched entries retain Pi metadata", () => {
    const index: ModelsDevIndex = {
      "zhipu/glm47": { contextWindow: 204800, maxTokens: 131072, input: ["text", "image"] },
      "zhipu/claudeopus46": { contextWindow: 999 },
    };
    const [compat, claude] = normalizeCatalog([COMPAT_ENTRY, CLAUDE_ENTRY], testConfig(), index).models;
    expect(compat.contextWindow).toBe(204800);
    expect(compat.maxTokens).toBe(131072);
    expect(compat.input).toEqual(["text", "image"]);
    expect(claude.contextWindow).toBe(200000);
  });

  test("models.dev metadata takes priority over Pi values", () => {
    const entry = { ...COMPAT_ENTRY, context_window: 111000 };
    const index: ModelsDevIndex = { "zhipu/glm47": { contextWindow: 204800, maxTokens: 131072 } };
    const [model] = normalizeCatalog([entry], testConfig(), index).models;
    expect(model.contextWindow).toBe(204800);
    expect(model.maxTokens).toBe(131072);
  });

  test("overrides beat both CPA metadata and models.dev", () => {
    const config = testConfig({ modelOverrides: { "glm-4.7": { contextWindow: 150000 } } });
    const index: ModelsDevIndex = { "zhipu/glm47": { contextWindow: 204800 } };
    const [model] = normalizeCatalog([COMPAT_ENTRY], config, index).models;
    expect(model.contextWindow).toBe(150000);
  });

  test("matches by owner-scoped id, then owner-scoped display name", () => {
    const index: ModelsDevIndex = {
      "zhipu/glm47": { contextWindow: 222 },
      "zhipu/customalias": { contextWindow: 111 },
    };
    const [byId] = normalizeCatalog([COMPAT_ENTRY], testConfig(), index).models;
    expect(byId.contextWindow).toBe(222);
    const [byName] = normalizeCatalog(
      [{ ...COMPAT_ENTRY, slug: "custom-alias" }],
      testConfig(),
      index,
    ).models;
    expect(byName.contextWindow).toBe(111);
  });

  test("never fills from a different provider's entry for the same model id", () => {
    // Resellers report conflicting limits for shared ids like deepseek-v3.2;
    // a wrong guess is worse than the fallback.
    const index: ModelsDevIndex = { "somewhiteglove/deepseekv32": { contextWindow: 999 } };
    const entry = {
      ...COMPAT_ENTRY,
      slug: "deepseek-v3.2",
      display_name: "DeepSeek V3.2",
      owned_by: "deepseek",
    };
    const [model] = normalizeCatalog([entry], testConfig(), index).models;
    expect(model.contextWindow).toBe(128000);
  });

  test("discoverModels enriches compat models and caches the catalog", async () => {
    const environment = isolatedEnv({ CLIPROXYAPI_API_KEY: "abc" });
    let modelsDevCalls = 0;
    const fetcher = async (input: string | URL | Request): Promise<Response> => {
      if (String(input).includes("models.dev")) {
        modelsDevCalls += 1;
        return makeModelsDevResponse({
          zhipu: {
            "glm-4.7": {
              id: "glm-4.7",
              name: "GLM-4.7",
              limit: { context: 204800, output: 131072 },
              modalities: { input: ["text", "image"] },
            },
          },
        });
      }
      if (new URL(String(input)).pathname === "/v1/models" && !new URL(String(input)).search) {
        return new Response(JSON.stringify({ data: [{ id: COMPAT_ENTRY.slug, owned_by: "zhipu" }] }));
      }
      return makeModelsResponse([{ ...COMPAT_ENTRY, owned_by: undefined }, CLAUDE_ENTRY]);
    };

    const first = await tryDiscoverModels(environment, fetcher);
    const glm = first?.catalog.models.find((model) => model.id === "glm-4.7");
    expect(glm?.contextWindow).toBe(204800);
    expect(glm?.maxTokens).toBe(131072);
    expect(modelsDevCalls).toBe(1);
    const cachePath = join(environment.PI_CODING_AGENT_DIR, "cache", "cliproxyapi", "models.dev.json");
    expect(existsSync(cachePath)).toBe(true);

    // Second run within the TTL reads the cache without touching the network.
    modelsDevCalls = 0;
    const second = await tryDiscoverModels(environment, fetcher);
    expect(second?.catalog.models.find((model) => model.id === "glm-4.7")?.contextWindow).toBe(204800);
    expect(modelsDevCalls).toBe(0);
  });

  test("six-hour-old cache loads before refresh and the next discovery sees refreshed metadata", async () => {
    const environment = isolatedEnv({ CLIPROXYAPI_API_KEY: "abc" });
    const cachePath = join(environment.PI_CODING_AGENT_DIR, "cache", "cliproxyapi", "models.dev.json");
    mkdirSync(join(environment.PI_CODING_AGENT_DIR, "cache", "cliproxyapi"), { recursive: true });
    writeFileSync(cachePath, JSON.stringify({
      fetchedAt: Date.now() - 6 * 60 * 60 * 1000,
      index: { "zhipu/glm47": { contextWindow: 123456 } },
    }));
    let release!: (response: Response) => void;
    const refresh = new Promise<Response>((resolve) => { release = resolve; });
    const fetcher = async (input: string | URL | Request): Promise<Response> => {
      if (String(input).includes("models.dev")) return refresh;
      return makeModelsResponse([COMPAT_ENTRY]);
    };
    let settled = false;
    const discovery = tryDiscoverModels(environment, fetcher).then((result) => {
      settled = true;
      return result;
    });
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(true);
      expect((await discovery)?.catalog.models[0].contextWindow).toBe(123456);
    } finally {
      release(makeModelsDevResponse({ zhipu: { "glm-4.7": { limit: { context: 204800 } } } }));
      await discovery;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const next = await tryDiscoverModels(environment, async (input) => {
      if (String(input).includes("models.dev")) throw new Error("fresh cache must not require a fetch");
      return makeModelsResponse([COMPAT_ENTRY]);
    });
    expect(next?.catalog.models[0].contextWindow).toBe(204800);
  });

  test("keeps a stale models.dev cache when background refresh fails", async () => {
    const environment = isolatedEnv({ CLIPROXYAPI_API_KEY: "abc" });
    mkdirSync(join(environment.PI_CODING_AGENT_DIR, "cache", "cliproxyapi"), { recursive: true });
    writeFileSync(
      join(environment.PI_CODING_AGENT_DIR, "cache", "cliproxyapi", "models.dev.json"),
      JSON.stringify({
        fetchedAt: Date.now() - 48 * 60 * 60 * 1000,
        index: { "zhipu/glm47": { contextWindow: 123456 } },
      }),
    );
    const discovery = await tryDiscoverModels(environment, async (input) => {
      if (String(input).includes("models.dev")) throw new Error("offline");
      return makeModelsResponse([COMPAT_ENTRY]);
    });
    expect(discovery?.catalog.models[0]?.contextWindow).toBe(123456);
  });

  test("models.dev replaces Pi template capabilities and falls back per missing field", async () => {
    const environment = isolatedEnv({ CLIPROXYAPI_API_KEY: "abc" });
    const discovery = await tryDiscoverModels(environment, async (input) => {
      if (String(input).includes("models.dev")) {
        return makeModelsDevResponse({ anthropic: {
          "claude-opus-4-6": {
            limit: { context: 300000 },
            modalities: { input: ["text"] },
            reasoning: false,
            tool_call: false,
          },
        } });
      }
      return makeModelsResponse([{ ...CLAUDE_ENTRY, owned_by: "anthropic" }]);
    });
    const model = discovery?.catalog.models[0];
    expect(model?.contextWindow).toBe(300000);
    expect(model?.maxTokens).toBe(CLAUDE_ENTRY.max_tokens);
    expect(model?.input).toEqual(["text"]);
    expect(model?.reasoning).toBe(false);
    expect(model?.thinking).toBeUndefined();
    expect(model?.supportsTools).toBe(false);
  });
});

describe("tryDiscoverModels", () => {
  test("returns null when the api key is missing", async () => {
    const discovery = await tryDiscoverModels(isolatedEnv(), async () => {
      throw new Error("should not fetch");
    });
    expect(discovery).toBeNull();
  });

  test("returns null when the catalog is empty", async () => {
    const discovery = await tryDiscoverModels(
      isolatedEnv({ CLIPROXYAPI_API_KEY: "abc" }),
      async () => makeModelsResponse([]),
    );
    expect(discovery).toBeNull();
  });

  test("config path honors PI_CODING_AGENT_DIR", () => {
    expect(cliproxyapiConfigPath({ PI_CODING_AGENT_DIR: "/tmp/agent" })).toBe(
      "/tmp/agent/cliproxyapi.yml",
    );
  });
});

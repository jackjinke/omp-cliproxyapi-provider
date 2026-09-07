import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activateOmp, type OmpExtensionAPI, type OmpProviderConfig } from "../src/omp.ts";
import {
  cliproxyapiConfigPath,
  decodeClaudeDDId,
  extractCPAModel,
  normalizeCatalog,
  readConfig,
  tryDiscoverModels,
  type CPAConfig,
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
    codexTransport: new Set(),
    effortOverrides: {},
    ...overrides,
  };
}

/** Shape of rich Anthropic-listing entries, mirroring internal/registry/models/models.json. */
const CLAUDE_ENTRY = {
  id: "claude-opus-4-6",
  object: "model",
  created: 1770000000,
  owned_by: "anthropic",
  type: "claude",
  display_name: "Claude Opus 4.6",
  context_length: 200000,
  max_completion_tokens: 64000,
  thinking: { min: 1024, max: 32768, zero_allowed: false, levels: ["low", "medium", "high", "max"] },
  supportedInputModalities: ["text", "image"],
  supportedOutputModalities: ["text"],
};

const CODEX_ENTRY = {
  id: "gpt-5.3-codex",
  object: "model",
  created: 1770000000,
  owned_by: "openai",
  type: "codex",
  display_name: "GPT-5.3 Codex",
  context_length: 400000,
  max_completion_tokens: 128000,
  thinking: { min: 0, max: 65535, zero_allowed: true, levels: ["low", "medium", "high", "xhigh"] },
  supportedInputModalities: ["text", "image"],
};

const KIMI_ENTRY = {
  id: "kimi-k3-256k",
  object: "model",
  created: 1770000000,
  owned_by: "moonshot",
  type: "kimi",
  display_name: "Kimi K3 256K",
  context_length: 262144,
  max_completion_tokens: 32768,
  thinking: { min: 0, max: 16384, zero_allowed: true },
  supportedInputModalities: ["text", "image"],
};

const SPARSE_ENTRY = {
  id: "deepseek-v3.2",
  object: "model",
  created: 1770000000,
  owned_by: "deepseek",
  type: "deepseek",
  display_name: "DeepSeek V3.2",
};

function makeModelsResponse(entries: unknown[]): Response {
  return new Response(
    JSON.stringify({ data: entries, has_more: false, first_id: null, last_id: null }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

describe("claude-dd id decoding", () => {
  test("round-trips cloaked ids", () => {
    expect(decodeClaudeDDId("claude-fable-5-dd-3k-imik")).toBe("kimi-k3");
    expect(decodeClaudeDDId("claude-fable-5-dd-xedoc-3.5-tpg")).toBe("gpt-5.3-codex");
  });

  test("leaves native claude ids and other ids untouched", () => {
    expect(decodeClaudeDDId("claude-opus-4-6")).toBe("claude-opus-4-6");
    expect(decodeClaudeDDId("kimi-k3-256k")).toBe("kimi-k3-256k");
  });

  test("leaves degenerate cloaked ids untouched", () => {
    expect(decodeClaudeDDId("claude-fable-5-dd-")).toBe("claude-fable-5-dd-");
  });
});

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

  test("reads codex transport and effort overrides from yaml", () => {
    const environment = envWithConfig(
      [
        "codex_transport: [combo/coding]",
        '"*": [low, medium]',
        "kimi-k3-256k: [low, high]",
      ].join("\n"),
      { CLIPROXYAPI_API_KEY: "abc" },
    );
    const config = readConfig(environment);
    expect(config.codexTransport.has("combo/coding")).toBe(true);
    expect(config.effortOverrides["*"]).toEqual(["low", "medium"]);
    expect(config.effortOverrides["kimi-k3-256k"]).toEqual(["low", "high"]);
  });

  test("normalizes rich registry metadata", () => {
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

    // No levels listed: reasoning model falls back to the default effort set.
    expect(kimi.thinking?.efforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(kimi.isClaude).toBe(false);
    expect(kimi.isCodex).toBe(false);
  });

  test("drops unsupported effort tiers", () => {
    const entry = {
      ...CODEX_ENTRY,
      thinking: { levels: ["auto", "none", "low", "high"] },
    };
    const [model] = normalizeCatalog([entry], testConfig()).models;
    expect(model.thinking?.efforts).toEqual(["low", "high"]);
  });

  test("applies effort overrides as additive extras", () => {
    const config = testConfig({ effortOverrides: { "*": ["minimal"] } });
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

  test("decodes cloaked ids during normalization", () => {
    const cloaked = { ...KIMI_ENTRY, id: "claude-fable-5-dd-k652-3k-imik" };
    const [model] = normalizeCatalog([cloaked], testConfig()).models;
    expect(model.id).toBe("kimi-k3-256k");
    expect(model.channel).toBe("kimi");
  });

  test("infers claude and codex wires from ids without channel metadata", () => {
    const bare = (id: string) => ({ id });
    const config = testConfig();
    expect(extractCPAModel(bare("claude-sonnet-4-5"), config)?.isClaude).toBe(true);
    expect(extractCPAModel(bare("gpt-5"), config)?.isCodex).toBe(true);
    expect(extractCPAModel(bare("glm-5"), config)?.isClaude).toBe(false);
  });

  test("honors codex_transport opt-in list", () => {
    const config = testConfig({ codexTransport: new Set(["custom/o3-pool"]) });
    expect(extractCPAModel({ id: "custom/o3-pool" }, config)?.isCodex).toBe(true);
  });

  test("proxied upstream listings still mark codex models as reasoning", () => {
    // Shape served by CPA for codex-api-key upstreams: no `thinking` block,
    // Anthropic-style max_input_tokens/max_tokens, generic type.
    const sparse = {
      id: "gpt-5.5",
      object: "model",
      owned_by: "openai",
      type: "model",
      display_name: "GPT 5.5",
      max_input_tokens: 272000,
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
    const [model] = normalizeCatalog([{ id: "codex-auto-review" }], testConfig()).models;
    expect(model.isCodex).toBe(true);
    expect(model.reasoning).toBe(true);
  });

  test("gpt-image models stay non-reasoning", () => {
    const [model] = normalizeCatalog([{ id: "gpt-image-2", owned_by: "openai" }], testConfig()).models;
    expect(model.isCodex).toBe(true);
    expect(model.reasoning).toBe(false);
    expect(model.thinking).toBeUndefined();
  });

  test("an exact-id effort override opts a model into reasoning", () => {
    const config = testConfig({ effortOverrides: { "deepseek-v3.2": ["low", "high"] } });
    const [model] = normalizeCatalog([SPARSE_ENTRY], config).models;
    expect(model.reasoning).toBe(true);
    expect(model.thinking?.efforts).toEqual(["low", "high"]);
  });

  test("wildcard effort overrides do not invent reasoning", () => {
    const config = testConfig({ effortOverrides: { "*": ["low"] } });
    const [model] = normalizeCatalog([SPARSE_ENTRY], config).models;
    expect(model.reasoning).toBe(false);
  });

  test("reads gemini-family token limit fields", () => {
    const gemini = {
      id: "gemini-2.5-pro",
      type: "gemini",
      display_name: "Gemini 2.5 Pro",
      inputTokenLimit: 1048576,
      outputTokenLimit: 65536,
      thinking: { min: 128, max: 32768, dynamic_allowed: true },
      supportedInputModalities: ["text", "image", "audio", "video"],
    };
    const [model] = normalizeCatalog([gemini], testConfig()).models;
    expect(model.contextWindow).toBe(1048576);
    expect(model.maxTokens).toBe(65536);
    expect(model.reasoning).toBe(true);
    // Host input types are limited to text and image; audio/video drop.
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
    expect(provider.name).toBe("cpa");
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
    expect(codex?.preferWebsockets).toBe(false);
    expect(String(codex?.baseUrl)).toContain("?cliproxyapi-codex=");
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
    expect(url.search).toBe("?cliproxyapi-codex=");
  });

  test("sends the Anthropic-Version header during discovery", async () => {
    const host = new FakeHost();
    const seen: { headers?: Headers } = {};
    const environment = isolatedEnv({ CLIPROXYAPI_API_KEY: "abc" });
    await activateOmp(host, environment, async (_input, init) => {
      seen.headers = new Headers(init?.headers);
      return makeModelsResponse([SPARSE_ENTRY]);
    });
    expect(seen.headers?.get("anthropic-version")).toBe("2023-06-01");
    expect(seen.headers?.get("authorization")).toBe("Bearer abc");
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
    const provisional: FakeContextModel = { provider: "cpa", id: "kimi-k3-256k" };
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
      provider: "cpa",
      id: "gpt-5.3-codex",
      baseUrl: "http://or.sorcery.link:20128/v1/responses?omniroute-codex=",
    };
    await host.emit("session_start", fakeContext(provisional));
    expect(String(provisional.baseUrl)).toContain("?cliproxyapi-codex=");
    expect(provisional.api).toBe("openai-codex-responses");
    expect(host.setModelCalls).toHaveLength(1);
  });

  test("rebind drops a foreign baseUrl when the built model has none", async () => {
    const host = new FakeHost();
    const environment = isolatedEnv({ CLIPROXYAPI_API_KEY: "abc" });
    await activateOmp(host, environment, async () => makeModelsResponse([KIMI_ENTRY]));
    const provisional: FakeContextModel = {
      provider: "cpa",
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

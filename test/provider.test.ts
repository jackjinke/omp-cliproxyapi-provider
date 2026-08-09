import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { FetchImpl, Model } from "@oh-my-pi/pi-ai";
import { createProvider } from "../src/index.ts";
import { loadModelsDevMetadata, modelsDevCachePath } from "../src/models-dev.ts";
import {
  CONFIG_FILE_NAME,
  fetchModels,
  mapCatalogModel,
  PROVIDER_ID,
  readConfig,
  resolveEndpoints,
  resolveSettings,
} from "../src/provider.ts";

const MODELS_DEV_URL = "https://models.dev/api.json";
const CPA_ROOT = "http://llm.example:8317";
const RAW_MODELS_URL = `${CPA_ROOT}/v1/models`;
const RICH_MODELS_URL = `${RAW_MODELS_URL}?client_version=pi`;

const MODELS_DEV_FIXTURE = {
  "opencode-go": {
    id: "opencode-go",
    name: "OpenCode Go",
    api: "https://opencode.ai/zen/go/v1",
    models: {
      "deepseek-v4-flash": {
        id: "deepseek-v4-flash",
        name: "DeepSeek V4 Flash (2x usage)",
        reasoning: true,
        reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }],
        modalities: { input: ["text"], output: ["text"] },
        limit: { context: 1_000_000, output: 384_000 },
        cost: { input: 0.07, output: 0.14, cache_read: 0.0014 },
      },
    },
  },
};

interface RecordedRequest {
  url: string;
  authorization: string | null;
}

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporaryAgentDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "omp-cliproxyapi-provider-"));
  temporaryDirectories.push(directory);
  return directory;
}

function cacheFile(agentDir: string): string {
  return modelsDevCachePath(agentDir);
}

function routeFetcher(routes: Record<string, unknown>, requests: RecordedRequest[] = []): FetchImpl {
  return async (input, init) => {
    const url = String(input);
    requests.push({ url, authorization: new Headers(init?.headers).get("Authorization") });
    const route = routes[url];
    if (route instanceof Response) return route.clone();
    if (route === undefined) return new Response("missing test route", { status: 404 });
    return Response.json(route);
  };
}

describe("endpoint resolution", () => {
  test("normalizes supported base URL forms", () => {
    expect(resolveEndpoints("llm.example:8317")).toEqual({
      inferenceBaseUrl: "http://llm.example:8317/backend-api/",
      rawModelsUrl: "http://llm.example:8317/v1/models",
      richModelsUrl: "http://llm.example:8317/v1/models?client_version=pi",
    });
    expect(resolveEndpoints("https://llm.example/prefix/v1")).toEqual({
      inferenceBaseUrl: "https://llm.example/prefix/backend-api/",
      rawModelsUrl: "https://llm.example/prefix/v1/models",
      richModelsUrl: "https://llm.example/prefix/v1/models?client_version=pi",
    });
    expect(resolveEndpoints("https://llm.example/backend-api/")).toEqual({
      inferenceBaseUrl: "https://llm.example/backend-api/",
      rawModelsUrl: "https://llm.example/v1/models",
      richModelsUrl: "https://llm.example/v1/models?client_version=pi",
    });
  });
});

describe("configuration", () => {
  test("resolves environment over the existing config file", () => {
    const agentDir = temporaryAgentDir();
    writeFileSync(join(agentDir, CONFIG_FILE_NAME), JSON.stringify({ baseUrl: "http://file:8317", apiKey: "file-key" }));

    expect(resolveSettings({
      PI_CODING_AGENT_DIR: agentDir,
      CLIPROXYAPI_BASE_URL: "http://env:8317",
      CLIPROXYAPI_API_KEY: "env-key",
    })).toEqual({ agentDir, baseUrl: "http://env:8317", apiKey: "env-key" });
  });

  test("places the full catalog under the OMP agent tmp directory", () => {
    expect(modelsDevCachePath("/home/test/.omp/agent")).toBe("/home/test/.omp/agent/tmp/models.dev.json");
  });

  test("rejects malformed config fields", () => {
    const agentDir = temporaryAgentDir();
    writeFileSync(join(agentDir, CONFIG_FILE_NAME), JSON.stringify({ baseUrl: 8317 }));
    expect(() => readConfig(agentDir)).toThrow('field "baseUrl" must be a non-empty string');
  });
});

describe("metadata enrichment", () => {
  test("maps available catalog fields without external enrichment", () => {
    const model = mapCatalogModel({
      slug: "gpt-5.6-sol",
      display_name: "GPT 5.6 Sol",
      context_window: 200_000,
      input_modalities: ["text", "image"],
      supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }, { effort: "ultra" }],
    });

    expect(model).not.toBeNull();
    expect(model?.id).toBe("gpt-5.6-sol");
    expect(model?.thinking?.mode).toBe("effort");
    expect(Array.from(model?.thinking?.efforts ?? [], String)).toEqual(["low", "high"]);
    expect(model?.input).toEqual(["text", "image"]);
    expect(model?.contextWindow).toBe(200_000);
    expect(model?.maxTokens).toBe(16_384);
  });

  test("matches owned_by and strips the CPA routing prefix", async () => {
    const agentDir = temporaryAgentDir();
    const requests: RecordedRequest[] = [];
    const fetcher = routeFetcher({
      [RAW_MODELS_URL]: { data: [{ id: "ocgo/deepseek-v4-flash", owned_by: "OpenCode Go" }] },
      [MODELS_DEV_URL]: MODELS_DEV_FIXTURE,
    }, requests);

    const [model] = await fetchModels(CPA_ROOT, "secret", fetcher, cacheFile(agentDir));
    expect(model?.id).toBe("ocgo/deepseek-v4-flash");
    expect(model?.name).toBe("DeepSeek V4 Flash (2x usage)");
    expect(model?.reasoning).toBeTrue();
    expect(model?.thinking?.mode).toBe("effort");
    expect(Array.from(model?.thinking?.efforts ?? [], String)).toEqual(["low", "high", "max"]);
    expect(model?.input).toEqual(["text"]);
    expect(model?.cost).toEqual({ input: 0.07, output: 0.14, cacheRead: 0.0014, cacheWrite: 0 });
    expect(model?.contextWindow).toBe(1_000_000);
    expect(model?.maxTokens).toBe(384_000);
    expect(requests.filter(request => request.url.startsWith(CPA_ROOT)).every(
      request => request.authorization === "Bearer secret",
    )).toBeTrue();
    expect(requests.find(request => request.url === MODELS_DEV_URL)?.authorization).toBeNull();
  });

  test("uses bundled Codex metadata for OpenAI-owned catalog models", async () => {
    const agentDir = temporaryAgentDir();
    const fetcher = routeFetcher({
      [RAW_MODELS_URL]: { data: [{ id: "gpt-5.6-sol", owned_by: "OpenAI" }] },
      [MODELS_DEV_URL]: {
        openai: {
          id: "openai",
          name: "OpenAI",
          models: {
            "gpt-5.6-sol": {
              id: "gpt-5.6-sol",
              name: "Wrong models.dev metadata",
              limit: { context: 1_050_000, output: 1_050_000 },
            },
          },
        },
      },
    });

    const [model] = await fetchModels(CPA_ROOT, "secret", fetcher, cacheFile(agentDir));
    expect(model).toMatchObject({
      id: "gpt-5.6-sol",
      name: "GPT-5.6 Sol",
      contextWindow: 372_000,
      maxTokens: 128_000,
      input: ["text", "image"],
    });
    expect(Array.from(model?.thinking?.efforts ?? [], String)).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  test("does not classify non-OpenAI owners as Codex", async () => {
    const agentDir = temporaryAgentDir();
    const fetcher = routeFetcher({
      [RAW_MODELS_URL]: { data: [{ id: "gpt-5.6-sol", owned_by: "Gateway" }] },
      [MODELS_DEV_URL]: {
        gateway: {
          id: "gateway",
          name: "Gateway",
          models: { "gpt-5.6-sol": { id: "gpt-5.6-sol", limit: { context: 900_000, output: 90_000 } } },
        },
      },
    });

    const [model] = await fetchModels(CPA_ROOT, "secret", fetcher, cacheFile(agentDir));
    expect(model?.contextWindow).toBe(900_000);
    expect(model?.maxTokens).toBe(90_000);
  });

  test("applies owned_by matching generically", async () => {
    const agentDir = temporaryAgentDir();
    const fetcher = routeFetcher({
      [RAW_MODELS_URL]: { data: [{ id: "gpt-test", owned_by: "OpenAI" }] },
      [MODELS_DEV_URL]: {
        openai: {
          id: "openai",
          name: "OpenAI",
          models: { "gpt-test": { id: "gpt-test", limit: { context: 900_000, output: 90_000 } } },
        },
      },
    });

    const [model] = await fetchModels(CPA_ROOT, "secret", fetcher, cacheFile(agentDir));
    expect(model?.contextWindow).toBe(900_000);
    expect(model?.maxTokens).toBe(90_000);
  });

  test("uses rich CPA metadata when a native owner has no models.dev match", async () => {
    const agentDir = temporaryAgentDir();
    const requests: RecordedRequest[] = [];
    const fetcher = routeFetcher({
      [RAW_MODELS_URL]: {
        data: [
          { id: "kimi-k3", owned_by: "moonshot" },
          { id: "kimi-k3-256k", owned_by: "moonshot" },
        ],
      },
      [RICH_MODELS_URL]: {
        models: [
          {
            slug: "kimi-k3",
            display_name: "Kimi K3",
            context_window: 1_048_576,
            input_modalities: ["text", "image"],
            supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }, { effort: "max" }],
          },
          {
            slug: "kimi-k3-256k",
            display_name: "Kimi K3 256K",
            context_window: 262_144,
            input_modalities: ["text", "image"],
            supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }, { effort: "max" }],
          },
        ],
      },
      [MODELS_DEV_URL]: {},
    }, requests);

    const models = await fetchModels(CPA_ROOT, "secret", fetcher, cacheFile(agentDir));
    expect(models).toMatchObject([
      {
        id: "kimi-k3",
        name: "Kimi K3",
        contextWindow: 1_048_576,
        maxTokens: 128_000,
        reasoning: true,
        input: ["text", "image"],
      },
      {
        id: "kimi-k3-256k",
        name: "Kimi K3 256K",
        contextWindow: 262_144,
        maxTokens: 128_000,
        reasoning: true,
        input: ["text", "image"],
      },
    ]);
    expect(Array.from(models[0]?.thinking?.efforts ?? [], String)).toEqual(["low", "high", "max"]);
    expect(requests.filter(request => request.url === RAW_MODELS_URL || request.url === RICH_MODELS_URL))
      .toHaveLength(2);
  });

  test("prefers models.dev over rich metadata for exact owner matches", async () => {
    const agentDir = temporaryAgentDir();
    const fetcher = routeFetcher({
      [RAW_MODELS_URL]: { data: [{ id: "grok-4.5", owned_by: "xai" }] },
      [RICH_MODELS_URL]: {
        models: [{
          slug: "grok-4.5",
          display_name: "Wrong rich metadata",
          context_window: 272_000,
          supported_reasoning_levels: [{ effort: "medium" }],
        }],
      },
      [MODELS_DEV_URL]: {
        "x-ai": {
          id: "x-ai",
          name: "xAI",
          models: {
            "grok-4.5": {
              id: "grok-4.5",
              name: "Grok 4.5",
              reasoning: true,
              reasoning_options: [{ type: "effort", values: ["low", "medium", "high"] }],
              modalities: { input: ["text", "image"], output: ["text"] },
              limit: { context: 500_000, output: 500_000 },
            },
          },
        },
      },
    });

    const [model] = await fetchModels(CPA_ROOT, "secret", fetcher, cacheFile(agentDir));
    expect(model).toMatchObject({
      name: "Grok 4.5",
      contextWindow: 500_000,
      maxTokens: 500_000,
      input: ["text", "image"],
    });
  });

  test("ignores rich metadata for unknown compatibility owners", async () => {
    const agentDir = temporaryAgentDir();
    const fetcher = routeFetcher({
      [RAW_MODELS_URL]: { data: [{ id: "unknown", owned_by: "Gateway" }] },
      [RICH_MODELS_URL]: {
        models: [{
          slug: "unknown",
          display_name: "Synthesized metadata",
          context_window: 272_000,
          supported_reasoning_levels: [{ effort: "medium" }],
        }],
      },
      [MODELS_DEV_URL]: {},
    });

    const [model] = await fetchModels(CPA_ROOT, "secret", fetcher, cacheFile(agentDir));
    expect(model).toMatchObject({
      name: "unknown",
      contextWindow: 128_000,
      maxTokens: 16_384,
      reasoning: false,
    });
  });

  test("replaces an invalid cache and reuses the fresh catalog", async () => {
    const agentDir = temporaryAgentDir();
    const path = cacheFile(agentDir);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{}");
    let requests = 0;
    const fetcher: FetchImpl = async () => {
      requests += 1;
      return Response.json(MODELS_DEV_FIXTURE);
    };

    const identities = [{ id: "ocgo/deepseek-v4-flash", owner: "OpenCode Go" }];
    const first = await loadModelsDevMetadata(identities, path, fetcher);
    const second = await loadModelsDevMetadata(identities, path, fetcher);

    expect(first.get(identities[0].id)?.contextWindow).toBe(1_000_000);
    expect(second.get(identities[0].id)?.contextWindow).toBe(1_000_000);
    expect(requests).toBe(1);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(MODELS_DEV_FIXTURE);
  });

  test("uses conservative defaults when models.dev is unavailable", async () => {
    const agentDir = temporaryAgentDir();
    const fetcher = routeFetcher({
      [RAW_MODELS_URL]: { data: [{ id: "unknown", owned_by: "Unknown" }] },
      [MODELS_DEV_URL]: new Response("offline", { status: 503 }),
    });

    const [model] = await fetchModels(CPA_ROOT, "secret", fetcher, cacheFile(agentDir));
    expect(model?.contextWindow).toBe(128_000);
    expect(model?.maxTokens).toBe(16_384);
  });

  test("skips hidden and unusable catalog entries", () => {
    expect(mapCatalogModel({ slug: "hidden", visibility: "hide" })).toBeNull();
    expect(mapCatalogModel({ display_name: "Missing id" })).toBeNull();
  });

  test("surfaces non-successful CPA catalog responses", async () => {
    const agentDir = temporaryAgentDir();
    const fetcher = routeFetcher({
      [RAW_MODELS_URL]: new Response("denied", { status: 401 }),
    });
    await expect(fetchModels(CPA_ROOT, "bad", fetcher, cacheFile(agentDir))).rejects.toThrow("HTTP 401: denied");
  });
});

describe("native OMP provider", () => {
  test("uses built-in Codex transport and OMP dynamic discovery", async () => {
    const agentDir = temporaryAgentDir();
    const fetcher = routeFetcher({
      [RAW_MODELS_URL]: { data: [{ id: "gpt-test", owned_by: "test" }] },
      [MODELS_DEV_URL]: {},
    });
    const provider = createProvider(
      { agentDir, baseUrl: CPA_ROOT, apiKey: "config-key" },
      fetcher,
      cacheFile(agentDir),
    );

    expect(provider.api).toBe("openai-codex-responses");
    expect(provider.baseUrl).toBe("http://llm.example:8317/backend-api/");
    expect(provider.apiKey).toBe("config-key");
    const discovered = await provider.fetchDynamicModels?.("config-key");
    expect(discovered?.map(model => model.id)).toEqual(["gpt-test"]);
  });

  test("login validates, persists, and updates the active endpoint", async () => {
    const agentDir = temporaryAgentDir();
    const oldRaw = "http://old.example:8317/v1/models";
    const newRaw = "http://new.example:8317/v1/models";
    const requests: RecordedRequest[] = [];
    const fetcher = routeFetcher({
      [oldRaw]: { data: [] },
      [newRaw]: { data: [] },
      [MODELS_DEV_URL]: {},
    }, requests);
    const provider = createProvider(
      { agentDir, baseUrl: "http://old.example:8317" },
      fetcher,
      cacheFile(agentDir),
    );
    const prompts = ["http://new.example:8317", "new-key"];
    const oauth = provider.oauth;
    if (!oauth) throw new Error("OAuth provider was not registered");

    const login = await oauth.login({
      onAuth() {},
      onPrompt: async () => prompts.shift() ?? "",
    });
    if (typeof login === "string") throw new Error("Expected OAuth credentials");

    expect(login.access).toBe("new-key");
    expect(JSON.parse(login.refresh)).toEqual({ baseUrl: "http://new.example:8317" });
    expect(readConfig(agentDir)).toMatchObject({ baseUrl: "http://new.example:8317", apiKey: "new-key" });
    expect(statSync(join(agentDir, CONFIG_FILE_NAME)).mode & 0o777).toBe(0o600);

    await provider.fetchDynamicModels?.("new-key");
    expect(requests.filter(request => request.url === newRaw)).toHaveLength(2);

    const fakeModels: Model[] = [
      { provider: PROVIDER_ID, id: "gpt-test", baseUrl: "http://old/backend-api/" },
      { provider: "other", id: "other", baseUrl: "http://other/v1" },
    ] as Model[];
    const modified = oauth.modifyModels?.(fakeModels, login);
    expect(modified?.[0]?.baseUrl).toBe("http://new.example:8317/backend-api/");
    expect(modified?.[1]?.baseUrl).toBe("http://other/v1");
  });

  test("does not fetch models before credentials exist", async () => {
    const agentDir = temporaryAgentDir();
    const provider = createProvider({ agentDir, baseUrl: CPA_ROOT }, async () => {
      throw new Error("unexpected fetch");
    }, cacheFile(agentDir));
    expect(await provider.fetchDynamicModels?.(undefined)).toEqual([]);
  });
});

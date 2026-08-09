import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FetchImpl, Model } from "@oh-my-pi/pi-ai";
import { createProvider } from "../src/index.ts";
import { loadModelsDevMetadata } from "../src/models-dev.ts";
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
const CODEX_MODELS_URL = `${RAW_MODELS_URL}?client_version=pi`;

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
  return join(agentDir, "models-dev.json");
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
      codexModelsUrl: "http://llm.example:8317/v1/models?client_version=pi",
    });
    expect(resolveEndpoints("https://llm.example/prefix/v1")).toEqual({
      inferenceBaseUrl: "https://llm.example/prefix/backend-api/",
      rawModelsUrl: "https://llm.example/prefix/v1/models",
      codexModelsUrl: "https://llm.example/prefix/v1/models?client_version=pi",
    });
    expect(resolveEndpoints("https://llm.example/backend-api/")).toEqual({
      inferenceBaseUrl: "https://llm.example/backend-api/",
      rawModelsUrl: "https://llm.example/v1/models",
      codexModelsUrl: "https://llm.example/v1/models?client_version=pi",
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

  test("rejects malformed config fields", () => {
    const agentDir = temporaryAgentDir();
    writeFileSync(join(agentDir, CONFIG_FILE_NAME), JSON.stringify({ baseUrl: 8317 }));
    expect(() => readConfig(agentDir)).toThrow('field "baseUrl" must be a non-empty string');
  });
});

describe("metadata enrichment", () => {
  test("maps CPA rich metadata without external enrichment", () => {
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
      [CODEX_MODELS_URL]: {
        models: [{
          slug: "ocgo/deepseek-v4-flash",
          display_name: "deepseek-v4-flash",
          context_window: 272_000,
          input_modalities: ["text", "image"],
          supported_reasoning_levels: ["low", "medium", "high"],
        }],
      },
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

  test("applies owned_by matching generically", async () => {
    const agentDir = temporaryAgentDir();
    const fetcher = routeFetcher({
      [RAW_MODELS_URL]: { data: [{ id: "gpt-test", owned_by: "OpenAI" }] },
      [CODEX_MODELS_URL]: { models: [{ slug: "gpt-test", context_window: 200_000 }] },
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

  test("replaces an invalid cache and reuses the fresh catalog", async () => {
    const agentDir = temporaryAgentDir();
    const path = cacheFile(agentDir);
    writeFileSync(path, "{}");
    let requests = 0;
    const fetcher: FetchImpl = async () => {
      requests += 1;
      return Response.json(MODELS_DEV_FIXTURE);
    };

    const identities = [{ id: "ocgo/deepseek-v4-flash", owner: "OpenCode Go" }];
    const first = await loadModelsDevMetadata(identities, fetcher, path);
    const second = await loadModelsDevMetadata(identities, fetcher, path);

    expect(first.get(identities[0].id)?.contextWindow).toBe(1_000_000);
    expect(second.get(identities[0].id)?.contextWindow).toBe(1_000_000);
    expect(requests).toBe(1);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(MODELS_DEV_FIXTURE);
  });

  test("falls back to CPA rich metadata when models.dev is unavailable", async () => {
    const agentDir = temporaryAgentDir();
    const fetcher = routeFetcher({
      [RAW_MODELS_URL]: { data: [{ id: "unknown", owned_by: "Unknown" }] },
      [CODEX_MODELS_URL]: { models: [{ slug: "unknown", context_window: 300_000 }] },
      [MODELS_DEV_URL]: new Response("offline", { status: 503 }),
    });

    const [model] = await fetchModels(CPA_ROOT, "secret", fetcher, cacheFile(agentDir));
    expect(model?.contextWindow).toBe(300_000);
  });

  test("skips hidden and unusable catalog entries", () => {
    expect(mapCatalogModel({ slug: "hidden", visibility: "hide" })).toBeNull();
    expect(mapCatalogModel({ display_name: "Missing id" })).toBeNull();
  });

  test("surfaces non-successful CPA catalog responses", async () => {
    const agentDir = temporaryAgentDir();
    const fetcher = routeFetcher({
      [RAW_MODELS_URL]: new Response("denied", { status: 401 }),
      [CODEX_MODELS_URL]: { models: [] },
    });
    await expect(fetchModels(CPA_ROOT, "bad", fetcher, cacheFile(agentDir))).rejects.toThrow("HTTP 401: denied");
  });
});

describe("native OMP provider", () => {
  test("uses built-in Codex transport and OMP dynamic discovery", async () => {
    const agentDir = temporaryAgentDir();
    const fetcher = routeFetcher({
      [RAW_MODELS_URL]: { data: [{ id: "gpt-test", owned_by: "test" }] },
      [CODEX_MODELS_URL]: { models: [{ slug: "gpt-test" }] },
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
    const oldCodex = `${oldRaw}?client_version=pi`;
    const newRaw = "http://new.example:8317/v1/models";
    const newCodex = `${newRaw}?client_version=pi`;
    const requests: RecordedRequest[] = [];
    const fetcher = routeFetcher({
      [oldRaw]: { data: [] },
      [oldCodex]: { models: [] },
      [newRaw]: { data: [] },
      [newCodex]: { models: [] },
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
    expect(requests.filter(request => request.url === newCodex)).toHaveLength(2);

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

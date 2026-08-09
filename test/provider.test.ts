import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@oh-my-pi/pi-ai";
import { createProvider } from "../src/index.ts";
import {
  CONFIG_FILE_NAME,
  fetchModels,
  mapCatalogModel,
  PROVIDER_ID,
  readConfig,
  resolveEndpoints,
  resolveSettings,
} from "../src/provider.ts";

function temporaryAgentDir(): string {
  return mkdtempSync(join(tmpdir(), "omp-cliproxyapi-provider-"));
}

describe("endpoint resolution", () => {
  test("normalizes supported base URL forms", () => {
    expect(resolveEndpoints("llm.example:8317")).toEqual({
      inferenceBaseUrl: "http://llm.example:8317/backend-api/",
      modelsUrl: "http://llm.example:8317/v1/models?client_version=pi",
    });
    expect(resolveEndpoints("https://llm.example/prefix/v1")).toEqual({
      inferenceBaseUrl: "https://llm.example/prefix/backend-api/",
      modelsUrl: "https://llm.example/prefix/v1/models?client_version=pi",
    });
    expect(resolveEndpoints("https://llm.example/backend-api/")).toEqual({
      inferenceBaseUrl: "https://llm.example/backend-api/",
      modelsUrl: "https://llm.example/v1/models?client_version=pi",
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

describe("catalog mapping", () => {
  test("maps OMP-native thinking and input metadata", () => {
    const model = mapCatalogModel({
      slug: "gpt-5.6-sol",
      display_name: "GPT 5.6 Sol",
      context_window: 200_000,
      input_modalities: ["text", "image"],
      supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }, { effort: "ultra" }],
    });

    expect(model).not.toBeNull();
    expect(model?.id).toBe("gpt-5.6-sol");
    expect(model?.name).toBe("GPT 5.6 Sol");
    expect(model?.reasoning).toBeTrue();
    expect(model?.thinking?.mode).toBe("effort");
    expect(Array.from(model?.thinking?.efforts ?? [], String)).toEqual(["low", "high"]);
    expect(model?.input).toEqual(["text", "image"]);
    expect(model?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    expect(model?.contextWindow).toBe(200_000);
    expect(model?.maxTokens).toBe(16_384);
  });

  test("skips hidden and unusable catalog entries", () => {
    expect(mapCatalogModel({ slug: "hidden", visibility: "hide" })).toBeNull();
    expect(mapCatalogModel({ display_name: "Missing id" })).toBeNull();
  });

  test("requests the rich CPA catalog with bearer authentication", async () => {
    let requestUrl = "";
    let requestAuthorization = "";
    const models = await fetchModels("http://llm.example:8317", "secret", async (input, init) => {
      requestUrl = String(input);
      requestAuthorization = new Headers(init?.headers).get("Authorization") ?? "";
      return Response.json({ models: [{ slug: "gpt-test", supported_reasoning_levels: ["medium"] }] });
    });

    expect(requestUrl).toBe("http://llm.example:8317/v1/models?client_version=pi");
    expect(requestAuthorization).toBe("Bearer secret");
    expect(models.map(model => model.id)).toEqual(["gpt-test"]);
  });

  test("surfaces non-successful catalog responses", async () => {
    await expect(fetchModels("http://llm.example:8317", "bad", async () => new Response("denied", { status: 401 })))
      .rejects.toThrow("HTTP 401: denied");
  });
});

describe("native OMP provider", () => {
  test("uses built-in Codex transport and OMP dynamic discovery", async () => {
    const agentDir = temporaryAgentDir();
    let requests = 0;
    const provider = createProvider(
      { agentDir, baseUrl: "http://llm.example:8317", apiKey: "config-key" },
      async () => {
        requests += 1;
        return Response.json({ models: [{ slug: "gpt-test" }] });
      },
    );

    expect(provider.api).toBe("openai-codex-responses");
    expect(provider.baseUrl).toBe("http://llm.example:8317/backend-api/");
    expect(provider.apiKey).toBe("config-key");
    const discovered = await provider.fetchDynamicModels?.("config-key");
    expect(discovered?.map(model => model.id)).toEqual(["gpt-test"]);
    expect(requests).toBe(1);
  });

  test("login validates, persists, and updates the active endpoint", async () => {
    const agentDir = temporaryAgentDir();
    const requestedUrls: string[] = [];
    const provider = createProvider(
      { agentDir, baseUrl: "http://old.example:8317" },
      async input => {
        requestedUrls.push(String(input));
        return Response.json({ models: [] });
      },
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
    expect(requestedUrls).toEqual([
      "http://new.example:8317/v1/models?client_version=pi",
      "http://new.example:8317/v1/models?client_version=pi",
    ]);

    const fakeModels: Model[] = [
      { provider: PROVIDER_ID, id: "gpt-test", baseUrl: "http://old/backend-api/" },
      { provider: "other", id: "other", baseUrl: "http://other/v1" },
    ] as Model[];
    const modified = oauth.modifyModels?.(fakeModels, login);
    expect(modified?.[0]?.baseUrl).toBe("http://new.example:8317/backend-api/");
    expect(modified?.[1]?.baseUrl).toBe("http://other/v1");
  });

  test("does not fetch models before credentials exist", async () => {
    const provider = createProvider({ agentDir: temporaryAgentDir(), baseUrl: "http://llm.example:8317" }, async () => {
      throw new Error("unexpected fetch");
    });
    expect(await provider.fetchDynamicModels?.(undefined)).toEqual([]);
  });
});

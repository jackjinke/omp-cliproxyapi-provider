import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@oh-my-pi/pi-ai";
import { catalogCachePath, readCatalogCache } from "../src/discovery-cache.ts";
import { activateOmp, type OmpExtensionAPI, type OmpProviderConfig, type ThinkingLevel } from "../src/omp.ts";
import { cliproxyapiConfigPath, readConfig } from "../src/shared.ts";

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function environment() {
  const dir = mkdtempSync(join(tmpdir(), "cpa-adapter-"));
  directories.push(dir);
  return { PI_CODING_AGENT_DIR: dir, CLIPROXYAPI_API_KEY: "private-key", CLIPROXYAPI_BASE_URL: "http://localhost:8317" };
}
function host() {
  let provider: OmpProviderConfig | undefined;
  let command: Parameters<NonNullable<OmpExtensionAPI["registerCommand"]>>[1] | undefined;
  let level: ThinkingLevel | undefined = "high";
  const restored: unknown[] = [];
  const handlers = new Map<string, (event: unknown, context: unknown) => unknown>();
  const api: OmpExtensionAPI = {
    registerProvider(_name, config) { provider = config; },
    getThinkingLevel: () => level,
    setThinkingLevel(value) { restored.push(value); level = value; },
    async setModel() { level = "medium"; return true; },
    on(event, handler) { handlers.set(event, handler); },
    registerCommand(_name, options) { command = options; },
  };
  return { api, restored, get provider() { return provider!; }, set level(value: typeof level) { level = value; }, get level() { return level; },
    async hydrate(model: unknown) { await handlers.get("before_agent_start")?.({}, { model }); },
    async refresh() {
      const notices: Array<{ message: string; type?: string }> = [];
      await command!.handler("", { ui: { notify(message, type) { notices.push({ message, type }); } } });
      return notices;
    },
  };
}
function catalog(contextWindow = 200000, reasoning = true) {
  return new Response(JSON.stringify({ models: [{ slug: "gpt-6-astra", display_name: "Astra", context_window: contextWindow, max_tokens: 10000, supported_reasoning_levels: reasoning ? [{ effort: "high" }] : [], default_reasoning_level: reasoning ? "high" : undefined }] }));
}
function fetchCatalog(contextWindow = 200000) {
  return async (input: string | URL | Request) => String(input).includes("models.dev") ? new Response("{}") : catalog(contextWindow);
}

test("catalog cache is scoped to endpoint, key, native route and model overrides without secrets", async () => {
  const env = environment();
  await activateOmp(host().api, env, fetchCatalog());
  const configPath = cliproxyapiConfigPath(env);
  const config = readConfig(env, configPath);
  const path = catalogCachePath(config, configPath);
  expect(path.startsWith(join(env.PI_CODING_AGENT_DIR, "cache", "cliproxyapi") + "/")).toBe(true);
  expect(readCatalogCache(path)?.[0]?.id).toBe("gpt-6-astra");
  expect(readFileSync(path, "utf8")).not.toContain(env.CLIPROXYAPI_API_KEY);
  for (const changed of [{ ...config, apiKey: "other" }, { ...config, baseUrl: "http://other" }, { ...config, codexBaseUrl: "http://localhost:8317/backend-api" }, { ...config, modelOverrides: { "gpt-6-astra": { contextWindow: 9000 } } }]) {
    expect(readCatalogCache(catalogCachePath(changed, configPath))).toBeUndefined();
  }
});

test("corrupt and injected transport catalog entries are rejected", async () => {
  const env = environment();
  await activateOmp(host().api, env, fetchCatalog());
  const path = catalogCachePath(readConfig(env), cliproxyapiConfigPath(env));
  const original = JSON.parse(readFileSync(path, "utf8"));
  for (const malformed of ["{", JSON.stringify({ ...original, models: [{ ...original.models[0], baseUrl: "https://foreign" }] }), JSON.stringify({ ...original, models: [{ ...original.models[0], contextWindow: "bad" }] })]) {
    writeFileSync(path, malformed);
    expect(readCatalogCache(path)).toBeUndefined();
  }
});

test("cached startup does not await refresh; outages retain the last catalog and report failure", async () => {
  const env = environment();
  await activateOmp(host().api, env, fetchCatalog());
  const path = catalogCachePath(readConfig(env), cliproxyapiConfigPath(env));
  const before = readFileSync(path, "utf8");
  const pending = Promise.withResolvers<Response>();
  let calls = 0;
  const next = host();
  await activateOmp(next.api, env, async () => { calls++; return pending.promise; });
  expect(next.provider.models[0]?.contextWindow).toBe(200000);
  const notice = next.refresh();
  expect(calls).toBe(1);
  pending.reject(new Error("offline"));
  expect((await notice)[0]?.type).toBe("error");
  expect(next.provider.models[0]?.contextWindow).toBe(200000);
  expect(readFileSync(path, "utf8")).toBe(before);
});

test("refresh updates hydration for an already stamped model without changing effort", async () => {
  const env = environment();
  const next = host();
  let contextWindow = 200000;
  await activateOmp(next.api, env, async input => String(input).includes("models.dev") ? new Response("{}") : catalog(contextWindow));
  const model = { provider: "cliproxyapi", id: "gpt-6-astra" } as Model;
  await next.hydrate(model);
  expect(model.contextWindow).toBe(200000);
  contextWindow = 300000;
  expect((await next.refresh())[0]?.type).toBe("info");
  expect(next.level).toBe("high");
  await next.hydrate(model);
  expect(model.contextWindow).toBe(300000);
  expect(model.useResponsesLite).toBe(false);
  expect(model.baseUrl).toBe("http://localhost:8317/v1/responses?via=");
  expect(next.level).toBe("high");
});

test("undefined initial effort is never passed to the host setter", async () => {
  const next = host();
  next.level = undefined;
  await activateOmp(next.api, environment(), fetchCatalog());
  await next.hydrate({ provider: "cliproxyapi", id: "gpt-6-astra" });
  expect(next.restored).toEqual([]);
  expect(next.api.getThinkingLevel()).toBe("medium");
});

test("explicit native Codex endpoint bypasses the compatibility query route", async () => {
  const env = { ...environment(), CLIPROXYAPI_BASE_URL: "http://localhost:8317/team/backend-api/codex/responses" };
  const next = host();
  await activateOmp(next.api, env, fetchCatalog());
  const model = { provider: "cliproxyapi", id: "gpt-6-astra" } as Model;
  await next.hydrate(model);
  expect(model.baseUrl).toBe("http://localhost:8317/team/backend-api");
  expect(model.remoteCompaction?.v2Endpoint).toBe("http://localhost:8317/team/backend-api/codex/responses");
});

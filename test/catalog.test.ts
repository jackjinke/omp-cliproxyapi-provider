import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverModels, extractCPAModel, normalizeCatalog, readConfig, type CPAConfig } from "../src/shared.ts";

const config: CPAConfig = { apiKey: "test", baseUrl: "http://localhost:8317", startupTimeoutMs: 1000, modelOverrides: {} };
const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function withConfig<T>(run: (path: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "cpa-catalog-"));
  try { return run(join(dir, "cliproxyapi.yml")); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

describe("catalog normalization", () => {
  test("classifies only final basenames while preserving request IDs and hiding unavailable entries", () => {
    const catalog = normalizeCatalog([
      { slug: "team/claude-sonnet-4" },
      { slug: "team/codex-mini" },
      { slug: "team/gpt-image-1", supported_reasoning_levels: [{ effort: "high" }] },
      { slug: "team/gpt-parent/other" },
      { slug: "hidden", visibility: "hide" },
    ], config);
    expect(catalog.models.map(model => [model.id, model.isClaude, model.isCodex, model.reasoning])).toEqual([
      ["team/claude-sonnet-4", true, false, false],
      ["team/codex-mini", false, true, true],
      ["team/gpt-image-1", false, true, false],
      ["team/gpt-parent/other", false, false, false],
    ]);
  });

  test("uses valid output caps in existing-first order", () => {
    expect(extractCPAModel({ slug: "model", max_tokens: 10, max_output_tokens: 20, max_completion_tokens: 30 }, config)?.maxTokens).toBe(10);
    expect(extractCPAModel({ slug: "model", max_tokens: -1, max_output_tokens: 20, max_completion_tokens: 30 }, config)?.maxTokens).toBe(20);
    expect(extractCPAModel({ slug: "model", max_output_tokens: "invalid", max_completion_tokens: 30 }, config)?.maxTokens).toBe(30);
  });

  test("normalizes endpoint forms without changing root-only routing", () => withConfig(path => {
    for (const input of ["proxy.example:8317/prefix/v1/", "http://proxy.example:8317/prefix/"]) {
      const result = readConfig({ CLIPROXYAPI_API_KEY: "test", CLIPROXYAPI_BASE_URL: input }, path);
      expect(result.baseUrl).toBe("http://proxy.example:8317/prefix");
      expect(result.codexBaseUrl).toBeUndefined();
    }
    for (const suffix of ["/backend-api", "/backend-api/codex", "/backend-api/codex/responses/"]) {
      const result = readConfig({ CLIPROXYAPI_API_KEY: "test", CLIPROXYAPI_BASE_URL: `https://proxy.example/prefix${suffix}` }, path);
      expect(result.baseUrl).toBe("https://proxy.example/prefix");
      expect(result.codexBaseUrl).toBe("https://proxy.example/prefix/backend-api");
    }
  }));

  test("rejects unsupported or malformed URLs before discovery", () => withConfig(path => {
    for (const input of ["ftp://host", "http:/host", "https:///host", "http://", "/relative/path", "not a host", "https://host?x=1", "https://host/#x", "https://user:pass@host", "http://host:invalid"]) {
      expect(() => readConfig({ CLIPROXYAPI_API_KEY: "test", CLIPROXYAPI_BASE_URL: input }, path)).toThrow("CLIPROXYAPI_BASE_URL");
    }
  }));
});

test("discovery caches owner-scoped pricing, canonical aliases and native context tiers", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cpa-pricing-"));
  const path = join(dir, "cliproxyapi.yml");
  const entries = [
    { slug: "team/gemini-pro-agent", owned_by: "google", context_window: 10, max_tokens: 5, input_modalities: ["text"] },
    { slug: "gemini-pro-agent", owned_by: "reseller" },
    { slug: "claude-model", owned_by: "anthropic" },
    { slug: "invalid-price", owned_by: "google" },
    { slug: "unknown", owned_by: "google" },
  ];
  const payload = {
    google: { models: {
      "gemini-3.1-pro-preview": { limit: { context: 1_000_000, output: 64_000 }, modalities: { input: ["image", "text"] }, reasoning: true, tool_call: false,
        cost: { input: 2, output: 12, cache_read: 0.2, cache_write: 1, context_over_200k: { input: 99 }, tiers: [
          { tier: { type: "context", size: 500_000 }, input: 8, output: 40 },
          { tier: { type: "context", size: 200_000 }, input: 4, output: 18, cache_read: 0.4, cache_write: 2 },
        ] } },
      "invalid-price": { cost: { input: -1, output: "3", cache_read: null, cache_write: 0 } },
    } },
    anthropic: { models: { "claude-model": { cost: { input: 3, output: 15, context_over_200k: { input: 6, output: 22.5, cache_read: 0.6 } } } } },
    reseller: { models: { "gemini-3.1-pro-preview": { cost: { input: 999, output: 999 } } } },
  };
  let catalogCalls = 0;
  const fetcher = async (input: string | URL | Request): Promise<Response> => {
    if (String(input) === "https://models.dev/api.json") {
      catalogCalls++;
      return Response.json(payload);
    }
    return Response.json({ models: entries });
  };
  try {
    const first = await discoverModels(config, fetcher, path);
    const model = first.models[0]!;
    expect(model.id).toBe("team/gemini-pro-agent");
    expect(model.cost).toEqual({ input: 2, output: 12, cacheRead: 0.2, cacheWrite: 1, longContext: { inputThreshold: 200_000, input: 4, output: 18, cacheRead: 0.4, cacheWrite: 2 } });
    expect([model.contextWindow, model.maxTokens, model.input, model.reasoning, model.supportsTools]).toEqual([1_000_000, 64_000, ["image", "text"], true, false]);
    expect(first.models[1]!.cost).toEqual(zeroCost);
    expect(first.models[2]!.cost.longContext).toEqual({ inputThreshold: 200_000, input: 6, output: 22.5, cacheRead: 0.6, cacheWrite: 0 });
    expect(first.models[3]!.cost).toEqual(zeroCost);
    expect(first.models[4]!.cost).toEqual(zeroCost);
    expect((await discoverModels(config, fetcher, path)).models[0]!.cost).toEqual(model.cost);
    expect(catalogCalls).toBe(1);
    const overridden = await discoverModels({ ...config, modelOverrides: { "team/gemini-pro-agent": { contextWindow: 42, maxTokens: 21 } } }, fetcher, path);
    expect([overridden.models[0]!.contextWindow, overridden.models[0]!.maxTokens]).toEqual([42, 21]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activateOmp, type OmpProviderConfig } from "../src/omp.ts";
import { discoverModels } from "../src/shared.ts";

const key = "discovery-regression-key";

test("authentication remains usable before and after catalog failure", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cliproxyapi-auth-test-"));
  const catalog = Promise.withResolvers<Response>();
  let provider: OmpProviderConfig | undefined;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === "/v1/models") return catalog.promise;
      return new Response(request.headers.get("Authorization") === `Bearer ${key}` ? "authenticated" : "denied", {
        status: request.headers.get("Authorization") === `Bearer ${key}` ? 200 : 401,
      });
    },
  });
  const activation = activateOmp({
    registerProvider(_name, config) { provider = config; },
    getThinkingLevel: () => "high",
    setThinkingLevel() {},
    setModel: async () => true,
    on() {},
  }, {
    CLIPROXYAPI_API_KEY: key,
    CLIPROXYAPI_BASE_URL: server.url.origin,
    PI_CODING_AGENT_DIR: dir,
  });
  const request = () => fetch(`${server.url.origin}/v1/chat/completions`, {
    headers: provider ? { Authorization: `Bearer ${provider.apiKey}` } : {},
  });
  try {
    expect(await (await request()).text()).toBe("authenticated");
    catalog.resolve(new Response("unavailable", { status: 503 }));
    await activation;
    expect(await (await request()).text()).toBe("authenticated");
  } finally {
    catalog.resolve(new Response("unavailable", { status: 503 }));
    await activation;
    await server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
});

test.each(["headers", "body"] as const)("catalog timeout cancels stalled %s without retrying", async (stage) => {
  const release = Promise.withResolvers<Response>();
  let requests = 0;
  let signal: AbortSignal | null | undefined;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      requests++;
      if (requests > 1) return new Response("unexpected retry", { status: 503 });
      if (stage === "headers") return release.promise;
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"models":[')); } }));
    },
  });
  try {
    await expect(discoverModels({
      apiKey: key,
      baseUrl: server.url.origin,
      startupTimeoutMs: 30,
      modelOverrides: {},
    }, (input, init) => {
      signal = init?.signal;
      return fetch(input, init);
    })).rejects.toThrow();
    expect(signal?.aborted).toBe(true);
    expect(requests).toBe(1);
  } finally {
    release.resolve(Response.json({ models: [] }));
    await server.stop(true);
  }
});

test("cold metadata body timeout preserves the discovered model capabilities", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cliproxyapi-metadata-test-"));
  const body = Promise.withResolvers<void>();
  let metadataSignal: AbortSignal | null | undefined;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === "/metadata") {
        return new Response(new ReadableStream({ async start(controller) {
          controller.enqueue(new TextEncoder().encode("{"));
          await body.promise;
          try { controller.enqueue(new TextEncoder().encode("}")); controller.close(); } catch { /* Connection already aborted. */ }
        } }));
      }
      return Response.json({ models: [{ slug: "gpt-5", owned_by: "openai", context_window: 262144 }] });
    },
  });
  const deadline = AbortSignal.timeout(1000);
  try {
    const catalog = await discoverModels({
      apiKey: key,
      baseUrl: server.url.origin,
      startupTimeoutMs: 30,
      modelOverrides: {},
    }, (input, init) => {
      if (String(input).startsWith("https://models.dev/")) {
        metadataSignal = init?.signal;
        return fetch(new URL("/metadata", server.url), { ...init, signal: init?.signal ?? deadline });
      }
      return fetch(input, init);
    }, join(dir, "cliproxyapi.yml"));
    expect(metadataSignal?.aborted).toBe(true);
    expect(catalog.models[0]?.contextWindow).toBe(262144);
  } finally {
    body.resolve();
    await server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
});

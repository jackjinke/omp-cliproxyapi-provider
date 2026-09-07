# omp-cliproxyapi-provider

[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) provider extension for OMP.

## What it does

- **Rich catalog discovery.** CPA's `/v1/models` normally returns only `{id, object, created, owned_by}`.
  This extension sends an `Anthropic-Version` header during discovery, which switches the same route to
  CPA's full registry entries: `display_name`, `context_length`, `max_completion_tokens`,
  `thinking.levels`, and `supportedInputModalities`. Context windows, max output tokens, reasoning effort
  sets, and vision support in OMP therefore come from the live gateway instead of a hardcoded list.
- **Per-model wire selection**, driven by the channel metadata in each catalog entry:
  - Claude models → `anthropic-messages` (native Messages API against CPA's `/v1/messages`)
  - Codex/GPT models → `openai-codex-responses` with V2 streaming remote compaction. The base URL is
    terminated with `?cliproxyapi-codex=` so pi-ai's unconditional `/codex/responses` suffix is parked in
    the query string and requests keep hitting CPA's `/v1/responses`.
  - Everything else (Kimi, GLM/BigModel, DeepSeek, OpenCode Go, …) → `openai-completions`. CPA's
    `openai-compatibility` executors speak chat completions to those upstreams regardless of the inbound
    wire, so asking for Responses or Messages client-side would only add a translation hop.
- **Cloaking decode.** CPA disguises non-Claude ids in Anthropic-shaped listings as
  `claude-fable-5-dd-<reversed id>` for Claude Code. The extension reverses them back to real routing ids.
- **Fail-open startup.** If CPA is down or unconfigured, a warning is logged and OMP starts without the
  provider.
- A persisted `cpa/…` startup model is rebound through `setModel` once the catalog registers, so
  native image input and capabilities reconcile immediately.

## What it does not do

- **Image generation** is not dispatched to extension-registered providers; `generate_image` only targets
  built-in providers. To generate images through CPA, point a built-in provider (e.g. `openai` or
  `openai-codex`) at CPA in `~/.omp/agent/models.yml` and keep an image-capable upstream configured. CPA
  also exposes `/v1/images/generations` for compat models marked `image: true` in its config.
- **V1 remote compaction** (`/responses/compact`) is deliberately not wired: CPA's compact route returns a
  generate response rather than a compaction item. Only V2 streaming compaction is enabled, for Codex
  models.

## Install

For local development:

```bash
omp -e /absolute/path/to/omp-cliproxyapi-provider/src/index.ts
```

For permanent use, add the package directory to `~/.omp/agent/config.yml`:

```yaml
extensions:
  - ~/Projects/omp-cliproxyapi-provider
```

## Use

```bash
export CLIPROXYAPI_API_KEY='...'
# Only needed when CPA is not local:
export CLIPROXYAPI_BASE_URL='http://your-cpa-host:8317'
```

Environment variables can also live in `~/.omp/agent/.env`.

Then choose any discovered entry:

```bash
omp --model cpa/<model-id>
```

## Metadata for openai-compatibility models

OAuth channels (Claude Code, Codex, Kimi, xAI) ship full registry metadata automatically.
`openai-compatibility` upstreams (DeepSeek, GLM/BigModel, OpenCode Go, …) only advertise what you
configure in CPAMP, so the extension fills their gaps from the
[models.dev](https://models.dev) catalog:

- The catalog is fetched once a day and cached at `cliproxyapi.models-dev.cache.json` next to
  `cliproxyapi.yml`; a stale cache is used when the network is down, and enrichment is skipped entirely
  when no compat models are present.
- Matching is provider-scoped: the compat provider's **name in CPAMP** is matched against models.dev
  provider ids (e.g. name it `deepseek`, `zai`, `opencode`), then by model id or display name.
  Cross-provider guessing is deliberately avoided — resellers report conflicting limits for the same
  model id, and wrong metadata is worse than the 128k/16k fallback.
- CPA config stays canonical per field: a `max-context-length` you set in CPAMP always wins over
  models.dev.

## Local overrides

`cliproxyapi.yml` in the agent directory (`~/.omp/agent/`, or `PI_CODING_AGENT_DIR` when set) accepts
Codex transport opt-ins, reasoning-effort overrides, and a generic `models:` table for metadata
overrides. Overrides apply to every channel — compat and first-party alike — and beat both CPA metadata
and models.dev. `"*"` sets defaults merged under per-model entries.

```yaml
codex_transport: [custom/o3-pool]
<model-id>: [low, medium, high, max]
"*": [low, medium, high, xhigh]

models:
  deepseek-v3.2:          # alias as exposed by CPA
    contextWindow: 163840
    maxTokens: 65536
  "*":
    contextWindow: 128000
```

Supported `models:` fields today: `contextWindow`, `maxTokens`. Unknown fields are ignored so newer
configs keep loading on older extension versions; new fields are added as the host supports them.

## Optional settings

```bash
CLIPROXYAPI_STARTUP_TIMEOUT_MS='15000'
```

## Development

```bash
bun install
bun test
bunx tsc --noEmit
```

Shared discovery/normalization logic lives in `src/shared.ts`; the OMP adapter lives in `src/omp.ts`.

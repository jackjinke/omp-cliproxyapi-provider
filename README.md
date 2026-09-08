# omp-cliproxyapi-provider

[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) provider extension for OMP.

## What it does

- **Pi catalog discovery.** Uses `/v1/models?client_version=pi` and its `models` array. Each exact
  `slug` is the routing ID; `display_name` is only the label. No Claude Code ID cloaking is involved.
- **Capability metadata.** Context/output limits, text/image input, reasoning support, and tool support
  prefer models.dev; missing fields fall back to the Pi catalog and then conservative defaults.
  Local metadata overrides take priority over both sources.
- **Reasoning efforts.** Selectable levels and the default level come from CPA's
  `supported_reasoning_levels` and `default_reasoning_level`, filtered to OMP-supported levels.
  `ultra` is not registered or remapped to `max`. These are CPA declarations, not a verified
  intersection of every upstream in a merged model pool.
- **Per-model wire selection**, using model IDs and explicit `codex_transport` opt-ins, not catalog
  connection hints:
  - Claude models → `anthropic-messages` against CPA's `/v1/messages`.
  - Codex/GPT models → `openai-codex-responses` with V2 streaming remote compaction. The base URL ends
    in `?cliproxyapi-codex=` so pi-ai's `/codex/responses` suffix stays in the query string and requests
    reach CPA's `/v1/responses`. `prefer_websockets` is honored; OMP handles SSE fallback.
    Responses Lite remains explicitly disabled even when CPA advertises it.
  - Other models → `openai-completions`. Arbitrary model aliases do not reliably identify a protocol;
    use `codex_transport` for custom Codex aliases.
- **Fail-open startup.** If CPA is down or unconfigured, a warning is logged and OMP starts without the
  provider.
- A persisted `cliproxyapi/…` startup model is rebound through `setModel` once the catalog registers,
  so native image input and capabilities reconcile immediately.

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
omp --model cliproxyapi/<model-id>
```

## Metadata sources and cache

The [models.dev](https://models.dev) catalog takes priority over Pi capability metadata for all models.
Pi entries can contain synthetic template values, so a populated Pi field does not prevent a
models.dev lookup. Missing models.dev fields retain the corresponding Pi values.

- Model IDs and display names always come from the Pi list. The ordinary `/v1/models` list supplies
  `owned_by`, joined by exact ID, because the Pi list omits provider identity.
- Metadata matching is provider-scoped: `owned_by` is matched against models.dev provider IDs, then
  by model ID or display name. Provider/model lookup keys ignore case and non-alphanumeric characters;
  routing IDs are never normalized. Custom provider labels may not match, and a merged listing does
  not identify every backing provider. Unmatched entries fall back to Pi; no cross-provider search is used.
- Reasoning **support** may come from models.dev, but effort levels and their default remain CPA's
  settings. No additional reasoning-level catalog is consulted.
- The normalized models.dev index is cached for **6 hours** at `cliproxyapi.models-dev.cache.json`
  beside `cliproxyapi.yml`. Fresh cache entries require no models.dev request.
- An expired readable cache is used immediately; refresh runs in the background for subsequent
  discoveries. It does not alter the already registered models. Refresh failure preserves the old cache.
- With no readable cache, discovery waits for the initial fetch. If that fails, it uses Pi metadata.
- Put explicit deployment limits in local `models:` overrides when they must override models.dev.

## Local overrides

`cliproxyapi.yml` in the agent directory (`~/.omp/agent/`, or `PI_CODING_AGENT_DIR` when set) accepts
Codex transport opt-ins, reasoning-effort overrides, and a generic `models:` table for metadata
overrides. Metadata overrides apply to every model and beat both models.dev and Pi metadata.
`"*"` sets defaults merged under per-model entries. Effort overrides add supported levels to CPA's
declared list; they do not replace or remove declared levels.

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

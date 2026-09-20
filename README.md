# omp-cliproxyapi-provider

[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) provider extension for [OMP](https://github.com/nicepkg/oh-my-pi). It discovers the models exposed by CLIProxyAPI and makes them available in OMP, including Claude, Codex/GPT, and other compatible models.

## Install

```bash
omp install github:jackjinke/omp-cliproxyapi-provider
```

## Configure

CLIProxyAPI must be running and expose a compatible API. Set its API key and, if needed, its base URL:

```bash
export CLIPROXYAPI_API_KEY='...'
export CLIPROXYAPI_BASE_URL='http://127.0.0.1:8317' # optional
```

These variables can also be placed in `~/.omp/agent/.env`. The base URL defaults to `http://127.0.0.1:8317`.

Host-and-port URLs without a scheme and URLs ending in `/v1` are accepted. Reverse-proxy path prefixes are preserved. Root URLs retain the existing `/v1/responses` Codex transport. To use CPA's native Codex route on servers that expose it, explicitly set the base URL to `http://127.0.0.1:8317/backend-api`; discovery and non-Codex models still use `/v1`. URLs must use HTTP(S), without embedded credentials, query parameters, or fragments.

Authentication is registered before model discovery. Successful catalogs are stored under `~/.omp/agent/cliproxyapi-catalog/`, scoped to the endpoint, API key, native route, and model overrides. Cache files contain model metadata, not API keys. Matching cached models register immediately while discovery refreshes in the background; an outage retains the last good catalog. Without a matching cache, startup waits for discovery and retains authentication if it fails.

Run `/cliproxyapi-refresh` to refresh models without restarting OMP. Concurrent refreshes share one request sequence, and failed refreshes keep the last catalog. Each catalog request has a 15-second timeout covering headers and body, and is cancelled on timeout. Set `CLIPROXYAPI_STARTUP_TIMEOUT_MS` to change this per-request limit. Discovery does not retry or launch external commands.

Optional models.dev enrichment uses the existing six-hour metadata cache. Provider-scoped models.dev capabilities and limits continue to take precedence over CPA's potentially templated metadata; explicit YAML context/output overrides take precedence over both. Pricing includes input, output, cache, and the first supported long-context tier, with zero for unknown rates. These are estimated list prices, not a guarantee of CPA billing. Unmatched providers never borrow reseller prices. Hidden catalog entries are omitted, and prefixed Claude/Codex IDs retain their full request IDs while selecting the appropriate transport.

The optional `~/.omp/agent/cliproxyapi.yml` file configures Codex transport opt-ins and per-model overrides. A bare model name applies to that model with or without a provider prefix; a provider-specific entry takes priority:

```yaml
models:
  gpt-5:
    contextWindow: 128000
  openai/gpt-5:
    contextWindow: 200000
```

Here the first override applies to `gpt-5` and other prefixed variants, while `openai/gpt-5` uses the provider-specific value.

```yaml
models:
  custom/gpt-pool:
    codex_transport: true
    efforts: [low, medium, high]
    contextWindow: 128000
    maxTokens: 16384
```

Select a discovered model with its CLIProxyAPI provider ID:

```bash
omp --model cliproxyapi/<model-id>
```

Model transport settings are restored at session startup, on session switches, and before each turn. This keeps model switches routed to CLIProxyAPI without changing the session's selected reasoning effort.

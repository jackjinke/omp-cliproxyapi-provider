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

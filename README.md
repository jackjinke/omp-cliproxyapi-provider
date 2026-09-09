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

The optional `~/.omp/agent/cliproxyapi.yml` file configures Codex transport opt-ins and per-model overrides:

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

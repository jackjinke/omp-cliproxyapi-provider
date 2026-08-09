# omp-cliproxyapi-provider

Native [OMP](https://github.com/can1357/oh-my-pi) provider extension for [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI).

It discovers available models from CLIProxyAPI's raw model endpoint and registers them under the `cliproxyapi` provider using OMP's native `openai-codex-responses` transport. OMP's bundled Codex catalog and models.dev enrich raw model identities; configurable metadata mappings handle aliases that use different catalog names. Exact OpenAI-owned Codex matches also retain OMP's bundled remote-compaction capabilities.

## Install

Requires OMP 17.2 or newer.

```sh
omp plugin install github:jackjinke/omp-cliproxyapi-provider
```

Restart OMP after installation.

## Configure

Run `/login` in OMP, select **CLIProxyAPI**, then enter the CLIProxyAPI base URL and API key. Configuration is stored in `~/.omp/agent/cliproxyapi.json`.

The configured `apiKey` is used first. If it is absent, the provider reads `CLIPROXYAPI_API_KEY`. The base URL can also be overridden with `CLIPROXYAPI_BASE_URL`:

```sh
export CLIPROXYAPI_BASE_URL=http://127.0.0.1:8317
export CLIPROXYAPI_API_KEY=cpa-your-key
```

Model aliases can point to a models.dev `provider/model` entry. User mappings replace built-in mappings with the same `modelId`; `contextWindow` and `displayName` are optional local overrides:

```json
{
  "baseUrl": "http://127.0.0.1:8317",
  "modelMetadataOverrides": [
    {
      "modelId": "kimi-k3-256k",
      "overrideWith": "kimi-for-coding/k3-256k",
      "displayName": "Kimi Coding K3 256K"
    }
  ]
}
```

## Use

Select a discovered model with `/model`, or reference it directly:

```text
cliproxyapi/gpt-5.6-sol
cliproxyapi/claude-fable-5
```

Example OMP role configuration:

```yaml
modelRoles:
  default: cliproxyapi/gpt-5.6-sol:high
  slow: cliproxyapi/claude-fable-5:xhigh
```

Refresh the dynamic model catalog with:

```sh
omp models refresh
```

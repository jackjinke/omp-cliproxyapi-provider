# omp-cliproxyapi-provider

Native [OMP](https://github.com/can1357/oh-my-pi) provider extension for [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI).

It discovers available models from CLIProxyAPI's raw and Codex-client model endpoints in parallel and registers them under the `cliproxyapi` provider using OMP's native `openai-codex-responses` transport. Raw metadata controls availability and ownership; exact OMP Codex and models.dev matches take precedence, with CLIProxyAPI's rich metadata used as a fallback for native providers.

## Install

Requires OMP 17.2 or newer.

```sh
omp plugin install github:jackjinke/omp-cliproxyapi-provider
```

Restart OMP after installation.

## Configure

Run `/login` in OMP, select **CLIProxyAPI**, then enter the CLIProxyAPI base URL and API key. Configuration is stored in `~/.omp/agent/cliproxyapi.json`.

Environment variables can be used instead:

```sh
export CLIPROXYAPI_BASE_URL=http://127.0.0.1:8317
export CLIPROXYAPI_API_KEY=cpa-your-key
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

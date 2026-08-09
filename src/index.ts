import type { FetchImpl, Model } from "@oh-my-pi/pi-ai";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@oh-my-pi/pi-ai/oauth/types";
import type { ExtensionAPI, ProviderConfig } from "@oh-my-pi/pi-coding-agent";
import {
  CREDENTIAL_TTL_MS,
  fetchModels,
  PROVIDER_ID,
  PROVIDER_NAME,
  resolveEndpoints,
  resolveSettings,
  type ResolvedSettings,
  writeConfig,
} from "./provider.ts";

function credentialBaseUrl(value: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || !("baseUrl" in parsed)) return undefined;
    return typeof parsed.baseUrl === "string" && parsed.baseUrl.trim() ? parsed.baseUrl.trim() : undefined;
  } catch {
    return undefined;
  }
}

export function createProvider(
  settings: ResolvedSettings,
  fetcher: FetchImpl = fetch,
): ProviderConfig {
  let activeBaseUrl = settings.baseUrl;

  return {
    baseUrl: resolveEndpoints(activeBaseUrl).inferenceBaseUrl,
    api: "openai-codex-responses",
    ...(settings.apiKey ? { apiKey: settings.apiKey } : {}),
    oauth: {
      name: PROVIDER_NAME,
      async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
        const enteredBaseUrl = await callbacks.onPrompt({
          message: `CLIProxyAPI base URL [${activeBaseUrl}]:`,
          placeholder: activeBaseUrl,
          allowEmpty: true,
        });
        const baseUrl = enteredBaseUrl.trim() || activeBaseUrl;
        resolveEndpoints(baseUrl);

        const apiKey = (await callbacks.onPrompt({
          message: "CLIProxyAPI API key:",
          placeholder: "cpa-...",
          allowEmpty: false,
        })).trim();
        if (!apiKey) throw new Error("CLIProxyAPI API key cannot be empty");

        callbacks.onProgress?.("Validating CLIProxyAPI credentials...");
        await fetchModels(baseUrl, apiKey, fetcher);
        writeConfig(settings.agentDir, { baseUrl, apiKey });
        activeBaseUrl = baseUrl;
        return {
          access: apiKey,
          refresh: JSON.stringify({ baseUrl }),
          expires: Date.now() + CREDENTIAL_TTL_MS,
        };
      },
      refreshToken(value: OAuthCredentials): Promise<OAuthCredentials> {
        return Promise.resolve({ ...value, expires: Date.now() + CREDENTIAL_TTL_MS });
      },
      getApiKey(value: OAuthCredentials): string {
        return value.access;
      },
      modifyModels(models: Model[], value: OAuthCredentials): Model[] {
        const baseUrl = credentialBaseUrl(value.refresh);
        if (!baseUrl) return models;
        const inferenceBaseUrl = resolveEndpoints(baseUrl).inferenceBaseUrl;
        return models.map(model => model.provider === PROVIDER_ID ? { ...model, baseUrl: inferenceBaseUrl } : model);
      },
    },
    fetchDynamicModels(apiKey: string | undefined) {
      return apiKey ? fetchModels(activeBaseUrl, apiKey, fetcher) : Promise.resolve([]);
    },
  };
}

export default function cliproxyapiProvider(api: ExtensionAPI): void {
  const settings = resolveSettings();
  api.registerProvider(PROVIDER_ID, createProvider(settings));
}

export { PROVIDER_ID, PROVIDER_NAME, resolveEndpoints } from "./provider.ts";

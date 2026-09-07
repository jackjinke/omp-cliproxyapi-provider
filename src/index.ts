import { activateOmp, type OmpExtensionAPI } from "./omp.ts";

export default async function cliproxyapiOmpExtension(api: OmpExtensionAPI): Promise<void> {
  await activateOmp(api);
}

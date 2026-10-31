import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { Backend } from "../shared/contracts";

/** Re-runs Paseo's catalog discovery for the backend so models and availability follow the new login */
export function refreshPaseoProvider(paseo: PluginHandlerContext["paseo"], backend: Backend): void {
  // Backend ids match Paseo's built-in provider ids
  paseo.providers.refresh({ providers: [backend] }).catch((error: unknown) => {
    console.error(`Refreshing Paseo's ${backend} provider failed`, error instanceof Error ? error.message : error);
  });
}

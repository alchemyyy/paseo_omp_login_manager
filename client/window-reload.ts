import { Platform } from "react-native";

/**
 * Reloads the Paseo window (desktop and web only): the renderer restarts, the app and its
 * background service keep running. Null where there is no window to reload, such as mobile.
 */
export function windowReloader(): (() => void) | null {
  if (Platform.OS !== "web") return null;
  // The plugin tsconfig has no DOM lib, so the Location is narrowed here
  const location: unknown = Reflect.get(globalThis, "location");
  if (typeof location !== "object" || location === null || !("reload" in location)) return null;
  const { reload } = location;
  return typeof reload === "function" ? () => reload.call(location) : null;
}

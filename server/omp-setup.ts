/** Paseo's provider/omp MIN_SUPPORTED_OMP_VERSION: setup installs omp over anything older */
export const MINIMUM_OMP_VERSION = "16.3.9";

/** The first `major.minor.patch` in `omp --version` output */
export function parseVersion(text: string): string | null {
  return /(\d+\.\d+\.\d+)/.exec(text)?.[1] ?? null;
}

/** Compares `major.minor.patch` numerically, so 16.10.0 is newer than 16.3.9 */
export function isOlderVersion(version: string, minimum: string): boolean {
  const left = version.split(".").map(Number);
  const right = minimum.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index];
  }
  return false;
}

/** The slice of Paseo's `providers.omp` settings that setup reads */
export interface OmpProviderSettings {
  enabled?: unknown;
  command?: unknown;
}

// A type alias, not an interface, so it fits Paseo's config patch with its open index signature
export type OmpProviderPatch = { enabled?: true; command?: string[] };

/**
 * The change that turns Paseo's omp provider on and points it at omp, filling only what the user has
 * not set: an absolute command lets a daemon started before omp joined PATH find it. Null when there
 * is nothing to change, when the user turned the provider off, or when no omp is available.
 */
export function providerPatch(settings: OmpProviderSettings | undefined, ompPath: string | null): OmpProviderPatch | null {
  if (settings?.enabled === false) return null;
  const hasCommand = settings?.command !== undefined;
  if (!hasCommand && ompPath === null) return null;
  const patch: OmpProviderPatch = {};
  if (settings?.enabled === undefined) patch.enabled = true;
  if (!hasCommand && ompPath !== null) patch.command = [ompPath];
  return patch.enabled === undefined && patch.command === undefined ? null : patch;
}

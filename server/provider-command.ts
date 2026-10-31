import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { Backend } from "../shared/contracts";

export interface ProviderLaunch {
  command: string;
  /** Argv prefix from a `command` override, placed before the subcommand */
  prefixArgs: string[];
  env: NodeJS.ProcessEnv;
}

interface BackendDefaults {
  defaultCommand: string;
  /** Environment variable Paseo's provider reads for its binary, if any */
  commandVariable: string | null;
  /** Where the official installer puts the binary, for daemons started with a stale PATH */
  installedPath(environment: NodeJS.ProcessEnv): string | null;
}

const BACKEND_DEFAULTS: Record<Backend, BackendDefaults> = {
  omp: {
    defaultCommand: "omp",
    commandVariable: "OMP_COMMAND",
    installedPath: (environment) =>
      environment.LOCALAPPDATA ? path.join(environment.LOCALAPPDATA, "omp", "omp.exe") : null,
  },
  claude: {
    defaultCommand: "claude",
    commandVariable: null,
    installedPath: (environment) =>
      environment.USERPROFILE ? path.join(environment.USERPROFILE, ".local", "bin", "claude.exe") : null,
  },
};

const PASEO_CONFIG_FILE = "config.json";

interface ProviderOverride {
  command?: unknown;
  env?: unknown;
}

/**
 * Resolves a backend's binary the way Paseo's built-in provider does: the
 * `agents.providers.<backend>.command` override, else the provider's command variable, else the
 * default name, with the provider's `env` layered over the daemon's. Using the same binary and env
 * (for example OMP_PROFILE or CLAUDE_CONFIG_DIR) makes logins land in the store Paseo reads.
 */
export function resolveProviderLaunch(
  backend: Backend,
  paseoConfig: unknown,
  environment: NodeJS.ProcessEnv,
  fileExists: (filePath: string) => boolean,
): ProviderLaunch {
  const defaults = BACKEND_DEFAULTS[backend];
  const override = readProviderOverride(paseoConfig, backend);
  const env: NodeJS.ProcessEnv = { ...environment, ...readStringRecord(override?.env) };
  const argv = readStringArray(override?.command);
  if (argv.length > 0) {
    return { command: argv[0]!, prefixArgs: argv.slice(1), env };
  }
  const fromEnvironment = defaults.commandVariable ? environment[defaults.commandVariable]?.trim() : undefined;
  if (fromEnvironment) return { command: fromEnvironment, prefixArgs: [], env };
  const installed = defaults.installedPath(environment);
  if (installed && fileExists(installed)) return { command: installed, prefixArgs: [], env };
  return { command: defaults.defaultCommand, prefixArgs: [], env };
}

/** Paseo's state directory: PASEO_HOME, default ~/.paseo */
export function paseoHome(): string {
  return process.env.PASEO_HOME || path.join(homedir(), ".paseo");
}

/** Reads Paseo's config.json from PASEO_HOME (default ~/.paseo) and resolves the backend from it */
export function loadProviderLaunch(backend: Backend): ProviderLaunch {
  let paseoConfig: unknown = null;
  try {
    paseoConfig = JSON.parse(readFileSync(path.join(paseoHome(), PASEO_CONFIG_FILE), "utf8"));
  } catch {
    // A missing or unreadable config means Paseo uses its defaults
  }
  return resolveProviderLaunch(backend, paseoConfig, process.env, existsSync);
}

function readProviderOverride(paseoConfig: unknown, backend: Backend): ProviderOverride | null {
  if (!isRecord(paseoConfig)) return null;
  const agents = paseoConfig.agents;
  if (!isRecord(agents)) return null;
  const providers = agents.providers;
  if (!isRecord(providers)) return null;
  const provider = providers[backend];
  return isRecord(provider) ? provider : null;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.every((entry) => typeof entry === "string" && entry.length > 0) ? value : [];
}

function readStringRecord(value: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  if (!isRecord(value)) return result;
  for (const [name, entry] of Object.entries(value)) {
    if (typeof entry === "string") result[name] = entry;
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

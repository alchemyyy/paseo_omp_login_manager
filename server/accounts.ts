import type { RpcOutput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { execCommand } from "@getpaseo/plugin/server";
import { type Account, type Backend, BackendSchema, enabledBackends, type listAccountsRpc } from "../shared/contracts";
import {
  buildAccounts,
  buildClaudeAccount,
  type ExportedCredential,
  parseAuthExport,
  parseUsage,
  type UsageSnapshot,
} from "./account-model";
import { loadProviderLaunch, type ProviderLaunch } from "./provider-command";
import { refreshPaseoProvider } from "./paseo-refresh";
import { ensureSetup, setupStatus } from "./setup";

const AUTH_EXPORT_TIMEOUT_MS = 20_000;
const USAGE_TIMEOUT_MS = 45_000;
const CLAUDE_STATUS_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
// cmd.exe's message when a bare command name is not on PATH
const NOT_RECOGNIZED = /is not recognized as an internal or external command/i;

/** A backend's rows, or why they could not be read; null when the backend is not installed */
type BackendResult = { accounts: Account[]; fingerprint: string } | { error: string } | null;

// Last observed credential fingerprint per backend, so a login made in a terminal still refreshes Paseo
const lastFingerprints = new Map<Backend, string>();

/** Lists omp and Claude Code accounts with their authentication status; the first list starts first-run setup */
export async function listAccounts(
  _input: object,
  { paseo }: PluginHandlerContext,
): Promise<RpcOutput<typeof listAccountsRpc>> {
  ensureSetup(paseo);
  const checkedAt = Date.now();
  const enabled = await readEnabledBackends(paseo);
  const readers: Record<Backend, () => Promise<BackendResult>> = {
    omp: () => readOmp(checkedAt),
    claude: readClaude,
  };
  const results = await Promise.all(
    enabled.map(async (backend): Promise<[Backend, BackendResult]> => [backend, await readers[backend]()]),
  );
  const accounts: Account[] = [];
  const errors: { backend: Backend; message: string }[] = [];
  for (const [backend, result] of results) {
    if (result === null) continue;
    if ("error" in result) {
      errors.push({ backend, message: result.error });
      continue;
    }
    accounts.push(...result.accounts);
    const previous = lastFingerprints.get(backend);
    if (previous !== undefined && previous !== result.fingerprint) refreshPaseoProvider(paseo, backend);
    lastFingerprints.set(backend, result.fingerprint);
  }
  return { accounts, enabledBackends: enabled, errors, setup: setupStatus(), checkedAt };
}

/** Backends Paseo has enabled; every backend when the snapshot is unavailable, so a hiccup hides nothing */
async function readEnabledBackends(paseo: PluginHandlerContext["paseo"]): Promise<Backend[]> {
  try {
    return enabledBackends(await paseo.providers.snapshot()) ?? [...BackendSchema.options];
  } catch (error) {
    console.error("Reading Paseo's provider snapshot failed", error instanceof Error ? error.message : error);
    return [...BackendSchema.options];
  }
}

/** Called after a plugin-driven login, which refreshes Paseo itself, so the next list skips a second refresh */
export function forgetFingerprint(backend: Backend): void {
  lastFingerprints.delete(backend);
}

async function readOmp(nowMs: number): Promise<BackendResult> {
  const launch = loadProviderLaunch("omp");
  const usagePromise = readUsage(launch);
  let credentials: ExportedCredential[] | null;
  try {
    credentials = await exportOmpCredentials(launch);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  if (credentials === null) return null;
  const usage = await usagePromise;
  const fingerprint = JSON.stringify(
    credentials.map(({ provider, credential }) => [provider, credential.email, credential.orgId, credential.authorizedAt]),
  );
  return { accounts: buildAccounts(credentials, usage, nowMs), fingerprint };
}

/** omp's stored credentials, identity fields only; null when omp is not installed */
export async function exportOmpCredentials(launch: ProviderLaunch): Promise<ExportedCredential[] | null> {
  let exported: string;
  try {
    exported = await run(launch, ["auth", "export"], AUTH_EXPORT_TIMEOUT_MS);
  } catch (error) {
    if (isMissingCommand(error)) return null;
    // NOTE: execFile errors carry stdout, which holds tokens here; report only stderr
    throw new Error(`Could not read omp credentials with ${launch.command}: ${describeError(error)}`);
  }
  return parseAuthExport(exported);
}

/** Live check plus disabled tombstones; best-effort because it calls each provider's usage API */
async function readUsage(launch: ProviderLaunch): Promise<UsageSnapshot | null> {
  try {
    return parseUsage(await run(launch, ["usage", "--json"], USAGE_TIMEOUT_MS));
  } catch {
    return null;
  }
}

async function readClaude(): Promise<BackendResult> {
  const launch = loadProviderLaunch("claude");
  let stdout: string;
  try {
    stdout = await run(launch, ["auth", "status", "--json"], CLAUDE_STATUS_TIMEOUT_MS);
  } catch (error) {
    if (isMissingCommand(error)) return null;
    // Logged out exits non-zero but still prints the status JSON
    const printed = errorStdout(error);
    if (!printed) return { error: `Could not read Claude Code status with ${launch.command}: ${describeError(error)}` };
    stdout = printed;
  }
  try {
    const account = buildClaudeAccount(stdout);
    return { accounts: [account], fingerprint: account.key };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

async function run(launch: ProviderLaunch, args: string[], timeout: number): Promise<string> {
  const { stdout } = await execCommand(launch.command, [...launch.prefixArgs, ...args], {
    env: launch.env,
    timeout,
    maxBuffer: MAX_OUTPUT_BYTES,
  });
  return stdout;
}

function isMissingCommand(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if ("code" in error && error.code === "ENOENT") return true;
  return NOT_RECOGNIZED.test(error.message);
}

function errorStdout(error: unknown): string | null {
  if (!(error instanceof Error) || !("stdout" in error)) return null;
  return typeof error.stdout === "string" && error.stdout.trim() ? error.stdout : null;
}

function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  // The first line is "Command failed: <argv>"; stderr follows and never contains the export payload
  return error.message.split("\n").slice(1).join(" ").trim() || error.message;
}

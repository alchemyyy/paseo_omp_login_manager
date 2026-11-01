import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { execCommand } from "@getpaseo/plugin/server";
import type { SetupStatus } from "../shared/contracts";
import { isOlderVersion, MINIMUM_OMP_VERSION, type OmpProviderSettings, parseVersion, providerPatch } from "./omp-setup";
import { refreshPaseoProvider } from "./paseo-refresh";
import { paseoHome } from "./provider-command";

type Paseo = PluginHandlerContext["paseo"];

/** Written once setup has finished; it never runs again while this file exists */
const MARKER_FILE = path.join(paseoHome(), "plugin-data", "omp-login-manager", "setup.json");
const RETRY_AFTER_MS = 10 * 60_000;
const VERSION_TIMEOUT_MS = 20_000;
// Downloads omp's prebuilt binary
const INSTALL_TIMEOUT_MS = 15 * 60_000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const OMP_INSTALLER_URL = "https://omp.sh/install.ps1";

let completed = existsSync(MARKER_FILE);
let running = false;
let status: SetupStatus | null = null;
let failedAt = 0;

/** Shown in the Accounts section while setup installs or configures, and after it failed */
export function setupStatus(): SetupStatus | null {
  return status;
}

/**
 * First-run setup, started by the first account list, which brings the Paseo handle the server
 * entry lacks: installs omp when it is missing or too old (Windows), then turns Paseo's omp
 * provider on and points it at that omp, unless the user configured the provider. Runs once; a
 * failure is retried by a list at least 10 minutes later, or after the plugin reloads.
 */
export function ensureSetup(paseo: Paseo): void {
  if (completed || running) return;
  if (status?.state === "failed" && Date.now() - failedAt < RETRY_AFTER_MS) return;
  running = true;
  status = null;
  runSetup(paseo).then(
    () => {
      completed = true;
      status = null;
    },
    (error: unknown) => {
      status = { state: "failed", message: error instanceof Error ? error.message : String(error) };
      failedAt = Date.now();
      console.error("[omp-login-manager] Setup failed", status.message);
    },
  ).finally(() => {
    running = false;
  });
}

async function runSetup(paseo: Paseo): Promise<void> {
  const { config } = await paseo.config.get();
  const settings: OmpProviderSettings | undefined = config.providers?.omp;
  // A provider turned off, or pointed at the user's own omp, is theirs to manage
  let ompPath: string | null = null;
  if (settings?.enabled !== false && settings?.command === undefined) {
    const found = await findOmp();
    const usable = found !== null && (found.version === null || !isOlderVersion(found.version, MINIMUM_OMP_VERSION));
    if (usable) ompPath = found.path;
    else if (process.platform === "win32") ompPath = await installOmp(found?.version ?? null);
    // Elsewhere omp's installer is a shell script for the user to run; an older omp is still used
    else ompPath = found?.path ?? null;
  }
  const patch = providerPatch(settings, ompPath);
  if (patch) {
    status = { state: "running", message: "Enabling Paseo's omp provider" };
    await paseo.config.patch({ providers: { omp: patch } });
    refreshPaseoProvider(paseo, "omp");
  }
  await mkdir(path.dirname(MARKER_FILE), { recursive: true });
  await writeFile(MARKER_FILE, `${JSON.stringify({ completedAt: new Date().toISOString(), omp: ompPath, patch }, null, 2)}\n`);
}

/** Where omp's official installer puts the binary */
function installedOmpPath(): string | null {
  if (process.platform !== "win32") return null;
  const directory = process.env.PI_INSTALL_DIR || (process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "omp"));
  return directory ? path.join(directory, "omp.exe") : null;
}

/** omp from the installer's folder, else from PATH, as an absolute path with its version */
async function findOmp(): Promise<{ path: string; version: string | null } | null> {
  const candidates: string[] = [];
  const installed = installedOmpPath();
  if (installed && existsSync(installed)) candidates.push(installed);
  try {
    const { stdout } = await execCommand(process.platform === "win32" ? "where.exe" : "which", ["omp"], {
      timeout: VERSION_TIMEOUT_MS,
    });
    candidates.push(...stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== ""));
  } catch {
    // Not on PATH
  }
  for (const candidate of candidates) {
    try {
      const { stdout } = await execCommand(candidate, ["--version"], { timeout: VERSION_TIMEOUT_MS });
      return { path: candidate, version: parseVersion(stdout) };
    } catch {
      // Not a working omp; try the next one
    }
  }
  return null;
}

/** Runs omp's official installer (prebuilt binary, SHA-256 checked); returns the installed omp */
async function installOmp(previousVersion: string | null): Promise<string> {
  const installed = installedOmpPath();
  if (!installed) throw new Error("Cannot tell where omp's installer puts omp: LOCALAPPDATA is not set");
  status = { state: "running", message: previousVersion ? `Updating omp ${previousVersion}` : "Installing omp" };
  // TLS 1.2 for Windows PowerShell 5.1, which omp.sh requires; no progress bar, which slows downloads
  const script = [
    "$ProgressPreference = 'SilentlyContinue'",
    "[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12",
    `& ([scriptblock]::Create((Invoke-RestMethod -Uri '${OMP_INSTALLER_URL}'))) -Binary`,
  ].join("; ");
  const powershell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  try {
    await execCommand(
      powershell,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      { timeout: INSTALL_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES },
    );
  } catch (error) {
    // PowerShell's first stderr line is the reason; the rest is its error position report
    const stderr = error instanceof Error && "stderr" in error && typeof error.stderr === "string" ? error.stderr : "";
    const reason = stderr.split(/\r?\n/).find((line) => line.trim() !== "")?.trim();
    const timedOut = error instanceof Error && "killed" in error && error.killed;
    throw new Error(`omp's installer failed: ${timedOut ? "it timed out" : (reason ?? "it exited with an error")}`);
  }
  try {
    await execCommand(installed, ["--version"], { timeout: VERSION_TIMEOUT_MS });
  } catch {
    throw new Error(`omp's installer finished, but ${installed} does not run`);
  }
  return installed;
}

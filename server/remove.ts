import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { execCommand, spawnProcess, terminateProcess } from "@getpaseo/plugin/server";
import { z } from "zod";
import type { removeAccountRpc } from "../shared/contracts";
import { selectLogoutCredential } from "./account-model";
import { forgetFingerprint } from "./accounts";
import { loadProviderLaunch, type ProviderLaunch } from "./provider-command";
import { refreshPaseoProvider } from "./paseo-refresh";

const CLAUDE_LOGOUT_TIMEOUT_MS = 30_000;
const OMP_RPC_TIMEOUT_MS = 30_000;

const RpcResponseSchema = z.object({
  type: z.literal("response"),
  id: z.string(),
  success: z.boolean(),
  error: z.string().optional(),
  data: z.unknown().optional(),
});
const LogoutAccountsSchema = z.object({
  accounts: z.array(z.object({ credentialId: z.number(), label: z.string(), type: z.string() })),
});
const LogoutResultSchema = z.object({ remainingSource: z.string().optional() }).nullable().optional();

/** Deletes one stored credential through the backend's own logout, then refreshes Paseo's provider */
export async function removeAccount(
  { backend, provider, type, logoutLabel }: RpcInput<typeof removeAccountRpc>,
  { paseo }: PluginHandlerContext,
): Promise<RpcOutput<typeof removeAccountRpc>> {
  const launch = loadProviderLaunch(backend);
  let remainingSource: string | null = null;
  switch (backend) {
    case "claude":
      await execCommand(launch.command, [...launch.prefixArgs, "auth", "logout"], {
        env: launch.env,
        timeout: CLAUDE_LOGOUT_TIMEOUT_MS,
      });
      break;
    case "omp":
      remainingSource = await removeOmpCredential(launch, provider, type, logoutLabel);
      break;
  }
  forgetFingerprint(backend);
  refreshPaseoProvider(paseo, backend);
  return { remainingSource };
}

/**
 * omp has no logout subcommand, so drive its RPC mode: `get_logout_accounts` lists the provider's
 * credentials with ids, and `logout` deletes one. `--no-session` keeps the run out of omp's history.
 */
async function removeOmpCredential(
  launch: ProviderLaunch,
  provider: string,
  type: "oauth" | "api_key",
  logoutLabel: string | null,
): Promise<string | null> {
  const client = startOmpRpc(launch);
  try {
    await client.ready;
    const listed = LogoutAccountsSchema.parse(await client.request({ type: "get_logout_accounts", providerId: provider }));
    const credentialId = selectLogoutCredential(listed.accounts, type, logoutLabel);
    const result = LogoutResultSchema.parse(await client.request({ type: "logout", providerId: provider, credentialId }));
    return result?.remainingSource ?? null;
  } finally {
    await client.close();
  }
}

interface OmpRpcClient {
  ready: Promise<void>;
  request(command: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

/** Minimal JSON-lines client for omp's RPC mode: a ready event, then id-correlated responses */
function startOmpRpc(launch: ProviderLaunch): OmpRpcClient {
  const child = spawnProcess(launch.command, [...launch.prefixArgs, "--mode", "rpc", "--no-session"], {
    stdio: "pipe",
    env: launch.env,
  });
  const pending = new Map<string, { resolve(data: unknown): void; reject(error: Error): void }>();
  // NOTE: no Promise.withResolvers; the plugin host may run Node 20
  let markReady: () => void = () => {};
  let failReady: (error: Error) => void = () => {};
  const ready = new Promise<void>((resolve, reject) => {
    markReady = resolve;
    failReady = reject;
  });
  let nextId = 1;
  let buffer = "";
  let stderr = "";
  const failAll = (error: Error): void => {
    failReady(error);
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  };
  const timer = setTimeout(() => failAll(new Error("omp RPC timed out")), OMP_RPC_TIMEOUT_MS);
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      handleLine(line);
    }
  });
  const handleLine = (line: string): void => {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      // Events and chunked frames this client does not need
      return;
    }
    if (typeof message === "object" && message !== null && "type" in message && message.type === "ready") {
      markReady();
      return;
    }
    const response = RpcResponseSchema.safeParse(message);
    if (!response.success) return;
    const waiter = pending.get(response.data.id);
    if (!waiter) return;
    pending.delete(response.data.id);
    if (response.data.success) waiter.resolve(response.data.data ?? null);
    else waiter.reject(new Error(response.data.error ?? "omp RPC request failed"));
  };
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-2000);
  });
  child.stdin.on("error", () => {});
  child.on("error", (error) => failAll(new Error(`Could not start ${launch.command}: ${error.message}`)));
  child.on("close", (exitCode) => failAll(new Error(`omp exited (${exitCode}) before answering. ${stderr.trim()}`)));
  return {
    ready,
    request(command) {
      const id = String(nextId++);
      const response = new Promise<unknown>((resolve, reject) => pending.set(id, { resolve, reject }));
      child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
      return response;
    },
    async close() {
      clearTimeout(timer);
      child.stdin.end();
      if (child.exitCode === null) await terminateProcess(child).catch(() => {});
    },
  };
}

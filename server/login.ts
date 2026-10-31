import { randomUUID } from "node:crypto";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { spawnProcess, terminateProcess } from "@getpaseo/plugin/server";
import type {
  cancelLoginRpc,
  LoginSession,
  LoginState,
  loginInputRpc,
  loginStatusRpc,
  startLoginRpc,
} from "../shared/contracts";
import type { Backend } from "../shared/contracts";
import { forgetFingerprint } from "./accounts";
import { loginArguments } from "./login-arguments";
import { endsWithPrompt, extractUrls, parseNumberedChoices, stripTerminalCodes } from "./login-output";
import { loadProviderLaunch } from "./provider-command";
import { refreshPaseoProvider } from "./paseo-refresh";

// Keeps the tail of a chatty login without unbounded growth
const MAX_OUTPUT_CHARACTERS = 64 * 1024;

interface LoginProcess {
  id: string;
  backend: Backend;
  provider: string | null;
  child: ChildProcessWithoutNullStreams;
  output: string;
  state: LoginState;
  exitCode: number | null;
  cancelRequested: boolean;
}

// One login at a time: OAuth loopback callbacks bind fixed local ports
let current: LoginProcess | null = null;

/**
 * Runs `omp login [provider]` or `claude auth login` with piped stdio. Both print the sign-in URL,
 * open it in the daemon host's browser, and wait on their OAuth callback; prompts (omp's provider
 * picker, pasted codes) are answered through `login.input`. On success the backend's Paseo provider
 * catalog is refreshed.
 */
export async function startLogin(
  { backend, provider, email }: RpcInput<typeof startLoginRpc>,
  { paseo }: PluginHandlerContext,
): Promise<RpcOutput<typeof startLoginRpc>> {
  await stopCurrentLogin();
  const launch = loadProviderLaunch(backend);
  const args = [...launch.prefixArgs, ...loginArguments(backend, provider, email)];
  const child = spawnProcess(launch.command, args, {
    stdio: "pipe",
    env: { ...launch.env, NO_COLOR: "1", FORCE_COLOR: "0" },
  });
  const login: LoginProcess = {
    id: randomUUID(),
    backend,
    provider,
    child,
    output: "",
    state: "running",
    exitCode: null,
    cancelRequested: false,
  };
  const append = (chunk: Buffer | string): void => {
    login.output = (login.output + stripTerminalCodes(chunk.toString())).slice(-MAX_OUTPUT_CHARACTERS);
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  // NOTE: a write racing omp's exit raises EPIPE here; unhandled it would crash the plugin process
  child.stdin.on("error", () => {});
  child.on("error", (error) => {
    append(`\nCould not start ${launch.command}: ${error.message}\n`);
    login.state = "failed";
  });
  child.on("close", (exitCode) => {
    login.exitCode = exitCode;
    if (login.cancelRequested) {
      login.state = "cancelled";
      return;
    }
    if (exitCode !== 0) {
      login.state = "failed";
      return;
    }
    login.state = "succeeded";
    forgetFingerprint(backend);
    refreshPaseoProvider(paseo, backend);
  });
  current = login;
  return snapshot(login);
}

export function loginStatus({ id }: RpcInput<typeof loginStatusRpc>): RpcOutput<typeof loginStatusRpc> {
  return current?.id === id ? snapshot(current) : null;
}

/** Writes one line to the login's stdin, answering its current prompt */
export function loginInput({ id, text }: RpcInput<typeof loginInputRpc>): RpcOutput<typeof loginInputRpc> {
  const login = current;
  if (!login || login.id !== id) throw new Error("This login is no longer active");
  if (login.state !== "running") throw new Error("The login has already finished");
  login.child.stdin.write(`${text}\n`);
  // End the prompt line like a terminal would; the answer is not echoed because it may be a pasted code
  login.output += login.output.endsWith("\n") ? "" : "\n";
  return snapshot(login);
}

export async function cancelLogin({ id }: RpcInput<typeof cancelLoginRpc>): Promise<RpcOutput<typeof cancelLoginRpc>> {
  if (current?.id !== id) return null;
  const login = current;
  await stopCurrentLogin();
  return snapshot(login);
}

/** Kills a running login; also used on plugin unload */
export async function stopCurrentLogin(): Promise<void> {
  const login = current;
  if (!login || login.state !== "running") return;
  login.cancelRequested = true;
  await terminateProcess(login.child);
}

function snapshot(login: LoginProcess): LoginSession {
  return {
    id: login.id,
    backend: login.backend,
    provider: login.provider,
    state: login.state,
    output: login.output,
    urls: extractUrls(login.output),
    awaitingInput: login.state === "running" && endsWithPrompt(login.output),
    choices: login.state === "running" ? parseNumberedChoices(login.output) : [],
    exitCode: login.exitCode,
  };
}

import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { PluginHandlerContext, PluginSettings } from "@getpaseo/plugin/server";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { type listAccountPinsRpc, modelProvider, type pinAccountRpc, type preferences } from "../shared/contracts";
import { redactEmails } from "../shared/redact";
import { buildPinnableCredentials, type PinnableCredential } from "./account-model";
import { exportOmpCredentials } from "./accounts";
import { loadProviderLaunch, paseoHome } from "./provider-command";

// A no-turn slash command answers at once; the margin covers a busy daemon
const PIN_TIMEOUT_MS = 30_000;
// omp's reply to a successful `/session pin <account>` (slash-commands/builtin-session.ts)
const PINNED_REPLY = /^Pinned .+ to this session for /;

/** Agent id → omp provider → pinned account key */
const PinStoreSchema = z.record(z.string(), z.record(z.string(), z.string()));
type PinStore = z.infer<typeof PinStoreSchema>;
const PIN_STORE_FILE = path.join(paseoHome(), "plugin-data", "omp-login-manager", "account-pins.json");

type PreferencesSettings = PluginSettings<(typeof preferences)["schema"]>;

let pinStore: Promise<PinStore> | null = null;
let pendingWrite: Promise<void> = Promise.resolve();

/** Builds the `pins.list` and `pins.set` handlers; labels and replies follow the redactEmails preference */
export function createPinHandlers(settings: PreferencesSettings) {
  const listAccountPins = async (_input: object): Promise<RpcOutput<typeof listAccountPinsRpc>> => {
    const [credentials, pins, redacting] = await Promise.all([readPinnable(), loadPins(), readRedacting(settings)]);
    return {
      accounts: credentials.map(({ key, provider, selector }) => ({
        key,
        provider,
        label: redacting ? redactEmails(selector) : selector,
      })),
      pins,
    };
  };

  /** Sends `/session pin` to the agent's omp session and remembers the pick once omp confirms it */
  const pinAccount = async (
    { agentId, accountKey }: RpcInput<typeof pinAccountRpc>,
    { paseo }: PluginHandlerContext,
  ): Promise<RpcOutput<typeof pinAccountRpc>> => {
    const redacting = await readRedacting(settings);
    const account = (await readPinnable()).find((candidate) => candidate.key === accountKey);
    if (!account) throw new Error("omp no longer stores that account; log in to it again");
    const agent = paseo.agents.ref(agentId);
    await agent.refresh();
    const snapshot = agent.current();
    if (!snapshot) throw new Error("Paseo no longer has that agent");
    if (snapshot.provider !== "omp") throw new Error("Only omp agents can switch accounts");
    if (modelProvider(snapshot.model) !== account.provider) {
      throw new Error(`The agent's model no longer uses ${account.provider}`);
    }
    // omp refuses to pin while streaming, and Paseo would queue the command behind the turn
    if (snapshot.status === "running") throw new Error("Wait for the agent's turn to finish, then switch accounts");
    const result = await agent.run(`/session pin ${account.selector}`, { timeoutMs: PIN_TIMEOUT_MS });
    const reply = result.lastMessage?.trim() ?? "";
    if (!PINNED_REPLY.test(reply)) {
      const failure = reply || result.error || `omp did not confirm the switch (${result.status})`;
      throw new Error(redacting ? redactEmails(failure) : failure);
    }
    const pins = await loadPins();
    pins[agentId] = { ...pins[agentId], [account.provider]: account.key };
    await savePins(pins);
    return { message: redacting ? redactEmails(reply) : reply };
  };

  return { listAccountPins, pinAccount };
}

/** Drops an archived agent's remembered pins */
export async function forgetAgentPins(agentId: string): Promise<void> {
  const pins = await loadPins();
  if (!(agentId in pins)) return;
  delete pins[agentId];
  await savePins(pins);
}

async function readPinnable(): Promise<PinnableCredential[]> {
  const credentials = await exportOmpCredentials(loadProviderLaunch("omp"));
  return credentials === null ? [] : buildPinnableCredentials(credentials);
}

async function readRedacting(settings: PreferencesSettings): Promise<boolean> {
  const state = await settings.read();
  return state.status === "ready" && state.values.redactEmails;
}

/** The pin store, read once per daemon; a missing or corrupt file starts empty */
function loadPins(): Promise<PinStore> {
  pinStore ??= readFile(PIN_STORE_FILE, "utf8").then(
    (text) => {
      try {
        const parsed = PinStoreSchema.safeParse(JSON.parse(text));
        return parsed.success ? parsed.data : {};
      } catch {
        return {};
      }
    },
    () => ({}),
  );
  return pinStore;
}

/** Writes the store atomically; writes are serialized so a slow one cannot overwrite a newer one */
function savePins(pins: PinStore): Promise<void> {
  const write = pendingWrite.then(async () => {
    await mkdir(path.dirname(PIN_STORE_FILE), { recursive: true });
    const temporary = `${PIN_STORE_FILE}.tmp`;
    await writeFile(temporary, JSON.stringify(pins), "utf8");
    await rename(temporary, PIN_STORE_FILE);
  });
  pendingWrite = write.catch(() => {});
  return write;
}

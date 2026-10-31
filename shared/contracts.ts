import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const preferences = defineSettings({
  id: "preferences",
  scope: "host",
  version: 1,
  schema: z.object({
    /** Mask email addresses everywhere the plugin displays them */
    redactEmails: z.boolean().default(false),
  }),
});

/** Paseo agent backend whose login the plugin manages; also its Paseo provider id */
export const BackendSchema = z.enum(["omp", "claude"]);
export type Backend = z.infer<typeof BackendSchema>;

export const BACKEND_LABELS: Record<Backend, string> = { omp: "omp", claude: "Claude Code" };

/** The slice of a Paseo provider snapshot (full or compact) that says which providers are enabled */
export interface ProviderSnapshotLike {
  entries: readonly { provider: string; enabled?: boolean }[];
  compactSnapshot?: { entries: readonly { provider: string; enabled?: boolean }[] };
}

/**
 * Backends whose Paseo provider is enabled, or null when the snapshot carries no entries to decide
 * from. A provider missing from the snapshot is not registered, so it counts as disabled.
 */
export function enabledBackends(snapshot: ProviderSnapshotLike): Backend[] | null {
  const entries = snapshot.entries.length > 0 ? snapshot.entries : (snapshot.compactSnapshot?.entries ?? []);
  if (entries.length === 0) return null;
  return BackendSchema.options.filter((backend) =>
    entries.some((entry) => entry.provider === backend && entry.enabled !== false),
  );
}

export const AccountStatusSchema = z.enum(["ok", "expiring", "expired", "disabled", "signed_out"]);
export type AccountStatus = z.infer<typeof AccountStatusSchema>;

export const AccountSchema = z.object({
  /** Stable row key: backend, provider, and identity */
  key: z.string(),
  backend: BackendSchema,
  /** omp credential provider id (the `omp login` argument), or Claude Code's auth method */
  provider: z.string(),
  type: z.enum(["oauth", "api_key"]),
  /** Email, account id, org name, or "API key" */
  label: z.string(),
  /** Email to pre-fill on the sign-in page, when the backend supports it */
  email: z.string().nullable(),
  orgName: z.string().nullable(),
  status: AccountStatusSchema,
  /** Human-readable status explanation */
  detail: z.string(),
  /** A live usage check succeeded for this account */
  verified: z.boolean(),
  /** The backend's login command can re-authenticate this account */
  canLogin: z.boolean(),
  /** The backend can delete this stored credential */
  canRemove: z.boolean(),
  /** omp's own label for the credential (`email (org)`), used to pick it for removal */
  logoutLabel: z.string().nullable(),
});
export type Account = z.infer<typeof AccountSchema>;

export const removeAccountRpc = defineRpc({
  name: "accounts.remove",
  input: z.object({
    backend: BackendSchema,
    provider: z.string().min(1),
    type: z.enum(["oauth", "api_key"]),
    logoutLabel: z.string().nullable(),
  }),
  /** `remainingSource` names auth that still applies after removal, such as an environment variable */
  output: z.object({ remainingSource: z.string().nullable() }),
});

export const listAccountsRpc = defineRpc({
  name: "accounts.list",
  input: z.object({}),
  output: z.object({
    accounts: z.array(AccountSchema),
    /** Backends whose Paseo provider is enabled; disabled ones are not queried or offered for login */
    enabledBackends: z.array(BackendSchema),
    /** Installed backends whose accounts could not be read; missing backends are omitted */
    errors: z.array(z.object({ backend: BackendSchema, message: z.string() })),
    checkedAt: z.number(),
  }),
});

export const PinnableAccountSchema = z.object({
  /** Same key as the account's sidebar row */
  key: z.string(),
  /** omp credential provider id; a pin applies while the agent's model uses this provider */
  provider: z.string(),
  /** omp's label (`email (org)`), masked when redactEmails is on */
  label: z.string(),
});
export type PinnableAccount = z.infer<typeof PinnableAccountSchema>;

export const listAccountPinsRpc = defineRpc({
  name: "pins.list",
  input: z.object({}),
  output: z.object({
    /** Stored omp OAuth accounts `/session pin` can select */
    accounts: z.array(PinnableAccountSchema),
    /** Agent id → provider → account key, for pins made through the plugin */
    pins: z.record(z.string(), z.record(z.string(), z.string())),
  }),
});

export const pinAccountRpc = defineRpc({
  name: "pins.set",
  input: z.object({ agentId: z.string().min(1), accountKey: z.string().min(1) }),
  /** omp's confirmation, such as `Pinned a@example.com to this session for Anthropic.` */
  output: z.object({ message: z.string() }),
});

/** The omp credential provider of an omp agent's `provider/model` id, or null when it has none */
export function modelProvider(model: string | null): string | null {
  const separator = model?.indexOf("/") ?? -1;
  return model && separator > 0 ? model.slice(0, separator) : null;
}

export const LoginStateSchema = z.enum(["running", "succeeded", "failed", "cancelled"]);
export type LoginState = z.infer<typeof LoginStateSchema>;

export const LoginSessionSchema = z.object({
  id: z.string(),
  backend: BackendSchema,
  /** Null when omp asks which provider to log in to */
  provider: z.string().nullable(),
  state: LoginStateSchema,
  /** The login command's terminal output with ANSI sequences removed */
  output: z.string(),
  /** URLs the login printed, in order; the first is the sign-in page */
  urls: z.array(z.string()),
  /** The login printed a prompt and is waiting for a line on stdin */
  awaitingInput: z.boolean(),
  /** Options of a pending numbered picker (omp's provider list); send `value` to choose one */
  choices: z.array(z.object({ value: z.string(), label: z.string() })),
  exitCode: z.number().nullable(),
});
export type LoginSession = z.infer<typeof LoginSessionSchema>;

const LoginIdInputSchema = z.object({ id: z.string().min(1) });

export const startLoginRpc = defineRpc({
  name: "login.start",
  input: z.object({
    backend: BackendSchema,
    provider: z.string().min(1).nullable(),
    email: z.string().min(1).nullable(),
  }),
  output: LoginSessionSchema,
});

export const loginStatusRpc = defineRpc({
  name: "login.status",
  input: LoginIdInputSchema,
  output: LoginSessionSchema.nullable(),
});

export const loginInputRpc = defineRpc({
  name: "login.input",
  input: LoginIdInputSchema.extend({ text: z.string() }),
  output: LoginSessionSchema,
});

export const cancelLoginRpc = defineRpc({
  name: "login.cancel",
  input: LoginIdInputSchema,
  output: LoginSessionSchema.nullable(),
});

import { z } from "zod";
import type { Account } from "../shared/contracts";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
// Mirrors omp's ANTHROPIC_OAUTH_GRANT_TTL_MS: Anthropic grants die ~30 days after login regardless of refresh
const ANTHROPIC_GRANT_TTL_MS = 30 * DAY_MS;
// Mirrors omp's RELOGIN_WARN_WINDOW_MS
const RELOGIN_WARN_WINDOW_MS = 7 * DAY_MS;
const ANTHROPIC_PROVIDER = "anthropic";

// Zod strips unknown keys, so access/refresh tokens and API keys never leave the parser
const ExportedCredentialSchema = z.object({
  provider: z.string(),
  credential: z.object({
    type: z.string(),
    email: z.string().optional(),
    accountId: z.string().optional(),
    projectId: z.string().optional(),
    enterpriseUrl: z.string().optional(),
    orgId: z.string().optional(),
    orgName: z.string().optional(),
    authorizedAt: z.number().optional(),
  }),
});

/**
 * omp's `/logout` label for an OAuth credential (slash-commands/helpers/logout.ts oauthLabel):
 * the first of email, account, project, or enterprise URL, plus `(org)` when the org differs.
 * Null when omp would fall back to a label built from its row id, which the export does not carry.
 */
export function ompLogoutLabel(credential: ExportedCredential["credential"]): string | null {
  const nonEmpty = (value: string | undefined) => (value?.trim() ? value.trim() : undefined);
  const base =
    nonEmpty(credential.email) ??
    nonEmpty(credential.accountId) ??
    nonEmpty(credential.projectId) ??
    nonEmpty(credential.enterpriseUrl);
  if (!base) return null;
  const org = nonEmpty(credential.orgName) ?? nonEmpty(credential.orgId);
  return org && org !== base ? `${base} (${org})` : base;
}
const AuthExportSchema = z.object({ credentials: z.array(ExportedCredentialSchema) });
export type ExportedCredential = z.infer<typeof ExportedCredentialSchema>;

const IdentitySchema = z.object({
  email: z.string().optional(),
  accountId: z.string().optional(),
  orgId: z.string().optional(),
});
const UsageJsonSchema = z.object({
  reports: z
    .array(z.object({ provider: z.string(), metadata: IdentitySchema.optional() }))
    .default([]),
  disabledCredentials: z
    .array(
      IdentitySchema.extend({
        provider: z.string(),
        type: z.string(),
        orgName: z.string().optional(),
        cause: z.string(),
        disabledAtMs: z.number().optional(),
      }),
    )
    .default([]),
});
export type UsageSnapshot = z.infer<typeof UsageJsonSchema>;

/** Parses `omp auth export` output into identity-only rows; throws without echoing the secret input */
export function parseAuthExport(stdout: string): ExportedCredential[] {
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    throw new Error("omp auth export did not print JSON");
  }
  const parsed = AuthExportSchema.safeParse(json);
  if (!parsed.success) throw new Error("omp auth export printed an unexpected shape");
  return parsed.data.credentials;
}

/** Parses `omp usage --json`; returns null when the output is unusable */
export function parseUsage(stdout: string): UsageSnapshot | null {
  try {
    const parsed = UsageJsonSchema.safeParse(JSON.parse(stdout));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Combines stored credentials with the live usage check and disabled tombstones into sidebar rows */
export function buildAccounts(
  credentials: readonly ExportedCredential[],
  usage: UsageSnapshot | null,
  nowMs: number,
): Account[] {
  const accounts: Account[] = [];
  for (const { provider, credential } of credentials) {
    const identity = identityKey(credential);
    if (credential.type !== "oauth") {
      accounts.push({
        key: `omp|${provider}|api_key|${accounts.length}`,
        backend: "omp",
        provider,
        type: "api_key",
        label: "API key",
        email: null,
        orgName: null,
        status: "ok",
        detail: "Stored API key",
        verified: false,
        canLogin: false,
        canRemove: true,
        logoutLabel: null,
      });
      continue;
    }
    const verified = usage?.reports.some(
      (report) => report.provider === provider && identitiesOverlap(report.metadata, credential),
    );
    const base = {
      key: `omp|${provider}|${identity}`,
      backend: "omp" as const,
      provider,
      type: "oauth" as const,
      label: credential.email ?? credential.accountId ?? credential.orgName ?? "OAuth account",
      email: credential.email ?? null,
      orgName: credential.orgName ?? null,
      verified: verified === true,
      canLogin: true,
      canRemove: true,
      logoutLabel: ompLogoutLabel(credential),
    };
    const remainingMs = grantRemainingMs(provider, credential.authorizedAt, nowMs);
    if (remainingMs !== null && remainingMs <= 0) {
      accounts.push({ ...base, status: "expired", detail: "Grant is past Anthropic's ~30 day lifetime; log in again" });
      continue;
    }
    if (remainingMs !== null && remainingMs <= RELOGIN_WARN_WINDOW_MS) {
      accounts.push({ ...base, status: "expiring", detail: `Log in again within ${formatDuration(remainingMs)}` });
      continue;
    }
    accounts.push({
      ...base,
      status: "ok",
      detail: base.verified ? "Authenticated; usage check passed" : "Authenticated",
    });
  }
  for (const disabled of usage?.disabledCredentials ?? []) {
    if (disabled.type !== "oauth") continue;
    const replaced = credentials.some(
      (stored) => stored.provider === disabled.provider && identitiesOverlap(disabled, stored.credential),
    );
    if (replaced) continue;
    const ago = disabled.disabledAtMs === undefined ? "" : ` ${formatDuration(nowMs - disabled.disabledAtMs)} ago`;
    accounts.push({
      key: `omp|${disabled.provider}|disabled|${identityKey(disabled)}`,
      backend: "omp",
      provider: disabled.provider,
      type: "oauth",
      label: disabled.email ?? disabled.accountId ?? disabled.orgName ?? "OAuth account",
      email: disabled.email ?? null,
      orgName: disabled.orgName ?? null,
      status: "disabled",
      detail: `Disabled${ago}: ${disabled.cause}`,
      verified: false,
      canLogin: true,
      // Tombstones are not in omp's logout list; logging in again replaces them
      canRemove: false,
      logoutLabel: null,
    });
  }
  return accounts;
}

/** A stored omp OAuth account that `/session pin` can select */
export interface PinnableCredential {
  /** Same key as the account's sidebar row */
  key: string;
  provider: string;
  /** omp's label for the credential, which `/session pin <label>` matches exactly */
  selector: string;
}

/** OAuth credentials `/session pin` can name; API keys and label-less rows cannot be pinned by name */
export function buildPinnableCredentials(credentials: readonly ExportedCredential[]): PinnableCredential[] {
  const pinnable: PinnableCredential[] = [];
  for (const { provider, credential } of credentials) {
    if (credential.type !== "oauth") continue;
    const selector = ompLogoutLabel(credential);
    if (selector === null) continue;
    pinnable.push({ key: `omp|${provider}|${identityKey(credential)}`, provider, selector });
  }
  return pinnable;
}

/** One row of omp's RPC `get_logout_accounts` result */
export interface OmpLogoutAccount {
  credentialId: number;
  label: string;
  type: string;
}

/**
 * Picks the omp credential to remove: the row with the account's type and logout label, or the
 * only row of that type when the label is unknown. Throws rather than guess between several rows.
 */
export function selectLogoutCredential(
  candidates: readonly OmpLogoutAccount[],
  type: "oauth" | "api_key",
  logoutLabel: string | null,
): number {
  const ofType = candidates.filter((candidate) => candidate.type === type);
  const matches = logoutLabel === null ? ofType : ofType.filter((candidate) => candidate.label === logoutLabel);
  if (matches.length === 1) return matches[0]!.credentialId;
  if (matches.length === 0) throw new Error("omp no longer stores this account");
  throw new Error("omp stores several matching accounts; remove it from omp's /logout instead");
}

// `claude auth status --json`; it reports identity only, never tokens
const ClaudeStatusSchema = z.object({
  loggedIn: z.boolean(),
  authMethod: z.string().optional(),
  apiProvider: z.string().optional(),
  email: z.string().optional(),
  orgId: z.string().optional(),
  orgName: z.string().optional(),
  subscriptionType: z.string().nullable().optional(),
});
// Methods `claude auth login` can redo; other values come from env keys or cloud credentials
const CLAUDE_LOGIN_METHODS = ["claude.ai", "console"];
const CLAUDE_FIRST_PARTY = "firstParty";

/** Builds the Claude Code row from `claude auth status --json`; throws on unusable output */
export function buildClaudeAccount(stdout: string): Account {
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    throw new Error("claude auth status did not print JSON");
  }
  const parsed = ClaudeStatusSchema.safeParse(json);
  if (!parsed.success) throw new Error("claude auth status printed an unexpected shape");
  const status = parsed.data;
  const method = status.authMethod ?? "none";
  const base = {
    key: `claude|${method}|${status.email ?? ""}|${status.orgId ?? ""}`,
    backend: "claude" as const,
    provider: method,
    email: status.email ?? null,
    orgName: status.orgName ?? null,
    verified: false,
    logoutLabel: null,
  };
  if (!status.loggedIn) {
    return {
      ...base,
      type: "oauth",
      label: "Not logged in",
      status: "signed_out",
      detail: "Claude Code is not logged in",
      canLogin: true,
      canRemove: false,
    };
  }
  const firstParty = (status.apiProvider ?? CLAUDE_FIRST_PARTY) === CLAUDE_FIRST_PARTY;
  const canLogin = firstParty && CLAUDE_LOGIN_METHODS.includes(method);
  const plan = status.subscriptionType ? `${status.subscriptionType} plan, ` : "";
  return {
    ...base,
    type: canLogin ? "oauth" : "api_key",
    label: status.email ?? status.orgName ?? method,
    status: "ok",
    detail: canLogin
      ? `Logged in (${plan}via ${method})`
      : `Authenticated via ${method}${firstParty ? "" : ` on ${status.apiProvider}`}; managed outside Claude Code login`,
    canLogin,
    // `claude auth logout` only clears what `claude auth login` stored
    canRemove: canLogin,
  };
}

/** Milliseconds left on a fixed-lifetime OAuth grant, or null when the provider has none */
function grantRemainingMs(provider: string, authorizedAt: number | undefined, nowMs: number): number | null {
  if (provider !== ANTHROPIC_PROVIDER || authorizedAt === undefined) return null;
  return authorizedAt + ANTHROPIC_GRANT_TTL_MS - nowMs;
}

function identityKey(identity: z.infer<typeof IdentitySchema>): string {
  return [identity.email, identity.accountId, identity.orgId].map((part) => part ?? "").join("|");
}

function identitiesOverlap(
  left: z.infer<typeof IdentitySchema> | undefined,
  right: z.infer<typeof IdentitySchema>,
): boolean {
  if (!left) return false;
  const leftValues = [left.email, left.accountId, left.orgId]
    .filter((value): value is string => Boolean(value))
    .map((value) => value.toLowerCase());
  return [right.email, right.accountId, right.orgId].some(
    (value) => Boolean(value) && leftValues.includes(value!.toLowerCase()),
  );
}

/** Compact duration such as `3d 4h` or `5h` */
export function formatDuration(durationMs: number): string {
  const totalHours = Math.max(0, Math.floor(durationMs / HOUR_MS));
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  if (days === 0) return `${hours}h`;
  return hours === 0 ? `${days}d` : `${days}d ${hours}h`;
}

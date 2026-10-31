import assert from "node:assert/strict";
import { test } from "node:test";
import { enabledBackends } from "../shared/contracts.ts";
import {
  buildAccounts,
  buildClaudeAccount,
  buildPinnableCredentials,
  formatDuration,
  ompLogoutLabel,
  parseAuthExport,
  parseUsage,
  selectLogoutCredential,
} from "./account-model.ts";

test("enabledBackends follows Paseo's snapshot, full or compact", () => {
  const entries = [
    { provider: "claude", enabled: false },
    { provider: "omp", enabled: true },
    { provider: "codex" },
  ];
  assert.deepEqual(enabledBackends({ entries }), ["omp"]);
  assert.deepEqual(enabledBackends({ entries: [], compactSnapshot: { entries } }), ["omp"]);
  assert.deepEqual(enabledBackends({ entries: [{ provider: "claude" }] }), ["claude"]);
  assert.equal(enabledBackends({ entries: [] }), null);
});

test("ompLogoutLabel mirrors omp's /logout labels", () => {
  assert.equal(ompLogoutLabel({ type: "oauth", email: "a@example.com", orgName: "Org" }), "a@example.com (Org)");
  assert.equal(ompLogoutLabel({ type: "oauth", email: "a@example.com", orgName: "a@example.com" }), "a@example.com");
  assert.equal(ompLogoutLabel({ type: "oauth", accountId: "acct", orgId: "org-1" }), "acct (org-1)");
  assert.equal(ompLogoutLabel({ type: "oauth", orgName: "Org" }), null);
});

test("selectLogoutCredential picks by type and label and refuses to guess", () => {
  const listed = [
    { credentialId: 1, label: "a@example.com (Org)", type: "oauth" },
    { credentialId: 2, label: "b@example.com", type: "oauth" },
    { credentialId: 3, label: "API key #3", type: "api_key" },
  ];
  assert.equal(selectLogoutCredential(listed, "oauth", "b@example.com"), 2);
  assert.equal(selectLogoutCredential(listed, "api_key", null), 3);
  assert.throws(() => selectLogoutCredential(listed, "oauth", null), /several/);
  assert.throws(() => selectLogoutCredential(listed, "oauth", "gone@example.com"), /no longer/);
});

test("Claude Code subscription logins are re-loginable with the email pre-filled", () => {
  const account = buildClaudeAccount(
    JSON.stringify({
      loggedIn: true,
      authMethod: "claude.ai",
      apiProvider: "firstParty",
      email: "a@example.com",
      orgId: "org-1",
      orgName: "Org",
      subscriptionType: "max",
    }),
  );
  assert.equal(account.backend, "claude");
  assert.equal(account.status, "ok");
  assert.equal(account.canLogin, true);
  assert.equal(account.email, "a@example.com");
  assert.match(account.detail, /max plan, via claude\.ai/);
});

test("Claude Code logged out offers a login", () => {
  const account = buildClaudeAccount(JSON.stringify({ loggedIn: false, authMethod: "none" }));
  assert.equal(account.status, "signed_out");
  assert.equal(account.canLogin, true);
});

test("Claude Code on Bedrock or an env API key is not re-loginable", () => {
  const bedrock = buildClaudeAccount(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "bedrock" }));
  const apiKey = buildClaudeAccount(JSON.stringify({ loggedIn: true, authMethod: "api_key", apiProvider: "firstParty" }));
  assert.equal(bedrock.canLogin, false);
  assert.match(bedrock.detail, /on bedrock/);
  assert.equal(apiKey.canLogin, false);
  assert.equal(apiKey.type, "api_key");
});

test("buildClaudeAccount rejects unusable output", () => {
  assert.throws(() => buildClaudeAccount("Not JSON"));
  assert.throws(() => buildClaudeAccount("{}"));
});

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW_MS = Date.UTC(2026, 9, 24);

test("parseAuthExport drops tokens and API keys", () => {
  const credentials = parseAuthExport(
    JSON.stringify({
      version: 1,
      credentials: [
        {
          provider: "anthropic",
          credential: { type: "oauth", access: "secret-access", refresh: "secret-refresh", email: "a@example.com" },
        },
        { provider: "openai", credential: { type: "api_key", key: "secret-key" } },
      ],
    }),
  );
  assert.equal(JSON.stringify(credentials).includes("secret"), false);
  assert.equal(credentials[0]!.credential.email, "a@example.com");
});

test("parseAuthExport errors never echo the payload", () => {
  assert.throws(() => parseAuthExport("not json secret-access"), (error: Error) => !error.message.includes("secret"));
});

test("Anthropic grants expire 30 days after login and warn inside the last week", () => {
  const credential = (authorizedAt: number) => ({
    provider: "anthropic",
    credential: { type: "oauth", email: "a@example.com", authorizedAt },
  });
  const [fresh] = buildAccounts([credential(NOW_MS - 1 * DAY_MS)], null, NOW_MS);
  const [expiring] = buildAccounts([credential(NOW_MS - 25 * DAY_MS)], null, NOW_MS);
  const [expired] = buildAccounts([credential(NOW_MS - 31 * DAY_MS)], null, NOW_MS);
  assert.equal(fresh!.status, "ok");
  assert.equal(expiring!.status, "expiring");
  assert.match(expiring!.detail, /5d/);
  assert.equal(expired!.status, "expired");
  assert.equal(expired!.canLogin, true);
});

test("Non-Anthropic OAuth has no fixed grant lifetime", () => {
  const [account] = buildAccounts(
    [{ provider: "openai-codex", credential: { type: "oauth", email: "a@example.com", authorizedAt: 0 } }],
    null,
    NOW_MS,
  );
  assert.equal(account!.status, "ok");
});

test("A matching usage report marks the account verified", () => {
  const usage = parseUsage(
    JSON.stringify({ reports: [{ provider: "anthropic", metadata: { email: "A@example.com" } }], disabledCredentials: [] }),
  );
  const [account] = buildAccounts(
    [{ provider: "anthropic", credential: { type: "oauth", email: "a@example.com", authorizedAt: NOW_MS } }],
    usage,
    NOW_MS,
  );
  assert.equal(account!.verified, true);
});

test("Disabled tombstones appear unless an active credential replaced them", () => {
  const usage = parseUsage(
    JSON.stringify({
      reports: [],
      disabledCredentials: [
        { provider: "anthropic", type: "oauth", email: "old@example.com", cause: "refresh failed", disabledAtMs: NOW_MS - 2 * DAY_MS },
        { provider: "anthropic", type: "oauth", email: "a@example.com", cause: "refresh failed" },
      ],
    }),
  );
  const accounts = buildAccounts(
    [{ provider: "anthropic", credential: { type: "oauth", email: "a@example.com", authorizedAt: NOW_MS } }],
    usage,
    NOW_MS,
  );
  assert.equal(accounts.length, 2);
  assert.equal(accounts[1]!.status, "disabled");
  assert.equal(accounts[1]!.label, "old@example.com");
  assert.match(accounts[1]!.detail, /2d ago: refresh failed/);
});

test("API keys are listed but not re-loginable", () => {
  const [account] = buildAccounts([{ provider: "openai", credential: { type: "api_key" } }], null, NOW_MS);
  assert.equal(account!.type, "api_key");
  assert.equal(account!.canLogin, false);
});

test("Pinnable accounts carry omp's exact label and the sidebar row key; API keys are left out", () => {
  const credentials = [
    { provider: "anthropic", credential: { type: "oauth", email: "a@example.com", orgId: "org-1", orgName: "Org" } },
    { provider: "anthropic", credential: { type: "oauth", email: "b@example.com", orgName: "b@example.com" } },
    { provider: "anthropic", credential: { type: "api_key" } },
    { provider: "anthropic", credential: { type: "oauth", orgName: "Unnamed" } },
  ];
  const pinnable = buildPinnableCredentials(credentials);
  assert.deepEqual(
    pinnable.map(({ selector }) => selector),
    ["a@example.com (Org)", "b@example.com"],
  );
  const rowKeys = buildAccounts(credentials.slice(0, 2), null, NOW_MS).map(({ key }) => key);
  assert.deepEqual(
    pinnable.map(({ key }) => key),
    rowKeys,
  );
});

test("parseUsage returns null for unusable output", () => {
  assert.equal(parseUsage("oops"), null);
});

test("formatDuration", () => {
  assert.equal(formatDuration(5 * 60 * 60 * 1000), "5h");
  assert.equal(formatDuration(3 * DAY_MS), "3d");
  assert.equal(formatDuration(3 * DAY_MS + 4 * 60 * 60 * 1000), "3d 4h");
  assert.equal(formatDuration(-1), "0h");
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { redactEmails } from "../shared/redact.ts";

test("redactEmails masks every address, including inside org names and URLs", () => {
  assert.equal(redactEmails("alice.smith@mail.example.co.uk"), "a***@***.uk");
  assert.equal(
    redactEmails("bob@example.com (bob@example.com's Organization)"),
    "b***@***.com (b***@***.com's Organization)",
  );
  assert.equal(redactEmails("Claude Code · Not logged in"), "Claude Code · Not logged in");
  assert.equal(
    redactEmails("https://claude.com/oauth/authorize?login_hint=bob%40example.com&state=x"),
    "https://claude.com/oauth/authorize?login_hint=b***%40***.com&state=x",
  );
});

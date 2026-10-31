import assert from "node:assert/strict";
import { test } from "node:test";
import { loginArguments } from "./login-arguments.ts";

test("omp logs in to a provider, or picks one when none is given", () => {
  assert.deepEqual(loginArguments("omp", "anthropic", "a@example.com"), ["login", "anthropic"]);
  assert.deepEqual(loginArguments("omp", null, null), ["login"]);
});

test("Claude Code keeps the auth method and pre-fills the email", () => {
  assert.deepEqual(loginArguments("claude", "claude.ai", "a@example.com"), ["auth", "login", "--email", "a@example.com"]);
  assert.deepEqual(loginArguments("claude", "console", null), ["auth", "login", "--console"]);
  assert.deepEqual(loginArguments("claude", null, null), ["auth", "login"]);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveProviderLaunch } from "./provider-command.ts";

const noFiles = () => false;

test("Paseo's command override wins and keeps its argv prefix and env", () => {
  const launch = resolveProviderLaunch(
    "omp",
    { agents: { providers: { omp: { command: ["C:\\omp\\omp.exe", "--profile", "work"], env: { OMP_PROFILE: "work" } } } } },
    { OMP_COMMAND: "ignored", PATH: "x" },
    noFiles,
  );
  assert.equal(launch.command, "C:\\omp\\omp.exe");
  assert.deepEqual(launch.prefixArgs, ["--profile", "work"]);
  assert.equal(launch.env.OMP_PROFILE, "work");
  assert.equal(launch.env.PATH, "x");
});

test("Overrides are per backend", () => {
  const config = { agents: { providers: { omp: { command: ["C:\\omp.exe"] }, claude: { env: { CLAUDE_CONFIG_DIR: "D:\\c" } } } } };
  const claude = resolveProviderLaunch("claude", config, {}, noFiles);
  assert.equal(claude.command, "claude");
  assert.equal(claude.env.CLAUDE_CONFIG_DIR, "D:\\c");
});

test("OMP_COMMAND is used without an override, and only for omp", () => {
  assert.equal(resolveProviderLaunch("omp", {}, { OMP_COMMAND: "D:\\omp.exe" }, noFiles).command, "D:\\omp.exe");
  assert.equal(resolveProviderLaunch("claude", {}, { OMP_COMMAND: "D:\\omp.exe" }, noFiles).command, "claude");
});

test("The installer location beats a bare PATH lookup", () => {
  const exists = (filePath: string) => filePath.endsWith(".exe");
  assert.match(resolveProviderLaunch("omp", null, { LOCALAPPDATA: "C:\\Local" }, exists).command, /omp\.exe$/);
  assert.match(
    resolveProviderLaunch("claude", null, { USERPROFILE: "C:\\Users\\me" }, exists).command,
    /\.local\\bin\\claude\.exe$/,
  );
  assert.equal(resolveProviderLaunch("omp", null, {}, noFiles).command, "omp");
});

test("Malformed overrides are ignored", () => {
  const launch = resolveProviderLaunch("omp", { agents: { providers: { omp: { command: [""], env: { A: 1 } } } } }, {}, noFiles);
  assert.equal(launch.command, "omp");
  assert.equal(launch.env.A, undefined);
});

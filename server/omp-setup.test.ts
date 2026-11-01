import assert from "node:assert/strict";
import { test } from "node:test";
import { isOlderVersion, MINIMUM_OMP_VERSION, parseVersion, providerPatch } from "./omp-setup.ts";

const OMP = "C:\\Users\\me\\AppData\\Local\\omp\\omp.exe";

test("A fresh Paseo gets the omp provider turned on and pinned to the omp found or installed", () => {
  assert.deepEqual(providerPatch(undefined, OMP), { enabled: true, command: [OMP] });
  assert.deepEqual(providerPatch({}, OMP), { enabled: true, command: [OMP] });
});

test("Setup fills only what the user left unset and leaves a provider they turned off alone", () => {
  // Their own command stays; only the switch is filled in
  assert.deepEqual(providerPatch({ command: ["D:\\tools\\omp.exe"] }, null), { enabled: true });
  assert.deepEqual(providerPatch({ enabled: true }, OMP), { command: [OMP] });
  assert.equal(providerPatch({ enabled: true, command: [OMP] }, OMP), null);
  assert.equal(providerPatch({ enabled: false }, OMP), null);
});

test("Without an omp to point at, the provider is not turned on", () => {
  assert.equal(providerPatch(undefined, null), null);
});

test("Versions compare numerically against Paseo's minimum", () => {
  assert.equal(parseVersion("omp 18.10.2 (windows-x86_64)\r\n"), "18.10.2");
  assert.equal(parseVersion("omp dev build"), null);
  assert.equal(isOlderVersion("16.3.8", MINIMUM_OMP_VERSION), true);
  assert.equal(isOlderVersion("16.10.0", MINIMUM_OMP_VERSION), false);
  assert.equal(isOlderVersion(MINIMUM_OMP_VERSION, MINIMUM_OMP_VERSION), false);
});

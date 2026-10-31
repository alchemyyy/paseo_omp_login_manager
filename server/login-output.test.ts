import assert from "node:assert/strict";
import { test } from "node:test";
import { endsWithPrompt, extractUrls, parseNumberedChoices, stripTerminalCodes } from "./login-output.ts";

test("parseNumberedChoices reads omp's provider picker", () => {
  const output = "Select a provider:\n\n  1. Anthropic (Claude Pro/Max)\n  2. ChatGPT Plus/Pro (Codex)\n  10. vLLM (Local OpenAI-compatible)\n\nEnter number (1-3): ";
  assert.deepEqual(parseNumberedChoices(output), []);
  const complete = "Select a provider:\n\n  1. Anthropic (Claude Pro/Max)\n  2. ChatGPT Plus/Pro (Codex)\n  3. vLLM (Local OpenAI-compatible)\n\nEnter number (1-3): ";
  assert.deepEqual(parseNumberedChoices(complete), [
    { value: "1", label: "Anthropic (Claude Pro/Max)" },
    { value: "2", label: "ChatGPT Plus/Pro (Codex)" },
    { value: "3", label: "vLLM (Local OpenAI-compatible)" },
  ]);
});

test("parseNumberedChoices ignores answered pickers and other prompts", () => {
  assert.deepEqual(parseNumberedChoices("  1. A\n\nEnter number (1-1): \nLogin failed\n"), []);
  assert.deepEqual(parseNumberedChoices("Paste code here if prompted > "), []);
});

test("stripTerminalCodes removes colors, hyperlinks, and carriage returns", () => {
  assert.equal(stripTerminalCodes("\u001b[32mLogged in\u001b[0m\r\n"), "Logged in\n");
  assert.equal(stripTerminalCodes("\u001b]8;;https://x.test\u0007link\u001b]8;;\u0007"), "link");
});

test("extractUrls keeps order, dedupes, and trims trailing punctuation", () => {
  const output =
    "Open this URL in your browser:\nhttps://claude.ai/oauth/authorize?code=true&state=abc\n" +
    "Local shortcut (this machine only): http://localhost:54545/launch.\n" +
    "https://claude.ai/oauth/authorize?code=true&state=abc\n";
  assert.deepEqual(extractUrls(output), [
    "https://claude.ai/oauth/authorize?code=true&state=abc",
    "http://localhost:54545/launch",
  ]);
});

test("endsWithPrompt detects readline questions only", () => {
  assert.equal(endsWithPrompt("Select a provider:\n\n  1. Anthropic\n\nEnter number (1-1): "), true);
  assert.equal(endsWithPrompt("Open this URL in your browser:\nhttps://x.test\n\n"), false);
  assert.equal(endsWithPrompt(""), false);
});

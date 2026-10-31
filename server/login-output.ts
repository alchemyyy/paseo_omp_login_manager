// CSI sequences (colors, cursor moves) and OSC sequences (titles, hyperlinks)
const ANSI_SEQUENCE = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
const URL_PATTERN = /https?:\/\/[^\s"'<>]+/g;
const TRAILING_PUNCTUATION = /[).,;]+$/;

/** Removes ANSI escape sequences and carriage returns from terminal output */
export function stripTerminalCodes(text: string): string {
  return text.replace(ANSI_SEQUENCE, "").replace(/\r/g, "");
}

/** Distinct http(s) URLs in output order */
export function extractUrls(text: string): string[] {
  const urls: string[] = [];
  for (const match of text.matchAll(URL_PATTERN)) {
    const url = match[0].replace(TRAILING_PUNCTUATION, "");
    if (!urls.includes(url)) urls.push(url);
  }
  return urls;
}

// omp's pickIndex: "  12. Label" rows, then "Enter number (1-N): "
const NUMBERED_PROMPT = /Enter number \(1-(\d+)\): *$/;
const NUMBERED_ROW = /^\s+(\d+)\.\s+(.+?)\s*$/;

export interface PromptChoice {
  /** Text to send on stdin */
  value: string;
  label: string;
}

/**
 * The options of a pending numbered picker, so the UI can offer them as buttons; empty unless the
 * output ends at the picker's prompt and every listed number is present.
 */
export function parseNumberedChoices(text: string): PromptChoice[] {
  const prompt = NUMBERED_PROMPT.exec(text);
  if (!prompt) return [];
  const count = Number(prompt[1]);
  const choices: PromptChoice[] = [];
  const lines = text.slice(0, prompt.index).split("\n");
  // Walk up from the prompt; the list ends at the first non-row line after its rows
  for (let index = lines.length - 1; index >= 0; index--) {
    const row = NUMBERED_ROW.exec(lines[index]!);
    if (row) {
      choices.unshift({ value: row[1]!, label: row[2]! });
      continue;
    }
    if (choices.length > 0) break;
  }
  const complete = choices.length === count && choices.every((choice, position) => choice.value === String(position + 1));
  return complete ? choices : [];
}

/**
 * True when the output ends in an unterminated line such as `Enter number (1-5): `.
 * omp prompts through readline, which writes the question without a newline.
 */
export function endsWithPrompt(text: string): boolean {
  if (text.length === 0 || text.endsWith("\n")) return false;
  const lastLine = text.slice(text.lastIndexOf("\n") + 1);
  return lastLine.trim().length > 0;
}

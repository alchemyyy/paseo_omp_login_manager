// Plain or URL-encoded (%40) addresses; the latter appear in pre-filled sign-in URLs
const EMAIL_PATTERN = /([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*?(@|%40)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*(\.[A-Za-z]{2,})/g;

/** Masks every email address in the text to `a***@***.com`, keeping only the first letter and TLD */
export function redactEmails(text: string): string {
  return text.replace(EMAIL_PATTERN, (_match, first: string, at: string, tld: string) => `${first}***${at}***${tld}`);
}

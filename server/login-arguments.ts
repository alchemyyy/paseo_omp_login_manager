import type { Backend } from "../shared/contracts";

const CLAUDE_CONSOLE_METHOD = "console";

/** The backend's own login command; `provider` is omp's provider id or Claude Code's auth method */
export function loginArguments(backend: Backend, provider: string | null, email: string | null): string[] {
  switch (backend) {
    case "omp":
      return ["login", ...(provider ? [provider] : [])];
    case "claude":
      return [
        "auth",
        "login",
        ...(provider === CLAUDE_CONSOLE_METHOD ? ["--console"] : []),
        ...(email ? ["--email", email] : []),
      ];
  }
}

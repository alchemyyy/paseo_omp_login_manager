# Login manager

Paseo plugin that lists Claude Code and [oh-my-pi](https://github.com/can1357/oh-my-pi) (omp) accounts and their authentication status in the sidebar, re-authenticates them with one click, and lets each omp agent pick which account it uses.

## Install

1. Install [Paseo](https://paseo.sh) (0.13.0 or later) and launch it once. For Claude Code accounts, install [Claude Code](https://claude.com/claude-code).
2. Run the setup script from the parent `paseo_plugins` folder:

   ```powershell
   powershell -ExecutionPolicy Bypass -File ..\install-omp-paseo.ps1
   ```

   It installs omp (prebuilt binary via omp.sh into `%LOCALAPPDATA%\omp`), backs up `~/.paseo/config.json` to `config.json.bak`, enables Paseo's omp provider (pinned to the absolute `omp.exe`) and plugins, then runs this folder's `install.ps1 -ReloadDaemon`.
   Options: `-Ref v<version>` pins an omp release. `-PaseoCli <path>` points to `paseo.cmd` if it is not found automatically.
3. Reload the Paseo window. In the sidebar's **Accounts** section, press **+** and choose Claude Code or omp to log in.

`install.ps1` in this folder installs the plugin with `paseo plugin install <folder>`, or runs `paseo plugin reload` if it is already installed; use it after editing the plugin. Options: `-PaseoCli <path>`, and `-ReloadDaemon` to run `paseo daemon reload` first. It warns if plugins are disabled in Paseo's config.

## Features

### Accounts sidebar section

- One row per account: `Claude Code · <email>` or `omp <provider> · <label>`. Accounts of a backend whose Paseo provider is disabled are not queried; with both disabled the section is hidden.
- Status icon per row: ok (check), expiring (clock), expired (alert), disabled (cross), signed out (dashed circle). omp Anthropic OAuth grants are flagged expiring within 7 days of their ~30-day lifetime and expired after it; omp accounts disabled by omp show the cause. A live `omp usage --json` check marks accounts as verified.
- Clicking a row opens details (source, org, OAuth/API key, status text) with **Log in again** and **Remove**. The refresh icon on a row re-runs that account's login, pre-filling its email for Claude Code.
- **Remove** asks for confirmation, then runs `claude auth logout`, or deletes the single omp credential through omp's RPC mode (`--no-session`). If another source such as an environment variable still provides credentials, a warning says so.
- Header: click it to re-check (shows "Accounts (checking)"); **+** opens a menu to log in to Claude Code or omp (omp then asks which provider) and to reload the Paseo window. Right-click the header (web/desktop) to toggle **Hide email addresses**, a host-scoped setting (default off) that masks emails in rows, details, login output, and the account control.
- Errors appear as "Accounts unavailable" or "<backend> unavailable" rows; click for the message. With no accounts, a "No accounts; log in" row appears. Backends that are not installed are skipped.
- The list re-checks every 60 seconds and when a provider is toggled in Paseo's settings. When stored credentials change, including logins made in a terminal, the plugin refreshes Paseo's matching provider so models and availability follow.

### Login window

- Runs `omp login [provider]` or `claude auth login [--console] [--email <email>]` with the same binary and environment Paseo's provider uses (`agents.providers.<backend>.command`/`env` in Paseo's config). Only one login runs at a time.
- Shows live output, an **Open sign-in page** link and **Copy link**, a clickable (filterable) provider picker for omp, and a text field for prompts such as a pasted authorization code. **Cancel login** stops the process.
- On success Paseo's provider is refreshed and the window reloads after 1.5 seconds (web/desktop); the app and running agents keep going.

### Switching accounts per agent

omp can hold several logins for the same provider, for example two Claude accounts. Log in to each one with **+** in the sidebar. All Paseo omp agents share the same omp install, so extensions and settings stay the same.

When the provider of an omp agent's model has two or more stored OAuth accounts, an account control appears in that agent's composer toolbar, after the model, thinking, and mode controls. Until you pick an account it reads **Auto**, and omp chooses the account. Choosing an account sends omp's `/session pin <account>` to the agent: the command and omp's confirmation appear in the chat, and the control then shows the chosen account. omp keeps that account for the session, including after a resume. It moves to another account only if the chosen one is blocked or its token refresh fails. You can switch only while the agent is idle, because omp refuses to pin during a turn.

The plugin remembers each pick in `~/.paseo/plugin-data/omp-login-manager/account-pins.json` (under `PASEO_HOME` if set) and forgets it when the agent is archived. omp has no unpin command, so to return an agent to **Auto**, start a new agent.

## Limitations

- Paseo's plugin SDK has no toolbar slot, so the account control finds the toolbar through the app's internal element ids (`combined-model-selector`, `agent-thinking-selector`, `mode-control`) and works on web/desktop only. A Paseo update that renames them hides the control; switching still works by typing `/session pin <account>` in the chat.
- Only the first 200 agents get a control at startup; later agents are added as they update.
- Sign-in pages open in the browser on the Paseo host machine.
- The install scripts are PowerShell (Windows).

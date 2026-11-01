# Login manager

Paseo plugin that lists Claude Code and [oh-my-pi](https://github.com/can1357/oh-my-pi) (omp) accounts and their authentication status in the sidebar, re-authenticates them with one click, and lets each omp agent pick which account it uses.

## Install

Requires [Paseo](https://paseo.sh) 0.13.0 or later with plugins turned on (Settings > Plugins > Enable plugins). For Claude Code accounts, install [Claude Code](https://claude.com/claude-code).

```sh
paseo plugin install https://github.com/alchemyyy/paseo_omp_login_manager
```

The first time a Paseo window shows the plugin, it sets up omp on its own and shows each step in the sidebar's **Accounts** section:

- It installs omp with omp's official installer (the prebuilt binary, SHA-256 checked, into `%LOCALAPPDATA%\omp`, or `PI_INSTALL_DIR` if set) when omp is missing or older than Paseo's minimum, 16.3.9. This happens on Windows only; on macOS and Linux, install omp first (`curl -fsSL https://omp.sh/install | sh`).
- It turns on Paseo's omp provider and points it at that omp by absolute path, so a daemon started before omp was on `PATH` still finds it. Settings you made stay: a provider you turned off stays off, and a command you set is kept.

Setup runs once and then records itself in `~/.paseo/plugin-data/omp-login-manager/setup.json` (under `PASEO_HOME` if set); delete that file to run it again. A failed step shows as **omp setup failed** (click it for the reason) and runs again within 10 minutes or when the plugin reloads. Once setup is done, press **+** in the **Accounts** section and choose Claude Code or omp to log in.

`paseo plugin update omp-login-manager` updates the plugin, and `paseo plugin remove omp-login-manager` removes it (omp and its logins stay). The [Plugin manager](https://github.com/alchemyyy/paseo_plugin_manager) plugin checks and updates installed plugins from the sidebar.

The `paseo` command comes with the desktop app: Settings > Integrations > Command line puts it on `PATH`, or run `paseo.cmd` from the app's `resources\bin` folder.

To work on the plugin, clone this repository and install the folder instead (`paseo plugin install <folder>`), then run `paseo plugin reload omp-login-manager` after editing it.

## Features

### Accounts sidebar section

- One row per account: `Claude Code · <email>` or `omp <provider> · <label>`. Accounts of a backend whose Paseo provider is disabled are not queried; with both disabled the section is hidden, unless first-run setup is still working or has failed.
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
- omp is installed automatically only on Windows.

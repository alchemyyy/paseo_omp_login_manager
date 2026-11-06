import type { PluginIconProps, PluginTheme } from "@getpaseo/plugin";
import type { PluginPopoverProps, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { usePaseo, useRpc, useSettings } from "@getpaseo/plugin/client";
import { Icon, SidebarRow, SidebarSeparator, useToast } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ComponentType, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import {
  type Account,
  type AccountStatus,
  BACKEND_LABELS,
  type Backend,
  BackendSchema,
  enabledBackends,
  listAccountsRpc,
  type LoginSession,
  preferences,
  removeAccountRpc,
  startLoginRpc,
} from "../shared/contracts";
import { redactEmails } from "../shared/redact";
import { LoginModal } from "./login-modal";
import { ACCOUNTS_QUERY_KEY } from "./query-keys";
import { windowReloader } from "./window-reload";

/** The slice of a DOM element the right-click hook needs; the plugin tsconfig has no DOM lib */
interface ContextMenuTarget {
  addEventListener(type: "contextmenu", listener: (event: { preventDefault(): void }) => void): void;
  removeEventListener(type: "contextmenu", listener: (event: { preventDefault(): void }) => void): void;
}

// Catches logins made in a terminal; the server refreshes Paseo when the credentials change
const ACCOUNTS_POLL_INTERVAL_MS = 60_000;
// While first-run setup installs omp, so its row follows the steps
const SETUP_POLL_INTERVAL_MS = 2_000;
const TRAILING_ICON_SIZE = 14;
const HIT_SLOP = { top: 6, bottom: 6, left: 6, right: 6 };

const STATUS_ICON_NAMES: Record<AccountStatus, string> = {
  ok: "CircleCheck",
  expiring: "Clock",
  expired: "CircleAlert",
  disabled: "CircleX",
  signed_out: "CircleDashed",
};

interface LoginRequest {
  backend: Backend;
  provider: string | null;
  email: string | null;
}

const NEW_LOGIN_OPTIONS: { request: LoginRequest; label: string; detail: string }[] = [
  {
    request: { backend: "claude", provider: null, email: null },
    label: "Claude Code",
    detail: "Sign in with your Claude subscription",
  },
  {
    request: { backend: "omp", provider: null, email: null },
    label: "omp",
    detail: "Choose one of omp's model providers",
  },
];

/** Sidebar block: a header row, then one row per account with its status and a re-login button */
export function AccountsItem({ theme, layout, openPopover }: PluginSidebarItemProps) {
  const listAccounts = useRpc(listAccountsRpc);
  const startLogin = useRpc(startLoginRpc);
  const removeAccount = useRpc(removeAccountRpc);
  const queryClient = useQueryClient();
  const toast = useToast();
  const settings = useSettings(preferences);
  const redacting = settings.status === "ready" && settings.values.redactEmails;
  const headerRef = useRef<View | null>(null);
  const [session, setSession] = useState<LoginSession | null>(null);
  // Set by a header click so that one list re-runs omp's live usage check instead of reusing it
  const forceUsageCheck = useRef(false);
  const accounts = useQuery({
    queryKey: ACCOUNTS_QUERY_KEY,
    queryFn: () => {
      const refresh = forceUsageCheck.current;
      forceUsageCheck.current = false;
      return listAccounts(refresh ? { refresh } : {});
    },
    refetchInterval: (query) =>
      query.state.data?.setup?.state === "running" ? SETUP_POLL_INTERVAL_MS : ACCOUNTS_POLL_INTERVAL_MS,
  });
  const statusIcons = useMemo(() => buildStatusIcons(theme), [theme]);
  // Before the first list arrives, offer every backend rather than none
  const offeredBackends: readonly Backend[] = accounts.data?.enabledBackends ?? BackendSchema.options;
  const paseo = usePaseo();
  const enabledKey = useRef<string | null>(null);

  // Toggling a provider in Paseo's settings re-lists at once; catalog refreshes that leave the
  // enabled set unchanged are ignored, so a login's own refresh does not trigger extra CLI runs
  useEffect(() => {
    return paseo.providers.subscribe((update) => {
      const enabled = enabledBackends(update);
      if (enabled === null) return;
      const key = enabled.join(",");
      if (enabledKey.current !== null && enabledKey.current !== key) {
        void queryClient.invalidateQueries({ queryKey: ACCOUNTS_QUERY_KEY });
      }
      enabledKey.current = key;
    });
  }, [paseo, queryClient]);

  const login = async (request: LoginRequest) => {
    try {
      setSession(await startLogin(request));
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      toast.error(`Could not start ${BACKEND_LABELS[request.backend]} login: ${message}`);
    }
  };

  const loginAgain = (account: Account) =>
    login({ backend: account.backend, provider: account.provider, email: account.email });

  /** Throws so the popover can show the failure next to its button */
  const remove = async (account: Account) => {
    const { remainingSource } = await removeAccount({
      backend: account.backend,
      provider: account.provider,
      type: account.type,
      logoutLabel: account.logoutLabel,
    });
    await queryClient.invalidateQueries({ queryKey: ACCOUNTS_QUERY_KEY });
    toast.show(
      remainingSource
        ? `Removed ${rowLabel(account)}; ${remainingSource} still provides credentials`
        : `Removed ${rowLabel(account)}`,
      { variant: remainingSource ? "warning" : "success" },
    );
  };

  const showAccount = (account: Account) => {
    openPopover(function AccountPopover({ close }: PluginPopoverProps) {
      return (
        <AccountDetails
          theme={theme}
          account={account}
          onLogin={() => {
            close();
            void loginAgain(account);
          }}
          onRemove={async () => {
            await remove(account);
            close();
          }}
        />
      );
    });
  };

  const showNewLogin = () => {
    const reloadWindow = windowReloader();
    openPopover(function NewLoginPopover({ close }: PluginPopoverProps) {
      return (
        <View style={{ padding: 6, minWidth: 240 }}>
          {NEW_LOGIN_OPTIONS.filter((option) => offeredBackends.includes(option.request.backend)).map((option) => (
            <Pressable
              key={option.request.backend}
              accessibilityRole="button"
              onPress={() => {
                close();
                void login(option.request);
              }}
              style={({ pressed }) => ({
                padding: 10,
                borderRadius: 6,
                backgroundColor: pressed ? theme.colors.surface2 : "transparent",
              })}
            >
              <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>{option.label}</Text>
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{option.detail}</Text>
            </Pressable>
          ))}
          {reloadWindow ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                close();
                reloadWindow();
              }}
              style={({ pressed }) => ({
                marginTop: 4,
                padding: 10,
                borderRadius: 6,
                borderTopWidth: 1,
                borderTopColor: theme.colors.border,
                backgroundColor: pressed ? theme.colors.surface2 : "transparent",
              })}
            >
              <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>Reload Paseo window</Text>
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
                Reloads the interface; the app and running agents keep going
              </Text>
            </Pressable>
          ) : null}
        </View>
      );
    });
  };

  const showError = (title: string, message: string) => {
    openPopover(function ErrorPopover() {
      return (
        <View style={{ padding: 12, gap: 6, maxWidth: 360 }}>
          <Text style={{ color: theme.colors.statusDanger, fontWeight: "600" }}>{title}</Text>
          <Text selectable style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
            {message}
          </Text>
        </View>
      );
    });
  };

  const showHeaderMenu = () => {
    openPopover(function HeaderMenuPopover({ close }: PluginPopoverProps) {
      const toggle = () => {
        close();
        if (settings.status !== "ready") return;
        void settings.save({ ...settings.values, redactEmails: !settings.values.redactEmails }, settings.revision);
      };
      return (
        <View style={{ padding: 4, minWidth: 220 }}>
          <Pressable
            accessibilityRole="checkbox"
            accessibilityState={{ checked: redacting, disabled: settings.status !== "ready" }}
            disabled={settings.status !== "ready"}
            onPress={toggle}
            style={({ pressed }) => ({
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
              paddingHorizontal: 10,
              paddingVertical: 8,
              borderRadius: 6,
              backgroundColor: pressed ? theme.colors.surface2 : "transparent",
            })}
          >
            <Icon name={redacting ? "SquareCheck" : "Square"} size={TRAILING_ICON_SIZE} color={theme.colors.foreground} />
            <Text style={{ color: theme.colors.foreground }}>Hide email addresses</Text>
          </Pressable>
        </View>
      );
    });
  };

  // Right-click on the header opens its menu; web and desktop only, since native has no right-click
  useEffect(() => {
    if (layout.platform !== "web") return;
    const target = headerRef.current as unknown as ContextMenuTarget | null;
    if (!target) return;
    const onContextMenu = (event: { preventDefault(): void }) => {
      event.preventDefault();
      showHeaderMenu();
    };
    target.addEventListener("contextmenu", onContextMenu);
    return () => target.removeEventListener("contextmenu", onContextMenu);
  });

  const data = accounts.data;
  const queryError = accounts.error ? (accounts.error instanceof Error ? accounts.error.message : String(accounts.error)) : null;
  // Only displayed text is masked; email and logoutLabel stay real for login and removal
  const rows = (data?.accounts ?? []).map((account) =>
    redacting
      ? {
          ...account,
          label: redactEmails(account.label),
          orgName: account.orgName === null ? null : redactEmails(account.orgName),
          detail: redactEmails(account.detail),
        }
      : account,
  );
  const backendErrors = data?.errors ?? [];
  const muted = theme.colors.foregroundMuted;

  // Neither provider is enabled in Paseo: the section disappears, unless setup has something to say
  // or a login window is still open
  if (data && data.enabledBackends.length === 0 && data.setup === null && session === null) return null;

  return (
    <>
      <SidebarSeparator />
      <View ref={headerRef} collapsable={false}>
        <SidebarRow
          id="header"
          icon="KeyRound"
          label={accounts.isFetching ? "Accounts (checking)" : "Accounts"}
          onPress={() => {
            forceUsageCheck.current = true;
            void accounts.refetch();
          }}
          trailing={
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Log in to another account"
              hitSlop={HIT_SLOP}
              onPress={showNewLogin}
            >
              <Icon name="Plus" size={TRAILING_ICON_SIZE} color={muted} />
            </Pressable>
          }
        />
      </View>
      {data?.setup ? (
        <SidebarRow
          id="setup"
          icon={data.setup.state === "running" ? "LoaderCircle" : statusIcons.disabled}
          label={data.setup.state === "running" ? `${data.setup.message}...` : "omp setup failed"}
          onPress={() => {
            if (data.setup?.state !== "failed") return;
            showError(
              "omp setup failed",
              `${data.setup.message}\n\nSetup runs again within 10 minutes, or when the plugin reloads.`,
            );
          }}
        />
      ) : null}
      {queryError ? (
        <SidebarRow
          id="error"
          icon={statusIcons.disabled}
          label="Accounts unavailable"
          onPress={() => showError("Could not list accounts", queryError)}
        />
      ) : null}
      {backendErrors.map(({ backend, message }) => (
        <SidebarRow
          key={`error-${backend}`}
          id={`error-${backend}`}
          icon={statusIcons.disabled}
          label={`${BACKEND_LABELS[backend]} unavailable`}
          onPress={() => showError(`${BACKEND_LABELS[backend]} is unavailable`, message)}
        />
      ))}
      {!queryError && data && rows.length === 0 && backendErrors.length === 0 && data.setup?.state !== "running" ? (
        <SidebarRow id="empty" icon="LogIn" label="No accounts; log in" onPress={showNewLogin} />
      ) : null}
      {rows.map((account) => (
        <SidebarRow
          key={account.key}
          id={account.key}
          icon={statusIcons[account.status]}
          label={rowLabel(account)}
          onPress={() => showAccount(account)}
          trailing={
            account.canLogin ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Log in to ${rowLabel(account)} again`}
                hitSlop={HIT_SLOP}
                onPress={() => void loginAgain(account)}
              >
                <Icon
                  name="RefreshCw"
                  size={TRAILING_ICON_SIZE}
                  color={account.status === "ok" ? muted : statusColor(theme, account.status)}
                />
              </Pressable>
            ) : null
          }
        />
      ))}
      <LoginModal theme={theme} initialSession={session} redact={redacting} onClose={() => setSession(null)} />
    </>
  );
}

function rowLabel(account: Account): string {
  switch (account.backend) {
    case "claude":
      return `Claude Code · ${account.label}`;
    case "omp":
      return `omp ${account.provider} · ${account.label}`;
  }
}

const POPOVER_BUTTON_STYLE = { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8 };

function AccountDetails({
  theme,
  account,
  onLogin,
  onRemove,
}: {
  theme: PluginTheme;
  account: Account;
  onLogin(): void;
  onRemove(): Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const muted = theme.colors.foregroundMuted;
  const danger = theme.colors.statusDanger;
  const source = account.backend === "omp" ? `omp ${account.provider}` : BACKEND_LABELS[account.backend];

  const confirmRemove = async () => {
    setRemoving(true);
    setError(null);
    try {
      await onRemove();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setRemoving(false);
    }
  };

  return (
    <View style={{ padding: 12, gap: 6, maxWidth: 360 }}>
      <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>{account.label}</Text>
      <Text style={{ color: muted, fontSize: 12 }}>
        {source}
        {account.orgName ? ` · ${account.orgName}` : ""} · {account.type === "oauth" ? "OAuth" : "API key"}
      </Text>
      <Text style={{ color: statusColor(theme, account.status), fontSize: 12 }}>{account.detail}</Text>
      {confirming ? (
        <View style={{ gap: 6, marginTop: 4 }}>
          <Text style={{ color: theme.colors.foreground, fontSize: 12 }}>
            {account.backend === "claude"
              ? "Log Claude Code out? Paseo's Claude agents stop working until you log in again."
              : `Delete this ${account.provider} credential from omp? omp agents using it stop working.`}
          </Text>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Pressable
              accessibilityRole="button"
              disabled={removing}
              onPress={() => setConfirming(false)}
              style={[POPOVER_BUTTON_STYLE, { backgroundColor: theme.colors.surface2 }]}
            >
              <Text style={{ color: theme.colors.foreground }}>Cancel</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: removing }}
              disabled={removing}
              onPress={() => void confirmRemove()}
              style={[POPOVER_BUTTON_STYLE, { backgroundColor: danger, opacity: removing ? 0.6 : 1 }]}
            >
              <Text style={{ color: theme.colors.accentForeground }}>{removing ? "Removing..." : "Remove"}</Text>
            </Pressable>
          </View>
        </View>
      ) : account.canLogin || account.canRemove ? (
        <View style={{ flexDirection: "row", gap: 8, marginTop: 4 }}>
          {account.canLogin ? (
            <Pressable
              accessibilityRole="button"
              onPress={onLogin}
              style={[POPOVER_BUTTON_STYLE, { backgroundColor: theme.colors.accent }]}
            >
              <Text style={{ color: theme.colors.accentForeground }}>
                {account.status === "signed_out" ? "Log in" : "Log in again"}
              </Text>
            </Pressable>
          ) : null}
          {account.canRemove ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Remove ${rowLabel(account)}`}
              onPress={() => setConfirming(true)}
              style={[POPOVER_BUTTON_STYLE, { backgroundColor: danger }]}
            >
              <Text style={{ color: theme.colors.accentForeground }}>Remove</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {error ? <Text style={{ color: danger, fontSize: 12 }}>{error}</Text> : null}
    </View>
  );
}

function statusColor(theme: PluginTheme, status: AccountStatus): string {
  switch (status) {
    case "ok":
      return theme.colors.statusSuccess;
    case "expiring":
    case "signed_out":
      return theme.colors.statusWarning;
    case "expired":
    case "disabled":
      return theme.colors.statusDanger;
  }
}

/** Status icons tinted by theme; SidebarRow passes only size and its own color, so the tint is baked in */
function buildStatusIcons(theme: PluginTheme): Record<AccountStatus, ComponentType<PluginIconProps>> {
  const icons = {} as Record<AccountStatus, ComponentType<PluginIconProps>>;
  for (const status of Object.keys(STATUS_ICON_NAMES) as AccountStatus[]) {
    const name = STATUS_ICON_NAMES[status];
    const color = statusColor(theme, status);
    icons[status] = function StatusIcon({ size }: PluginIconProps) {
      return <Icon name={name} size={size} color={color} />;
    };
  }
  return icons;
}

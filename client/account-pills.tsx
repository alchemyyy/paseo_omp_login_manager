import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginButtonIconProps, PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { Icon, useToast } from "@getpaseo/plugin/client/ui";
import { type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Pressable, Text, type TextStyle, View } from "react-native";
import { listAccountPinsRpc, modelProvider, type PinnableAccount, pinAccountRpc } from "../shared/contracts";
import {
  asDomElement,
  createDomPortal,
  createOverlayContainer,
  createToolbarSlot,
  type DomElement,
  hideEnclosingPill,
  menuPosition,
  onDismiss,
  type ToolbarMetrics,
  type ToolbarSlot,
} from "./composer-toolbar";

const PILL_ID = "omp-account";
// Catches logins and removals made elsewhere; a switch through the menu refreshes at once
const PINS_POLL_INTERVAL_MS = 60_000;
// shortcut: only the first 200 agents get a control at startup; later ones arrive as updates
const AGENT_PAGE_LIMIT = 200;
// The control row re-renders with layout changes; a lost slot is rebuilt on the next check
const SLOT_CHECK_INTERVAL_MS = 1_000;
const AUTO_LABEL = "Auto";
// Mirrors the app's AgentControlTrigger toolbar style (composer/agent-controls)
const CONTROL_HEIGHT = 28;
const CONTROL_RADIUS = 16;
const CONTROL_GAP = 4;
const CONTROL_PADDING = 8;
const CHEVRON_SIZE = 14;
const DEFAULT_GLYPH_SIZE = 16;
const DEFAULT_FONT_SIZE = 14;
const LABEL_MAX_WIDTH = 220;
const MENU_WIDTH = 280;
const CHECK_ICON_SIZE = 14;

interface AgentView {
  workspaceId: string;
  model: string | null;
  running: boolean;
}

interface PillState {
  accounts: readonly PinnableAccount[];
  /** Agent id → provider → account key, for switches made through the control */
  pins: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** Live, unarchived omp agents that belong to a workspace */
  agents: ReadonlyMap<string, AgentView>;
}

/** The slice of a Paseo agent snapshot the control reads */
interface AgentSnapshotLike {
  id: string;
  provider: string;
  workspaceId?: string;
  model: string | null;
  status: string;
  archivedAt?: string | null;
}

/** The provider's accounts and the one the agent was switched to, for the agent's current model */
function agentChoices(state: PillState, agentId: string, agent: AgentView | undefined) {
  const provider = modelProvider(agent?.model ?? null);
  const choices = provider === null ? [] : state.accounts.filter((account) => account.provider === provider);
  const pinnedKey = provider === null ? undefined : state.pins[agentId]?.[provider];
  return { provider, choices, pinned: choices.find((account) => account.key === pinnedKey) ?? null };
}

/**
 * Adds an account control to every omp agent's composer toolbar, after the model, thinking, and
 * mode controls. It shows only while the agent's model provider has two or more stored omp OAuth
 * accounts, and switches with omp's `/session pin`.
 *
 * The SDK has no toolbar slot, so each agent gets a hidden composer pill whose icon mounts in that
 * agent's composer; the icon then portals the control into the toolbar row (web only).
 */
export function startAccountPills(client: PluginClientContext): () => void {
  const pills = new Map<string, { registration: PluginButtonRegistration; visible: boolean }>();
  const listeners = new Set<() => void>();
  let state: PillState = { accounts: [], pins: {}, agents: new Map() };
  let stopped = false;
  let releaseSubscription: (() => Promise<void>) | null = null;

  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const getState = () => state;

  const syncPills = () => {
    for (const [agentId, pill] of pills) {
      if (state.agents.has(agentId)) continue;
      pill.registration.remove();
      pills.delete(agentId);
    }
    for (const [agentId, agent] of state.agents) {
      const visible = agentChoices(state, agentId, agent).choices.length > 1;
      const pill = pills.get(agentId);
      if (!pill) {
        const registration = client.addComposerPill({
          id: PILL_ID,
          workspaceId: agent.workspaceId,
          agentId,
          button: {
            title: "omp account for this agent",
            icon: ToolbarAnchor,
            visible,
            // The pill stays hidden; presses on the toolbar control reach it through the React
            // tree, so it must not open anything itself
            behavior: { kind: "action", onPress: () => {} },
          },
        });
        pills.set(agentId, { registration, visible });
      } else if (pill.visible !== visible) {
        pill.registration.update({ visible });
        pill.visible = visible;
      }
    }
  };

  const publish = (next: Partial<PillState>) => {
    if (stopped) return;
    state = { ...state, ...next };
    for (const listener of listeners) listener();
    syncPills();
  };

  const refreshPins = async () => {
    try {
      publish(await client.rpc(listAccountPinsRpc, {}));
    } catch (error) {
      if (!stopped) console.error("[omp-login-manager] Reading omp accounts failed", error);
    }
  };

  const upsertAgent = (agents: Map<string, AgentView>, agent: AgentSnapshotLike) => {
    if (agent.provider !== "omp" || !agent.workspaceId || agent.archivedAt) {
      agents.delete(agent.id);
      return;
    }
    agents.set(agent.id, { workspaceId: agent.workspaceId, model: agent.model, running: agent.status === "running" });
  };

  /** Mounted by Paseo inside the agent's (hidden) pill; moves the real control into the toolbar */
  function ToolbarAnchor(props: PluginButtonIconProps) {
    const anchorRef = useRef<View | null>(null);
    const [toolbar, setToolbar] = useState<ToolbarSlot | null>(null);

    useEffect(() => {
      const node = asDomElement(anchorRef.current);
      if (!node) return;
      let current: ToolbarSlot | null = null;
      const attach = () => {
        hideEnclosingPill(node);
        if (current?.slot.isConnected) return;
        current?.slot.remove();
        current = createToolbarSlot(node);
        setToolbar(current);
      };
      attach();
      const timer = setInterval(attach, SLOT_CHECK_INTERVAL_MS);
      return () => {
        clearInterval(timer);
        current?.slot.remove();
      };
    }, []);

    return (
      <>
        <View ref={anchorRef} style={{ width: 0, height: 0 }} />
        {toolbar && props.context === "agent"
          ? createDomPortal(
              <AccountControl theme={props.theme} agentId={props.agentId} metrics={toolbar.metrics} />,
              toolbar.slot,
              PILL_ID,
            )
          : null}
      </>
    );
  }

  /** The toolbar trigger, styled like the app's model, thinking, and mode controls */
  function AccountControl({
    theme,
    agentId,
    metrics,
  }: {
    theme: PluginTheme;
    agentId: string;
    metrics: ToolbarMetrics | null;
  }) {
    const current = useSyncExternalStore(subscribe, getState);
    const [open, setOpen] = useState(false);
    const [hovered, setHovered] = useState(false);
    const triggerRef = useRef<View | null>(null);
    const { pinned } = agentChoices(current, agentId, current.agents.get(agentId));
    const label = pinned?.label ?? AUTO_LABEL;
    const textStyle: TextStyle = {
      color: metrics?.color ?? theme.colors.foregroundMuted,
      fontFamily: metrics?.fontFamily,
      fontSize: metrics?.fontSize ?? DEFAULT_FONT_SIZE,
      fontWeight: (metrics?.fontWeight ?? "400") as TextStyle["fontWeight"],
      lineHeight: metrics?.lineHeight,
    };

    return (
      <>
        <View
          ref={triggerRef}
          style={{ minWidth: 0, flexShrink: 1 }}
          onPointerEnter={() => setHovered(true)}
          onPointerLeave={() => setHovered(false)}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`omp account: ${label}`}
            onPress={() => setOpen((value) => !value)}
            style={({ pressed }) => ({
              height: CONTROL_HEIGHT,
              minWidth: 0,
              flexShrink: 1,
              flexDirection: "row",
              alignItems: "center",
              gap: CONTROL_GAP,
              paddingHorizontal: CONTROL_PADDING,
              borderRadius: CONTROL_RADIUS,
              backgroundColor: pressed || open ? theme.colors.surface0 : hovered ? theme.colors.surface2 : "transparent",
            })}
          >
            <Icon
              name="UserRound"
              size={metrics?.glyphSize ?? DEFAULT_GLYPH_SIZE}
              color={theme.colors.foregroundMuted}
            />
            <Text numberOfLines={1} style={[textStyle, { minWidth: 0, flexShrink: 1, maxWidth: LABEL_MAX_WIDTH }]}>
              {label}
            </Text>
            <View style={{ flexShrink: 0, transform: [{ translateY: 1 }] }}>
              <Icon name="ChevronDown" size={CHEVRON_SIZE} color={theme.colors.foregroundMuted} />
            </View>
          </Pressable>
        </View>
        {open ? (
          <AccountMenu
            theme={theme}
            agentId={agentId}
            anchor={asDomElement(triggerRef.current)}
            onClose={() => setOpen(false)}
          />
        ) : null}
      </>
    );
  }

  /** Floating account list above the trigger, like the app's combobox menus */
  function AccountMenu({
    theme,
    agentId,
    anchor,
    onClose,
  }: {
    theme: PluginTheme;
    agentId: string;
    anchor: DomElement | null;
    onClose(): void;
  }) {
    const current = useSyncExternalStore(subscribe, getState);
    const toast = useToast();
    const [pendingKey, setPendingKey] = useState<string | null>(null);
    const [overlay, setOverlay] = useState<DomElement | null>(null);
    const agent = current.agents.get(agentId);
    const { provider, choices, pinned } = agentChoices(current, agentId, agent);
    // omp cannot pin mid-turn; an unknown agent cannot be pinned at all
    const busy = agent?.running ?? true;

    useEffect(() => {
      if (!anchor) return;
      const container = createOverlayContainer();
      const { left, bottom } = menuPosition(anchor, MENU_WIDTH);
      container.style.setProperty("position", "fixed");
      container.style.setProperty("left", `${left}px`);
      container.style.setProperty("bottom", `${bottom}px`);
      container.style.setProperty("z-index", "1000");
      setOverlay(container);
      const stopDismiss = onDismiss(() => [container, anchor], onClose);
      return () => {
        stopDismiss();
        container.remove();
      };
      // The menu opens once per mount; a new onClose each render must not reopen it
    }, [anchor]);

    const choose = async (account: PinnableAccount) => {
      if (provider === null) return;
      setPendingKey(account.key);
      try {
        const { message } = await client.rpc(pinAccountRpc, { agentId, accountKey: account.key });
        publish({ pins: { ...state.pins, [agentId]: { ...state.pins[agentId], [provider]: account.key } } });
        toast.show(message, { variant: "success" });
        onClose();
        void refreshPins();
      } catch (reason) {
        setPendingKey(null);
        toast.error(`Could not switch accounts: ${reason instanceof Error ? reason.message : String(reason)}`);
      }
    };

    if (!overlay) return null;
    const menu: ReactNode = (
      <View
        style={{
          width: MENU_WIDTH,
          padding: 4,
          borderRadius: 12,
          borderWidth: 1,
          borderColor: theme.colors.border,
          backgroundColor: theme.colors.surface1,
          shadowColor: "#000",
          shadowOpacity: 0.3,
          shadowRadius: 16,
          shadowOffset: { width: 0, height: 4 },
        }}
      >
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, paddingHorizontal: 10, paddingVertical: 6 }}>
          {busy
            ? "Switch accounts once the agent's turn finishes"
            : pinned
              ? `${provider} account for this agent`
              : `omp picks the ${provider} account until you choose one`}
        </Text>
        {choices.map((account) => {
          const selected = account.key === pinned?.key;
          const disabled = busy || pendingKey !== null || selected;
          return (
            <Pressable
              key={account.key}
              accessibilityRole="button"
              accessibilityState={{ disabled, selected }}
              disabled={disabled}
              onPress={() => void choose(account)}
              style={({ pressed }) => ({
                flexDirection: "row",
                alignItems: "center",
                gap: 8,
                paddingHorizontal: 10,
                paddingVertical: 8,
                borderRadius: 8,
                opacity: disabled && !selected ? 0.5 : 1,
                backgroundColor: pressed ? theme.colors.surface2 : "transparent",
              })}
            >
              <View style={{ width: CHECK_ICON_SIZE }}>
                {selected ? <Icon name="Check" size={CHECK_ICON_SIZE} color={theme.colors.accent} /> : null}
              </View>
              <Text
                numberOfLines={1}
                style={{ color: theme.colors.foreground, fontWeight: selected ? "600" : "400", flexShrink: 1 }}
              >
                {pendingKey === account.key ? `Switching to ${account.label}…` : account.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    );
    return createDomPortal(menu, overlay, `${PILL_ID}-menu`);
  }

  void client.paseo.agents
    .list({ subscribe: {}, page: { limit: AGENT_PAGE_LIMIT } })
    .then(({ subscription }) => {
      releaseSubscription = () => subscription.release();
      if (stopped) {
        void subscription.release();
        return;
      }
      subscription.subscribe({
        // Snapshots also arrive after reconnect; existing pills are kept so they do not remount
        snapshot: ({ entries }) => {
          const agents = new Map<string, AgentView>();
          for (const { agent } of entries) upsertAgent(agents, agent);
          publish({ agents });
        },
        update: (message) => {
          if (message.type !== "agent_update") return;
          const update = message.payload;
          const agents = new Map(state.agents);
          if (update.kind === "remove") agents.delete(update.agentId);
          else upsertAgent(agents, update.agent);
          publish({ agents });
        },
      });
    })
    .catch((error: unknown) => {
      if (!stopped) console.error("[omp-login-manager] Agent observation failed", error);
    });

  void refreshPins();
  const poll = setInterval(() => void refreshPins(), PINS_POLL_INTERVAL_MS);

  return () => {
    stopped = true;
    clearInterval(poll);
    void releaseSubscription?.();
    for (const pill of pills.values()) pill.registration.remove();
    pills.clear();
  };
}

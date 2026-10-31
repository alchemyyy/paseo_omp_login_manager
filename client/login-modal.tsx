import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { copyText, ExternalLink, Icon, Modal, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import {
  BACKEND_LABELS,
  cancelLoginRpc,
  type LoginSession,
  loginInputRpc,
  loginStatusRpc,
} from "../shared/contracts";
import { redactEmails } from "../shared/redact";
import { ACCOUNTS_QUERY_KEY } from "./query-keys";
import { windowReloader } from "./window-reload";

const MONOSPACE = Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" });
const POLL_INTERVAL_MS = 500;
const BUTTON_STYLE = { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8 };

// Choices shown before the filter box is needed
const CHOICE_FILTER_THRESHOLD = 8;
// Long enough to read "Logged in" before the window reloads
const RELOAD_DELAY_MS = 1_500;

const STATE_LABELS: Record<LoginSession["state"], string> = {
  running: "Waiting for the login",
  succeeded: "Logged in",
  failed: "Login failed",
  cancelled: "Login cancelled",
};

/** Live transcript of one login run with its sign-in link, clickable picker choices, a stdin line, and cancel */
export function LoginModal({
  theme,
  initialSession,
  redact,
  onClose,
}: {
  theme: PluginTheme;
  /** Session returned by login.start; null keeps the modal closed */
  initialSession: LoginSession | null;
  /** Mask email addresses in the transcript; links and copied URLs stay intact */
  redact: boolean;
  onClose(): void;
}) {
  const getStatus = useRpc(loginStatusRpc);
  const sendInput = useRpc(loginInputRpc);
  const cancel = useRpc(cancelLoginRpc);
  const queryClient = useQueryClient();
  const toast = useToast();
  const [answer, setAnswer] = useState("");
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const reportedId = useRef<string | null>(null);
  const sessionId = initialSession?.id ?? null;

  const status = useQuery({
    queryKey: ["omp-login-manager", "login", sessionId],
    queryFn: () => getStatus({ id: sessionId! }),
    enabled: sessionId !== null,
    initialData: initialSession,
    refetchInterval: (query) => (query.state.data?.state === "running" ? POLL_INTERVAL_MS : false),
  });
  const session = status.data ?? initialSession;
  const running = session?.state === "running";

  useEffect(() => {
    setAnswer("");
    setFilter("");
    setError(null);
  }, [sessionId]);

  // Report the outcome once. A success reloads the window (web/desktop only), so every surface,
  // including the composer's account pills, picks up the new account and Paseo's refreshed provider
  useEffect(() => {
    if (!session || session.state === "running" || reportedId.current === session.id) return;
    reportedId.current = session.id;
    const backendLabel = BACKEND_LABELS[session.backend];
    if (session.state === "succeeded") {
      const reloadWindow = windowReloader();
      if (reloadWindow) {
        toast.show(`${backendLabel} login finished; reloading Paseo`, { variant: "success" });
        // Leaves the modal's "Logged in" state visible briefly; only the window reloads, not the app
        setTimeout(reloadWindow, RELOAD_DELAY_MS);
        return;
      }
      toast.show(`${backendLabel} login finished; Paseo's ${backendLabel} provider is refreshing`, { variant: "success" });
    }
    void queryClient.invalidateQueries({ queryKey: ACCOUNTS_QUERY_KEY });
    if (session.state === "failed") toast.error(`${backendLabel} login failed`);
  }, [session, queryClient, toast]);

  const send = async (text: string) => {
    if (!session) return;
    setError(null);
    try {
      await sendInput({ id: session.id, text });
      setAnswer("");
      setFilter("");
      await status.refetch();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const close = () => {
    // Closing mid-flow abandons the login, so the loopback port is released for the next attempt
    if (session && running) void cancel({ id: session.id });
    onClose();
  };

  const copyUrl = async (url: string) => {
    try {
      await copyText(url);
      toast.show("Sign-in link copied", { variant: "success" });
    } catch {
      toast.error("Could not copy. Select the link text instead.");
    }
  };

  const muted = theme.colors.foregroundMuted;
  const stateColor =
    session?.state === "succeeded"
      ? theme.colors.statusSuccess
      : session?.state === "failed"
        ? theme.colors.statusDanger
        : muted;
  const signInUrl = session?.urls[0] ?? null;
  const backendLabel = session ? BACKEND_LABELS[session.backend] : "";
  const choices = running ? session.choices : [];
  const picking = choices.length > 0;
  const normalizedFilter = filter.trim().toLowerCase();
  const visibleChoices = normalizedFilter
    ? choices.filter((choice) => choice.label.toLowerCase().includes(normalizedFilter))
    : choices;
  const inputStyle = {
    color: theme.colors.foreground,
    backgroundColor: theme.colors.surface2,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
  };
  const title =
    session?.backend === "claude"
      ? "Log in to Claude Code"
      : `Log in to ${session?.provider ?? "a provider"} with omp`;

  return (
    <Modal
      title={title}
      icon={<Icon name="KeyRound" size={16} color={theme.colors.foreground} />}
      open={initialSession !== null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <Modal.Content>
        <Text style={{ color: stateColor, fontWeight: "600" }}>
          {session ? STATE_LABELS[session.state] : ""}
          {session && !running && session.exitCode !== null ? ` (exit ${session.exitCode})` : ""}
        </Text>
        {running && signInUrl ? (
          <View style={{ gap: 6 }}>
            <Text style={{ color: muted, fontSize: 12 }}>
              {backendLabel} opened the sign-in page in the browser on the Paseo host. Finish it there, or open it
              here:
            </Text>
            <View style={{ flexDirection: "row", gap: 12, alignItems: "center" }}>
              <ExternalLink href={signInUrl}>
                <Text style={{ color: theme.colors.accent }}>Open sign-in page</Text>
              </ExternalLink>
              <Pressable accessibilityRole="button" onPress={() => void copyUrl(signInUrl)}>
                <Text style={{ color: theme.colors.accent }}>Copy link</Text>
              </Pressable>
            </View>
          </View>
        ) : null}
        {picking ? (
          <View style={{ gap: 8 }}>
            <Text style={{ color: theme.colors.foreground }}>Choose a provider</Text>
            {choices.length > CHOICE_FILTER_THRESHOLD ? (
              <TextInput
                value={filter}
                onChangeText={setFilter}
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="Filter providers"
                placeholderTextColor={muted}
                style={inputStyle}
              />
            ) : null}
            <View style={{ borderColor: theme.colors.border, borderWidth: 1, borderRadius: 8, overflow: "hidden" }}>
              {visibleChoices.map((choice, position) => (
                <Pressable
                  key={choice.value}
                  accessibilityRole="button"
                  onPress={() => void send(choice.value)}
                  style={({ pressed }) => ({
                    paddingHorizontal: 12,
                    paddingVertical: 9,
                    borderTopWidth: position === 0 ? 0 : 1,
                    borderColor: theme.colors.border,
                    backgroundColor: pressed ? theme.colors.surface2 : theme.colors.surface1,
                  })}
                >
                  <Text style={{ color: theme.colors.foreground }}>{choice.label}</Text>
                </Pressable>
              ))}
              {visibleChoices.length === 0 ? (
                <Text style={{ color: muted, padding: 12 }}>No provider matches "{filter}"</Text>
              ) : null}
            </View>
          </View>
        ) : (
          <View
            style={{
              backgroundColor: theme.colors.surface1,
              borderColor: theme.colors.border,
              borderWidth: 1,
              borderRadius: 8,
              padding: 10,
            }}
          >
            <Text selectable style={{ color: theme.colors.foreground, fontFamily: MONOSPACE, fontSize: 12 }}>
              {(redact ? redactEmails(session?.output ?? "") : session?.output) || `Starting ${backendLabel} login...`}
            </Text>
          </View>
        )}
        {running && !picking ? (
          <View style={{ gap: 6 }}>
            <Text style={{ color: muted, fontSize: 12 }}>
              Answer {backendLabel} prompts here, for example a pasted authorization code
            </Text>
            <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
              <TextInput
                value={answer}
                onChangeText={setAnswer}
                onSubmitEditing={() => void send(answer)}
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="Type a reply and press Enter"
                placeholderTextColor={muted}
                style={[inputStyle, { flex: 1, fontFamily: MONOSPACE }]}
              />
              <Pressable
                accessibilityRole="button"
                onPress={() => void send(answer)}
                style={[BUTTON_STYLE, { backgroundColor: theme.colors.accent }]}
              >
                <Text style={{ color: theme.colors.accentForeground }}>Send</Text>
              </Pressable>
            </View>
          </View>
        ) : null}
        {error ? <Text style={{ color: theme.colors.statusDanger, fontSize: 12 }}>{error}</Text> : null}
        <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8 }}>
          <Pressable
            accessibilityRole="button"
            onPress={close}
            style={[BUTTON_STYLE, { backgroundColor: theme.colors.surface2 }]}
          >
            <Text style={{ color: theme.colors.foreground }}>{running ? "Cancel login" : "Close"}</Text>
          </Pressable>
        </View>
      </Modal.Content>
    </Modal>
  );
}

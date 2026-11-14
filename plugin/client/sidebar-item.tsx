import type { PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { useRpc, useSettings } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, Text, View, type TextStyle } from "react-native";
import { statusRpc } from "../shared/rpc";
import { preferences } from "../shared/settings";
import { SCREEN_ID } from "./format";
import { useText } from "./i18n";
import { sidebarSummary } from "./sidebar-summary";

/**
 * Sidebar row: one click to Voice Kit, with a short summary (whether it is in effect, what needs
 * attention, the devices and memory it uses) and a status dot (green in effect, yellow partly or
 * busy, red failed).
 */
export function VoiceKitSidebarItem(props: PluginSidebarItemProps) {
  const settings = useSettings(preferences);
  // Hidden from the Voice Kit page ("Show in sidebar"); it stays reachable via /voicekit and ⌘K.
  if (settings.status === "ready" && !settings.values.showInSidebar) return null;
  return <Row {...props} />;
}

function Row({ theme, currentScreen, openScreen }: PluginSidebarItemProps) {
  const { t } = useText();
  const settings = useSettings(preferences);
  const getStatus = useRpc(statusRpc);
  // One retry, then the row says Voice Kit can't be reached instead of showing the last good status.
  const status = useQuery({ queryKey: ["voicekit", "status", "sidebar"], queryFn: () => getStatus({}), refetchInterval: 5000, retry: 1 });
  const values = settings.status === "ready" ? settings.values : null;
  const summary = sidebarSummary(t, status.data, values, status.dataUpdatedAt || Date.now(), status.isError);
  const open = () => openScreen({ screenId: SCREEN_ID });
  const c = theme.colors;
  const color = summary.tone === "success" ? c.statusSuccess : summary.tone === "danger" ? c.statusDanger : summary.tone === "warning" ? c.statusWarning : c.border;
  return (
    <SidebarRow
      icon="AudioLines"
      label={t("app.title")}
      active={currentScreen?.screenId === SCREEN_ID}
      onPress={open}
      trailing={
        // The trailing slot sits outside the row's pressable, so it opens Voice Kit too.
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={summary.accessible}
          onPress={open}
          // Clips the hidden measuring layer only; visible text always fits.
          style={{ flexDirection: "row", alignItems: "center", gap: 6, marginRight: 8, overflow: "hidden" }}
        >
          <FitText candidates={summary.candidates} style={{ color: c.foregroundMuted, fontSize: 11 }} />
          <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} />
        </Pressable>
      }
    />
  );
}

/** Widest summary the row shows, and its line height. */
const MAX_WIDTH = 120;
const LINE_HEIGHT = 14;

/**
 * Shows the first candidate that fits on one line within MAX_WIDTH, measured as laid out, so text
 * is never cut off with an ellipsis. Until a new set is measured the previous text stays.
 */
function FitText({ candidates, style }: { candidates: string[]; style: TextStyle }) {
  const [heights, setHeights] = useState<Record<string, number>>({});
  const [shown, setShown] = useState("");
  const measured = candidates.every((text) => text in heights);
  const fits = candidates.find((text) => heights[text] !== undefined && heights[text] < LINE_HEIGHT * 1.5);
  // Nothing fits: the shortest wraps rather than being cut.
  const best = measured ? (fits ?? candidates[candidates.length - 1] ?? "") : shown;
  if (measured && best !== shown) setShown(best);
  const text = measured ? best : shown;
  const textStyle: TextStyle = { ...style, lineHeight: LINE_HEIGHT, maxWidth: MAX_WIDTH };
  return (
    <>
      {text ? (
        <Text testID="voicekit-sidebar-text" style={textStyle}>
          {text}
        </Text>
      ) : null}
      <View
        aria-hidden
        importantForAccessibility="no-hide-descendants"
        accessibilityElementsHidden
        pointerEvents="none"
        style={{ position: "absolute", top: 0, right: 0, width: MAX_WIDTH, opacity: 0, alignItems: "flex-start" }}
      >
        {candidates.map((candidate) => (
          <Text
            key={candidate}
            style={textStyle}
            onLayout={(e) => {
              const height = e.nativeEvent.layout.height;
              setHeights((prev) => {
                if (prev[candidate] === height) return prev;
                // Keep only the current set (memory changes the text over time).
                const next: Record<string, number> = { [candidate]: height };
                for (const other of candidates) if (other !== candidate && prev[other] !== undefined) next[other] = prev[other];
                return next;
              });
            }}
          >
            {candidate}
          </Text>
        ))}
      </View>
    </>
  );
}

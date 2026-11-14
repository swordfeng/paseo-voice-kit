// Small themed building blocks for Voice Kit's settings: tabs, badges, chips, progress, buttons.
// React Native primitives only; every color comes from the Paseo theme.
import type { PluginTheme } from "@getpaseo/plugin";
import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";

type Colors = PluginTheme["colors"];
export type BadgeTone = "accent" | "success" | "warning" | "danger" | "neutral";

function toneColor(c: Colors, tone: BadgeTone): string {
  switch (tone) {
    case "accent":
      return c.accent;
    case "success":
      return c.statusSuccess;
    case "warning":
      return c.statusWarning;
    case "danger":
      return c.statusDanger;
    default:
      return c.foregroundMuted;
  }
}

/** Segmented tabs. */
export function Tabs<T extends string>({
  theme,
  value,
  options,
  onChange,
}: {
  theme: PluginTheme;
  value: T;
  options: readonly { value: NoInfer<T>; label: string }[];
  onChange(value: NoInfer<T>): void;
}) {
  const c = theme.colors;
  return (
    <View
      accessibilityRole="tablist"
      style={{ flexDirection: "row", padding: 3, borderRadius: 10, backgroundColor: c.surface1, borderWidth: 1, borderColor: c.border, alignSelf: "flex-start" }}
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <Pressable
            key={o.value}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            accessibilityLabel={o.label}
            onPress={() => onChange(o.value)}
            style={{ paddingHorizontal: 14, paddingVertical: 6, borderRadius: 7, backgroundColor: active ? c.surface0 : "transparent", borderWidth: active ? 1 : 0, borderColor: c.border }}
          >
            <Text style={{ color: active ? c.foreground : c.foregroundMuted, fontSize: 13, fontWeight: active ? "600" : "400" }}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** Small pill with a colored outline, for states like "Recommended" or "In use". */
export function Badge({ theme, tone = "neutral", children }: { theme: PluginTheme; tone?: BadgeTone; children: ReactNode }) {
  const color = toneColor(theme.colors, tone);
  return (
    <View style={{ borderRadius: 999, borderWidth: 1, borderColor: color, paddingHorizontal: 8, paddingVertical: 1 }}>
      <Text style={{ color, fontSize: 11, fontWeight: "600" }}>{children}</Text>
    </View>
  );
}

/** Quiet metadata chip: languages, size, engine. */
export function Chip({ theme, children }: { theme: PluginTheme; children: ReactNode }) {
  return (
    <View style={{ borderRadius: 6, backgroundColor: theme.colors.surface2, paddingHorizontal: 7, paddingVertical: 2 }}>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{children}</Text>
    </View>
  );
}

export function ProgressBar({ theme, fraction }: { theme: PluginTheme; fraction: number | null }) {
  const pct = fraction === null ? 0.15 : Math.max(0.02, Math.min(1, fraction));
  return (
    <View style={{ height: 6, borderRadius: 3, backgroundColor: theme.colors.surface2, overflow: "hidden" }}>
      <View style={{ height: 6, width: `${pct * 100}%`, borderRadius: 3, backgroundColor: theme.colors.accent }} />
    </View>
  );
}

export type ButtonKind = "primary" | "secondary" | "danger";

export function Button({
  theme,
  kind = "secondary",
  label,
  disabled,
  onPress,
}: {
  theme: PluginTheme;
  kind?: ButtonKind;
  label: string;
  disabled?: boolean;
  onPress(): void;
}) {
  const c = theme.colors;
  const background = kind === "primary" ? c.accent : "transparent";
  const border = kind === "primary" ? c.accent : kind === "danger" ? c.statusDanger : c.border;
  const color = kind === "primary" ? c.accentForeground : kind === "danger" ? c.statusDanger : c.foreground;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: border,
        backgroundColor: background,
        opacity: disabled ? 0.45 : pressed ? 0.75 : 1,
      })}
    >
      <Text style={{ color, fontSize: 13, fontWeight: "500" }}>{label}</Text>
    </Pressable>
  );
}

/** Section heading used inside tabs. */
export function Heading({ theme, title, trailing }: { theme: PluginTheme; title: string; trailing?: ReactNode }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 4 }}>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "600", letterSpacing: 0.4 }}>{title.toUpperCase()}</Text>
      {trailing}
    </View>
  );
}

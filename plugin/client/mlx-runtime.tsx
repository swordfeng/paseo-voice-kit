// Setting up the optional MLX runtime (a Python environment for MLX models) from the UI. Nothing
// is installed until the user confirms; adding a model never installs it.
import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { installMlxRuntimeRpc, mlxRuntimeRpc, type MlxRuntime } from "../shared/rpc";
import { errorText, useText } from "./i18n";
import { Button } from "./kit";

const KEY = ["voicekit", "mlx"];

/** The MLX runtime's state and an explicit, confirmed install. Hidden once it is ready unless `showReady`. */
export function MlxRuntimeSetup({ theme, showReady = false }: { theme: PluginTheme; showReady?: boolean }) {
  const { t } = useText();
  const c = theme.colors;
  const queryClient = useQueryClient();
  const getRuntime = useRpc(mlxRuntimeRpc);
  const installRpc = useRpc(installMlxRuntimeRpc);
  const [confirming, setConfirming] = useState(false);
  const runtime = useQuery({
    queryKey: KEY,
    queryFn: () => getRuntime({}),
    // One retry, then show what went wrong instead of waiting through several.
    retry: 1,
    // Every 2 s while installing; otherwise rarely (it changes only through this or the script).
    refetchInterval: (query) => (query.state.data?.phase === "installing" ? 2_000 : 30_000),
  });
  const install = useMutation({
    mutationFn: () => installRpc({ confirmed: true }),
    onSuccess: (next) => {
      setConfirming(false);
      queryClient.setQueryData(KEY, next);
    },
  });
  // Once it is ready, models and voices that need it can run: refresh them.
  const phase = runtime.data?.phase;
  const previous = useRef(phase);
  useEffect(() => {
    if (previous.current && previous.current !== "ready" && phase === "ready") {
      void queryClient.invalidateQueries({ queryKey: ["voicekit"], predicate: (q) => q.queryKey[1] !== "mlx" });
    }
    previous.current = phase;
  }, [phase, queryClient]);

  const r = runtime.data;
  // The check itself failed: say so and let the user check again, rather than hiding the setup.
  if (!r && runtime.error) {
    return (
      <View style={{ gap: 6 }}>
        <Text selectable style={{ color: c.statusDanger, fontSize: 12 }}>
          {t("mlx.checkFailed") + " " + errorText(t, runtime.error)}
        </Text>
        <View style={{ flexDirection: "row" }}>
          <Button theme={theme} label={t("mlx.checkAgain")} disabled={runtime.isFetching} onPress={() => void runtime.refetch()} />
        </View>
      </View>
    );
  }
  if (!r) return null;
  if (r.phase === "ready" && !showReady) return null;
  const muted = { color: c.foregroundMuted, fontSize: 12, lineHeight: 17 };
  const box = { gap: 6, borderWidth: 1, borderColor: c.border, borderRadius: 8, padding: 10 };
  const lines = r.lines.slice(-6).join("\n");
  const log = lines ? <Text selectable style={{ ...muted, fontFamily: "monospace", fontSize: 11 }}>{lines}</Text> : null;

  if (r.phase === "ready") return <Text style={muted}>{t("mlx.ready")}</Text>;
  if (r.phase === "unavailable") return <Text style={muted}>{unavailableText(t, r)}</Text>;
  if (r.phase === "installing") {
    return (
      <View style={box}>
        <Text style={{ ...muted, color: c.foreground }}>{t("mlx.installing")}</Text>
        {log}
      </View>
    );
  }
  // missing or failed: explain, then ask before installing.
  return (
    <View style={box}>
      {r.phase === "failed" ? (
        <Text selectable style={{ color: c.statusDanger, fontSize: 12 }}>
          {r.error ? t("mlx.failed") + " " + r.error : t("mlx.failed")}
        </Text>
      ) : (
        <Text style={muted}>{t("mlx.missing")}</Text>
      )}
      {r.phase === "failed" ? log : null}
      {confirming ? (
        <>
          <Text style={{ ...muted, color: c.foreground }}>{t("mlx.confirm", { path: r.path, python: r.python ?? "Python 3.12" })}</Text>
          {install.error ? <Text selectable style={{ color: c.statusDanger, fontSize: 12 }}>{errorText(t, install.error)}</Text> : null}
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            <Button theme={theme} label={t("mlx.confirmInstall")} disabled={install.isPending} onPress={() => install.mutate()} />
            <Button theme={theme} label={t("mlx.cancel")} disabled={install.isPending} onPress={() => setConfirming(false)} />
          </View>
        </>
      ) : (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          <Button theme={theme} label={r.phase === "failed" ? t("mlx.retry") : t("mlx.install")} onPress={() => setConfirming(true)} />
        </View>
      )}
    </View>
  );
}

function unavailableText(t: ReturnType<typeof useText>["t"], r: MlxRuntime): string {
  switch (r.reason) {
    case "platform":
      return t("mlx.platform");
    case "pythonRequired":
      return t("mlx.pythonRequired");
    case "runtimeRequired":
      return t("mlx.runtimeRequired");
    case "externalRuntime":
      return t("mlx.externalRuntime", { python: r.python ?? "VOICEKIT_MLX_PYTHON" });
    default:
      return r.error ?? t("mlx.platform");
  }
}

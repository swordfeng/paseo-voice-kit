// Whether MLX models can run: the speech server ships a native MLX helper beside it, so there is
// nothing to install here. This only reports what the server found; it never loads a model.
import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { Text, View } from "react-native";
import { mlxRuntimeRpc, type MlxRuntime } from "../shared/rpc";
import { errorText, useText, type Translate } from "./i18n";
import { Button } from "./kit";

const KEY = ["voicekit", "mlx"];

/** Whether this speech server can run MLX models. Hidden once it can, unless `showReady`. */
export function MlxRuntimeStatus({ theme, showReady = false }: { theme: PluginTheme; showReady?: boolean }) {
  const { t } = useText();
  const c = theme.colors;
  const queryClient = useQueryClient();
  const getRuntime = useRpc(mlxRuntimeRpc);
  const runtime = useQuery({
    queryKey: KEY,
    queryFn: () => getRuntime({}),
    // One retry, then show what went wrong instead of waiting through several.
    retry: 1,
    // It changes only when the speech server is updated or replaced.
    refetchInterval: 30_000,
  });
  // Once the helper is there, models and voices that need it can run: refresh them.
  const phase = runtime.data?.phase;
  const previous = useRef(phase);
  useEffect(() => {
    if (previous.current && previous.current !== "ready" && phase === "ready") {
      void queryClient.invalidateQueries({ queryKey: ["voicekit"], predicate: (q) => q.queryKey[1] !== "mlx" });
    }
    previous.current = phase;
  }, [phase, queryClient]);

  const r = runtime.data;
  // The check itself failed: say so and let the user check again, rather than hiding it.
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
  return (
    <Text selectable={r.phase !== "ready"} style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 17 }}>
      {r.phase === "ready" ? t("mlx.ready") : unavailableText(t, r)}
    </Text>
  );
}

function unavailableText(t: Translate, r: MlxRuntime): string {
  switch (r.reason) {
    case "platform":
      return t("mlx.platform");
    case "runtimeRequired":
      return t("mlx.runtimeRequired");
    default:
      return r.error ? t("mlx.unavailable") + " " + r.error : t("mlx.unavailable");
  }
}

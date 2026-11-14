import type { PluginClientContext } from "@getpaseo/plugin/client";
import { SettingsScreen, setAudioPlayer } from "./client/settings-screen";
import { SCREEN_ID } from "./client/format";
import { messages } from "./client/i18n";
import { VoiceKitSidebarItem } from "./client/sidebar-item";
import { attachRpc, previewRpc, restartRpc } from "./shared/rpc";

export default function contribute(client: PluginClientContext) {
  const lifetime = new AbortController();
  setAudioPlayer((audio) => client.playAudio(audio));

  // The backend reaches Paseo's config through the daemon session that comes with RPC calls.
  // Attach on load and retry until the backend is up (it may still be starting).
  void (async () => {
    for (let attempt = 0; !lifetime.signal.aborted; attempt++) {
      try {
        await client.rpc(attachRpc, {});
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, Math.min(10_000, 1000 * 2 ** attempt)));
      }
    }
  })();

  // Titles are message references, so the host shows them in the app language and updates them
  // when it changes.
  const title = messages.message("app.title");
  const removers = [
    // The settings page as its own screen (sidebar row, /voicekit, ⌘K), and behind the
    // settings cog on the plugin's row in Settings > Plugins.
    client.addScreen({ id: SCREEN_ID, title, Component: SettingsScreen }),
    client.addSidebarFooterItem({ id: SCREEN_ID, title, Component: VoiceKitSidebarItem }),
    client.addSettingsScreen({ id: SCREEN_ID, title, icon: "AudioLines", Component: SettingsScreen }),
    client.addSlashCommand({
      name: "voicekit",
      description: messages.message("app.slashDescription"),
      argumentHint: "",
      context: "workspace",
      onSubmit({ openScreen }) {
        openScreen({ screenId: SCREEN_ID });
      },
    }),
    client.addCommandCenterItem({
      id: "open-settings",
      title: messages.message("app.commandSettings"),
      icon: "AudioLines",
      context: "global",
      onSelect({ openScreen }) {
        openScreen({ screenId: SCREEN_ID });
      },
    }),
    client.addCommandCenterItem({
      id: "restart",
      title: messages.message("app.commandRestart"),
      icon: "RotateCcw",
      context: "global",
      async onSelect({ rpc }) {
        await rpc(restartRpc, {});
      },
    }),
    client.addCommandCenterItem({
      id: "preview",
      title: messages.message("app.commandPreview"),
      icon: "Volume2",
      context: "global",
      async onSelect({ rpc }) {
        const audio = await rpc(previewRpc, {});
        await client.playAudio(audio);
      },
    }),
  ];

  return () => {
    lifetime.abort();
    setAudioPlayer(null);
    for (const remove of removers) remove();
  };
}

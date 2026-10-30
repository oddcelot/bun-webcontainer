import { render } from "@solidjs/web";
import type { Playground } from "../boot";
import { AppContext } from "../ui/context";
import { EmbedApp, EmbedContext } from "../ui/EmbedApp";
import type { Embed } from "./main";

const noop = () => {};

/** Renders the embed into <body>. The panes it shares with the full playground read AppContext; the rest is the embed's. */
export function mountEmbed(pg: Playground, embed: Embed) {
  const app = {
    session: pg.session,
    support: pg.support,
    workspace: pg.workspace,
    previews: pg.previews,
    terminal: pg.terminal,
    clearConsole: pg.clearConsole,
    vfs: pg.vfs,
    log: pg.log,
    run: () => void pg.run(),
    stop: pg.stop,
    install: () => void pg.install(),
    newFile: pg.newFile,
    // Opening other projects, folders and zips is the full playground's.
    openProject: noop,
    openFolder: noop,
    openDirectory: noop,
    reopenFolder: noop,
    openZip: noop,
    repoParam: "",
    // `edit` isn't a feature: an embed takes edits unless the author set `readonly`.
    features: { has: (name: string) => (name === "edit" ? !embed.options.readonly : embed.features().includes(name as never)) },
  };
  return render(
    () => (
      <AppContext value={app}>
        <EmbedContext value={embed}>
          <EmbedApp />
        </EmbedContext>
      </AppContext>
    ),
    document.body,
  );
}

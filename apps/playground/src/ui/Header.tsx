import { useContext } from "solid-js";
import { DropdownMenu } from "@kobalte/core/dropdown-menu";
import { DOCS } from "../base";
import { formatChord, keysFor } from "../keymap";
import logo from "../bun-logo.svg";
import { AppContext } from "./context";
import { ProjectPicker } from "./ProjectPicker";
import { ShareMenu } from "./ShareMenu";
import { Shortcuts } from "./Shortcuts";
import { ThemePicker } from "./ThemePicker";
import { Title } from "./Title";
import { Tip } from "@runbun/ui/solid/Tip";

const CANT_RUN = "This browser can't run code here";

export function Header() {
  const app = useContext(AppContext);
  const s = app.session;

  return (
    <>
      <h1 class="title">
        <img src={logo} alt="" width="23" height="20" />
        <span class="sr-only">runbun.dev: Bun in your browser</span>
        <span id="title" aria-hidden="true">
          <Title />
        </span>
      </h1>
      <ProjectPicker />
      {/* Startup installs and runs the project itself, so Run and Install ignore clicks until it's done (no greying out meanwhile). */}
      <span id="run-group">
        <Tip
          id="run"
          tip={s.canRun ? "Run the project" : CANT_RUN}
          keys={s.canRun ? keysFor("run").map(formatChord) : undefined}
          disabled={!s.canRun || !!s.busy.run}
          onClick={() => s.ready() && app.run()}
        >
          <i class="i-lucide-play" aria-hidden="true" /> Run
        </Tip>
        <DropdownMenu placement="bottom-start" gutter={6}>
          <Tip as={DropdownMenu.Trigger} id="run-more" disabled={!s.canRun} tip={s.canRun ? "More" : CANT_RUN} aria-label="More run actions">
            <i class="i-lucide-chevron-down" aria-hidden="true" />
          </Tip>
          <DropdownMenu.Portal>
            <DropdownMenu.Content class="select-menu menu">
              <DropdownMenu.Item class="select-option" disabled={!!s.busy.install} onSelect={() => s.ready() && app.install()}>
                <i class="i-lucide-download" aria-hidden="true" />
                <DropdownMenu.ItemLabel class="name">bun install</DropdownMenu.ItemLabel>
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu>
      </span>
      <Tip as="a" id="docs" href={DOCS} target="_blank" rel="noopener" tip="Documentation: what works, and how (opens in a new tab)">
        <i class="i-lucide-book-open" aria-hidden="true" /> Docs
      </Tip>
      <Tip id="share" popovertarget="share-menu" tip="Share this project">
        <i class="i-lucide-share-2" aria-hidden="true" /> Share
      </Tip>
      <ShareMenu />
      <Shortcuts id="shortcuts" />
      <ThemePicker />
    </>
  );
}

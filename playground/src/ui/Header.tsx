import { useContext } from "solid-js";
import logo from "../bun-logo.svg";
import { AppContext } from "./context";
import { ProjectPicker } from "./ProjectPicker";
import { ShareMenu } from "./ShareMenu";
import { ThemePicker } from "./ThemePicker";
import { Title } from "./Title";

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
      {/* Startup installs and runs the project itself, so Run and Install ignore clicks until it's done (no greying out meanwhile). */}
      <button id="run" disabled={!s.canRun || !!s.busy.run} title={s.canRun ? undefined : CANT_RUN} onClick={() => s.ready() && app.run()}>
        <i class="i-lucide-play" aria-hidden="true" /> Run
      </button>
      <button id="share" popovertarget="share-menu" title="Share this project">
        <i class="i-lucide-share-2" aria-hidden="true" /> Share
      </button>
      <ShareMenu />
      <button
        id="install"
        disabled={!s.canRun || !!s.busy.install}
        title={s.canRun ? "bun install" : CANT_RUN}
        onClick={() => s.ready() && app.install()}
      >
        <i class="i-lucide-download" aria-hidden="true" />
        <span class="label">bun install</span>
      </button>
      <ProjectPicker />
      <span id="status" role="status" data-state={s.status().state} title={s.status().text}>
        <span class="text">{s.status().text}</span>
      </span>
      <ThemePicker />
    </>
  );
}

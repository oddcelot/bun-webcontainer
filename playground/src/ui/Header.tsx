import { For, useContext } from "solid-js";
import logo from "../bun-logo.svg";
import { examples, repoExamples } from "../examples";
import { AppContext } from "./context";
import { ShareMenu } from "./ShareMenu";
import { ThemePicker } from "./ThemePicker";
import { Title } from "./Title";

const CANT_RUN = "This browser can't run code here";

export function Header() {
  const app = useContext(AppContext);
  const s = app.session;
  let folderInput!: HTMLInputElement;

  function openRepo() {
    const input = prompt("GitHub repo (owner/repo, owner/repo@ref or a github.com URL)", app.repoParam || "oddcelot/bun-elysia-demo");
    if (input) app.openProject(`repo:${input.trim()}`);
  }

  function newFile() {
    const name = prompt("File path", "new.ts");
    if (name) app.newFile(name);
  }

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
      <button id="newfile" title="New file" onClick={newFile}>
        <i class="i-lucide-file-plus" aria-hidden="true" />
        <span class="label">New file</span>
      </button>
      <button id="openfolder" title="Open folder" onClick={() => folderInput.click()}>
        <i class="i-lucide-folder-open" aria-hidden="true" />
        <span class="label">Open folder</span>
      </button>
      <button id="openrepo" title="Open GitHub repo" onClick={openRepo}>
        <i class="i-lucide-github" aria-hidden="true" />
        <span class="label">Open GitHub repo</span>
      </button>
      <select
        id="example"
        title="Example project"
        value={s.project().selected}
        onChange={(e) => e.currentTarget.value !== "#shared" && app.openProject(e.currentTarget.value)}
      >
        <option value="">Confetti demo</option>
        <For each={Object.entries(examples)}>{([name, label]) => <option value={name}>{label}</option>}</For>
        <For each={Object.entries(repoExamples)}>{([name, label]) => <option value={`repo:${name}`}>{label}</option>}</For>
        <For each={s.project().extra}>{([label, value]) => <option value={value}>{label}</option>}</For>
      </select>
      <input
        ref={folderInput}
        id="folderinput"
        type="file"
        webkitdirectory
        multiple
        hidden
        onChange={(e) => {
          const files = [...(e.currentTarget.files ?? [])];
          e.currentTarget.value = "";
          if (files.length) app.openFolder(files);
        }}
      />
      <span id="status" role="status" data-state={s.status().state}>
        {s.status().text}
      </span>
      <ThemePicker />
    </>
  );
}

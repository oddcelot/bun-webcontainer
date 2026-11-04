import { Show, createSignal, useContext } from "solid-js";
import { examples, peekProject, repoExamples } from "../examples";
import { AppContext } from "./context";
import { PromptDialog } from "./PromptDialog";
import { Select } from "@runbun/ui/solid/Select";

type Project = { label: string; value: string; icon?: string };

// Kobalte doesn't count an empty value as selected, so the demo (the empty `?example=`) goes by this inside the picker.
const DEMO = "#demo";
const toPicker = (value: string) => value || DEMO;
const fromPicker = (value: string) => (value === DEMO ? "" : value);

// Entries that ask for a project instead of naming one.
const OPEN_FOLDER = "#open-folder";
const OPEN_ZIP = "#open-zip";
const REOPEN_FOLDER = "#reopen-folder";
const OPEN_REPO = "#open-repo";
type Group = { label: string; options: Project[] };

/**
 * The project switcher: the example projects, the GitHub ones, this page's own project when it's neither (a repo or
 * a share link), and entries to open a local folder or any GitHub repo.
 */
export function ProjectPicker() {
  const app = useContext(AppContext);
  const s = app.session;
  const groups = (extra: [string, string][], reopen?: string): Group[] => [
    {
      label: "Examples",
      options: [{ label: "Confetti demo", value: DEMO }, ...Object.entries(examples).map(([value, label]) => ({ label, value }))],
    },
    {
      label: "From GitHub",
      // The section says where they come from.
      options: Object.entries(repoExamples).map(([name, label]) => ({
        label: label.replace(/ \(from GitHub\)$/, ""),
        value: `repo:${name}`,
      })),
    },
    ...(extra.length ? [{ label: "This page", options: extra.map(([label, value]) => ({ label, value })) }] : []),
    {
      label: "Open",
      options: [
        // The folder from before a reload: opening it again asks for access.
        ...(reopen ? [{ label: `Reopen ${reopen}`, value: REOPEN_FOLDER, icon: "i-lucide-folder-sync" }] : []),
        { label: "Folder…", value: OPEN_FOLDER, icon: "i-lucide-folder-open" },
        { label: "Zip file…", value: OPEN_ZIP, icon: "i-lucide-file-archive" },
        { label: "GitHub repo…", value: OPEN_REPO, icon: "i-lucide-github" },
      ],
    },
  ];
  const current = (list: Group[]) => list.flatMap((g) => g.options).find((o) => o.value === toPicker(s.project().selected)) ?? null;
  // Rebuilt when "This page" or the folder to reopen changes (at startup, when a folder opens): changing a mounted Select's options logs STRICT_READ_UNTRACKED
  // from inside Kobalte.
  return (
    <Show when={JSON.stringify([s.project().extra, s.project().selected === "#folder" ? undefined : s.project().reopen])} keyed>
      {(key) => <Picker groups={groups(...(JSON.parse(key) as [[string, string][], string?]))} current={current} />}
    </Show>
  );
}

function Picker(props: { groups: Group[]; current: (list: Group[]) => Project | null }) {
  const app = useContext(AppContext);
  const s = app.session;
  let folderInput!: HTMLInputElement;
  let zipInput!: HTMLInputElement;

  const [asking, setAsking] = createSignal(false);

  // How long the highlight rests on an entry before the editor and file tree show it: the pointer passing over others
  // doesn't flash them, or spend GitHub API calls on them.
  const PEEK_DELAY = 120;
  const PEEK_DELAY_REPO = 300;
  let peekTimer: ReturnType<typeof setTimeout> | undefined;
  let peeking = 0;
  /** Shows the highlighted example's entry file over the editor and its files over the tree (read-only, not loaded or run). */
  function highlight(p: Project | null) {
    clearTimeout(peekTimer);
    const ask = ++peeking;
    const value = p && fromPicker(p.value);
    // The project already open and the Open entries show nothing.
    const known = value !== null && (value === "" || value in examples || (value.startsWith("repo:") && value.slice(5) in repoExamples));
    if (!p || !known || value === s.project().selected) return app.workspace.setPeek(null);
    peekTimer = setTimeout(
      async () => {
        const peek = await peekProject(value);
        if (ask !== peeking) return;
        app.workspace.setPeek(peek && { ...peek, title: p.label });
      },
      value.startsWith("repo:") ? PEEK_DELAY_REPO : PEEK_DELAY,
    );
  }

  function pick(p: Project | null) {
    // The select stays on the current project (value is controlled) unless the page navigates away.
    if (!p) return;
    // Where the browser can write to the folder, edits go back to disk; elsewhere it's a copy.
    if (p.value === OPEN_FOLDER) return "showDirectoryPicker" in window ? app.openDirectory() : folderInput.click();
    if (p.value === OPEN_ZIP) return zipInput.click();
    if (p.value === REOPEN_FOLDER) return app.reopenFolder();
    // Once the Select has closed and handed focus back to its trigger, or that would win over the dialog.
    if (p.value === OPEN_REPO) return void setTimeout(() => setAsking(true));
    // A shared project lives in the link only, an opened folder on disk: picking them again has nothing to load.
    if (p.value !== "#shared" && p.value !== "#folder" && fromPicker(p.value) !== s.project().selected) app.openProject(fromPicker(p.value));
  }

  return (
    <>
      <Select<Project, Group>
        id="example"
        label="Example project"
        tip="Example project"
        options={props.groups}
        optionValue="value"
        optionTextValue="label"
        groupChildren="options"
        value={props.current(props.groups)}
        onChange={pick}
        onHighlight={highlight}
        placement="bottom-start"
        leading={(o) => <Show when={o.icon}>{(icon) => <i class={icon()} aria-hidden="true" />}</Show>}
      />
      <PromptDialog
        open={asking()}
        onOpenChange={setAsking}
        title="Open a GitHub repo"
        description="owner/repo, owner/repo@ref or a github.com URL"
        label="Repository"
        initial={app.repoParam || "oddcelot/bun-elysia-demo"}
        submit="Open"
        onSubmit={(input) => app.openProject(`repo:${input}`)}
        returnFocus={() => document.getElementById("example")}
      />
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
      <input
        ref={zipInput}
        id="zipinput"
        type="file"
        accept=".zip,application/zip"
        hidden
        onChange={(e) => {
          const file = e.currentTarget.files?.[0];
          e.currentTarget.value = "";
          if (file) app.openZip(file);
        }}
      />
    </>
  );
}

import { For, Show, createMemo, createSignal, onSettled, untrack, useContext, type ParentProps } from "solid-js";
import { applyEdits, modify } from "jsonc-parser";
import { Dialog, DialogClose, DialogTitle, DialogTrigger, useDialogContext } from "@runbun/ui/solid/Dialog";
import { Button } from "@runbun/ui/solid/Button";
import { Field } from "@runbun/ui/solid/Field";
import { Input } from "@runbun/ui/solid/Input";
import { Segmented } from "@runbun/ui/solid/Segmented";
import { PathList } from "@runbun/ui/solid/PathList";
import { Switch } from "@runbun/ui/solid/Switch";
import { Tip } from "@runbun/ui/solid/Tip";
import { CONFIG_FILE, readConfig, type Panel, type ProjectConfig, type Requirement, type Sized } from "../projectConfig";
import { AppContext } from "./context";

/**
 * Settings, its button in the header: the reader's own (kept in this browser, for every project; the header's toggles
 * are the same ones) and the open project's runbun.json as a form. The form edits the file in place, keeping its
 * comments and layout; a field set back to its default leaves the file.
 */
export function Settings(props: { id?: string }) {
  return (
    <Dialog
      class="settings"
      trigger={
        <Tip as={DialogTrigger} id={props.id} tip="Settings" aria-label="Settings">
          <i class="i-lucide-settings" aria-hidden="true" />
        </Tip>
      }
    >
      <SettingsForm />
    </Dialog>
  );
}

/** The sections, in the sidebar's order, under their group: the reader's own, then the project's runbun.json. */
const SECTIONS = [
  { id: "editor", group: "playground", label: "Editor", icon: "i-lucide-file-pen-line" },
  { id: "running", group: "playground", label: "Running", icon: "i-lucide-play" },
  { id: "project-running", group: "project", label: "Entry & env", icon: "i-lucide-terminal" },
  { id: "files", group: "project", label: "Files", icon: "i-lucide-files" },
  { id: "layout", group: "project", label: "Layout", icon: "i-lucide-layout-panel-left" },
  { id: "preview", group: "project", label: "Preview", icon: "i-lucide-app-window" },
  { id: "card", group: "project", label: "Gallery card", icon: "i-lucide-id-card" },
] as const;
type Section = (typeof SECTIONS)[number]["id"];
const GROUPS = [
  { id: "playground", label: "Playground", hint: "Yours, in this browser, for every project" },
  { id: "project", label: "Project", hint: `Its ${CONFIG_FILE}, shared with it` },
] as const;

/** A setting's row: its name and what it does on the left, its control on the right. */
function Row(props: ParentProps<{ label: string; hint?: string }>) {
  return (
    <div class="settings-row">
      <div class="text">
        <span class="label">{props.label}</span>
        <Show when={props.hint}>
          <span class="hint">{props.hint}</span>
        </Show>
      </div>
      <div class="control">{props.children}</div>
    </div>
  );
}

// Inside the dialog's content, so each opening reads the file afresh (the content unmounts on close).
function SettingsForm() {
  const app = useContext(AppContext);
  const dialog = useDialogContext();
  const project = projectConfig();
  const [section, setSection] = createSignal<Section>("editor");
  const current = () => SECTIONS.find((s) => s.id === section())!;
  /** Up and Down (Home, End) move between the sections, as a vertical tab list does. */
  const onNavKey = (e: KeyboardEvent) => {
    const i = SECTIONS.findIndex((s) => s.id === section());
    const next = { ArrowUp: i - 1, ArrowDown: i + 1, Home: 0, End: SECTIONS.length - 1 }[e.key];
    if (next === undefined || !SECTIONS[next]) return;
    e.preventDefault();
    setSection(SECTIONS[next].id);
    (e.currentTarget as HTMLElement).querySelector<HTMLElement>(`[data-section="${SECTIONS[next].id}"]`)?.focus();
  };
  return (
    <>
      <header class="settings-header">
        <DialogTitle>Settings</DialogTitle>
        <DialogClose class="settings-close">
          <i class="i-lucide-x" aria-hidden="true" />
          <span class="sr-only">Close</span>
        </DialogClose>
      </header>
      <div class="settings-main">
        <nav class="settings-nav">
          <div role="tablist" aria-label="Settings" aria-orientation="vertical" onKeyDown={onNavKey}>
            <For each={GROUPS}>
              {(group) => (
                <>
                  <h3 title={group.hint}>{group.label}</h3>
                  <For each={SECTIONS.filter((s) => s.group === group.id)}>
                    {(s) => (
                      <button
                        type="button"
                        role="tab"
                        id={`settings-tab-${s.id}`}
                        data-section={s.id}
                        aria-controls="settings-panel"
                        aria-selected={section() === s.id ? "true" : "false"}
                        tabindex={section() === s.id ? 0 : -1}
                        onClick={() => setSection(s.id)}
                      >
                        <i class={s.icon} aria-hidden="true" />
                        {s.label}
                      </button>
                    )}
                  </For>
                </>
              )}
            </For>
          </div>
          <Button
            class="open-config"
            onClick={() => {
              app.workspace.open(CONFIG_FILE);
              dialog.close();
            }}
          >
            <i class="i-lucide-file-json" aria-hidden="true" /> Open {CONFIG_FILE}
          </Button>
        </nav>
        <section class="settings-panel" id="settings-panel" role="tabpanel" aria-labelledby={`settings-tab-${section()}`}>
          <div class="settings-page">
            <h2>
              <Show when={current().group === "project"}>
                <span class="group">{CONFIG_FILE}</span>
              </Show>
              {current().label}
            </h2>
            <SectionPage section={section()} project={project} />
          </div>
        </section>
      </div>
    </>
  );
}

/** The open section's page. */
function SectionPage(props: { section: Section; project: ProjectConfigState }) {
  return (
    <>
      <Show when={props.section === "editor"}>
        <EditorSettings />
      </Show>
      <Show when={props.section === "running"}>
        <RunningSettings />
      </Show>
      <Show when={props.section !== "editor" && props.section !== "running"}>
        <ProjectPage section={props.section} project={props.project} />
      </Show>
    </>
  );
}

/** The editor's settings: the reader's own. */
function EditorSettings() {
  const ws = useContext(AppContext).workspace;
  return (
    <div class="settings-list">
      <Row label="Auto-save" hint="Save edits shortly after typing stops. Off, they wait for Save, Run, Install or Share.">
        <Switch label="Auto-save" checked={ws.autosave()} onChange={ws.setAutosave} />
      </Row>
      <Row label="Format on save" hint="Save (Ctrl/Cmd+S) formats the file with bun fmt first.">
        <Switch label="Format on save" checked={ws.formatOnSave()} onChange={ws.setFormatOnSave} />
      </Row>
      <Row label={`Show ${CONFIG_FILE}`} hint={`In the file tree and the tabs. Hidden, it still applies, and the ${CONFIG_FILE} sections here edit it.`}>
        <Switch label={`Show ${CONFIG_FILE}`} checked={ws.showConfig()} onChange={(on) => ws.setShowConfig(on)} />
      </Row>
    </div>
  );
}

/** How runs go: the reader's own. */
function RunningSettings() {
  const ws = useContext(AppContext).workspace;
  return (
    <div class="settings-list">
      <Row label="Restart on save" hint="Restart the program on every save (bun --watch). Off, only Run restarts it.">
        <Switch label="Restart on save" checked={ws.watch()} onChange={ws.setWatch} />
      </Row>
      <Row
        label="Fast path"
        hint={`Experimental. Browser-only projects run without an install, packages from esm.sh; no dev server, so no hot reload. Applies on the next Run; a project's ${CONFIG_FILE} can opt out.`}
      >
        <Switch label="Fast path" checked={ws.fast()} onChange={ws.setFast} />
      </Row>
    </div>
  );
}

const lines = (list: string[] | undefined) => (list ?? []).join("\n");
const fromLines = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
/** An object without its unset entries (undefined, empty strings and lists); other values as they are. */
const clean = (v: unknown): unknown =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).filter(([, x]) => !isEmpty(x))) : v;
/** A value the file leaves out: undefined, an empty string, list or object. */
const isEmpty = (v: unknown) => v === undefined || v === "" || (Array.isArray(v) ? !v.length : typeof v === "object" && v !== null && !Object.keys(v).length);

const PANELS: [Panel, string][] = [
  ["files", "File tree"],
  ["tabs", "Editor tabs (embeds)"],
  ["preview", "Preview"],
  ["console", "Console"],
];
const SIZES: [Sized, string, string][] = [
  ["files", "File tree", "of the width"],
  ["editor", "Editor", "beside the preview and console"],
  ["preview", "Preview", "of its column, over the console"],
];
const REQUIRES: [Requirement, string, string][] = [
  ["cross-origin-isolation", "cross-origin isolation", "SharedArrayBuffer and threads (Vite, Rolldown); runbun.dev has it, some hosts don't"],
  ["local-bun", "Local Bun", "Native Bun on the reader's machine: child processes, native addons"],
];

/** A list of project paths under its label, each removable, with a field that adds one. */
function FileList(props: { label: string; hint: string; value: string[] | undefined; suggestions: string[]; onChange: (v: string[]) => void }) {
  return (
    <div class="field">
      <span class="field-label">
        {props.label}
        <span class="field-hint">{props.hint}</span>
      </span>
      <PathList label={props.label} value={props.value ?? []} suggestions={props.suggestions} onChange={(v) => props.onChange(v)} placeholder="Add a file" />
    </div>
  );
}

/** The open project's runbun.json as the form reads and writes it, kept current while Settings is open. */
function projectConfig() {
  const { vfs, workspace: ws } = useContext(AppContext);
  const [text, setText] = createSignal(vfs.readText(CONFIG_FILE));
  onSettled(() => vfs.onChange(({ path }) => path === CONFIG_FILE && setText(vfs.readText(CONFIG_FILE))));
  const parsed = createMemo(() => {
    const problems: string[] = [];
    const t = text();
    const config: ProjectConfig = readConfig(() => t, problems);
    return { config, problems };
  });
  const c = () => parsed().config;
  // The project's files and folders, offered when adding to a list (not node_modules or .git).
  const [version, setVersion] = createSignal(0);
  onSettled(() => vfs.onChange(({ created, removed }) => (created || removed) && setVersion((n) => n + 1)));
  const files = createMemo(() => {
    version();
    return [...vfs.files.keys()].filter((p) => !/(^|\/)(node_modules|\.git)\//.test(p)).sort();
  });
  const folders = createMemo(() => [...new Set(files().flatMap((p) => p.split("/").slice(0, -1).map((_, i, parts) => `${parts.slice(0, i + 1).join("/")}/`)))].sort());
  /** The file doesn't parse: the form would write over what it can't read. */
  const broken = () => parsed().problems.some((p) => p.startsWith(`${CONFIG_FILE} isn't valid JSON`) || p.startsWith(`${CONFIG_FILE} must hold`));

  /** Sets a top-level field (removed when empty), keeping the rest of the file as it is. */
  function set(key: keyof ProjectConfig, value: unknown) {
    // The editor's unsaved text of the file would otherwise overwrite this change on its next save.
    ws.saveAll();
    const before = vfs.readText(CONFIG_FILE) ?? `{\n  "$schema": "https://runbun.dev/schema/runbun.json"\n}\n`;
    value = clean(value);
    const edits = modify(before, [key], isEmpty(value) ? undefined : value, { formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" } });
    const after = applyEdits(before, edits);
    if (after === before) return;
    vfs.write(CONFIG_FILE, after);
    if (key === "readonly") ws.setReadonly((value as string[] | undefined) ?? []);
  }
  return { text, parsed, c, files, folders, broken, set };
}
type ProjectConfigState = ReturnType<typeof projectConfig>;

/** A tri-state: unset (the default), or true/false. */
const tri = (v: boolean | undefined) => (v === undefined ? "default" : v ? "on" : "off");
const fromTri = (v: string) => (v === "default" ? undefined : v === "on");

/** One section of the open project's runbun.json, field by field. */
function ProjectPage(props: { section: Section; project: ProjectConfigState }) {
  const { text, parsed, c, files, folders, broken, set } = untrack(() => props.project);

  return (
    <div class="settings-list project">
      <Show when={parsed().problems.length}>
        <ul class="settings-problems" role="status">
          <For each={parsed().problems}>{(p) => <li>{p}</li>}</For>
        </ul>
      </Show>
      <Show
        when={!broken()}
        fallback={<p class="settings-note">Fix {CONFIG_FILE} in the editor first; the form would overwrite what it can't read.</p>}
      >
        <Show when={text() === undefined}>
          <p class="settings-note">This project has no {CONFIG_FILE}. A change here creates it.</p>
        </Show>

        <Show when={props.section === "project-running"}>
        <div class="settings-grid">
          <Field label="Entry" hint="what Run starts">
            <Input spellcheck={false} value={c().run?.entry ?? ""} placeholder="guessed" onChange={(e) => {
              const entry = e.currentTarget.value.trim();
              set("run", entry ? { entry, ...(c().run?.args.length ? { args: c().run!.args } : {}) } : undefined);
            }} />
          </Field>
          <Field label="Arguments" hint="space-separated">
            <Input spellcheck={false} disabled={!c().run} value={(c().run?.args ?? []).join(" ")} onChange={(e) => {
              const args = e.currentTarget.value.split(/\s+/).filter(Boolean);
              if (c().run) set("run", { entry: c().run!.entry, ...(args.length ? { args } : {}) });
            }} />
          </Field>
        </div>
        <Row label="Run once opened" hint="Code from a link still waits for the reader's Run.">
          <Switch label="Run once opened" checked={c().autorun !== false} onChange={(on) => set("autorun", on ? undefined : false)} />
        </Row>
        <Row label="Allow the fast path" hint="Off: always install and start the dev server, even with the reader's fast path on.">
          <Switch label="Allow the fast path" checked={c().fastPath !== false} onChange={(on) => set("fastPath", on ? undefined : false)} />
        </Row>
        <Field label="Environment" hint="KEY=value per line; not for secrets, the file is shared">
          <Input multiline rows={3} spellcheck={false} value={Object.entries(c().env ?? {}).map(([k, v]) => `${k}=${v}`).join("\n")} onChange={(e) => {
            const env: Record<string, string> = {};
            for (const line of fromLines(e.currentTarget.value)) {
              const i = line.indexOf("=");
              if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1);
            }
            set("env", env);
          }} />
        </Field>
        <For each={REQUIRES}>
          {([need, label, hint]) => (
            <Row label={`Needs ${label}`} hint={`${hint}. The playground says so up front where it's missing.`}>
              <Switch
                label={`Needs ${label}`}
                checked={(c().requires ?? []).includes(need)}
                onChange={(on) => set("requires", on ? [...(c().requires ?? []), need] : (c().requires ?? []).filter((r) => r !== need))}
              />
            </Row>
          )}
        </For>
        </Show>
        <Show when={props.section === "files"}>
        <div class="settings-stack">
          <FileList label="Open" hint="as tabs, the first shown" value={c().open} suggestions={files()} onChange={(v) => set("open", v)} />
          <FileList label="Hidden" hint="kept out of the tabs" value={c().hidden} suggestions={files()} onChange={(v) => set("hidden", v)} />
          <FileList label="Read-only" hint="files or folders" value={c().readonly} suggestions={[...folders(), ...files()]} onChange={(v) => set("readonly", v)} />
        </div>
        </Show>
        <Show when={props.section === "layout"}>
        <p class="settings-note">Applies when the project opens.</p>
        <For each={PANELS}>
          {([panel, label]) => (
            <Row label={label}>
              <Segmented
                label={label}
                value={tri(c().panels?.[panel])}
                options={[
                  ["default", "Default"],
                  ["on", "Show"],
                  ["off", "Hide"],
                ]}
                onChange={(v) => set("panels", { ...c().panels, [panel]: fromTri(v) })}
              />
            </Row>
          )}
        </For>
        <Row label="Embed layout" hint="The preview beside the editor or under it, unless the embedding page says.">
          <Segmented
            label="Embed layout"
            value={c().layout ?? "default"}
            options={[
              ["default", "Default"],
              ["side", "Side"],
              ["stack", "Stack"],
            ]}
            onChange={(v) => set("layout", v === "default" ? undefined : v)}
          />
        </Row>
        <For each={SIZES}>
          {([key, label, hint]) => (
            <Row label={`${label} size`} hint={`Percent ${hint}; empty: as the reader left it.`}>
              <Input
                class="percent"
                type="number"
                min={1}
                max={99}
                aria-label={`${label} size, percent`}
                value={c().sizes?.[key] ?? ""}
                onChange={(e) => {
                  const n = e.currentTarget.valueAsNumber;
                  set("sizes", { ...c().sizes, [key]: n > 0 && n < 100 ? n : undefined });
                }}
              />
            </Row>
          )}
        </For>
        </Show>
        <Show when={props.section === "preview"}>
        <div class="settings-grid">
          <Field label="Path" hint="where it points first">
            <Input spellcheck={false} value={c().preview?.path ?? ""} placeholder="/" onChange={(e) => set("preview", { ...c().preview, path: e.currentTarget.value.trim() || undefined })} />
          </Field>
          <Field label="Requests" hint="one per line, each in its own tab: GET /api">
            <Input multiline rows={3} spellcheck={false} value={lines(c().preview?.requests)} onChange={(e) => set("preview", { ...c().preview, requests: fromLines(e.currentTarget.value) })} />
          </Field>
        </div>
        </Show>
        <Show when={props.section === "card"}>
        <p class="settings-note">How the project shows in a gallery: the playground's examples, an embed's library.</p>
        <div class="settings-grid">
          <Field label="Name">
            <Input value={c().name ?? ""} onChange={(e) => set("name", e.currentTarget.value.trim())} />
          </Field>
          <Field label="Tags" hint="comma-separated">
            <Input spellcheck={false} value={(c().tags ?? []).join(", ")} onChange={(e) => set("tags", e.currentTarget.value.split(",").map((t) => t.trim()).filter(Boolean))} />
          </Field>
        </div>
        <Field label="Description">
          <Input value={c().description ?? ""} onChange={(e) => set("description", e.currentTarget.value.trim())} />
        </Field>
        <Row label="Kind">
          <Segmented
            label="Kind"
            value={c().kind ?? "default"}
            options={[
              ["default", "None"],
              ["starter", "Starter"],
              ["example", "Example"],
            ]}
            onChange={(v) => set("kind", v === "default" ? undefined : v)}
          />
        </Row>
        </Show>
      </Show>
    </div>
  );
}

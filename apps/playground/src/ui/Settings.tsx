import { For, Show, createMemo, createSignal, createStore, onSettled, snapshot, untrack, useContext, type ParentProps } from "solid-js";
import { applyEdits, modify } from "jsonc-parser";
import { Dialog, DialogClose, DialogTitle, DialogTrigger, useDialogContext } from "@runbun/ui/solid/Dialog";
import { Button } from "@runbun/ui/solid/Button";
import { Field } from "@runbun/ui/solid/Field";
import { Input } from "@runbun/ui/solid/Input";
import { Segmented } from "@runbun/ui/solid/Segmented";
import { PathList } from "@runbun/ui/solid/PathList";
import { PathInput } from "@runbun/ui/solid/PathInput";
import { Switch } from "@runbun/ui/solid/Switch";
import { Tip } from "@runbun/ui/solid/Tip";
import { CONFIG_FILE, readConfig, type Panel, type ProjectConfig, type Requirement, type Sized } from "../projectConfig";
import { AppContext } from "./context";
import { HOSTING } from "../hosting";
import type { JSX } from "@solidjs/web";
import { commandOf, isShellCommand } from "../scripts";
import { Fields, METHODS, MethodBadge } from "./RequestFields";
import { hasBody } from "./previews";
import { Select } from "@runbun/ui/solid/Select";
import { formatRequest, parseRequests, type PresetRequest } from "../embed/requests";
import type { Field as RequestField } from "../request";
import { placeTiles as place } from "@runbun/ui/solid/Tiling";
import { PRESETS, TILES, activeTiles, isPreset, type Tile } from "./Tiles";

// Open from the header's button or the command palette.
const [settingsOpen, setSettingsOpen] = createSignal(false);
/** Opens Settings (the command palette's Open Settings). */
export const openSettings = () => setSettingsOpen(true);

/**
 * Settings, its button in the header: the reader's own (kept in this browser, for every project; the header's toggles
 * are the same ones) and the open project's runbun.json as a form. The form edits the file in place, keeping its
 * comments and layout; a field set back to its default leaves the file.
 */
export function Settings(props: { id?: string }) {
  return (
    <Dialog
      open={settingsOpen()}
      onOpenChange={setSettingsOpen}
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
  { id: "panels", group: "playground", label: "Panels", icon: "i-lucide-layout-dashboard" },
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
function Row(props: ParentProps<{ label: string; hint?: string; reset?: ResetProps }>) {
  return (
    <div class="settings-row">
      <div class="text">
        <span class="label">{props.label}</span>
        <Show when={props.hint}>
          <span class="hint">{props.hint}</span>
        </Show>
      </div>
      <div class="control">
        <Show when={props.reset}>{(r) => <Reset what={props.label} shown={r().shown} default={r().default} onReset={() => r().onReset()} />}</Show>
        {props.children}
      </div>
    </div>
  );
}

/** A setting's way back to its default: shown when `shown`, the tooltip naming `default`. */
type ResetProps = { shown: boolean; default: string; onReset: () => void };

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
            <h2>{current().label}</h2>
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
      <Show when={props.section === "panels"}>
        <PanelsSettings />
      </Show>
      <Show when={props.section !== "editor" && props.section !== "running" && props.section !== "panels"}>
        <ProjectPage section={props.section} project={props.project} />
      </Show>
    </>
  );
}

/** A reader's setting's reset: shown while it differs from its default. */
const pref = (value: boolean, initial: boolean, set: (v: boolean) => void): ResetProps => ({ shown: value !== initial, default: initial ? "on" : "off", onReset: () => set(initial) });

/** The editor's settings: the reader's own. */
function EditorSettings() {
  const ws = useContext(AppContext).workspace;
  return (
    <div class="settings-list">
      <Row label="Auto-save" hint="Save edits shortly after typing stops. Off, they wait for Save, Run, Install or Share." reset={pref(ws.autosave(), true, ws.setAutosave)}>
        <Switch label="Auto-save" checked={ws.autosave()} onChange={ws.setAutosave} />
      </Row>
      <Row label="Format on save" hint="Save (Ctrl/Cmd+S) formats the file with bun fmt first." reset={pref(ws.formatOnSave(), false, ws.setFormatOnSave)}>
        <Switch label="Format on save" checked={ws.formatOnSave()} onChange={ws.setFormatOnSave} />
      </Row>
      <Row
        label={`Show ${CONFIG_FILE}`}
        hint={`In the file tree and the tabs. Hidden, it still applies, and the ${CONFIG_FILE} sections here edit it.`}
        reset={pref(ws.showConfig(), HOSTING.showConfig, (on) => ws.setShowConfig(on))}
      >
        <Switch label={`Show ${CONFIG_FILE}`} checked={ws.showConfig()} onChange={(on) => ws.setShowConfig(on)} />
      </Row>
      <Row label="Show hidden files" hint={`What a project keeps out of its file tree (${CONFIG_FILE}'s hiddenInTree), in the tree and in Go to a file.`} reset={pref(ws.showHidden(), false, ws.setShowHidden)}>
        <Switch label="Show hidden files" checked={ws.showHidden()} onChange={ws.setShowHidden} />
      </Row>
    </div>
  );
}

/** How runs go: the reader's own. */
function RunningSettings() {
  const ws = useContext(AppContext).workspace;
  return (
    <div class="settings-list">
      <Row label="Restart on save" hint="Restart the program on every save (bun --watch). Off, only Run restarts it." reset={pref(ws.watch(), true, ws.setWatch)}>
        <Switch label="Restart on save" checked={ws.watch()} onChange={ws.setWatch} />
      </Row>
      <Row
        label="Fast path"
        hint={`Experimental. Browser-only projects run without an install, packages from esm.sh; no dev server, so no hot reload. Applies on the next Run; a project's ${CONFIG_FILE} can opt out.`}
        reset={pref(ws.fast(), false, ws.setFast)}
      >
        <Switch label="Fast path" checked={ws.fast()} onChange={ws.setFast} />
      </Row>
    </div>
  );
}

/** How each panel shows in a preset's picture. */
const PANEL_LOOKS: Record<Tile, { label: string; icon: string }> = {
  files: { label: "Files", icon: "i-lucide-folder-tree" },
  editor: { label: "Editor", icon: "i-lucide-code" },
  preview: { label: "Preview", icon: "i-lucide-app-window" },
  console: { label: "Console", icon: "i-lucide-square-terminal" },
};
/** The picture's room and the gap between its panels, in units of its own (16 by 10, as it is drawn). */
const PICTURE = { x: 0, y: 0, w: 160, h: 100 };
const PICTURE_GAP = 4;

/** The panels' arrangement: the reader's own. A few to pick from, each a small picture of itself. */
function PanelsSettings() {
  const tiles = activeTiles();
  return (
    <div class="settings-list">
      <Show when={tiles}>
        {(t) => (
          <>
            <div class="layout-presets" role="group" aria-label="Arrangement">
              <For each={PRESETS}>
                {(preset) => (
                  <button type="button" class="layout-preset" aria-pressed={isPreset(t().layout(), preset.layout) ? "true" : "false"} onClick={() => t().setLayout(preset.layout)}>
                    <span class="picture" aria-hidden="true">
                      <For each={[...place(preset.layout.tree, PICTURE, PICTURE_GAP, new Set(preset.layout.hidden)).rects]}>
                        {([tile, r]) => (
                          <span class="panel" data-panel={tile} title={PANEL_LOOKS[tile as Tile].label} style={{ left: `${r.x / 1.6}%`, top: `${r.y}%`, width: `${r.w / 1.6}%`, height: `${r.h}%` }}>
                            <i class={PANEL_LOOKS[tile as Tile].icon} />
                          </span>
                        )}
                      </For>
                    </span>
                    <span class="name">{preset.label}</span>
                  </button>
                )}
              </For>
            </div>
            <ul class="layout-legend">
              <For each={TILES}>
                {(tile) => (
                  <li data-panel={tile}>
                    <i class={PANEL_LOOKS[tile].icon} aria-hidden="true" /> {PANEL_LOOKS[tile].label}
                  </li>
                )}
              </For>
            </ul>
            <p class="settings-note">
              Picking one replaces your arrangement in this window. From there it is yours again: drag a border to resize, hold Alt and drag a panel to move it, and the status bar's
              buttons show and hide each.
            </p>
          </>
        )}
      </Show>
    </div>
  );
}

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

/** What a pane does when runbun.json doesn't say: this host's `panels`, else the reader's layout (embeds: shown). */
const panelDefault = (panel: Panel) => {
  const host = HOSTING.panels?.[panel as "files"];
  if (host !== undefined) return `${host ? "shown" : "hidden"}, as this playground's host sets`;
  return panel === "tabs" ? "shown" : "as the reader left it (shown at first)";
};

/** A setting's reset: shown while runbun.json sets it, its tooltip naming the default it goes back to. */
function Reset(props: { what: string; shown: boolean; default: string; onReset: () => void }) {
  return (
    <Tip
      type="button"
      class="reset"
      tip={`Reset to the default: ${props.default}`}
      aria-label={`Reset ${props.what} to the default`}
      data-shown={props.shown ? "" : undefined}
      tabindex={props.shown ? 0 : -1}
      aria-hidden={props.shown ? undefined : "true"}
      onClick={() => props.onReset()}
    >
      <i class="i-lucide-rotate-ccw" aria-hidden="true" />
    </Tip>
  );
}

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
  ["cross-origin-isolation", "cross-origin isolation", "For projects that use SharedArrayBuffer or threads, like Vite and Rolldown. Where the page doesn't have it, the console warns when the project opens."],
  ["local-bun", "Local Bun", "For projects that need Bun on your machine: child processes or native addons. With Local Bun off, the console warns when the project opens."],
];

/** A field whose label has an info button: its tooltip says what the field does, with examples. */
function InfoField(props: ParentProps<{ id: string; label: string; hint?: string; info?: JSX.Element; reset?: ResetProps }>) {
  // Built here, under this component: the tooltip renders its content later, in a portal with no owner.
  const tip = untrack(() => props.info) && <span class="info-tip">{untrack(() => props.info)}</span>;
  return (
    <div class="field">
      <span class="field-label">
        <label for={props.id}>{props.label}</label>
        <Show when={props.hint}>
          <span class="field-hint">{props.hint}</span>
        </Show>
        <Show when={tip}>
          <Tip type="button" class="info" tip={tip} aria-label={`About ${props.label}`}>
            <i class="i-lucide-info" aria-hidden="true" />
          </Tip>
        </Show>
        <Show when={props.reset}>{(r) => <Reset what={props.label} shown={r().shown} default={r().default} onReset={() => r().onReset()} />}</Show>
      </span>
      {props.children}
    </div>
  );
}

/** A preset request being edited, with whether its headers and body show. */
type Draft = PresetRequest & { open: boolean };

/**
 * runbun.json's `preview.requests` as a list: each a method, a path, and (opened) its headers and body, as the preview's
 * request bar has them; rows can be added and removed. Edits are kept here and written shortly after typing stops.
 */
function RequestPresets(props: { requests: string[]; onChange: (requests: string[]) => void }) {
  // Read once: the list is the source while it's shown (a write coming back mustn't reset a row being typed in).
  const [drafts, setDrafts] = createStore<{ list: Draft[] }>({ list: parseRequests(untrack(() => props.requests).join("; ")).map((r) => ({ ...r, open: false })) });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const write = (now = false) => {
    clearTimeout(timer);
    const save = () => props.onChange(snapshot(drafts.list).filter((r) => r.path.trim()).map(({ open: _, ...r }) => formatRequest(r)));
    if (now) save();
    else timer = setTimeout(save, 400);
  };
  onSettled(() => () => {
    // Settings closing or the section changing: what's still waiting is written.
    if (timer !== undefined) write(true);
  });
  const edit = (i: number, fn: (d: Draft) => void, now = false) => {
    setDrafts((s) => fn(s.list[i]!));
    write(now);
  };
  const headerRows = (d: Draft): RequestField[] => (d.headers ?? []).map(([name, value]) => ({ name, value, on: true }));
  return (
    <div class="request-presets">
      <Show when={drafts.list.length} fallback={<p class="settings-note">None: the preview opens on its path.</p>}>
        <ol>
          <For each={drafts.list} keyed={false}>
            {(d, i) => (
              <li class="preset" data-open={d().open ? "" : undefined}>
                <div class="line">
                  <Select<string>
                    class="method"
                    label={`Request ${i + 1}: method`}
                    options={METHODS}
                    value={d().method}
                    onChange={(m) => m && edit(i, (x) => void (x.method = m), true)}
                    placement="bottom-start"
                    menuClass="method-menu"
                    text={(m) => <MethodBadge method={m} />}
                  />
                  <input
                    class="input path"
                    spellcheck={false}
                    placeholder="/path"
                    aria-label={`Request ${i + 1}: path`}
                    value={d().path}
                    onInput={(e) => edit(i, (x) => void (x.path = e.currentTarget.value))}
                  />
                  <Tip
                    type="button"
                    class="more"
                    tip={d().open ? "Hide headers and body" : "Headers and body"}
                    aria-label={`Request ${i + 1}: headers and body`}
                    aria-expanded={d().open ? "true" : "false"}
                    onClick={() => setDrafts((s) => void (s.list[i]!.open = !s.list[i]!.open))}
                  >
                    <i class="i-lucide-sliders-horizontal" aria-hidden="true" />
                    <Show when={(d().headers?.length ?? 0) + (d().body.trim() ? 1 : 0)}>{(n) => <span class="count">{n()}</span>}</Show>
                  </Tip>
                  <Tip type="button" class="remove" tip="Remove" aria-label={`Remove request ${i + 1}`} onClick={() => {
                    setDrafts((s) => void s.list.splice(i, 1));
                    write(true);
                  }}>
                    <i class="i-lucide-x" aria-hidden="true" />
                  </Tip>
                </div>
                <Show when={d().open}>
                  <div class="details">
                    <span class="sub">Headers</span>
                    <Fields
                      label={`Request ${i + 1}: headers`}
                      rows={headerRows(d())}
                      hidden={false}
                      onChange={(row, change) =>
                        edit(i, (x) => {
                          const h = (x.headers ??= []);
                          if (!h[row]) h.push([change.name ?? "", change.value ?? ""]);
                          else {
                            if (change.name !== undefined) h[row][0] = change.name;
                            if (change.value !== undefined) h[row][1] = change.value;
                          }
                        })
                      }
                      onRemove={(row) => edit(i, (x) => void x.headers?.splice(row, 1), true)}
                    />
                    <Show when={hasBody(d().method)}>
                      <span class="sub">Body</span>
                      <Input
                        multiline
                        rows={3}
                        spellcheck={false}
                        placeholder='{"name": "value"}, sent as JSON when it parses'
                        aria-label={`Request ${i + 1}: body`}
                        value={d().body}
                        onInput={(e) => edit(i, (x) => void (x.body = e.currentTarget.value))}
                      />
                    </Show>
                  </div>
                </Show>
              </li>
            )}
          </For>
        </ol>
      </Show>
      <Button class="add" onClick={() => setDrafts((s) => void s.list.push({ method: "GET", path: "/", body: "", open: false }))}>
        <i class="i-lucide-plus" aria-hidden="true" /> Add a request
      </Button>
    </div>
  );
}

/** A list of project paths under its label, each removable, with a field that adds one. */
function FileList(props: { label: string; hint: string; value: string[] | undefined; suggestions: string[]; onChange: (v: string[]) => void }) {
  return (
    <div class="field">
      <span class="field-label">
        {props.label}
        <span class="field-hint">{props.hint}</span>
      </span>
      <PathList label={props.label} value={props.value ?? []} suggestions={props.suggestions} onChange={(v) => props.onChange(v)} placeholder="Add a file…" />
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
    if (key === "hiddenInTree") ws.setTreeHidden(((value as string[] | undefined) ?? []).map((p) => p.replace(/\/+$/, "")));
  }
  // What Run starts without runbun.json's `run`: the playground's own guess (scripts.ts commandOf), read with the file left out.
  const guessed = createMemo(() => {
    version();
    text();
    return commandOf((p) => vfs.files.has(p), (p) => (p === CONFIG_FILE ? undefined : vfs.readText(p)));
  });
  /** The guess is a file to name (not a package.json script run through the shell). */
  const guessShown = () => !isShellCommand(guessed().entry, guessed().args);
  /** The command Run starts, as one line. */
  const commandLine = () => {
    const run = c().run ?? guessed();
    return isShellCommand(run.entry, run.args) ? run.args[1]! : ["bun", run.entry, ...run.args].join(" ");
  };
  return { text, parsed, c, files, folders, broken, set, guessed, guessShown, commandLine };
}
type ProjectConfigState = ReturnType<typeof projectConfig>;


/** One section of the open project's runbun.json, field by field. */
function ProjectPage(props: { section: Section; project: ProjectConfigState }) {
  const { text, parsed, c, files, folders, broken, set, guessed, guessShown, commandLine } = untrack(() => props.project);
  /** A field's reset: shown while the file sets it, back to `fallback` by leaving it out. */
  const unset = (key: keyof ProjectConfig, value: unknown, fallback: string): ResetProps => ({ shown: value !== undefined, default: fallback, onReset: () => set(key, undefined) });

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
          <InfoField
            id="settings-entry"
            label="Entry"
            hint="the file Run starts"
            reset={{ shown: !!c().run, default: guessShown() ? `${guessed().entry} (guessed)` : "guessed from package.json", onReset: () => set("run", undefined) }}
            info={
              <>
                The file Run starts, as <code>bun &lt;entry&gt;</code>, relative to the project's root. Empty, it's guessed: package.json's{" "}
                <code>module</code> or <code>main</code>, a <code>bun &lt;file&gt;</code> dev or start script, a script that runs a package's bin (<code>vite</code>),
                else <code>index.ts</code>. Examples: <code>src/server.ts</code>, <code>index.html</code>
              </>
            }
          >
            <PathInput
              id="settings-entry"
              label="Entry"
              value={c().run?.entry ?? ""}
              suggestions={files().filter((f) => /\.(m?[jt]sx?|html)$/.test(f))}
              placeholder={guessShown() ? `${guessed().entry} (guessed)` : "index.ts"}
              onChange={(entry) => set("run", entry ? { entry, ...(c().run?.args.length ? { args: c().run!.args } : {}) } : undefined)}
            />
          </InfoField>
          <InfoField
            id="settings-args"
            label="Arguments"
            hint="space-separated"
            reset={{ shown: !!c().run?.args.length, default: "none", onReset: () => c().run && set("run", { entry: c().run!.entry }) }}
            info={
              <>
                Passed to the program after the entry, <code>bun &lt;entry&gt; &lt;arguments&gt;</code>; it reads them in <code>Bun.argv</code> (or{" "}
                <code>process.argv</code>) from index 2. Examples: <code>--port 3000</code>, <code>--verbose data.json</code>
              </>
            }
          >
            <Input
              id="settings-args"
              spellcheck={false}
              value={(c().run?.args ?? []).join(" ")}
              placeholder={!c().run && guessShown() && guessed().args.length ? `${guessed().args.join(" ")} (guessed)` : "--port 3000"}
              onChange={(e) => {
                const args = e.currentTarget.value.split(/\s+/).filter(Boolean);
                // Arguments need an entry: the guessed one, written out, when none is set.
                const entry = c().run?.entry ?? (guessShown() ? guessed().entry : undefined);
                if (entry) set("run", args.length || c().run ? { entry, ...(args.length ? { args } : {}) } : undefined);
              }}
            />
          </InfoField>
        </div>
        <p class="settings-command">
          Run starts <code>{commandLine()}</code>
          <Show when={!c().run}>
            <span class="settings-note"> (guessed)</span>
          </Show>
        </p>
        <Row label="Run once opened" hint="Code from a link still waits for the reader's Run." reset={unset("autorun", c().autorun, "on")}>
          <Switch label="Run once opened" checked={c().autorun ?? true} unset={c().autorun === undefined} onChange={(on) => set("autorun", on)} />
        </Row>
        <Row
          label="Allow the fast path"
          hint="Off: always install and start the dev server, even with the reader's fast path on."
          reset={unset("fastPath", c().fastPath, "on, when the reader has it on")}
        >
          <Switch label="Allow the fast path" checked={c().fastPath ?? true} unset={c().fastPath === undefined} onChange={(on) => set("fastPath", on)} />
        </Row>
        <InfoField
          id="settings-env"
          label="Environment"
          hint="KEY=value per line"
          reset={unset("env", c().env, "none, the playground's own")}
          info={
            <>
              Set in <code>process.env</code> and <code>Bun.env</code> for the program, over the defaults. Not for secrets: the file is shared
              with the project. Example: <code>LOG_LEVEL=debug</code>, <code>PORT=3000</code>
            </>
          }
        >
          <Input id="settings-env" placeholder={"LOG_LEVEL=debug\nPORT=3000"} multiline rows={3} spellcheck={false} value={Object.entries(c().env ?? {}).map(([k, v]) => `${k}=${v}`).join("\n")} onChange={(e) => {
            const env: Record<string, string> = {};
            for (const line of fromLines(e.currentTarget.value)) {
              const i = line.indexOf("=");
              if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1);
            }
            set("env", env);
          }} />
        </InfoField>
        <For each={REQUIRES}>
          {([need, label, hint]) => (
            <Row
              label={`Needs ${label}`}
              hint={hint}
              reset={{ shown: (c().requires ?? []).includes(need), default: "off", onReset: () => set("requires", (c().requires ?? []).filter((r) => r !== need)) }}
            >
              <Switch
                label={`Needs ${label}`}
                unset={!(c().requires ?? []).includes(need)}
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
          <FileList label="Hidden in the file tree" hint="files or folders, until the reader shows hidden files" value={c().hiddenInTree} suggestions={[...folders(), ...files()]} onChange={(v) => set("hiddenInTree", v)} />
        </div>
        </Show>
        <Show when={props.section === "layout"}>
        <p class="settings-note">Applies when the project opens.</p>
        <For each={PANELS}>
          {([panel, label]) => (
            <Row
              label={`Show the ${label.toLowerCase()}`}
              reset={{ shown: c().panels?.[panel] !== undefined, default: panelDefault(panel), onReset: () => set("panels", { ...c().panels, [panel]: undefined }) }}
            >
              <Switch
                label={`Show the ${label.toLowerCase()}`}
                checked={c().panels?.[panel] ?? HOSTING.panels?.[panel as "files"] ?? true}
                unset={c().panels?.[panel] === undefined}
                onChange={(on) => set("panels", { ...c().panels, [panel]: on })}
              />
            </Row>
          )}
        </For>
        <Row label="Embed layout" hint="Whether the preview sits beside the editor or under it. The embedding page's own setting wins." reset={unset("layout", c().layout, "side")}>
          <Segmented
            label="Embed layout"
            value={c().layout ?? "side"}
            options={[
              ["side", "Side", "i-lucide-columns-2"],
              ["stack", "Stack", "i-lucide-rows-2"],
            ]}
            onChange={(v) => set("layout", v)}
          />
        </Row>
        <For each={SIZES}>
          {([key, label, hint]) => (
            <Row
              label={`${label} size`}
              hint={`Percent ${hint}.`}
              reset={{ shown: c().sizes?.[key] !== undefined, default: "as the reader left it", onReset: () => set("sizes", { ...c().sizes, [key]: undefined }) }}
            >
              <Input
                class="percent"
                type="number"
                min={1}
                max={99}
                aria-label={`${label} size, percent`}
                value={c().sizes?.[key] ?? ""}
                placeholder="auto"
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
        <div class="settings-stack">
          <InfoField id="settings-preview-path" label="Path" hint="where the preview opens" reset={{ shown: !!c().preview?.path, default: "/", onReset: () => set("preview", { ...c().preview, path: undefined }) }}>
            <Input id="settings-preview-path" spellcheck={false} value={c().preview?.path ?? ""} placeholder="/" onChange={(e) => set("preview", { ...c().preview, path: e.currentTarget.value.trim() || undefined })} />
          </InfoField>
          <div class="field">
            <span class="field-label">
              Requests
              <span class="field-hint">each opens in its own preview tab, the first sent on Run</span>
            </span>
            <RequestPresets requests={untrack(() => c().preview?.requests ?? [])} onChange={(requests) => set("preview", { ...c().preview, requests })} />
          </div>
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
        <Row label="Kind" hint="Starter: a small project to build on. Example: one that shows a framework or feature." reset={unset("kind", c().kind, "none")}>
          <Segmented
            label="Kind"
            value={c().kind ?? ""}
            options={[
              ["starter", "Starter"],
              ["example", "Example"],
            ]}
            onChange={(v) => set("kind", v)}
          />
        </Row>
        </Show>
      </Show>
    </div>
  );
}

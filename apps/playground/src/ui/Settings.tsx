import { For, Show, createMemo, createSignal, createStore, onSettled, snapshot, untrack, useContext, type ParentProps } from "solid-js";
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
import type { JSX } from "@solidjs/web";
import { commandOf, isShellCommand } from "../scripts";
import { Fields, METHODS, MethodBadge } from "./RequestFields";
import { hasBody } from "./previews";
import { Select } from "@runbun/ui/solid/Select";
import { formatRequest, parseRequests, type PresetRequest } from "../embed/requests";
import type { Field as RequestField } from "../request";

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

/** A field whose label has an info button: its tooltip says what the field does, with examples. */
function InfoField(props: ParentProps<{ id: string; label: string; hint?: string; info: JSX.Element }>) {
  // Built here, under this component: the tooltip renders its content later, in a portal with no owner.
  const tip = <span class="info-tip">{untrack(() => props.info)}</span>;
  return (
    <div class="field">
      <span class="field-label">
        <label for={props.id}>{props.label}</label>
        <Show when={props.hint}>
          <span class="field-hint">{props.hint}</span>
        </Show>
        <Tip type="button" class="info" tip={tip} aria-label={`About ${props.label}`}>
          <i class="i-lucide-info" aria-hidden="true" />
        </Tip>
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

/** A tri-state: unset (the default), or true/false. */
const tri = (v: boolean | undefined) => (v === undefined ? "default" : v ? "on" : "off");
const fromTri = (v: string) => (v === "default" ? undefined : v === "on");

/** One section of the open project's runbun.json, field by field. */
function ProjectPage(props: { section: Section; project: ProjectConfigState }) {
  const { text, parsed, c, files, folders, broken, set, guessed, guessShown, commandLine } = untrack(() => props.project);

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
            info={
              <>
                The file Run starts, as <code>bun &lt;entry&gt;</code>, relative to the project's root. Empty, it's guessed: package.json's{" "}
                <code>module</code> or <code>main</code>, a <code>bun &lt;file&gt;</code> dev or start script, a script that runs a package's bin (<code>vite</code>),
                else <code>index.ts</code>. Examples: <code>src/server.ts</code>, <code>index.html</code>
              </>
            }
          >
            <Input
              id="settings-entry"
              spellcheck={false}
              list="settings-entry-files"
              value={c().run?.entry ?? ""}
              placeholder={guessShown() ? `${guessed().entry} (guessed)` : "index.ts"}
              onChange={(e) => {
                const entry = e.currentTarget.value.trim().replace(/^\.?\//, "");
                set("run", entry ? { entry, ...(c().run?.args.length ? { args: c().run!.args } : {}) } : undefined);
              }}
            />
            <datalist id="settings-entry-files">
              <For each={files().filter((f) => /\.(m?[jt]sx?|html)$/.test(f))}>{(f) => <option value={f} />}</For>
            </datalist>
          </InfoField>
          <InfoField
            id="settings-args"
            label="Arguments"
            hint="space-separated"
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
        <Row label="Run once opened" hint="Code from a link still waits for the reader's Run.">
          <Switch label="Run once opened" checked={c().autorun !== false} onChange={(on) => set("autorun", on ? undefined : false)} />
        </Row>
        <Row label="Allow the fast path" hint="Off: always install and start the dev server, even with the reader's fast path on.">
          <Switch label="Allow the fast path" checked={c().fastPath !== false} onChange={(on) => set("fastPath", on ? undefined : false)} />
        </Row>
        <InfoField
          id="settings-env"
          label="Environment"
          hint="KEY=value per line"
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
        <div class="settings-stack">
          <Field label="Path" hint="where the preview opens">
            <Input spellcheck={false} value={c().preview?.path ?? ""} placeholder="/" onChange={(e) => set("preview", { ...c().preview, path: e.currentTarget.value.trim() || undefined })} />
          </Field>
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

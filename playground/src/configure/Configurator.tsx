import { For, Show, createEffect, createMemo, createSignal, createStore, type ParentProps } from "solid-js";
import { Select } from "@kobalte/core/select";
import { ToggleGroup } from "@kobalte/core/toggle-group";
import { BASE, DOCS } from "../base";
import { PRESETS } from "../embed/config";
import { FEATURES, MODES, type Feature, type Mode } from "../embed/protocol";
import { examples, repoExamples } from "../examples";
import { FAMILIES, pickFamily, setColorMode, setThemeVars } from "../theme";
import { guarded } from "../ui/guarded";
import { Swatch } from "../ui/Swatch";
import { TabItem, TabList } from "../ui/Tabs";
import { Tip } from "../ui/Tip";
import { attributes, elementSnippet, iframeSnippet, inlineFile, type Attr, type Form } from "./snippet";

// runbun.dev/configure: a form over every <bun-playground> option, a live embed with those options, and the snippet to
// paste. The page wears the embed's theme, family and vars, so the whole thing previews the look.

/** Where snippets load the playground from: this deploy. */
const PLAYGROUND = new URL(BASE, location.href).href;

const SAMPLE = `const greet = (name: string) => \`Hello, \${name}!\`;

console.log(greet("Bun"));
console.log(Bun.version);
`;

const MODE_INFO: Record<Mode, [icon: string, text: string]> = {
  code: ["i-lucide-code", "The editor and a console below it"],
  console: ["i-lucide-terminal", "The editor beside a console that takes commands"],
  preview: ["i-lucide-app-window", "The editor with tabs beside the preview of a server"],
  full: ["i-lucide-layout-dashboard", "The whole playground: file tree, tabs, preview, console. Waits for Run"],
  result: ["i-lucide-eye", "Only the preview, with an Edit button"],
};
const FEATURE_INFO: Record<Feature, string> = {
  files: "File tree",
  tabs: "Tab bar for open files",
  console: "Console output",
  preview: "Preview of a server",
  types: "Type errors, hover and completions (12 MB on first use)",
  format: "Format button, bun fmt (9 MB on first use)",
  install: "Install button",
  terminal: "Interactive terminal",
  open: "Open in runbun.dev",
  watch: "Restart the program when an edit is saved",
  autosave: "An Auto-save switch over the editor",
};

type Option = { value: string; label: string; swatch?: string };
const FAMILY_OPTIONS: Option[] = [
  { value: "default", label: "Default (Pierre)" },
  ...Object.values(FAMILIES).flatMap((list) => list.map(([name, light]) => ({ value: light, label: name, swatch: light }))),
];
const EXAMPLE_OPTIONS: Option[] = Object.entries(examples).map(([value, label]) => ({ value, label }));
const EXPAND_OPTIONS: Option[] = [
  { value: "none", label: "No button" },
  { value: "button", label: "Button, same mode" },
  ...MODES.map((m) => ({ value: m, label: `Button, opens as ${m}` })),
];
const AUTORUN_OPTIONS: Option[] = [
  { value: "default", label: "Mode default" },
  { value: "true", label: "Run once loaded" },
  { value: "false", label: "Wait for Run" },
];

function Field(props: ParentProps<{ label: string; hint?: string; wide?: boolean }>) {
  return (
    <label class={["field", { wide: props.wide }]}>
      <span class="field-label">
        {props.label}
        <Show when={props.hint}>
          <span class="field-hint">{props.hint}</span>
        </Show>
      </span>
      {props.children}
    </label>
  );
}

/** A Kobalte Select over a fixed list (changing a mounted Select's options warns; see ProjectPicker). */
function Choice(props: { label: string; value: string; options: Option[]; onChange: (v: string) => void }) {
  const selected = () => props.options.find((o) => o.value === props.value) ?? props.options[0];
  return (
    <Select<Option>
      options={props.options}
      optionValue="value"
      optionTextValue="label"
      value={selected()}
      onChange={(o) => o && props.onChange(o.value)}
      disallowEmptySelection
      gutter={4}
      itemComponent={(p) => (
        <Select.Item item={p.item} class="select-option">
          <Show when={p.item.rawValue.swatch}>{(s) => <Swatch light={s()} />}</Show>
          <Select.ItemLabel class="name">{p.item.rawValue.label}</Select.ItemLabel>
          <Select.ItemIndicator class="check">
            <i class="i-lucide-check" aria-hidden="true" />
          </Select.ItemIndicator>
        </Select.Item>
      )}
    >
      <Select.Trigger class="select-trigger" aria-label={props.label}>
        <Select.Value<Option> class="value">
          {(s) => (
            <>
              <Show when={s.selectedOption().swatch}>{(sw) => <Swatch light={sw()} />}</Show>
              <span class="name">{s.selectedOption().label}</span>
            </>
          )}
        </Select.Value>
        <Select.Icon class="chevron">
          <i class="i-lucide-chevron-down" aria-hidden="true" />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content class="select-menu">
          <Select.Listbox class="select-list" />
        </Select.Content>
      </Select.Portal>
    </Select>
  );
}

/** One of a few values, as a row of buttons (the theme picker's look). */
function Segmented(props: { label: string; value: string; options: [value: string, label: string, icon?: string, tip?: string][]; onChange: (v: string) => void }) {
  return (
    <ToggleGroup class="segmented" aria-label={props.label} value={props.value} onChange={(v) => v && props.onChange(v)}>
      <For each={props.options}>
        {([value, label, icon, tip]) => (
          <Tip as={ToggleGroup.Item} value={value} tip={tip}>
            <Show when={icon}>
              <i class={icon} aria-hidden="true" />
            </Show>
            {label}
          </Tip>
        )}
      </For>
    </ToggleGroup>
  );
}

const Text = (props: { value: string; placeholder?: string; onInput: (v: string) => void; label?: string }) => (
  <input class="dialog-input" value={props.value} placeholder={props.placeholder} aria-label={props.label} spellcheck={false} onInput={(e) => props.onInput(e.currentTarget.value)} />
);

/**
 * The live embed: a <bun-playground> kept in step with the form. Attribute changes go to the running element (it
 * updates in place or rebuilds its frame); a new file or source makes a new element, since the inline files are read
 * at start. Typing settles for a moment before it reaches the embed.
 */
function LiveEmbed(props: { form: Form; attrs: Attr[] }) {
  let host!: HTMLDivElement;
  let el: HTMLElement | null = null;
  let key = "";
  let applied = new Map<string, string>();
  const apply = (next: { key: string; attrs: Attr[]; file: ReturnType<typeof inlineFile> }) => {
    const attrs = new Map(next.attrs);
    if (!el || next.key !== key) {
      el = document.createElement("bun-playground");
      // The element loads the embed from where its script came from; here that's a bundle chunk, so point it here.
      el.setAttribute("src", PLAYGROUND);
      for (const [k, v] of attrs) el.setAttribute(k, v);
      if (next.file) {
        const s = document.createElement("script");
        s.type = "text/plain";
        s.dataset.file = next.file.path;
        s.textContent = next.file.text;
        el.append(s);
      }
      host.replaceChildren(el);
      key = next.key;
    } else {
      for (const k of applied.keys()) if (!attrs.has(k)) el.removeAttribute(k);
      for (const [k, v] of attrs) if (applied.get(k) !== v) el.setAttribute(k, v);
    }
    applied = attrs;
  };
  createEffect(
    () => {
      const file = inlineFile(props.form);
      const source = props.attrs.find(([k]) => k === "example" || k === "repo");
      return { key: JSON.stringify([props.form.source, file, source]), attrs: props.attrs, file };
    },
    (next) => {
      const t = setTimeout(guarded("configure", apply), el ? 400 : 0, next);
      return () => clearTimeout(t);
    },
  );
  return <div class="live" ref={host} />;
}

export function Configurator() {
  const [form, setForm] = createStore<Form>({
    source: "inline",
    filename: "index.ts",
    code: SAMPLE,
    example: "elysia-demo",
    repo: "oddcelot/bun-elysia-demo",
    mode: "code",
    features: [...PRESETS.code],
    height: "",
    expand: "none",
    status: "toast",
    load: "visible",
    autorun: "default",
    file: "",
    path: "",
    persist: "",
    title: "",
    readonly: false,
    theme: "auto",
    family: "default",
    accent: "",
    radius: "",
    fontUi: "",
    fontMono: "",
    fonts: "",
  });
  const set =
    <K extends keyof Form>(k: K) =>
    (v: Form[K]) =>
      setForm((s) => {
        s[k] = v;
      });
  const attrs = createMemo(() => attributes(form));
  const [tab, setTab] = createSignal<"element" | "iframe">("element");
  const snippet = createMemo(() => (tab() === "element" ? elementSnippet : iframeSnippet)(form, attrs(), PLAYGROUND));
  const [copied, setCopied] = createSignal(false);

  // The page takes the embed's look: its color mode, family and chrome variables.
  createEffect(
    () => ({ theme: form.theme, family: form.family, vars: attrs().find(([k]) => k === "vars")?.[1] }),
    guarded("configure theme", (look) => {
      setColorMode(look.theme === "auto" ? "system" : look.theme);
      pickFamily(look.family === "default" ? "pierre-light" : look.family);
      setThemeVars(look.vars ? JSON.parse(look.vars) : undefined);
    }),
  );

  const copy = async () => {
    await navigator.clipboard.writeText(snippet());
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <>
      <header class="cfg-header">
        <h1 class="title">
          <img src={`${BASE}favicon.svg`} alt="" width="20" height="20" />
          Embed configurator
        </h1>
        <a href={`${DOCS}guides/embedding/`} target="_top">
          Embedding guide
        </a>
        <a href={`${DOCS}reference/embed-api/`} target="_top">
          Reference
        </a>
      </header>
      <main class="cfg">
        <form class="cfg-form" onSubmit={(e) => e.preventDefault()}>
          <section>
            <h2>Source</h2>
            <Segmented
              label="Source"
              value={form.source}
              onChange={(v) => set("source")(v as Form["source"])}
              options={[
                ["inline", "Inline file", "i-lucide-file-code"],
                ["example", "Example", "i-lucide-package"],
                ["repo", "GitHub repo", "i-lucide-github"],
              ]}
            />
            <Show when={form.source === "inline"}>
              <Field label="File name">
                <Text value={form.filename} onInput={set("filename")} />
              </Field>
              <Field label="Code" wide>
                <textarea class="dialog-input code" rows={8} spellcheck={false} value={form.code} onInput={(e) => set("code")(e.currentTarget.value)} />
              </Field>
            </Show>
            <Show when={form.source === "example"}>
              <Field label="Example" wide>
                <Choice label="Example" value={form.example} options={EXAMPLE_OPTIONS} onChange={set("example")} />
              </Field>
            </Show>
            <Show when={form.source === "repo"}>
              <Field label="Repo" hint="owner/repo[@ref] or a GitHub URL" wide>
                <Text value={form.repo} onInput={set("repo")} />
              </Field>
              <div class="chips">
                <For each={Object.entries(repoExamples)}>
                  {([repo, label]) => (
                    <button type="button" class="chip" aria-pressed={form.repo === repo ? "true" : "false"} onClick={() => set("repo")(repo)}>
                      {label}
                    </button>
                  )}
                </For>
              </div>
            </Show>
          </section>

          <section>
            <h2>Layout</h2>
            <Segmented
              label="Mode"
              value={form.mode}
              onChange={(v) =>
                setForm((s) => {
                  // A new mode starts from its own features.
                  s.mode = v as Mode;
                  s.features.splice(0, s.features.length, ...PRESETS[v as Mode]);
                })
              }
              options={MODES.map((m) => [m, m, MODE_INFO[m][0], MODE_INFO[m][1]])}
            />
            <Field label="Features" hint="a mode's feature turned off is locked for readers" wide>
              <ToggleGroup class="chips" multiple aria-label="Features" value={form.features} onChange={(v) =>
                  setForm((s) => {
                    s.features.splice(0, s.features.length, ...(v as Feature[]));
                  })
                }>
                <For each={FEATURES}>
                  {(f) => (
                    <Tip as={ToggleGroup.Item} class="chip" value={f} tip={FEATURE_INFO[f]}>
                      <i class={form.features.includes(f) ? "i-lucide-check" : PRESETS[form.mode].includes(f) ? "i-lucide-lock" : "i-lucide-plus"} aria-hidden="true" />
                      {f}
                    </Tip>
                  )}
                </For>
              </ToggleGroup>
            </Field>
            <div class="row">
              <Field label="Height" hint={form.mode === "code" ? "auto" : undefined}>
                <Text value={form.height} placeholder="mode default" onInput={set("height")} />
              </Field>
              <Field label="Expand">
                <Choice label="Expand" value={form.expand} options={EXPAND_OPTIONS} onChange={set("expand")} />
              </Field>
            </div>
            <Field label="Run status" wide>
              <Segmented
                label="Run status"
                value={form.status}
                onChange={(v) => set("status")(v as Form["status"])}
                options={[
                  ["toast", "Toast", "i-lucide-message-square", "A toast over the panes that fades once it settles"],
                  ["bar", "Pill in the bar", "i-lucide-panel-bottom", "A pill in the embed's bar"],
                ]}
              />
            </Field>
          </section>

          <section>
            <h2>Behavior</h2>
            <Field label="Start" wide>
              <Segmented
                label="Start"
                value={form.load}
                onChange={(v) => set("load")(v as Form["load"])}
                options={[
                  ["visible", "When visible", "i-lucide-scan-eye", "When the embed scrolls into view"],
                  ["eager", "At once", "i-lucide-zap", "As soon as the page loads"],
                  ["click", "On click", "i-lucide-mouse-pointer-click", "When the reader clicks the poster's Run button"],
                ]}
              />
            </Field>
            <div class="row">
              <Field label="Autorun">
                <Choice label="Autorun" value={form.autorun} options={AUTORUN_OPTIONS} onChange={set("autorun")} />
              </Field>
              <Field label="Editing">
                <Segmented
                  label="Editing"
                  value={form.readonly ? "readonly" : "edit"}
                  onChange={(v) => set("readonly")(v === "readonly")}
                  options={[
                    ["edit", "Editable", "i-lucide-pencil"],
                    ["readonly", "Read-only", "i-lucide-lock"],
                  ]}
                />
              </Field>
              <Field label="Open file">
                <Text value={form.file} placeholder="the entry file" onInput={set("file")} />
              </Field>
              <Field label="Preview path">
                <Text value={form.path} placeholder="/" onInput={set("path")} />
              </Field>
              <Field label="Persist key" hint="keeps edits">
                <Text value={form.persist} placeholder="none" onInput={set("persist")} />
              </Field>
              <Field label="Title" hint="for screen readers">
                <Text value={form.title} placeholder="none" onInput={set("title")} />
              </Field>
            </div>
          </section>

          <section>
            <h2>Look</h2>
            <div class="row">
              <Field label="Color mode">
                <Segmented
                  label="Color mode"
                  value={form.theme}
                  onChange={(v) => set("theme")(v as Form["theme"])}
                  options={[
                    ["auto", "Auto", "i-lucide-monitor"],
                    ["light", "Light", "i-lucide-sun"],
                    ["dark", "Dark", "i-lucide-moon"],
                  ]}
                />
              </Field>
              <Field label="Theme family">
                <Choice label="Theme family" value={form.family} options={FAMILY_OPTIONS} onChange={set("family")} />
              </Field>
              <Field label="Accent">
                <span class="accent">
                  <input type="color" value={form.accent || "#009fff"} aria-label="Accent color" onInput={(e) => set("accent")(e.currentTarget.value)} />
                  <Text value={form.accent} placeholder="theme's" label="Accent value" onInput={set("accent")} />
                  <Show when={form.accent}>
                    <button type="button" class="clear" aria-label="Use the theme's accent" onClick={() => set("accent")("")}>
                      <i class="i-lucide-x" aria-hidden="true" />
                    </button>
                  </Show>
                </span>
              </Field>
              <Field label="Corner radius">
                <Text value={form.radius} placeholder="12px" onInput={set("radius")} />
              </Field>
              <Field label="UI font">
                <Text value={form.fontUi} placeholder="Inter, sans-serif" onInput={set("fontUi")} />
              </Field>
              <Field label="Code font">
                <Text value={form.fontMono} placeholder="JetBrains Mono, monospace" onInput={set("fontMono")} />
              </Field>
            </div>
            <Field label="Font stylesheets" hint="loaded inside the embed" wide>
              <Text value={form.fonts} placeholder="https://fonts.googleapis.com/css2?family=Inter&display=swap" onInput={set("fonts")} />
            </Field>
          </section>
        </form>

        <aside class="cfg-side">
          <LiveEmbed form={form} attrs={attrs()} />
          <div class="snippet">
            <div class="tabs-bar">
              <TabList class="tabs" label="Snippet" onSelect={(v) => setTab(v as "element" | "iframe")}>
                <TabItem value="element" selected={tab() === "element"} title="The <bun-playground> element">
                  <span class="name">Element</span>
                </TabItem>
                <TabItem value="iframe" selected={tab() === "iframe"} title="A bare iframe, no script">
                  <span class="name">iframe</span>
                </TabItem>
              </TabList>
              <button type="button" class="copy" onClick={() => void copy()}>
                <i class={copied() ? "i-lucide-check" : "i-lucide-copy"} aria-hidden="true" />
                {copied() ? "Copied" : "Copy"}
              </button>
            </div>
            <pre>
              <code>{snippet()}</code>
            </pre>
          </div>
        </aside>
      </main>
    </>
  );
}

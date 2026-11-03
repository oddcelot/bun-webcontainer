import { For, Show, createEffect, createMemo, createSignal, createStore, onSettled, untrack } from "solid-js";
import { BASE, DOCS } from "../base";
import { PRESETS } from "../embed/config";
import { FEATURES, MODES, type Feature, type Mode } from "@runbun/embed/protocol";
import { examples, repoExamples } from "../examples";
import { createPierre } from "../editors/pierre";
import { FAMILIES, isFamily, onTheme, pickFamily, setColorMode, themeName } from "../theme";
import { guarded } from "../ui/guarded";
import { Swatch } from "@runbun/ui/solid/Swatch";
import { Chip, Chips } from "@runbun/ui/solid/Chips";
import { Segmented } from "@runbun/ui/solid/Segmented";
import { TabItem, TabList } from "@runbun/ui/solid/Tabs";
import { Field } from "@runbun/ui/solid/Field";
import { Input } from "@runbun/ui/solid/Input";
import { Select } from "@runbun/ui/solid/Select";
import { highlightSnippet } from "./highlight";
import { attributes, elementSnippet, iframeSnippet, inlineFile, type Attr, type Form } from "./snippet";

// runbun.dev/configure: a form over every <bun-playground> option, a live embed with those options, and the snippet to
// paste. The form's Look settings go to the embed only; the page wears the docs' theme when they frame it.

/**
 * The page framing the configurator (the docs): its color scheme and theme family, which this page wears. They come
 * in the URL (`?theme=dark&family=…`) and later as messages (`{ bunConfigure: 1, theme, family }`), only from the docs.
 */
type Host = { theme?: "light" | "dark"; family?: string };
const DOCS_ORIGIN = new URL(DOCS).origin;
function hostLook(data: { theme?: unknown; family?: unknown }): Host {
  const theme = data.theme === "light" || data.theme === "dark" ? data.theme : undefined;
  const family = typeof data.family === "string" && isFamily(data.family) ? data.family : undefined;
  return { theme, family };
}
const params = new URLSearchParams(location.search);

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
  types: "Type errors, hover and completions (10 MB on first use)",
  format: "Format button, bun fmt (7 MB on first use)",
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

/** A Select over a fixed list. */
function Choice(props: { label: string; value: string; options: Option[]; onChange: (v: string) => void }) {
  const selected = () => props.options.find((o) => o.value === props.value) ?? props.options[0];
  return (
    <Select<Option>
      label={props.label}
      options={props.options}
      optionValue="value"
      optionTextValue="label"
      value={selected()}
      onChange={(o) => o && props.onChange(o.value)}
      required
      gutter={4}
      leading={(o) => <Show when={o.swatch}>{(s) => <Swatch light={s()} />}</Show>}
    />
  );
}

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

/**
 * The inline file in the playground's Pierre editor, highlighted by the file name's extension. A new name reopens it
 * with the text as it is; edits go to `onInput`.
 */
function CodeInput(props: { path: string; text: string; onInput: (text: string) => void }) {
  let el!: HTMLDivElement;
  let editor: ReturnType<typeof createPierre> | undefined;
  createEffect(
    () => ({ path: props.path || "index.ts", text: untrack(() => props.text) }),
    guarded("configure code", ({ path, text }) => {
      (editor ??= createPierre(el)).open(path, text, (next) => props.onInput(next));
    }),
  );
  onSettled(() => () => editor?.destroy());
  return <div class="code-editor" ref={el} />;
}

/**
 * The snippet, highlighted with @pierre/highlights in the page's theme: the HTML, and the inline file in its own
 * language (highlight.ts). The highlighted HTML lands after the themes load; until then the text shows plain.
 */
function SnippetView(props: { text: string }) {
  let el!: HTMLPreElement;
  const [theme, setTheme] = createSignal(themeName());
  onSettled(() => onTheme((name) => setTheme(name)));
  let seq = 0;
  createEffect(
    () => ({ text: props.text, theme: theme() }),
    guarded("configure snippet", ({ text, theme }) => {
      const n = ++seq;
      if (!el.innerHTML) el.textContent = text;
      void highlightSnippet(text, theme).then((r) => {
        if (n !== seq) return;
        el.innerHTML = r.html;
        el.style.background = r.bg;
        el.style.color = r.fg;
      });
    }),
  );
  return <pre class="snippet-code" ref={el} />;
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

  const [host, setHost] = createSignal<Host>(hostLook({ theme: params.get("theme"), family: params.get("family") }));
  onSettled(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin === DOCS_ORIGIN && e.data?.bunConfigure === 1) setHost(hostLook(e.data));
    };
    addEventListener("message", onMessage);
    return () => removeEventListener("message", onMessage);
  });

  // The page wears the framing page's look (the docs'), else its own default; the form's Look settings are the
  // embed's alone.
  createEffect(
    () => host(),
    guarded("configure theme", (look) => {
      setColorMode(look.theme ?? "system");
      pickFamily(look.family ?? "pierre-light");
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
                <Input value={form.filename} spellcheck={false} onInput={(e) => set("filename")(e.currentTarget.value)} />
              </Field>
              {/* Not a <label>: a click inside the editor mustn't go to a form control. */}
              <div class="field wide">
                <span class="field-label">Code</span>
                <CodeInput path={form.filename.trim()} text={form.code} onInput={set("code")} />
              </div>
            </Show>
            <Show when={form.source === "example"}>
              <Field label="Example" class="wide">
                <Choice label="Example" value={form.example} options={EXAMPLE_OPTIONS} onChange={set("example")} />
              </Field>
            </Show>
            <Show when={form.source === "repo"}>
              <Field label="Repo" hint="owner/repo[@ref] or a GitHub URL" class="wide">
                <Input value={form.repo} spellcheck={false} onInput={(e) => set("repo")(e.currentTarget.value)} />
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
            <Field label="Features" hint="a mode's feature turned off is locked for readers" class="wide">
              <Chips label="Features" value={form.features} onChange={(v) =>
                  setForm((s) => {
                    s.features.splice(0, s.features.length, ...(v as Feature[]));
                  })
                }>
                <For each={FEATURES}>
                  {(f) => (
                    <Chip value={f} tip={FEATURE_INFO[f]}>
                      <i class={form.features.includes(f) ? "i-lucide-check" : PRESETS[form.mode].includes(f) ? "i-lucide-lock" : "i-lucide-plus"} aria-hidden="true" />
                      {f}
                    </Chip>
                  )}
                </For>
              </Chips>
            </Field>
            <div class="row">
              <Field label="Height" hint={form.mode === "code" ? "auto" : undefined}>
                <Input value={form.height} placeholder="mode default" spellcheck={false} onInput={(e) => set("height")(e.currentTarget.value)} />
              </Field>
              <Field label="Expand">
                <Choice label="Expand" value={form.expand} options={EXPAND_OPTIONS} onChange={set("expand")} />
              </Field>
            </div>
            <Field label="Run status" class="wide">
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
            <Field label="Start" class="wide">
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
                <Input value={form.file} placeholder="the entry file" spellcheck={false} onInput={(e) => set("file")(e.currentTarget.value)} />
              </Field>
              <Field label="Preview path">
                <Input value={form.path} placeholder="/" spellcheck={false} onInput={(e) => set("path")(e.currentTarget.value)} />
              </Field>
              <Field label="Persist key" hint="keeps edits">
                <Input value={form.persist} placeholder="none" spellcheck={false} onInput={(e) => set("persist")(e.currentTarget.value)} />
              </Field>
              <Field label="Title" hint="for screen readers">
                <Input value={form.title} placeholder="none" spellcheck={false} onInput={(e) => set("title")(e.currentTarget.value)} />
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
                  <Input value={form.accent} placeholder="theme's" aria-label="Accent value" spellcheck={false} onInput={(e) => set("accent")(e.currentTarget.value)} />
                  <Show when={form.accent}>
                    <button type="button" class="clear" aria-label="Use the theme's accent" onClick={() => set("accent")("")}>
                      <i class="i-lucide-x" aria-hidden="true" />
                    </button>
                  </Show>
                </span>
              </Field>
              <Field label="Corner radius">
                <Input value={form.radius} placeholder="12px" spellcheck={false} onInput={(e) => set("radius")(e.currentTarget.value)} />
              </Field>
              <Field label="UI font">
                <Input value={form.fontUi} placeholder="Inter, sans-serif" spellcheck={false} onInput={(e) => set("fontUi")(e.currentTarget.value)} />
              </Field>
              <Field label="Code font">
                <Input value={form.fontMono} placeholder="JetBrains Mono, monospace" spellcheck={false} onInput={(e) => set("fontMono")(e.currentTarget.value)} />
              </Field>
            </div>
            <Field label="Font stylesheets" hint="loaded inside the embed" class="wide">
              <Input value={form.fonts} placeholder="https://fonts.googleapis.com/css2?family=Inter&display=swap" spellcheck={false} onInput={(e) => set("fonts")(e.currentTarget.value)} />
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
            <SnippetView text={snippet()} />
          </div>
        </aside>
      </main>
    </>
  );
}

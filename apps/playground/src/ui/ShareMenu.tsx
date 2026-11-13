import { Loading, Show, For, action, createMemo, createOptimistic, createSignal, resolve, useContext } from "solid-js";
import type { JSX } from "@solidjs/web";
import { LONG_LINK, MAX_SHORT, badgeUrl, formats, noteLines, shareLink, shortLink, type Link } from "../share";
import { exportZip, zipName } from "../archive";
import { AppContext } from "./context";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The Share menu (a popover under the Share button): copy the link, a Markdown badge for a README, or the same
 * badge as HTML. The link is built when the menu opens, so it carries the files as they are then.
 */
export function ShareMenu() {
  const app = useContext(AppContext);
  const [opened, setOpened] = createSignal(0);
  const link = createMemo(() => (opened() ? shareLink(app.vfs) : undefined));
  const size = (l: Link) => (l.short ? l.url.replace(/^https?:\/\//, "") : `${l.files} files · ${(l.url.length / 1024).toFixed(1)} KB`);

  /** Copies `kind` of the link and logs it with what the link leaves out. */
  async function copy(kind: keyof typeof formats) {
    const l = (await resolve(link))!;
    // The address bar shows the link too, so it can be copied from there or bookmarked.
    history.replaceState(null, "", l.url);
    const copied = await navigator.clipboard.writeText(formats[kind](l.url)).then(
      () => true,
      () => false,
    );
    const what = kind === "link" ? "link" : kind === "markdown" ? "Markdown badge" : "HTML badge";
    app.log("sys", copied ? `[share] ${what} copied: ${size(l)}` : "[share] couldn't copy. The link is in the address bar");
    for (const line of noteLines(l)) app.log(l.url.length > LONG_LINK && line.startsWith("Long") ? "warn" : "sys", `[share] ${line}`);
    return copied ? "Copied" : "Couldn't copy";
  }

  /**
   * Opt-in: stores the packed project on runbun.dev and copies the short link. The clipboard gets a promise of the
   * text, so the write still counts as part of the click while the request runs.
   */
  async function copyShort() {
    const url = resolve(link).then((l) => shortLink(l!));
    try {
      await navigator.clipboard.write([new ClipboardItem({ "text/plain": url.then((u) => new Blob([u], { type: "text/plain" })) })]);
      app.log("sys", `[share] short link copied: ${await url}`);
      return "Copied";
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      app.log("error", /fetch|JSON|answered 404/.test(why) ? "[share] short links only work on runbun.dev" : `[share] no short link: ${why}`);
      return "Couldn't shorten";
    }
  }

  /** Saves the project as a zip, a backup that browser storage limits can't clear. */
  async function download() {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(exportZip(app.vfs));
    a.download = zipName(app.vfs);
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    app.log("sys", `[share] downloaded ${a.download}`);
    return "Downloaded";
  }

  return (
    <div id="share-menu" popover onBeforeToggle={(e) => {
        if (e.newState !== "open") return;
        // The link carries the VFS, so unsaved edits go in first.
        app.workspace.saveAll();
        setOpened((n) => n + 1);
      }}>
      <Loading fallback={<p class="lead">…</p>}>
        <Show when={link()}>
          {(l) => (
            <>
              <p class="lead">
                <span data-share-lead>
                  {l().short
                    ? `Short link to ${l().short}. After an edit, the link includes your changes.`
                    : "The project is in the link. Nothing is uploaded unless you pick a short link."}
                </span>{" "}
                <span data-share-size>{size(l())}</span>
              </p>
              <ul class={["notes", { warn: l().url.length > LONG_LINK }]} hidden={!noteLines(l()).length}>
                <For each={noteLines(l())}>{(line) => <li>{line}</li>}</For>
              </ul>
              <ShareItem icon="i-lucide-link" title="Copy link" sub="Send it in a chat, open it anywhere" copy={() => copy("link")} />
              <ShareItem
                icon="i-lucide-link-2"
                title="Copy short link"
                sub={l().url.length > MAX_SHORT ? "Too large. Share from GitHub instead" : "Stores a copy on runbun.dev"}
                hidden={!!l().short}
                disabled={l().url.length > MAX_SHORT}
                working="Shortening…"
                copy={copyShort}
              />
              <ShareItem icon="i-lucide-file-text" title="Copy README badge" sub="Markdown, for GitHub" copy={() => copy("markdown")}>
                <img src={badgeUrl()} alt="Open in runbun" width="150" height="28" />
              </ShareItem>
              <ShareItem icon="i-lucide-code" title="Copy HTML badge" sub="For a website or blog post" copy={() => copy("html")} />
              <ShareItem icon="i-lucide-download" title="Download as zip" sub="A backup you can reopen from the project menu" copy={download} />
            </>
          )}
        </Show>
      </Loading>
    </div>
  );
}

/** A menu entry whose title says how the copy went for a moment, then goes back. */
function ShareItem(props: {
  icon: string;
  title: string;
  sub: string;
  hidden?: boolean;
  disabled?: boolean;
  /** The title while `copy` runs. */
  working?: string;
  /** Copies and returns the title to show for a moment ("Copied", "Couldn't copy"). */
  copy: () => Promise<string>;
  children?: JSX.Element;
}) {
  const [label, setLabel] = createOptimistic(() => props.title);
  const [copied, setCopied] = createOptimistic(false);
  // Optimistic writes revert when the action settles, which is after the pause.
  const copy = action(function* () {
    const done = props.copy();
    if (props.working) setLabel(props.working);
    const result: string = yield done;
    setLabel(result);
    setCopied(true);
    yield sleep(1400);
  });
  return (
    <button hidden={props.hidden} disabled={props.disabled} data-copied={copied() ? "" : undefined} onClick={() => copy()}>
      <i class={props.icon} aria-hidden="true" />
      <span>
        <span class="title">{label()}</span>
        <span class="sub">{props.sub}</span>
        {props.children}
      </span>
    </button>
  );
}

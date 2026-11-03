import { For, Show, createSignal, createUniqueId, useContext } from "solid-js";
import { Dialog, useDialogContext } from "@kobalte/core/dialog";
import { BASE, DOCS } from "../base";
import { MAX_SHORT, shareLink, shortLink } from "../share";
import { BUN_VERSION } from "../worker/bunVersion";
import { AppContext } from "./context";
import { Tip } from "./Tip";

/**
 * The status bar's Feedback button and its dialog: a message, an optional address to answer, and, if the sender
 * ticks them, the Bun release and browser (listed before sending) and a short link to the open project. Posts to
 * the Worker (worker/index.ts, POST /api/feedback); docs/privacy says what's kept.
 */
export function Feedback() {
  return (
    <Dialog>
      <Tip as={Dialog.Trigger} placement="top-end" tip="Tell us what works, what doesn't, what's missing">
        Feedback
      </Tip>
      <Dialog.Portal>
        <Dialog.Overlay class="dialog-overlay" />
        <div class="dialog-positioner">
          <Dialog.Content
            class="dialog feedback"
            onOpenAutoFocus={(e) => {
              e.preventDefault();
              (e.currentTarget as HTMLElement | null)?.querySelector("textarea")?.focus();
            }}
          >
            <FeedbackForm />
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog>
  );
}

/** What "include" sends: read when the dialog opens, shown as a list next to the checkbox. */
function environment(failing: string[]): Record<string, string> {
  return {
    bun: BUN_VERSION,
    browser: navigator.userAgent,
    window: `${innerWidth}×${innerHeight} @${devicePixelRatio}x`,
    ...(failing.length ? { unsupported: failing.join(", ") } : {}),
    ...(import.meta.env.CANARY ? { build: "canary" } : {}),
  };
}

// Inside Dialog.Content so each opening starts empty (the content unmounts on close).
function FeedbackForm() {
  const app = useContext(AppContext);
  const dialog = useDialogContext();
  const id = createUniqueId();
  const env = environment(app.support.filter((c) => !c.ok).map((c) => c.name));
  const [error, setError] = createSignal("");
  const [sending, setSending] = createSignal(false);
  let message!: HTMLTextAreaElement;
  let email!: HTMLInputElement;
  let withEnv!: HTMLInputElement;
  let withProject!: HTMLInputElement;

  /** The project as a short link (/s/<id>), or, while it's an unchanged example or repo, the query that opens it. */
  async function project(): Promise<{ project?: string; source?: string }> {
    app.workspace.saveAll();
    const l = await shareLink(app.vfs);
    if (l.short) return { source: new URL(l.url).search || "(the demo)" };
    if (l.url.length > MAX_SHORT) throw new Error("the project is too large to attach; describe it, or share it from GitHub");
    return { project: new URL(await shortLink(l)).pathname };
  }

  async function send(e: SubmitEvent) {
    e.preventDefault();
    if (sending()) return;
    const text = message.value.trim();
    if (!text) {
      setError("Write a few words first.");
      message.focus();
      return;
    }
    setError("");
    setSending(true);
    try {
      const attached = withProject.checked ? await project() : {};
      const body = {
        kind: "message",
        message: text,
        email: email.value.trim() || undefined,
        page: location.href.split("#")[0],
        env: withEnv.checked || attached.source ? { ...(withEnv.checked ? env : {}), ...(attached.source ? { project: attached.source } : {}) } : undefined,
        project: attached.project,
      };
      const res = await fetch(`${BASE}api/feedback`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const answer = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(answer.error ?? `the server answered ${res.status}`);
      app.log("sys", `[feedback] sent, thank you${attached.project ? ` (with the project: ${location.origin}${attached.project})` : ""}`);
      dialog.close();
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      setError(/fetch|JSON|answered 404/.test(why) ? "Feedback can't be sent from here (it goes to runbun.dev)." : `Not sent: ${why}`);
    } finally {
      setSending(false);
    }
  }

  return (
    <form onSubmit={send}>
      <Dialog.Title class="dialog-title">Send feedback</Dialog.Title>
      <Dialog.Description class="dialog-description">
        A bug, something that should run but doesn't, an idea. It goes to the people building this.{" "}
        <a href={`${DOCS}privacy/#feedback`} target="_blank" rel="noopener">
          What's kept
        </a>
      </Dialog.Description>
      <label class="dialog-label" for={`${id}-message`}>
        Message
      </label>
      <textarea
        ref={message}
        id={`${id}-message`}
        class="dialog-input feedback-message"
        maxlength={4000}
        aria-describedby={`${id}-error`}
        aria-invalid={error() ? "true" : undefined}
        onKeyDown={(e) => {
          // ⌘/Ctrl+Enter sends, as in chat apps; plain Enter is a new line.
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) e.currentTarget.form?.requestSubmit();
        }}
      />
      <label class="dialog-label" for={`${id}-email`}>
        Email, if you'd like an answer (optional)
      </label>
      <input ref={email} id={`${id}-email`} class="dialog-input" type="email" maxlength={200} autocomplete="email" spellcheck={false} />
      <label class="feedback-check">
        <input ref={withEnv} type="checkbox" checked />
        <span>Include the Bun release and browser</span>
      </label>
      {/* Outside the label, so opening the list doesn't tick the box. */}
      <details class="feedback-env">
        <summary>What's sent</summary>
        <dl>
          <For each={Object.entries(env)}>
            {([k, v]) => (
              <>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </>
            )}
          </For>
        </dl>
      </details>
      <label class="feedback-check">
        <input ref={withProject} type="checkbox" />
        <span>
          Attach this project
          <span class="sub">Stores a copy on runbun.dev as a short link, as Share does (no .env or key files)</span>
        </span>
      </label>
      <p class="dialog-error" id={`${id}-error`} role="alert">
        <Show when={error()}>{error()}</Show>
      </p>
      <div class="dialog-actions">
        <Dialog.CloseButton class="dialog-button" type="button">
          Cancel
        </Dialog.CloseButton>
        <button class="dialog-button primary" type="submit" disabled={sending()}>
          {sending() ? "Sending…" : "Send"}
        </button>
      </div>
    </form>
  );
}

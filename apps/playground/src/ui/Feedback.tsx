import { For, Show, createSignal, createUniqueId, onSettled, useContext } from "solid-js";
import { Dialog, DialogActions, DialogClose, DialogDescription, DialogTitle, DialogTrigger, useDialogContext } from "@runbun/ui/solid/Dialog";
import { Button } from "@runbun/ui/solid/Button";
import { Input } from "@runbun/ui/solid/Input";
import { BASE, DOCS } from "../base";
import { MAX_SHORT, shareLink, shortLink } from "../share";
import { BUN_VERSION } from "../worker/bunVersion";
import { AppContext } from "./context";
import { Tip } from "@runbun/ui/solid/Tip";

/**
 * The status bar's Feedback button and its dialog: a message, an optional address to answer, and, if the sender
 * ticks them, the Bun release and browser (listed before sending) and a short link to the open project. Posts to
 * the Worker (worker/index.ts, POST /api/feedback); docs/privacy says what's kept.
 */
export function Feedback() {
  return (
    <Dialog
      class="feedback"
      trigger={
        <Tip as={DialogTrigger} placement="top-end" tip="Tell us what works, what doesn't, what's missing">
          Feedback
        </Tip>
      }
      onOpenAutoFocus={(e) => {
        e.preventDefault();
        (e.currentTarget as HTMLElement | null)?.querySelector("textarea")?.focus();
      }}
    >
      <FeedbackForm />
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
  const [sent, setSent] = createSignal(false);
  let closing: ReturnType<typeof setTimeout> | undefined;
  onSettled(() => () => clearTimeout(closing));
  let message!: HTMLTextAreaElement;
  let email!: HTMLInputElement;
  let withEnv!: HTMLInputElement;
  let withProject!: HTMLInputElement;

  /** The project as a short link (/s/<id>), or, while it's an unchanged example or repo, the query that opens it. */
  async function project(): Promise<{ project?: string; source?: string }> {
    app.workspace.saveAll();
    const l = await shareLink(app.vfs);
    if (l.short) return { source: new URL(l.url).search || "(the demo)" };
    if (l.url.length > MAX_SHORT) throw new Error("the project is too large to attach. Share it from GitHub instead");
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
      // The thanks (and its heart) for a moment, then the dialog closes by itself.
      setSent(true);
      closing = setTimeout(() => dialog.close(), 2600);
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      setError(/fetch|JSON|answered 404/.test(why) ? "Feedback only works on runbun.dev." : `Not sent: ${why}`);
    } finally {
      setSending(false);
    }
  }

  return (
    <Show when={!sent()} fallback={<Thanks />}>
      <form onSubmit={send}>
        <DialogTitle>Send feedback</DialogTitle>
        <DialogDescription>
          Tell us about a bug, something that should run but doesn't, or an idea.{" "}
          <a href={`${DOCS}privacy/#feedback`} target="_blank" rel="noopener">
            What's kept
          </a>
        </DialogDescription>
        <label class="dialog-label" for={`${id}-message`}>
          Message
        </label>
        <Input
          multiline
          ref={message}
          id={`${id}-message`}
          class="feedback-message"
          maxlength={4000}
          aria-describedby={`${id}-error`}
          aria-invalid={error() ? "true" : undefined}
          onKeyDown={(e) => {
            // ⌘/Ctrl+Enter sends, as in chat apps; plain Enter is a new line.
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) e.currentTarget.form?.requestSubmit();
          }}
        />
        <label class="dialog-label" for={`${id}-email`}>
          Email (optional)
        </label>
        <Input ref={email} id={`${id}-email`} type="email" maxlength={200} autocomplete="email" spellcheck={false} />
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
            <span class="sub">Saves a copy as a short link, like Share. Skips .env and key files.</span>
          </span>
        </label>
        <p class="dialog-error" id={`${id}-error`} role="alert">
          <Show when={error()}>{error()}</Show>
        </p>
        <DialogActions>
          <DialogClose>Cancel</DialogClose>
          <Button primary type="submit" disabled={sending()}>
            {sending() ? "Sending…" : "Send"}
          </Button>
        </DialogActions>
      </form>
    </Show>
  );
}

/** After sending: a neon heart that draws itself in one pen stroke, then flickers on. */
function Thanks() {
  return (
    <div class="feedback-thanks">
      <NeonHeart />
      <DialogTitle>Thank you!</DialogTitle>
      <DialogDescription>Your feedback is on its way.</DialogDescription>
      <DialogClose>Close</DialogClose>
    </div>
  );
}

// Same drawing as the docs' (apps/docs/src/components/Footer.astro): one stroke, a swoosh in, a loop for the heart
// and a swoosh out; pathLength="1" lets a dash animation draw it from end to end.
function NeonHeart() {
  return (
    <svg class="neon-heart" viewBox="0 0 100 44" width="150" height="66" aria-hidden="true">
      <path pathLength="1" d="M4 25C18 33 36 38 50 35 58 33 62 24 61 18 60 12 54 10 50 16 46 10 39 12 39 18 39 25 45 31 51 38 60 46 82 40 96 31" />
    </svg>
  );
}

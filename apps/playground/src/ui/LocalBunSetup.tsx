import { Show, createSignal, createUniqueId } from "solid-js";
import { DOCS } from "../base";
import { Button } from "@runbun/ui/solid/Button";
import { Dialog, DialogActions, DialogClose, DialogDescription, DialogTitle } from "@runbun/ui/solid/Dialog";
import { Input } from "@runbun/ui/solid/Input";

const COMMAND = "bunx @runbun/connect --open";

/** The runner's WebSocket URL from what the runner printed: its runbun.dev link, or the ws:// URL itself. */
export function connectUrl(text: string): string | undefined {
  let ws = text.trim();
  try {
    ws = new URL(ws).searchParams.get("connect") ?? ws;
  } catch {}
  try {
    const u = new URL(ws);
    return u.protocol === "ws:" && /^(127\.0\.0\.1|localhost|\[::1\])$/.test(u.hostname) && u.searchParams.has("token") ? ws : undefined;
  } catch {}
}

/**
 * How to run projects with the Bun on this machine, for the Local Bun button when no runner is connected: start
 * `@runbun/connect`, then either use the playground it opens or paste its link to connect this page. `lost`: there was
 * one, and it stopped.
 */
export function LocalBunSetup(props: { open: boolean; onOpenChange: (open: boolean) => void; lost: boolean; browserOk: boolean }) {
  const id = createUniqueId();
  const [copied, setCopied] = createSignal(false);
  const [bad, setBad] = createSignal(false);
  let input!: HTMLInputElement;
  const connect = (e: SubmitEvent) => {
    e.preventDefault();
    const ws = connectUrl(input.value);
    if (!ws) return setBad(true);
    const url = new URL(location.href);
    url.hash = "";
    url.searchParams.set("connect", ws);
    location.assign(url);
  };
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange} class="local-bun-setup">
      <DialogTitle>{props.lost ? "Start Local Bun again" : "Run with Bun on this machine"}</DialogTitle>
      <DialogDescription>
        {props.lost
          ? "The runner on this machine stopped. Start it again; its link changes each time, so open the new one."
          : "The playground runs Bun in your browser. With Local Bun, Run, bun install and bun test use the Bun installed on your computer instead, in a sandbox: child processes, bun:ffi and real sockets work."}
      </DialogDescription>
      <ol>
        <li>
          Install <a href="https://bun.sh" target="_blank" rel="noopener">Bun</a> 1.3 or later. On Linux, also bubblewrap (
          <code>apt install bubblewrap</code>).
        </li>
        <li>
          In a terminal, run
          <span class="command">
            <code>{COMMAND}</code>
            <Button
              aria-label="Copy the command"
              onClick={() => void navigator.clipboard.writeText(COMMAND).then(() => (setCopied(true), setTimeout(() => setCopied(false), 1500)))}
            >
              <i class={copied() ? "i-lucide-check" : "i-lucide-copy"} aria-hidden="true" />
            </Button>
          </span>
          It opens the playground with Local Bun on, in any browser.
        </li>
      </ol>
      <Show when={props.browserOk}>
        <form onSubmit={connect}>
          <label for={id}>Or stay on this page: start it without --open and paste the link it prints (Chrome, Firefox).</label>
          <span class="paste">
            <Input ref={input} id={id} placeholder="https://runbun.dev/?connect=ws%3A%2F%2F127.0.0.1…" spellcheck={false} autocomplete="off" onInput={() => setBad(false)} />
            <Button type="submit">Connect</Button>
          </span>
          <Show when={bad()}>
            <p class="error" role="alert">
              That isn't a link from the runner: it prints one with ?connect=ws://127.0.0.1…
            </p>
          </Show>
        </form>
      </Show>
      <p class="note">
        While the runner is on, open only projects you trust: their code can reach it and run on your computer.{" "}
        <a href={`${DOCS}guides/local-bun/`} target="_blank" rel="noopener">
          How it works
        </a>
      </p>
      <DialogActions>
        <DialogClose>Close</DialogClose>
      </DialogActions>
    </Dialog>
  );
}

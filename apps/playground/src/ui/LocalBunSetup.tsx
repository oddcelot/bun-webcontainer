import { Match, Show, Switch, createSignal, createUniqueId } from "solid-js";
import { DOCS } from "../base";
import { Button } from "@runbun/ui/solid/Button";
import { Dialog, DialogActions, DialogClose, DialogDescription, DialogTitle } from "@runbun/ui/solid/Dialog";
import { Input } from "@runbun/ui/solid/Input";
import { Segmented } from "@runbun/ui/solid/Segmented";

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

const INSTALL_BUN = "curl -fsSL https://bun.sh/install | bash";

type Os = "mac" | "linux" | "windows" | "mobile";

/** Which steps to show first; the dialog's switch covers a wrong guess (a VM, setting up another machine). */
function detectOs(): Os {
  const ua = navigator.userAgent;
  const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform ?? "";
  // iPadOS reports a Mac; touch gives it away.
  if (/iPhone|iPad|iPod|Android/i.test(ua) || (/Mac/i.test(platform) && navigator.maxTouchPoints > 1)) return "mobile";
  if (/Win/i.test(platform) || /Windows/.test(ua)) return "windows";
  if (/Mac/i.test(platform) || /Mac OS X/.test(ua)) return "mac";
  return "linux";
}

/** A command to type, with a button that copies it. */
function Command(props: { text: string }) {
  const [copied, setCopied] = createSignal(false);
  return (
    <span class="command">
      <code>{props.text}</code>
      <Button aria-label="Copy the command" onClick={() => void navigator.clipboard.writeText(props.text).then(() => (setCopied(true), setTimeout(() => setCopied(false), 1500)))}>
        <i class={copied() ? "i-lucide-check" : "i-lucide-copy"} aria-hidden="true" />
      </Button>
    </span>
  );
}

/**
 * How to run projects with the Bun on this machine, for the Local Bun button when no runner is connected: start
 * `@runbun/connect`, then either use the playground it opens or paste its link to connect this page. `lost`: there was
 * one, and it stopped.
 */
export function LocalBunSetup(props: { open: boolean; onOpenChange: (open: boolean) => void; lost: boolean; browserOk: boolean }) {
  const id = createUniqueId();
  const detected = detectOs();
  const [os, setOs] = createSignal<Os>(detected === "mobile" ? "mac" : detected);
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
      <Show when={detected === "mobile"}>
        <p class="note">
          Local Bun runs on a computer: it needs Bun and a terminal. Open the playground on your Mac or Linux PC to use it; the
          steps are below.
        </p>
      </Show>
      <Segmented
        label="Steps for"
        value={os()}
        options={[
          ["mac", "macOS"],
          ["linux", "Linux"],
          ["windows", "Windows"],
        ]}
        onChange={(v) => setOs(v as Os)}
      />
      <Switch>
        <Match when={os() === "mac"}>
          <ol>
            <li>
              Install <a href="https://bun.sh" target="_blank" rel="noopener">Bun</a> 1.3 or later, if you haven't:
              <Command text={INSTALL_BUN} />
              The sandbox (sandbox-exec) comes with macOS.
            </li>
            <li>
              Start the runner:
              <Command text={COMMAND} />
              It opens the playground with Local Bun on, in any browser, Safari included.
            </li>
          </ol>
        </Match>
        <Match when={os() === "linux"}>
          <ol>
            <li>
              Install <a href="https://bun.sh" target="_blank" rel="noopener">Bun</a> 1.3 or later, if you haven't:
              <Command text={INSTALL_BUN} />
            </li>
            <li>
              Install bubblewrap, the sandbox runs go in (Fedora: <code>dnf</code>, Arch: <code>pacman -S</code>):
              <Command text="sudo apt install bubblewrap" />
            </li>
            <li>
              Start the runner:
              <Command text={COMMAND} />
              It opens the playground with Local Bun on.
            </li>
          </ol>
        </Match>
        <Match when={os() === "windows"}>
          <p>
            Not on Windows itself yet: there's no sandbox for it, so the runner doesn't start there. Under WSL 2 it may work as on
            Linux (untested): in the WSL terminal, install Bun and bubblewrap, then run
          </p>
          <Command text={COMMAND.replace(" --open", "")} />
          <p>and open the link it prints.</p>
        </Match>
      </Switch>
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
        Before a page runs anything, the runner asks in its terminal: say no if you didn't just press Run.{" "}
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

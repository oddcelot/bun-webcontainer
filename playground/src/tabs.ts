/**
 * Open files as tabs above the editor. `onActivate` gets the file to show (null: none left), `onChange`
 * the set of open files. Middle-click or the × closes a tab; closing the active one activates a neighbor.
 */
export function mountTabs(
  bar: HTMLElement,
  { onActivate, onChange }: { onActivate: (path: string | null) => void; onChange: (open: ReadonlySet<string>) => void },
) {
  const open: string[] = [];
  let active: string | null = null;

  const name = (path: string) => path.slice(path.lastIndexOf("/") + 1);

  function render() {
    // Same file name in two folders: show the folder too.
    const counts = new Map<string, number>();
    for (const p of open) counts.set(name(p), (counts.get(name(p)) ?? 0) + 1);
    bar.replaceChildren(
      ...open.map((path) => {
        const tab = document.createElement("div");
        tab.className = "tab";
        tab.role = "tab";
        tab.title = path;
        tab.tabIndex = path === active ? 0 : -1;
        tab.setAttribute("aria-selected", String(path === active));
        const label = Object.assign(document.createElement("span"), { className: "name", textContent: name(path) });
        tab.append(label);
        if (counts.get(name(path))! > 1 && path.includes("/"))
          tab.append(Object.assign(document.createElement("span"), { className: "dir", textContent: path.slice(0, path.lastIndexOf("/")) }));
        const close = document.createElement("button");
        close.className = "close";
        close.title = close.ariaLabel = `Close ${name(path)}`;
        close.tabIndex = -1;
        close.innerHTML = `<i class="i-lucide-x" aria-hidden="true"></i>`;
        close.onclick = (e) => {
          e.stopPropagation();
          api.close(path);
        };
        tab.append(close);
        tab.onclick = () => activate(path);
        tab.onauxclick = (e) => e.button === 1 && api.close(path);
        tab.onkeydown = (e) => {
          if (e.key === "Delete" || (e.key === "w" && (e.ctrlKey || e.metaKey))) return e.preventDefault(), api.close(path);
          if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
          const next = open[open.indexOf(path) + (e.key === "ArrowLeft" ? -1 : 1)];
          if (next) activate(next), (bar.querySelector('[aria-selected="true"]') as HTMLElement | null)?.focus();
        };
        return tab;
      }),
    );
    bar.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  function activate(path: string | null) {
    if (path === active) return;
    active = path;
    render();
    onActivate(path);
  }

  const api = {
    get active() {
      return active;
    },
    /** Opens `path` in a tab (after the active one) or switches to its tab. */
    open(path: string) {
      if (!open.includes(path)) {
        open.splice(active ? open.indexOf(active) + 1 : open.length, 0, path);
        onChange(new Set(open));
      }
      if (path === active) render();
      else activate(path);
    },
    close(path: string) {
      const i = open.indexOf(path);
      if (i < 0) return;
      open.splice(i, 1);
      onChange(new Set(open));
      if (path !== active) return render();
      active = open[i] ?? open[i - 1] ?? null;
      render();
      onActivate(active);
    },
    closeAll() {
      open.length = 0;
      onChange(new Set());
      active = null;
      render();
      onActivate(null);
    },
  };
  return api;
}

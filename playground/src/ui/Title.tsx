// A different name on every visit. Switching projects reloads the page too, so the name lives in the tab's
// session storage and is only picked again on a real reload (or in a new tab).
const titles = [
  "Bun Away",
  "Always Bunning",
  "Bun and Done",
  "Hot Cross Bun",
  "Bun in the Oven",
  "Bun Shot",
  "Bundle of Joy",
  "Bun Voyage",
  "On the Bun",
];
const KEY = "title";

function pickTitle(): string {
  const reload = (performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined)?.type === "reload";
  const kept = sessionStorage.getItem(KEY);
  if (kept && !reload && titles.includes(kept)) return kept;
  // A reload always shows a different name than before.
  const pool = titles.filter((t) => t !== kept);
  const title = pool[Math.floor(Math.random() * pool.length)];
  sessionStorage.setItem(KEY, title);
  return title;
}

export function Title() {
  const title = pickTitle();
  // The tab keeps the site name, so bookmarks and search results stay recognizable.
  document.title = `${title} · runbun.dev`;
  return <>{title}</>;
}

// A different name on every visit.
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

export function Title() {
  const title = titles[Math.floor(Math.random() * titles.length)];
  // The tab keeps the site name, so bookmarks and search results stay recognizable.
  document.title = `${title} · runbun.dev`;
  return <>{title}</>;
}

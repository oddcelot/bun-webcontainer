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

const title = titles[Math.floor(Math.random() * titles.length)];
document.getElementById("title")!.textContent = title;
// The tab keeps the site name, so bookmarks and search results stay recognizable.
document.title = `${title} · runbun.dev`;

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

document.title = document.getElementById("title")!.textContent = titles[Math.floor(Math.random() * titles.length)];

/** The random name index.html picked for this visit (see the script in its <head>). */
export function Title() {
  let title = "Bun playground";
  try {
    title = sessionStorage.getItem("title") || title;
  } catch {}
  return <>{title}</>;
}

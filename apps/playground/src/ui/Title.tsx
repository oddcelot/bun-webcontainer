import { HOSTING } from "../hosting";

/** The random name index.html picked for this visit (see the script in its <head>), or a branded host's own name. */
export function Title() {
  if (HOSTING.brand) return <>{HOSTING.name}</>;
  let title = "Bun playground";
  try {
    title = sessionStorage.getItem("title") || title;
  } catch {}
  return <>{title}</>;
}

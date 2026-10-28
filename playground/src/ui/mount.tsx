import { render, type JSX } from "@solidjs/web";
import { Title } from "./Title";

// render() appends; index.html keeps static fallback text for crawlers and no-JS visitors.
function mount(id: string, view: () => JSX.Element) {
  const root = document.getElementById(id)!;
  root.replaceChildren();
  render(view, root);
}

mount("title", () => <Title />);

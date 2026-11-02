import "virtual:uno.css";
import "./configure.css";
import { render } from "@solidjs/web";
import { BASE } from "../base";
import { showCanaryBadge } from "../canary";
import { Configurator } from "./Configurator";

showCanaryBadge();

// The <bun-playground> element, from the same embed.js other sites load (in dev vite.config.ts serves it from
// embed-element/). Not a static import: bundled into this page as well, its code would move to a shared chunk, and
// embed.js would only import that chunk from assets/, which other origins can't load and where the element would
// resolve its iframe as assets/embed.
void import(/* @vite-ignore */ `${location.origin}${BASE}embed.js`);

render(() => <Configurator />, document.body);

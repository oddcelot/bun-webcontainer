// The element runbun.dev serves as /embed.js (packages/embed): it frames the playground it is served from, so a
// deploy at another origin or base path (and the dev server) embeds itself. Not `new URL("./", import.meta.url)`:
// Vite would take that for an asset reference.
import { define } from "@runbun/embed/element";

define({ src: import.meta.url.replace(/[^/]*$/, "") });

// The blocks' stylesheet, a file of its own so the browser caches it and only pages with a block load it.
import { css } from "virtual:@runbun/astro/config";

export const prerender = true;
export const GET = () => new Response(css, { headers: { "Content-Type": "text/css; charset=utf-8" } });

// The colors of <Code> blocks (src/highlight.mjs) in every family's code theme. A file of its own, so the browser
// caches it and only pages with a block load it.
import type { APIRoute } from "astro";
import { themeCss } from "../highlight.mjs";

export const GET: APIRoute = () => new Response(themeCss(), { headers: { "Content-Type": "text/css; charset=utf-8" } });

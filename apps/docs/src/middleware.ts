import { defineMiddleware } from "astro:middleware";
import { PLAYGROUND_URL, toPlayground } from "../site-urls.ts";

/** Pages (Markdown and frontmatter alike) link https://runbun.dev; point those links at this environment's playground. */
export const onRequest = defineMiddleware(async (_context, next) => {
  const response = await next();
  if (PLAYGROUND_URL === "https://runbun.dev/" || !response.headers.get("content-type")?.startsWith("text/html")) return response;
  return new Response(toPlayground(await response.text(), PLAYGROUND_URL), response);
});

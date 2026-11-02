import type { Root } from "mdast";

/** ```ts playground fences as embeds. Options default to the runbun() integration's. */
export default function remarkRunbun(options?: {
  playgroundUrl?: string;
  base?: string;
  sync?: { scheme?: string; family?: string };
}): (tree: Root, file?: { path?: string }) => void;

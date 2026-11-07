/**
 * The origin that runs project code (the runtime Worker and the previews), or undefined to run it on the editor's own
 * origin. Dev: the editor at http://localhost:5173 and `VITE_CONTENT_ORIGIN=http://127.0.0.1:5173`, the same server
 * under the other hostname (a different origin and site). Spike, see bead bwc-2kk.11.
 */
const raw = import.meta.env.VITE_CONTENT_ORIGIN as string | undefined;
export const CONTENT_ORIGIN: string | undefined = raw ? new URL(raw).origin : undefined;

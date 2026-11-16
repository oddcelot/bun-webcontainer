/**
 * `XMLHttpRequest`, kept for the playground's own synchronous requests (the transpiler's module, source maps, the
 * page's module claims). A worker has the global, Bun doesn't, and libraries branch on it: axios picks its xhr adapter,
 * the browser's network instead of `node:http`. `hideXhr` removes the global from the worker running user code, once
 * every module that needs the class has been evaluated (they capture it here when imported).
 */
export const XHR: typeof XMLHttpRequest = globalThis.XMLHttpRequest;

export function hideXhr(): void {
  if (typeof document === "undefined") delete (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest;
}

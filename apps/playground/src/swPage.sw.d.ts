// What sw.ts sees of swPage.ts (tsconfig.sw.json maps "#sw-page" here; vite.config.ts maps it to swPage.ts).
// swPage.ts needs the DOM lib and sw.ts the worker lib, so each is checked in its own project.
export function previewColorScheme(): void;
export function previewWebSocket(prefix: string): void;
export function previewBridge(base: string, editor: string, v: number): void;

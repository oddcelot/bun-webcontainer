// The Launch Handler API (Chromium; not in TypeScript's DOM lib yet): how the installed app learns what it was
// launched with, here the files of the manifest's `file_handlers` (main.ts).
interface LaunchParams {
  readonly targetURL?: string;
  readonly files: readonly FileSystemHandle[];
}

interface LaunchQueue {
  setConsumer(consumer: (params: LaunchParams) => unknown): void;
}

interface Window {
  readonly launchQueue: LaunchQueue;
}

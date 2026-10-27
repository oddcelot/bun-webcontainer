export type FetchHandler = (req: Request, server: unknown) => Response | Promise<Response>;

/** The worker's one preview request handler: `Bun.serve` and `http.Server#listen` both register through the runtime's hook. */
export const hooks: { set: (h: FetchHandler | undefined) => void; get: () => FetchHandler | undefined } = { set() {}, get: () => undefined };

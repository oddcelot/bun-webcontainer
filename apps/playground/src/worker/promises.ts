// A promise's state isn't readable from JS without waiting. The formatters (`console.log`, `util.inspect`) show
// the states recorded here and `<pending>` for the rest.

type Settled = { state: "resolved" | "rejected"; value: unknown };
const settled = new WeakMap<Promise<unknown>, Settled>();

/** Records how `p` settled, for promises the runtime watches anyway. */
export function trackPromise(p: Promise<unknown>, state: Settled["state"], value?: unknown) {
  settled.set(p, { state, value });
}

export const settledPromise = (p: Promise<unknown>): Settled | undefined => settled.get(p);

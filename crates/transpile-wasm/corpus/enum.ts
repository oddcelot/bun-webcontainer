enum Color { Red, Green = "g", Blue = 4 }
export const enum Flags { A = 1 << 0, B = 1 << 1 }
namespace NS { export const x = 1; }
export function id<T extends object>(v: T): T { return v; }
class Root {}
abstract class Base<T> extends Root { constructor(private readonly t: T, public n?: number) { super(); } abstract go(): void }
let y = <const>["a"]; let z = y as unknown as string satisfies string;
export { Color, NS, Base };

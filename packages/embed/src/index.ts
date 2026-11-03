// @runbun/embed: importing it registers <bun-playground> and <bun-playground-defaults>, framing https://runbun.dev/.
// `@runbun/embed/element` exports the same without registering, for `define({ src })` with another playground.
import { define } from "./element.js";

define();

export * from "./element.js";
export type * from "./protocol.js";

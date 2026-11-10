// `false`: bun/src/runtime/shell/builtin/false_.rs
import type { Command } from "../interp";

export const false_: Command = async () => 1;

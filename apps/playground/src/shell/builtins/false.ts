// `false`: bun/src/runtime/shell/builtin/false_.rs
import type { Command } from "../interp";
import { notYet } from "./util";

export const false_: Command = notYet("false");

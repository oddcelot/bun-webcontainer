// Bun's shell builtins (bun/src/runtime/shell/builtin/), one file each, over the shell's files (interp.ts ShellFs).
import type { Command } from "../interp";
import { echo } from "./echo";
import { cd } from "./cd";
import { pwd } from "./pwd";
import { exit } from "./exit";
import { true_ } from "./true";
import { false_ } from "./false";
import { yes } from "./yes";
import { seq } from "./seq";
import { dirname } from "./dirname";
import { basename } from "./basename";
import { which } from "./which";
import { export_ } from "./export";
import { cat } from "./cat";
import { touch } from "./touch";
import { mkdir } from "./mkdir";
import { ls } from "./ls";
import { rm } from "./rm";
import { mv } from "./mv";
import { cp } from "./cp";

export const builtins: Record<string, Command> = {
  echo,
  cd,
  pwd,
  exit,
  "true": true_,
  "false": false_,
  yes,
  seq,
  dirname,
  basename,
  which,
  "export": export_,
  cat,
  touch,
  mkdir,
  ls,
  rm,
  mv,
  cp,
};

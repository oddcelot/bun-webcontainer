import type { FileContents, VFS } from "@runbun/vfs";
import type { EditorDiagnostic } from "../editors/types";
import type { FmtResult } from "../fmt";

// A language pack: support for a language the TypeScript service sees through a TSX projection (the pack's compiler
// turns a module into TSX and says which spans of the two texts are the same). A pack is a lazily loaded chunk; what
// the core may know about it without loading it is its LanguageMeta (./index.ts).

type Position = { line: number; character: number };

/** One module and its projection: positions from one to the other. */
export interface LanguageView {
  /** The projection's position (0-based) for a 1-based line and column of the module; null where the module's text isn't in it as written. */
  toProjection(line: number, column: number): Position | null;
  /** Where a range of the projection is in the module (1-based); null for text the compiler added. */
  toModule(range: { start: Position; end: Position }): { line: number; column: number; length: number } | null;
  /** The compiler's own errors, which need no types. */
  diagnostics(): EditorDiagnostic[];
  /** Whether the type checker's error `code` is one the projection causes, not the module. */
  ignores(code: unknown): boolean;
}

/** `bun fmt` as a pack's formatter calls it (src/fmt.ts): the project's configs apply, `flags` go on its command line. */
export type Fmt = (vfs: VFS, path: string, text: string, flags?: string[]) => Promise<FmtResult>;

/** `same`: already formatted. `rejected`: the result couldn't be shown to be the same program, the module stays as it is. `skip`: it doesn't parse. */
export type FormatResult = { status: "ok" | "same"; out: string } | { status: "rejected"; reason: string; detail: string } | { status: "skip"; detail: string };

export interface LanguagePack {
  /** What the type checker reads a module as: `<path>` + this, always ".tsx" for now. */
  projectionSuffix: ".tsx";
  /**
   * Adds the project's modules to `files` (what the type checker gets) as `<path>` + `projectionSuffix`, with the
   * declarations their projections import. `text` is `path`'s contents, unsaved edits included.
   */
  project(vfs: VFS, files: Map<string, FileContents>, path: string, text: string): Promise<void>;
  /** The projection the pack has for the module at VFS `path`, once `project` has made it. */
  view(path: string): LanguageView | undefined;
  /** A module formatted, `fmt` being `bun fmt`; without it, the module is formatted as any other file. */
  format?(vfs: VFS, path: string, text: string, fmt: Fmt): Promise<FormatResult>;
  /** Whether saving formats the module (when the host formats on save at all). */
  formatOnSave: boolean;
}

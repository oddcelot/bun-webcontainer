import type { FileContents, VFS } from "@runbun/vfs";
import { HOSTING } from "../hosting";
import type { LanguageId } from "../../hosting/load";
import type { LanguagePack, LanguageView } from "./types";

// The library of language packs that ship with runbun. A host picks the ones it enables (hosting file's `languages`,
// null: all). Only cheap metadata is here: a pack's code (its compiler included) is a chunk, loaded when a project
// has a file the pack reads, so a host or project without such files never fetches it.

/** What the core knows about a pack without loading it. */
export interface LanguageMeta {
  /** The language's name, as the status bar shows it. */
  name: string;
  /** The modules the pack types, formats and marks (not, say, declaration files). */
  match: RegExp;
  /** Every file the pack reads, modules or not: when the project has none, the pack isn't loaded. */
  inputs: RegExp;
  /** The language the editor highlights the files as, where the highlighter has no lexer of its own. */
  highlightAs: "tsx";
  /** The file extension (no dot) the status bar names the language by. */
  ext: string;
  load: () => Promise<LanguagePack>;
}
export type Language = LanguageMeta & { id: LanguageId };

const library: Record<LanguageId, LanguageMeta> = {
  reactivescript: {
    name: "ReactiveScript",
    match: /(?<!\.d)\.rx$/,
    inputs: /\.rx$/,
    highlightAs: "tsx",
    ext: "rx",
    load: () => import("./reactivescript").then((m) => m.reactivescript),
  },
};

/** The packs this host enables, in the library's order. */
export const enabledLanguages: Language[] = (Object.keys(library) as LanguageId[])
  .filter((id) => !HOSTING.languages || HOSTING.languages.includes(id))
  .map((id) => ({ id, ...library[id] }));

/** The enabled pack's metadata for a module at `path`, if there is one. A file of a pack the host leaves out is a plain file. */
export const languageFor = (path: string): Language | undefined => enabledLanguages.find((l) => l.match.test(path));

/** The enabled pack for a file extension (lower case, no dot), for names and highlighting that go by it alone. */
export const languageByExt = (ext: string): Language | undefined => enabledLanguages.find((l) => l.ext === ext);

const loaded = new Map<LanguageId, Promise<LanguagePack>>();
const ready = new Map<LanguageId, LanguagePack>();

/** A pack's code, fetched once; a failed fetch is tried again by the next call. */
export function loadLanguage(meta: Language): Promise<LanguagePack> {
  let p = loaded.get(meta.id);
  if (!p) {
    p = meta.load().then((pack) => (ready.set(meta.id, pack), pack));
    p.catch(() => loaded.delete(meta.id));
    loaded.set(meta.id, p);
  }
  return p;
}

const IN_MODULES = /(?:^|\/)node_modules\//;

/**
 * Adds the project's modules of every enabled pack to `files` (what the type checker gets) as their projections
 * (LanguagePack.project). A pack is loaded only when the VFS has a file it reads outside node_modules, or `path` is
 * one; a pack that was loaded keeps being asked, to drop what a deleted file left.
 */
export async function projectLanguages(vfs: VFS, files: Map<string, FileContents>, path: string, text: string): Promise<void> {
  for (const meta of enabledLanguages) {
    const wanted = meta.inputs.test(path) || [...vfs.files.keys()].some((p) => meta.inputs.test(p) && !IN_MODULES.test(p));
    if (!wanted && !ready.has(meta.id)) continue;
    try {
      await (await loadLanguage(meta)).project(vfs, files, path, text);
    } catch (e) {
      // Without the pack its files go unchecked.
      console.warn(`${meta.id}: ${e}`);
    }
  }
}

/** The projection of the module at `path`, if its pack is loaded and has made one. */
export const languageView = (path: string): LanguageView | undefined => {
  const meta = languageFor(path);
  return meta && ready.get(meta.id)?.view(path);
};

/** The module a projection file (`<module>.tsx`) was made from, if one: `file` is a VFS path. */
export function moduleOfProjection(file: string): string | undefined {
  for (const meta of enabledLanguages) {
    const pack = ready.get(meta.id);
    if (!pack || !file.endsWith(pack.projectionSuffix)) continue;
    const module = file.slice(0, -pack.projectionSuffix.length);
    if (meta.match.test(module)) return module;
  }
}

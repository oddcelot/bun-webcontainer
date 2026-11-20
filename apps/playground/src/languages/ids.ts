/**
 * The language packs of the library (./index.ts), by id: what a hosting file's `languages` may name. Apart from the
 * library so hosting/load.ts can check a file without the packs' code; the library's type keeps the two in step.
 */
export const LANGUAGE_IDS = ["reactivescript"] as const;
export type LanguageId = (typeof LANGUAGE_IDS)[number];

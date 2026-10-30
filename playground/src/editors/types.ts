export type EditorDiagnostic = {
  severity: "error" | "warning";
  message: string;
  /** 1-based. */
  line: number;
  /** 1-based UTF-16 column. */
  column: number;
  /** UTF-16 length; 0 marks the one character at `column`. */
  length: number;
  /** What reported it, shown after the message as editors do: `ts(2322)`, `bun`. */
  source?: string;
};

/** Where the cursor is: 1-based line and UTF-16 column, and how many characters are selected. */
export type EditorCursor = { line: number; column: number; selected: number };

/** Type information shown when the pointer rests on a token: the declaration as code, then its documentation (markdown). */
export type EditorHover = { code: string; docs: string };

/** What a completion is, for its icon. */
export type CompletionKind =
  | "function"
  | "variable"
  | "constant"
  | "property"
  | "class"
  | "interface"
  | "type"
  | "enum"
  | "module"
  | "file"
  | "folder"
  | "keyword"
  | "text";

/** One entry of the completion list. */
export type EditorCompletion = {
  label: string;
  kind: CompletionKind;
  /** Shown after the label, dimmed (e.g. the module it comes from). */
  description?: string;
  /** What accepting it inserts in place of the word before the cursor. */
  insert: string;
  /** 1-based UTF-16 column on the cursor's line where the replaced text starts, if not at the start of the word. */
  start?: number;
  /** Ordering among equally good matches, and the text typing is matched against. */
  sort: string;
  filter: string;
  /** For EditorEvents.resolveCompletion. */
  ref?: unknown;
};

/** The completions at a position; `incomplete`: typing more asks again instead of narrowing these down. */
export type EditorCompletions = { items: EditorCompletion[]; incomplete: boolean };

/** What the editor reports as it changes, for the status bar, and what it asks for. */
export type EditorEvents = {
  /** The cursor moved (null: no editable file). */
  onCursor?(cursor: EditorCursor | null): void;
  /** The markers shown changed. */
  onDiagnostics?(diagnostics: EditorDiagnostic[]): void;
  /** What to show for the token at a 1-based line and UTF-16 column of `path` (null: nothing). */
  hover?(path: string, line: number, column: number): Promise<EditorHover | null>;
  /** The completions at a 1-based line and UTF-16 column of `path`; `trigger` is the character just typed, if that's what asked. */
  complete?(path: string, line: number, column: number, trigger?: string): Promise<EditorCompletions | null>;
  /** The declaration and documentation of a completion (one `complete` returned for `path`), shown beside the list. */
  resolveCompletion?(path: string, item: EditorCompletion): Promise<EditorHover | null>;
};

/** One open file at a time. `text === null` means a binary file (shown read-only). */
export interface CodeEditor {
  open(path: string, text: string | null, onChange: (text: string) => void): void;
  /** The file changed outside the editor (e.g. `Bun.write`); show `text` if it differs. */
  update(text: string): void;
  getText(): string;
  /** Replace the open file's text as one undoable edit (as typing it would); the cursor stays where the text didn't change. */
  replace(text: string): void;
  /** Inline error/warning markers for the open file (replaces the previous ones; empty clears). Lines and columns are 1-based UTF-16. */
  setDiagnostics(diagnostics: EditorDiagnostic[]): void;
  /** Shows the hover (EditorEvents.hover) for the token at the cursor, as resting the pointer on it would. */
  showHover(): void;
  /** Opens the completion list at the cursor (EditorEvents.complete), as typing a name does. */
  suggest(): void;
  /** Puts the cursor at a 1-based line and column, scrolls to it and focuses the editor. */
  reveal(line: number, column: number): void;
  /** Show no file (the last tab was closed). */
  clear(): void;
  destroy(): void;
}

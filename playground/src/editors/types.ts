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
  /** Show no file (the last tab was closed). */
  clear(): void;
  destroy(): void;
}

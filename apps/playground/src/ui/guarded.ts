/**
 * Wraps an effect's apply step so an error is logged instead of thrown. A throw from an apply halts every reactive
 * update on the page (REACTIVITY_HALTED), and createEffect's `error` option doesn't catch it (it only covers the
 * compute step). Use it for applies that call into libraries (the editor, the file tree).
 */
export const guarded =
  <T,>(label: string, apply: (value: T, prev: T | undefined) => void) =>
  (value: T, prev: T | undefined) => {
    try {
      apply(value, prev);
    } catch (e) {
      console.error(`[${label}]`, e);
    }
  };

import { useCallback, useSyncExternalStore } from "react";

// A flag the owner sets and expects to find again: on or off, kept in localStorage. Storage can be missing or refuse (a private
// window, blocked site data, a full quota), and the app must work without it, so every touch of it is guarded and the value
// is held in memory as well. Memory is what is read once a flag has been set: for as long as the page lives it is the truth,
// whatever storage managed to keep.

const memory = new Map<string, boolean>();
const listeners = new Set<() => void>();

function read(key: string, fallback: boolean): boolean {
  const remembered = memory.get(key);
  if (remembered !== undefined) return remembered;
  try {
    const stored = window.localStorage.getItem(key);
    if (stored === "true") return true;
    if (stored === "false") return false;
  } catch {
    // No storage to read: the default stands.
  }
  return fallback;
}

function write(key: string, value: boolean): void {
  memory.set(key, value);
  try {
    window.localStorage.setItem(key, String(value));
  } catch {
    // Not kept for the next visit; kept in memory.
  }
  for (const listener of [...listeners]) listener();
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
}

/** The flag stored under `key` (`initial` until it has been set, here or on an earlier visit) and the way to set it. */
export function useStoredFlag(key: string, initial: boolean): [flag: boolean, setFlag: (value: boolean) => void] {
  const flag = useSyncExternalStore(subscribe, () => read(key, initial), () => initial);
  const setFlag = useCallback((value: boolean) => write(key, value), [key]);
  return [flag, setFlag];
}

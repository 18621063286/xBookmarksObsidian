/**
 * Tiny helpers for safely navigating untyped JSON (X's deeply-nested GraphQL
 * responses, Ollama replies). Using these instead of `any` keeps the parsing
 * code fully type-checked: every access is narrowed, so there are no unsafe
 * member accesses and no `any` leaking through the codebase.
 */

export type JsonObject = { [key: string]: unknown };

export function isObject(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The value at `obj[key]`, or undefined if `obj` isn't an object. */
export function get(v: unknown, key: string): unknown {
  return isObject(v) ? v[key] : undefined;
}

/** Walk a path of keys, stopping (undefined) at the first non-object. */
export function dig(v: unknown, ...path: string[]): unknown {
  let cur: unknown = v;
  for (const key of path) {
    if (!isObject(cur)) return undefined;
    cur = cur[key];
  }
  return cur;
}

export function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

export function asNumber(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

/** Returns the value as an array of unknowns, or [] if it isn't an array. */
export function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? (v as unknown[]) : [];
}

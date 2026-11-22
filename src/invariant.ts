/**
 * A value that the code has already established (a regex group the pattern requires, a split part,
 * an element behind a length or loop check) but that TypeScript cannot see. A missing one is a bug
 * here, not an input error, so it throws an internal Error instead of letting undefined through.
 */
export function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) {
    throw new Error(`internal: missing ${what}`);
  }
  return value;
}

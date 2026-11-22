// Ascending order for Array#sort. Without a comparator, Array#sort orders numbers as text ("10" before "9"),
// so tests that sort ids pass this instead. For strings and for arrays (compared by their text) it is the order
// Array#sort uses by default.
export function ascending(a: any, b: any): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

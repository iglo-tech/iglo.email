export function percentile(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const pick = (p: number) =>
    Number((sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? 0).toFixed(3));
  return { p50: pick(0.5), p95: pick(0.95), p99: pick(0.99), max: pick(1) };
}

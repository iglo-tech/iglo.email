// A stand-in raw-query child that validates both statements, sends one row, then keeps
// running without finishing: the shape of a query that is slow only after its first rows.
import { writeSync } from "node:fs";

await Bun.stdin.text();
writeSync(1, "R0\n1\nR1\n1\n");
for (;;) Bun.sleepSync(50);

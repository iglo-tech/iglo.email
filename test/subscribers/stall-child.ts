// A stand-in raw-query child that validates both statements, stages one row, then keeps
// running without finishing: the shape of a query that is slow only after its first rows.
import { writeSync } from "node:fs";
import { createIdWriter } from "@/subscribers/id-stage";

const request = JSON.parse(await Bun.stdin.text()) as { spool: string };
for (const index of [0, 1]) {
  const writer = createIdWriter(`${request.spool}${index}`);
  writer.push(1n);
  writer.flush();
  writer.close();
  writeSync(1, `R${index}\nB1\n`);
}
for (;;) Bun.sleepSync(50);

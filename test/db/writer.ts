// A process fixture deliberately holds one synchronous write until its parent releases it.
import { readSync } from "node:fs";
import { openDatabase } from "@/db/connection";
import { writeTransaction } from "@/db/transaction";

const db = openDatabase(process.argv[2]!);
try {
  const lock = process.argv[3] === "lock";
  if (!lock) process.stdout.write("attempt\n");
  writeTransaction(db, () => {
    db.run("INSERT INTO fixture_records (id, value) VALUES (?, ?)", [
      lock ? 10 : 20,
      lock ? "first" : "second",
    ]);
    if (lock) {
      process.stdout.write("locked\n");
      readSync(0, Buffer.alloc(1), 0, 1, null);
    }
  });
  process.stdout.write("committed\n");
} finally {
  db.close(true);
}

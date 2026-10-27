import type { Database } from "bun:sqlite";
import { writeTransaction } from "@/db/transaction";

export function transactionTypeChecks(db: Database): void {
  // @ts-expect-error Transactions cannot accept async functions.
  writeTransaction(db, async () => 1);
  // @ts-expect-error Transactions cannot accept promise-returning callbacks.
  writeTransaction(db, () => Promise.resolve("no"));
  // @ts-expect-error An explicit void result must not admit an async callback.
  writeTransaction<void>(db, async () => {});
}

// Run by test/db/instance-lock.test.ts: takes the data directory in this process, prints who won.
import { holdDataDirectory } from "@/db/instance-lock";
import { asBody } from "@/test/read-body";

try {
  holdDataDirectory(process.argv[2]!).release();
  process.stdout.write("held\n");
} catch (error) {
  process.stdout.write(`${asBody<Error>(error).message}\n`);
  process.exitCode = 1;
}

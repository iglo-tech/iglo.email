// A stand-in analytics child for docs/perf/B7-load-memory.md: holds one read snapshot open for
// a second and a half, the way a long report does, then answers with an empty result.
import { writeSync } from "node:fs";
import { openReadOnly } from "@/subscribers/query-runner";

const request = JSON.parse(await Bun.stdin.text()) as { path: string };
const db = openReadOnly(request.path);
db.run("BEGIN");
db.query("SELECT COUNT(*) FROM campaigns").get();
Bun.sleepSync(1500);
db.run("COMMIT");
db.close(true);
writeSync(1, '{"data":[]}');

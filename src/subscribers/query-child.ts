// Source-checkout entry for the raw subscriber query child; the compiled executable
// enters runQueryChild from src/main.ts instead.
import { runQueryChild } from "@/subscribers/query-runner";

await runQueryChild();

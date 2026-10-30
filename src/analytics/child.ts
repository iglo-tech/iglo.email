// Source-checkout entry for the analytics reader child; the compiled executable enters
// runAnalyticsChild from src/main.ts instead.
import { runAnalyticsChild } from "@/analytics/reader";

await runAnalyticsChild();

// B116 (D131) cost of the push-time eligibility check, which the runner asks once per recipient:
// the same check as before and after the change, median of runs, in process. Opt-in; not a CI
// threshold. The same script runs on origin/main (before) and on this branch (after).
//   bun test/campaigns/runner/measure-eligibility.ts
import { runnerFixture } from "@/test/campaigns/runner/fixture";
import { createCampaignRecipients } from "@/subscribers/campaign-recipients";

const RUNS = Number(process.env.ELIGIBLE_MEASURE_RUNS ?? 5);
const CHECKS = Number(process.env.ELIGIBLE_MEASURE_CHECKS ?? 20_000);

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

const f = await runnerFixture();
try {
  const list = await f.list("l");
  const member = await f.member("eligible@x.test", [list]);
  const recipients = createCampaignRecipients(f.db);
  const audience = { type: "regular" as const, lists: [{ id: BigInt(list), optin: "single" }] };
  const recipient = {
    id: BigInt(member.id),
    uuid: member.uuid as string,
    email: "eligible@x.test",
  };
  if (recipients.eligible(audience, recipient) !== "eligible") throw new Error("not eligible");
  const samples: number[] = [];
  for (let r = 0; r < RUNS; r++) {
    const started = performance.now();
    for (let i = 0; i < CHECKS; i++) recipients.eligible(audience, recipient);
    samples.push(((performance.now() - started) * 1000) / CHECKS);
  }
  console.log(
    `eligible() per recipient: ${median(samples).toFixed(2)} us (median of ${RUNS} runs of ${CHECKS})`,
  );
  recipients.close();
} finally {
  await f.close();
}

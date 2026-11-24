// B138b (14-projects section 9, invariant 7; D151): the analytics egress budget is one for the
// process. Two projects' readers, built from one instance's budgets as the composition builds them,
// share its 64 MiB of finished responses waiting to be written.
import { expect, test } from "bun:test";
import { createRealClock } from "@/clock";
import { createInstanceBudgets } from "@/projects/budgets";

const MiB = 1024 * 1024;
// A child that answers with 32 MiB, the largest response one read may have.
const largest = ["head", "-c", String(32 * MiB), "/dev/zero"];

test("finished analytics responses of every project count against one egress budget", async () => {
  const budgets = await createInstanceBudgets(createRealClock());
  const a = budgets.analytics({ path: "a", command: largest });
  const b = budgets.analytics({ path: "b", command: largest });
  const held = [await a.respond("dashboardCounts", []), await a.respond("dashboardCounts", [])];
  try {
    expect(a.heldBytes()).toBe(64 * MiB);
    // A has spent the process's budget: B's read is refused before it starts, as A's own is.
    for (const reader of [b, a]) {
      const refused = await reader.respond("dashboardCounts", []).catch((error: unknown) => error);
      expect(refused).toMatchObject({ kind: "egress" });
    }
  } finally {
    for (const response of held) {
      await response.body?.cancel();
    }
  }
  // Once A's responses are gone, B's read runs.
  const later = await b.respond("dashboardCounts", []);
  expect(b.heldBytes()).toBe(32 * MiB);
  await later.body?.cancel();
  expect(b.heldBytes()).toBe(0);
  await Promise.all([a.close(), b.close()]);
});

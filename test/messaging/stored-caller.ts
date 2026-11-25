// Compiled test-only caller: reads settings through their owner and sends to the owned fixture.
import { openDatabase } from "@/db/connection";
import { createRealClock } from "@/clock";
import { dirname } from "node:path";
import { INSTANCE_DATABASE } from "@/projects/layout";
import { createInstanceSettings } from "@/settings/instance";
import { fixtureEmailer } from "@/test/messaging/sender";

const directory = process.env.M21_DATA_DIR,
  subject = process.env.M21_SUBJECT;
if (!directory || !subject || !subject.startsWith("m08")) {
  throw new Error("Missing synthetic fixture inputs");
}
const clock = createRealClock();
// B139 (D154): SMTP is an instance key, read from instance.db two levels above the project.
const db = openDatabase(dirname(dirname(directory)), INSTANCE_DATABASE);
const settings = createInstanceSettings(db, clock);
const emailer = fixtureEmailer({
  clock,
  settings: () => ({ smtp: settings.read().smtp, rootUrl: "https://example.test" }),
});
try {
  const outcome = await emailer.push({
    from: "sender@example.test",
    to: ["recipient@example.test"],
    subject,
    contentType: "plain",
    body: Buffer.from("retained settings fixture"),
  }).result;
  if (outcome.status !== "accepted") {
    throw new Error("Fixture delivery was not accepted");
  }
} finally {
  await emailer.close();
  settings.close();
  db.close(true);
}

// Compiled test-only caller: reads settings through their owner and sends to the owned fixture.
import { openDatabase } from "@/db/connection";
import { createRealClock } from "@/clock";
import { createListReferences } from "@/lists/references";
import { createRoles } from "@/roles/roles";
import { createSettings } from "@/settings/store";
import { createEmailer } from "@/messaging/email";

const directory = process.env.M21_DATA_DIR,
  subject = process.env.M21_SUBJECT;
if (!directory || !subject || !subject.startsWith("m08"))
  throw new Error("Missing synthetic fixture inputs");
const clock = createRealClock();
const db = openDatabase(directory);
const lists = createListReferences(db);
const roles = createRoles(db, lists);
const settings = createSettings(db, clock, "https://example.test", roles);
const emailer = createEmailer({
  clock,
  settings: () => {
    const current = settings.read();
    return { smtp: current.smtp, rootUrl: current["app.root_url"] };
  },
});
try {
  const outcome = await emailer.push({
    from: "sender@example.test",
    to: ["recipient@example.test"],
    subject,
    contentType: "plain",
    body: Buffer.from("retained settings fixture"),
  }).result;
  if (outcome.status !== "accepted") throw new Error("Fixture delivery was not accepted");
} finally {
  await emailer.close();
  settings.close();
  roles.close();
  lists.close();
  db.close(true);
}

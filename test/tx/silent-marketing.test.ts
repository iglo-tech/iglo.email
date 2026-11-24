// B118a item 3 for a marketing send: an SMTP server that accepts the connection and never greets
// gets no byte, so the send is proven not sent and ends `failed` with `temporary_rejection`. A
// marketing send is never retried (D24): the server sees one connection, however far the clock moves.
// The greeting timeout is nodemailer's real timer, so the send settles in real time.
import { expect, test } from "bun:test";
import { silentServer } from "@/test/messaging/silent-server";
import { asBody } from "@/test/read-body";
import { txFixture } from "@/test/tx/fixture";
import { untilState } from "@/test/wait";

test("a marketing send to a server that never greets ends failed, and is not resent", async () => {
  const silent = await silentServer("1s");
  const f = await txFixture({ smtpPort: silent.port });
  try {
    const template = await f.template("<p>x</p>");
    const list = await f.json("/api/lists", "POST", {
      name: "news",
      type: "public",
      optin: "single",
    });
    const listId = list.body.data.id;
    const ada = await f.subscriber("ada@example.test", "Ada", {
      lists: [listId],
      preconfirm_subscriptions: true,
    });
    const sent = await f.tx({
      subscriber_id: ada,
      template_id: template,
      kind: "marketing",
      list_id: listId,
    });
    expect(sent.status).toBe(200);
    const id = sent.body.data.sends[0].id;
    const row = async () =>
      asBody<{ status: string; error: string | null }>(
        (await f.json(`/api/sends/${id}`)).body.data,
      );

    // Settles when the greeting timer ends the dispatch: the clock is advanced so the loops run.
    let current = await row();
    await untilState(
      async () => {
        f.clock.advance(1000);
        await Bun.sleep(0);
        current = await row();
        return current.status !== "queued" && current.status !== "sending";
      },
      {
        label: "greeting timer ends the dispatch",
        progress: () => current.status,
        stallMs: 20_000,
        intervalMs: 50,
      },
    );
    expect(current).toMatchObject({ status: "failed", error: "temporary_rejection" });
    expect(silent.bytesReceived()).toBe(0);
    expect(silent.connections()).toBe(1);

    // Not retried: a retry would be due after one second, and the clock moves past it.
    f.clock.advance(3_600_000);
    await Bun.sleep(300);
    expect(await row()).toMatchObject({ status: "failed", error: "temporary_rejection" });
    expect(silent.connections()).toBe(1);
    expect(f.sink.messages).toHaveLength(0);
  } finally {
    await f.close();
    await silent.close();
  }
}, 30_000);

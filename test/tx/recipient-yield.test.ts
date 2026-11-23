// B118a: a transactional send to several recipients lets the event loop run between their renders,
// and between their pushes. The order of the events is the test, not their timing: a synchronous loop
// cannot let a queued immediate run, so a turn that appears between the first and the last render (and
// between the first and the last push) is the yield. Without the yield no turn falls between them.
import { expect, test } from "bun:test";
import { txFixture } from "@/test/tx/fixture";

test("a send to several recipients runs a loop turn between their renders and between their pushes", async () => {
  const f = await txFixture({});
  try {
    const templateId = await f.template("<p>Hi {{ subscriber.email }}</p>", "Hello");

    // One event log: the renders and pushes of this send, and each turn of an otherwise idle loop.
    const events: Array<string> = [];
    const renderer = f.owners.renderer;
    const compile = renderer.compile.bind(renderer);
    renderer.compile = (input) => {
      const body = compile(input);
      return {
        ...body,
        renderSync: (...args: Parameters<typeof body.renderSync>) => {
          events.push("render");
          return body.renderSync(...args);
        },
      };
    };
    const push = f.emailer.push.bind(f.emailer);
    f.emailer.push = (...args: Parameters<typeof push>) => {
      events.push("push");
      return push(...args);
    };
    let running = true;
    const spin = () => {
      events.push("turn");
      if (running) {
        setImmediate(spin);
      }
    };
    setImmediate(spin);

    try {
      const response = await f.tx({
        subscriber_mode: "external",
        subscriber_emails: ["a@example.test", "b@example.test", "c@example.test", "d@example.test"],
        template_id: templateId,
        data: {},
      });
      expect(response.status).toBe(200);
    } finally {
      running = false;
    }

    const between = (kind: string) => {
      const at = events.flatMap((event, index) => (event === kind ? [index] : []));
      expect(at.length).toBe(4);
      return events.slice(at[0], at.at(-1)).includes("turn");
    };
    expect(between("render")).toBe(true);
    expect(between("push")).toBe(true);
  } finally {
    await f.close();
  }
});

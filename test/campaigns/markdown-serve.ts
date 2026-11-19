// B104: the campaigns fixture served over a real socket, as a child process. The concurrency test
// in markdown-time.test.ts sends its requests from the test process, so a render that blocks this
// process is seen as a stalled response, as a client sees it. Prints one JSON line with the origin,
// a campaign id and the reader's session headers, then serves until it is killed.
import { campaignsFixture } from "@/test/campaigns/fixture";
import { readerSession } from "@/test/campaigns/markdown-support";

const f = await campaignsFixture();
const news = await f.list("news");
const campaign = await f.campaign({ name: "md", subject: "s", lists: [news] });
const headers = await readerSession(
  f,
  "md-reader",
  ["campaigns:get"],
  [{ id: news, permissions: ["list:get"] }],
);
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(request) {
    const url = new URL(request.url);
    const reads = request.method !== "GET" && request.method !== "HEAD";
    return f.request(`${url.pathname}${url.search}`, {
      method: request.method,
      headers: request.headers,
      ...(reads ? { body: await request.arrayBuffer() } : {}),
    });
  },
});
console.log(
  JSON.stringify({ origin: `http://127.0.0.1:${server.port}`, campaign: campaign.id, headers }),
);
process.on("SIGTERM", async () => {
  server.stop(true);
  await f.close();
  process.exit(0);
});

// Public HTTP boundary for this synthetic fixture only; never registered in production.
import { TestClock } from "@/test/server/fixture";
import { SpikeStore } from "@/test/perf/sqlite-write-load/store";
import type { Mutation, SyntheticEvent } from "@/test/perf/sqlite-write-load/store";
import { Workload } from "@/test/perf/sqlite-write-load/workload";
import type { Mode } from "@/test/perf/sqlite-write-load/workload";
import { asBody, readJson } from "@/test/read-body";

export function startSpikeFixture(directory: string) {
  const store = new SpikeStore(directory);
  const clock = new TestClock();
  let workload: Workload | undefined;
  let subscribers = 0;
  function action(input: Record<string, any>): unknown {
    switch (input.action) {
      case "setup":
        subscribers = input.subscribers;
        store.seed(subscribers);
        return true;
      case "status":
        return store.status();
      case "reserve":
        return store.reserve(input.count);
      case "process":
        return store.process(input.count);
      case "events":
        store.events(asBody<Array<SyntheticEvent>>(input.events));
        return true;
      case "subscriber":
        store.mutate([asBody<Mutation>(input)], input.rollback);
        return true;
      case "search":
        return store.search(input.term);
      case "start":
        workload = new Workload(store, clock, {
          mode: asBody<Mode>(input.mode),
          durationMs: input.durationMs,
          subscribers,
        });
        return true;
      case "advance":
        clock.advance(input.ms);
        workload!.pump();
        return true;
      case "workload":
        return workload!.result();
      case "drain":
        workload!.drain();
        return true;
      default:
        throw new Error("Unknown synthetic action");
    }
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname !== "/synthetic/write-load") {
        return new Response("Not found", { status: 404 });
      }
      try {
        return Response.json({ result: action(await readJson<Record<string, any>>(request)) });
      } catch (error) {
        return Response.json({ error: String(error) }, { status: 400 });
      }
    },
  });
  return {
    origin: `http://127.0.0.1:${server.port}`,
    async close() {
      await server.stop(true);
      store.close();
    },
  };
}

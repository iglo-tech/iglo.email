// Public HTTP boundary for this synthetic fixture only; never registered in production.
import { TestClock } from "@/test/server/fixture";
import {
  SpikeStore,
  type Mutation,
  type SyntheticEvent,
} from "@/test/perf/sqlite-write-load/store";
import { Workload, type Mode } from "@/test/perf/sqlite-write-load/workload";

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
        store.events(input.events as SyntheticEvent[]);
        return true;
      case "subscriber":
        store.mutate([input as Mutation], input.rollback);
        return true;
      case "search":
        return store.search(input.term);
      case "start":
        workload = new Workload(store, clock, {
          mode: input.mode as Mode,
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
      if (new URL(request.url).pathname !== "/synthetic/write-load")
        return new Response("Not found", { status: 404 });
      try {
        return Response.json({ result: action((await request.json()) as Record<string, any>) });
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

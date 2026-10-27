// Synthetic lease policy belongs to this fixture, not the reusable loop.
import { openDatabase } from "@/db/connection";
import { startLoop } from "@/loops/loop";
import { TestClock } from "@/test/server/fixture";

interface Running {
  loop: ReturnType<typeof startLoop<number>>;
  release?: () => void;
}

export function startLoopFixture(dataDir: string) {
  const databases = [openDatabase(dataDir), openDatabase(dataDir)];
  const db = databases[0]!;
  db.run("CREATE TABLE fixture_work (id INTEGER PRIMARY KEY, lease_until INTEGER)");
  const clock = new TestClock();
  const running = new Map<string, Running>();
  const started: Array<{ loop: string; id: string; inTransaction: boolean }> = [];
  const failures: string[] = [];
  const waiters: Array<() => void> = [];
  async function action(input: Record<string, any>): Promise<unknown> {
    switch (input.action) {
      case "add":
        db.run("INSERT INTO fixture_work (id) VALUES (?)", [input.id]);
        return true;
      case "start": {
        const connection = databases[input.connection ?? 0]!;
        const entry: Running = {} as Running;
        const loop = startLoop<number>({
          db: connection,
          clock,
          logger: { error: (error) => failures.push(String(error)) },
          intervalMs: input.intervalMs ?? 100,
          leaseMs: input.leaseMs ?? 500,
          batchSize: input.batchSize ?? 1,
          signal: input.aborted ? AbortSignal.abort("already stopped") : undefined,
          claim(now, leaseUntil, batchSize) {
            return connection
              .query<{ id: bigint }, [number, number, number]>(
                "UPDATE fixture_work SET lease_until = ? WHERE id IN (SELECT id FROM fixture_work WHERE lease_until IS NULL OR lease_until <= ? ORDER BY id LIMIT ?) RETURNING id",
              )
              .all(leaseUntil.getTime(), now.getTime(), batchSize)
              .map((item) => Number(item.id));
          },
          async process(id) {
            started.push({
              loop: input.name,
              id: String(id),
              inTransaction: connection.inTransaction,
            });
            for (const notify of waiters.splice(0)) notify();
            if (input.fail) throw new Error("fixture processing failed");
            if (input.hold)
              await new Promise<void>((resolve) => {
                entry.release = resolve;
              });
          },
        });
        entry.loop = loop;
        running.set(input.name, entry);
        // Observe failure even when the test requests the result later.
        void loop.done.catch(() => undefined);
        return true;
      }
      case "wait-started":
        if (started.length < input.count)
          await new Promise<void>((resolve) => waiters.push(resolve));
        return started;
      case "sleeping":
        await clock.whenSleeping(input.count ?? 1);
        return true;
      case "advance":
        clock.advance(input.ms);
        return true;
      case "stop":
        void running
          .get(input.name)!
          .loop.stop()
          .catch(() => undefined);
        return true;
      case "release":
        running.get(input.name)!.release?.();
        return true;
      case "done": {
        try {
          await running.get(input.name)!.loop.done;
          return { error: null };
        } catch (error) {
          return { error: String(error) };
        }
      }
      case "state":
        return { started, failures };
      default:
        throw new Error("Unknown fixture action");
    }
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      try {
        return Response.json({
          result: await action((await request.json()) as Record<string, any>),
        });
      } catch (error) {
        return Response.json({ error: String(error) }, { status: 400 });
      }
    },
  });
  return {
    origin: `http://127.0.0.1:${server.port}`,
    async close() {
      for (const entry of running.values()) {
        entry.release?.();
        void entry.loop.stop().catch(() => undefined);
      }
      await Promise.allSettled([...running.values()].map((entry) => entry.loop.done));
      await server.stop(true);
      for (const connection of databases) connection.close(true);
    },
  };
}

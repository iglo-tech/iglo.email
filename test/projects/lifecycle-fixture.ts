// B149a: an instance in this process behind its own server on port 0, for the lifecycle tests that
// need a chosen moment (a held request body, a test clock, a paused backup). Every call goes
// through HTTP with an explicit Host header (test/projects/fixture.ts `request`); the instance's
// attention lines are read from its Logs page.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Clock } from "@/clock";
import { openInstance } from "@/projects/instance";
import { serveRouted } from "@/server/server";
import { instanceCall, instanceLogin } from "@/test/projects/admin-fixture";
import type { InstanceSession } from "@/test/projects/admin-fixture";
import { adminCredentials, logIn, request, sessionHeaders } from "@/test/projects/fixture";
import type { Credentials, Session } from "@/test/projects/fixture";
import { asBody } from "@/test/read-body";

export const PRIMARY = "127.0.0.1";

export interface LifecycleFixture {
  readonly admin: Credentials;
  readonly dataDir: string;
  readonly port: number;
  readonly operator: InstanceSession;
  readonly failures: Array<unknown>;
  readonly instance: Awaited<ReturnType<typeof openInstance>>;
  /** An instance JSON call with the operator's session. */
  call(method: string, path: string, body?: unknown): Promise<Response>;
  /** The instance Logs page's text. */
  logs(): Promise<string>;
  /** Stops and closes the instance; `keep` leaves the data directory for a reopen. */
  close(keep?: boolean): Promise<void>;
}

/**
 * Opens an instance in `dataDir` (a new temporary one by default) on `clock`, starts its loops and
 * logs the operator in. `before` runs on the data directory before the instance opens.
 */
export async function openLifecycle(
  clock: Clock,
  options: { dataDir?: string; before?: (dataDir: string) => void } = {},
): Promise<LifecycleFixture> {
  const admin = await adminCredentials();
  const dataDir = options.dataDir ?? (await mkdtemp(join(tmpdir(), "iglo-email-b149a-")));
  options.before?.(dataDir);
  const instance = await openInstance(
    {
      dataDir,
      rootUrl: `http://${PRIMARY}`,
      listen: { host: PRIMARY, port: 0 },
      seed: { admin: { user: admin.user, password: admin.password } },
    },
    clock,
  );
  const server = serveRouted({ host: PRIMARY, port: 0 }, (incoming, peer) =>
    instance.dispatch(incoming, peer),
  );
  const failures: Array<unknown> = [];
  instance.attach(server);
  instance.start((failure) => failures.push(failure ?? new Error("a loop failed")));
  const port = server.port!;
  const operator = (await instanceLogin(port, PRIMARY, admin)).session!;
  const call = (method: string, path: string, body?: unknown) =>
    instanceCall(port, PRIMARY, operator, method, path, body);
  let closed = false;
  return {
    admin,
    dataDir,
    port,
    operator,
    failures,
    instance,
    call,
    logs: async () => (await call("GET", "/admin/instance/logs")).text(),
    async close(keep = false) {
      if (!closed) {
        closed = true;
        await Promise.allSettled(instance.stop());
        await server.stop(true);
        await instance.close();
      }
      if (!keep) {
        await rm(dataDir, { recursive: true, force: true });
      }
    },
  };
}

/** Creates a project through the instance API; fails the test on anything but 200. */
export async function createProject(
  f: LifecycleFixture,
  body: { slug: string; name: string; hostname: string },
): Promise<void> {
  const response = await f.call("POST", "/api/instance/projects", body);
  const text = await response.text();
  if (response.status !== 200) {
    throw new Error(`create ${body.slug}: ${response.status} ${text}`);
  }
}

/** Starts a project delete through the API; resolves with its status and body. */
export function deleteProject(f: LifecycleFixture, slug: string) {
  const answer = f
    .call("DELETE", `/api/instance/projects/${slug}`, { confirm: slug })
    .then(async (response) => ({ status: response.status, text: await response.text() }));
  // Observed at once: a test that fails first stops the server under it.
  answer.catch(() => {});
  return answer;
}

/** The final snapshot's database path from a delete's 200 answer. */
export const deletedDatabase = (text: string) =>
  asBody<{ data: { database: string } }>(JSON.parse(text)).data.database;

/** A project-session JSON call on `host`. */
export async function projectCall(
  f: LifecycleFixture,
  host: string,
  session: Session,
  method: string,
  path: string,
  body?: unknown,
) {
  const response = await request(f.port, host, path, {
    method,
    headers: sessionHeaders(session),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, text: await response.text(), headers: response.headers };
}

/** Logs the admin into the project on `host`. */
export const projectSession = (f: LifecycleFixture, host: string) => logIn(f.port, host, f.admin);

/**
 * A request to `host` whose JSON body is held open after its first bytes, so the project's router is
 * answering it until `finish()`.
 */
export function heldRequest(
  port: number,
  host: string,
  session: Session,
  path: string,
  value: unknown,
) {
  const body = JSON.stringify(value);
  const encoder = new TextEncoder();
  let finish!: () => void;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(body.slice(0, 10)));
      let done = false;
      finish = () => {
        if (done) {
          return;
        }
        done = true;
        controller.enqueue(encoder.encode(body.slice(10)));
        controller.close();
      };
    },
  });
  const answered = request(port, host, path, {
    method: "POST",
    headers: { ...sessionHeaders(session), "content-length": String(body.length) },
    body: stream,
  }).then(async (response) => ({ status: response.status, text: await response.text() }));
  // Observed at once: a test that fails first stops the server under it.
  answered.catch(() => {});
  return { answered, finish: () => finish() };
}

/** Whether the project on `host` still answers this session (it is on the routing table). */
export async function serving(port: number, host: string, session: Session): Promise<boolean> {
  return (
    (await request(port, host, "/api/profile", { headers: sessionHeaders(session) })).status === 200
  );
}

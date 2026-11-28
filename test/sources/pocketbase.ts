// The PocketBase test harness (15-external-sources section 8, D170, D190). `startPocketBase` runs
// the real 0.40.5 binary in its own temporary directory on a free loopback port with the fixture
// schema of the shared harness (harness.ts): `services` (the service account), `users`, `events`
// and the `recipients` view, each readable by the service account only. The `PocketBase` interface
// below is the harness both binaries return (iglo-base.ts too), since both speak PocketBase's API.
// See README.md.
import { join } from "node:path";
import type { PocketBaseConfig } from "@/sources/pocketbase";
import { startHarness } from "@/test/sources/harness";
import { pocketBaseBinary } from "@/test/sources/pocketbase-binary";

export type PocketBaseRecord = Record<string, unknown> & { id: string };

export interface PocketBase {
  /** `http://127.0.0.1:<port>`. */
  readonly url: string;
  readonly port: number;
  /** The data directory (pb_data) of this instance. */
  readonly dir: string;
  /** The service account the source settings name. */
  readonly service: { collection: "services"; identity: string; password: string };
  /** A superuser API call; throws with the body on a non-2xx answer. */
  api(method: string, path: string, body?: unknown): Promise<any>;
  create(collection: string, record: Record<string, unknown>): Promise<PocketBaseRecord>;
  update(
    collection: string,
    id: string,
    record: Record<string, unknown>,
  ): Promise<PocketBaseRecord>;
  remove(collection: string, id: string): Promise<void>;
  /** A user and its recipients-view row. */
  user(fields?: Record<string, unknown>): Promise<PocketBaseRecord>;
  /** An events record for `user`; `occurredAt` defaults to now. */
  event(
    user: string,
    name: string,
    data?: Record<string, unknown>,
    fields?: Record<string, unknown>,
  ): Promise<PocketBaseRecord>;
  /** Renames a field of a collection (a schema change the source must report as permanent). */
  renameField(collection: string, from: string, to: string): Promise<void>;
  /** Stops the process; the data directory stays until `close`. */
  stop(): Promise<void>;
  /** Starts the process again on the same port and data. */
  start(): Promise<void>;
  /**
   * Pauses (SIGSTOP) or resumes (SIGCONT) the process: a server that accepts and never answers.
   * `pause` settles once every thread of the process is stopped (B154): `kill` returns before
   * that, and until each thread has run to its stop the server still answers.
   */
  pause(): Promise<void>;
  resume(): void;
  /** Stops the process and removes its directory. */
  close(): Promise<void>;
}

/** The adapter's settings for a harness instance: the fixture schema's names, `url` as given. */
export function sourceConfig(url: string, service: PocketBase["service"]): PocketBaseConfig {
  return {
    url,
    authCollection: service.collection,
    identity: service.identity,
    password: service.password,
    events: {
      collection: "events",
      user: "user",
      name: "name",
      data: "data",
      occurredAt: "occurredAt",
      key: "key",
    },
    recipients: { collection: "recipients", email: "email", name: "name", optOut: "optOut" },
    users: { collection: "users", leavingFilter: "deletedAt != ''" },
  };
}

/** Starts PocketBase with the fixture schema and the service account. */
export function startPocketBase(): Promise<PocketBase> {
  return startHarness({
    label: "PocketBase",
    prefix: "iglo-pocketbase-",
    binary: pocketBaseBinary,
    serveArgs: (root) => [
      `--dir=${join(root, "pb_data")}`,
      `--publicDir=${join(root, "pb_public")}`,
      `--hooksDir=${join(root, "pb_hooks")}`,
      `--migrationsDir=${join(root, "pb_migrations")}`,
      "--automigrate=false",
    ],
  });
}

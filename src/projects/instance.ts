// The instance (14-projects sections 1–3, 9 and 10, D142, D151, D157): instance.db with its
// registry, one wired project per registered project, the routing table that picks a project by
// `Host`, and the lifecycle that creates, edits and deletes projects while it runs. Native: listmonk
// serves one database per process. main() owns the lock, the bind and the signals.
import type { Database } from "bun:sqlite";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import type { Clock } from "@/clock";
import { must } from "@/invariant";
import { openDatabase } from "@/db/connection";
import { instanceMigrations, runMigrations } from "@/db/migrations";
import { createApp } from "@/app";
import { createInstanceRouter } from "@/admin/instance/routes";
import type { InstanceProjects, ProjectSummary } from "@/admin/instance/projects";
import { createTranslation } from "@/i18n/i18n";
import { createInstanceLogBuffer, mergeLogs } from "@/maintenance/log-buffer";
import { createAdminSync } from "@/projects/admin-sync";
import { createInstanceBudgets } from "@/projects/budgets";
import type { InstanceBudgets } from "@/projects/budgets";
import { createProject } from "@/projects/compose";
import { createDispatcher } from "@/messaging/dispatcher";
import type { Dispatcher } from "@/messaging/dispatcher";
import type { SMTPServer } from "@/messaging/email";
import type { Project, ProjectOptions, ProjectServer } from "@/projects/compose";
import { archiveDeleted, deletedSnapshots } from "@/projects/deleted";
import type { ArchiveProgress, DeletedProject } from "@/projects/deleted";
import {
  INSTANCE_DATABASE,
  PROJECTS,
  oldLayoutMessage,
  preMigrationDirectory,
  projectDirectory,
  usesOldLayout,
} from "@/projects/layout";
import { createInstanceLogger } from "@/projects/logger";
import {
  RegistryError,
  SLUG_PATTERN,
  createRegistry,
  normalizeHostname,
  projectName,
  requestHostname,
} from "@/projects/registry";
import type { NewProject, ProjectChange, ProjectRecord, Registry } from "@/projects/registry";
import { SES_PATH, registerSesRoute } from "@/bounces/ses-route";
import type { PageSite } from "@/public/layout";
import { Router } from "@/server/router";
import { ok } from "@/server/response";
import { defaults } from "@/settings/defaults";
import { holdForInstance } from "@/settings/hold";
import { sessionDuration } from "@/settings/duration";
import { createInstanceSettings, instanceLoginSettings } from "@/settings/instance";
import type { InstanceSettingsStore } from "@/settings/instance";
import { createClientAddress } from "@/server/client-address";
import { defaultAuthPolicy } from "@/users/auth";
import { createAdminAccountStore } from "@/users/account";
import type { AdminAccountStore } from "@/users/account";
import { initialAdmin } from "@/users/bootstrap";
import { createHandoffTokens } from "@/users/handoff";
import { createInstanceAuth } from "@/users/instance-auth";
import { hashPassword } from "@/users/password";
import { createCapacity } from "@/messaging/capacity";
import type { Capacity } from "@/messaging/capacity";
import { createSesAccount } from "@/messaging/ses-account";
import type { SesAccount } from "@/messaging/ses-account";

/** The paths the instance answers on the instance host and on an unclaimed one (section 2). */
function instancePath(pathname: string): boolean {
  return (
    pathname === "/admin/instance" ||
    pathname.startsWith("/admin/instance/") ||
    pathname === "/api/instance" ||
    pathname.startsWith("/api/instance/")
  );
}

/** The one path that serves project-authored text as a script (`appearance.public.custom_js`). */
const CUSTOM_SCRIPT_PATH = "/public/custom.js";

/**
 * The primary project's public custom script where the instance routes answer (B172, D200): an
 * empty script, so no project-authored code runs in the origin where the instance credentials are
 * typed and sent. The project's other hosts (extra hostnames) still serve it.
 */
function emptyCustomScript(method: string): Response {
  return new Response(method === "HEAD" ? null : "", {
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/** The fresh install's one project (D151). Its name is the site name's default. */
export const PRIMARY_SLUG = "main";

/** The Projects page's "sent" window. */
const DAY_MS = 24 * 60 * 60 * 1000;
/** A request's read ended by its cut connection ("The connection was closed."). */
const isAbort = (error: unknown) => error instanceof DOMException && error.name === "AbortError";

/**
 * How long a delete waits for the project's requests in flight (B149a, D164): the sender's close
 * bound (`SENDER_CLOSE_MS`). A request still running then is cut: its database closes under it.
 */
export const DRAIN_MS = 5000;

export interface InstanceConfig {
  readonly dataDir: string;
  /** `--root-url`: its host is the instance host, and the primary project's root URL is it. */
  readonly rootUrl: string;
  readonly listen: { readonly host: string; readonly port: number };
  /**
   * The environment's first users: the admin account on a first start with none (B140, D153), and
   * the API user, seeded as before into the primary project while it has no users (D151).
   */
  readonly seed: ProjectOptions["seed"];
  /** SES's API base URL for a region (B145a); AWS's own unless a test gives its stand-in. */
  readonly sesEndpoint?: (region: string) => string;
}

interface Entry {
  /** Replaced by an edit (a rename or new extra hostnames). */
  record: ProjectRecord;
  readonly project: Project;
  /** Requests the project's router is answering now. */
  requests: number;
  /** Set by a delete waiting for `requests` to reach 0. */
  idle: (() => void) | undefined;
  /** Off the routing table, being deleted: a loop's failure no longer stops the process. */
  removed: boolean;
}

/**
 * A delete that stopped after the project left the routing table (B149a, D164): not served, listed
 * with its error, and finished by the next delete from the step that failed.
 */
interface StuckDelete {
  readonly entry: Entry;
  /** The project closed: a retry does not close it again. */
  closed: boolean;
  /** Its registry rows are gone: a restart would find a leftover directory. */
  unregistered: boolean;
  /** The final snapshot's finished steps: a retry neither claims another name nor tars again. */
  readonly archive: ArchiveProgress;
  error: string;
}

/**
 * `--root-url` with its host replaced by `hostname`: scheme, port and path are kept
 * (14-projects section 2).
 */
export function projectRootUrl(rootUrl: string, hostname: string): string {
  const url = new URL(rootUrl);
  const rest = url.href.slice(url.origin.length);
  const origin = `${url.protocol}//${hostname}${url.port ? `:${url.port}` : ""}`;
  // A root URL without a trailing slash keeps none, as the bootstrap gave it.
  return origin + (rest === "/" && !rootUrl.endsWith("/") ? "" : rest);
}

/** The instance's own public page brand, for the SES route's 404 and 429 without a primary. */
const instancePageSite = (rootUrl: string): PageSite => ({
  rootUrl: rootUrl.replace(/\/+$/, ""),
  logoUrl: "",
  faviconUrl: "",
  subscriptionPage: false,
  archive: false,
  siteUrl: "",
  accent: "",
  font: "system-sans",
  header: "auto",
  siteName: "iglo.email",
});

const notFound = () =>
  new Response("404 page not found\n", {
    status: 404,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });

/**
 * The directories under `projects/` whose names are project slugs, by name. Anything else there
 * (`lost+found` when `projects/` is its own filesystem, a symlink, a file) is no project's
 * (B155a r1, D176), so it neither marks the instance as several projects nor blocks a first start.
 */
function projectDirectories(root: string): Array<string> {
  return existsSync(resolve(root, PROJECTS))
    ? readdirSync(resolve(root, PROJECTS), { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && SLUG_PATTERN.test(entry.name))
        .map((entry) => entry.name)
        .toSorted()
    : [];
}

function newEntry(record: ProjectRecord, project: Project): Entry {
  return { record, project, requests: 0, idle: undefined, removed: false };
}

export type Instance = Awaited<ReturnType<typeof openInstance>>;

/**
 * Opens and migrates `instance.db` in a data directory of today's layout; the caller closes it.
 * A test fixture registers projects through it (with createRegistry) before a start.
 */
export function openInstanceDatabase(dataDir: string, clock: Clock): Database {
  const root = resolve(dataDir);
  if (usesOldLayout(root)) {
    throw new Error(oldLayoutMessage(root));
  }
  const db = openDatabase(root, INSTANCE_DATABASE);
  try {
    runMigrations(db, root, clock, instanceMigrations, {
      directory: preMigrationDirectory(root),
      name: "instance",
    });
    return db;
  } catch (error) {
    db.close(true);
    throw error;
  }
}

/**
 * Opens and migrates instance.db, registers the primary project on a fresh install, and wires every
 * registered project (none of their loops start yet: B52). The caller already holds the lock.
 */
export async function openInstance(config: InstanceConfig, clock: Clock) {
  const root = resolve(config.dataDir);
  const instanceHost = normalizeHostname(new URL(config.rootUrl).hostname);
  const db = openInstanceDatabase(root, clock);
  let registry: Registry | undefined;
  let budgets: InstanceBudgets | undefined;
  let account: AdminAccountStore | undefined;
  let settings: InstanceSettingsStore | undefined;
  /** The one dispatcher every project sends through (B141): its pools, rate and start schedule. */
  let dispatcher: Dispatcher | undefined;
  /** The SES account snapshot and the capacity forecast over every project (B145a). */
  let ses: SesAccount | undefined;
  let capacity: Capacity | undefined;
  /** Wired projects in registration order (slug order at start). */
  const entries: Array<Entry> = [];
  /** The routing table: hostname to project, and the primary for every other host. */
  let hosts = new Map<string, Entry>();
  let primary: Entry | undefined;
  let server: ProjectServer | undefined;
  let fail: ((failure?: unknown) => void) | undefined;
  /** Projects whose loops failed: the instance health route turns unhealthy. */
  const down = new Set<string>();
  /** Slugs whose directory a create or a delete is working on: not leftovers. */
  const busy = new Set<string>();
  /** Deletes that stopped part way, by slug: not served, not leftovers, finished by a new delete. */
  const stuck = new Map<string, StuckDelete>();
  /** Set by stop(): a create no longer starts (B149a, D164). */
  let stopping = false;
  /**
   * B155a (D176): `backups/deleted` could not be listed at this start, so it cannot prove the
   * instance only ever served one project. The several-projects rules apply until the next start,
   * which lists it again; nothing permanent is written.
   */
  let unsureOfSeveral = false;
  /**
   * Set when the bounded HTTP stop cuts the requests still running (B155a, D176): their aborted
   * reads are the cut its attention line already named, not unexpected errors.
   */
  let serverCut = false;
  /** An aborted read of a request that cut ended: on the instance host and every project's. */
  const cutRead = (error: unknown) => serverCut && isAbort(error);
  // The instance's own lines: stderr and the buffer the instance Logs page shows (D157).
  const instanceLogs = createInstanceLogBuffer(clock);
  const { logger: instanceLogger, attention } = createInstanceLogger(instanceLogs, cutRead);

  /**
   * Create, edit and delete run one at a time (D157): a create that loses a same-slug race sees the
   * winner's directory and removes nothing, and no edit sees a half-deleted project.
   */
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const run = queue.then(work, work);
    queue = run.catch(() => undefined);
    return run;
  };

  const rebuild = () => {
    const next = new Map<string, Entry>();
    for (const entry of entries) {
      for (const hostname of [entry.record.hostname, ...entry.record.extra]) {
        next.set(hostname, entry);
      }
    }
    hosts = next;
    primary = entries.find((entry) => entry.record.primary);
  };

  const options = (record: ProjectRecord): ProjectOptions => ({
    slug: record.slug,
    name: record.name,
    directory: projectDirectory(root, record.slug),
    // The primary project's root URL is `--root-url` itself, so one install's links are unchanged.
    rootUrl: record.primary ? config.rootUrl : projectRootUrl(config.rootUrl, record.hostname),
    snapshots: { directory: preMigrationDirectory(root), name: record.slug },
    // The environment's API user is the primary project's only: an API credential is one project's.
    seed: record.primary ? config.seed : { admin: config.seed.admin },
  });

  const tokens = createHandoffTokens(clock);
  const adminSync = () =>
    createAdminSync({
      account: must(account, "admin account"),
      projects: () =>
        entries.map((entry) => ({
          slug: entry.record.slug,
          syncAdmin: (current: Parameters<Project["syncAdmin"]>[0]) =>
            entry.project.syncAdmin(current),
        })),
      attention,
    });
  let sync: ReturnType<typeof adminSync> | undefined;

  const wire = async (record: ProjectRecord) => {
    const admin = must(sync, "admin sync");
    const project = await createProject(
      {
        clock,
        budgets: must(budgets, "budgets"),
        settings: must(settings, "instance settings").reader,
        dispatcher: must(dispatcher, "dispatcher"),
        instanceRootUrl: config.rootUrl,
        listen: config.listen,
        admin: {
          account: admin.account,
          changed: (slug, credentials) => admin.change(slug, credentials),
          redeem: (slug, token) => tokens.redeem(slug, token),
        },
        projects: () => entries.map(({ record: r }) => ({ slug: r.slug, name: r.name })),
        capacity: must(capacity, "capacity"),
        expectedError: cutRead,
      },
      options(record),
    );
    // A restored instance.db holds every project's sending until it is released (D158).
    holdForInstance(project.db, db);
    return project;
  };

  /** Only the primary project may hold the instance host (14-projects section 2). */
  const checkInstanceHost = (record: Pick<ProjectRecord, "primary" | "hostname" | "extra">) => {
    if (!record.primary && [record.hostname, ...record.extra].includes(instanceHost)) {
      throw new RegistryError(
        409,
        `The instance host ${instanceHost} can only be the primary project's`,
      );
    }
  };

  const closeAll = async () => {
    // A create or delete in progress finishes first: it may still write the registry.
    await queue;
    for (const entry of entries.toReversed()) {
      await entry.project.close();
    }
    entries.length = 0;
    // A delete that stopped before its close: tried once more, as a delete would. Its registry rows
    // decide what the next start does (served again, or a leftover).
    for (const { entry, closed } of stuck.values()) {
      if (!closed) {
        await entry.project.close().catch(() => {});
      }
    }
    stuck.clear();
    // Last in the shutdown order (14-projects section 7): every project has stopped asking for
    // slots and drained; the pools close. After stop() this is the same, already settled close.
    await dispatcher?.close();
    // Its settings listener goes before the store closes, also after a partial open (B149b).
    await ses?.stop();
    registry?.close();
    account?.close();
    settings?.close();
    db.close(true);
  };

  try {
    registry = createRegistry(db, clock);
    settings = createInstanceSettings(db, clock);
    account = createAdminAccountStore(db, clock);
    const instanceKeys = settings;
    // The effective rate is the lower of messaging.max_send_rate and SES's MaxSendRate, and the
    // quota guard holds marketing and campaign slots (B145b, D161). A new snapshot or a settings
    // change that moves either wakes the dispatcher.
    const sesService = createSesAccount({
      clock,
      settings: settings.reader,
      attention,
      endpoint: config.sesEndpoint,
      onChange: () => dispatcher?.wake(),
    });
    ses = sesService;
    dispatcher = createDispatcher({
      clock,
      // Validated on save (src/settings/validate.ts): an array of servers and a whole number.
      smtp: () => {
        const servers: unknown = instanceKeys.read().smtp;
        return Array.isArray(servers) ? servers.filter((s): s is SMTPServer => !!s) : [];
      },
      rate: sesService.rate,
      held: sesService.held,
    });
    capacity = createCapacity({
      clock,
      account: ses,
      sources: () => entries.map((entry) => entry.project.capacity),
    });
    const directories = projectDirectories(root);
    // A fresh install, or one whose first start stopped before its registry row: register the
    // primary project. Its directory is created by its wiring, or used as it is (D151). An instance
    // with an admin account has started before, so an empty registry there means every project
    // was deleted, and nothing is registered again (D157).
    if (
      registry.list().length === 0 &&
      account.get() === null &&
      directories.every((name) => name === PRIMARY_SLUG)
    ) {
      registry.add({
        slug: PRIMARY_SLUG,
        name: defaults["app.site_name"],
        hostname: instanceHost,
        primary: true,
      });
    }
    registry.followInstanceHost(instanceHost);
    // B149b r2 (D165): a deleted project's snapshot is proof the instance served several projects,
    // for one that deleted it before the registry recorded that. A listing that fails proves
    // nothing either way: the rules apply for this start only (B155a, D176).
    const snapshots = deletedSnapshots(root, attention);
    if (snapshots === "found") {
      registry.markSeveral();
    }
    unsureOfSeveral = snapshots === "unlisted";
    const records = registry.list();
    for (const name of directories) {
      if (!records.some((record) => record.slug === name)) {
        attention(`${PROJECTS}/${name} has no registry row: it is not served`);
        // B155a (D176): a project directory with no row is another project's (v2.0.0 left one
        // when a delete's archive failed before its rename, and a create that crashed before its
        // row leaves one): its late notices must not reach this project's address lookup.
        registry.markSeveral();
      }
    }
    budgets = await createInstanceBudgets(clock);
    // The admin account (B140): created from the environment on a start with none. Once it exists
    // the variables are not read, as a project with users never read them (D153).
    const first = account.get() ? null : initialAdmin(config.seed.admin, config.seed.api);
    if (first) {
      account.create(first.username, await hashPassword(first.password));
    }
    sync = adminSync();
    for (const record of records) {
      checkInstanceHost(record);
      entries.push(newEntry(record, await wire(record)));
    }
    // B162a (D188): an upgraded instance whose projects already read a source keeps them reading.
    settings.settleSourcesUpgrade(() => entries.some((entry) => entry.project.hasSourceUrl()));
    rebuild();
  } catch (error) {
    await closeAll();
    throw error;
  }
  const registered = must(registry, "registry");
  const changes = must(sync, "admin sync");
  const rootUrlOf = (slug: string) => {
    const entry = entries.find((item) => item.record.slug === slug);
    return entry ? options(entry.record).rootUrl : undefined;
  };

  /**
   * Wires a project, registers it and serves it, without a restart (14-projects section 10).
   * Everything is checked before the directory is made. The registry row is written last: a
   * failure before it removes the new directory, and a crash before it leaves a directory with no
   * row, which a start reports and never serves.
   */
  const add = (input: NewProject): Promise<ProjectRecord> =>
    serial(async () => {
      // A create after the shutdown began is refused before anything is made (B149a, D164); one
      // already wiring finishes, is registered, and is not started (the next start serves it).
      if (stopping) {
        throw new RegistryError(503, "The instance is shutting down: nothing was created");
      }
      if (!SLUG_PATTERN.test(input.slug)) {
        throw new RegistryError(400, `Invalid project slug: ${input.slug}`);
      }
      const name = projectName(input.name);
      const hostname = normalizeHostname(input.hostname);
      const extra = (input.extra ?? []).map(normalizeHostname);
      if (new Set([hostname, ...extra]).size !== extra.length + 1) {
        throw new RegistryError(400, "A hostname is listed twice");
      }
      if (input.primary && primary) {
        throw new RegistryError(409, "There is a primary project already");
      }
      if (input.primary && hostname !== instanceHost) {
        throw new RegistryError(400, "The primary project's hostname is the instance host");
      }
      checkInstanceHost({ primary: input.primary ?? false, hostname, extra });
      if (entries.some((entry) => entry.record.slug === input.slug) || stuck.has(input.slug)) {
        throw new RegistryError(409, `A project named ${input.slug} exists`);
      }
      const directory = projectDirectory(root, input.slug);
      if (existsSync(directory)) {
        throw new RegistryError(409, `${PROJECTS}/${input.slug} exists already`);
      }
      // Checked again, with the registry's own rules, when the row is written below.
      const taken = new Set(entries.flatMap((e) => [e.record.hostname, ...e.record.extra]));
      if ([hostname, ...extra].some((h) => taken.has(h))) {
        throw new RegistryError(409, "A hostname belongs to another project");
      }
      const pending: ProjectRecord = {
        slug: input.slug,
        name,
        createdAt: clock.now().toISOString(),
        primary: input.primary ?? false,
        hostname,
        extra,
      };
      busy.add(input.slug);
      try {
        let project: Project;
        try {
          project = await wire(pending);
        } catch (error) {
          rmSync(directory, { recursive: true, force: true });
          throw error;
        }
        let record: ProjectRecord;
        try {
          record = registered.add({ ...input, name, hostname, extra });
        } catch (error) {
          await project.close();
          rmSync(directory, { recursive: true, force: true });
          throw error;
        }
        const entry = newEntry(record, project);
        if (server) {
          project.attach(server);
        }
        entries.push(entry);
        rebuild();
        if (fail && !stopping) {
          startProject(entry);
        }
        return record;
      } finally {
        busy.delete(input.slug);
      }
    });

  /** Renames a project or replaces its extra hostnames; the routing table follows at once. */
  const update = (slug: string, change: ProjectChange): Promise<ProjectRecord> =>
    serial(async () => {
      const entry = entries.find((item) => item.record.slug === slug);
      if (!entry) {
        throw new RegistryError(404, `No project ${slug}`);
      }
      if (change.extra !== undefined) {
        checkInstanceHost({
          primary: entry.record.primary,
          hostname: entry.record.hostname,
          extra: change.extra.map(normalizeHostname),
        });
      }
      entry.record = registered.update(slug, change);
      rebuild();
      return entry.record;
    });

  /**
   * Deletes a project (14-projects section 10): it leaves the routing table, its sending stops,
   * its in-flight requests finish against its open database for at most DRAIN_MS, its loops stop
   * under today's deadlines (its sends in SMTP flight under the sender's 5 s close deadline), it
   * closes, its registry rows go, then its database moves to `backups/deleted/` with a tarball of
   * its other files, and its directory is removed. A crash before the rows go serves it again at the
   * next start; a crash after leaves a directory with no row, reported and never served, with
   * nothing lost. A failure after the routing table keeps the project off it and listed with the
   * error, and the next delete finishes from the failed step (B149a, D164). Returns null for a slug
   * no project has.
   */
  const remove = (slug: string): Promise<DeletedProject | null> =>
    serial(async () => {
      const left = stuck.get(slug);
      if (left) {
        return finishDelete(left);
      }
      const index = entries.findIndex((entry) => entry.record.slug === slug);
      if (index === -1) {
        return null;
      }
      const entry = must(entries.splice(index, 1)[0], "project entry");
      entry.removed = true;
      busy.add(slug);
      try {
        rebuild();
        // Its sending stops first (D157): grants go back, waiting pushes end not-started with their
        // claims handed back, and no slot request is answered while its HTTP requests drain. Pushes
        // in SMTP flight get the sender's 5 s close deadline; the shared pools are never cut.
        const sending = entry.project.stopSending();
        const cut = await drain(entry);
        if (cut > 0) {
          attention(
            `Deleting project ${slug}: ${cut} request${cut === 1 ? "" : "s"} still running after ` +
              `${DRAIN_MS / 1000} s ${cut === 1 ? "was" : "were"} cut; its database closes under ` +
              `${cut === 1 ? "it" : "them"}`,
          );
        }
        await Promise.allSettled([sending, ...entry.project.stop()]);
      } finally {
        busy.delete(slug);
      }
      return finishDelete({ entry, closed: false, unregistered: false, archive: {}, error: "" });
    });

  /**
   * A delete's steps after the loops stopped: close, registry rows, final snapshot. Each step done
   * is remembered, so a delete that stopped part way is finished by the next one from that step.
   */
  async function finishDelete(state: StuckDelete): Promise<DeletedProject> {
    const slug = state.entry.record.slug;
    busy.add(slug);
    try {
      if (!state.closed) {
        await state.entry.project.close();
        state.closed = true;
        down.delete(slug);
      }
      if (!state.unregistered) {
        registered.remove(slug);
        state.unregistered = true;
      }
      const deleted = await archiveDeleted(root, slug, clock, state.archive);
      stuck.delete(slug);
      return deleted;
    } catch (error) {
      const step = !state.closed
        ? "its close"
        : !state.unregistered
          ? "its registry rows"
          : "its archive";
      state.error = `${step}: ${error instanceof Error ? error.message : String(error)}`;
      stuck.set(slug, state);
      const message = `Deleting project ${slug} stopped at ${state.error}. It is not served; delete it again to finish`;
      attention(message);
      throw new RegistryError(500, message);
    } finally {
      busy.delete(slug);
    }
  }

  const projects: InstanceProjects = {
    list: (): Array<ProjectSummary> => {
      const since = new Date(clock.now().getTime() - DAY_MS);
      return [
        ...entries.map((entry) => ({
          ...entry.record,
          rootUrl: options(entry.record).rootUrl,
          activity: entry.project.activity(since),
          deleteError: null,
        })),
        // A delete that stopped part way: its database may be closed, so it has no counts.
        ...[...stuck.values()].map(({ entry, error }) => ({
          ...entry.record,
          rootUrl: options(entry.record).rootUrl,
          activity: null,
          deleteError: error,
        })),
      ];
    },
    leftovers: () =>
      projectDirectories(root).filter(
        (name) =>
          !busy.has(name) &&
          !stuck.has(name) &&
          !entries.some((entry) => entry.record.slug === name),
      ),
    create: add,
    update,
    remove,
    logs: () =>
      mergeLogs([
        { source: "instance", lines: instanceLogs.lines() },
        ...entries.map((entry) => ({ source: entry.record.slug, lines: entry.project.logs() })),
      ]),
    customCode: (slug) =>
      entries.find((entry) => entry.record.slug === slug)?.project.customCode() ?? null,
    // Serialized with the lifecycle, so a project being deleted is never written to (D201).
    setCustomCode: (slug, change) =>
      serial(async () => {
        const entry = entries.find((item) => item.record.slug === slug);
        if (!entry) {
          throw new RegistryError(404, `No project ${slug}`);
        }
        entry.project.setCustomCode(change);
        return entry.project.customCode();
      }),
  };

  const instanceSettings = must(settings, "instance settings");
  const sesAccount = must(ses, "SES account");
  const instanceClientAddress = createClientAddress(
    () => instanceLoginSettings(instanceSettings.read()).trustedProxies,
    instanceLogger,
  );
  const instanceAuth = await createInstanceAuth({
    account: must(account, "admin account"),
    clock,
    rootUrl: config.rootUrl,
    change: (credentials, keepSession) => changes.change(null, credentials, keepSession),
    // The instance session lasts security.session_duration, an instance key (B139, D154).
    policy: {
      ...defaultAuthPolicy,
      get sessionDurationMs() {
        return sessionDuration(
          instanceLoginSettings(instanceSettings.read()).sessionDuration,
          clock.now().getTime(),
        );
      },
    },
  });
  const instanceRouter = createInstanceRouter({
    auth: instanceAuth,
    tokens,
    rootUrl: config.rootUrl.replace(/\/+$/, ""),
    instanceHost,
    projectRootUrl: rootUrlOf,
    settings: instanceSettings,
    projects,
    // The login limit's address honours security.trusted_proxies, as a project's login does.
    clientAddress: instanceClientAddress,
    ses: sesAccount,
    // The Sending page (B143b): the instance's forecast as no project, without a candidate.
    forecast: () => must(capacity, "capacity").forecast(null, null),
    smtpTest: () => {
      const project = primary?.project;
      return project && ((body, revalidate) => project.smtpTest(body, revalidate));
    },
  });
  const instanceApp = createApp({
    bootstrap: {
      host: config.listen.host,
      port: config.listen.port,
      dataDir: root,
      rootUrl: config.rootUrl,
      initialAdmin: config.seed.admin,
    },
    clock,
    db,
    logger: instanceLogger,
    i18n: createTranslation(),
  });
  // SES notices (B142, D156): the instance's route, with the instance's bounce keys; each notice
  // goes to the one project it names (14-projects section 8).
  const sesRouter = new Router();
  const sesProjects = () =>
    entries
      .toSorted((a, b) => (a.record.slug < b.record.slug ? -1 : 1))
      .map((entry) => entry.project.ses);
  const sesPage = () => primary?.project.ses.page() ?? instancePageSite(config.rootUrl);
  registerSesRoute(sesRouter, {
    clock,
    settings: () => {
      const current = instanceSettings.read();
      const topics: unknown = current["bounce.ses_topic_arns"];
      return {
        enabled: current["bounce.enabled"] === true,
        webhooksEnabled: current["bounce.webhooks_enabled"] === true,
        ses: current["bounce.ses_enabled"] === true,
        sesTopics: Array.isArray(topics)
          ? topics.filter((topic): topic is string => typeof topic === "string")
          : [],
      };
    },
    page: sesPage,
    // The bounce table's own peers: no project's slug is empty. The floor, or the largest
    // project's setting, so one install's budget is unchanged.
    limit: must(budgets, "budgets").limit("bounce", {
      slug: "",
      limit: () =>
        Math.max(
          must(budgets, "budgets").bounceWebhookPerMinute,
          ...entries.map((entry) => entry.project.ses.bounceLimit()),
        ),
      page: sesPage,
      clientAddress: instanceClientAddress,
    }),
    projects: sesProjects,
    servedSeveral: () => unsureOfSeveral || registered.servedSeveral(),
    logger: instanceLogger,
  });

  return {
    /** The instance host: `--root-url`'s host. */
    host: instanceHost,
    /** The projects being served, in registration order. */
    projects: (): ReadonlyArray<ProjectRecord> => entries.map((entry) => entry.record),
    /** The primary project's router, for main()'s `inspect` (the OpenAPI coverage test). */
    primaryRouter: (): Router | undefined => primary?.project.router,
    /** False once any project's loops have failed (14-projects section 9). */
    healthy: (): boolean => down.size === 0,
    /**
     * Picks the project by `Host` (lowercase, no port; `X-Forwarded-Host` is ignored). A host no
     * project claims, the instance host included, goes to the primary project if there is one.
     */
    dispatch(request: Request, peerAddress: string): Promise<Response> {
      const hostname = requestHostname(request.headers.get("host"));
      const claimed = hosts.get(hostname);
      const { pathname } = new URL(request.url);
      // The instance routes come first on the instance host and on a host no project claims
      // (section 2); on a project's own host these paths are that project's.
      const instanceOrigin = !claimed || hostname === instanceHost;
      if (instanceOrigin && instancePath(pathname)) {
        return instanceRouter.handle(instanceApp, request, peerAddress);
      }
      // SES notices are the instance's on those hosts, with or without a primary (B142).
      if (instanceOrigin && pathname === SES_PATH && request.method === "POST") {
        return sesRouter.handle(instanceApp, request, peerAddress);
      }
      const entry = claimed ?? primary;
      // No project-authored script runs where the instance's cookies live (D200). The router
      // matches this exact spelling only, so no other spelling reaches the project's route.
      if (
        entry &&
        instanceOrigin &&
        pathname === CUSTOM_SCRIPT_PATH &&
        (request.method === "GET" || request.method === "HEAD")
      ) {
        return Promise.resolve(emptyCustomScript(request.method));
      }
      if (entry) {
        return serve(entry, request, peerAddress);
      }
      // Without a primary, the instance pages still need their bundled stylesheets, favicon and
      // scripts: the login pages use the public ones, the signed-in pages the admin's (D200).
      if (pathname.startsWith("/admin/static/") || pathname.startsWith("/public/static/")) {
        return instanceRouter.handle(instanceApp, request, peerAddress);
      }
      return Promise.resolve(answerWithoutPrimary(request));
    },
    attach(bound: ProjectServer): void {
      server = bound;
      for (const entry of entries) {
        entry.project.attach(bound);
      }
    },
    /** Starts every project's loops, in registration order. A loop's failure calls `onFail`. */
    start(onFail: (failure?: unknown) => void): void {
      fail = onFail;
      sesAccount.start();
      for (const entry of entries) {
        startProject(entry);
      }
    },
    /**
     * Every project's orderly stops, the last registered first, then the dispatcher's. main() appends
     * the HTTP stop. The dispatcher stops in the same turn as the projects, not after they settle: a
     * project's sender waits for its pushes in SMTP flight, and only the dispatcher's emailer bounds
     * that drain (5 s, then it cancels the sockets), as each project's own emailer did before B141.
     */
    stop(): Array<unknown> {
      stopping = true;
      const stops = [
        ...entries.toReversed().flatMap((entry) => entry.project.stop()),
        sesAccount.stop(),
      ];
      return dispatcher ? [...stops, dispatcher.close()] : stops;
    },
    /**
     * The HTTP stop main() appends (B149a, D164): the attached server stops taking requests, and
     * those in flight get at most DRAIN_MS on the instance clock, a delete's drain bound, before
     * their connections are cut and the databases close under them. A stalled upload no longer
     * holds the shutdown until Bun's own idle timeout.
     */
    async stopServer(): Promise<void> {
      const bound = server;
      if (!bound) {
        return;
      }
      const deadline = new AbortController();
      const expired = clock.sleep(DRAIN_MS, deadline.signal).then(
        () => true,
        () => false,
      );
      const cut = await Promise.race([bound.stop().then(() => false), expired]);
      deadline.abort();
      if (cut) {
        const running = bound.pendingRequests;
        attention(
          `Stopping: ${running} request${running === 1 ? "" : "s"} still running after ` +
            `${DRAIN_MS / 1000} s ${running === 1 ? "was" : "were"} cut`,
        );
        serverCut = true;
        await bound.stop(true);
      }
    },
    close: closeAll,
    add,
    update,
    remove,
  };

  /** One request to a project's router, counted until its handler answers (a delete's drain). */
  async function serve(entry: Entry, request: Request, peerAddress: string): Promise<Response> {
    entry.requests++;
    try {
      return await entry.project.router.handle(entry.project.app, request, peerAddress);
    } finally {
      entry.requests--;
      if (entry.requests === 0) {
        entry.idle?.();
      }
    }
  }

  /**
   * Waits until the project's counted requests have all answered, for at most DRAIN_MS on the
   * instance clock. Returns how many were still running at the deadline (0 when all answered).
   */
  async function drain(entry: Entry): Promise<number> {
    if (entry.requests === 0) {
      return 0;
    }
    const deadline = new AbortController();
    const idle = new Promise<"idle">((resolve) => {
      entry.idle = () => resolve("idle");
    });
    const expired = clock.sleep(DRAIN_MS, deadline.signal).then(
      () => "cut" as const,
      () => "idle" as const,
    );
    const outcome = await Promise.race([idle, expired]);
    deadline.abort();
    entry.idle = undefined;
    return outcome === "cut" ? entry.requests : 0;
  }

  function startProject(entry: Entry): void {
    entry.project.start((failure) => {
      if (entry.removed) {
        return;
      }
      down.add(entry.record.slug);
      must(fail, "instance failure handler")(failure);
    });
  }

  /** Without a primary project: health, a way to the instance pages, and a 404 that names nothing. */
  function answerWithoutPrimary(request: Request): Response {
    const { pathname } = new URL(request.url);
    if (pathname === "/health" && (request.method === "GET" || request.method === "HEAD")) {
      return down.size === 0
        ? ok(true)
        : Response.json({ message: "Background work has stopped" }, { status: 503 });
    }
    if (
      (pathname === "/admin" || pathname.startsWith("/admin/")) &&
      !pathname.startsWith("/admin/instance/")
    ) {
      const target = new URL(config.rootUrl);
      target.pathname = `${target.pathname.replace(/\/$/, "")}/admin/instance/projects`;
      return new Response(null, {
        status: 302,
        headers: { Location: target.href },
      });
    }
    return notFound();
  }
}

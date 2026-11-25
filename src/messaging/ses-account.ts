// The SES account snapshot (14-projects section 7, "Reading the account", B145a, D159). Native:
// listmonk reads no provider account. An instance service: one snapshot for the process, read with
// the instance's read-only IAM credentials through SES v2 `GetAccount`, held in memory only.
// A failed read keeps the last snapshot and never stops sending.
import type { Clock } from "@/clock";
import { signRequest } from "@/messaging/sigv4";
import type { Settings } from "@/settings/validate";

/** The values read from `GetAccount`, and when. */
export interface SesSnapshot {
  readonly maxSendRate: number;
  /** -1 when SES gives the account no 24-hour limit. */
  readonly max24HourSend: number;
  readonly sentLast24Hours: number;
  readonly productionAccessEnabled: boolean;
  readonly sendingEnabled: boolean;
  /** ISO time of the read. */
  readonly readAt: string;
}

export interface SesCredentials {
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

/** What the instance knows of the account now. */
export interface SesAccountState {
  /** All three `ses.api_*` settings are set. */
  readonly configured: boolean;
  /** The last good read, kept through failed ones; null before the first. */
  readonly snapshot: SesSnapshot | null;
  /** The last read's error while reads fail; null after a good read. */
  readonly error: string | null;
}

/** The 10-second limit on one `GetAccount` call. */
export const GET_ACCOUNT_TIMEOUT_MS = 10_000;
/** The normal refresh. */
export const REFRESH_MS = 5 * 60_000;
/** The refresh while little of the quota is left, and the age past which a forecast reads again. */
export const FAST_REFRESH_MS = 60_000;
const ATTENTION_MS = 60 * 60_000;

/** SES's public endpoint for a region; tests pass their own server instead. */
export const sesEndpoint = (region: string) => `https://email.${region}.amazonaws.com`;

/** The instance's API credentials, or null unless all three are set. */
export function sesCredentials(settings: Settings): SesCredentials | null {
  const region: unknown = settings["ses.api_region"];
  const accessKeyId: unknown = settings["ses.api_access_key_id"];
  const secretAccessKey: unknown = settings["ses.api_secret_access_key"];
  return typeof region === "string" &&
    region &&
    typeof accessKeyId === "string" &&
    accessKeyId &&
    typeof secretAccessKey === "string" &&
    secretAccessKey
    ? { region, accessKeyId, secretAccessKey }
    : null;
}

/** `messaging.max_send_rate`: messages per second, 0 for no cap (D92). */
export function sendRateSetting(settings: Settings): number {
  const value: unknown = settings["messaging.max_send_rate"];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * The effective rate (section 7, "Rate"): the lower of the setting and SES's `MaxSendRate`. A
 * setting of 0 (no cap) leaves SES's rate; without a snapshot, or a rate SES did not give, the
 * setting alone applies. 0 means no cap. Pure, so the dispatcher (B145b) uses the same rule.
 */
export function effectiveRate(setting: number, snapshot: Pick<SesSnapshot, "maxSendRate"> | null) {
  const ses = snapshot && snapshot.maxSendRate > 0 ? snapshot.maxSendRate : 0;
  if (!ses) {
    return setting;
  }
  return setting > 0 ? Math.min(setting, ses) : ses;
}

/**
 * When the next read is due after one with this snapshot: every minute while what is left is at
 * most `max(10% of the quota, effective rate × 300 s)`, else every 5 minutes.
 */
export function refreshDelay(snapshot: SesSnapshot | null, rate: number): number {
  if (!snapshot || snapshot.max24HourSend < 0) {
    return REFRESH_MS;
  }
  const remaining = snapshot.max24HourSend - snapshot.sentLast24Hours;
  const line = Math.max(0.1 * snapshot.max24HourSend, rate * 300);
  return remaining <= line ? FAST_REFRESH_MS : REFRESH_MS;
}

/**
 * The guard's hold line (section 7, "Last-resort guard"): `max(2% of Max24HourSend, effective rate ×
 * 60 s)`. The second term is what the app can send between two fast reads, so SES never refuses
 * mail past the quota before the next read sees it.
 */
export function holdLine(snapshot: Pick<SesSnapshot, "max24HourSend">, rate: number): number {
  return Math.max(0.02 * snapshot.max24HourSend, rate * (FAST_REFRESH_MS / 1000));
}

/**
 * Whether the guard holds marketing and campaign starts on this snapshot: what is left of the
 * 24-hour quota is at most the hold line. Never without a snapshot or for an account without a
 * daily limit. Pure, so a test can compute it by hand.
 */
export function quotaHeld(
  snapshot: Pick<SesSnapshot, "max24HourSend" | "sentLast24Hours"> | null,
  rate: number,
): boolean {
  if (!snapshot || snapshot.max24HourSend < 0) {
    return false;
  }
  return snapshot.max24HourSend - snapshot.sentLast24Hours <= holdLine(snapshot, rate);
}

const number = (value: unknown, name: string) => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`SES GetAccount answered without ${name}`);
  }
  return value;
};

/** The fields read from a `GetAccount` answer or refusal; each is checked before it is used. */
interface SendQuotaBody {
  readonly MaxSendRate?: unknown;
  readonly Max24HourSend?: unknown;
  readonly SentLast24Hours?: unknown;
}
interface GetAccountBody {
  readonly SendQuota?: unknown;
  readonly ProductionAccessEnabled?: unknown;
  readonly SendingEnabled?: unknown;
  readonly message?: unknown;
  readonly Message?: unknown;
}

/** A JSON object; its fields are all optional and unknown in `T`, so nothing is assumed. */
const isObject = <T extends object>(value: unknown): value is T =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The answer's JSON object, or null: a refusal from something other than SES may not be JSON. */
function parseBody(text: string): GetAccountBody | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return isObject<GetAccountBody>(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** The most of a `GetAccount` answer read; a real one is well under 1 KiB. */
const ANSWER_LIMIT = 64 * 1024;

/**
 * The answer's text, reading at most `limit` bytes of it: the stream is cancelled past the limit,
 * so a long or endless answer never sits in memory whole. `over` says the limit was passed.
 */
async function readCapped(
  response: Response,
  limit: number,
): Promise<{ readonly text: string; readonly over: boolean }> {
  if (!response.body) {
    return { text: "", over: false };
  }
  const reader = response.body.getReader();
  const chunks: Array<Uint8Array> = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => {});
        return { text: "", over: true };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return { text: new TextDecoder().decode(Buffer.concat(chunks)), over: false };
}

/** One signed `GET /v2/email/account`. Throws with SES's own message on a refusal. */
export async function getAccount(
  credentials: SesCredentials,
  options: { readonly endpoint: string; readonly now: Date; readonly signal?: AbortSignal },
): Promise<SesSnapshot> {
  const url = `${options.endpoint.replace(/\/+$/, "")}/v2/email/account`;
  const signed = await signRequest({
    method: "GET",
    url,
    region: credentials.region,
    service: "ses",
    credentials,
    date: options.now,
  });
  const timeout = AbortSignal.timeout(GET_ACCOUNT_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { ...signed, accept: "application/json" },
      redirect: "error",
      signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
    });
  } catch (error) {
    if (timeout.aborted) {
      throw new Error("SES GetAccount did not answer within 10 seconds", { cause: error });
    }
    throw new Error(
      `SES GetAccount failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  let read: { readonly text: string; readonly over: boolean };
  try {
    read = await readCapped(response, ANSWER_LIMIT);
  } catch (error) {
    if (timeout.aborted) {
      throw new Error("SES GetAccount did not answer within 10 seconds", { cause: error });
    }
    throw new Error(
      `SES GetAccount failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (response.ok && read.over) {
    throw new Error("SES GetAccount answered more than 64 KiB");
  }
  const body = read.over ? null : parseBody(read.text);
  if (!response.ok) {
    const message = body?.message ?? body?.Message;
    const kind = (response.headers.get("x-amzn-errortype") ?? "").split(":")[0];
    throw new Error(
      `SES GetAccount answered ${response.status}${kind ? ` ${kind}` : ""}${typeof message === "string" && message ? `: ${message.slice(0, 300)}` : ""}`,
    );
  }
  const quota = body?.SendQuota;
  if (!body || !isObject<SendQuotaBody>(quota)) {
    throw new Error("SES GetAccount answered without SendQuota");
  }
  const fields = body;
  return {
    maxSendRate: number(quota.MaxSendRate, "SendQuota.MaxSendRate"),
    max24HourSend: number(quota.Max24HourSend, "SendQuota.Max24HourSend"),
    sentLast24Hours: number(quota.SentLast24Hours, "SendQuota.SentLast24Hours"),
    productionAccessEnabled: fields.ProductionAccessEnabled === true,
    sendingEnabled: fields.SendingEnabled === true,
    readAt: options.now.toISOString(),
  };
}

/** The guard's attention line when holding starts (`holding`) or stops. */
function guardLine(holding: boolean, snapshot: SesSnapshot | null, rate: number): string {
  if (!snapshot) {
    return "SES quota guard: resuming marketing and campaign sends: the SES API keys changed";
  }
  const left = snapshot.max24HourSend - snapshot.sentLast24Hours;
  const line = Math.ceil(holdLine(snapshot, rate));
  return holding
    ? `SES quota guard: holding marketing and campaign sends: ${left} of the 24-hour quota of ${snapshot.max24HourSend} left, at or below the hold line of ${line} (snapshot read at ${snapshot.readAt})`
    : `SES quota guard: resuming marketing and campaign sends: ${left} of the 24-hour quota of ${snapshot.max24HourSend} left, above the hold line of ${line} (snapshot read at ${snapshot.readAt})`;
}

const sameCredentials = (a: SesCredentials | null, b: SesCredentials | null) =>
  a?.region === b?.region &&
  a?.accessKeyId === b?.accessKeyId &&
  a?.secretAccessKey === b?.secretAccessKey;

export function createSesAccount(deps: {
  readonly clock: Clock;
  /** The instance keys: the credentials and `messaging.max_send_rate`. */
  readonly settings: {
    read(): Settings;
    subscribe(listener: (next: Settings, current: Settings) => void): () => void;
  };
  /** SES's base URL for a region; `sesEndpoint` unless a test gives its own. */
  readonly endpoint?: ((region: string) => string) | undefined;
  readonly attention: (message: string) => void;
  /**
   * The effective rate or the guard's hold changed (B145b): a new snapshot, a key change or a
   * change of `messaging.max_send_rate`. The instance wakes the dispatcher with it.
   */
  readonly onChange?: (() => void) | undefined;
}) {
  const { clock } = deps;
  const endpoint = deps.endpoint ?? sesEndpoint;
  let snapshot: SesSnapshot | null = null;
  let error: string | null = null;
  let lastAttention: number | null = null;
  /** When the last read began, good or failed: an on-demand read waits a minute after it. */
  let lastAttempt: number | null = null;
  let reading: Promise<void> | null = null;
  /** Bumped when the credentials change, so a read with the old ones is not kept. */
  let generation = 0;
  /** The generation `reading` was started with. */
  let readingGeneration = 0;
  let stopped = false;
  let running: Promise<void> | null = null;
  let sleeping: AbortController | null = null;
  const lifetime = new AbortController();

  const credentials = () => sesCredentials(deps.settings.read());
  const rate = () => effectiveRate(sendRateSetting(deps.settings.read()), snapshot);
  /** The guard (B145b, D161): true while the latest snapshot is at or below the hold line. */
  let holding = false;
  /** The effective rate as of the last change handed to `onChange`. */
  let lastRate = rate();

  /**
   * Re-reads the hold and the rate after the snapshot or the settings changed: one attention line
   * when holding starts and one when it stops, and `onChange` when either moved. A failed read
   * changes neither, so it is never a cause.
   */
  function evaluate(): void {
    const nextRate = rate();
    const next = credentials() !== null && quotaHeld(snapshot, nextRate);
    const moved = next !== holding || nextRate !== lastRate;
    if (next !== holding) {
      holding = next;
      deps.attention(guardLine(next, snapshot, nextRate));
    }
    lastRate = nextRate;
    if (moved) {
      deps.onChange?.();
    }
  }

  /**
   * One read with the current credentials; concurrent callers share it. A read still in flight
   * with keys that have since changed is not shared: the caller waits for it, then reads with the
   * new keys at once (B149b), so neither the loop nor a forecast waits a refresh for them.
   */
  function read(): Promise<void> {
    if (reading) {
      return readingGeneration === generation ? reading : reading.then(read);
    }
    const current = credentials();
    if (!current) {
      return Promise.resolve();
    }
    const started = generation;
    readingGeneration = started;
    const now = clock.now();
    lastAttempt = now.getTime();
    reading = getAccount(current, {
      endpoint: endpoint(current.region),
      now,
      signal: lifetime.signal,
    })
      .then(
        (next) => {
          if (started === generation && !stopped) {
            snapshot = next;
            error = null;
            lastAttention = null;
            evaluate();
          }
        },
        (error_: unknown) => {
          if (started !== generation || stopped) {
            return;
          }
          error = error_ instanceof Error ? error_.message : String(error_);
          const at = clock.now().getTime();
          if (lastAttention === null || at - lastAttention >= ATTENTION_MS) {
            lastAttention = at;
            deps.attention(
              `${error}${snapshot ? `; keeping the snapshot read at ${snapshot.readAt}` : ""}`,
            );
          }
        },
      )
      .finally(() => {
        reading = null;
      });
    return reading;
  }

  const state = (): SesAccountState => ({
    configured: credentials() !== null,
    snapshot,
    error,
  });

  const unsubscribe = deps.settings.subscribe((next, current) => {
    if (!sameCredentials(sesCredentials(next), sesCredentials(current))) {
      // Another account, or none: its snapshot is not this one's.
      generation++;
      snapshot = null;
      error = null;
      lastAttention = null;
      lastAttempt = null;
      sleeping?.abort();
    }
    // The rate setting, or the keys, may move the effective rate and the hold line.
    evaluate();
  });

  async function loop(): Promise<void> {
    while (!stopped) {
      const keys = generation;
      await read();
      if (stopped) {
        return;
      }
      // The keys changed while it read: that read is discarded, and the new keys are read now.
      if (keys !== generation) {
        continue;
      }
      sleeping = new AbortController();
      try {
        await clock.sleep(refreshDelay(snapshot, rate()), sleeping.signal);
      } catch {
        // Woken early: the credentials changed, or the service stops.
      }
      sleeping = null;
    }
  }

  return {
    /** Reads at once, then on the refresh schedule, until stop(). */
    start(): void {
      running ??= loop();
    },
    async stop(): Promise<void> {
      stopped = true;
      unsubscribe();
      lifetime.abort();
      sleeping?.abort();
      await running;
      await reading?.catch(() => {});
    },
    /** The snapshot as it is now. */
    current: state,
    /**
     * The state a forecast uses: read again first when the snapshot is older than a minute
     * (section 7, "on demand"). A failed read is not repeated within the minute either.
     */
    async fresh(): Promise<SesAccountState> {
      const age = lastAttempt === null ? Infinity : clock.now().getTime() - lastAttempt;
      if (!stopped && credentials() && age > FAST_REFRESH_MS) {
        await read();
      }
      return state();
    },
    /** The instance settings button: a read now, with its values or the AWS error. */
    async check(): Promise<SesAccountState> {
      if (!stopped) {
        await reading;
        await read();
      }
      return state();
    },
    /** The effective rate now: the setting and the latest snapshot. */
    rate,
    /** The guard: marketing and campaign starts wait while this is true (B145b). */
    held: () => holding,
    /** `messaging.max_send_rate` as set. */
    setting: () => sendRateSetting(deps.settings.read()),
  };
}
export type SesAccount = ReturnType<typeof createSesAccount>;

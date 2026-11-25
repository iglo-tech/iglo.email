// The capacity forecast (14-projects section 7, "Forecast", B145a, D159). Native: listmonk has no
// forecast. One question: does the busiest 24 hours around a campaign fit the SES quota? Every
// number comes from the rules below, so a test can compute it by hand. The answer holds instance
// totals only: no project is named and no other project's campaign is listed (invariant 1).
import type { Clock } from "@/clock";
import type { PlannedCampaign } from "@/campaigns/planned";
import { effectiveRate } from "@/messaging/ses-account";
import type { SesAccount, SesSnapshot } from "@/messaging/ses-account";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Starts after the 24 hours' start (`day`) and after the window's start (`window`). */
export interface StartCounts {
  readonly day: number;
  readonly window: number;
}

/** What one project gives the forecast: counts and send times only. */
export interface CapacitySource {
  /**
   * This project's own starts after `day` and after `from` (ISO, `from` not before `day`), as
   * campaign messages and every other send: one scan of each table.
   */
  starts(
    day: string,
    from: string,
  ): { readonly campaign: StartCounts; readonly other: StartCounts };
  /** Its scheduled and running campaigns. */
  planned(): ReadonlyArray<PlannedCampaign>;
}

/** The campaign being planned: when it starts, how many it sends, and which one it is. */
export interface Candidate {
  /** Its start; now when null or in the past. */
  readonly at: Date | null;
  readonly recipients: number;
  /** A campaign of the asking project left out of `planned`, so an edited one counts once. */
  readonly exclude: number | null;
}

/** The forecast's inputs once the history is read: everything section 7 lists. */
export interface ForecastInputs {
  readonly now: Date;
  readonly quota: number;
  readonly sentLast24Hours: number;
  readonly rate: number;
  /** The app's own starts in the last 24 hours, all kinds. */
  readonly app24h: number;
  /** The app's non-campaign starts in the last 24 hours (the baseline's source). */
  readonly other24h: number;
  /** The app's own starts after the window's start, F − 24 h (0 when that is not in the past). */
  readonly appInWindow: number;
  /** Every project's planned campaigns, the excluded one left out. */
  readonly planned: ReadonlyArray<Pick<PlannedCampaign, "status" | "sendAt" | "recipients">>;
  readonly candidate: { readonly start: Date; readonly recipients: number } | null;
}

export interface Forecast {
  /** The candidate's start T, or now. */
  readonly start: string;
  /** F, the end of the window: T plus the candidate's recipients at the effective rate. */
  readonly end: string;
  /** F − 24 h. */
  readonly from: string;
  readonly outside: number;
  readonly stillCounted: number;
  readonly baseline: number;
  readonly planned: number;
  readonly candidate: number;
  readonly demand: number;
  /** `Max24HourSend`, or null when SES gives no limit. */
  readonly quota: number | null;
  readonly headroom: number | null;
  readonly fits: boolean;
}

/** The candidate's start T and the window's end F. */
export interface ForecastWindow {
  readonly start: Date;
  readonly end: Date;
}

/** F: the candidate's start (never before now) plus its sending time at `rate` (0: no cap). */
export function windowEnd(
  now: Date,
  rate: number,
  candidate: Pick<Candidate, "at" | "recipients"> | null,
): ForecastWindow {
  if (!candidate) {
    return { start: now, end: now };
  }
  const start = new Date(Math.max(now.getTime(), candidate.at?.getTime() ?? now.getTime()));
  const duration = rate > 0 ? Math.ceil((candidate.recipients / rate) * 1000) : 0;
  return { start, end: new Date(start.getTime() + duration) };
}

/** Section 7's rules, applied to read inputs. Pure. */
export function forecast(inputs: ForecastInputs): Forecast {
  const { now } = inputs;
  const { start, end } = windowEnd(
    now,
    inputs.rate,
    inputs.candidate && {
      at: inputs.candidate.start,
      recipients: inputs.candidate.recipients,
    },
  );
  const from = end.getTime() - DAY;
  // How far F lies in the future: the past part of the window shrinks by as much.
  const ahead = Math.min(DAY, Math.max(0, end.getTime() - now.getTime()));
  const outside = Math.max(0, inputs.sentLast24Hours - inputs.app24h);
  // Outside mail is spread evenly over the past 24 hours; the part after F − 24 h still counts.
  const stillCounted = inputs.appInWindow + Math.ceil((outside * (DAY - ahead)) / DAY);
  // The app's non-campaign mail goes on at its last-24-hour pace in the future part of the window.
  const baseline = Math.ceil((inputs.other24h * ahead) / DAY);
  let planned = 0;
  for (const campaign of inputs.planned) {
    if (campaign.status === "running") {
      planned += campaign.recipients;
      continue;
    }
    const at = campaign.sendAt === null ? now.getTime() : Date.parse(campaign.sendAt);
    if (at > from && at <= end.getTime()) {
      planned += campaign.recipients;
    }
  }
  const candidate = inputs.candidate?.recipients ?? 0;
  planned += candidate;
  const demand = stillCounted + baseline + planned;
  const quota = inputs.quota < 0 ? null : inputs.quota;
  return {
    start: start.toISOString(),
    end: end.toISOString(),
    from: new Date(from).toISOString(),
    outside,
    stillCounted,
    baseline,
    planned,
    candidate,
    demand,
    quota,
    headroom: quota === null ? null : quota - demand,
    fits: quota === null || demand <= quota,
  };
}

/** The API's answer (`GET /api/sending/capacity`). */
export interface CapacityAnswer {
  readonly available: boolean;
  readonly reason: "not_configured" | "not_read" | null;
  readonly error: string | null;
  readonly rate: {
    readonly setting: number;
    readonly ses: number | null;
    readonly effective: number;
  };
  readonly account: {
    readonly max_send_rate: number;
    readonly max_24_hour_send: number;
    readonly sent_last_24_hours: number;
    readonly production_access_enabled: boolean;
    readonly sending_enabled: boolean;
    readonly read_at: string;
    readonly age_seconds: number;
  } | null;
  readonly forecast: {
    readonly start: string;
    readonly window_start: string;
    readonly window_end: string;
    readonly still_counted: number;
    readonly outside: number;
    readonly baseline: number;
    readonly planned: number;
    readonly candidate: number;
    readonly demand: number;
    readonly quota: number | null;
    readonly headroom: number | null;
    readonly fits: boolean;
  } | null;
}

function accountView(snapshot: SesSnapshot | null, now: Date): CapacityAnswer["account"] {
  return snapshot
    ? {
        max_send_rate: snapshot.maxSendRate,
        max_24_hour_send: snapshot.max24HourSend,
        sent_last_24_hours: snapshot.sentLast24Hours,
        production_access_enabled: snapshot.productionAccessEnabled,
        sending_enabled: snapshot.sendingEnabled,
        read_at: snapshot.readAt,
        age_seconds: Math.max(0, Math.floor((now.getTime() - Date.parse(snapshot.readAt)) / 1000)),
      }
    : null;
}

/** The instance's forecast over every project's sources. */
export function createCapacity(deps: {
  readonly clock: Clock;
  readonly account: Pick<SesAccount, "fresh" | "current" | "setting">;
  /** Every served project's source, read at each call (a project added or removed at runtime). */
  readonly sources: () => ReadonlyArray<CapacitySource>;
}) {
  /** Every project's starts in the last 24 hours (all, and not campaign mail) and after `from`. */
  const totals = (day: number, from: number) => {
    const since = new Date(day).toISOString();
    const after = new Date(Math.max(day, from)).toISOString();
    let all = 0;
    let other = 0;
    let inWindow = 0;
    for (const source of deps.sources()) {
      const counted = source.starts(since, after);
      all += counted.campaign.day + counted.other.day;
      other += counted.other.day;
      inWindow += counted.campaign.window + counted.other.window;
    }
    return { all, other, inWindow };
  };
  return {
    /** The answer for `asker` (the project the request reached), with an optional candidate. */
    async forecast(asker: CapacitySource, candidate: Candidate | null): Promise<CapacityAnswer> {
      const state = await deps.account.fresh();
      const now = deps.clock.now();
      const setting = deps.account.setting();
      const snapshot = state.snapshot;
      const rate = {
        setting,
        ses: snapshot ? snapshot.maxSendRate : null,
        effective: effectiveRate(setting, snapshot),
      };
      if (!state.configured || !snapshot) {
        return {
          available: false,
          reason: state.configured ? "not_read" : "not_configured",
          error: state.error,
          rate,
          account: null,
          forecast: null,
        };
      }
      const window = windowEnd(now, rate.effective, candidate);
      // The window's past part starts at F − 24 h; nothing has started after now.
      const history = totals(now.getTime() - DAY, window.end.getTime() - DAY);
      const planned = deps
        .sources()
        .flatMap((source) =>
          source
            .planned()
            .filter((campaign) => !(source === asker && campaign.id === candidate?.exclude)),
        );
      const result = forecast({
        now,
        quota: snapshot.max24HourSend,
        sentLast24Hours: snapshot.sentLast24Hours,
        rate: rate.effective,
        app24h: history.all,
        other24h: history.other,
        appInWindow: history.inWindow,
        planned,
        candidate: candidate && { start: window.start, recipients: candidate.recipients },
      });
      return {
        available: true,
        reason: null,
        error: state.error,
        rate,
        account: accountView(snapshot, now),
        forecast: {
          start: result.start,
          window_start: result.from,
          window_end: result.end,
          still_counted: result.stillCounted,
          outside: result.outside,
          baseline: result.baseline,
          planned: result.planned,
          candidate: result.candidate,
          demand: result.demand,
          quota: result.quota,
          headroom: result.headroom,
          fits: result.fits,
        },
      };
    },
  };
}
export type Capacity = ReturnType<typeof createCapacity>;

// The instance Sending page (14-projects sections 7 and 13; B143b, D162). Native: listmonk has no
// instance and no SES account. What the dispatcher and SES see when the page is rendered: the
// effective rate and where it comes from, the SES snapshot and its age, the quota guard and the
// forecast for the 24 hours ending now. Rendered with the page; reload for newer values.
import type { CapacityAnswer } from "@/messaging/capacity";
import { holdLine } from "@/messaging/ses-account";
import type { SesSnapshot } from "@/messaging/ses-account";

export const SENDING_PATH = "/admin/instance/sending";

/** What the page shows, read once per request. */
export interface SendingState {
  readonly now: Date;
  /** All three `ses.api_*` keys are saved. */
  readonly configured: boolean;
  /** The last good read, kept through failed ones. */
  readonly snapshot: SesSnapshot | null;
  /** The last read's error while reads fail, AWS's own text (the instance admin may see it). */
  readonly error: string | null;
  /** The effective rate and its two inputs, as `GET /api/sending/capacity` answers them. */
  readonly rate: CapacityAnswer["rate"];
  /** The dispatcher's hold predicate as it is now (B145b). */
  readonly held: boolean;
  /** The instance's forecast without a candidate; null without a snapshot. */
  readonly forecast: CapacityAnswer["forecast"];
}

const count = (value: number) => value.toLocaleString("en-US");
const perSecond = (value: number) => `${value.toLocaleString("en-US")}/s`;

/** A snapshot's age as people say it: seconds, minutes, or hours and minutes. */
export function ageText(seconds: number): string {
  if (seconds < 60) {
    return `${seconds} s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes} min`;
  }
  const rest = minutes % 60;
  return `${Math.floor(minutes / 60)} h${rest ? ` ${rest} min` : ""}`;
}

/** Which input sets the effective rate, said plainly. */
function rateSource(rate: CapacityAnswer["rate"]): string {
  if (rate.effective === 0) {
    return "No cap: sending is not paced. Starts are bounded only by the 200 messages in flight.";
  }
  if (rate.ses !== null && rate.ses > 0 && (rate.setting === 0 || rate.ses < rate.setting)) {
    return "SES's MaxSendRate applies: it is lower than the setting.";
  }
  if (rate.ses !== null && rate.ses > 0) {
    return "The setting applies: it is not higher than SES's MaxSendRate.";
  }
  return "The setting applies: SES's MaxSendRate is not known.";
}

function Row(props: { label: string; testid: string; children: unknown }) {
  return (
    <tr>
      <th scope="row">{props.label}</th>
      <td class="align-right" data-testid={props.testid}>
        {props.children}
      </td>
    </tr>
  );
}

function RateCard({ state }: { state: SendingState }) {
  const { rate } = state;
  return (
    <section class="card mb-4" data-testid="sending-rate">
      <h3>Rate</h3>
      <table>
        <tbody>
          <Row label="Effective rate" testid="rate-effective">
            {rate.effective === 0 ? "No cap" : perSecond(rate.effective)}
          </Row>
          <Row label="messaging.max_send_rate" testid="rate-setting">
            {rate.setting === 0 ? "0 (no cap)" : perSecond(rate.setting)}
          </Row>
          <Row label="SES MaxSendRate" testid="rate-ses">
            {rate.ses === null ? "Not read" : perSecond(rate.ses)}
          </Row>
        </tbody>
      </table>
      <p class="text-light" data-testid="rate-source">
        {rateSource(rate)}
      </p>
    </section>
  );
}

function SnapshotCard({ state, snapshot }: { state: SendingState; snapshot: SesSnapshot }) {
  const age = Math.max(0, Math.floor((state.now.getTime() - Date.parse(snapshot.readAt)) / 1000));
  const unlimited = snapshot.max24HourSend < 0;
  return (
    <section class="card mb-4" data-testid="sending-snapshot">
      <h3>SES account</h3>
      {state.error === null ? null : (
        <div role="alert" data-variant="warning" class="mb-4" data-testid="snapshot-stale">
          Stale: reads of the SES account are failing, so these values are from the last good read.
          Last error: <span data-testid="snapshot-error">{state.error}</span>
        </div>
      )}
      {snapshot.sendingEnabled ? null : (
        <div role="alert" data-variant="danger" class="mb-4" data-testid="sending-disabled">
          SES says sending is disabled for this account (SendingEnabled: false). SES refuses the
          mail until AWS enables it again.
        </div>
      )}
      <table>
        <tbody>
          <Row label="Max24HourSend" testid="snapshot-max">
            {unlimited ? "No daily limit" : count(snapshot.max24HourSend)}
          </Row>
          <Row label="SentLast24Hours" testid="snapshot-sent">
            {count(snapshot.sentLast24Hours)}
          </Row>
          <Row label="Remaining" testid="snapshot-remaining">
            {unlimited
              ? "No daily limit"
              : count(snapshot.max24HourSend - snapshot.sentLast24Hours)}
          </Row>
          <Row label="Production access" testid="snapshot-production">
            {snapshot.productionAccessEnabled
              ? "Yes"
              : "No: the account is in the SES sandbox and sends only to verified addresses"}
          </Row>
          <Row label="Sending enabled" testid="snapshot-sending">
            {snapshot.sendingEnabled ? "Yes" : "No"}
          </Row>
          <Row label="Read at" testid="snapshot-read-at">
            <time datetime={snapshot.readAt}>{snapshot.readAt}</time>
          </Row>
          <Row label="Age" testid="snapshot-age">
            {ageText(age)}
          </Row>
        </tbody>
      </table>
    </section>
  );
}

function GuardCard({ state, snapshot }: { state: SendingState; snapshot: SesSnapshot }) {
  if (snapshot.max24HourSend < 0) {
    return (
      <section class="card mb-4" data-testid="sending-guard">
        <h3>Quota guard</h3>
        <p data-testid="guard-state">
          SES gives this account no daily limit: the guard never holds.
        </p>
      </section>
    );
  }
  const remaining = snapshot.max24HourSend - snapshot.sentLast24Hours;
  const line = Math.ceil(holdLine(snapshot, state.rate.effective));
  return (
    <section class="card mb-4" data-testid="sending-guard">
      <h3>Quota guard</h3>
      {state.held ? (
        <div role="alert" data-variant="warning" class="mb-4" data-testid="guard-state">
          Holding marketing and campaign sends: the remaining quota is at or below the hold line.
          Transactional mail is not held. Sending resumes by itself after a read above the line.
        </div>
      ) : (
        <p data-testid="guard-state">Not holding: the remaining quota is above the hold line.</p>
      )}
      <table>
        <tbody>
          <Row label="Remaining quota" testid="guard-remaining">
            {count(remaining)}
          </Row>
          <Row label="Hold line" testid="guard-line">
            {count(line)}
          </Row>
        </tbody>
      </table>
      <p class="text-light">
        The hold line is the larger of 2% of Max24HourSend and the effective rate × 60 s.
      </p>
    </section>
  );
}

function ForecastCard({ forecast }: { forecast: NonNullable<SendingState["forecast"]> }) {
  return (
    <section class="card mb-4" data-testid="sending-forecast">
      <h3>Forecast</h3>
      <p class="text-light">
        The 24 hours from <time datetime={forecast.window_start}>{forecast.window_start}</time> to{" "}
        <time datetime={forecast.window_end}>{forecast.window_end}</time>, every project together.
      </p>
      {forecast.fits ? null : (
        <div role="alert" data-variant="warning" class="mb-4" data-testid="forecast-over">
          Over the quota by {count(-(forecast.headroom ?? 0))}.
        </div>
      )}
      <table>
        <tbody>
          <Row label="Still counted" testid="forecast-still-counted">
            {count(forecast.still_counted)}
          </Row>
          <Row label="Outside sends (other software)" testid="forecast-outside">
            {count(forecast.outside)}
          </Row>
          <Row label="Baseline" testid="forecast-baseline">
            {count(forecast.baseline)}
          </Row>
          <Row label="Planned" testid="forecast-planned">
            {count(forecast.planned)}
          </Row>
          <Row label="Window demand" testid="forecast-demand">
            {count(forecast.demand)}
          </Row>
          <Row label="Quota" testid="forecast-quota">
            {forecast.quota === null ? "No daily limit" : count(forecast.quota)}
          </Row>
          <Row label="Headroom" testid="forecast-headroom">
            {forecast.headroom === null ? "No daily limit" : count(forecast.headroom)}
          </Row>
          <Row label="Fits" testid="forecast-fits">
            {forecast.fits ? "Yes" : "No"}
          </Row>
        </tbody>
      </table>
    </section>
  );
}

/** The Sending page's body. */
export function SendingBody(props: { state: SendingState; settingsHref: string }) {
  const { state } = props;
  const { snapshot } = state;
  return (
    <section class="instance-sending">
      <header class="page-header">
        <h1 class="page-title">Sending</h1>
      </header>
      <div class="page-content">
        <p class="text-light" data-testid="sending-help">
          What the dispatcher and SES see now. Reload for newer values.
        </p>
        <RateCard state={state} />
        {!state.configured ? (
          <div role="alert" class="card mb-4" data-testid="sending-no-keys">
            No SES API credentials are saved: there is no SES reading, no capacity forecast and no
            quota guard, and the setting alone sets the rate. Save them in{" "}
            <a href={props.settingsHref}>instance settings</a> (Amazon SES).
          </div>
        ) : snapshot === null ? (
          <div role="alert" data-variant="warning" class="card mb-4" data-testid="sending-not-read">
            The SES account has not been read yet: there is no forecast and no quota guard until a
            read succeeds.
            {state.error === null ? null : (
              <>
                {" "}
                Last error: <span data-testid="snapshot-error">{state.error}</span>
              </>
            )}
          </div>
        ) : (
          <>
            <SnapshotCard state={state} snapshot={snapshot} />
            <GuardCard state={state} snapshot={snapshot} />
            {state.forecast ? <ForecastCard forecast={state.forecast} /> : null}
          </>
        )}
      </div>
    </section>
  );
}

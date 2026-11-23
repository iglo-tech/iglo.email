// Labels of a send and of a skipped step (B127), shared by the send log, a subscriber's sends tab
// and an enrollment's timeline, so one status and one reason read the same on every screen.
import { i18n } from '@/assets/admin/js/main.js';
import { subjectKey } from '@/assets/admin/js/send-subject.js';
import * as u from '@/assets/admin/js/utils.js';

export function statusText(status) {
  return i18n.t(`sends.status.${status}`);
}

export function sourceText(source) {
  return i18n.t(source === 'tx' ? 'sends.sourceTx' : 'sends.sourceSequence');
}

// A skip reason's words. A reason without a label shows as its code, never as a missing key.
export function skipLabel(reason) {
  const key = `skipReasons.${reason}`;
  const label = i18n.t(key);
  return label === key ? reason : label;
}

// The badge tone of a send's status: a skipped send is a warning, never a success. Neutral is null.
export function statusVariant(status) {
  if (status === 'sent') {
    return 'success';
  }
  if (status === 'skipped') {
    return 'warning';
  }
  if (status === 'failed' || status === 'unknown') {
    return 'danger';
  }
  return null;
}

// "(late)" beside a skipped status, or nothing when the send has no reason.
export function skipText(reason) {
  return reason ? `(${skipLabel(reason)})` : '';
}

// A send's subject, or the reason it has none (B127 r1): a skipped send was never prepared, a wiped
// one has no address, and a sent one past the thirty-day retention lost its message.
export function subjectText(send) {
  const key = subjectKey(send);
  if (key === null) {
    return send.subject;
  }
  return key === 'sends.subjectSkipped'
    ? i18n.ts(key, { reason: skipLabel(send.skip_reason) })
    : i18n.t(key);
}

// A sequence send's sequence and step, or nothing for a transactional send. The API's step_position counts
// from zero, as the timeline's position does, and the page counts from one. A step that no longer exists
// has no position (B117d): its send names the sequence alone.
export function sequenceStepText(send) {
  if (!send.sequence_name) {
    return '';
  }
  return send.step_position === null || send.step_position === undefined
    ? send.sequence_name
    : i18n.ts('sends.sequenceStep', { name: send.sequence_name, position: send.step_position + 1 });
}

// An enrollment's exit reason, named (B127): the event that exited it, with the time the exit was
// recorded when one is given, or the step condition that did, with its text when it is kept (B127 r2).
// Any other reason shows as stored.
export function exitText(reason, at = null, condition = null) {
  if (!reason) {
    return '';
  }
  if (reason === 'condition') {
    return condition
      ? i18n.ts('sequences.exit.conditionText', { condition })
      : i18n.t('sequences.exit.condition');
  }
  if (reason.startsWith('event:')) {
    const name = reason.slice('event:'.length);
    return at
      ? i18n.ts('sequences.exit.eventAt', { name, at: u.niceDate(at, true) })
      : i18n.ts('sequences.exit.event', { name });
  }
  return reason;
}

// The "Sequence / template" column (B127): a sequence send's sequence and step, else the name of the
// template a transactional send used. A template that was deleted has no name, so it shows a dash.
export function sequenceOrTemplateText(send) {
  return send.sequence_name ? sequenceStepText(send) : send.template_name || '-';
}

// The "Sent" column (B127 r2): when the send went out, or a dash for a send that did not (skipped,
// failed, queued). A send's creation time is never shown under "Sent".
export function sentText(send) {
  return send.sent_at ? u.niceDate(send.sent_at, true) : '—';
}

// Labels of a send and of a skipped step (B127), shared by the send log, a subscriber's sends tab
// and an enrollment's timeline, so one status and one reason read the same on every screen.
import { i18n } from '@/assets/admin/js/main.js';
import { subjectKey } from '@/assets/admin/js/send-subject.js';

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

// A sequence send's sequence and step, or nothing for a transactional send or a removed step. The
// API's step_position counts from zero, as the timeline's position does, and the page counts from one.
export function sequenceStepText(send) {
  return send.sequence_name
    ? i18n.ts('sends.sequenceStep', { name: send.sequence_name, position: send.step_position + 1 })
    : '';
}

// The "Sequence / template" column (B127): a sequence send's sequence and step, else the name of the
// template a transactional send used. A template that was deleted has no name, so it shows a dash.
export function sequenceOrTemplateText(send) {
  return send.sequence_name ? sequenceStepText(send) : send.template_name || '-';
}

// The words for a send row that has no subject (B127 r1). The API names the cause (sends.ts,
// subject_missing): a skipped send was never prepared, a wiped one has no address, and any other one
// lost its message to the thirty-day retention. This maps each cause to its translation key.
export function subjectKey(send) {
  switch (send.subject_missing) {
    case 'skipped':
      return send.skip_reason ? 'sends.subjectSkipped' : 'sends.subjectNotSent';
    case 'wiped':
      return 'sends.subjectWiped';
    case 'retention':
      return 'sends.subjectExpired';
    default:
      return null;
  }
}

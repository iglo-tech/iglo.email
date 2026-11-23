// B127: the subscriber's Events tab names what each event did (docs/design/05-sequences.md#admin-ui):
// the sequences it started and exited, and the sequence of each refused start (B116, D131) by name.
// The events store keeps the refused starts; the enrollments and sequences modules read their own
// tables for the rest. This module only joins one page of events to them.
import type { Enrollments } from "@/sequences/enrollments";
import type { SequenceStore } from "@/sequences/store";

/** One event of the page, as the events store projects it. */
export interface EventPageRow {
  id: number | object;
  name: string;
  created_at: string;
  skipped: Array<{ sequence_id: number | object; reason: string }>;
}
// An ID the page projects as a number, or as raw JSON past the safe integer range: both read back
// exactly through JSON, so the BigInt is the row's own ID.
const idOf = (id: unknown) => BigInt(JSON.stringify(id));

/** The page with each event's links: the enrollments it started and exited, and names for its refusals. */
export function linkEvents(
  page: { results: Array<EventPageRow>; total: number | object; page: number; per_page: number },
  subscriberId: bigint,
  enrollments: Pick<Enrollments, "eventLinks">,
  sequences: Pick<SequenceStore, "names">,
) {
  const events = page.results.map((row) => ({
    id: idOf(row.id),
    name: row.name,
    receivedAt: row.created_at,
  }));
  const links = enrollments.eventLinks(subscriberId, events);
  const names = sequences.names([
    ...new Set(page.results.flatMap((row) => row.skipped.map((skip) => idOf(skip.sequence_id)))),
  ]);
  return {
    ...page,
    results: page.results.map((row) => {
      const link = links.get(idOf(row.id));
      return {
        ...row,
        started: link?.started ?? [],
        exited: link?.exited ?? [],
        skipped: row.skipped.map((skip) => ({
          ...skip,
          sequence_name: names.get(idOf(skip.sequence_id)) ?? null,
        })),
      };
    }),
  };
}

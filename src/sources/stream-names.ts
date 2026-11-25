// Native (15-external-sources section 4, D171): the event names a project's stream subscribes to:
// an active sequence's trigger, an active or paused sequence's `exit_on` (read through the
// sequences store's `list`) and every `grant_lists` rule's event. A name in none of them is never
// received.
import type { Settings } from "@/settings/validate";
import { isSourceList, isSourceObject, member, sourceJson } from "@/sources/json";

/** What the names need of the sequences store (`createSequenceStore(...).list`). */
export interface SequenceLister {
  list(filter: { status: string; page: number; perPage: number }): {
    results: ReadonlyArray<{ trigger: unknown; exit_on: unknown }>;
  };
}

/** Sequences read per page while collecting names. */
const PAGE = 100;

/** The grant rules' event names. */
export function grantEventNames(settings: Settings): Array<string> {
  const rules = sourceJson(settings["source.grant_lists"]);
  const names: Array<string> = [];
  for (const rule of isSourceList(rules) ? rules : []) {
    const event = member(rule, "event");
    if (typeof event === "string" && event) {
      names.push(event);
    }
  }
  return names;
}

/** Every summary of the sequences with `status`, page by page. */
function* sequencesWith(sequences: SequenceLister, status: string) {
  for (let page = 1; ; page++) {
    const { results } = sequences.list({ status, page, perPage: PAGE });
    yield* results;
    if (results.length < PAGE) {
      return;
    }
  }
}

/** The names sequences use: active triggers, and active or paused `exit_on`. */
export function sequenceEventNames(sequences: SequenceLister): Array<string> {
  const names: Array<string> = [];
  for (const status of ["active", "paused"]) {
    for (const sequence of sequencesWith(sequences, status)) {
      const trigger = sourceJson(sequence.trigger);
      const event = isSourceObject(trigger) ? member(trigger, "event") : undefined;
      if (status === "active" && typeof event === "string") {
        names.push(event);
      }
      const exits = sourceJson(sequence.exit_on);
      for (const name of isSourceList(exits) ? exits : []) {
        if (typeof name === "string") {
          names.push(name);
        }
      }
    }
  }
  return names;
}

/** The subscribed names, sorted and unique, read now (each check and each connection). */
export function streamEventNames(
  sequences: SequenceLister,
  settings: () => Settings,
): () => Array<string> {
  return () => {
    const names = new Set([...sequenceEventNames(sequences), ...grantEventNames(settings())]);
    return [...names].filter(Boolean).sort();
  };
}

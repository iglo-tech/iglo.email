// The template data and render of one sequence step, shared by the scheduler's real sends and the
// preview and test-send routes, so a preview renders exactly what a send renders
// (docs/design/05-sequences.md#template-data, #preview-and-test-send, D105). No upstream source.
import { numberID } from "@/sequences/enrollments";
import type { MessageBudget, RenderTracking, TemplateRenderer } from "@/templates/renderer";

/** The subject of a test send, so a recipient cannot mistake it for a real one (D105). */
export const TEST_SUBJECT = "[Test] ";

/** What a step's template reads. JSON-valued fields are kept as the JSON text they are stored as. */
export interface StepData {
  subscriber: {
    id: bigint;
    uuid: string;
    email: string;
    name: string;
    external_id: string;
    /** JSON object text. */
    attribs: string;
  };
  trigger: { name: string; data: string; occurred_at: string } | null;
  sequence: { id: bigint; name: string };
  step: { id: bigint; uuid: string; position: number; kind: string };
  aggregates: Record<string, number>;
  /** Marketing steps only: a transactional mail carries no unsubscribe_url (D126, r2). */
  unsubscribe_url: string;
  /** The subscriber's manage link, for marketing and transactional steps alike (D126). */
  manage_url: string;
}

/** The JSON the template is rendered with, byte for byte what the scheduler has always sent. */
const id = (value: bigint) => JSON.stringify(numberID(value));
const text = (value: string) => JSON.stringify(value);
export function stepDataText(data: StepData): string {
  const {
    subscriber,
    trigger,
    sequence,
    step,
    unsubscribe_url: unsubscribe,
    manage_url: manage,
  } = data;
  return (
    `{"subscriber":{"id":${id(subscriber.id)},"uuid":${text(subscriber.uuid)},` +
    `"email":${text(subscriber.email)},"name":${text(subscriber.name)},` +
    `"external_id":${text(subscriber.external_id)},"attribs":${subscriber.attribs}},` +
    `"trigger":${
      trigger
        ? `{"name":${text(trigger.name)},"data":${trigger.data},"occurred_at":${text(trigger.occurred_at)}}`
        : "null"
    },` +
    `"sequence":{"id":${id(sequence.id)},"name":${text(sequence.name)}},` +
    `"step":{"id":${id(step.id)},"uuid":${text(step.uuid)},"position":${step.position},"kind":${text(step.kind)}},` +
    `"aggregates":${JSON.stringify(data.aggregates)},` +
    `"unsubscribe_url":${text(unsubscribe)},` +
    `"manage_url":${text(manage)}}`
  );
}

/** The compile input of a step's template: its subject wins over the template's (the caller picks). */
export function stepCompileInput(body: string, subject: string, marketing: boolean) {
  return { mode: "html" as const, transactional: !marketing, body, subject };
}

export type CompiledStep = ReturnType<TemplateRenderer["compile"]>;

/**
 * Renders a compiled step with its data. A subject with a line break or NUL is refused, as the
 * scheduler has always refused it. `tracking` is what a real send passes; a preview passes none.
 */
export function renderStep(
  compiled: CompiledStep,
  data: string,
  tracking?: RenderTracking,
  budget?: MessageBudget,
): { subject: string; body: string } {
  const rendered = compiled.renderSync(data, tracking, budget);
  if (/[\r\n\0]/.test(rendered.subject)) {
    throw new Error("Invalid subject");
  }
  return rendered;
}

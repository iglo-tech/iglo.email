// Comparison: listmonk models/templates.go, models/campaigns.go and
// internal/manager/message.go compile layout/body/subject before recipient rendering.
// This is a new synthetic Liquid fixture, not a Go-template port.
import { Liquid, type LiquidOptions, type Template } from "liquidjs";

export interface FixtureInput {
  mode?: "html" | "plain";
  body: string;
  layout?: string;
  data?: Record<string, unknown>;
  limit?: "small-parse" | "small-memory";
}
export function engine(mode: "html" | "plain", options: LiquidOptions = {}) {
  const liquid = new Liquid({
    ownPropertyOnly: true,
    // An empty in-memory mapping disables disk and network template resolution.
    templates: {},
    strictFilters: true,
    parseLimit: 64 * 1024,
    renderLimit: 1000,
    memoryLimit: 1_000_000,
    ...(mode === "html" ? { outputEscape: "escape" as const } : {}),
    ...options,
  });
  liquid.registerFilter("track_link", (url: string) => `${url}&fixture=1`);
  liquid.registerFilter("t", (key: string) => (key === "hello" ? "Hello" : key));
  return liquid;
}
export function compile(liquid: Liquid, body: string, layout?: string) {
  return {
    body: liquid.parse(body),
    layout: layout === undefined ? undefined : liquid.parse(layout),
  };
}
export function renderCompiled(
  liquid: Liquid,
  compiled: { body: Template[]; layout?: Template[] | undefined },
  data: Record<string, unknown>,
) {
  const body = String(liquid.renderSync(compiled.body, data));
  return compiled.layout
    ? String(liquid.renderSync(compiled.layout, { ...data, content: body }))
    : body;
}
export function render(input: FixtureInput) {
  const options =
    input.limit === "small-parse"
      ? { parseLimit: 128 }
      : input.limit === "small-memory"
        ? { memoryLimit: 20 }
        : {};
  const liquid = engine(input.mode ?? "html", options);
  return renderCompiled(liquid, compile(liquid, input.body, input.layout), input.data ?? {});
}

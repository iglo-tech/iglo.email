// Specification fixture only: this executable does not register production routes.
import { raw, render } from "@/jsx/render";
import { jsx } from "@/jsx/jsx-runtime";

const hostile = `<tag attr="x">&'`;
function Plain() {
  return `<img src=x onerror=alert(1)>`;
}
function Nested({ children }: { children: unknown }) {
  return <section>{children}</section>;
}
function Document() {
  return (
    <>
      <Nested>
        <p title={hostile}>{hostile}</p>
        <Plain />
        {["one", [2, false, null, undefined, <b>three</b>]]}
        <input disabled={true} hidden={false} data-active={false} aria-checked={false} />
        <br />
      </Nested>
      {raw("<em>trusted</em>")}
    </>
  );
}
const invalid: Record<string, () => unknown> = {
  tag: () => jsx("bad tag", {}),
  attribute: () => jsx("p", { "bad attribute": "x" }),
  "object-child": () => jsx("p", { children: { html: "<b>fake</b>" } }),
  "forged-raw": () =>
    jsx("p", { children: Object.create(Object.getPrototypeOf(raw("<b>trusted</b>"))) }),
  "forged-node": () => Object.create(Object.getPrototypeOf(jsx("b", { children: "trusted" }))),
  "object-attribute": () => jsx("p", { title: { html: "<b>fake</b>" } }),
  "raw-attribute": () => jsx("p", { title: raw('<b>"') }),
  "event-handler": () => jsx("button", { onClick: () => {} }),
  "void-child": () => jsx("input", { children: "bad" }),
};
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const key = new URL(request.url).pathname.slice(1);
    try {
      const result = key === "document" ? <Document /> : invalid[key]?.();
      if (result === undefined) return new Response("missing", { status: 404 });
      return new Response(render(result), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    } catch {
      return new Response("rejected", { status: 400 });
    }
  },
});
process.stdout.write(`http://127.0.0.1:${server.port}\n`);
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.once(signal, () => {
    void server.stop(true);
  });

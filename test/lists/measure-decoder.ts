// Bounded synthetic compiled HTTP decoder observations; no production data.
import { resolve } from "node:path";
import { provisionApiUser, withProduction } from "@/test/contract/owned";

const admin = {
  user: "m15-xml-measure-admin",
  password: "m15-xml-measure-password",
};
for (let repetition = 1; repetition <= 3; repetition++) {
  await withProduction(
    resolve(process.argv[2] ?? "dist/iglo.email"),
    AbortSignal.timeout(120_000),
    async (origin) => {
      const credentials = await provisionApiUser(origin, admin);
      const headers = {
        Authorization: `Basic ${btoa(`${credentials.user}:${credentials.token}`)}`,
        "Content-Type": "application/xml",
      };
      const valid: number[] = [],
        rejected: number[] = [];
      for (let i = 0; i < 55; i++) {
        let start = performance.now();
        const created = await fetch(`${origin}/api/lists`, {
          method: "POST",
          headers,
          body: `<List><Name>xml-measure-${i}</Name><Tags>one two</Tags><Description>value &amp; &#65;</Description></List>`,
        });
        const data = (await created.json()) as { data: { id: number } };
        if (created.status !== 200) throw new Error("valid XML rejected");
        if (i >= 5) valid.push(performance.now() - start);
        const deleted = await fetch(`${origin}/api/lists/${data.data.id}`, {
          method: "DELETE",
          headers,
        });
        if (deleted.status !== 200) throw new Error("cleanup failed");
        start = performance.now();
        const denied = await fetch(`${origin}/api/lists`, {
          method: "POST",
          headers,
          body: `<!DOCTYPE List [<!ENTITY x "${"a".repeat(4096)}">]><List><Name>&x;</Name></List>`,
        });
        await denied.arrayBuffer();
        if (denied.status !== 400) throw new Error("declaration accepted");
        if (i >= 5) rejected.push(performance.now() - start);
      }
      const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
      process.stdout.write(
        `${JSON.stringify({ repetition, warmup: 5, samples: 50, validXmlCreateMs: mean(valid), rejectedDeclarationMs: mean(rejected) })}\n`,
      );
    },
    admin,
    120_000,
  );
}

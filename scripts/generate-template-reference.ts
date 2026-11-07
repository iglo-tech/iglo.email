import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export async function generateTemplateReference() {
  const root = resolve(import.meta.dir, "..");
  const docPath = join(root, "docs/design/06-templates.md");
  const targetPath = join(root, "src/mcp/reference.ts");

  const content = await readFile(docPath, "utf8");

  // Extract the section for agents (variables, tags, filters, examples)
  const startMarker = "### Template reference for agents";
  const endMarker = "### Internal renderer implementation notes";

  const startIndex = content.indexOf(startMarker);
  const endIndex = content.indexOf(endMarker);

  if (startIndex === -1 || endIndex === -1) {
    throw new Error(`Failed to find markers in ${docPath}`);
  }

  const docSection = content.slice(startIndex, endIndex).trim();
  const fullReference = `${docSection}\n`;

  const tsSource = `// Generated from docs/design/06-templates.md by scripts/generate-template-reference.ts. Do not hand-edit.\nexport const TEMPLATE_REFERENCE = ${JSON.stringify(fullReference)};\n`;

  await writeFile(targetPath, tsSource, "utf8");

  // Format the generated file so bun run format:check is clean
  const oxfmt = Bun.which("oxfmt") || join(root, "node_modules/.bin/oxfmt");
  Bun.spawnSync([oxfmt, targetPath], { cwd: root });

  console.log(`Generated ${targetPath}`);
}

if (import.meta.main) {
  await generateTemplateReference();
}

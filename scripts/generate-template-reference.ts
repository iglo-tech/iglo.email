import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export async function generateTemplateReference() {
  const root = resolve(import.meta.dir, "..");
  const docPath = join(root, "docs/design/06-templates.md");
  const targetPath = join(root, "src/mcp/reference.ts");

  const content = await readFile(docPath, "utf8");

  // Extract the section from "### Current M1.8 branch subset" to "### Built-in templates"
  const startMarker = "### Current M1.8 branch subset";
  const endMarker = "### Built-in templates";

  const startIndex = content.indexOf(startMarker);
  const endIndex = content.indexOf(endMarker);

  if (startIndex === -1 || endIndex === -1) {
    throw new Error(`Failed to find markers in ${docPath}`);
  }

  const docSection = content.slice(startIndex, endIndex).trim();

  const campaignExample = `### Example: Campaign Template (Layout)
\`\`\`html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>{{ campaign.subject }}</title>
</head>
<body>
  <header>
    <h1>{{ campaign.name }}</h1>
  </header>
  <main>
    {{ content | raw }}
  </main>
  <footer>
    <p><a href="{{ unsubscribe_url }}">Unsubscribe</a> | <a href="{{ manage_url }}">Manage preferences</a></p>
    {{ track_view }}
  </footer>
</body>
</html>
\`\`\``;

  const txExample = `### Example: Transactional (tx) Template
\`\`\`html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Order Confirmation #{{ data.order_id }}</title>
</head>
<body>
  <h2>Hello {{ subscriber.name | default: "Valued Customer" }},</h2>
  <p>Thank you for your order #{{ data.order_id }}.</p>
  {% if data.items %}
  <ul>
    {% for item in data.items %}
    <li>{{ item.name }} - \${{ item.price }}</li>
    {% endfor %}
  </ul>
  {% endif %}
  <p>Track your package: <a href="{{ data.tracking_url | track_link }}">Track Order</a></p>
</body>
</html>
\`\`\``;

  const fullReference = `${docSection}\n\n${campaignExample}\n\n${txExample}\n`;

  const tsSource = `// Generated from docs/design/06-templates.md by scripts/generate-template-reference.ts. Do not hand-edit.
export const TEMPLATE_REFERENCE = ${JSON.stringify(fullReference)};
`;

  await writeFile(targetPath, tsSource, "utf8");
  console.log(`Generated ${targetPath}`);
}

if (import.meta.main) {
  await generateTemplateReference();
}

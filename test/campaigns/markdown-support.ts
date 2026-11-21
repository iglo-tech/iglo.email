// B104 helpers shared by the Markdown preview tests and the served campaigns fixture
// (markdown-serve.ts). Errors are thrown, not asserted, so the served fixture can import this too.
import type { CampaignsFixture } from "@/test/campaigns/fixture";

/**
 * A password user with the given user permissions and list grants (built as the contract suite
 * builds list-scoped accounts), returning the session headers for requests as that user.
 */
export async function readerSession(
  f: CampaignsFixture,
  name: string,
  permissions: Array<string>,
  lists: Array<{ id: number; permissions: string[] }>,
): Promise<Record<string, string>> {
  const role = await f.json("/api/roles/users", "POST", { name, permissions });
  if (role.status !== 200) {
    throw new Error(`role ${role.status}`);
  }
  const listRole = await f.json("/api/roles/lists", "POST", { name: `${name}-lists`, lists });
  if (listRole.status !== 200) {
    throw new Error(`list role ${listRole.status}`);
  }
  const created = await f.json("/api/users", "POST", {
    username: name,
    email: `${name}@fixture.test`,
    name,
    type: "user",
    status: "enabled",
    password_login: true,
    password: "reader-password-1",
    password2: "reader-password-1",
    user_role_id: role.body.data.id,
    list_role_id: listRole.body.data.id,
  });
  if (created.status !== 200) {
    throw new Error(`user ${created.status}`);
  }
  const session = await f.owners.auth.login(name, "reader-password-1");
  if (!session || !("id" in session)) {
    throw new Error("reader login failed");
  }
  return { cookie: `session=${session.id}`, "x-csrf-token": session.csrf };
}

/** `unit` repeated to exactly `bytes` characters. */
export const repeat = (unit: string, bytes: number) =>
  unit.repeat(Math.ceil(bytes / unit.length)).slice(0, bytes);

/** The form body the editor posts for a Markdown preview. */
export const previewForm = (body: string) =>
  new URLSearchParams({ content_type: "markdown", body }).toString();

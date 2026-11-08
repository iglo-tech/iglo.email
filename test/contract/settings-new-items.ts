// Native (B51): a new SMTP server or bounce mailbox never takes another item's password. Upstream
// copies a stored password into any new item whose uuid is blank, so this runs against the compiled
// production executable only (mode "normal"); the reference run skips it.
import type { Credentials, Mode } from "@/test/contract/types";
import { withBlankPasswords } from "@/test/contract/settings-candidate";
import { settingsFetch } from "@/test/contract/settings-reference-fetch";

export async function runSettingsNewItems(target: {
  mode: Mode;
  baseUrl: string;
  credentials: Credentials;
}) {
  if (target.mode !== "normal") return;
  const auth = `Basic ${btoa(`${target.credentials.user}:${target.credentials.token}`)}`;
  const request = (path: string, method = "GET", value?: unknown) =>
    settingsFetch(
      target.baseUrl + path,
      {
        method,
        headers: { Authorization: auth, "Content-Type": "application/json" },
        ...(value === undefined ? {} : { body: JSON.stringify(value) }),
      },
      false,
    );
  function check(value: unknown, label: string): asserts value {
    if (!value) throw new Error(`FAIL settings-new-items-${label}`);
  }
  async function read() {
    const response = await request("/api/settings");
    check(response.status === 200, "read");
    return (await response.json()).data as Record<string, any>;
  }
  const before = await read();
  const body = withBlankPasswords(before);
  body.smtp.push({
    ...body.smtp[0],
    uuid: "",
    name: "b51-contract",
    host: "b51-contract.example.invalid",
    password: "",
    enabled: false,
    from_addresses: [],
  });
  body["bounce.mailboxes"].push({
    ...body["bounce.mailboxes"][0],
    uuid: "",
    host: "b51-contract-bounce.example.invalid",
    password: "",
    return_path: "bounces@b51.example.invalid",
  });
  check((await request("/api/settings", "PUT", body)).status === 200, "save");

  const after = await read();
  const server = after.smtp.find(
    (item: { host: string }) => item.host === "b51-contract.example.invalid",
  );
  const box = after["bounce.mailboxes"].find(
    (item: { host: string }) => item.host === "b51-contract-bounce.example.invalid",
  );
  check(server && server.password === undefined, "smtp-no-inherit");
  check(box && box.password === undefined, "bounce-no-inherit");

  // Put the configuration back as it was read, so later cases see the same settings.
  check(
    (await request("/api/settings", "PUT", withBlankPasswords(before))).status === 200,
    "restore",
  );
}

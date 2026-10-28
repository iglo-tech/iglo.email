// Public API client for one invocation's synthetic Mailpit messages only.
import assert from "node:assert/strict";
import type { CapturedMessage } from "@/test/perf/runtime-compat/smtp-expect";
import type { ReferenceMailpit } from "@/test/perf/runtime-compat/smtp-env";

export interface Summary {
  ID: string;
  MessageID: string;
  Subject: string;
}
export class Mailpit {
  constructor(
    private readonly reference: ReferenceMailpit,
    readonly marker: string,
  ) {
    if (!/^m08[a-f0-9]{16,80}$/.test(marker)) throw new Error("Invalid owned message marker");
  }
  private async request(path: string, init: RequestInit = {}) {
    const response = await fetch(`${this.reference.api}${path}`, {
      ...init,
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Mailpit ${path.split("?")[0]} returned ${response.status}`);
    return response;
  }
  async list() {
    const found: Summary[] = [];
    for (let start = 0; ; start += 100) {
      const query = new URLSearchParams({
        query: `subject:${this.marker}`,
        start: String(start),
        limit: "100",
      });
      const result = (await (await this.request(`/api/v1/search?${query}`)).json()) as {
        messages: Summary[] | null;
        messages_count: number;
      };
      const messages = result.messages ?? [];
      for (const message of messages) {
        assert.ok(
          message.Subject.startsWith(this.marker),
          "search returned a message outside this invocation",
        );
        found.push(message);
      }
      if (found.length >= result.messages_count || messages.length === 0) break;
    }
    return found;
  }
  async message(id: string) {
    return (await (
      await this.request(`/api/v1/message/${encodeURIComponent(id)}`)
    ).json()) as CapturedMessage;
  }
  async raw(id: string) {
    return await (await this.request(`/api/v1/message/${encodeURIComponent(id)}/raw`)).text();
  }
  async part(id: string, part: string) {
    return Buffer.from(
      await (
        await this.request(
          `/api/v1/message/${encodeURIComponent(id)}/part/${encodeURIComponent(part)}`,
        )
      ).arrayBuffer(),
    );
  }
  async removeOwned() {
    const messages = await this.list();
    for (let offset = 0; offset < messages.length; offset += 100) {
      const ids = messages.slice(offset, offset + 100).map((message) => message.ID);
      if (!ids.length) continue;
      await this.request("/api/v1/messages", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ IDs: ids }),
      });
    }
    return messages.length;
  }
}

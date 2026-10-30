// Adapted from listmonk internal/core/media.go and queries/media.sql at 6fcd95f. The database
// side of media; files are in src/media/filesystem.ts and neither calls the other.
import type { Database } from "bun:sqlite";
import { lowercaseGlob } from "@/campaigns/search";
import type { Clock } from "@/clock";
import { prepareNamedQueries } from "@/db/queries";
import sql from "@/media/store.sql" with { type: "text" };

export interface MediaRow {
  id: bigint;
  uuid: string;
  provider: string;
  filename: string;
  content_type: string;
  thumb: string;
  meta: string;
  created_at: string;
}

export function createMediaStore(db: Database, clock: Clock) {
  const q = prepareNamedQueries(db, [{ name: "media/store", sql }]);
  return {
    insert(input: {
      filename: string;
      thumb: string;
      contentType: string;
      provider: string;
      meta: object;
    }): MediaRow {
      return q
        .get("insert-media")
        .get(
          crypto.randomUUID(),
          input.filename,
          input.thumb,
          input.contentType,
          input.provider,
          JSON.stringify(input.meta),
          clock.now().toISOString(),
        ) as MediaRow;
    },
    /** `limit` 0 is no limit. */
    query(provider: string, search: string, offset: number, limit: number) {
      const rows = q
        .get("query-media")
        .all(provider, lowercaseGlob(search), limit || -1, offset) as (MediaRow & {
        total: bigint;
      })[];
      return { results: rows, total: Number(rows[0]?.total ?? 0) };
    },
    get(id: bigint | number): MediaRow | null {
      return q.get("get-media").get(id) as MediaRow | null;
    },
    /** The row of a stored file; a name without one is not a file of this application. */
    byFilename(filename: string): MediaRow | null {
      return q.get("get-media-by-filename").get(filename) as MediaRow | null;
    },
    any(): boolean {
      return q.get("any-media").get() !== null;
    },
    filename(id: bigint | number): string | null {
      return (q.get("get-media").get(id) as MediaRow | null)?.filename ?? null;
    },
    filenameTaken(filename: string): boolean {
      return q.get("media-filename-exists").get(filename) !== null;
    },
    /** The removed row; campaign_media keeps its filename and loses the ID (ON DELETE SET NULL). */
    delete(id: bigint | number): MediaRow | null {
      return q.get("delete-media").get(id) as MediaRow | null;
    },
    close(): void {
      q.close();
    },
  };
}
export type MediaStore = ReturnType<typeof createMediaStore>;

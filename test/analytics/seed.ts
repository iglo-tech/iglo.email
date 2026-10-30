// Generated database for docs/perf/M3.3-analytics.md: subscribers, memberships, campaigns,
// views, clicks, bounces and sends, inserted by SQL in one transaction. The subscriber FTS
// triggers are dropped in this throwaway file only: no measured query reads the index.
import type { Database } from "bun:sqlite";

export interface SeedSize {
  subscribers: number;
  views: number;
  clicks: number;
  /** Extra views and clicks belonging to transactional and sequence sends. */
  sends: number;
  /** Put every campaign event on the six newest campaigns, all finished: the dashboard card. */
  recentLarge?: boolean;
}
const now = Date.parse("2026-10-30T12:00:00.000Z");
const series = (count: number) =>
  `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${count})`;
/** Rows spread evenly over the last 365 days, so a 30-day chart reads about 8% of them. */
const at = (i: string, count: number) =>
  `strftime('%Y-%m-%dT%H:%M:%fZ', ${now / 1000 - 31_536_000} + (${i} * 31536000.0 / ${count}), 'unixepoch')`;

export function seed(db: Database, size: SeedSize) {
  const campaigns = 100;
  const lists = 20;
  const newestSix = `${campaigns - 5} + i % 6`;
  const owner = size.recentLarge
    ? newestSix
    : `CASE WHEN i % 2 = 0 THEN 90 ELSE 1 + i % ${campaigns} END`;
  db.run("DROP TRIGGER subscribers_fts_insert");
  db.run("PRAGMA synchronous = OFF");
  db.transaction(() => {
    db.run(`${series(lists)} INSERT INTO lists (id, uuid, name, type, optin)
      SELECT i, 'list-' || i, 'List ' || i, CASE i % 2 WHEN 0 THEN 'public' ELSE 'private' END,
        CASE i % 4 WHEN 0 THEN 'double' ELSE 'single' END FROM n`);
    db.run(`${series(size.subscribers)} INSERT INTO subscribers (id, uuid, email, name, status, created_at, updated_at)
      SELECT i, 'sub-' || i, 'user' || i || '@example.test', 'User ' || i,
        CASE WHEN i % 50 = 0 THEN 'blocklisted' ELSE 'enabled' END,
        ${at("i", size.subscribers)}, ${at("i", size.subscribers)} FROM n`);
    // Most subscribers are on one list, 40% on a second, and 2% on none.
    db.run(`${series(size.subscribers)} INSERT INTO subscriber_lists (subscriber_id, list_id, status, created_at, updated_at)
      SELECT i, 1 + i % ${lists}, CASE WHEN i % 10 = 0 THEN 'unsubscribed' ELSE 'confirmed' END,
        ${at("i", size.subscribers)}, ${at("i", size.subscribers)} FROM n WHERE i % 50 != 1`);
    db.run(`${series(size.subscribers)} INSERT INTO subscriber_lists (subscriber_id, list_id, status, created_at, updated_at)
      SELECT i, 1 + (i + 7) % ${lists}, 'confirmed', ${at("i", size.subscribers)}, ${at("i", size.subscribers)}
      FROM n WHERE i % 5 < 2 AND i % 50 != 1`);
    db.run(`${series(campaigns)} INSERT INTO campaigns (id, uuid, name, subject, from_email, body, messenger, status, sent, created_at, updated_at)
      SELECT i, 'camp-' || i, 'Campaign ' || i, 's', 'a@example.test', 'b', 'email',
        CASE WHEN i > ${size.recentLarge ? campaigns : 90} THEN 'draft' ELSE 'finished' END, ${size.subscribers} / 2, ${at("i", campaigns)}, ${at("i", campaigns)} FROM n`);
    db.run(`${series(campaigns)} INSERT INTO campaign_lists (campaign_id, list_id, list_name)
      SELECT i, 1 + i % ${lists}, 'List' FROM n`);
    db.run(
      `${series(50)} INSERT INTO links (id, uuid, url) SELECT i, 'link-' || i, 'https://example.test/' || i FROM n`,
    );
    // Half of all rows are on campaign 90, the realistic worst case of one big send.
    db.run(`${series(size.views)} INSERT INTO campaign_views (campaign_id, subscriber_id, created_at)
      SELECT ${owner}, 1 + (i * 7) % ${size.subscribers},
        ${at("i", size.views)} FROM n`);
    db.run(`${series(size.clicks)} INSERT INTO link_clicks (campaign_id, link_id, subscriber_id, created_at)
      SELECT ${owner}, 1 + i % 50, 1 + (i * 11) % ${size.subscribers},
        ${at("i", size.clicks)} FROM n`);
    db.run(`${series(10_000)} INSERT INTO bounces (subscriber_id, campaign_id, created_at)
      SELECT 1 + (i * 13) % ${size.subscribers}, ${size.recentLarge ? newestSix : 90}, ${at("i", 10_000)} FROM n`);
    if (size.sends) {
      db.run(`INSERT INTO templates (id, name, type, subject, body) VALUES
        (1, 'One', 'tx', 's', 'b'), (2, 'Two', 'tx', 's', 'b'), (3, 'Three', 'tx', 's', 'b')`);
      db.run(`${series(size.sends)} INSERT INTO sends (id, uuid, source, kind, subscriber_id, to_email, template_id, status, created_at, sent_at)
        SELECT i, 'send-' || i, 'tx', 'transactional', 1 + i % ${size.subscribers}, 'a@example.test', 1 + i % 3, 'sent', ${at("i", size.sends)}, ${at("i", size.sends)} FROM n`);
      db.run(
        `${series(size.sends)} INSERT INTO campaign_views (send_id, created_at) SELECT i, ${at("i", size.sends)} FROM n`,
      );
      db.run(
        `${series(size.sends)} INSERT INTO link_clicks (send_id, link_id, created_at) SELECT i, 1 + i % 50, ${at("i", size.sends)} FROM n WHERE i % 2 = 0`,
      );
    }
  })();
  db.run("PRAGMA synchronous = FULL");
}

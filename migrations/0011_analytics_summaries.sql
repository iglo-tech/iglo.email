-- M3.3: the rows behind app.cache_slow_queries, replacing listmonk's mat_dashboard_counts,
-- mat_dashboard_charts and mat_list_subscriber_stats. One row per view: nothing reads inside
-- `data`, and a refresh replaces all of them in one short transaction.
CREATE TABLE analytics_summaries (
  name TEXT PRIMARY KEY CHECK (name IN ('dashboard_counts', 'dashboard_charts', 'list_stats')),
  data TEXT NOT NULL CHECK (json_valid(data)),
  updated_at TEXT NOT NULL
) WITHOUT ROWID;

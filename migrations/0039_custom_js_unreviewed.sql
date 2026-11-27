-- B172 (D201, round 2): public custom JavaScript stored before this release may have been written
-- by a project user with `settings:manage`. It runs on the project's own origin, where a same-origin
-- window can read the sign-in page the instance admin types into, so a non-empty stored script is
-- marked unreviewed and `/public/custom.js` serves the empty script on every host until the instance
-- admin saves it through `PUT /api/instance/projects/:slug/appearance`. The mark is a settings row
-- that `defaults` does not name, like `restore.hold`, so the settings API neither shows nor writes
-- it. Owned by src/settings (src/settings/custom-js.ts).
INSERT OR IGNORE INTO settings (key, value)
SELECT 'appearance.public.custom_js_unreviewed', 'true'
FROM settings
WHERE key = 'appearance.public.custom_js' AND value NOT IN ('""', 'null', '');

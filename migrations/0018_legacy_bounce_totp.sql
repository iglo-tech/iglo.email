-- B24 (D84): data an older build accepted. A stored bounce rule with count 0 recorded no bounce
-- row and fired its action on every bounce; the count is at least 1 now. Rules that carry no
-- action (the empty "*" default) are left alone. A TOTP key of an API user or a user with password
-- login off could not be used and could return when the account changed back; clear it.
-- A rule that is not a JSON object (a hand edit) is kept as it is: json_each hands a string back as
-- bare text, so only an element of type 'object' is read as JSON.
UPDATE settings SET value = (
  SELECT json_group_object(
    key,
    CASE type
      WHEN 'object' THEN
        CASE WHEN json_type(value, '$.count') IN ('integer', 'real')
                  AND json_extract(value, '$.count') = 0
                  AND json_extract(value, '$.action') IN ('none', 'unsubscribe', 'blocklist', 'delete')
             THEN json_set(value, '$.count', 1)
             ELSE json(value) END
      WHEN 'text' THEN json_quote(value)
      WHEN 'true' THEN json('true')
      WHEN 'false' THEN json('false')
      ELSE json(value) END)
  FROM json_each(settings.value))
WHERE key = 'bounce.actions' AND json_type(value) = 'object';

UPDATE users SET twofa_type = 'none', twofa_key = NULL
  WHERE (type = 'api' OR password_login = 0) AND (twofa_type <> 'none' OR twofa_key IS NOT NULL);

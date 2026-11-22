-- B132 (D130): a rotated webhook secret keeps signing until `previous_secret_until`. The previous
-- secret is stored the way the current one is, in the same column format. A rotation without an
-- overlap stores neither column. The retention pass clears both once the window has ended; signing
-- also stops at the window's end by the injected clock, so the pass only removes what is already dead.
ALTER TABLE webhooks ADD COLUMN previous_secret TEXT;
ALTER TABLE webhooks ADD COLUMN previous_secret_until TEXT;

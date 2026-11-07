-- B35 (D89): Amazon SES is the only provider. Drop the stored Mailgun webhook signing key
-- so a database upgraded from an older build does not leave an orphaned secret.
DELETE FROM settings WHERE key = 'bounce.mailgun';

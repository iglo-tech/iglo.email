# Backup test credentials

Synthetic values used only by the local backup tests and measurement. They do not identify a
real account and never leave the test process.

```dotenv
IGLO_EMAIL_ADMIN_USER=backup-test-admin
IGLO_EMAIL_ADMIN_PASSWORD=backup-test-password
```

The password `a-new-password-of-the-operator` in `hold.test.ts` is generated for the
`reset-password` test, and so is the TOTP key seeded there. Neither is a real credential.

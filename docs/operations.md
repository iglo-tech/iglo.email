# Operations guide

How to run iglo.email in production. The commands here were run on 2026-10-31 on Debian 13, with
a build of this branch, synthetic data and paths under a temporary directory in place of
`/usr/local/bin`, `/var/lib` and `/var/backups`. What was not run is listed under
[Unverified](#unverified). The account, ownership and restore commands ran as written, as root in a
throwaway user and mount namespace, so `/etc`, `/var/lib` and `/var/backups` there were temporary
copies.

## Install

Each release on [GitHub](https://github.com/iglo-tech/iglo.email/releases) has one Linux x86-64
executable, `SHA256SUMS`, `LICENSE` and `THIRD-PARTY-NOTICES.txt`. The server needs glibc and an
x86-64 CPU with SSE4.2 (Nehalem or newer, as Bun 1.4.4 targets), and neither Bun nor a checkout. Download the four files of the version you
want into an empty directory, then:

```sh
sha256sum --check --strict SHA256SUMS
install -m 0755 iglo.email-linux-x64 /usr/local/bin/iglo.email
iglo.email --version
```

To build it yourself instead, on a machine with Bun 1.4 or newer:

```sh
bun install --frozen-lockfile
bun run build
install -m 0755 dist/iglo.email /usr/local/bin/iglo.email
```

Create the service account, and the data and backup directories it owns, closed to everyone else.
Run this as root:

```sh
groupadd --system iglo-email
useradd --system --gid iglo-email --home-dir /var/lib/iglo.email --shell /usr/sbin/nologin iglo-email
install -d -o iglo-email -g iglo-email -m 0700 /var/lib/iglo.email /var/backups/iglo.email
install -d -o root -g iglo-email -m 0750 /etc/iglo.email
```

Run every `iglo.email` command below as that account, so what it creates keeps that owner:

```sh
runuser -u iglo-email -- iglo.email backup --help
```

The first start creates the first administrator from `IGLO_EMAIL_ADMIN_USER` and
`IGLO_EMAIL_ADMIN_PASSWORD`. They are read only while no users exist, and there is no public
first-account form. Without them `/health` works and login is denied.

A systemd unit (`systemd-analyze verify` accepts it; it was not run as a service):

```ini
[Unit]
Description=iglo.email
After=network-online.target
Wants=network-online.target

[Service]
User=iglo-email
Environment=IGLO_EMAIL_DATA_DIR=/var/lib/iglo.email
Environment=IGLO_EMAIL_ROOT_URL=https://news.example.com
EnvironmentFile=-/etc/iglo.email/env
ExecStart=/usr/local/bin/iglo.email serve
Restart=on-failure
RestartSec=5
UMask=0077

[Install]
WantedBy=multi-user.target
```

Put the two admin variables in `/etc/iglo.email/env`, owned by root, mode 0640, group `iglo-email`,
and remove them after the first start. systemd reads this file as root; a shell run as the account
needs the group.

One server runs per data directory, because the sending loops depend on it: two servers on one
directory could send a message twice. A second one [refuses to start](#one-process-per-data-directory).
A backup, and the helpers the server starts itself, are read-only and do not count.

## Environment variables

| Flag | Variable | Default |
|---|---|---|
| `--port` | `IGLO_EMAIL_PORT` | `9000` |
| `--host` | `IGLO_EMAIL_HOST` | `127.0.0.1` |
| `--data-dir` | `IGLO_EMAIL_DATA_DIR` | `./data` |
| `--root-url` | `IGLO_EMAIL_ROOT_URL` | `http://<host>:<port>` |
| | `IGLO_EMAIL_ADMIN_USER` | none |
| | `IGLO_EMAIL_ADMIN_PASSWORD` | none |

Flags win over variables. The root URL goes into every link in every email: set it to the public
URL. It is the one setting that needs a restart. Everything else is in the admin UI under
Settings, or `PUT /api/settings`, and applies at once.

## Data directory

```text
/var/lib/iglo.email/
  iglo-email.db         the database, with -wal and -shm while it is open
  iglo-email.lock       the instance lock; holds no data and stays after the server stops
  uploads/              media files
  backups/              pre-migration snapshots, and backups with no --output
  .iglo-email-import/   the file of a running import
```

The database holds SMTP passwords, API tokens, password hashes, webhook secrets, the Mailgun key
and subscriber data, stored as given. Protect the directory with the host's permissions and disk
encryption. Never copy `iglo-email.db` of a running server by hand: use `backup`.

### One process per data directory

The server takes a lock on the data directory before it opens the database. While it is held,
a second server exits nonzero with this one line and touches nothing:

```text
/var/lib/iglo.email is in use by another iglo.email process: stop it first
```

The operating system frees the lock when the process ends, also on `kill -9` or a crash, so a
restart needs no cleanup. `iglo-email.lock` staying behind is normal, and a backup does not include
it. Its content does not matter. Do not delete it while a server runs: a process started after
that would get a lock of its own.

| Command | Beside a running server |
|---|---|
| `serve` | Refuses |
| `reset-password` | Refuses |
| `backup --release-hold` | Refuses |
| `backup` | Runs: it only reads the database |
| `backup --verify` | Runs: it reads a backup, not the data directory |
| `--help`, `--version` | Run: they do not use the data directory |

The two commands that refuse also take the lock while they work, so a server started in that moment
refuses too, with the same error. They also refuse while anything else has the database open, such
as a running `backup`.

Run commands as the service user, as this guide does. A lock file first created by root is one the
service cannot write, and the server then stops with `Cannot lock` and that path; `chown` it to the
service user.

**This needs a local filesystem.** The lock is a POSIX file lock. On NFS, SMB and other shared
filesystems it may not reach other hosts or work at all, so two servers on two machines could both
start. SQLite's WAL mode, which the database uses, needs one host in any case. Keep the data
directory on a local disk; a mounted upload directory inside it is fine.

## Reverse proxy and TLS

iglo.email serves plain HTTP. Keep it on `127.0.0.1` and terminate TLS in a reverse proxy. An
example for nginx, not run here:

```nginx
server {
    listen 443 ssl;
    server_name news.example.com;
    ssl_certificate     /etc/letsencrypt/live/news.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/news.example.com/privkey.pem;
    client_max_body_size 64m;

    location / {
        proxy_pass http://127.0.0.1:9000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

Behind a proxy every visitor arrives from the proxy's address, so one client's rate limit would
stop all of them. List the proxy in `security.trusted_proxies` ([D60](design/09-decisions.md#d60-explicit-trusted-proxies-for-client-addresses)).
It is empty by default, and `X-Forwarded-For` is ignored until it is set. It takes IPs or CIDRs and
refuses a zero prefix. In Settings > Security, or:

```sh
curl -fsS -u "$API" -X PUT -H 'content-type: application/json' \
  -d '["127.0.0.1"]' http://127.0.0.1:9000/api/settings/security.trusted_proxies
```

`API` is `username:token` of an API user, created under Users. Public rate limits, login limits
and `privacy.record_optin_ip` all use the address found this way.

## SMTP and DKIM

Set SMTP servers in Settings > SMTP, then send a test from there. The defaults are placeholders.
Most providers sign for you. To sign here, add `dkim` to a server. The admin UI keeps it but does
not show it, so this goes through the API. A masked password sent back unchanged is kept.

The private key passes through two files. Keep them in a private directory, created under a
restrictive umask before either exists, and removed even if a command fails. Run this in a
subshell so the umask and trap end with it:

```sh
(
umask 077
staging="$(mktemp -d)"
trap 'rm -rf "$staging"' EXIT
set -e
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$staging/dkim.pem"
openssl pkey -in "$staging/dkim.pem" -pubout -outform DER | openssl base64 -A
echo
curl -fsS -u "$API" http://127.0.0.1:9000/api/settings -o "$staging/settings.json"
python3 - "$staging/settings.json" "$staging/dkim.pem" example.com mail <<'PY'
import json, sys
path, key, domain, selector = sys.argv[1:]
settings = json.load(open(path))["data"]
settings["smtp"][0]["dkim"] = {
    "domain_name": domain,
    "key_selector": selector,
    "private_key": open(key).read(),
}
json.dump(settings, open(path, "w"))
PY
curl -fsS -u "$API" -X PUT -H 'content-type: application/json' \
  -d @"$staging/settings.json" http://127.0.0.1:9000/api/settings
)
```

It prints the public key for the DNS record
`mail._domainkey.example.com TXT "v=DKIM1; k=rsa; p=<key>"`. The trap removes the staging directory
on success and on failure: the key now lives in the database. Exposing `$API` on a command line
shows it to local process listings, so keep that token to a host you trust or use a netrc file.

## Mailgun bounces

Copy the HTTP webhook signing key from your Mailgun account, then turn on all three settings, in
Settings > Bounces or:

```sh
for setting in bounce.enabled bounce.webhooks_enabled; do
  curl -fsS -u "$API" -X PUT -H 'content-type: application/json' \
    -d 'true' "http://127.0.0.1:9000/api/settings/$setting"
done
curl -fsS -u "$API" -X PUT -H 'content-type: application/json' \
  -d '{"enabled":true,"key":"<signing key>"}' \
  http://127.0.0.1:9000/api/settings/bounce.mailgun
```

In Mailgun, point the webhooks for failures and complaints at
`https://news.example.com/webhooks/bounce/mailgun`. Delivered, opened and other events are
acknowledged and ignored. A request with a bad signature answers 406,
which is what a forged one got in this check. The server's clock must be right: a signature older
than 15 minutes is refused as stale.

## Uploads

Rules from [D64](design/09-decisions.md#d64-the-upload-directory-is-a-fixed-boundary-inside-the-data-directory):

- The real path of `upload.filesystem.upload_path` must be a directory inside the real data
  directory, with every symlink resolved. For other storage, mount it at that directory.
- A refused directory stops media and nothing else. The reason is logged at startup and shown in
  the API error, and campaigns with media pause.
- Only a file with a `media` row of that exact name is served.
- The path cannot change while any media row exists. To move media, delete it first.
- A crash can leave a file with no row. It is never served and is safe to delete or keep.

## Backups

```sh
runuser -u iglo-email -- iglo.email backup --data-dir /var/lib/iglo.email \
  --output /var/backups/iglo.email/monday
runuser -u iglo-email -- iglo.email backup --verify /var/backups/iglo.email/monday
```

Run it as the service user, while the server runs or while it is stopped: files in the backup
keep that owner through a restore. The parent directory must exist and be writable by that user,
as [Install](#install) sets up. With no `--output` the backup goes to
`backups/iglo-email-<time>` in the data directory. That is not off-site, so copy it away.
`--force` replaces an earlier backup, and only something that looks like one: never another
directory or the data directory, and it checks what it actually moved. Without it, an existing
path is refused, also one that appears while the backup runs: publishing is one rename, which
refuses a directory holding anything and a file, so of two overlapping backups to one path the
second to finish exits nonzero and the first stays. An empty directory that appears in that moment
is replaced, which loses nothing.

A backup is a directory shaped like a data directory:

```text
monday/                    mode 0700
  iglo-email.db            mode 0600, the snapshot, with the restore hold in it
  iglo-email-backup.json   mode 0600, the relative path of the upload directory
  uploads/                 mode 0700, copies of the uploaded files, each mode 0600
```

If the upload directory is reached through a symlink inside the data directory, which D64 allows,
the backup holds the real directory and its `upload_path` names it. The symlink is not kept and is
not needed after a restore.

**It holds everything the data directory does:** SMTP passwords, API tokens, password hashes,
secrets and personal data, in the clear. That is why it has these modes. Keep them, and encrypt
anything that leaves the host. A deletion or wipe of a subscriber does not reach backups already
taken, so keep them only as long as your privacy policy says.

**How it works.** `backup` is a separate process that opens the database with
`SQLITE_OPEN_READONLY` and runs `VACUUM INTO`, which needs only a read transaction on the source.
It takes no write lock, the server keeps committing, and the snapshot is exactly the committed
state when it began. This is safe beside a running server for the reason D62's read helpers are:
WAL mode allows readers in other processes, and a read-only connection cannot change the database
file, take a lease or send anything, so the one-server rule is untouched. It cannot use
`query_only`, as those helpers do, because that also refuses the writes to the output file. A
short-lived helper syncs the output while it is written: that keeps the disk flush from holding the
server's commits, which one flush at the end did for up to 1.9 s.

**Checkpoints and disk.** While the snapshot runs, a checkpoint cannot pass it, so the WAL grows
with the writes of that time. It was 7.5 MiB at about 80 writes a second, and the WAL is reused
afterwards. The WAL file keeps its size until the server stops. `backup` needs room for the live
pages of the database and the uploads, about the size of the data directory. It checks this first
and refuses if there is too little.

**Failure.** The backup is built in `.iglo-email-backup-partial-<random>` beside its destination,
synced, checked with `PRAGMA integrity_check` and renamed. A failed backup exits nonzero and
removes that directory. A killed one leaves it, and nothing at the final name, so a retry of the
same `--output` works. `--verify` refuses it, and it can never be mistaken for a backup. A kill after the final rename, before the command reports success, leaves a complete backup at that name: check it with `--verify` before you retry, since a retry refuses the existing destination. The next
`backup` in that place warns about it and does not delete it, as it could be running. When none
is running, remove it:

```sh
rm -rf /var/backups/iglo.email/.iglo-email-backup-partial-*
```

A `--force` run killed while publishing can leave the old backup as
`.iglo-email-backup-replaced-<random>`, with nothing at the final name. The next `backup` there
warns about that too. Move it back, or remove it once the new backup is verified.

**Media.** The database is copied first and the files after it. An upload that lands in between
is a file with no row, which nothing serves. A file deleted in between is a row with no file:
`backup` and `--verify` name it on stderr and exit 0. It behaves as a missing attachment does
anywhere: a 404 at its URL, and a campaign that attaches it pauses. An upload in progress and the
file of a running import are not included, and neither are the `backups` directory or subdirectories
and symlinks in the upload directory, which uploads never create.

### Nightly schedule

A script for the service user's cron or a systemd timer, kept to 14 days:

```sh
#!/bin/sh
set -eu
root=/var/backups/iglo.email
name="iglo-email-$(date -u +%Y-%m-%dT%H-%M-%SZ)"
iglo.email backup --data-dir /var/lib/iglo.email --output "$root/$name"
iglo.email backup --verify "$root/$name"
umask 077
tar -C "$root" -czf "$root/$name.tar.gz" "$name"
find "$root" -mindepth 1 -maxdepth 1 -name 'iglo-email-*' -mtime +13 -exec rm -rf {} +
```

```cron
# /etc/cron.d/iglo-email
20 3 * * * iglo-email /usr/local/bin/iglo-email-nightly
```

Then send `$name.tar.gz` off-site, encrypted, with the tool you already use. A cron job's failure
needs to reach someone: the script exits nonzero on any failed step.

## Restore

Restoring goes back to the moment of the snapshot, and this matters more for email than for most
data:

- Anyone who unsubscribed after the snapshot is subscribed again, and subscribers added since are
  gone.
- Marketing is at-most-once only within one database history. Messages sent after the snapshot
  are not on record, so a campaign, a queued message or a sequence step would send them again.

So every backup carries a **hold**, written into its database. A server started on it sends
nothing until you release it, however the files were copied. There is no step to remember.

```sh
systemctl stop iglo.email
runuser -u iglo-email -- iglo.email backup --verify /var/backups/iglo.email/monday
mv /var/lib/iglo.email /var/lib/iglo.email.before-restore
cp -a /var/backups/iglo.email/monday /var/lib/iglo.email
systemctl start iglo.email
curl -fsSi http://127.0.0.1:9000/health
```

`--verify` prints `Hold: held since <time>`. `/health` answers `200` and its usual body, with an
`X-Iglo-Email-Hold: <time>` header, and the admin shows the reason on every page.

**While held.** The admin and the API can be read, and paused or cancelled work stays so. Public
unsubscribe, opt-out and preference pages work, and so do bounce webhooks, because a person's
refusal must always land. Nothing leaves:

- Campaigns, scheduled ones too, do not start or continue. Their status stays as it was.
- Queued marketing and transactional mail stays `queued`, and no row is marked failed. A row the
  snapshot caught mid-send becomes `unknown` on start, as after any crash, and is not retried.
- Sequences take no steps, and outbound webhooks are not delivered.
- A request that would send now gets a 503 that says why: `POST /api/tx`, resends, test sends,
  starting or scheduling a campaign, SMTP tests, sequence test runs, the opt-in resend, a public
  data export and the [password reset](#locked-out-of-a-restored-install). An `async` `POST /api/tx`, opt-in mail from a signup and
  webhook events queue and wait.

**What a hold does not do.** It does not recover a lost unsubscribe. A person who opted out in
the app after the snapshot may be on no provider's list at all. Before releasing, look for what
happened since, in this order:

1. The newer database, with its WAL, in `/var/lib/iglo.email.before-restore`, if it survived.
2. A consumer of the `subscriber.unsubscribed` webhook, or anything else that kept these events.
3. Your provider's own suppressions, bounces and complaints.

Put each one back through the public unsubscribe link, the admin or the API, which work during the
hold. Then compare what was sent with what is queued, and pause or cancel what must not repeat.

If none of those records survives, keep marketing to the restored audience off: stay held, or
release only after every campaign and marketing sequence is paused and the audience has been
reconciled or has consented again. Stale consent is not consent.

**Release** is one command on a stopped server. It is refused without the flag, and while anything
has the database open. It records the time, and `--verify` then prints `Hold: released at <time>`.

```sh
systemctl stop iglo.email
runuser -u iglo-email -- iglo.email backup --release-hold --consent-reconciled \
  --data-dir /var/lib/iglo.email
systemctl start iglo.email
```

What is left then goes out: scheduled and running campaigns continue from the restored cursor,
queued mail is checked against current consent and sent, sequences catch up within their
`max_late`, and webhooks deliver. A recipient whose opt-out you did not put back gets mail, and one
who already received a campaign after the snapshot gets it again. That is what the flag states you
have dealt with.

A backup of a held install is held too, and keeps the original time. Upgrading keeps the hold.

### Locked out of a restored install

A restored database has the passwords and sessions of its snapshot, and a held install sends no
reset mail. If nobody can log in to do the review above, set a password locally. Do not release
the hold for this: that starts what you have not reviewed yet.

```sh
systemctl stop iglo.email
read -rs password
printf '%s\n' "$password" | runuser -u iglo-email -- iglo.email reset-password \
  --data-dir /var/lib/iglo.email --user admin
unset password
systemctl start iglo.email
```

The password comes from stdin, so it never appears in a process list or in shell history; `printf`
is a shell builtin. It follows the same rule as everywhere else, 8 to 2000 bytes. The command
refuses while anything has the database open, and refuses a disabled account, an API user and one
with password login off.

It changes that one account: the hold stays, and all of the user's sessions end. A second factor
stays required, so a user with TOTP gets the challenge after the new password. Control of the
machine does not replace the device. The command works the same on an install with no hold.

From an archive, first unpack it with `tar -xzf` and verify what came out.

Move the whole directory, as here. A new database beside an old `iglo-email.db-wal` is corrupted by
it. If the upload directory is a mount, restore into it with `cp -a monday/uploads/. <mount>/`. The
extra `iglo-email-backup.json` in a restored directory is harmless. If `upload_path` is absolute
and the data directory moved, media is refused until the path is right again.

Executable and backup versions:

- A newer executable restores an older backup: `--verify` says it will migrate, and the first
  start takes a pre-migration snapshot in `backups/` and runs the migrations. The hold stays.
- An older executable refuses a newer backup. `--verify` exits nonzero, and `serve` exits with
  `Database version N is ahead of this executable`. Restore with that version or a newer one.

## Upgrades

1. Take and verify a backup.
2. Download and check the new release as in [Install](#install).
3. Stop the server, replace the executable, start it.
4. Check `/health` and `iglo.email --version`.

Migrations run at startup and are forward-only. With migrations pending, startup first writes a
verified snapshot to `backups/` and refuses to migrate if it cannot. Those snapshots are plain
`.db` files that are never removed automatically; `--verify` reads them too. To go back: stop,
restore the backup from step 1, and put back the old executable.

A version with `-` in it, such as `0.1.0-rc.1`, is marked as a prerelease. Do not run one in
production.

A pre-migration snapshot carries a [hold](#restore), like a backup, and everything in Restore
applies if you put one back: it is an older moment, and it sends nothing until you release it. A
snapshot taken before this rule existed has no hold and must not be started without the same
review; `--verify` prints no `Hold:` line for it. The install the snapshot came from is not held.
A migration that fails rolls its own transaction back and the server exits: the live database
stays at its previous version, without a hold, and nothing is restored from the snapshot.

## Monitoring

- `GET /health` is public and answers `200` and `{"data":true}` once the server is listening. On a
  [held](#restore) install the body is byte for byte the same, so a balancer that matches it keeps
  routing unsubscribes here, and the response adds `X-Iglo-Email-Hold: <since>`. Alert on that
  header: nothing is being sent. Every signed-in admin page gives the reason. `/health` reads that
  one row and does not exercise the sending loops. `GET /api/health` needs an API user.
- A loop that fails for good stops the whole process, with a nonzero exit, so a supervisor with
  `Restart=on-failure` restarts it. Alert on restarts.
- Watch free disk on the data directory and on the backup destination, and the age of the newest
  backup.

## Logs

The server writes only errors and things that need attention, to stderr, with the whole error
there: journald, with the unit above. Treat that log as sensitive. `GET /api/logs` and the Logs
screen hold the last 5,000 lines in memory, each only a time, a fixed message and an error class,
because `settings:get` readers see them. For the detail, go to stderr.

## Sizes and capacity

Measured on one shared 6 vCPU VM with SQLite on ext4. These are observations, not guarantees.

| Measure | Result | Source |
|---|---|---|
| Campaign sending | 79.7 messages/s, 78.8/s under mixed load, against a target of 50 | [M6.1b](perf/M6.1b-throughput.md) |
| Events API | 100 events/s, p95 22 ms alone and 51 ms under mixed load | [M6.1b](perf/M6.1b-throughput.md) |
| Server memory | 106-119 MiB resident in those runs | [M6.1b](perf/M6.1b-throughput.md) |
| Read helpers | up to two at a time, 256 MiB each at most | [D62](design/09-decisions.md#d62-read-only-helper-processes-for-slow-reads) |
| Database, 1,000,000 subscribers | 600 MiB with memberships; 822 MiB with a year of views, clicks and sends | [M6.2](perf/M6.2-backup.md), [M4.6](perf/M4.6-maintenance.md) |
| Backup, 1,000,000 subscribers | 16-18 s in all, 2.7 s of it the snapshot; 73 MiB resident; server write stall up to 0.45 s | [M6.2](perf/M6.2-backup.md) |

Plan for a disk of at least twice the data directory, for the backup that is built beside it, plus
what is kept. With `app.cache_slow_queries` on, dashboard reads stop holding the WAL open
([D62](design/09-decisions.md#d62-read-only-helper-processes-for-slow-reads)).

## Retention

These run by themselves and have no settings
([D70](design/09-decisions.md#d70-send-history-is-kept-and-its-bodies-are-dropped-retention-shares-one-paced-loop)):

| What | When | What stays |
|---|---|---|
| Expired sessions | Within an hour of expiry | Sessions still valid |
| Finished webhook deliveries | 30 days after their last change | Pending deliveries, always |
| The message body of a finished send | 30 days after the send was created | The row, its links, and all analytics |
| Events | 400 days after receipt | Newer events |

- After 30 days a `failed` or `unknown` send can no longer be resent: `POST /api/sends/:id/resend` answers 409.
- After an upgrade from a version without this, the first start works through what has built up
  at about 120 rows a second per table, while sending goes on. A million rows take a few hours,
  and nothing needs watching ([measurements](perf/B2-retention.md)).
- Freed space goes back to SQLite for later rows, so the file stops growing but does not shrink.
- `sends` rows are kept for good. Their size is small, and old links and analytics read them.

## Defaults for open questions

From [Open questions](design/10-open-questions.md), until the owner decides otherwise:

| Question | Default in effect |
|---|---|
| Where does the first instance run? | A VPS with a persistent volume, behind the existing reverse proxy, with the nightly `backup` above sent off-site. Litestream is not recommended or tested; replication is the operator's choice. |
| Public subscription forms in v1? | The pages are there, with no CAPTCHA. The first consumer adds people through the API. Open forms attract signup spam, so keep lists private until CAPTCHA arrives. |
| Existing listmonk data? | None is imported. There is no listmonk importer. |
| Public repository? | Public, under the AGPL-3.0. |

## Unverified

- Real Mailgun events have not reached this code: only synthetic signed requests have. Whether
  Mailgun re-signs a retry is unknown. If it repeats a signature past 15 minutes, after a 429 or
  5xx here, that bounce is refused as stale and lost ([D63](design/09-decisions.md#d63-bounce-receipts-and-retained-provider-text)).
- Delivery through a real SMTP provider, and DKIM against real receivers. Tests use a local sink
  only.
- The systemd unit as a running service, the nginx example, TLS, a mounted upload directory, and a
  restore from real off-site storage.
- Behaviour on Linux arm64 or macOS. Only Linux x86-64 was used.
- A download from a published release. The checksum and install commands ran on files packaged
  locally by `bun run release:package`, and the release workflow has not run yet.
- Translations other than English have not been reviewed.
- Supported PDF viewers for attachments.

Known limits rather than unknowns: a [hold](#restore)
is in what `backup` and the migration runner write, so a disk image or a hand copy does not add
one (it keeps the row of a database already held) and must not be started without the same
review; and admin pages set no Content-Security-Policy yet, so review that before exposing the admin UI publicly.

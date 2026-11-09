# Operations guide

How to run iglo.email in production. The commands here were run on 2026-10-31 on Debian 13, with
a build of this branch, synthetic data and paths under a temporary directory in place of
`/usr/local/bin`, `/var/lib` and `/var/backups`. What was not run is listed under
[Unverified](#unverified). The account, ownership and restore commands ran as written, as root in a
throwaway user and mount namespace, so `/etc`, `/var/lib` and `/var/backups` there were temporary
copies.

## Install

Each release on [GitHub](https://github.com/iglo-tech/iglo.email/releases) has one executable per
architecture, `iglo.email-linux-x64` and `iglo.email-linux-arm64`, plus `SHA256SUMS`, `LICENSE` and
`THIRD-PARTY-NOTICES.txt`. Linux on x86-64 (an SSE4.2 CPU, Nehalem or newer, as Bun 1.4.4 targets)
and on arm64 are the only supported platforms; there are no macOS or Windows builds. The server
needs glibc, and neither Bun nor a checkout. Download the files of the version you want into an
empty directory, then pick your architecture (`uname -m` prints `x86_64` or `aarch64`):

```sh
sha256sum --check --strict --ignore-missing SHA256SUMS
install -m 0755 iglo.email-linux-x64 /usr/local/bin/iglo.email    # or iglo.email-linux-arm64
iglo.email --version
```

To build it yourself instead, on a Linux machine with Bun 1.4 or newer (the build is for the
architecture of the machine; `bun build --compile --target=bun-linux-arm64` cross-compiles):

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

A systemd unit, saved as `/etc/systemd/system/iglo.email.service`. On 2026-11-09 it ran as a service in a Debian 13 container with systemd as PID 1
(not on a host): it started, answered `/health`, restarted after `kill -9` and stopped cleanly.

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
needs the group. Start the service with the variables in place, then remove them and restart it.
`enable` makes the unit start at boot; without it the service stays down after a reboot:

```sh
systemctl enable --now iglo.email
curl -fsS --retry 10 --retry-connrefused --retry-delay 1 http://127.0.0.1:9000/health
```

When it prints `{"data":true}`, the administrator exists; then remove the variables and restart:

```sh
sed -i '/^IGLO_EMAIL_ADMIN_/d' /etc/iglo.email/env
systemctl restart iglo.email
```

One server runs per data directory, because the sending loops depend on it: two servers on one
directory could send a message twice. A second one [refuses to start](#one-process-per-data-directory).
A backup, and the helpers the server starts itself, are read-only and do not count.

## Docker

An official multi-architecture image (`linux/amd64`, `linux/arm64`) is published to GitHub's
container registry on every release: `ghcr.io/iglo-tech/iglo.email:<version>`, and `:latest` for
a version without `-`. GitHub creates such a package as private on its first push, and its owner
must once set the visibility to public (package settings) before the documented anonymous
`docker pull` works. The `ghcr.io/iglo-tech/iglo.email` package was made public for `0.1.0` on
2026-11-09. It only wraps the release executable of the same version;
nothing is built inside it. It runs as the non-root user 65532, keeps its data in the volume
`/data`, listens on port 9000 and has no shell. Prerelease versions are not for production.

```sh
docker volume create iglo-email-data
docker run -d --name iglo-email --restart unless-stopped \
  -v iglo-email-data:/data \
  -p 127.0.0.1:9000:9000 \
  -e IGLO_EMAIL_ROOT_URL=https://news.example.com \
  -e IGLO_EMAIL_ADMIN_USER=admin \
  -e IGLO_EMAIL_ADMIN_PASSWORD='choose-a-long-password' \
  ghcr.io/iglo-tech/iglo.email:0.1.0
```

The admin variables are read only while no users exist: after the first start, recreate the
container without them. Put the [reverse proxy](#reverse-proxy-and-tls) in front of the published
port. The image sets `IGLO_EMAIL_HOST=0.0.0.0` so that the published port reaches the server, so
publish it only where it should be reachable. The image has no `HEALTHCHECK`, since it has no HTTP
client: have the orchestrator or the proxy probe `GET /health` (`200` and `{"data":true}`).
Everything else in this guide applies; the data directory is `/data`, and one container runs per
volume ([one process per data directory](#one-process-per-data-directory)).

Commands that need the data directory run in a second container on the same volume, which is
only right for those that do not [refuse beside a running server](#one-process-per-data-directory).
A bind mount using `chown 65532` fails or maps to a different host UID under rootless Docker. To
work under both rootful and rootless Docker, run `backup` in the running container and copy the
verified directory out with `docker cp` (or write the backup into a named volume). The host
destination must be owned by the user running `docker cp` (for example `mkdir -p ~/iglo-backups`
without `sudo`), not a root-owned directory.

Backups made with `docker exec` stay inside the data volume, and the image has no shell to remove
them. To keep volume usage bounded using only the executable, reuse one fixed in-volume path and
pass `--force` to replace it on each subsequent run:

```sh
mkdir -p -m 0700 ~/iglo-backups
docker exec iglo-email iglo.email backup --output /data/backups/latest --force
docker exec iglo-email iglo.email backup --verify /data/backups/latest
docker cp iglo-email:/data/backups/latest/. ~/iglo-backups/monday
```

Copy into a destination that does not exist yet, and give each run a new name (`monday`,
`tuesday`, and so on). `docker cp` creates a missing destination and fills it with the backup's
contents. With the `/.` suffix, an existing destination gets those contents merged into it, so a
repeated copy to the same name mixes two backups. Without the suffix, an existing destination
gets the directory nested inside it, as `monday/latest`. `docker cp` does not create the parent
folder either, which `mkdir -p` does above. See the
[`docker container cp` reference](https://docs.docker.com/reference/cli/docker/container/cp/).

`reset-password`, `reset-totp` and `backup --release-hold` refuse while the server runs: stop the
container, run them with `--rm -v iglo-email-data:/data`, and start it again. A
[restore](#restore) likewise runs in a container with the volume mounted. To upgrade, take and
verify a backup, then `docker pull` the new tag, remove the container and run it again with the
same volume and variables; see [Upgrades](#upgrades). To go back, restore the backup with the old
tag.

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
  stage/                IDs of a large subscriber selection while it runs; empty at rest
  uploads/              media files
  backups/              pre-migration snapshots, and backups with no --output
  .iglo-email-import/   the file of a running import
```

The database holds SMTP passwords, API tokens, password hashes, webhook secrets
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
| `reset-totp` | Refuses |
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
example for nginx. On 2026-11-09 it ran verbatim in front of the service, with a self-signed test
certificate in place of Let's Encrypt's: the admin login, `/health`, a media upload and download,
and the public subscription page all worked through it:

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

## Sending with Amazon SES

This is the one path to good deliverability (D89). Easy DKIM signs each message, a custom MAIL FROM
domain lets SPF align, DMARC states the policy, SMTP credentials send, and the send-rate cap matches
the account. Amazon SES is the only sending provider. Use one AWS region throughout: the identity,
the SMTP endpoint and the SNS topic must all be in the same region. Do the steps in order. The AWS
pages each step follows are listed under [References](#references); they were checked on
2026-11-08.

1. **Verify the domain with Easy DKIM.** In SES, open Identities, create a domain identity and keep
   Easy DKIM on. SES signs with a 2048-bit key by default. On the identity's Authentication tab,
   take the three CNAME records SES shows and publish them with your DNS provider, copying each
   value exactly. Each value is the DKIM token followed by SES's signing domain, for example
   `<token>.dkim.<region>.amazonses.com`. Wait until the identity is verified, which can take up to
   72 hours. SES signs outgoing mail with this key, so leave `smtp[].dkim` empty (see
   [Compatibility](#compatibility-signing-in-igloemail)).
2. **Set a custom MAIL FROM domain.** Choose a subdomain of the verified domain that you use for no
   other mail, for example `bounce.example.com`, and set it on the identity's "Custom MAIL FROM
   domain" pane. Publish two records on that name:
   - MX `bounce.example.com` with the value `10 feedback-smtp.<region>.amazonses.com`
   - TXT `bounce.example.com` with the value `"v=spf1 include:amazonses.com ~all"`

   SPF alignment needs the MAIL FROM domain to match the From domain, so without this step the
   message's SPF check does not align with your From address. Wait until the MAIL FROM status is
   Success. SES keeps checking for up to 72 hours; if it shows Failed, fix the records and set the
   domain again.
3. **Publish DMARC.** Add a TXT record `_dmarc.example.com` with
   `v=DMARC1; p=none; rua=mailto:dmarc-reports@example.com`, using a mailbox you read. DMARC passes
   when SPF or DKIM passes and aligns with the From domain, and with steps 1 and 2 both align. Start
   with `p=none`, read the aggregate reports for several weeks, then move to `p=quarantine` and
   finally `p=reject`. AWS recommends this phased rollout. Do not set `aspf=s`, because the MAIL FROM
   subdomain aligns with the From domain only in relaxed mode.
4. **Create SMTP credentials and add the server.** In SES, open SMTP settings and choose Create SMTP
   credentials. The SMTP user name and password are not your AWS login, and SES shows the password
   only once, so download the credentials then. Set SMTP servers in Settings > SMTP, then send a
   test from there. The defaults are placeholders. Add a server with host
   `email-smtp.<region>.amazonaws.com`, port 587 with STARTTLS (or 465 with TLS), and those
   credentials. Change the default `app.from_email` (`listmonk <noreply@listmonk.yoursite.com>`,
   in `src/settings/defaults.ts`) to an address on the verified domain, and use that domain for
   campaign From addresses too, because SES refuses mail from any other address.
5. **Send through a configuration set (optional).** A configuration set carries the bounce,
   complaint and other event destinations for mail sent through SES. To assign one, add
   `X-SES-CONFIGURATION-SET: <name>` to the SMTP server's custom headers in Settings > SMTP, or via
   the API as `[{"X-SES-CONFIGURATION-SET": "<name>"}]` under `smtp[].email_headers`. The header goes
   with every message sent through that server.
6. **Set the send rate.** `messaging.max_send_rate` (Settings > Performance, or
   `PUT /api/settings/messaging.max_send_rate`) is the account-wide cap in messages per second across
   all connections. Set it to the maximum sending rate your SES account has. The code default is `14`
   (`src/settings/defaults.ts`). In the sandbox AWS allows one message per second, so set `1` there.
   `0` turns the cap off. Every email (campaign, transactional and sequence) waits on this shared
   limit, and outbox sends (transactional and sequence) go ahead of background campaign broadcasts.
   SES counts both the 24-hour quota and the per-second rate per recipient, not per message, so one
   message to three addresses uses three.
7. **Leave the sandbox.** A new account is in the SES sandbox: 200 messages per 24 hours, one per
   second, and mail only to verified addresses and domains or the mailbox simulator. So a test send
   made in the sandbox must go to a verified address or the mailbox simulator. Before real sends,
   follow the sandbox notice on the Account dashboard to request production access. AWS states that
   the first answer can take up to 96 hours. When it is granted, set `messaging.max_send_rate` to the
   production rate.

### Compatibility: signing in iglo.email

`smtp[].dkim` makes iglo.email sign messages itself. It exists for listmonk API compatibility and
is not needed with SES Easy DKIM (step 1). SES already signs every message for the verified domain,
so a key here only adds a second signature from the same domain. Do not set both. To sign here, add
`dkim` to a server. The admin UI keeps it but does not show it, so this goes through the API. A
masked password sent back unchanged is kept. The key script below is for anyone who needs it.

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
leaves it in `ps`, so use a file or netrc in a real environment.

### References

AWS documentation, checked 2026-11-08:

- Easy DKIM: <https://docs.aws.amazon.com/ses/latest/dg/send-email-authentication-dkim-easy.html>
- Verifying identities and the three CNAME records: <https://docs.aws.amazon.com/ses/latest/dg/creating-identities.html>
- Custom MAIL FROM domain: <https://docs.aws.amazon.com/ses/latest/dg/mail-from.html>
- SPF: <https://docs.aws.amazon.com/ses/latest/dg/send-email-authentication-spf.html>
- DMARC: <https://docs.aws.amazon.com/ses/latest/dg/send-email-authentication-dmarc.html>
- SMTP credentials: <https://docs.aws.amazon.com/ses/latest/dg/smtp-credentials.html>
- SMTP endpoints (the `email-smtp.<region>` hosts): <https://docs.aws.amazon.com/general/latest/gr/ses.html>
- SMTP ports and TLS: <https://docs.aws.amazon.com/ses/latest/dg/smtp-connect.html>
- Configuration sets in email, with the `X-SES-CONFIGURATION-SET` header: <https://docs.aws.amazon.com/ses/latest/dg/using-configuration-sets-in-email.html>
- Sending quotas: <https://docs.aws.amazon.com/ses/latest/dg/manage-sending-quotas.html>
- Moving out of the sandbox: <https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html>
- SNS topics for bounce and complaint feedback: <https://docs.aws.amazon.com/ses/latest/dg/configure-sns-notifications.html>

## Amazon SES bounces

Sending through SES is ordinary SMTP (see [Sending with Amazon SES](#sending-with-amazon-ses)). SES
reports bounces and complaints through Amazon SNS, and iglo.email records and acts on them as
listmonk does, so the account's bounce and complaint rates stay low. Amazon SES is the only sending
and bounce provider (D89).

1. **An SNS topic.** In SNS, create a Standard topic in the same region, for example
   `ses-bounces`, and note its ARN. Its access policy must allow SES to publish to it (see
   [Amazon SNS notifications](https://docs.aws.amazon.com/ses/latest/dg/configure-sns-notifications.html)).
2. **Send feedback to it.** In SES > Identities > your domain, open the Notifications tab and choose
   Edit under Feedback notifications. Set the Bounce and Complaint feedback to the topic, and tick
   "Include original email headers" under each so a bounce can be matched to the campaign (without
   them it is matched by address). With a configuration
   set, add an event destination for Bounce and Complaint events to the topic instead. Other event
   types (Delivery, Send) are refused with 400 and do nothing, so do not publish them to this topic.
3. **Turn it on** in Settings > Bounces (bounce processing, webhooks, the Amazon SES switch, and
   the allowed topic ARNs), or:

   ```sh
   for setting in bounce.enabled bounce.webhooks_enabled bounce.ses_enabled; do
     curl -fsS -u "$API" -X PUT -H 'content-type: application/json' \
       -d 'true' "http://127.0.0.1:9000/api/settings/$setting"
   done
   curl -fsS -u "$API" -X PUT -H 'content-type: application/json' \
     -d '["arn:aws:sns:eu-west-1:123456789012:ses-bounces"]' \
     http://127.0.0.1:9000/api/settings/bounce.ses_topic_arns
   ```

   List the topic's full ARN, or `arn:aws:sns:*:<account-id>:*` to accept every topic of your
   AWS account. **Until a topic is listed, every SES message is refused**, including the
   subscription confirmation.

4. **Subscribe the endpoint.** In SNS, create a subscription on the topic with protocol HTTPS and
   endpoint `https://news.example.com/webhooks/service/ses`. SNS posts a
   `SubscriptionConfirmation`; with the switch on, iglo.email verifies it and confirms by itself,
   and the subscription shows "Confirmed". Turn the switch on first: a confirmation sent while it
   is off is refused, and SNS needs a new request (delete and recreate the subscription).
5. **Check it.** Send to SES's mailbox simulator, `bounce@simulator.amazonses.com` (hard) and
   `complaint@simulator.amazonses.com`, from a campaign or `/api/tx`. Then open Bounces: rows
   appear with source `ses`, and the subscriber is acted on at the thresholds you set. If nothing
   appears, check in SNS that the subscription is confirmed and read its delivery logs, where a
   refused message shows as a 400 response; the endpoint does not say why it refused.

The server needs outbound HTTPS to `sns.<region>.amazonaws.com` to fetch the signing certificate
and to confirm subscriptions, and its clock must be right (a message more than 24 hours old, or
15 minutes ahead, is refused). The endpoint accepts bodies up to 256 KiB. SNS delivers at least
once; a repeated message is recorded once.

Amazon signs every SNS message with the same certificates, whoever's topic it comes from, so a
valid signature only proves the message passed through SNS. Any AWS account could create a topic,
subscribe your public endpoint and publish a bounce for any address. That is why the allowed
topic ARNs are required (unlike listmonk, which believes any signed message): a message from a topic
that is not listed is refused with 400, a confirmation is not fetched and nothing is recorded. At most
50 recipients of a message are recorded, which is SES's own limit.

## Uploads

Rules from [D64](design/09-decisions.md#d64-the-upload-directory-is-a-fixed-boundary-inside-the-data-directory):

- The real path of `upload.filesystem.upload_path` must be a directory inside the real data
  directory, with every symlink resolved. For other storage, mount it at that directory.
- A refused directory stops media and nothing else. The reason is logged at startup and shown in
  the API error, and campaigns with media pause.
- A mounted upload directory is often owned by root, so after mounting it, the service user must own
  it: run `chown iglo-email:iglo-email /var/lib/iglo.email/uploads` as root. Until then an upload
  fails with `500`, and the log shows `EACCES` on `mkdir`. On 2026-11-09 a file uploaded into a
  bind-mounted directory was served before and after `systemctl restart`, once the directory was
  owned by the service user.
- Only a file with a `media` row of that exact name is served.
- The path cannot change while any media row exists. To move media, delete it first.
- A crash can leave a file with no row. It is never served and is safe to delete or keep.

## Backups

```sh
runuser -u iglo-email -- iglo.email backup --data-dir /var/lib/iglo.email \
  --output /var/backups/iglo.email/monday
runuser -u iglo-email -- iglo.email backup --verify /var/backups/iglo.email/monday
```

Run it as the service user, while the server runs or while it is stopped: files in the backup keep
that owner through a restore. Missing parent folders of `--output` are created, mode 0700; the
nearest one that exists must be writable by that user, as [Install](#install) sets up. A refused
backup leaves no folder it made and keeps every folder that existed. A failed one does the same: it
removes exactly the folders it made, and only while they are empty. With no `--output` the backup
goes to `backups/iglo-email-<time>` in the data directory. That is not off-site, so copy it away.
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
synced, checked with `PRAGMA integrity_check` and renamed. A failed backup exits nonzero and removes
that directory, and any parent folder it created for it. A folder is removed only if it is still the
one the backup made and is empty: a folder another process has started using is kept without a
warning. If a folder on the output's path is renamed or replaced while the backup runs, the backup
is refused as changed meanwhile and does not search for its partial directory: the warning gives
the path the partial was last made at, and it is left for you to remove. A step after the final
rename is not undone, and the cleanup does not run over the backup. A failed sync of the output's
folder exits nonzero: the backup is in place, but it may not survive a crash. The message names the
replaced backup, if any, which is kept beside the new one, and says to check the new one with
`--verify`. Keep the replaced backup until the new one has been verified. A failure to remove the
replaced backup is a warning, and the next `backup` there reports it. A killed backup leaves its
partial directory, and nothing at the final name, so a retry of the same `--output` works.
`--verify` refuses it, and it can never be mistaken for a backup. A kill after the final rename,
before the command reports success, leaves a complete backup at that name: check it with `--verify`
before you retry, since a retry refuses the existing destination. The next `backup` in that place
warns about it and does not delete it, as it could be running. When none is running, remove it:

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

### A user lost their TOTP device

No admin screen clears another user's second factor. With the server stopped, turn it off for that
user:

```sh
systemctl stop iglo.email
runuser -u iglo-email -- iglo.email reset-totp --data-dir /var/lib/iglo.email --user alice
systemctl start iglo.email
```

All of the user's sessions end, and they log in with their password alone and can enroll a new
device. The command refuses while anything has the database open. It does not change the password,
and the restore hold stays as it is. TOTP is also dropped when an admin turns a user's password
login off or converts the user to an API user, so an old key never comes back.

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
2. Download and check the new release as in [Install](#install), or pull the new image tag as in
   [Docker](#docker).
3. Stop the server, replace the executable (or recreate the container on the same volume), start
   it.
4. Check `/health` and `iglo.email --version`.

This applies only to an install whose settings were never saved before the upgrade. On such an
install, the seeded placeholder passwords (`password`, on both seeded SMTP servers and on the seeded bounce
mailbox) are not carried over by the first full save of the settings page, so enter the real
passwords before that save. Any earlier save gave these items their uuids, and they keep their
passwords, so this note does not apply to them.

From this version, an SMTP server or bounce mailbox saved with auth `none` keeps no password, and so
does an SMTP server saved with an empty auth protocol, so switching it back to login needs the password
entered again. A bounce mailbox saved with an empty auth protocol keeps its password, as upstream's POP
login runs for it. A save that would give two SMTP servers, bounce mailboxes or messengers the same
uuid is refused with 400 and changes nothing. An install that already holds duplicate uuids (only
hand-made API calls could store them) gets 400 on every API settings save (`PUT /api/settings` or a
per-key update), until the settings page is saved once.

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

## Admin notifications

Operators can receive notifications for campaign and import events by configuring `app.notify_emails` (a comma-separated list of email addresses on the General settings tab in the Admin UI, or an array of strings in `PUT /api/settings`). When configured, system notification emails are sent using listmonk's built-in templates from `app.from_email[0]`, with at most one notification per status change, sent after the change commits when:
- A campaign **finishes** (audience exhausted or zero recipients), is **cancelled** via the API, or **pauses automatically** upon reaching `app.max_send_errors`.
- A subscriber CSV import **finishes** or **fails**.

If `app.notify_emails` is empty or unset, no notifications are generated. An entry that is not a valid email address is skipped and logged as an error on every notification; the valid entries still receive the mail. If `app.from_email[0]` is not a valid address, no admin notification is sent and the bad value is logged once per distinct value per process, because the sender would be refused by SES. Nothing falls back to another sender. A notification that cannot be queued is logged and never changes the campaign or import it reports on. Notifications are delivered via the durable transactional outbox queue and do not interfere with subscriber metrics or webhooks.

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

Analytics and report reads have two further limits ([D62](design/09-decisions.md#d62-read-only-helper-processes-for-slow-reads),
[measurements](perf/B7-load-memory.md)):

- **Slow downloads.** Finished responses over 64 KiB that a client has not yet received are held
  in memory up to 64 MiB in all. Past that, a new analytics read gets `503` before it starts;
  retry shortly. Normal dashboards and reports are unaffected.
- **Continuous polling.** If reads overlap for 15 s without a pause, new reads wait for the
  running ones to finish and the server checkpoints the WAL, so polling with no gap cannot grow
  it without limit. An occasional report that takes a few seconds longer is the sign.

Large subscriber selections (`per_page=all`, exports, bulk actions on a query) write the matching
IDs to `stage/` in the data directory while they run, about 8 bytes each. The files are removed as
the request ends, and any left by a killed server when it next starts.

## Retention

These run by themselves and have no settings
([D70](design/09-decisions.md#d70-send-history-is-kept-and-its-bodies-are-dropped-retention-shares-one-paced-loop)):

| What | When | What stays |
|---|---|---|
| Expired sessions | Within an hour of expiry | Sessions still valid |
| Finished webhook deliveries | 30 days after their last change | Pending deliveries, always |
| The message body of a finished send | 30 days after the send was created | The row, its links, and all analytics |
| Events | 400 days after receipt | Newer events |

Sessions, deliveries, send bodies and events share one loop that takes at most 100 rows from one
of them, then pauses 250 ms, so a large expired backlog never holds back a send. The loop clears about 380 rows a second in
total (measured with events alone, [D74](design/09-decisions.md#d74-synchronous-attachment-sends-share-a-memory-budget-event-retention-joins-the-paced-loop)); owners with a backlog take turns, so each gets a share of that, and send bodies, 50 rows a pass, are slower in rows.
A session with no stored expiry (written before sessions captured one) goes seven days after creation, to the millisecond.

- After 30 days a `failed` or `unknown` send can no longer be resent: `POST /api/sends/:id/resend` answers 409.
- After an upgrade from a version without this, the first start works through what has built up
  at about 380 rows a second across all four together, while sending goes on. A million rows take about three quarters of an hour, and a backlog in every table a few hours,
  and nothing needs watching ([measurements](perf/B2-retention.md)).
- Freed space goes back to SQLite for later rows, so the file stops growing but does not shrink.
- `sends` rows are kept for good. Their size is small, and old links and analytics read them.

## Attachment sends

`POST /api/tx` with caller attachments, or with a template that embeds images, holds memory until
the SMTP server answers. All such requests share 128 MiB of measured memory
([D74](design/09-decisions.md#d74-synchronous-attachment-sends-share-a-memory-budget-event-retention-joins-the-paced-loop),
[D87](design/09-decisions.md#d87-the-tx-attachment-budget-counts-measured-memory-b26)):
a request that finds no room waits up to 2 seconds and then gets `429` with `Retry-After: 1`,
before anything is journaled, so retrying it is safe. A caller that sees this often should send
`async` or fewer, smaller attachments at once. There is no setting.

## Admin Content-Security-Policy

Every HTML page under `/admin` has a Content-Security-Policy
([D71](design/09-decisions.md#d71-admin-pages-have-a-content-security-policy-and-the-editor-stays-in-the-page)).
Do not replace or weaken it at the proxy, and do not add a second one there: browsers enforce both.

- `appearance.admin.custom_js` runs, as `/admin/custom.js`, but cannot use `eval` or inline handlers,
  load a script from another origin, or call another origin. Custom CSS cannot load fonts or images
  from another origin.
- Images load from this address, the root URL's origin and the favicon's. Set `app.root_url` to the
  address the admin is used at, or media in the rich-text editor waits behind its notice.
- Remote images in a campaign body stay unloaded until **Show remote images** is pressed, for that
  page load only.

## Public form CAPTCHA

Open public forms attract signup spam. Turn a CAPTCHA on in Settings → Security before linking
`/subscription/form` or pasting a form from Lists → Forms on another site.

- **ALTCHA** needs no account and sends nothing to a third party. The browser solves a SHA-256
  proof of work, at most *complexity* hashes (300,000 by default, about a second on a laptop).
  Challenges are valid for five minutes, each solution is accepted once, and a restart refuses
  challenges issued before it. The form loads `/public/static/altcha.umd.js` from this server and
  fetches its challenge from the root URL, so the root URL must be the address visitors use. A
  form pasted on another site also needs that site's origin in `security.trusted_urls`: the
  widget script and the challenge are then served with CORS headers for that origin, as in
  listmonk. A site that is not listed gets no header, so its browser refuses the widget and every
  signup from that page is refused too. If the site has its own Content-Security-Policy, it must
  allow this server in `script-src` and `connect-src`, and `blob:` in `worker-src`.
- **hCaptcha** needs a site key and secret from hcaptcha.com. Each form post calls hCaptcha's
  `siteverify` with a 5 s timeout, so the server needs outbound HTTPS to `hcaptcha.com`; when that
  fails, or answers anything but success, the signup is refused, never let through.

Only one provider is used: ALTCHA if both are enabled. `POST /api/public/subscription`, the JSON
API, never asks for a CAPTCHA, as in listmonk; the subscribe rate limit is its protection. Keep
lists private if that API is not meant to be public.

## MCP (Model Context Protocol)

iglo.email provides an MCP Streamable HTTP endpoint at `POST /api/mcp` for AI agents (Claude Code, Cursor, Cline, etc.) to list, read, edit, and preview templates and campaign content, create draft campaigns, find lists and media, and edit the content of sequence steps. The tools are listed in [D91](design/09-decisions.md#d91-mcp-endpoint-for-template-and-campaign-editing-lead-2026-11-07).

To connect an MCP client, use the Streamable HTTP transport with an API user authorization header:

```sh
claude mcp add --transport http iglo https://<root>/api/mcp --header "Authorization: token <user>:<key>"
```

### Security and role recommendations

- Do not use administrative accounts for AI agents. Create a dedicated API user (`type: "api"`) with a restricted user role holding only the necessary permissions:
  - For template work only: `templates:get` and `templates:manage`.
  - For campaign editing: `campaigns:get` and `campaigns:manage` (or `campaigns:get_all` / `campaigns:manage_all`), and optionally restrict access using a list role to only the lists the agent is allowed to target. `list_media` also needs `media:get`.
  - For sequence step content: `sequences:get` to read and `sequences:manage` to change a step. Changing a step of a live sequence changes the messages of everyone who has not reached that step yet. Saving a step rewrites the whole sequence, so it also needs `subscribers:sql_query` when another step of the sequence has a raw-SQL condition.
  - `list_lists` shows only the lists the caller's role can read (`lists:get_all`, or a list role that covers the list).
  - Read-merge tools (`update_campaign`, `send_campaign_test`, `preview_campaign`, `campaign_text`, `update_sequence_step`) read the stored object before they save or render it. `preview_campaign` and `campaign_text` read only when their input omits fields; `send_campaign_test` always reads. A role with the write permission but not the read permission gets a tool error that names the read permission, and nothing is written; give the role both. For campaigns the read permission is `campaigns:get_all`, or `campaigns:get` with a list role that includes one of the campaign's lists.
- The endpoint validates incoming `Origin` headers against the configured root URL and rejects foreign origins with HTTP 403.
- Unauthenticated requests receive HTTP 401 before any JSON-RPC processing.
- All operations are dispatched in-process with the caller's credentials and permissions; the MCP server owns no direct database tables.

## Defaults for open questions

From [Open questions](design/10-open-questions.md), until the owner decides otherwise:

| Question | Default in effect |
|---|---|
| Where does the first instance run? | A VPS with a persistent volume, behind the existing reverse proxy, with the nightly `backup` above sent off-site. Litestream is not recommended or tested; replication is the operator's choice. |
| Public subscription forms in v1? | The pages are there, with ALTCHA or hCaptcha available; see [Public form CAPTCHA](#public-form-captcha). The first consumer adds people through the API. |
| Existing listmonk data? | None is imported. There is no listmonk importer. |
| Public repository? | Public, under the AGPL-3.0. |

## Unverified

- Delivery through a real SMTP provider, and DKIM against real receivers. Tests use a local sink
  only.
- TLS with a certificate from a certificate authority: the nginx example ran with a self-signed
  test certificate only, since issuing one needs a public domain.
- A restore from real off-site storage.
- Running on Linux arm64: the server as a service, and the published `linux/arm64` image. The
  release workflow's `image-smoke` job runs the arm64 executable and an image built from the
  Dockerfile on a native arm64 runner; the published image itself was run only on amd64.
- Translations other than English have not been reviewed.
- PDF viewers other than desktop Chromium and Firefox. Those two were checked on 2026-11-09 with a
  hostile PDF: its JavaScript ran only inside the viewer and sent no request to `/api/*`
  (see the media serving row in [07-api-and-ui.md](design/07-api-and-ui.md)). iOS and Android viewers
  are untested; the owner has not decided whether they need a check (open question 5).

Known limits rather than unknowns: a [hold](#restore)
is in what `backup` and the migration runner write, so a disk image or a hand copy does not add
one (it keeps the row of a database already held) and must not be started without the same
review.

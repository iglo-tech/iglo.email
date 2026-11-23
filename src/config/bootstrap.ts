// Bootstrap flags and configuration are adapted from listmonk's cmd/init.go and cmd/main.go.
import { isIP } from "node:net";
import { must } from "@/invariant";
import { version } from "@/../package.json";

export interface BootstrapConfig {
  port: number;
  host: string;
  dataDir: string;
  rootUrl: string;
  initialAdmin: { user: string | undefined; password: string | undefined };
  /** The first API user (D106). Absent in fixtures that create no user from the environment. */
  initialApi?: { user: string | undefined; token: string | undefined };
}

type Environment = Record<string, string | undefined>;
type OptionName = "--port" | "--host" | "--data-dir" | "--root-url";

type BootstrapResult =
  | { help: true }
  | { help: false; version: true }
  | { help: false; version: false; config: BootstrapConfig };

const removedFlags = new Set(["--install", "--upgrade", "--config", "--new-config"]);
const optionNames: ReadonlyArray<OptionName> = ["--port", "--host", "--data-dir", "--root-url"];
const isOptionName = (name: string): name is OptionName =>
  optionNames.some((option) => option === name);

// Bun inlines package.json at build time, so the compiled executable carries this value.
export const versionText = `${version}\n`;

export const helpText = `Usage: iglo.email [serve] [options]

Start the HTTP server. Bootstrap options override their environment equivalents:
  --port <port>          IGLO_EMAIL_PORT       Listen port (default: 9000)
  --host <host>          IGLO_EMAIL_HOST       Listen host (default: 127.0.0.1)
  --data-dir <path>      IGLO_EMAIL_DATA_DIR   Data directory (default: ./data)
  --root-url <url>       IGLO_EMAIL_ROOT_URL   Public root URL (default: http://<host>:<port>)
  --help                                        Show this help
  --version                                     Print the version

IGLO_EMAIL_ADMIN_USER and IGLO_EMAIL_ADMIN_PASSWORD initialize the first admin
only when no users exist. Without them public health is available but login is denied.
IGLO_EMAIL_API_USER and IGLO_EMAIL_API_TOKEN create an API user with the Super Admin role on the
same first start, with that token; set both or neither. Nothing is printed. Remove them afterwards.
`;

export function parseBootstrap(args: Array<string>, env: Environment): BootstrapResult {
  const options: Partial<Record<OptionName, string>> = {};
  let sawCommand = false;
  let help = false;
  let printVersion = false;

  for (let i = 0; i < args.length; i++) {
    const arg = must(args[i], "argument");
    if (!arg.startsWith("-")) {
      if (arg !== "serve" || sawCommand) {
        throw new Error(`Unknown command: ${arg}`);
      }
      sawCommand = true;
      continue;
    }

    const equals = arg.indexOf("=");
    const name = equals === -1 ? arg : arg.slice(0, equals);
    if (removedFlags.has(name)) {
      throw new Error(`${name} is no longer supported; see docs/design/01-scope.md`);
    }
    if (name === "--help" && equals === -1) {
      help = true;
      continue;
    }
    if (name === "--version" && equals === -1) {
      printVersion = true;
      continue;
    }
    if (!isOptionName(name)) {
      throw new Error(`Unknown flag: ${name}`);
    }

    let value: string;
    if (equals !== -1) {
      value = arg.slice(equals + 1);
    } else {
      const next = args[i + 1];
      if (next === undefined || next.startsWith("-")) {
        throw new Error(`${name} requires a value`);
      }
      value = next;
      i++;
    }
    options[name] = value;
  }

  if (help) {
    return { help: true };
  }
  if (printVersion) {
    return { help: false, version: true };
  }

  const portValue = options["--port"] ?? env.IGLO_EMAIL_PORT ?? "9000";
  if (!/^[0-9]+$/.test(portValue)) {
    throw new Error("Invalid port: expected an integer from 1 to 65535");
  }
  const port = Number(portValue);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Invalid port: expected an integer from 1 to 65535");
  }

  const host = parseHost(options["--host"] ?? env.IGLO_EMAIL_HOST ?? "127.0.0.1");
  const dataDir = options["--data-dir"] ?? env.IGLO_EMAIL_DATA_DIR ?? "./data";
  if (dataDir.trim() === "" || dataDir.includes("\0")) {
    throw new Error("Invalid data-dir: expected a non-empty path");
  }

  const urlHost = isIP(host) === 6 ? `[${host}]` : host;
  const rootUrl = options["--root-url"] ?? env.IGLO_EMAIL_ROOT_URL ?? `http://${urlHost}:${port}`;
  validateAbsoluteUrl(rootUrl, "root-url");

  return {
    help: false,
    version: false,
    config: {
      port,
      host,
      dataDir,
      rootUrl,
      initialAdmin: { user: env.IGLO_EMAIL_ADMIN_USER, password: env.IGLO_EMAIL_ADMIN_PASSWORD },
      initialApi: { user: env.IGLO_EMAIL_API_USER, token: env.IGLO_EMAIL_API_TOKEN },
    },
  };
}

function parseHost(value: string): string {
  let host = value;
  if (host.startsWith("[") && host.endsWith("]")) {
    host = host.slice(1, -1);
    if (isIP(host) !== 6) {
      throw new Error("Invalid host: brackets are only valid around an IPv6 address");
    }
  }
  if (isIP(host)) {
    return host;
  }

  const labels = host.replace(/\.$/, "").split(".");
  const validName =
    host.length <= 253 &&
    labels.every((label) => /^(?=.{1,63}$)[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(label));
  const looksLikeIPv4 = labels.length === 4 && labels.every((label) => /^[0-9]+$/.test(label));
  if (!validName || looksLikeIPv4) {
    throw new Error("Invalid host: expected a hostname or IP address without a port");
  }
  return host;
}

const schemeStart = /^[A-Za-z][A-Za-z0-9+.-]*:/;
// `host:port`, read as a host unless the name is a scheme that is followed by no `//`.
const hostAndPort = /^[A-Za-z0-9.-]+:[0-9]+(?:[/?#]|$)/;
const schemeNames = /^(?:https?|ftp):/i;
const schemeSlash = /^(?:https?|ftp)\//i;
const expectedUrl = "expected an absolute http:// or https:// URL";

// A DNS host name: at least two labels of letters, digits and hyphens, each 1 to 63 characters and
// not starting or ending with a hyphen. Then an optional port without a leading zero, and an
// optional path with no whitespace, backslash, `?`, `#` or `@`. Only a value that matches all of it
// gets a suggestion (D107): every other value names what is wrong and gets none.
const label = String.raw`[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?`;
const bareRootUrl = new RegExp(
  String.raw`^((?:${label}\.)+${label})(?::([1-9][0-9]{0,4}))?(\/[^\s\\?#@]*)?$`,
);

/** Whether the value starts with a scheme; `news.example.com:8443` is a host and a port. */
function hasScheme(value: string): boolean {
  if (!schemeStart.test(value)) {
    return false;
  }
  return !hostAndPort.test(value) || schemeNames.test(value);
}

function portInRange(digits: string): boolean {
  const port = Number(digits);
  return port >= 1 && port <= 65_535;
}

/**
 * `https://<value>` for a bare host, when the value matches the host allow-list and the URL built
 * from it has the same host and port and passes the validator. Otherwise nothing.
 */
function suggestionFor(value: string, kind: AbsoluteUrlKind): string | undefined {
  const match = bareRootUrl.exec(value);
  if (!match) {
    return undefined;
  }
  const host = match[1] ?? "";
  const port = match[2];
  if (host.length > 253) {
    return undefined;
  }

  const candidate = `https://${value}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return undefined;
  }
  // URL drops the default port of https (443), so a port of 443 is read back as "".
  const expectedPort = port === undefined || port === "443" ? "" : port;
  if (url.hostname !== host.toLowerCase() || url.port !== expectedPort) {
    return undefined;
  }
  try {
    validateAbsoluteUrl(candidate, kind);
  } catch {
    return undefined;
  }
  return candidate;
}

/** What is wrong with a value that gets no suggestion. The scheme is never guessed. */
function missingSchemeReason(value: string): string {
  // `https//host` and `https/host` have the scheme but not its colon.
  if (schemeSlash.test(value)) {
    return "the scheme must be followed by ://";
  }
  const port = /^[A-Za-z0-9.-]+:([0-9]+)(?:\/|$)/.exec(value)?.[1];
  if (port !== undefined && !portInRange(port)) {
    return "the port must be from 1 to 65535";
  }
  // B117a (D136): `host:00080` names a port with a leading zero, which gets no suggestion (D107).
  if (port !== undefined && port.length > 1 && port.startsWith("0")) {
    return `${expectedUrl} with a host name; the port has a leading zero, so write ${Number(port)} instead of ${port}, and the scheme is not guessed`;
  }
  return `${expectedUrl} with a host name; the scheme is not guessed`;
}

/**
 * Which absolute http(s) URL a value is (D107, D123). The root URL names this installation and takes
 * no query string. The site URL (`app.site_url`, B126) is the operator's own site, and takes one, as a
 * homepage's tracking parameter does. Both take no credentials, no fragment and no control character.
 */
export type AbsoluteUrlKind = "root-url" | "site-url";

// JSON.stringify escapes the C0 controls only, so DEL and the C1 controls are escaped too (B117a, D136).
const escapeC1 = (text: string) =>
  text.replaceAll(/[\u007f-\u009f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

/** The D107 rules for an absolute http(s) URL of the given kind. The message names that kind. */
export function validateAbsoluteUrl(value: string, kind: AbsoluteUrlKind): void {
  const site = kind === "site-url";
  const name = site ? "site URL" : "root-url";
  const noun = site ? "site URL" : "root URL";
  // A value with credentials, a query or a fragment may hold a secret, so the message leaves it out.
  const withheld = /[@?#]/.test(value);
  const shown = withheld ? "(value not shown)" : escapeC1(JSON.stringify(value));
  const fail = (reason: string): never => {
    throw new Error(`Invalid ${name} ${shown}: ${reason}`);
  };

  if (/\s|\\/.test(value)) {
    fail("the value contains whitespace or a backslash; remove it");
  }
  // oxlint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f]/.test(value)) {
    fail("the value contains a control character; remove it");
  }
  // A suggestion is only for a value with no scheme at all. Any other value names its wrong part,
  // because `https://` in front of it would be wrong too (`https://https://host` is host `https`).
  if (!hasScheme(value)) {
    const suggestion = suggestionFor(value, kind);
    if (suggestion) {
      fail(`${expectedUrl}, such as ${suggestion}`);
    }
    fail(missingSchemeReason(value));
  }
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) {
    // B117a (D136): `a.b:/c` reads as a scheme `a.b` with one slash, and names that scheme.
    const scheme = value.slice(0, value.indexOf(":"));
    fail(
      schemeNames.test(value)
        ? "the scheme must be followed by //"
        : `the scheme must be followed by //, and "${scheme}" is not http or https`,
    );
  }

  let url: URL | undefined;
  try {
    url = new URL(value);
  } catch {
    url = undefined;
  }
  if (url && !["http:", "https:"].includes(url.protocol)) {
    fail("the scheme must be http:// or https://");
  }
  if (url && (url.username !== "" || url.password !== "")) {
    fail(`remove the user name and password from the URL; the ${noun} is a public address`);
  }
  if (site) {
    if (value.includes("#")) {
      fail(
        "remove the fragment; the site URL is a scheme, a host and an optional path, with an optional query string",
      );
    }
  } else if (url && (url.search !== "" || url.hash !== "")) {
    fail(
      "remove the query string and fragment; the root URL is a scheme, a host and an optional path",
    );
  }
  // URL refuses a port above 65535 and keeps 0, so the port is read from the text.
  const portText = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*:([0-9]+)(?:[/?#]|$)/.exec(value)?.[1];
  if (portText !== undefined && !portInRange(portText)) {
    fail("the port must be from 1 to 65535");
  }
  if (!url || url.host === "") {
    fail(`${expectedUrl} with a valid host name`);
  }
}

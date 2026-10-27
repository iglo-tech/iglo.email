// Bootstrap flags and configuration are adapted from listmonk's cmd/init.go and cmd/main.go.
import { isIP } from "node:net";

export interface BootstrapConfig {
  port: number;
  host: string;
  dataDir: string;
  rootUrl: string;
  initialAdmin: { user: string | undefined; password: string | undefined };
}

type Environment = Record<string, string | undefined>;
type OptionName = "--port" | "--host" | "--data-dir" | "--root-url";

type BootstrapResult = { help: true } | { help: false; config: BootstrapConfig };

const removedFlags = new Set(["--install", "--upgrade", "--config", "--new-config"]);
const optionNames = new Set<string>(["--port", "--host", "--data-dir", "--root-url"]);

export const helpText = `Usage: iglo.email [serve] [options]

Start the HTTP server. Bootstrap options override their environment equivalents:
  --port <port>          IGLO_EMAIL_PORT       Listen port (default: 9000)
  --host <host>          IGLO_EMAIL_HOST       Listen host (default: 127.0.0.1)
  --data-dir <path>      IGLO_EMAIL_DATA_DIR   Data directory (default: ./data)
  --root-url <url>       IGLO_EMAIL_ROOT_URL   Public root URL (default: http://<host>:<port>)
  --help                                        Show this help

IGLO_EMAIL_ADMIN_USER and IGLO_EMAIL_ADMIN_PASSWORD are reserved for initial
admin setup, which is not yet implemented. Credentials are not required to serve.
`;

export function parseBootstrap(args: string[], env: Environment): BootstrapResult {
  const options: Partial<Record<OptionName, string>> = {};
  let sawCommand = false;
  let help = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("-")) {
      if (arg !== "serve" || sawCommand) throw new Error(`Unknown command: ${arg}`);
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
    if (!optionNames.has(name)) throw new Error(`Unknown flag: ${name}`);

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
    options[name as OptionName] = value;
  }

  if (help) return { help: true };

  const portValue = options["--port"] ?? env.IGLO_EMAIL_PORT ?? "9000";
  if (!/^[0-9]+$/.test(portValue))
    throw new Error("Invalid port: expected an integer from 1 to 65535");
  const port = Number(portValue);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("Invalid port: expected an integer from 1 to 65535");
  }

  const host = parseHost(options["--host"] ?? env.IGLO_EMAIL_HOST ?? "127.0.0.1");
  const dataDir = options["--data-dir"] ?? env.IGLO_EMAIL_DATA_DIR ?? "./data";
  if (dataDir.trim() === "" || dataDir.includes("\0")) {
    throw new Error("Invalid data-dir: expected a non-empty path");
  }

  const urlHost = isIP(host) === 6 ? `[${host}]` : host;
  const rootUrl = options["--root-url"] ?? env.IGLO_EMAIL_ROOT_URL ?? `http://${urlHost}:${port}`;
  validateRootUrl(rootUrl);

  return {
    help: false,
    config: {
      port,
      host,
      dataDir,
      rootUrl,
      initialAdmin: { user: env.IGLO_EMAIL_ADMIN_USER, password: env.IGLO_EMAIL_ADMIN_PASSWORD },
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
  if (isIP(host)) return host;

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

function validateRootUrl(value: string): void {
  let url: URL;
  try {
    if (/\s|\\/.test(value)) throw new Error();
    url = new URL(value);
  } catch {
    throw new Error("Invalid root-url: expected an absolute HTTP or HTTPS URL");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("Invalid root-url: use HTTP or HTTPS without credentials, query, or fragment");
  }
}

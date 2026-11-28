// A small TCP proxy in front of the PocketBase harness, for the one transport fault the binary
// cannot produce on demand: a connection reset (a proxy or network cutting a stream). It forwards
// bytes unchanged; `cut()` drops every open connection at once, and `cutWhen` drops a connection
// as a request line it carries matches (a reset in the middle of a catch-up read). It never
// rewrites or invents a byte of PocketBase's protocol.
import type { Socket } from "bun";

interface Pair {
  client: Socket<Side>;
  upstream?: Socket<Side> | undefined;
  /** Bytes from the client while the upstream connection opens. */
  early: Array<Uint8Array>;
  /** The proxy's local port of the upstream connection, once open. */
  upstreamPort?: number;
  closed: boolean;
}
interface Side {
  pair: Pair;
  /** Bytes the socket did not take yet, written on drain. */
  backlog: Array<Uint8Array>;
}

function write(socket: Socket<Side>, chunk: Uint8Array) {
  const { backlog } = socket.data;
  if (backlog.length) {
    backlog.push(chunk);
    return;
  }
  const written = socket.write(chunk);
  if (written < chunk.byteLength) {
    backlog.push(chunk.subarray(Math.max(0, written)));
  }
}

function drain(socket: Socket<Side>) {
  const { backlog } = socket.data;
  for (let chunk = backlog[0]; chunk; chunk = backlog[0]) {
    const written = socket.write(chunk);
    if (written < chunk.byteLength) {
      backlog[0] = chunk.subarray(Math.max(0, written));
      return;
    }
    backlog.shift();
  }
}

export interface CutProxy {
  readonly url: string;
  /** Resets every open connection. */
  cut(): void;
  /** Resets a connection when a request line it sends matches (e.g. the second catch-up page). */
  cutWhen(match: ((line: string) => boolean) | undefined): void;
  /** How many connections were reset. */
  readonly cuts: number;
  /** The request lines seen, oldest first. */
  readonly requests: ReadonlyArray<string>;
  stop(): void;
}

/**
 * `onUpstreamClose` is told the proxy's local port of a connection the target closed (not one the
 * proxy cut or the client closed), after the bytes the target sent before its close were received.
 */
export function startCutProxy(
  targetPort: number,
  onUpstreamClose?: (port: number) => void,
): CutProxy {
  const pairs = new Set<Pair>();
  let cuts = 0;
  let matcher: ((line: string) => boolean) | undefined;
  const requests: Array<string> = [];
  const drop = (pair: Pair) => {
    if (pair.closed) {
      return;
    }
    pair.closed = true;
    pairs.delete(pair);
    pair.client.terminate();
    pair.upstream?.terminate();
  };
  const listener = Bun.listen<Side>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(client) {
        const pair: Pair = { client, early: [], closed: false };
        client.data = { pair, backlog: [] };
        pairs.add(pair);
        void Bun.connect<Side>({
          hostname: "127.0.0.1",
          port: targetPort,
          socket: {
            open(upstream) {
              upstream.data = { pair, backlog: [] };
              if (pair.closed) {
                upstream.terminate();
                return;
              }
              pair.upstream = upstream;
              pair.upstreamPort = upstream.localPort;
              for (const chunk of pair.early.splice(0)) {
                write(upstream, chunk);
              }
            },
            data(_upstream, chunk) {
              if (!pair.closed) {
                write(client, chunk);
              }
            },
            drain,
            close() {
              if (!pair.closed) {
                pair.closed = true;
                pairs.delete(pair);
                client.end();
                if (pair.upstreamPort !== undefined) {
                  onUpstreamClose?.(pair.upstreamPort);
                }
              }
            },
            error() {
              drop(pair);
            },
            connectError() {
              drop(pair);
            },
          },
        }).catch(() => drop(pair));
      },
      data(client, chunk) {
        const { pair } = client.data;
        const text = Buffer.from(chunk.subarray(0, 512)).toString("latin1");
        const line = /^(GET|POST|PATCH|DELETE|PUT) [^\r\n]*/.exec(text)?.[0];
        if (line) {
          requests.push(line);
          if (matcher?.(line)) {
            cuts++;
            drop(pair);
            return;
          }
        }
        if (pair.upstream) {
          write(pair.upstream, chunk);
        } else {
          pair.early.push(chunk);
        }
      },
      drain,
      close(client) {
        const { pair } = client.data;
        if (!pair.closed) {
          pair.closed = true;
          pairs.delete(pair);
          pair.upstream?.end();
        }
      },
      error(client) {
        drop(client.data.pair);
      },
    },
  });
  return {
    url: `http://127.0.0.1:${listener.port}`,
    cut() {
      for (const pair of pairs) {
        cuts++;
        drop(pair);
      }
    },
    cutWhen(match) {
      matcher = match;
    },
    get cuts() {
      return cuts;
    },
    requests,
    stop() {
      for (const pair of pairs) {
        drop(pair);
      }
      listener.stop(true);
    },
  };
}

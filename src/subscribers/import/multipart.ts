// Native: a multipart/form-data reader that streams one file to disk, as Request.formData() would
// hold it in memory. The form it reads is the one of listmonk cmd/import.go at 6fcd95f, and like
// Go's FormFile and FormValue it takes the first `file` part with a filename and the first
// `params` part without one. Anything else in the form is read past.
import type { FileHandle } from "node:fs/promises";

const CRLF = Buffer.from("\r\n");
const HEADERS_END = Buffer.from("\r\n\r\n");
const MAX_HEADER_BYTES = 16 * 1024;
const MAX_PARAMS_BYTES = 64 * 1024;

/** The body is not a complete form. Go's FormValue finds nothing in it. */
export class MalformedForm extends Error {}
export class UploadTooLarge extends Error {}

export interface ReceivedForm {
  params?: string;
  /** The name the file was uploaded under, if the form held one. */
  filename?: string;
}

async function write(file: FileHandle, bytes: Uint8Array) {
  for (let done = 0; done < bytes.length;)
    done += (await file.write(bytes, done, bytes.length - done)).bytesWritten;
}
const disposition = (headers: string, key: string) => {
  const line = /^content-disposition:(.*)$/im.exec(headers)?.[1] ?? "";
  const match = new RegExp(`(?:^|[;\\s])${key}=(?:"((?:[^"\\\\]|\\\\.)*)"|([^;\\s]*))`, "i").exec(
    line,
  );
  if (!match) return undefined;
  return match[1]?.replace(/\\(.)/g, "$1") ?? match[2];
};

export function multipartBoundary(contentType: string | null): string | undefined {
  if (!contentType || !/^\s*multipart\/form-data\s*(;|$)/i.test(contentType)) return undefined;
  const boundary = /;\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  const value = boundary?.[1] ?? boundary?.[2];
  return value && value.length <= 200 ? value : undefined;
}

/** Stream `body` into `file`, stopping with the upload limit or `signal`. */
export async function receiveForm(
  body: ReadableStream<Uint8Array>,
  boundary: string,
  file: FileHandle,
  maxBytes: number,
  signal: AbortSignal,
): Promise<ReceivedForm> {
  const first = Buffer.from(`--${boundary}`);
  const next = Buffer.from(`\r\n--${boundary}`);
  const form: ReceivedForm = {};
  let pending: Buffer = Buffer.alloc(0);
  let state = "preamble" as "preamble" | "boundary" | "headers" | "body" | "done";
  let target: "file" | "params" | "none" = "none";
  let params: Buffer[] = [];
  let paramsSize = 0;
  let received = 0;
  const emit = async (bytes: Uint8Array) => {
    if (target === "file") await write(file, bytes);
    else if (target === "params") {
      paramsSize += bytes.length;
      if (paramsSize > MAX_PARAMS_BYTES) throw new MalformedForm();
      params.push(Buffer.from(bytes));
    }
  };
  const openPart = (headers: string) => {
    const name = disposition(headers, "name");
    const filename = disposition(headers, "filename");
    target = "none";
    if (name === "file" && filename && form.filename === undefined) {
      form.filename = filename.slice(filename.lastIndexOf("/") + 1);
      target = "file";
    } else if (name === "params" && filename === undefined && form.params === undefined) {
      params = [];
      target = "params";
    }
  };
  const closePart = () => {
    if (target === "params") form.params = Buffer.concat(params).toString("utf8");
    target = "none";
  };
  const consume = async () => {
    while (state !== "done") {
      if (state === "preamble") {
        const at = pending.indexOf(first);
        if (at < 0) {
          pending = pending.subarray(Math.max(0, pending.length - first.length + 1));
          return;
        }
        pending = pending.subarray(at + first.length);
        state = "boundary";
      } else if (state === "boundary") {
        if (pending.length < 2) return;
        if (pending[0] === 45 && pending[1] === 45) {
          state = "done";
          return;
        }
        const at = pending.indexOf(CRLF);
        if (at < 0) {
          if (pending.length > 1024) throw new MalformedForm();
          return;
        }
        // Keep the line break: a part without headers starts with the blank line.
        pending = pending.subarray(at);
        state = "headers";
      } else if (state === "headers") {
        const at = pending.indexOf(HEADERS_END);
        if (at < 0) {
          if (pending.length > MAX_HEADER_BYTES) throw new MalformedForm();
          return;
        }
        openPart(pending.toString("utf8", 0, at));
        pending = pending.subarray(at + HEADERS_END.length);
        state = "body";
      } else {
        const at = pending.indexOf(next);
        if (at >= 0) {
          await emit(pending.subarray(0, at));
          closePart();
          pending = pending.subarray(at + next.length);
          state = "boundary";
        } else {
          // The end of this chunk may be the start of the boundary.
          const safe = pending.length - next.length + 1;
          if (safe > 0) {
            await emit(pending.subarray(0, safe));
            pending = pending.subarray(safe);
          }
          return;
        }
      }
    }
  };
  const reader = body.getReader();
  let onAbort = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  void aborted.catch(() => {});
  try {
    while (true) {
      const read = reader.read().catch(() => {
        // The client went away or stalled past the server's idle limit.
        throw new MalformedForm();
      });
      const item = await Promise.race([read, aborted]);
      if (item.done) break;
      received += item.value.length;
      if (received > maxBytes) throw new UploadTooLarge();
      pending = pending.length
        ? Buffer.concat([pending, item.value])
        : Buffer.from(item.value.buffer, item.value.byteOffset, item.value.length);
      await consume();
      if (state === "done") break;
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    await reader.cancel().catch(() => {});
  }
  if (state !== "done") throw new MalformedForm();
  return form;
}

// Adapted from Go 1.27.2 src/encoding/csv/reader.go, the reader listmonk's importer uses, as a
// push parser over bytes, so a file is read in chunks and a field's encoding is checked later.
// Copyright 2011 The Go Authors. See assets/licenses/go-1.27.2-BSD.txt for the complete license.

const QUOTE = 34,
  LF = 10,
  CR = 13;
/**
 * The longest record, so an unclosed quote cannot hold the rest of a file in memory. A field's
 * delimiter counts as a byte, since its offset is held like the text.
 */
export const MAX_RECORD_BYTES = 1024 * 1024;
/** The widest record, checked before an offset is kept. Spreadsheets stop at this many columns. */
export const MAX_RECORD_FIELDS = 16_384;

export class CsvError extends Error {}

/** One record, valid only during the call that receives it. */
export interface CsvRecord {
  count: number;
  field(index: number): Buffer;
}

/** Go's validDelim, for the ASCII delimiters a parameter of one byte can name. */
export const validDelimiter = (byte: number) =>
  byte !== 0 && byte !== QUOTE && byte !== CR && byte !== LF;

export function createCsvReader(delimiter: number, onRecord: (record: CsvRecord) => void) {
  let buffer = Buffer.allocUnsafe(64 * 1024);
  let size = 0;
  let ends: number[] = [];
  let state: "start" | "plain" | "quoted" | "quote" = "start";
  let carriage = false;
  let newlines = 0;
  let last = 0;
  const record: CsvRecord = {
    get count() {
      return ends.length;
    },
    field: (index) => buffer.subarray(index ? ends[index - 1]! : 0, ends[index]!),
  };
  const fail = (message: string) => new CsvError(`parse error on line ${newlines + 1}: ${message}`);
  const overBudget = () => fail(`record over ${MAX_RECORD_BYTES} bytes`);
  const append = (byte: number) => {
    if (size + ends.length >= MAX_RECORD_BYTES) throw overBudget();
    if (size === buffer.length)
      buffer = Buffer.concat([buffer], Math.min(size * 2, MAX_RECORD_BYTES));
    buffer[size++] = byte;
  };
  const endField = () => {
    if (ends.length === MAX_RECORD_FIELDS) throw fail(`record over ${MAX_RECORD_FIELDS} fields`);
    if (size + ends.length >= MAX_RECORD_BYTES) throw overBudget();
    ends.push(size);
    state = "start";
  };
  const endRecord = () => {
    endField();
    onRecord(record);
    ends = [];
    size = 0;
  };
  const step = (byte: number) => {
    if (byte === LF) newlines++;
    switch (state) {
      case "start":
        if (byte === QUOTE) state = "quoted";
        else if (byte === delimiter) endField();
        else if (byte !== LF) {
          state = "plain";
          append(byte);
        } else if (ends.length) endRecord();
        return;
      case "plain":
        if (byte === delimiter) endField();
        else if (byte === LF) endRecord();
        else if (byte === QUOTE) throw fail('bare " in non-quoted field');
        else append(byte);
        return;
      case "quoted":
        if (byte === QUOTE) state = "quote";
        else append(byte);
        return;
      case "quote":
        if (byte === QUOTE) {
          state = "quoted";
          append(byte);
        } else if (byte === delimiter) endField();
        else if (byte === LF) endRecord();
        else throw fail('extraneous or missing " in quoted-field');
    }
  };
  return {
    push(chunk: Uint8Array) {
      for (let i = 0; i < chunk.length; i++) {
        const byte = chunk[i]!;
        // A CR is part of the text unless a LF follows it.
        if (carriage) {
          carriage = false;
          if (byte !== LF) step(CR);
        }
        if (byte === CR) carriage = true;
        else step(byte);
      }
      if (chunk.length) last = chunk[chunk.length - 1]!;
    },
    end() {
      if (state === "quoted") throw fail('extraneous or missing " in quoted-field');
      if (state !== "start" || ends.length) endRecord();
    },
    /** listmonk's countLines: line breaks, and an unfinished last line. */
    lines: () => newlines + (last !== 0 && last !== LF ? 1 : 0),
  };
}

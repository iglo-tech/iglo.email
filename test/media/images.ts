// Small valid images, built byte by byte, for media tests.
import { crc32, deflateSync } from "node:zlib";

const bytes = (hex: string) => Buffer.from(hex.replace(/\s/g, ""), "hex");

export const imagePngSize = { width: 3, height: 2 };
export const imagePng = Uint8Array.from(
  (() => {
    const chunk = (type: string, data: Buffer) => {
      const body = Buffer.concat([Buffer.from(type), data]);
      const length = Buffer.alloc(4);
      length.writeUInt32BE(data.length);
      const check = Buffer.alloc(4);
      check.writeUInt32BE(crc32(body));
      return Buffer.concat([length, body, check]);
    };
    const header = Buffer.alloc(13);
    header.writeUInt32BE(imagePngSize.width, 0);
    header.writeUInt32BE(imagePngSize.height, 4);
    header.set([8, 0, 0, 0, 0], 8);
    const rows = Buffer.alloc((imagePngSize.width + 1) * imagePngSize.height, 0);
    return Buffer.concat([
      bytes("89504e470d0a1a0a"),
      chunk("IHDR", header),
      chunk("IDAT", deflateSync(rows)),
      chunk("IEND", Buffer.alloc(0)),
    ]);
  })(),
);
/** 2×1. */
export const imageGif = Uint8Array.from(
  bytes(
    "474946383961 0200 0100 800000 000000 ffffff 2c00000000 0200 0100 00 0202 0c0a 00 3b".replace(
      /\s/g,
      "",
    ),
  ),
);
/** 1×1, with an APP0 segment and tables before its frame header. */
export const imageJpeg = Uint8Array.from(
  bytes(`ffd8ffe000104a46494600010100000100010000
    ffdb00430001010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101
    ffc0000b080001000101011100
    ffc4001f0000010501010101010100000000000000000102030405060708090a0b
    ffc400b5100002010303020403050504040000017d01020300041105122131410613516107227114328191a1082342b1c11552d1f02433627282090a161718191a25262728292a3435363738393a434445464748494a535455565758595a636465666768696a737475767778797a838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae1e2e3e4e5e6e7e8e9eaf1f2f3f4f5f6f7f8f9fa
    ffda0008010100003f002bffd9`),
);

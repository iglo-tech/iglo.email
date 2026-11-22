// The part of pngjs (a transitive dependency of qrcode, not a direct one) that verify-qr.ts reads: a synchronous PNG decode.
declare module "pngjs" {
  export class PNG {
    static sync: { read(buffer: Buffer): { width: number; height: number; data: Buffer } };
  }
}

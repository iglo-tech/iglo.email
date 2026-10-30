// Native replacement for the `image.DecodeConfig` part of listmonk's cmd/media.go: processImage.
// The header is read without decoding pixels, so no image library is needed. A file it cannot
// read still uploads, without dimensions.

function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 2;
  while (at + 9 <= bytes.length) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1]!;
    // Fill bytes before a marker, and standalone markers without a length.
    if (marker === 0xff) {
      at++;
      continue;
    }
    if (marker >= 0xd0 && marker <= 0xd9) {
      at += 2;
      continue;
    }
    // SOF0-SOF15, except DHT, JPG and DAC, which share the range.
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
      return { width: view.getUint16(at + 7), height: view.getUint16(at + 5) };
    if (marker === 0xda) return null;
    at += 2 + view.getUint16(at + 2);
  }
  return null;
}

/** The dimensions of a PNG, GIF or JPEG, or null when the header does not give them. */
export function imageSize(bytes: Uint8Array): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));
  if (bytes.length >= 24 && text(1, 4) === "PNG" && text(12, 16) === "IHDR")
    return { width: view.getUint32(16), height: view.getUint32(20) };
  if (bytes.length >= 10 && (text(0, 6) === "GIF87a" || text(0, 6) === "GIF89a"))
    return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) return jpegSize(bytes);
  return null;
}

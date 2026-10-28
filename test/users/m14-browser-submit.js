(async () => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("12345678901234567890"),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const counter = new Uint8Array(8);
  new DataView(counter.buffer).setBigUint64(0, BigInt(Math.floor(Date.now() / 30000)));
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, counter));
  const offset = digest[19] & 15;
  document.querySelector("#totp_code").value = String(
    (new DataView(digest.buffer).getUint32(offset) & 0x7fffffff) % 1000000,
  ).padStart(6, "0");
  document.querySelector("form").requestSubmit();
  return { submitted: true };
})();

(async () => {
  const profile = await (await fetch("/api/profile")).json();
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
  const code = String(
    (new DataView(digest.buffer).getUint32(offset) & 0x7fffffff) % 1000000,
  ).padStart(6, "0");
  const csrf =
    document.cookie
      .split("; ")
      .find((v) => v.startsWith("csrf="))
      ?.slice(5) || "";
  const enabled = await fetch(`/api/users/${profile.data.id}/twofa`, {
    method: "PUT",
    headers: { "content-type": "application/json", "x-csrf-token": csrf },
    body: JSON.stringify({ secret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", code }),
  });
  const csrfDenied = await fetch("/api/logout", { method: "POST" });
  const logout = await fetch("/api/logout", { method: "POST", headers: { "x-csrf-token": csrf } });
  return { enabled: enabled.status, csrfDenied: csrfDenied.status, logout: logout.status };
})();

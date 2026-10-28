// Validation adapted from Go 1.27.2 net/url/url.go and gen_encoding_table.go.
// Copyright The Go Authors; the BSD notice is embedded from assets/licenses/go-1.27.2-BSD.txt.
import { isIP } from "node:net";

const hostChars = /^[A-Za-z0-9!$&'()*+,;=:\[\]<>"_.~\-]$/;
const escaped = (s: string) => !/%(?![0-9a-fA-F]{2})/.test(s);
function hostPartValid(s: string, zone = false): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === "%") {
      const hex = s.slice(i + 1, i + 3);
      if (!/^[0-9a-fA-F]{2}$/.test(hex)) return false;
      const n = parseInt(hex, 16);
      if (
        zone
          ? n !== 37 && n !== 32 && n < 128 && !hostChars.test(String.fromCharCode(n))
          : n < 128 && n !== 37
      )
        return false;
      i += 2;
    } else if (c.charCodeAt(0) < 128 && !hostChars.test(c)) return false;
  }
  return true;
}

// url.Parse lowercases the scheme, retains the original value for storage and
// validates path and fragment escapes, but does not parse query escapes.
export function validTrustedURL(input: string): boolean {
  const [withoutFragment, ...fragmentParts] = input.split("#");
  const fragment = fragmentParts.join("#");
  if (/[\x00-\x1f\x7f]/.test(withoutFragment!) || !escaped(fragment)) return false;
  const match = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?]*)([^?]*)(?:\?.*)?$/s.exec(withoutFragment!);
  if (!match || !["http", "https"].includes(match[1]!.toLowerCase())) return false;
  const authority = match[2]!;
  const at = authority.lastIndexOf("@");
  if (at >= 0) {
    const user = authority.slice(0, at);
    if (!/^[A-Za-z0-9\-._:~!$&'()*+,;=%@]*$/.test(user) || !escaped(user)) return false;
  }
  const host = authority.slice(at + 1);
  if (!host || !escaped(match[3]!)) return false;
  const bracket = host.lastIndexOf("[");
  if (bracket > 0) return false;
  if (bracket === 0) {
    const close = host.lastIndexOf("]");
    if (close < 0 || !/^(?::[0-9]*)?$/.test(host.slice(close + 1))) return false;
    const literal = host.slice(1, close);
    const zone = literal.indexOf("%25");
    if (
      !(zone < 0
        ? hostPartValid(literal)
        : hostPartValid(literal.slice(0, zone)) && hostPartValid(literal.slice(zone), true))
    )
      return false;
    // netip.ParseAddr permits a nonempty IPv6 zone but not an IPv4 literal.
    const address = zone < 0 ? literal : literal.slice(0, zone);
    const zoneName = zone < 0 ? "" : literal.slice(zone + 3);
    return isIP(address) === 6 && (zone < 0 || zoneName.length > 0);
  }
  const colon = host.indexOf(":");
  if (colon >= 0 && !/^:[0-9]*$/.test(host.slice(colon))) return false;
  return hostPartValid(host);
}

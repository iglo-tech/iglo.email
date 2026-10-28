// Optional Linux host check: independently decode a compiled provisioning PNG with libzbar.
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { withProduction } from "@/test/contract/owned";

const { PNG } = require("pngjs") as {
  PNG: { sync: { read(value: Buffer): { width: number; height: number; data: Buffer } } };
};
const root = resolve(import.meta.dir, "../..");
const fixture = await readFile(resolve(root, "test/users/fixtures.md"), "utf8");
const user = /^IGLO_EMAIL_ADMIN_USER=(.+)$/m.exec(fixture)?.[1];
const password = /^IGLO_EMAIL_ADMIN_PASSWORD=(.+)$/m.exec(fixture)?.[1];
if (!user || !password) throw new Error("Missing synthetic fixture");
function cookie(response: Response, name: string) {
  return (
    response.headers
      .getSetCookie()
      .find((c) => c.startsWith(`${name}=`))
      ?.split(";", 1)[0] ?? ""
  );
}
await withProduction(
  resolve(root, "dist/iglo.email"),
  AbortSignal.timeout(30000),
  async (origin) => {
    const page = await fetch(`${origin}/admin/login`);
    const nonce = /name="nonce"\s+value="([^"]+)"/.exec(await page.text())?.[1] ?? "";
    const login = await fetch(`${origin}/admin/login`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: cookie(page, "nonce"),
      },
      body: new URLSearchParams({ username: user, password, nonce }),
    });
    const session = cookie(login, "session");
    const profile = await fetch(`${origin}/api/profile`, { headers: { cookie: session } });
    const id = ((await profile.json()) as { data: { id: number } }).data.id;
    const response = await fetch(`${origin}/api/users/${id}/twofa/totp`, {
      headers: { cookie: session },
    });
    if (response.status !== 200) throw new Error("QR provisioning failed");
    const data = ((await response.json()) as { data: { qr: string; secret: string } }).data;
    const image = PNG.sync.read(Buffer.from(data.qr, "base64"));
    const grayscale = Buffer.alloc(image.width * image.height);
    for (let i = 0; i < grayscale.length; i++) grayscale[i] = image.data[i * 4]!;
    const python = `import base64,ctypes,ctypes.util,json,sys,urllib.parse
v=json.load(sys.stdin); z=ctypes.CDLL(ctypes.util.find_library('zbar'))
def decl(n,r,*a):
 f=getattr(z,n); f.restype=r; f.argtypes=a; return f
p=ctypes.c_void_p; u=ctypes.c_uint
scanner=decl('zbar_image_scanner_create',p)(); image=decl('zbar_image_create',p)()
decl('zbar_image_set_format',None,p,u)(image,0x30303859)
decl('zbar_image_set_size',None,p,u,u)(image,v['width'],v['height'])
buf=ctypes.create_string_buffer(base64.b64decode(v['pixels']))
decl('zbar_image_set_data',None,p,p,ctypes.c_ulong,p)(image,ctypes.cast(buf,p),len(buf)-1,None)
count=decl('zbar_scan_image',ctypes.c_int,p,p)(scanner,image)
symbol=decl('zbar_image_first_symbol',p,p)(image)
if count != 1 or not symbol: raise SystemExit(1)
text=decl('zbar_symbol_get_data',ctypes.c_char_p,p)(symbol).decode(); uri=urllib.parse.urlparse(text); q=urllib.parse.parse_qs(uri.query)
assert uri.scheme=='otpauth' and uri.netloc=='totp' and urllib.parse.unquote(uri.path)=='/iglo.email:initial-admin@localhost.invalid'
assert q=={'secret':[v['secret']],'issuer':['iglo.email'],'period':['30'],'digits':['6'],'algorithm':['SHA1']}
decl('zbar_image_destroy',None,p)(image); decl('zbar_image_scanner_destroy',None,p)(scanner)
`;
    const decoded = spawnSync("python3", ["-c", python], {
      input: JSON.stringify({
        width: image.width,
        height: image.height,
        pixels: grayscale.toString("base64"),
        secret: data.secret,
      }),
      encoding: "utf8",
    });
    if (decoded.status !== 0) throw new Error("Independent QR decoding failed");
    process.stdout.write("Compiled provisioning QR decoded and URI verified\n");
  },
  { user, password },
);

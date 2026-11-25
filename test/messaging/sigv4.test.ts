// B145a (14-projects section 15, "Signer"): the in-house SigV4 signer against AWS's published
// Signature Version 4 test suite (awslabs/aws-c-auth, tests/aws-signing-test-suite/v4, the
// header-signed cases). Every case signs with the suite's credentials, region, service and time.
import { describe, expect, test } from "bun:test";
import { amzDate, signParts } from "@/messaging/sigv4";

const suite = {
  region: "us-east-1",
  service: "service",
  credentials: {
    accessKeyId: "AKIDEXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
  },
  date: new Date("2015-08-30T12:36:00Z"),
};
const host = { Host: "example.amazonaws.com" };

describe("SigV4 test suite", () => {
  test("get-vanilla", async () => {
    const parts = await signParts({
      ...suite,
      method: "GET",
      url: "https://example.amazonaws.com/",
      headers: host,
    });
    expect(parts.canonicalRequest).toBe(
      [
        "GET",
        "/",
        "",
        "host:example.amazonaws.com",
        "x-amz-date:20150830T123600Z",
        "",
        "host;x-amz-date",
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      ].join("\n"),
    );
    expect(parts.stringToSign).toBe(
      [
        "AWS4-HMAC-SHA256",
        "20150830T123600Z",
        "20150830/us-east-1/service/aws4_request",
        "bb579772317eb040ac9ed261061d46c1f17a8133879d6129b6e1c25292927e63",
      ].join("\n"),
    );
    expect(parts.signature).toBe(
      "5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
    );
    expect(parts.headers.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
    );
    expect(parts.headers["x-amz-date"]).toBe("20150830T123600Z");
  });

  test("get-vanilla-query-order-key-case", async () => {
    const parts = await signParts({
      ...suite,
      method: "GET",
      url: "https://example.amazonaws.com/?Param2=value2&Param1=value1",
      headers: host,
    });
    expect(parts.canonicalRequest.split("\n")[2]).toBe("Param1=value1&Param2=value2");
    expect(parts.stringToSign.split("\n")[3]).toBe(
      "816cd5b414d056048ba4f7c5386d6e0533120fb1fcfa93762cf0fc39e2cf19e0",
    );
    expect(parts.signature).toBe(
      "b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500",
    );
  });

  test("get-vanilla-query-unreserved", async () => {
    const unreserved = "-._~0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    const parts = await signParts({
      ...suite,
      method: "GET",
      url: `https://example.amazonaws.com/?${unreserved}=${unreserved}`,
      headers: host,
    });
    expect(parts.signature).toBe(
      "9c3e54bfcdf0b19771a7f523ee5669cdf59bc7cc0884027167c21bb143a40197",
    );
  });

  test("get-utf8", async () => {
    const parts = await signParts({
      ...suite,
      method: "GET",
      url: "https://example.amazonaws.com/ሴ",
      headers: host,
    });
    expect(parts.canonicalRequest.split("\n")[1]).toBe("/%E1%88%B4");
    expect(parts.signature).toBe(
      "8318018e0b0f223aa2bbf98705b62bb787dc9c0e678f255a891fd03141be5d85",
    );
  });

  test("get-header-value-trim", async () => {
    const parts = await signParts({
      ...suite,
      method: "GET",
      url: "https://example.amazonaws.com/",
      headers: { ...host, "My-Header1": " value1", "My-Header2": ' "a   b   c"' },
    });
    expect(parts.signature).toBe(
      "acc3ed3afb60bb290fc8d2dd0098b9911fcaa05412b367055dee359757a9c736",
    );
  });

  test("post-header-key-sort", async () => {
    const parts = await signParts({
      ...suite,
      method: "POST",
      url: "https://example.amazonaws.com/",
      headers: { ...host, "My-Header1": "value1" },
    });
    expect(parts.signature).toBe(
      "c5410059b04c1ee005303aed430f6e6645f61f4dc9e1461ec8f8916fdf18852c",
    );
  });

  test("post-x-www-form-urlencoded (signed body)", async () => {
    const parts = await signParts({
      ...suite,
      method: "POST",
      url: "https://example.amazonaws.com/",
      headers: {
        ...host,
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": "13",
        "X-Amz-Content-Sha256": "9095672bbd1f56dfc5b65f3e153adc8731a4a654192329106275f4c7b24d0b6e",
      },
      body: "Param1=value1",
    });
    expect(parts.stringToSign.split("\n")[3]).toBe(
      "b1edd1d03544c25390e32085d55b57acc9a3961bb59415ff86c45c3d89d16cfb",
    );
    expect(parts.signature).toBe(
      "d3875051da38690788ef43de4db0d8f280229d82040bfac253562e56c3f20e0b",
    );
  });

  test("the host comes from the URL when it is not given, and the date has no separators", async () => {
    const parts = await signParts({
      ...suite,
      method: "GET",
      url: "https://example.amazonaws.com/",
    });
    expect(parts.signature).toBe(
      "5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
    );
    expect(amzDate(new Date("2026-11-25T09:08:07.654Z"))).toBe("20261125T090807Z");
  });
});

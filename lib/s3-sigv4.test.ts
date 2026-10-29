import assert from "node:assert/strict";
import test from "node:test";

import { signS3Request } from "./s3-sigv4";

// The "GET Object" example of the AWS S3 SigV4 documentation (header-based authentication).
test("signs the documented S3 GET Object example", () => {
  const headers = signS3Request("GET", new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
    { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", region: "us-east-1" },
    new Date("2013-05-24T00:00:00Z"), { range: "bytes=0-9" });
  assert.equal(headers.authorization,
    "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, " +
    "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, " +
    "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
  assert.equal(headers["x-amz-date"], "20130524T000000Z");
  assert.equal(headers.host, undefined, "fetch sets Host itself");
});

test("refuses a URL with a query string", () => {
  assert.throws(() => signS3Request("HEAD", new URL("https://s3.cloud.ru/b/k?x=1"),
    { accessKeyId: "a", secretAccessKey: "b", region: "ru-central-1" }, new Date()), /query/);
});

// No secret in the static bundle (ART-363). The Control Room is public static files: anything that
// looks like a credential, a private address or a server-side configuration name fails the build.
// Usage: node scripts/check-bundle.mjs <dir>
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export const FORBIDDEN = [
  ["database URL", /postgres(ql)?:\/\//i],
  ["server-side variable", /\b(ADMIN_TOTP_KEY|ADMIN_DATABASE_URL|ADMIN_OPERATOR_DATABASE_URL|OPERATOR_DATABASE_URL|DATABASE_URL|REFREF_API_KEY|NOTISEND_API_KEY|COOLIFY_[A-Z_]+|AWS_SECRET_ACCESS_KEY|S3_SECRET_ACCESS_KEY)\b/],
  ["GitHub token", /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}/],
  ["AWS-style access key", /\b(AKIA|ASIA)[A-Z0-9]{16}\b/],
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["Refref API key", /\brk_(live|test)_[A-Za-z0-9]{16,}/],
  ["password hash", /scrypt:v1:16384:8:1:/],
  ["public env inlined", /NEXT_PUBLIC_[A-Z_]+/],
];

export function findings(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (!/\.(html|js|mjs|css|json|txt|map|svg)$/.test(name)) continue;
      const text = readFileSync(p, "utf8");
      for (const [label, pattern] of FORBIDDEN) if (pattern.test(text)) out.push(`${relative(dir, p)}: ${label}`);
    }
  };
  walk(dir);
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2] ?? "out";
  const found = findings(dir);
  if (found.length > 0) {
    console.error(`Secrets or server configuration in the static bundle:\n${found.join("\n")}`);
    process.exit(1);
  }
  console.log(`check-bundle: ${dir} has no secret`);
}

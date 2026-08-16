#!/usr/bin/env node
/**
 * GitHub OAuth token-exchange broker for Sveltia CMS's `github` backend.
 *
 * Sveltia's config parser hard-rejects `auth_type: pkce` for GitHub (GitHub
 * OAuth Apps require a client-secret exchange, which cannot happen in the
 * browser), so this tiny external service is mandatory, not optional — see
 * docs/DECISIONS.md and RUNBOOK.md. Zero dependencies on purpose: this is the
 * one place in the project that holds a GitHub OAuth client secret, so it
 * stays small enough to read end to end in one sitting.
 *
 * Implements the exact "server-side Authorization Code Flow" wire protocol
 * Sveltia's own client expects (popup window + postMessage handshake,
 * cookie-based CSRF token, GET /auth then GET /callback) — ported from
 * Sveltia's reference implementation, github.com/sveltia/sveltia-cms-auth
 * (MIT), which targets Cloudflare Workers; this is the same protocol on
 * plain Node so it can run as a regular container next to the site.
 *
 * Required env vars: GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, ALLOWED_DOMAINS
 * (comma-separated hostnames; `*` wildcard supported, e.g. `*.example.com`).
 * This service mints repo,user-scoped tokens — full read/write on every repo
 * the authenticating GitHub user can reach — so it fails closed: it refuses
 * to start at all without an explicit allowlist, rather than defaulting to
 * "any site may use this broker".
 * Optional: PORT (default 8787), GITHUB_HOSTNAME (default github.com).
 */
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const PORT = process.env.PORT ?? 8787;
const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID;
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET;
const GITHUB_HOSTNAME = process.env.GITHUB_HOSTNAME ?? "github.com";
const ALLOWED_DOMAINS = process.env.ALLOWED_DOMAINS?.split(",").map((s) => s.trim()).filter(Boolean);

if (!GITHUB_CLIENT_ID || !GITHUB_CLIENT_SECRET || !ALLOWED_DOMAINS || ALLOWED_DOMAINS.length === 0) {
  console.error(
    "[oauth-broker] refusing to start: GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET and ALLOWED_DOMAINS " +
      "(comma-separated, non-empty) must all be set. This service holds a GitHub OAuth client secret and " +
      "mints repo-scoped tokens, so it never runs with an unrestricted allowlist.",
  );
  process.exit(1);
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isDomainAllowed(domain) {
  return ALLOWED_DOMAINS.some((pattern) => new RegExp(`^${escapeRegExp(pattern).replaceAll("\\*", ".+")}$`).test(domain ?? ""));
}

/** HTML response that relays the result to the Sveltia popup's window.opener via postMessage. */
function outputHTML(res, { token, error, errorCode } = {}) {
  const state = error ? "error" : "success";
  const content = error ? { provider: "github", error, errorCode } : { provider: "github", token };
  // Defense in depth: GitHub's own error vocabulary can't contain `</script>`,
  // but nothing enforces that at this call site, so escape `<` before this
  // goes into an inline <script> block rather than assume it always will.
  const payload = JSON.stringify(content).replace(/</g, "\\u003c");

  res.writeHead(200, {
    "Content-Type": "text/html;charset=UTF-8",
    "Set-Cookie": "csrf-token=deleted; HttpOnly; Max-Age=0; Path=/; SameSite=Lax; Secure",
  });
  res.end(`<!doctype html><html><body><script>
    (() => {
      window.addEventListener('message', ({ data, origin }) => {
        if (data === 'authorizing:github') {
          window.opener?.postMessage('authorization:github:${state}:${payload}', origin);
        }
      });
      window.opener?.postMessage('authorizing:github', '*');
    })();
  </script></body></html>`);
}

function handleAuth(url, res) {
  const { site_id: domain } = Object.fromEntries(url.searchParams);

  if (!isDomainAllowed(domain)) {
    return outputHTML(res, { error: "Your domain is not allowed to use the authenticator.", errorCode: "UNSUPPORTED_DOMAIN" });
  }

  const csrfToken = randomUUID().replaceAll("-", "");
  const params = new URLSearchParams({ client_id: GITHUB_CLIENT_ID, scope: "repo,user", state: csrfToken });

  res.writeHead(302, {
    Location: `https://${GITHUB_HOSTNAME}/login/oauth/authorize?${params}`,
    "Set-Cookie": `csrf-token=${csrfToken}; HttpOnly; Path=/; Max-Age=600; SameSite=Lax; Secure`,
  });
  res.end();
}

async function handleCallback(url, req, res) {
  const { code, state } = Object.fromEntries(url.searchParams);
  const cookieHeader = req.headers.cookie ?? "";
  const csrfToken = cookieHeader.match(/\bcsrf-token=([0-9a-f]{32})\b/)?.[1];

  if (!code || !state) {
    return outputHTML(res, { error: "Failed to receive an authorization code. Please try again later.", errorCode: "AUTH_CODE_REQUEST_FAILED" });
  }
  if (!csrfToken || state !== csrfToken) {
    return outputHTML(res, { error: "Potential CSRF attack detected. Authentication flow aborted.", errorCode: "CSRF_DETECTED" });
  }

  let token = "";
  let error = "";
  try {
    const response = await fetch(`https://${GITHUB_HOSTNAME}/login/oauth/access_token`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ code, client_id: GITHUB_CLIENT_ID, client_secret: GITHUB_CLIENT_SECRET }),
    });
    ({ access_token: token, error } = await response.json());
  } catch {
    return outputHTML(res, { error: "Failed to request an access token. Please try again later.", errorCode: "TOKEN_REQUEST_FAILED" });
  }

  outputHTML(res, { token, error });
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/healthz") return void res.writeHead(200).end("ok");
  if (req.method === "GET" && url.pathname === "/auth") return handleAuth(url, res);
  if (req.method === "GET" && url.pathname === "/callback") return void handleCallback(url, req, res);

  res.writeHead(404).end();
});

server.listen(PORT, () => {
  console.log(`[oauth-broker] listening on :${PORT}`);
});

// One-shot GSC OAuth setup.
//
// What this does:
//   1. Reads a Google Cloud OAuth Desktop App client_secrets.json
//      (passed as the first arg, or at ~/.config/gsc_connector/client_secrets.json).
//   2. Spins up a tiny local HTTP server on 127.0.0.1:<ephemeral> to catch the
//      Google OAuth redirect.
//   3. Opens your browser → you sign in with the Google account that
//      owns / has access to the GSC property (nick@earnedmedia.com.au).
//   4. Catches the authorization code, exchanges it for a refresh token.
//   5. Prints GSC_CLIENT_ID / GSC_CLIENT_SECRET / GSC_REFRESH_TOKEN / GSC_PROPERTY
//      ready to paste into Vercel + .env.local.
//
// Usage:
//   node scripts/setup-gsc-oauth.js ~/Downloads/client_secret_XYZ.json
//   node scripts/setup-gsc-oauth.js                 # uses default path
//
// First-time GCP setup (~5 min):
//   1. console.cloud.google.com → New Project (or existing)
//   2. APIs & Services → Enable APIs → "Google Search Console API"
//   3. APIs & Services → Credentials → Create Credentials →
//        OAuth client ID → Application type: Desktop App
//        Name: "MrPaint bot"
//   4. Download the JSON → pass path to this script.

const fs = require("fs");
const http = require("http");
const path = require("path");
const { URL } = require("url");
const { exec } = require("child_process");

const SCOPES = ["https://www.googleapis.com/auth/webmasters.readonly"];
const DEFAULT_SECRETS_PATH = path.join(
  process.env.HOME || "",
  ".config/gsc_connector/client_secrets.json"
);

async function main() {
  const secretsPath = process.argv[2] || DEFAULT_SECRETS_PATH;
  if (!fs.existsSync(secretsPath)) {
    console.error(`\n  ✗ client_secrets.json not found at ${secretsPath}`);
    console.error(`\n  Either pass the path as an argument:`);
    console.error(`    node scripts/setup-gsc-oauth.js ~/Downloads/client_secret_XYZ.json`);
    console.error(`  Or save it to the default location and re-run.\n`);
    process.exit(1);
  }

  const secrets = JSON.parse(fs.readFileSync(secretsPath, "utf8"));
  const cfg = secrets.installed || secrets.web;
  if (!cfg?.client_id || !cfg?.client_secret) {
    console.error(`\n  ✗ client_secrets.json missing "installed"/"web" block or client_id/client_secret\n`);
    process.exit(1);
  }
  const { client_id, client_secret } = cfg;

  // Single closure runs the entire flow: start server, build auth URL with
  // the actual bound port, open browser, capture code, exchange for tokens.
  const tokenResp = await runOAuthFlow(client_id, client_secret);

  // Save a local copy (gitignored) so test scripts can use it without env vars.
  const out = path.join(process.cwd(), ".gsc-oauth.json");
  fs.writeFileSync(out, JSON.stringify({
    client_id,
    client_secret,
    refresh_token: tokenResp.refresh_token,
    obtained_at: new Date().toISOString(),
  }, null, 2));

  console.log("\n  ✓ Refresh token obtained.\n");
  console.log("  Local copy saved to .gsc-oauth.json (gitignored).\n");
  console.log("  Add these four to Vercel production:\n");
  console.log("    GSC_CLIENT_ID");
  console.log(`      ${client_id}\n`);
  console.log("    GSC_CLIENT_SECRET");
  console.log(`      ${client_secret}\n`);
  console.log("    GSC_REFRESH_TOKEN");
  console.log(`      ${tokenResp.refresh_token}\n`);
  console.log("    GSC_PROPERTY");
  console.log(`      sc-domain:mrpaint.com.au\n`);
}

function runOAuthFlow(client_id, client_secret) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url, `http://127.0.0.1`);
        const code = url.searchParams.get("code");
        const errParam = url.searchParams.get("error");
        if (errParam) {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(`<h2>OAuth error: ${errParam}</h2>`);
          server.close();
          return reject(new Error(`OAuth error: ${errParam}`));
        }
        if (!code) {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(`<h2>Waiting for OAuth redirect…</h2>`);
          return;
        }
        const tokenResp = await exchangeCode(client_id, client_secret, code, redirectUri);
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`<h2>✓ Authorisation complete</h2><p>You can close this tab and return to the terminal.</p>`);
        server.close();
        resolve(tokenResp);
      } catch (err) {
        res.writeHead(500, { "Content-Type": "text/html" });
        res.end(`<pre>${(err && err.message) || err}</pre>`);
        server.close();
        reject(err);
      }
    });

    let redirectUri;
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      redirectUri = `http://127.0.0.1:${port}`;
      const authUrl =
        "https://accounts.google.com/o/oauth2/v2/auth?" +
        new URLSearchParams({
          client_id,
          redirect_uri: redirectUri,
          response_type: "code",
          scope: SCOPES.join(" "),
          access_type: "offline",
          prompt: "consent",
        }).toString();

      console.log(`\n  Listening on ${redirectUri}`);
      console.log(`  Opening browser for Google sign-in…`);
      console.log(`  (If it doesn't open, paste this URL into a browser:)\n`);
      console.log(`    ${authUrl}\n`);

      const opener = process.platform === "darwin" ? "open"
                   : process.platform === "win32" ? "start ''"
                   : "xdg-open";
      exec(`${opener} "${authUrl}"`).on("error", () => {/* ignore */});
    });

    server.on("error", reject);
  });
}

async function exchangeCode(client_id, client_secret, code, redirectUri) {
  const params = new URLSearchParams({
    client_id, client_secret, code,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
  });
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params,
  });
  const data = await r.json();
  if (!r.ok) {
    throw new Error(`Token exchange failed (${r.status}): ${JSON.stringify(data).slice(0, 400)}`);
  }
  if (!data.refresh_token) {
    throw new Error(
      `No refresh_token in response. This usually means you've already authorised this client — ` +
      `revoke at https://myaccount.google.com/permissions and re-run the script.`
    );
  }
  return data;
}

main().catch((err) => {
  console.error("\n  ✗ Setup failed:", err.message || err, "\n");
  process.exit(1);
});

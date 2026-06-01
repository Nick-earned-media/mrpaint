// Tiny .env.local loader for local scripts. Require this FIRST, before
// anything that reads process.env at module load.
//
// Usage:
//   require("../lib/load-env.js");          // looks for .env.local at repo root
//   const { client } = require("./supabase.js");
//
// We do this instead of `node --env-file=.env.local` because that flag only
// works on Node 20.6+ — silently no-ops on older versions, which is how we
// got here. Vercel auto-loads env vars in production, so this file only
// matters for local script runs.

const fs = require("fs");
const path = require("path");

const ENV_PATH = path.join(__dirname, "..", ".env.local");

if (!fs.existsSync(ENV_PATH)) {
  // Don't throw — env vars may be set another way (e.g. exported in shell).
  return;
}

const raw = fs.readFileSync(ENV_PATH, "utf8");

for (const rawLine of raw.split(/\r?\n/)) {
  const line = rawLine.trim();
  if (!line || line.startsWith("#")) continue;
  const eq = line.indexOf("=");
  if (eq === -1) continue;
  const key = line.slice(0, eq).trim();
  let value = line.slice(eq + 1).trim();
  // Strip matching surrounding quotes (single or double)
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  // Don't clobber values already set in the real environment
  if (process.env[key] === undefined || process.env[key] === "") {
    process.env[key] = value;
  }
}

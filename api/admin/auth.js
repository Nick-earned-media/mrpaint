// Login endpoint for the /admin terminal.
//
//   GET  → { authenticated: true|false }   (session check from the page)
//   POST { password } → sets the mp_admin session cookie on success
//   POST { logout: true } → clears the cookie
//
// Failed attempts get a flat 1s delay to blunt brute-forcing; the password
// itself is compared via hashed timing-safe equality (lib/admin-session.js).

const { createToken, checkPassword, isAuthed, sessionCookie, clearCookie } = require("../../lib/admin-session.js");

module.exports = async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).json({ authenticated: isAuthed(req) });
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const body = await readJson(req).catch(() => ({}));

  if (body.logout) {
    res.setHeader("Set-Cookie", clearCookie());
    return res.status(200).json({ ok: true });
  }

  if (!process.env.ADMIN_PASSWORD) {
    return res.status(500).json({ error: "Admin login not configured" });
  }

  if (!checkPassword(body.password)) {
    await new Promise((r) => setTimeout(r, 1000));
    return res.status(401).json({ error: "Wrong password" });
  }

  res.setHeader("Set-Cookie", sessionCookie(createToken()));
  return res.status(200).json({ ok: true });
};

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}")); }
      catch (err) { reject(err); }
    });
    req.on("error", reject);
  });
}

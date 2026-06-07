// Admin session tokens for the /admin terminal.
//
// Stateless HMAC tokens: `${expiryMs}.${hmac}`. The signing secret is derived
// from ADMIN_PASSWORD, so changing the password invalidates every session.

const crypto = require("crypto");

const SESSION_DAYS = 7;
const COOKIE_NAME = "mp_admin";

function secret() {
  const pw = process.env.ADMIN_PASSWORD;
  if (!pw) throw new Error("ADMIN_PASSWORD env var not set");
  return crypto.createHash("sha256").update(`mp-admin-session:${pw}`).digest();
}

function sign(payload) {
  return crypto.createHmac("sha256", secret()).update(payload).digest("hex");
}

function createToken() {
  const exp = String(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  return `${exp}.${sign(exp)}`;
}

function verifyToken(token) {
  if (!token || typeof token !== "string") return false;
  const [exp, mac] = token.split(".");
  if (!exp || !mac) return false;
  if (Number(exp) < Date.now()) return false;
  const expected = sign(exp);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function checkPassword(supplied) {
  const pw = process.env.ADMIN_PASSWORD;
  if (!pw || !supplied) return false;
  const a = crypto.createHash("sha256").update(String(supplied)).digest();
  const b = crypto.createHash("sha256").update(pw).digest();
  return crypto.timingSafeEqual(a, b);
}

function readSessionCookie(req) {
  const header = req.headers?.cookie || "";
  const match = header.split(/;\s*/).find((c) => c.startsWith(`${COOKIE_NAME}=`));
  return match ? decodeURIComponent(match.slice(COOKIE_NAME.length + 1)) : null;
}

function isAuthed(req) {
  return verifyToken(readSessionCookie(req));
}

function sessionCookie(token) {
  const maxAge = SESSION_DAYS * 24 * 60 * 60;
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

function clearCookie() {
  return `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

module.exports = { createToken, verifyToken, checkPassword, isAuthed, sessionCookie, clearCookie, COOKIE_NAME };

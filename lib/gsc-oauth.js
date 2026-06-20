// Google Search Console client using OAuth 2.0 refresh tokens.
//
// Why OAuth instead of a service account: GSC Domain properties (the
// sc-domain:foo.com format) silently reject "Add User" attempts with a
// service account email. OAuth tokens inherit access from a real Google
// account — so authenticating once with nick@earnedmedia.com.au gives
// access to every property that account owns or has been added to,
// including Domain properties.
//
// Setup (one-time, run scripts/setup-gsc-oauth.js):
//   1. Create OAuth 2.0 Desktop App credentials in Google Cloud Console.
//   2. Run the setup script → opens browser → log in with the Google
//      account that owns/has access to the GSC property.
//   3. Script prints GSC_CLIENT_ID, GSC_CLIENT_SECRET, GSC_REFRESH_TOKEN.
//   4. Add those three + GSC_PROPERTY to Vercel env vars.
//
// Env vars used:
//   GSC_CLIENT_ID
//   GSC_CLIENT_SECRET
//   GSC_REFRESH_TOKEN
//   GSC_PROPERTY     — sc-domain:mrpaint.com.au or https://mrpaint.com.au/

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GSC_API = "https://searchconsole.googleapis.com/webmasters/v3";

let cachedToken = null;
let cachedTokenExpiry = 0;

// Exchange the refresh token for a fresh access token (cached for 50min).
async function getAccessToken() {
  if (cachedToken && Date.now() < cachedTokenExpiry) return cachedToken;

  const clientId = process.env.GSC_CLIENT_ID;
  const clientSecret = process.env.GSC_CLIENT_SECRET;
  const refreshToken = process.env.GSC_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("GSC OAuth env vars not set (GSC_CLIENT_ID / GSC_CLIENT_SECRET / GSC_REFRESH_TOKEN)");
  }

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const r = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`GSC token refresh ${r.status}: ${t.slice(0, 300)}`);
  }
  const data = await r.json();
  cachedToken = data.access_token;
  cachedTokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return cachedToken;
}

async function gscPost(path, body) {
  const token = await getAccessToken();
  const r = await fetch(`${GSC_API}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`GSC ${path} ${r.status}: ${t.slice(0, 300)}`);
  }
  return r.json();
}

function defaultProperty() {
  return process.env.GSC_PROPERTY || "sc-domain:mrpaint.com.au";
}

function dateRange(days) {
  const end = new Date(Date.now() - 3 * 86400 * 1000); // GSC has ~3-day lag
  const start = new Date(end.getTime() - days * 86400 * 1000);
  return {
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
  };
}

// Top search queries — what people are typing to find the site.
// Returns: [{ query, clicks, impressions, ctr, position }, ...]
async function getTopQueries({ days = 28, limit = 25, property } = {}) {
  const { startDate, endDate } = dateRange(days);
  const data = await gscPost(
    `/sites/${encodeURIComponent(property || defaultProperty())}/searchAnalytics/query`,
    {
      startDate, endDate,
      dimensions: ["query"],
      rowLimit: Math.min(25000, limit),
      orderBy: [{ fieldName: "clicks", sortOrder: "DESCENDING" }],
    }
  );
  return (data.rows || []).map((r) => ({
    query: r.keys[0],
    clicks: r.clicks || 0,
    impressions: r.impressions || 0,
    ctr: Math.round((r.ctr || 0) * 10000) / 100, // %, 2 decimals
    position: Math.round((r.position || 0) * 10) / 10,
  }));
}

// Top pages by clicks.
async function getTopPages({ days = 28, limit = 25, property } = {}) {
  const { startDate, endDate } = dateRange(days);
  const data = await gscPost(
    `/sites/${encodeURIComponent(property || defaultProperty())}/searchAnalytics/query`,
    {
      startDate, endDate,
      dimensions: ["page"],
      rowLimit: Math.min(25000, limit),
      orderBy: [{ fieldName: "clicks", sortOrder: "DESCENDING" }],
    }
  );
  return (data.rows || []).map((r) => ({
    page: r.keys[0],
    clicks: r.clicks || 0,
    impressions: r.impressions || 0,
    ctr: Math.round((r.ctr || 0) * 10000) / 100,
    position: Math.round((r.position || 0) * 10) / 10,
  }));
}

// Overall summary — total clicks / impressions / avg CTR / avg position.
async function getOverview({ days = 28, property } = {}) {
  const { startDate, endDate } = dateRange(days);
  const data = await gscPost(
    `/sites/${encodeURIComponent(property || defaultProperty())}/searchAnalytics/query`,
    { startDate, endDate, dimensions: [] }
  );
  const row = (data.rows || [])[0];
  return {
    days,
    startDate, endDate,
    clicks: row?.clicks || 0,
    impressions: row?.impressions || 0,
    ctr: row ? Math.round((row.ctr || 0) * 10000) / 100 : 0,
    position: row ? Math.round((row.position || 0) * 10) / 10 : 0,
  };
}

// Week-over-week comparison: this 7d vs previous 7d.
async function getWeekOverWeek({ property } = {}) {
  const now = new Date(Date.now() - 3 * 86400 * 1000);
  const thisStart = new Date(now.getTime() - 7 * 86400 * 1000);
  const prevEnd = new Date(thisStart.getTime() - 86400 * 1000);
  const prevStart = new Date(prevEnd.getTime() - 7 * 86400 * 1000);

  const fmt = (d) => d.toISOString().slice(0, 10);
  const propUri = property || defaultProperty();

  const [thisWeek, prevWeek] = await Promise.all([
    gscPost(`/sites/${encodeURIComponent(propUri)}/searchAnalytics/query`, {
      startDate: fmt(thisStart), endDate: fmt(now), dimensions: [],
    }),
    gscPost(`/sites/${encodeURIComponent(propUri)}/searchAnalytics/query`, {
      startDate: fmt(prevStart), endDate: fmt(prevEnd), dimensions: [],
    }),
  ]);

  const cur = thisWeek.rows?.[0] || {};
  const prev = prevWeek.rows?.[0] || {};
  const pctChange = (a, b) => {
    if (!b) return null;
    return Math.round(((a - b) / b) * 1000) / 10;
  };

  return {
    this_week: {
      startDate: fmt(thisStart), endDate: fmt(now),
      clicks: cur.clicks || 0,
      impressions: cur.impressions || 0,
      ctr: Math.round((cur.ctr || 0) * 10000) / 100,
      position: Math.round((cur.position || 0) * 10) / 10,
    },
    prev_week: {
      startDate: fmt(prevStart), endDate: fmt(prevEnd),
      clicks: prev.clicks || 0,
      impressions: prev.impressions || 0,
      ctr: Math.round((prev.ctr || 0) * 10000) / 100,
      position: Math.round((prev.position || 0) * 10) / 10,
    },
    delta: {
      clicks_pct: pctChange(cur.clicks, prev.clicks),
      impressions_pct: pctChange(cur.impressions, prev.impressions),
      position_diff: cur.position && prev.position ? Math.round((cur.position - prev.position) * 10) / 10 : null,
    },
  };
}

module.exports = {
  getAccessToken,
  gscPost,
  getTopQueries,
  getTopPages,
  getOverview,
  getWeekOverWeek,
};

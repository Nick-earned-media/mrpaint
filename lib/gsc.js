// Google Search Console week-over-week trends.
//
// Compares the last 7 days to the previous 7 days and flags any page
// with a >=20% drop in clicks OR impressions.
//
// Env vars:
//   GSC_SERVICE_ACCOUNT_JSON — full JSON of the service account key.
//     The service account must be added as a Restricted user on the
//     GSC mrpaint property.
//
// Setup steps for the user:
//   1. In Google Cloud Console, create a service account.
//   2. Enable the Search Console API on the project.
//   3. Download the service account JSON key.
//   4. In GSC → Settings → Users and permissions → Add user. Use the
//      service account's email ("foo@bar.iam.gserviceaccount.com").
//   5. Paste the JSON content (single-line minified) into Vercel env
//      vars as GSC_SERVICE_ACCOUNT_JSON.

const { google } = require("googleapis");

const DROP_THRESHOLD_PCT = 20;

async function fetchGscTrends({ siteUrl }) {
  const raw = process.env.GSC_SERVICE_ACCOUNT_JSON;
  if (!raw) return { skipped: "GSC_SERVICE_ACCOUNT_JSON not set" };

  let creds;
  try {
    creds = JSON.parse(raw);
  } catch (err) {
    return { error: `GSC_SERVICE_ACCOUNT_JSON not valid JSON: ${err.message}` };
  }

  const auth = new google.auth.JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ["https://www.googleapis.com/auth/webmasters.readonly"],
  });
  const sc = google.searchconsole({ version: "v1", auth });

  // Date ranges
  const today = new Date();
  const fmt = (d) => d.toISOString().slice(0, 10);
  const thisEnd = new Date(today); thisEnd.setDate(thisEnd.getDate() - 2); // GSC has 2-3 day lag
  const thisStart = new Date(thisEnd); thisStart.setDate(thisStart.getDate() - 6);
  const prevEnd = new Date(thisStart); prevEnd.setDate(prevEnd.getDate() - 1);
  const prevStart = new Date(prevEnd); prevStart.setDate(prevStart.getDate() - 6);

  const range = (start, end) => ({ startDate: fmt(start), endDate: fmt(end) });

  const [thisAgg, prevAgg, thisByPage, prevByPage] = await Promise.all([
    queryAgg(sc, siteUrl, range(thisStart, thisEnd)),
    queryAgg(sc, siteUrl, range(prevStart, prevEnd)),
    queryByPage(sc, siteUrl, range(thisStart, thisEnd)),
    queryByPage(sc, siteUrl, range(prevStart, prevEnd)),
  ]);

  const prevPages = new Map();
  for (const r of prevByPage) prevPages.set(r.page, r);

  // Compare each page this week vs last week.
  const drops = [];
  for (const cur of thisByPage) {
    const prev = prevPages.get(cur.page);
    if (!prev) continue;
    const clicksDelta = pctChange(cur.clicks, prev.clicks);
    const impressionsDelta = pctChange(cur.impressions, prev.impressions);
    if (clicksDelta <= -DROP_THRESHOLD_PCT || impressionsDelta <= -DROP_THRESHOLD_PCT) {
      drops.push({
        page: shortPath(cur.page, siteUrl),
        clicksThis: cur.clicks, clicksPrev: prev.clicks, clicksDelta,
        impressionsThis: cur.impressions, impressionsPrev: prev.impressions, impressionsDelta,
      });
    }
  }
  drops.sort((a, b) => a.clicksDelta - b.clicksDelta);

  const top = [...thisByPage]
    .sort((a, b) => b.clicks - a.clicks)
    .slice(0, 10)
    .map((r) => ({ page: shortPath(r.page, siteUrl), clicks: r.clicks, impressions: r.impressions }));

  return {
    siteUrl,
    range: { this: range(thisStart, thisEnd), prev: range(prevStart, prevEnd) },
    summary: {
      clicksThis: thisAgg.clicks,
      clicksPrev: prevAgg.clicks,
      clicksDelta: pctChange(thisAgg.clicks, prevAgg.clicks),
      impressionsThis: thisAgg.impressions,
      impressionsPrev: prevAgg.impressions,
      impressionsDelta: pctChange(thisAgg.impressions, prevAgg.impressions),
    },
    top,
    drops,
  };
}

async function queryAgg(sc, siteUrl, dates) {
  const r = await sc.searchanalytics.query({
    siteUrl,
    requestBody: { ...dates, dimensions: [] },
  });
  const row = r.data.rows?.[0];
  return { clicks: row?.clicks || 0, impressions: row?.impressions || 0 };
}

async function queryByPage(sc, siteUrl, dates) {
  const r = await sc.searchanalytics.query({
    siteUrl,
    requestBody: { ...dates, dimensions: ["page"], rowLimit: 100 },
  });
  return (r.data.rows || []).map((row) => ({
    page: row.keys[0],
    clicks: row.clicks || 0,
    impressions: row.impressions || 0,
  }));
}

function pctChange(now, then) {
  if (!then) return now > 0 ? 100 : 0;
  return ((now - then) / then) * 100;
}

function shortPath(fullUrl, siteUrl) {
  try {
    const u = new URL(fullUrl);
    return u.pathname || "/";
  } catch {
    return fullUrl.replace(siteUrl, "") || "/";
  }
}

module.exports = { fetchGscTrends };

// Renders a report-data payload to a complete HTML page.
// Matches the design system in /reports/cairns/2026-05-30.html (mockup).
// Standalone — no external assets, inlined styles, mobile-first.

const REPORT_CSS = `
  :root{
    --navy:#0e1f33;
    --navy-2:#0a1828;
    --cream:#fbf6ec;
    --cream-2:#f3ecd9;
    --ink:#13151b;
    --ink-2:#465264;
    --muted:#778497;
    --line:#e6dfc9;
    --yellow:#ffd23f;
    --cyan:#1daae0;
    --up:#16a34a;
    --down:#dc2626;
    --flat:#94a3b8;
    --shadow: 0 6px 20px rgba(15,30,50,.08);
    --radius: 14px;
  }
  *{ box-sizing:border-box }
  html,body{ margin:0; padding:0 }
  body{
    background: var(--cream); color: var(--ink);
    font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "Inter", Roboto, sans-serif;
    -webkit-font-smoothing: antialiased;
    padding-bottom: 96px;
  }
  .topbar{
    background: var(--navy); color:#fff;
    padding: 14px 18px 12px;
    display:flex; align-items:center; gap:10px;
    position:sticky; top:0; z-index: 5;
  }
  .brand{ display:flex; align-items:center; gap:8px; font-weight:700; font-size:15px }
  .dot{ width:8px; height:8px; border-radius:50%; background:var(--yellow) }
  .topbar .meta{ margin-left:auto; font-size:12px; color:#a9b8cd }
  .hero{ background: var(--navy); color:#fff; padding: 4px 18px 28px; position:relative }
  .crumb{ font-size:12px; color:#a9b8cd; letter-spacing:.1em; text-transform:uppercase }
  .h1{ font-size: 22px; line-height:1.2; font-weight:700; margin:6px 0 10px }
  .h1 em{ font-style:normal; color: var(--yellow) }
  .hero p{ color:#cfd9e6; font-size:14px; margin:0; max-width:30ch }
  .kpis{ display:grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px; margin: -16px 14px 0; position: relative; z-index: 1 }
  .kpi{ background:#fff; border-radius: var(--radius); padding: 14px 12px; box-shadow: var(--shadow); text-align: center }
  .kpi .v{ font-size: 22px; font-weight: 800; letter-spacing: -.02em; color: var(--navy) }
  .kpi .l{ font-size: 11px; text-transform: uppercase; letter-spacing: .12em; color: var(--muted); margin-top:4px }
  .kpi .d{ font-size: 12px; margin-top:4px; font-weight:600 }
  .kpi .d.up{ color: var(--up) } .kpi .d.down{ color: var(--down) } .kpi .d.flat{ color: var(--flat) }
  .card{ background:#fff; border-radius: var(--radius); padding: 18px; margin: 16px 14px; box-shadow: var(--shadow) }
  .eyebrow{ font-size: 11px; letter-spacing:.14em; text-transform:uppercase; color: var(--muted); font-weight: 700; margin-bottom: 8px }
  h2{ font-size: 18px; margin: 0 0 12px; color: var(--navy); font-weight: 700 }
  p{ margin: 0 0 10px; color: var(--ink-2); font-size: 14.5px; line-height: 1.55 }
  p:last-child{ margin-bottom: 0 }
  p strong{ color: var(--ink) }
  .mover{ display:grid; grid-template-columns: 36px 1fr auto; gap: 12px; align-items: center; padding: 10px 0; border-bottom: 1px solid var(--line) }
  .mover:last-child{ border-bottom:0 }
  .badge{ width:36px; height:36px; border-radius:10px; display:flex; align-items:center; justify-content:center; font-weight:800; color:#fff; font-size: 13px }
  .badge.up{ background: var(--up) } .badge.down{ background: var(--down) } .badge.flat{ background: var(--flat) } .badge.new{ background: var(--navy) }
  .mover .kw{ font-weight: 600; font-size: 15px; color: var(--ink) }
  .mover .sub{ font-size: 12.5px; color: var(--muted); margin-top: 2px }
  .pos{ font-weight: 800; font-size: 17px; color: var(--navy) }
  .kwlist{ margin: 4px 0 0 }
  .kwlist .row{ display:grid; grid-template-columns: 1fr auto auto; gap:12px; padding: 10px 0; border-bottom: 1px solid var(--line); align-items: baseline }
  .kwlist .row:last-child{ border-bottom:0 }
  .kwlist .ph{ font-weight: 500; font-size: 14.5px; color: var(--ink) }
  .kwlist .vl{ font-size:12px; color: var(--muted) }
  .kwlist .po{ font-weight: 700; color: var(--navy); font-variant-numeric: tabular-nums; font-size: 13.5px }
  .delta{ font-size: 11px; font-weight: 700; padding: 2px 6px; border-radius: 6px; margin-left: 6px }
  .delta.up{ background: rgba(22,163,74,.12); color: var(--up) }
  .delta.down{ background: rgba(220,38,38,.12); color: var(--down) }
  .delta.flat{ color: var(--flat) }
  .crow{ display: grid; grid-template-columns: 32px 1fr; gap: 12px; align-items: center; padding: 8px 0 }
  .crow .name{ display:flex; justify-content:space-between; font-size: 13.5px; margin-bottom: 4px }
  .crow .name strong{ color: var(--ink) }
  .crow .name .pct{ color: var(--muted); font-variant-numeric: tabular-nums; font-weight: 600 }
  .bar{ height:10px; background: var(--cream-2); border-radius: 999px; overflow: hidden }
  .bar > span{ display:block; height:100%; border-radius: 999px }
  .you .bar > span{ background: var(--yellow) }
  .other .bar > span{ background: var(--navy) }
  .brand-logo{ width: 32px; height: 32px; border-radius: 8px; background: var(--cream-2); display: flex; align-items: center; justify-content: center; font-weight: 800; font-size: 13px; color: var(--navy) }
  .crow.you .brand-logo{ background: var(--yellow) }
  .crow.you .name strong:after{ content:" · You"; color: var(--navy); font-weight:600; background: var(--yellow); padding: 0 6px; border-radius: 4px; margin-left: 6px; font-size: 11px }
  .todo li{ list-style: none; padding: 10px 0; border-bottom: 1px solid var(--line); display: grid; grid-template-columns: 28px 1fr; gap: 12px; align-items:start }
  .todo li:last-child{ border-bottom:0 }
  .todo ul{ margin:0; padding:0 }
  .num{ background: var(--navy); color: var(--yellow); width:24px; height:24px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-weight: 800; font-size: 12px }
  .todo .why{ font-size: 12.5px; color: var(--muted); margin-top: 4px }
  .remind{ margin-top: 8px }
  .remind summary{ list-style: none; cursor: pointer; display: inline-flex; align-items: center; gap: 4px; font-size: 12.5px; font-weight: 700; color: var(--navy); padding: 6px 10px; border-radius: 7px; background: var(--cream-2) }
  .remind summary::-webkit-details-marker{ display:none }
  .remind summary::after{ content: " ▾"; font-size: 10px; opacity: .6 }
  .remind[open] summary::after{ content: " ▴" }
  .remind-opts{ display: grid; gap: 4px; margin-top: 8px; padding: 6px; background: #fff; border: 1px solid var(--line); border-radius: 10px; box-shadow: var(--shadow) }
  .remind-opts a{ display:flex; align-items:center; justify-content: space-between; padding: 10px 12px; text-decoration: none; color: var(--ink); font-size: 14px; font-weight: 500; border-radius: 6px }
  .remind-opts a:hover, .remind-opts a:active{ background: var(--cream) }
  .remind-opts a span{ color: var(--muted); font-size: 12px; font-weight: 500 }
  .ctabar{ position: fixed; bottom: 0; left: 0; right: 0; background: #fff; border-top: 1px solid var(--line); padding: 12px 14px calc(12px + env(safe-area-inset-bottom)); display: grid; grid-template-columns: 1fr 1fr; gap: 10px; z-index: 10 }
  .btn{ display:flex; align-items:center; justify-content:center; gap:8px; text-decoration: none; padding: 13px 10px; border-radius: 10px; font-size: 14px; font-weight: 700; min-height: 46px }
  .btn--primary{ background: var(--navy); color: #fff }
  .btn--ghost{ background: transparent; color: var(--navy); border: 1px solid var(--navy) }
  .ftnote{ color: var(--muted); font-size: 11.5px; text-align: center; padding: 6px 18px 4px }
  @media (min-width: 720px){
    body{ background: #ece4cf }
    .topbar, .hero, .kpis, .card, .ftnote{ max-width: 480px; margin-left:auto; margin-right:auto }
    .ctabar{ max-width: 480px; left:50%; transform: translateX(-50%); border-radius: 14px 14px 0 0 }
  }
`;

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function fmtNum(n) {
  if (n == null) return "—";
  const num = Number(n);
  if (!Number.isFinite(num)) return "—";
  if (num >= 1000) return `${(num / 1000).toFixed(1)}k`;
  return String(num);
}

function badgeFor(status) {
  if (status === "new") return `<div class="badge new">★</div>`;
  if (status === "up") return `<div class="badge up">▲</div>`;
  if (status === "down") return `<div class="badge down">▼</div>`;
  return `<div class="badge flat">—</div>`;
}

function moverBadge(mover) {
  if (mover.status === "new") return `<div class="badge new">★</div>`;
  const arrow = mover.status === "up" ? "▲" : mover.status === "down" ? "▼" : "—";
  const num = mover.delta && mover.delta !== "—" ? mover.delta.replace(/[▲▼★]/g, "") : "";
  return `<div class="badge ${mover.status}">${arrow}${num}</div>`;
}

function reminderLinks(actionTitle) {
  // wa.me deep-link to the user's own bot — pre-fills a /remind message
  const baseTo = process.env.TWILIO_FROM_DISPLAY || "14155238886";
  const encode = (s) => encodeURIComponent(s);
  const opts = [
    { label: "Tomorrow morning", sub: "8 am", cmd: `/remind tomorrow 8am ${actionTitle}` },
    { label: "End of week", sub: "Fri 4 pm", cmd: `/remind friday 4pm ${actionTitle}` },
    { label: "Next week", sub: "Mon 8 am", cmd: `/remind monday 8am ${actionTitle}` },
    { label: "Custom…", sub: "type a time", cmd: `/remind ... ${actionTitle}` },
  ];
  return opts.map((o) =>
    `<a href="https://wa.me/${baseTo}?text=${encode(o.cmd)}">${escapeHtml(o.label)} <span>${escapeHtml(o.sub)}</span></a>`
  ).join("");
}

function renderReport(data) {
  const { client, scope, period, kpis, movers, all_keywords, competitors, narrative, actions } = data;
  const displayName = client?.display_name || "MrPaint";
  const scopeLabel = scope === "cairns" ? "Cairns" :
                     scope === "edge-hill" ? "Edge Hill" :
                     scope.charAt(0).toUpperCase() + scope.slice(1);

  // KPI cards (use 3: keywords_ranked, avg_position, share_of_voice OR visibility)
  const kpiCards = `
    <div class="kpi">
      <div class="v">${escapeHtml(kpis.keywords_ranked.value)} <span style="font-size:14px;color:var(--muted)">/ ${escapeHtml(kpis.keywords_ranked.total_tracked)}</span></div>
      <div class="l">Keywords ranked</div>
      ${kpis.keywords_ranked.delta ? `<div class="d ${kpis.keywords_ranked.delta_direction}">${escapeHtml(kpis.keywords_ranked.delta)}</div>` : `<div class="d flat">—</div>`}
    </div>
    <div class="kpi">
      <div class="v">${escapeHtml(kpis.avg_position.value)}</div>
      <div class="l">Avg position</div>
      ${kpis.avg_position.delta ? `<div class="d ${kpis.avg_position.delta_direction}">${escapeHtml(kpis.avg_position.delta)}</div>` : `<div class="d flat">—</div>`}
    </div>
    <div class="kpi">
      <div class="v">${escapeHtml(kpis.visibility.value)}</div>
      <div class="l">Visibility</div>
      ${kpis.visibility.delta ? `<div class="d ${kpis.visibility.delta_direction}">${escapeHtml(kpis.visibility.delta)}</div>` : `<div class="d flat">—</div>`}
    </div>
  `;

  // Movers card
  const moversHtml = movers.length
    ? movers.map((m) => `
        <div class="mover">
          ${moverBadge(m)}
          <div>
            <div class="kw">${escapeHtml(m.keyword)}</div>
            <div class="sub">vol ${fmtNum(m.volume)}/mo${m.cpc ? ` · CPC $${escapeHtml(m.cpc)}` : ""}</div>
          </div>
          <div class="pos">${escapeHtml(m.position)}</div>
        </div>
      `).join("")
    : `<p>No tracked-keyword movement to highlight this week.</p>`;

  // All-keywords card
  const allHtml = all_keywords.map((k) => `
    <div class="row">
      <div class="ph">${escapeHtml(k.keyword)}</div>
      <div class="vl">${fmtNum(k.volume)}/mo</div>
      <div class="po">${escapeHtml(k.position)} <span class="delta ${k.direction}">${escapeHtml(k.delta)}</span></div>
    </div>
  `).join("");

  // Competitor bars
  const compHtml = competitors.map((c) => {
    const klass = c.is_you ? "crow you" : "crow other";
    const initial = (c.name || c.domain || "?").charAt(0).toUpperCase();
    const widthPct = c.is_you ? `${c.bar_pct}%` : `${c.bar_pct}%`;
    return `
      <div class="${klass}">
        <div class="brand-logo">${escapeHtml(initial)}</div>
        <div>
          <div class="name"><strong>${escapeHtml(c.name)}</strong><span class="pct">${escapeHtml(c.sov_pct)}</span></div>
          <div class="bar"><span style="width:${widthPct}"></span></div>
        </div>
      </div>
    `;
  }).join("");

  // Narrative
  const narrativeHtml = (narrative || []).map((p) => `<p>${escapeHtml(p)}</p>`).join("");

  // Actions
  const actionsHtml = (actions || []).map((a, i) => `
    <li>
      <span class="num">${i + 1}</span>
      <div>
        <strong>${escapeHtml(a.title)}</strong>
        <div class="why">${escapeHtml(a.why)}</div>
        <details class="remind">
          <summary>⏰ Remind me</summary>
          <div class="remind-opts">${reminderLinks(a.title)}</div>
        </details>
      </div>
    </li>
  `).join("");

  const askPath = scope === "cairns" ? "/report cairns" : `/report ${scope}`;
  const askDeepLink = `https://wa.me/${process.env.TWILIO_FROM_DISPLAY || "14155238886"}?text=${encodeURIComponent(askPath)}`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
<meta name="theme-color" content="#0e1f33" />
<title>${escapeHtml(scopeLabel)} report · ${escapeHtml(displayName)}</title>
<meta name="description" content="Weekly ${escapeHtml(period.cadence)} report for ${escapeHtml(displayName)} — ${escapeHtml(scopeLabel)}." />
<meta name="robots" content="noindex" />
<style>${REPORT_CSS}</style>
</head>
<body>

<div class="topbar" role="banner">
  <span class="brand"><span class="dot"></span> ${escapeHtml(displayName)} · Reports</span>
  <span class="meta">${escapeHtml(period.label_short)}</span>
</div>

<section class="hero">
  <div class="crumb">${escapeHtml(scope === "cairns" ? "City-wide performance" : "Suburb performance")}</div>
  <h1 class="h1">${escapeHtml(scopeLabel)} · <em>last 7 days</em></h1>
  <p>${escapeHtml(kpis.keywords_ranked.total_tracked)} tracked keywords in the campaign. ${escapeHtml(period.label_range)}.</p>
</section>

<div class="kpis">${kpiCards}</div>

<section class="card">
  <div class="eyebrow">What happened</div>
  ${narrativeHtml || `<p>Strategist narrative not generated this run.</p>`}
</section>

<section class="card">
  <div class="eyebrow">Top movers this week</div>
  ${moversHtml}
</section>

<section class="card">
  <div class="eyebrow">All tracked keywords</div>
  <h2 style="margin-bottom: 4px">${escapeHtml(scopeLabel)} — ${all_keywords.length} phrases</h2>
  <div class="kwlist">${allHtml}</div>
</section>

<section class="card compete">
  <div class="eyebrow">Local competitor snapshot</div>
  <h2 style="margin-bottom:14px">${escapeHtml(scopeLabel)} market share</h2>
  ${compHtml}
  <p style="margin-top: 12px; font-size: 13px; color: var(--muted)">Share of voice via Semrush Position Tracking. Bars normalised to the top competitor.</p>
</section>

${actionsHtml ? `
<section class="card todo">
  <div class="eyebrow">Do this week</div>
  <h2>Three moves to push the numbers.</h2>
  <ul>${actionsHtml}</ul>
</section>
` : ""}

<p class="ftnote">Report generated ${escapeHtml(period.label_short)} · data via Semrush Position Tracking + Google Search Console · ${escapeHtml(displayName)}</p>

<nav class="ctabar" aria-label="Quick actions">
  <a class="btn btn--primary" href="${escapeHtml(askDeepLink)}" rel="noopener">💬 Ask the bot</a>
  <a class="btn btn--ghost" href="#" onclick="if(navigator.share){navigator.share({title:'${escapeHtml(scopeLabel)} Report — ${escapeHtml(displayName)}',url:location.href})}else{alert('Long-press the link in your browser to share.')};return false;">↗ Share report</a>
</nav>

</body>
</html>`;
}

module.exports = { renderReport };

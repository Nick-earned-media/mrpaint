// Web chat handler — serves the chat UI (GET) and processes messages (POST).
//
// Auth: server-set HttpOnly cookie.  Login is a plain HTML form — no JS PIN
// screen, no localStorage.  The cookie is valid for 30 days.
//
// Env vars:
//   WEBCHAT_PIN           — 4-digit PIN for Adrian (production)
//   WEBCHAT_TEST_PIN      — 4-digit PIN for Nick to test before handoff
//   WEBCHAT_SESSION_SECRET — optional secret for HMAC; defaults to WEBCHAT_PIN
//   WEBCHAT_CLIENT_PHONE  — maps web user to a Supabase client row

const crypto = require('crypto');
const { runWithContext } = require('./whatsapp.js');

const WEBCHAT_PIN = process.env.WEBCHAT_PIN || '';
const WEBCHAT_TEST_PIN = process.env.WEBCHAT_TEST_PIN || '';
// WEBCHAT_CLIENT_ID is preferred — a Supabase client UUID, no phone needed.
// WEBCHAT_CLIENT_PHONE is the legacy fallback (still works if set).
const WEBCHAT_CLIENT_ID = process.env.WEBCHAT_CLIENT_ID || '';
const WEBCHAT_CLIENT_PHONE =
  process.env.WEBCHAT_CLIENT_PHONE ||
  (process.env.ALLOWED_PHONES || '').split(',').map(s => s.trim()).filter(Boolean)[0] ||
  '';
const COOKIE_NAME = 'mrpaint_auth';
const COOKIE_MAX_AGE = 30 * 24 * 60 * 60; // 30 days

// Resolve the phone identifier the bot uses internally.
// When WEBCHAT_CLIENT_ID is set we look up the client row once and cache the phone.
let _resolvedFromId = null;
async function resolveFromId() {
  if (_resolvedFromId) return _resolvedFromId;
  if (WEBCHAT_CLIENT_ID) {
    try {
      const { getClientById } = require('../lib/supabase.js');
      const row = await getClientById(WEBCHAT_CLIENT_ID);
      _resolvedFromId = row?.primary_phone || (row?.allowed_phones || [])[0] || WEBCHAT_CLIENT_PHONE || 'web:unknown';
    } catch {
      _resolvedFromId = WEBCHAT_CLIENT_PHONE || 'web:unknown';
    }
  } else {
    _resolvedFromId = WEBCHAT_CLIENT_PHONE || 'web:unknown';
  }
  return _resolvedFromId;
}

// ─── Crypto helpers ───────────────────────────────────────────────────────────

function makeToken(pin) {
  const secret = process.env.WEBCHAT_SESSION_SECRET || WEBCHAT_PIN || 'mrpaint';
  return crypto.createHmac('sha256', secret).update(pin).digest('hex').slice(0, 32);
}

function validatePin(pin) {
  if (!pin) return null;
  if (WEBCHAT_PIN && pin === WEBCHAT_PIN) return { isTest: false, token: makeToken(pin) };
  if (WEBCHAT_TEST_PIN && pin === WEBCHAT_TEST_PIN) return { isTest: true, token: makeToken(pin) };
  return null;
}

function checkCookie(req) {
  const token = getCookieValue(req.headers.cookie || '', COOKIE_NAME);
  if (!token) return null;
  if (WEBCHAT_PIN && token === makeToken(WEBCHAT_PIN)) return { isTest: false };
  if (WEBCHAT_TEST_PIN && token === makeToken(WEBCHAT_TEST_PIN)) return { isTest: true };
  return null;
}

function getCookieValue(header, name) {
  for (const part of (header || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

// ─── Main handler ─────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  if (req.method === 'GET') {
    const qs = new URL(req.url, 'http://x').searchParams;
    if (qs.get('draft') === '1') return handleGetDraft(req, res);
    return handleGetUI(req, res);
  }
  if (req.method === 'POST') {
    const ct = req.headers['content-type'] || '';
    if (ct.includes('application/x-www-form-urlencoded')) return handleLoginForm(req, res);
    return handleChat(req, res);
  }
  res.setHeader('Allow', 'GET, POST');
  return res.status(405).end('Method Not Allowed');
};

// ─── GET: serve login form or chat UI ────────────────────────────────────────

function handleGetUI(req, res) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Cache-Control', 'no-store');
  const auth = checkCookie(req);
  if (!auth) return res.status(200).end(loginHTML(''));
  return res.status(200).end(chatHTML(auth.isTest));
}

// ─── POST: login form submission ──────────────────────────────────────────────

async function handleLoginForm(req, res) {
  let body;
  try { body = await readFormBody(req); } catch { return res.status(400).end('Bad request'); }

  const pin = (body.pin || '').replace(/\D/g, '');
  const auth = validatePin(pin);

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Cache-Control', 'no-store');

  if (!auth) return res.status(200).end(loginHTML('Incorrect PIN — try again'));

  const secure = process.env.VERCEL ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${auth.token}; Max-Age=${COOKIE_MAX_AGE}; Path=/; HttpOnly${secure}; SameSite=Lax`);
  res.setHeader('Location', '/chat');
  return res.status(302).end();
}

// ─── POST: chat AJAX ──────────────────────────────────────────────────────────

async function handleChat(req, res) {
  const auth = checkCookie(req);
  if (!auth) return res.status(401).json({ ok: false, error: 'Not authenticated' });

  let body;
  try { body = await readJson(req); } catch { return res.status(400).json({ ok: false, error: 'Bad JSON' }); }

  const message = (body.message || '').trim();
  const mediaData = body.media;

  if (!message && !mediaData) return res.status(400).json({ ok: false, error: 'No message or media' });

  const replies = [];
  const contentType = mediaData?.contentType || 'image/jpeg';
  const isImage = contentType.startsWith('image/');
  const mediaUrl = (mediaData && isImage)
    ? `data:${contentType};base64,${mediaData.data}`
    : 'web-upload';
  const mediaBuffer = (mediaData && !isImage && mediaData.data)
    ? Buffer.from(mediaData.data, 'base64')
    : null;

  const ctx = {
    sendMessage: async (_ignored, text) => { replies.push(text); },
    downloadMedia: async (url) => {
      if (url === 'web-upload' && mediaBuffer) return mediaBuffer;
      throw new Error(`Unexpected downloadMedia call for: ${url}`);
    },
  };

  const fromId = await resolveFromId();

  try {
    await runWithContext(fromId, message, mediaData ? { url: mediaUrl, contentType } : null, ctx);
  } catch (err) {
    console.error('chat-web error:', err);
    replies.push('⚠️ Something went wrong — please try again.');
  }

  return res.status(200).json({ ok: true, replies });
}

// ─── GET: draft endpoint ──────────────────────────────────────────────────────

async function handleGetDraft(req, res) {
  const auth = checkCookie(req);
  if (!auth) return res.status(401).json({ ok: false, error: 'Not authenticated' });

  try {
    const { createClient } = require('@supabase/supabase-js');
    const db = createClient(
      process.env.SUPABASE_URL || '',
      process.env.SUPABASE_SERVICE_ROLE_KEY || '',
      { auth: { persistSession: false } }
    );
    const phone = (await resolveFromId()).replace(/^whatsapp:/, '');
    const { data } = await db
      .from('pending_captures')
      .select('draft_payload')
      .eq('status', 'preview_pending')
      .or(`phone.eq.${phone},phone.eq.whatsapp:${phone}`)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!data?.draft_payload) return res.status(404).json({ ok: false, error: 'No draft found' });
    return res.status(200).json({ ok: true, title: data.draft_payload.title || '', body: data.draft_payload.body || '' });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8'))); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function readFormBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try {
        const params = new URLSearchParams(Buffer.concat(chunks).toString('utf-8'));
        resolve(Object.fromEntries(params.entries()));
      } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── Login HTML (plain form, zero JS required) ────────────────────────────────

function loginHTML(errorMsg) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="theme-color" content="#1a1a1a">
<title>MrPaint OS</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#1a1a1a;display:flex;align-items:center;justify-content:center}
form{display:flex;flex-direction:column;align-items:center;gap:20px;padding:32px 24px;width:100%;max-width:320px}
.logo{font-size:48px}
h1{color:#fff;font-size:22px;font-weight:700}
.sub{color:rgba(255,255,255,.5);font-size:14px;text-align:center}
input[name=pin]{font-size:28px;letter-spacing:12px;text-align:center;border:none;border-bottom:2px solid #f5c518;background:transparent;color:#fff;width:180px;outline:none;padding:8px 0}
button{background:#f5c518;color:#000;border:none;padding:12px 32px;border-radius:24px;font-size:16px;font-weight:700;cursor:pointer;width:100%;max-width:200px}
.err{color:#ff3b30;font-size:14px;min-height:20px;text-align:center}
</style>
</head>
<body>
<form method="POST" action="/chat">
  <div class="logo">🎨</div>
  <h1>MrPaint OS</h1>
  <div class="sub">Enter your 4-digit PIN to continue</div>
  <input type="tel" name="pin" inputmode="numeric" pattern="[0-9]*" placeholder="••••" maxlength="4" autocomplete="off" autofocus />
  <button type="submit">Unlock</button>
  <div class="err">${escapeHtml(errorMsg)}</div>
</form>
</body>
</html>`;
}

// ─── Chat HTML ─────────────────────────────────────────────────────────────────

function chatHTML(isTest) {
  const testBadge = isTest
    ? ' <span style="background:#f5c518;color:#000;font-size:11px;padding:2px 7px;border-radius:10px;font-weight:700;vertical-align:middle;letter-spacing:.05em">TEST</span>'
    : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="theme-color" content="#1a1a1a">
<title>MrPaint OS</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#f0f0f0;--bubble-out:#dcf8c6;--bubble-in:#fff;
  --header:#1a1a1a;--accent:#f5c518;--send:#25d366;
  --text:#111;--muted:#666;--border:#ddd;
  --font:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
}
html,body{height:100%;overflow:hidden;font-family:var(--font);background:var(--bg)}
#app{display:flex;flex-direction:column;height:100dvh;max-width:600px;margin:0 auto}
#header{background:var(--header);color:#fff;padding:12px 16px;display:flex;align-items:center;gap:12px;flex-shrink:0}
#header-avatar{width:40px;height:40px;border-radius:50%;background:var(--accent);color:#000;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:16px;flex-shrink:0}
#header-info{flex:1}
#header-name{font-weight:600;font-size:16px}
#header-status{font-size:12px;opacity:.7;margin-top:1px}
#messages{flex:1;overflow-y:auto;padding:12px 10px;display:flex;flex-direction:column;gap:4px;-webkit-overflow-scrolling:touch}
.msg{max-width:82%;padding:7px 10px 6px;border-radius:8px;font-size:15px;line-height:1.4;position:relative;word-break:break-word}
.msg-out{align-self:flex-end;background:var(--bubble-out);border-radius:8px 0 8px 8px}
.msg-in{align-self:flex-start;background:var(--bubble-in);border-radius:0 8px 8px 8px;box-shadow:0 1px 1px rgba(0,0,0,.08)}
.msg-time{font-size:11px;color:var(--muted);margin-top:2px;text-align:right}
.msg-media{max-width:220px;border-radius:6px;display:block;margin-bottom:4px}
.msg-audio{width:200px}
.thinking{opacity:.6;font-style:italic}
.date-div{text-align:center;margin:8px 0}
.date-div span{background:rgba(0,0,0,.12);color:#fff;font-size:12px;padding:3px 10px;border-radius:12px}
#input-bar{background:#fff;border-top:1px solid var(--border);padding:8px;display:flex;align-items:flex-end;gap:6px;flex-shrink:0}
#msg-input{flex:1;border:none;outline:none;resize:none;font-size:16px;font-family:var(--font);padding:8px 10px;border-radius:20px;background:#f5f5f5;max-height:120px;line-height:1.4}
.icon-btn{width:40px;height:40px;border-radius:50%;border:none;background:#f0f0f0;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0;transition:background .15s}
.icon-btn:active{background:#ddd}
#send-btn{background:var(--send);color:#fff;font-size:20px}
#send-btn:active{background:#1da851}
#record-btn.recording{background:#ff3b30;animation:pulse 1s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.6}}
</style>
</head>
<body>
<div id="app">
  <div id="header">
    <div id="header-avatar">M</div>
    <div id="header-info">
      <div id="header-name">MrPaint OS${testBadge}</div>
      <div id="header-status">Your site assistant</div>
    </div>
  </div>
  <div id="messages"></div>
  <div id="input-bar">
    <button class="icon-btn" id="attach-btn" title="Send photo">📎</button>
    <input id="file-input" type="file" accept="image/*" style="display:none" />
    <textarea id="msg-input" rows="1" placeholder="Message…"></textarea>
    <button class="icon-btn" id="record-btn" title="Voice note">🎤</button>
    <button class="icon-btn" id="send-btn" title="Send">➤</button>
  </div>
</div>
<script>
(function(){
  const API = '/api/chat-web';
  const msgList = document.getElementById('messages');

  function now() {
    return new Date().toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' });
  }

  function addMsg(content, type, isMedia) {
    const div = document.createElement('div');
    div.className = 'msg msg-' + type;
    if (isMedia === 'image') {
      const img = document.createElement('img');
      img.src = content; img.className = 'msg-media';
      div.appendChild(img);
    } else if (isMedia === 'audio') {
      const audio = document.createElement('audio');
      audio.src = content; audio.controls = true; audio.className = 'msg-audio';
      div.appendChild(audio);
    } else {
      const html = content
        .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
        .replace(/\\*(.*?)\\*/g,'<strong>$1</strong>')
        .replace(/(https?:\\/\\/[^\\s<]+)/g,'<a href="$1" target="_blank" rel="noopener" style="color:#1a73e8;word-break:break-all">$1</a>')
        .replace(/\\n/g,'<br>');
      div.innerHTML = html;
      if (type === 'in' && content.includes('Preview:') && content.includes('YES')) {
        const editBtn = document.createElement('button');
        editBtn.textContent = '\\u270F\\uFE0F Edit text';
        editBtn.style.cssText = 'display:block;margin-top:8px;background:#f0f0f0;border:none;border-radius:14px;padding:6px 14px;font-size:13px;cursor:pointer;';
        editBtn.addEventListener('click', openEditOverlay);
        div.appendChild(editBtn);
      }
    }
    const time = document.createElement('div');
    time.className = 'msg-time'; time.textContent = now();
    div.appendChild(time);
    msgList.appendChild(div);
    msgList.scrollTop = msgList.scrollHeight;
    return div;
  }

  function addThinking() {
    const div = document.createElement('div');
    div.className = 'msg msg-in thinking';
    div.textContent = '\\u2026';
    msgList.appendChild(div);
    msgList.scrollTop = msgList.scrollHeight;
    return div;
  }

  function addBotMessages(replies) {
    replies.forEach(function(r, i) { setTimeout(function(){ addMsg(r, 'in'); }, i * 300); });
  }

  // ── Send ──────────────────────────────────────────────────────────────────
  async function send(message, media) {
    if (!message && !media) return;
    if (message) addMsg(message, 'out');
    if (media && media.type === 'image') addMsg(media.preview, 'out', 'image');
    if (media && media.type === 'audio') addMsg(media.preview, 'out', 'audio');
    const thinking = addThinking();
    const payload = { message: message };
    if (media) payload.media = { data: media.data, contentType: media.contentType };
    try {
      const r = await fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (r.status === 401) { location.href = '/chat'; return; }
      const data = await r.json();
      thinking.remove();
      if (data.replies && data.replies.length) addBotMessages(data.replies);
      else addMsg('\\u26A0\\uFE0F No reply received.', 'in');
    } catch (err) {
      thinking.remove();
      addMsg('\\u26A0\\uFE0F Network error \\u2014 check your connection.', 'in');
    }
  }

  // ── Text input ────────────────────────────────────────────────────────────
  const input = document.getElementById('msg-input');
  const sendBtn = document.getElementById('send-btn');
  input.addEventListener('input', function() {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 120) + 'px';
  });
  input.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); }
  });
  sendBtn.addEventListener('click', doSend);
  function doSend() {
    const msg = input.value.trim();
    if (!msg) return;
    input.value = ''; input.style.height = 'auto';
    send(msg, null);
  }

  // ── Photo ─────────────────────────────────────────────────────────────────
  const attachBtn = document.getElementById('attach-btn');
  const fileInput = document.getElementById('file-input');
  attachBtn.addEventListener('click', function(){ fileInput.click(); });
  fileInput.addEventListener('change', function() {
    const file = fileInput.files[0];
    if (!file) return;
    fileInput.value = '';
    compressImage(file, 1600, 0.75).then(function(res) {
      const base64 = res.dataUrl.split(',')[1];
      const msg = input.value.trim();
      input.value = ''; input.style.height = 'auto';
      send(msg, { type: 'image', data: base64, contentType: res.blob.type, preview: res.dataUrl });
    }).catch(function() {
      const reader = new FileReader();
      reader.onload = function() {
        const dataUrl = reader.result;
        send(input.value.trim(), { type: 'image', data: dataUrl.split(',')[1], contentType: file.type, preview: dataUrl });
        input.value = ''; input.style.height = 'auto';
      };
      reader.readAsDataURL(file);
    });
  });

  function compressImage(file, maxPx, quality) {
    return new Promise(function(resolve, reject) {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = function() {
        URL.revokeObjectURL(url);
        let w = img.width, h = img.height;
        if (w > maxPx || h > maxPx) {
          if (w > h) { h = Math.round(h * maxPx / w); w = maxPx; }
          else { w = Math.round(w * maxPx / h); h = maxPx; }
        }
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        canvas.toBlob(function(blob) {
          if (!blob) { reject(new Error('canvas toBlob failed')); return; }
          const reader = new FileReader();
          reader.onload = function(){ resolve({ dataUrl: reader.result, blob: blob }); };
          reader.readAsDataURL(blob);
        }, 'image/jpeg', quality);
      };
      img.onerror = reject;
      img.src = url;
    });
  }

  // ── Voice recording ───────────────────────────────────────────────────────
  const recordBtn = document.getElementById('record-btn');
  let mediaRecorder = null;
  let audioChunks = [];
  recordBtn.addEventListener('click', async function() {
    if (mediaRecorder && mediaRecorder.state === 'recording') { mediaRecorder.stop(); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : 'audio/webm';
      mediaRecorder = new MediaRecorder(stream, { mimeType: mimeType });
      audioChunks = [];
      mediaRecorder.ondataavailable = function(e) { if (e.data.size > 0) audioChunks.push(e.data); };
      mediaRecorder.onstop = function() {
        stream.getTracks().forEach(function(t){ t.stop(); });
        recordBtn.classList.remove('recording');
        recordBtn.textContent = '\\uD83C\\uDFA4';
        const blob = new Blob(audioChunks, { type: mimeType });
        const reader = new FileReader();
        reader.onload = function() {
          const base64 = reader.result.split(',')[1];
          const preview = URL.createObjectURL(blob);
          send('', { type: 'audio', data: base64, contentType: mimeType, preview: preview });
        };
        reader.readAsDataURL(blob);
      };
      mediaRecorder.start();
      recordBtn.classList.add('recording');
      recordBtn.textContent = '\\u23F9';
    } catch(e) {
      alert('Microphone access denied. Check browser permissions.');
    }
  });

  // ── Edit overlay ──────────────────────────────────────────────────────────
  async function openEditOverlay() {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:#fff;z-index:200;display:flex;flex-direction:column;';
    const header = document.createElement('div');
    header.style.cssText = 'background:#1a1a1a;color:#fff;padding:14px 16px;display:flex;align-items:center;gap:12px;flex-shrink:0;';
    header.innerHTML = '<button id="edit-cancel" style="background:none;border:none;color:#fff;font-size:20px;cursor:pointer;padding:0">\\u2190</button><span style="font-weight:600;font-size:16px;flex:1">Edit post text</span><button id="edit-send" style="background:#f5c518;color:#000;border:none;border-radius:20px;padding:8px 18px;font-weight:700;font-size:14px;cursor:pointer">Send</button>';
    overlay.appendChild(header);
    const loading = document.createElement('div');
    loading.style.cssText = 'flex:1;display:flex;align-items:center;justify-content:center;color:#666;font-size:15px;';
    loading.textContent = 'Loading draft\\u2026';
    overlay.appendChild(loading);
    document.body.appendChild(overlay);
    header.querySelector('#edit-cancel').addEventListener('click', function(){ overlay.remove(); });
    let draftBody = '';
    try {
      const r = await fetch(API + '?draft=1');
      const d = await r.json();
      if (d.ok) draftBody = d.body;
      else { loading.textContent = 'No draft found \\u2014 send a photo first.'; return; }
    } catch(e) { loading.textContent = 'Could not load draft.'; return; }
    loading.remove();
    const ta = document.createElement('textarea');
    ta.value = draftBody;
    ta.style.cssText = 'flex:1;border:none;outline:none;padding:16px;font-size:15px;font-family:-apple-system,sans-serif;line-height:1.5;resize:none;';
    overlay.appendChild(ta);
    setTimeout(function(){ ta.focus(); }, 50);
    header.querySelector('#edit-send').addEventListener('click', function() {
      const newBody = ta.value.trim();
      if (!newBody) return;
      overlay.remove();
      send('EDIT: ' + newBody, null);
    });
  }

  // ── Welcome ───────────────────────────────────────────────────────────────
  setTimeout(function(){
    addMsg("G'day boss \\u2014 ready when you are. Send a photo, voice note, or just type.", 'in');
  }, 300);

})();
</script>
</body>
</html>`;
}

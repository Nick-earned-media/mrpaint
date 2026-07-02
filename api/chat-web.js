// Web chat handler — serves the chat UI (GET) and processes messages (POST).
//
// Adrian accesses /chat on his phone browser, enters a PIN once, then chats
// with the bot exactly like WhatsApp.
//
// Supports: text messages, photo uploads, voice recording (WebM/opus)
//
// Env vars:
//   WEBCHAT_PIN           — 4-digit PIN for Adrian (production)
//   WEBCHAT_TEST_PIN      — 4-digit PIN for Nick to test before handoff
//   WEBCHAT_CLIENT_PHONE  — maps web user to a Supabase client row
//                           (defaults to first ALLOWED_PHONES entry)

const { runWithContext } = require("./whatsapp.js");

const WEBCHAT_PIN = process.env.WEBCHAT_PIN || "";
const WEBCHAT_TEST_PIN = process.env.WEBCHAT_TEST_PIN || "";
const WEBCHAT_CLIENT_PHONE =
  process.env.WEBCHAT_CLIENT_PHONE ||
  (process.env.ALLOWED_PHONES || "").split(",").map((s) => s.trim()).filter(Boolean)[0] ||
  "";

module.exports = async function handler(req, res) {
  if (req.method === "GET") {
    const qs = new URL(req.url, "http://x").searchParams;
    if (qs.get("draft") === "1") return handleGetDraft(req, res, qs);
    return serveUI(res);
  }
  if (req.method === "POST") return handleChat(req, res);
  res.setHeader("Allow", "GET, POST");
  return res.status(405).end("Method Not Allowed");
};

// ─── POST handler ─────────────────────────────────────────────────────────────

async function handleChat(req, res) {
  let body;
  try {
    body = await readJson(req);
  } catch {
    return res.status(400).json({ ok: false, error: "Bad JSON" });
  }

  // PIN check — accept production PIN or test PIN
  const isTest = WEBCHAT_TEST_PIN && body.pin === WEBCHAT_TEST_PIN;
  const isProd = WEBCHAT_PIN && body.pin === WEBCHAT_PIN;
  if (!isTest && !isProd) {
    return res.status(401).json({ ok: false, error: "Invalid PIN" });
  }

  // Silent PIN check — client sends this to validate PIN without triggering the bot
  if (body.pin_check) {
    return res.status(200).json({ ok: true, testMode: isTest });
  }

  const message = (body.message || "").trim();
  const mediaData = body.media; // { data: base64, contentType: string }

  if (!message && !mediaData) {
    return res.status(400).json({ ok: false, error: "No message or media" });
  }

  // Collect all bot replies synchronously
  const replies = [];
  const contentType = mediaData?.contentType || "image/jpeg";
  const isImage = contentType.startsWith("image/");

  // For images: store as a data URI so the URL survives beyond this request.
  // When the bot later re-downloads the image (e.g. from a voice-note request),
  // downloadTwilioMedia detects "data:" and decodes it directly — no buffer needed.
  // For audio: keep "web-upload" so the ctx buffer is used within this request.
  const mediaUrl = (mediaData && isImage)
    ? `data:${contentType};base64,${mediaData.data}`
    : "web-upload";

  const mediaBuffer = (mediaData && !isImage && mediaData.data)
    ? Buffer.from(mediaData.data, "base64")
    : null;

  const ctx = {
    sendMessage: async (_toIgnored, text) => {
      replies.push(text);
    },
    downloadMedia: async (url) => {
      // Only handle the audio "web-upload" case — images are self-contained data URIs
      // handled by downloadTwilioMedia before it reaches this ctx.
      if (url === "web-upload" && mediaBuffer) return mediaBuffer;
      throw new Error(`Unexpected downloadMedia call for: ${url}`);
    },
  };

  const media = mediaData
    ? { url: mediaUrl, contentType }
    : null;

  // Use the client phone as fromId so Supabase lookups work
  const fromId = WEBCHAT_CLIENT_PHONE || "web:unknown";

  try {
    await runWithContext(fromId, message, media, ctx);
  } catch (err) {
    console.error("chat-web error:", err);
    replies.push("⚠️ Something went wrong — please try again.");
  }

  return res.status(200).json({ ok: true, replies });
}

// ─── GET handler — serve the chat UI ─────────────────────────────────────────

function serveUI(res) {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.setHeader("Cache-Control", "no-store");
  res.status(200).end(HTML);
}

// ─── GET draft endpoint ────────────────────────────────────────────────────────
// Returns the body text of the current preview_pending draft for the client.
// Used by the web chat UI to pre-fill the edit textarea.

async function handleGetDraft(req, res, qs) {
  const pin = qs.get("pin") || "";
  const isTest = WEBCHAT_TEST_PIN && pin === WEBCHAT_TEST_PIN;
  const isProd = WEBCHAT_PIN && pin === WEBCHAT_PIN;
  if (!isTest && !isProd) return res.status(401).json({ ok: false, error: "Invalid PIN" });

  try {
    const { createClient } = require("@supabase/supabase-js");
    const db = createClient(
      process.env.SUPABASE_URL || "",
      process.env.SUPABASE_SERVICE_ROLE_KEY || "",
      { auth: { persistSession: false } }
    );
    const phone = WEBCHAT_CLIENT_PHONE.replace(/^whatsapp:/, "");
    const { data } = await db
      .from("pending_captures")
      .select("draft_payload")
      .eq("status", "preview_pending")
      .or(`phone.eq.${phone},phone.eq.whatsapp:${phone}`)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!data?.draft_payload) {
      return res.status(404).json({ ok: false, error: "No draft found" });
    }
    return res.status(200).json({
      ok: true,
      title: data.draft_payload.title || "",
      body: data.draft_payload.body || "",
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8"))); }
      catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

// ─── Chat UI ──────────────────────────────────────────────────────────────────

const HTML = `<!DOCTYPE html>
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

/* Header */
#header{
  background:var(--header);color:#fff;
  padding:12px 16px;display:flex;align-items:center;gap:12px;
  flex-shrink:0;
}
#header-avatar{
  width:40px;height:40px;border-radius:50%;
  background:var(--accent);color:#000;
  display:flex;align-items:center;justify-content:center;
  font-weight:700;font-size:16px;flex-shrink:0;
}
#header-info{flex:1}
#header-name{font-weight:600;font-size:16px}
#header-status{font-size:12px;opacity:.7;margin-top:1px}

/* Messages */
#messages{
  flex:1;overflow-y:auto;padding:12px 10px;
  display:flex;flex-direction:column;gap:4px;
  -webkit-overflow-scrolling:touch;
}
.msg{max-width:82%;padding:7px 10px 6px;border-radius:8px;font-size:15px;line-height:1.4;position:relative;word-break:break-word}
.msg-out{align-self:flex-end;background:var(--bubble-out);border-radius:8px 0 8px 8px}
.msg-in{align-self:flex-start;background:var(--bubble-in);border-radius:0 8px 8px 8px;box-shadow:0 1px 1px rgba(0,0,0,.08)}
.msg-time{font-size:11px;color:var(--muted);margin-top:2px;text-align:right}
.msg-media{max-width:220px;border-radius:6px;display:block;margin-bottom:4px}
.msg-audio{width:200px}
.thinking{opacity:.6;font-style:italic}

/* Date divider */
.date-div{text-align:center;margin:8px 0}
.date-div span{background:rgba(0,0,0,.12);color:#fff;font-size:12px;padding:3px 10px;border-radius:12px}

/* Input bar */
#input-bar{
  background:#fff;border-top:1px solid var(--border);
  padding:8px;display:flex;align-items:flex-end;gap:6px;flex-shrink:0;
}
#msg-input{
  flex:1;border:none;outline:none;resize:none;
  font-size:16px;font-family:var(--font);
  padding:8px 10px;border-radius:20px;background:#f5f5f5;
  max-height:120px;line-height:1.4;
}
.icon-btn{
  width:40px;height:40px;border-radius:50%;border:none;
  background:#f0f0f0;cursor:pointer;display:flex;
  align-items:center;justify-content:center;font-size:18px;
  flex-shrink:0;transition:background .15s;
}
.icon-btn:active{background:#ddd}
#send-btn{background:var(--send);color:#fff;font-size:20px}
#send-btn:active{background:#1da851}
#record-btn.recording{background:#ff3b30;animation:pulse 1s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.6}}

/* PIN screen */
#pin-screen{
  position:fixed;inset:0;background:#1a1a1a;
  display:flex;flex-direction:column;align-items:center;justify-content:center;
  gap:20px;z-index:100;
}
#pin-screen.hidden{display:none}
#pin-logo{font-size:48px;margin-bottom:8px}
#pin-title{color:#fff;font-size:22px;font-weight:700}
#pin-sub{color:rgba(255,255,255,.5);font-size:14px}
#pin-input{
  font-size:28px;letter-spacing:12px;text-align:center;
  border:none;border-bottom:2px solid var(--accent);background:transparent;
  color:#fff;width:180px;outline:none;padding:8px 0;
}
#pin-btn{
  background:var(--accent);color:#000;border:none;
  padding:12px 32px;border-radius:24px;font-size:16px;
  font-weight:700;cursor:pointer;
}
#pin-error{color:#ff3b30;font-size:14px;min-height:20px}
</style>
</head>
<body>

<!-- PIN screen -->
<div id="pin-screen">
  <div id="pin-logo">🎨</div>
  <div id="pin-title">MrPaint OS</div>
  <div id="pin-sub">Enter your 4-digit PIN to continue</div>
  <input id="pin-input" type="tel" inputmode="numeric" pattern="[0-9]*" placeholder="••••" maxlength="4" autocomplete="off" />
  <button id="pin-btn">Unlock</button>
  <div id="pin-error"></div>
</div>

<!-- Chat -->
<div id="app">
  <div id="header">
    <div id="header-avatar">M</div>
    <div id="header-info">
      <div id="header-name">MrPaint OS</div>
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
  const PIN_KEY = 'mrpaint_pin';
  const API = '/api/chat-web';

  // ── PIN ──────────────────────────────────────────────────────────────────
  let savedPin = localStorage.getItem(PIN_KEY);
  const pinScreen = document.getElementById('pin-screen');
  const pinInput = document.getElementById('pin-input');
  const pinBtn = document.getElementById('pin-btn');
  const pinError = document.getElementById('pin-error');

  if (savedPin) pinScreen.classList.add('hidden');

  async function submitPin() {
    if (submitting) return;
    const pin = pinInput.value.replace(/\D/g, '');
    if (pin.length < 4) return;
    submitting = true;
    pinError.textContent = '';
    pinBtn.textContent = '…';
    try {
      const r = await fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin, pin_check: true }),
      });
      if (r.status === 401) {
        pinError.textContent = 'Incorrect PIN — try again';
        pinInput.value = '';
        pinBtn.textContent = 'Unlock';
        submitting = false;
        return;
      }
      const data = await r.json();
      if (data.testMode) localStorage.setItem(PIN_KEY + '_test', '1');
      else localStorage.removeItem(PIN_KEY + '_test');
      savedPin = pin;
      localStorage.setItem(PIN_KEY, pin);
      pinScreen.classList.add('hidden');
      if (data.testMode) document.getElementById('header-name').innerHTML = 'MrPaint OS <span style="background:#f5c518;color:#000;font-size:11px;padding:2px 7px;border-radius:10px;font-weight:700;vertical-align:middle;letter-spacing:.05em">TEST</span>';
      setTimeout(() => {
        addMsg("G'day boss — ready when you are. Send a photo, voice note, or just type.", 'in');
      }, 300);
    } catch (err) {
      pinError.textContent = 'Connection error — check your internet and try again';
      pinBtn.textContent = 'Unlock';
      submitting = false;
    }
  }

  let submitting = false;
  pinBtn.addEventListener('click', submitPin);
  pinInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitPin(); });
  pinInput.addEventListener('input', () => {
    // Strip non-digits (tel input can accept other chars)
    pinInput.value = pinInput.value.replace(/\D/g, '').slice(0, 4);
    if (pinInput.value.length === 4) submitPin();
  });

  // ── Messages ─────────────────────────────────────────────────────────────
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
      // Render *bold*, newlines, and clickable https:// links
      const html = content
        .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
        .replace(/\\*(.*?)\\*/g,'<strong>$1</strong>')
        .replace(/(https?:\/\/[^\s<]+)/g,'<a href="$1" target="_blank" rel="noopener" style="color:#1a73e8;word-break:break-all">$1</a>')
        .replace(/\\n/g,'<br>');
      div.innerHTML = html;

      // If this is a draft confirmation message, add an Edit button
      if (type === 'in' && content.includes('Preview:') && content.includes('YES')) {
        const editBtn = document.createElement('button');
        editBtn.textContent = '✏️ Edit text';
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
    div.textContent = '…';
    msgList.appendChild(div);
    msgList.scrollTop = msgList.scrollHeight;
    return div;
  }

  function addBotMessages(replies) {
    replies.forEach((r, i) => {
      setTimeout(() => addMsg(r, 'in'), i * 300);
    });
  }

  // ── Send ──────────────────────────────────────────────────────────────────
  async function send(message, media) {
    if (!message && !media) return;

    if (message) addMsg(message, 'out');
    if (media?.type === 'image') addMsg(media.preview, 'out', 'image');
    if (media?.type === 'audio') addMsg(media.preview, 'out', 'audio');

    const thinking = addThinking();

    const payload = { pin: savedPin, message };
    if (media) payload.media = { data: media.data, contentType: media.contentType };

    try {
      const r = await fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (r.status === 401) {
        localStorage.removeItem(PIN_KEY);
        location.reload();
        return;
      }

      const data = await r.json();
      thinking.remove();

      if (data.replies?.length) {
        addBotMessages(data.replies);
      } else {
        addMsg('⚠️ No reply received.', 'in');
      }
    } catch (err) {
      thinking.remove();
      addMsg('⚠️ Network error — check your connection.', 'in');
    }
  }

  // ── Text input ────────────────────────────────────────────────────────────
  const input = document.getElementById('msg-input');
  const sendBtn = document.getElementById('send-btn');

  input.addEventListener('input', function() {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 120) + 'px';
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      doSend();
    }
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

  attachBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    if (!file) return;
    fileInput.value = '';
    // Compress before upload — iPhone photos can be 4-5MB which breaks Vercel's 4.5MB limit
    compressImage(file, 1600, 0.75).then(({ dataUrl, blob }) => {
      const base64 = dataUrl.split(',')[1];
      const msg = input.value.trim();
      input.value = ''; input.style.height = 'auto';
      send(msg, { type: 'image', data: base64, contentType: blob.type, preview: dataUrl });
    }).catch(() => {
      // Fall back to uncompressed if Canvas is unavailable
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result;
        send(input.value.trim(), { type: 'image', data: dataUrl.split(',')[1], contentType: file.type, preview: dataUrl });
        input.value = ''; input.style.height = 'auto';
      };
      reader.readAsDataURL(file);
    });
  });

  function compressImage(file, maxPx, quality) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        let { width: w, height: h } = img;
        if (w > maxPx || h > maxPx) {
          if (w > h) { h = Math.round(h * maxPx / w); w = maxPx; }
          else { w = Math.round(w * maxPx / h); h = maxPx; }
        }
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        canvas.toBlob(blob => {
          if (!blob) { reject(new Error('canvas toBlob failed')); return; }
          const reader = new FileReader();
          reader.onload = () => resolve({ dataUrl: reader.result, blob });
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

  recordBtn.addEventListener('click', async () => {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      mediaRecorder.stop();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/mp4')
        ? 'audio/mp4'
        : 'audio/webm';
      mediaRecorder = new MediaRecorder(stream, { mimeType });
      audioChunks = [];
      mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunks.push(e.data); };
      mediaRecorder.onstop = () => {
        stream.getTracks().forEach(t => t.stop());
        recordBtn.classList.remove('recording');
        recordBtn.textContent = '🎤';
        const blob = new Blob(audioChunks, { type: mimeType });
        const reader = new FileReader();
        reader.onload = () => {
          const base64 = reader.result.split(',')[1];
          const preview = URL.createObjectURL(blob);
          send('', { type: 'audio', data: base64, contentType: mimeType, preview });
        };
        reader.readAsDataURL(blob);
      };
      mediaRecorder.start();
      recordBtn.classList.add('recording');
      recordBtn.textContent = '⏹';
    } catch {
      alert('Microphone access denied. Check browser permissions.');
    }
  });

  // ── Edit overlay ─────────────────────────────────────────────────────────
  async function openEditOverlay() {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:#fff;z-index:200;display:flex;flex-direction:column;';

    const header = document.createElement('div');
    header.style.cssText = 'background:#1a1a1a;color:#fff;padding:14px 16px;display:flex;align-items:center;gap:12px;flex-shrink:0;';
    header.innerHTML = '<button id="edit-cancel" style="background:none;border:none;color:#fff;font-size:20px;cursor:pointer;padding:0">←</button><span style="font-weight:600;font-size:16px;flex:1">Edit post text</span><button id="edit-send" style="background:#f5c518;color:#000;border:none;border-radius:20px;padding:8px 18px;font-weight:700;font-size:14px;cursor:pointer">Send</button>';
    overlay.appendChild(header);

    const loading = document.createElement('div');
    loading.style.cssText = 'flex:1;display:flex;align-items:center;justify-content:center;color:#666;font-size:15px;';
    loading.textContent = 'Loading draft…';
    overlay.appendChild(loading);

    document.body.appendChild(overlay);

    header.querySelector('#edit-cancel').addEventListener('click', () => overlay.remove());

    // Fetch current draft body
    let draftBody = '';
    try {
      const r = await fetch('/api/chat-web?draft=1&pin=' + encodeURIComponent(savedPin));
      const d = await r.json();
      if (d.ok) draftBody = d.body;
      else { loading.textContent = 'No draft found — send a photo first.'; return; }
    } catch { loading.textContent = 'Could not load draft.'; return; }

    // Replace loading with textarea
    loading.remove();
    const ta = document.createElement('textarea');
    ta.value = draftBody;
    ta.style.cssText = 'flex:1;border:none;outline:none;padding:16px;font-size:15px;font-family:-apple-system,sans-serif;line-height:1.5;resize:none;';
    overlay.appendChild(ta);
    setTimeout(() => ta.focus(), 50);

    header.querySelector('#edit-send').addEventListener('click', () => {
      const newBody = ta.value.trim();
      if (!newBody) return;
      overlay.remove();
      send('EDIT: ' + newBody, null);
    });
  }

  // ── Welcome (already unlocked from a previous session) ───────────────────
  if (savedPin) {
    if (localStorage.getItem(PIN_KEY + '_test')) {
      document.getElementById('header-name').innerHTML = 'MrPaint OS <span style="background:#f5c518;color:#000;font-size:11px;padding:2px 7px;border-radius:10px;font-weight:700;vertical-align:middle;letter-spacing:.05em">TEST</span>';
    }
    setTimeout(() => {
      addMsg("G'day boss — ready when you are. Send a photo, voice note, or just type.", 'in');
    }, 300);
  }

})();
</script>
</body>
</html>`;

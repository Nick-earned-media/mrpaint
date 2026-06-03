// Voice-note transcription for WhatsApp.
//
// Twilio delivers voice messages as audio/ogg (Opus codec). OpenAI's Whisper
// API accepts that natively. ~$0.006/minute, so a 30-second voice note costs
// ~$0.003 — negligible at MrPaint's volume.
//
// Configuration: OPENAI_API_KEY in Vercel env. Without it, transcription is
// skipped and a clear status is returned so the bot can ask the user to type.

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;

async function downloadTwilioMedia(url) {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
    throw new Error("Twilio credentials missing — can't fetch the audio");
  }
  const auth = "Basic " + Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
  const r = await fetch(url, { headers: { Authorization: auth }, redirect: "follow" });
  if (!r.ok) throw new Error(`Twilio media download ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const contentType = r.headers.get("content-type") || "audio/ogg";
  return { buf, contentType };
}

function extFromContentType(ct) {
  const c = (ct || "").toLowerCase();
  if (c.includes("ogg")) return "ogg";
  if (c.includes("mpeg") || c.includes("mp3")) return "mp3";
  if (c.includes("mp4") || c.includes("m4a")) return "m4a";
  if (c.includes("wav")) return "wav";
  if (c.includes("webm")) return "webm";
  if (c.includes("amr")) return "amr";
  return "ogg";
}

/**
 * Transcribe a Twilio-hosted audio URL via OpenAI Whisper.
 * Returns { ok, text, error }.
 */
async function transcribeTwilioAudio(mediaUrl, mediaContentType) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return {
      ok: false,
      error: "OPENAI_API_KEY not configured — voice transcription unavailable. Set the env var in Vercel and redeploy.",
    };
  }
  try {
    const { buf, contentType } = await downloadTwilioMedia(mediaUrl);
    const ext = extFromContentType(mediaContentType || contentType);
    const filename = `voice.${ext}`;
    const blob = new Blob([buf], { type: mediaContentType || contentType });
    const form = new FormData();
    form.append("file", blob, filename);
    form.append("model", "whisper-1");
    form.append("response_format", "text");
    // English-leaning default — leave language unset so Whisper auto-detects.

    const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => "");
      return { ok: false, error: `Whisper ${r.status}: ${detail.slice(0, 200)}` };
    }
    const text = (await r.text()).trim();
    if (!text) return { ok: false, error: "Whisper returned empty transcription" };
    return { ok: true, text };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

module.exports = {
  transcribeTwilioAudio,
};

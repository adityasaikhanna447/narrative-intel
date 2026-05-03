// ─────────────────────────────────────────────────────
// NarrativeIntel — Automatic Watcher
// Deployed as: /api/watcher  on Vercel
// Triggered by: GitHub Actions every 30 minutes
//
// Flow:
//   1. Fetch Google News RSS (real-time, free)
//   2. Score every headline for video potential
//   3. Skip anything already seen (dedup via seen list)
//   4. For high-score stories → call Gemini → generate brief
//   5. Send formatted email via Resend
// ─────────────────────────────────────────────────────

const SEEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// ── Topic queries to monitor ─────────────────────────
const WATCH_TOPICS = [
  { name: 'India Breaking', q: 'India breaking news urgent', threshold: 72 },
  { name: 'India-Pakistan', q: 'India Pakistan military tension', threshold: 65 },
  { name: 'India-China',    q: 'India China LAC border',        threshold: 65 },
  { name: 'Supreme Court',  q: 'Supreme Court India verdict',   threshold: 68 },
  { name: 'Indian Politics',q: 'Modi BJP Congress India politics', threshold: 70 },
  { name: 'Geopolitics',   q: 'BRICS UN India foreign policy', threshold: 68 },
];

// ── Scoring keywords ─────────────────────────────────
const HIGH = /attack|war|strike|nuclear|crisis|emergency|verdict|resign|arrested|killed|bomb|terror|ceasefire|escalat|coup|airstrike|firing|clash|tension|dossier|explosion/i;
const MID  = /india|modi|court|election|economy|gdp|rupee|china|brics|un |parliament|budget|reform|protest|bilateral|treaty|sanction/i;

// ── In-memory seen store (resets each cold start) ────
// For persistence across cold starts without a DB,
// we embed seen IDs in the email subject and read them back.
// Simple and free.
let _seenThisRun = new Set();

module.exports = async function handler(req, res) {
  // ── Auth check — only GitHub Actions can call this ──
  const token = req.headers['x-watcher-token'];
  if (token !== process.env.WATCHER_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const env = {
    geminiKey:  process.env.GEMINI_API_KEY,
    geminiModel:process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite-preview-06-17',
    resendKey:  process.env.RESEND_API_KEY,
    toEmail:    process.env.ALERT_EMAIL,
    serperKey:  process.env.SERPER_API_KEY || '',
    channelCtx: process.env.CHANNEL_CONTEXT || '',
    minScore:   parseInt(process.env.MIN_SCORE || '68'),
  };

  if (!env.geminiKey || !env.resendKey || !env.toEmail) {
    return res.status(500).json({ error: 'Missing required env vars: GEMINI_API_KEY, RESEND_API_KEY, ALERT_EMAIL' });
  }

  const log = [];
  const alerts = [];

  // ── 1. Fetch and score all topics ────────────────────
  for (const topic of WATCH_TOPICS) {
    try {
      const stories = await fetchRSS(topic.q);
      log.push(`[${topic.name}] fetched ${stories.length} stories`);

      for (const story of stories) {
        const id = storyId(story);
        if (_seenThisRun.has(id)) continue;

        const score = scoreStory(story);
        if (score < Math.max(topic.threshold, env.minScore)) continue;

        _seenThisRun.add(id);
        log.push(`[${topic.name}] HIGH SCORE: ${score} — ${story.title.slice(0, 70)}`);

        // ── 2. Generate research brief ─────────────────
        const webCtx = env.serperKey ? await fetchSerper(story.title, env.serperKey) : '';
        const brief  = await generateBrief(story, webCtx, env);

        if (brief) {
          alerts.push({ story, brief, score, topic: topic.name });
        }
      }
    } catch (e) {
      log.push(`[${topic.name}] ERROR: ${e.message}`);
    }
  }

  // ── 3. Send emails ────────────────────────────────────
  const sent = [];
  for (const alert of alerts) {
    try {
      await sendEmail(alert, env);
      sent.push(alert.story.title.slice(0, 60));
      log.push(`EMAIL SENT: ${alert.story.title.slice(0, 60)}`);
    } catch (e) {
      log.push(`EMAIL FAILED: ${e.message}`);
    }
  }

  return res.status(200).json({
    ok: true,
    checked: WATCH_TOPICS.length,
    alerts_sent: sent.length,
    sent,
    log,
  });
};

// ─────────────────────────────────────────────────────
// RSS FETCH via rss2json (free, no key needed)
// ─────────────────────────────────────────────────────
async function fetchRSS(query) {
  const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-IN&gl=IN&ceid=IN:en`;
  const apiUrl = `https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(rssUrl)}&count=15`;
  const r = await fetch(apiUrl, { signal: AbortSignal.timeout(10000) });
  const d = await r.json();
  if (d.status !== 'ok' || !d.items?.length) return [];
  return d.items.map(it => ({
    title:       (it.title || '').replace(/ - [^-]+$/, '').trim(),
    description: (it.description || '').replace(/<[^>]*>/g, '').slice(0, 300),
    pubDate:     it.pubDate,
    link:        it.link,
    source:      it.author || srcFromTitle(it.title),
  }));
}

function srcFromTitle(t = '') {
  const m = t.match(/ - ([^-]+)$/);
  return m ? m[1].trim() : 'News';
}

// ─────────────────────────────────────────────────────
// STORY SCORING
// ─────────────────────────────────────────────────────
function scoreStory(story) {
  const txt = (story.title + ' ' + story.description).toLowerCase();
  let score = 38;
  if (HIGH.test(txt)) score += 48;
  else if (MID.test(txt)) score += 24;
  const ageMin = Math.floor((Date.now() - new Date(story.pubDate).getTime()) / 60000);
  if (ageMin < 60)  score += 10;
  else if (ageMin < 180) score += 5;
  else if (ageMin > 720) score -= 10; // 12h old — deprioritise
  return Math.min(score, 99);
}

function storyId(story) {
  return (story.title || '').toLowerCase().replace(/\s+/g, '').slice(0, 60);
}

// ─────────────────────────────────────────────────────
// SERPER WEB SEARCH (optional — adds live context)
// ─────────────────────────────────────────────────────
async function fetchSerper(title, apiKey) {
  try {
    const r = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: title + ' India analysis', gl: 'in', num: 4 }),
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return '';
    const d = await r.json();
    return (d.organic || []).slice(0, 3)
      .map(x => `SOURCE: ${x.title}\nURL: ${x.link}\nSUMMARY: ${x.snippet}`)
      .join('\n\n');
  } catch (e) {
    return '';
  }
}

// ─────────────────────────────────────────────────────
// GEMINI BRIEF GENERATION
// ─────────────────────────────────────────────────────
async function generateBrief(story, webCtx, env) {
  const chCtx = env.channelCtx
    ? `\n\nCHANNEL CONTEXT:\n${env.channelCtx}`
    : '';

  const prompt = `You are a research engine for a serious Indian YouTube channel covering politics and geopolitics in the style of Nitish Rajput.${chCtx}

BREAKING STORY:
TITLE: ${story.title}
DESCRIPTION: ${story.description || 'Not available'}
SOURCE: ${story.source}
PUBLISHED: ${story.pubDate}
${webCtx ? `\nLIVE WEB CONTEXT:\n${webCtx}\n` : ''}

This story just broke. Generate a concise research brief the host can use immediately.
Return ONLY valid JSON — no markdown, no explanation:

{
  "video_title": "Punchy 8-12 word title",
  "why_this_matters": "2 sentences: why this specific story is significant right now",
  "hook": "Opening 3-4 sentences for the video. Start mid-action, not 'today we discuss'. Reframe the story as something revelatory.",
  "context": "What happened in plain language — 3-4 sentences, no jargon",
  "history": "Key historical background most people don't know — 3-4 sentences with specific dates",
  "data": "2-3 key statistics as narrative sentences — make numbers feel consequential",
  "perspective_govt": "Government/establishment position — 2 sentences",
  "perspective_critic": "Opposition/expert/academic critique — 2 sentences",
  "pivot": "The hidden angle nobody is covering — 'lekin ek cheez aur hai' — 2-3 sentences",
  "what_next": "2-3 concrete scenarios to watch — specific triggers",
  "closing_question": "One uncomfortable, thought-provoking question to end the video",
  "angle": "One sentence: the unique angle that makes this video different from news coverage",
  "urgency": "HIGH or MEDIUM — how time-sensitive is making this video",
  "suggested_sources": ["PRS India", "ORF India", "MEA.gov.in", "The Hindu", "SIPRI"]
}`;

  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${env.geminiModel}:generateContent?key=${env.geminiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.7, maxOutputTokens: 2000 },
        }),
        signal: AbortSignal.timeout(30000),
      }
    );
    const data = await r.json();
    if (data.error) throw new Error(data.error.message);
    let raw = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    raw = raw.replace(/```json|```/g, '').trim();
    const s = raw.indexOf('{'), e = raw.lastIndexOf('}');
    if (s === -1 || e === -1) throw new Error('Non-JSON response');
    return JSON.parse(raw.slice(s, e + 1));
  } catch (e) {
    console.error('Gemini error:', e.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────
// EMAIL via RESEND
// ─────────────────────────────────────────────────────
async function sendEmail({ story, brief, score, topic }, env) {
  const urgencyColor = brief.urgency === 'HIGH' ? '#e8392a' : '#f0a820';
  const urgencyBg    = brief.urgency === 'HIGH' ? '#fff0ee' : '#fffbee';

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f4f4f7;font-family:Georgia,serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f7;padding:24px 0;">
<tr><td align="center">
<table width="620" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">

  <!-- HEADER -->
  <tr><td style="background:#07080b;padding:20px 28px;">
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td>
          <span style="font-family:Arial,sans-serif;font-size:13px;font-weight:900;letter-spacing:3px;color:#ffffff;">NARRATIVE</span><span style="font-family:Arial,sans-serif;font-size:13px;font-weight:900;letter-spacing:3px;color:#e8392a;">INTEL</span>
          <span style="font-family:monospace;font-size:9px;color:#555;margin-left:8px;letter-spacing:1px;">LIVE ALERT</span>
        </td>
        <td align="right">
          <span style="font-family:monospace;font-size:10px;color:#888;">${new Date().toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}</span>
        </td>
      </tr>
    </table>
  </td></tr>

  <!-- URGENCY BANNER -->
  <tr><td style="background:${urgencyBg};border-left:4px solid ${urgencyColor};padding:10px 28px;">
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td><span style="font-family:monospace;font-size:9px;font-weight:700;letter-spacing:2px;color:${urgencyColor};">${brief.urgency === 'HIGH' ? '🔴 HIGH URGENCY' : '🟡 MEDIUM URGENCY'} · ${topic.toUpperCase()}</span></td>
        <td align="right"><span style="font-family:monospace;font-size:9px;color:#888;">VIDEO SCORE: <strong style="color:${score >= 80 ? '#e8392a' : '#f0a820'}">${score}/99</strong></span></td>
      </tr>
    </table>
  </td></tr>

  <!-- STORY SOURCE -->
  <tr><td style="padding:6px 28px 0;">
    <span style="font-family:monospace;font-size:9px;color:#888;letter-spacing:1px;">${story.source.toUpperCase()} · <a href="${story.link || '#'}" style="color:#3b7ef6;">READ ORIGINAL →</a></span>
  </td></tr>

  <!-- VIDEO TITLE -->
  <tr><td style="padding:12px 28px 16px;">
    <div style="font-family:Arial,sans-serif;font-size:22px;font-weight:900;line-height:1.2;color:#07080b;letter-spacing:-0.5px;">${brief.video_title || story.title}</div>
    <div style="margin-top:8px;font-size:13px;color:#666;font-style:italic;line-height:1.5;">${brief.angle || brief.why_this_matters || ''}</div>
  </td></tr>

  <!-- WHY THIS MATTERS -->
  <tr><td style="padding:0 28px 16px;">
    <div style="background:#f8f8fc;border-radius:6px;padding:14px 16px;">
      <div style="font-family:monospace;font-size:9px;letter-spacing:2px;color:#e8392a;margin-bottom:8px;">WHY THIS MATTERS NOW</div>
      <div style="font-size:13px;color:#333;line-height:1.75;">${brief.why_this_matters || ''}</div>
    </div>
  </td></tr>

  <!-- HOOK -->
  <tr><td style="padding:0 28px 16px;">
    <div style="border-left:3px solid #e8392a;padding-left:16px;">
      <div style="font-family:monospace;font-size:9px;letter-spacing:2px;color:#888;margin-bottom:8px;">OPENING HOOK · 0:00 – 1:30</div>
      <div style="font-size:15px;font-style:italic;color:#111;line-height:1.75;">${brief.hook || ''}</div>
    </div>
  </td></tr>

  <!-- DIVIDER -->
  <tr><td style="padding:0 28px;"><div style="height:1px;background:#eeeeee;"></div></td></tr>

  <!-- CONTEXT + HISTORY -->
  <tr><td style="padding:16px 28px 0;">
    <div style="font-family:monospace;font-size:9px;letter-spacing:2px;color:#3b7ef6;margin-bottom:8px;">WHAT HAPPENED · 1:30 – 3:30</div>
    <div style="font-size:13px;color:#444;line-height:1.8;">${brief.context || ''}</div>
  </td></tr>
  <tr><td style="padding:14px 28px 0;">
    <div style="font-family:monospace;font-size:9px;letter-spacing:2px;color:#f0a820;margin-bottom:8px;">HISTORY NOBODY TELLS YOU · 3:30 – 6:00</div>
    <div style="font-size:13px;color:#444;line-height:1.8;">${brief.history || ''}</div>
  </td></tr>

  <!-- DATA -->
  <tr><td style="padding:14px 28px 0;">
    <div style="font-family:monospace;font-size:9px;letter-spacing:2px;color:#20c060;margin-bottom:8px;">THE NUMBERS · 6:00 – 8:00</div>
    <div style="font-size:13px;color:#444;line-height:1.8;">${brief.data || ''}</div>
  </td></tr>

  <!-- DIVIDER -->
  <tr><td style="padding:16px 28px 0;"><div style="height:1px;background:#eeeeee;"></div></td></tr>

  <!-- 3 PERSPECTIVES -->
  <tr><td style="padding:16px 28px 0;">
    <div style="font-family:monospace;font-size:9px;letter-spacing:2px;color:#9050f0;margin-bottom:12px;">THREE PERSPECTIVES · 8:00 – 12:00</div>
    <table width="100%" cellpadding="0" cellspacing="8">
      <tr>
        <td width="32%" valign="top" style="background:#f0f4ff;border-radius:5px;padding:11px;">
          <div style="font-family:monospace;font-size:8px;color:#3b7ef6;letter-spacing:1px;margin-bottom:6px;">GOVT POSITION</div>
          <div style="font-size:11px;color:#333;line-height:1.6;">${brief.perspective_govt || ''}</div>
        </td>
        <td width="4%"></td>
        <td width="32%" valign="top" style="background:#fff0f0;border-radius:5px;padding:11px;">
          <div style="font-family:monospace;font-size:8px;color:#e8392a;letter-spacing:1px;margin-bottom:6px;">CRITIC / EXPERT</div>
          <div style="font-size:11px;color:#333;line-height:1.6;">${brief.perspective_critic || ''}</div>
        </td>
        <td width="4%"></td>
        <td width="28%" valign="top" style="background:#f0fff6;border-radius:5px;padding:11px;">
          <div style="font-family:monospace;font-size:8px;color:#20c060;letter-spacing:1px;margin-bottom:6px;">GLOBAL ANGLE</div>
          <div style="font-size:11px;color:#333;line-height:1.6;">${brief.perspective_critic || ''}</div>
        </td>
      </tr>
    </table>
  </td></tr>

  <!-- HIDDEN ANGLE -->
  <tr><td style="padding:16px 28px 0;">
    <div style="background:linear-gradient(135deg,#f5f0ff,#f0f4ff);border:1px solid #d0c0f0;border-radius:6px;padding:14px 16px;">
      <div style="font-family:monospace;font-size:9px;letter-spacing:2px;color:#9050f0;margin-bottom:8px;">🔑 THE HIDDEN ANGLE — "lekin ek cheez aur hai"</div>
      <div style="font-size:13px;color:#333;line-height:1.8;font-style:italic;">${brief.pivot || ''}</div>
    </div>
  </td></tr>

  <!-- WHAT NEXT -->
  <tr><td style="padding:14px 28px 0;">
    <div style="font-family:monospace;font-size:9px;letter-spacing:2px;color:#f06030;margin-bottom:8px;">WHAT HAPPENS NEXT</div>
    <div style="font-size:13px;color:#444;line-height:1.8;">${brief.what_next || ''}</div>
  </td></tr>

  <!-- CLOSING QUESTION -->
  <tr><td style="padding:14px 28px 16px;">
    <div style="background:#07080b;border-radius:6px;padding:16px 20px;">
      <div style="font-family:monospace;font-size:9px;letter-spacing:2px;color:#888;margin-bottom:8px;">CLOSING QUESTION</div>
      <div style="font-size:15px;font-style:italic;color:#ffffff;line-height:1.65;">"${brief.closing_question || ''}"</div>
    </div>
  </td></tr>

  <!-- SUGGESTED SOURCES -->
  <tr><td style="padding:0 28px 16px;">
    <div style="font-family:monospace;font-size:9px;letter-spacing:2px;color:#888;margin-bottom:8px;">SUGGESTED SOURCES TO VERIFY</div>
    <div style="font-size:11px;color:#3b7ef6;line-height:2;">${(brief.suggested_sources || []).map(s => `→ ${s}`).join('<br>')}</div>
  </td></tr>

  <!-- FOOTER -->
  <tr><td style="background:#f8f8fc;padding:14px 28px;border-top:1px solid #eee;">
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td><span style="font-family:monospace;font-size:9px;color:#aaa;">NarrativeIntel · Automated Research Engine</span></td>
        <td align="right"><span style="font-family:monospace;font-size:9px;color:#aaa;">Score ${score}/99 · ${topic}</span></td>
      </tr>
    </table>
  </td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;

  const subjectPrefix = brief.urgency === 'HIGH' ? '🔴' : '🟡';
  const subject = `${subjectPrefix} [NarrativeIntel] ${brief.video_title || story.title.slice(0, 60)}`;

  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.resendKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'NarrativeIntel <alerts@narrativeintel.com>',
      to:   [env.toEmail],
      subject,
      html,
    }),
  });

  if (!r.ok) {
    const err = await r.text();
    throw new Error(`Resend error: ${err}`);
  }
  return await r.json();
}

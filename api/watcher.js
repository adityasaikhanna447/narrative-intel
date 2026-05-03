// ─────────────────────────────────────────────────────
// NarrativeIntel — Automatic Watcher v3
// Uses Serper news search — reliable from Vercel
// ─────────────────────────────────────────────────────

const WATCH_TOPICS = [
  { name: 'BJP & NDA',         q: 'BJP Modi Amit Shah NDA India politics news',              threshold: 40 },
  { name: 'Congress & Oppn',   q: 'Congress Rahul Gandhi INDIA alliance opposition news',    threshold: 40 },
  { name: 'AAP TMC Regional',  q: 'AAP Kejriwal TMC Mamata SP Akhilesh regional party news', threshold: 40 },
  { name: 'Elections & EC',    q: 'India election date result exit poll Election Commission', threshold: 35 },
  { name: 'Parliament & Law',  q: 'Lok Sabha Rajya Sabha Parliament bill ED CBI raid India', threshold: 45 },
  { name: 'India Breaking',    q: 'India breaking news urgent politics controversy',          threshold: 50 },
  { name: 'Press & Rallies',   q: 'India politician press conference rally statement row',    threshold: 38 },
  { name: 'Geopolitics',       q: 'India Pakistan China foreign policy BRICS UN diplomacy',  threshold: 60 },
];

const HIGH = /attack|war|strike|nuclear|crisis|emergency|verdict|resign|arrested|killed|bomb|terror|ceasefire|escalat|coup|result|winner|elected|majority|sweep|landslide|exit poll|counting/i;
const MID  = /india|modi|rahul|kejriwal|mamata|yogi|amit|election|vote|poll|parliament|lok sabha|rajya sabha|cabinet|congress|bjp|aap|tmc|rally|statement|controversial|defect|alliance|coalition|ed raid|cbi|manifesto|ec |eci|mcc/i;

let _seenThisRun = new Set();

module.exports = async function handler(req, res) {

  if (req.query.debug === '1') {
    return res.status(200).json({
      has_gemini:  !!process.env.GEMINI_API_KEY,
      has_resend:  !!process.env.RESEND_API_KEY,
      has_email:   !!process.env.ALERT_EMAIL,
      has_token:   !!process.env.WATCHER_TOKEN,
      has_serper:  !!process.env.SERPER_API_KEY,
      node_env:    process.env.NODE_ENV,
    });
  }

  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const token = req.headers['x-watcher-token'];
  if (token !== process.env.WATCHER_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const env = {
    geminiKey:   process.env.GEMINI_API_KEY,
    geminiModel: process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite-preview-06-17',
    resendKey:   process.env.RESEND_API_KEY,
    toEmail:     process.env.ALERT_EMAIL,
    serperKey:   process.env.SERPER_API_KEY || '',
    channelCtx:  process.env.CHANNEL_CONTEXT || '',
    minScore:    parseInt(process.env.MIN_SCORE || '38'),
  };

  if (!env.geminiKey || !env.resendKey || !env.toEmail) {
    return res.status(500).json({ error: 'Missing required env vars: GEMINI_API_KEY, RESEND_API_KEY, ALERT_EMAIL' });
  }

  if (!env.serperKey) {
    return res.status(500).json({ error: 'Missing SERPER_API_KEY — required for news fetching' });
  }

  const log = [];
  const alerts = [];

  for (const topic of WATCH_TOPICS) {
    try {
      const stories = await fetchNews(topic.q, env.serperKey);
      log.push(`[${topic.name}] fetched ${stories.length} stories`);

      for (const story of stories) {
        const id = storyId(story);
        if (_seenThisRun.has(id)) continue;

        const score = scoreStory(story, topic.threshold);
        if (score < Math.max(topic.threshold, env.minScore)) continue;

        _seenThisRun.add(id);
        log.push(`[${topic.name}] ALERT: ${score} — ${story.title.slice(0, 70)}`);

        const brief = await generateBrief(story, env);
        if (brief) alerts.push({ story, brief, score, topic: topic.name });
      }
    } catch (e) {
      log.push(`[${topic.name}] ERROR: ${e.message}`);
    }
  }

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

  return res.status(200).json({ ok: true, checked: WATCH_TOPICS.length, alerts_sent: sent.length, sent, log });
};

// ── NEWS FETCH via Serper ─────────────────────────────
async function fetchNews(query, apiKey) {
  try {
    const r = await fetch('https://google.serper.dev/news', {
      method: 'POST',
      headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query, gl: 'in', hl: 'en', num: 10 }),
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) return [];
    const d = await r.json();
    return (d.news || []).map(item => ({
      title:       item.title || '',
      description: item.snippet || '',
      pubDate:     item.date || new Date().toISOString(),
      link:        item.link || '',
      source:      item.source || 'News',
    }));
  } catch (e) {
    return [];
  }
}

// ── SCORING ───────────────────────────────────────────
function scoreStory(story, baseThreshold) {
  const txt = (story.title + ' ' + story.description).toLowerCase();
  let score = baseThreshold;
  if (HIGH.test(txt)) score += 30;
  else if (MID.test(txt)) score += 15;
  const ageMin = Math.floor((Date.now() - new Date(story.pubDate).getTime()) / 60000);
  if (ageMin < 60)  score += 10;
  else if (ageMin < 180) score += 5;
  else if (ageMin > 720) score -= 10;
  return Math.min(score, 99);
}

function storyId(story) {
  return (story.title || '').toLowerCase().replace(/\s+/g, '').slice(0, 60);
}

// ── GEMINI BRIEF ──────────────────────────────────────
async function generateBrief(story, env) {
  const chCtx = env.channelCtx ? `\n\nCHANNEL CONTEXT:\n${env.channelCtx}` : '';
  const prompt = `You are a research engine for a serious Indian YouTube channel covering politics and geopolitics in the style of Nitish Rajput.${chCtx}

BREAKING STORY:
TITLE: ${story.title}
DESCRIPTION: ${story.description || 'Not available'}
SOURCE: ${story.source}
PUBLISHED: ${story.pubDate}

Return ONLY valid JSON — no markdown, no explanation:

{
  "video_title": "Punchy 8-12 word title",
  "why_this_matters": "2 sentences: why this is significant right now",
  "hook": "Opening 3-4 sentences. Start mid-action. Reframe as revelatory. Do NOT say 'today we discuss'.",
  "context": "What happened in plain language — 3-4 sentences, no jargon",
  "history": "Key background most people don't know — 3-4 sentences with specific dates",
  "data": "2-3 key statistics as narrative sentences — make numbers feel consequential",
  "perspective_govt": "Government/establishment position — 2 sentences",
  "perspective_critic": "Opposition/expert/academic critique — 2 sentences",
  "pivot": "The hidden angle nobody is covering — 'lekin ek cheez aur hai' — 2-3 sentences",
  "what_next": "2-3 concrete scenarios — specific triggers to watch",
  "closing_question": "One uncomfortable thought-provoking question to end the video",
  "angle": "One sentence: unique angle that makes this different from news coverage",
  "urgency": "HIGH or MEDIUM",
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

// ── EMAIL via RESEND ──────────────────────────────────
async function sendEmail({ story, brief, score, topic }, env) {
  const urgencyColor = brief.urgency === 'HIGH' ? '#e8392a' : '#f0a820';
  const urgencyBg    = brief.urgency === 'HIGH' ? '#fff0ee' : '#fffbee';

  const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f4f4f7;font-family:Georgia,serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f7;padding:24px 0;">
<tr><td align="center">
<table width="620" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">
  <tr><td style="background:#07080b;padding:20px 28px;">
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td><span style="font-family:Arial,sans-serif;font-size:13px;font-weight:900;letter-spacing:3px;color:#fff;">NARRATIVE</span><span style="font-family:Arial,sans-serif;font-size:13px;font-weight:900;letter-spacing:3px;color:#e8392a;">INTEL</span><span style="font-family:monospace;font-size:9px;color:#555;margin-left:8px;">LIVE ALERT</span></td>
      <td align="right"><span style="font-family:monospace;font-size:10px;color:#888;">${new Date().toLocaleString('en-IN',{dateStyle:'medium',timeStyle:'short'})}</span></td>
    </tr></table>
  </td></tr>
  <tr><td style="background:${urgencyBg};border-left:4px solid ${urgencyColor};padding:10px 28px;">
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td><span style="font-family:monospace;font-size:9px;font-weight:700;letter-spacing:2px;color:${urgencyColor};">${brief.urgency==='HIGH'?'🔴 HIGH URGENCY':'🟡 MEDIUM'} · ${topic.toUpperCase()}</span></td>
      <td align="right"><span style="font-family:monospace;font-size:9px;color:#888;">SCORE: <strong style="color:${score>=80?'#e8392a':'#f0a820'}">${score}/99</strong></span></td>
    </tr></table>
  </td></tr>
  <tr><td style="padding:6px 28px 0;"><span style="font-family:monospace;font-size:9px;color:#888;">${(story.source||'').toUpperCase()} · <a href="${story.link||'#'}" style="color:#3b7ef6;">READ ORIGINAL →</a></span></td></tr>
  <tr><td style="padding:12px 28px 16px;">
    <div style="font-family:Arial,sans-serif;font-size:22px;font-weight:900;line-height:1.2;color:#07080b;">${brief.video_title||story.title}</div>
    <div style="margin-top:8px;font-size:13px;color:#666;font-style:italic;">${brief.angle||''}</div>
  </td></tr>
  <tr><td style="padding:0 28px 16px;">
    <div style="background:#f8f8fc;border-radius:6px;padding:14px 16px;">
      <div style="font-family:monospace;font-size:9px;letter-spacing:2px;color:#e8392a;margin-bottom:8px;">WHY THIS MATTERS NOW</div>
      <div style="font-size:13px;color:#333;line-height:1.75;">${brief.why_this_matters||''}</div>
    </div>
  </td></tr>
  <tr><td style="padding:0 28px 16px;">
    <div style="border-left:3px solid #e8392a;padding-left:16px;">
      <div style="font-family:monospace;font-size:9px;letter-spacing:2px;color:#888;margin-bottom:8px;">OPENING HOOK · 0:00–1:30</div>
      <div style="font-size:15px;font-style:italic;color:#111;line-height:1.75;">${brief.hook||''}</div>
    </div>
  </td></tr>
  <tr><td style="padding:0 28px;"><div style="height:1px;background:#eee;"></div></td></tr>
  <tr><td style="padding:16px 28px 0;">
    <div style="font-family:monospace;font-size:9px;letter-spacing:2px;color:#3b7ef6;margin-bottom:8px;">WHAT HAPPENED · 1:30–3:30</div>
    <div style="font-size:13px;color:#444;line-height:1.8;">${brief.context||''}</div>
  </td></tr>
  <tr><td style="padding:14px 28px 0;">
    <div style="font-family:monospace;font-size:9px;letter-spacing:2px;color:#f0a820;margin-bottom:8px;">HISTORY NOBODY TELLS YOU · 3:30–6:00</div>
    <div style="font-size:13px;color:#444;line-height:1.8;">${brief.history||''}</div>
  </td></tr>
  <tr><td style="padding:14px 28px 0;">
    <div style="font-family:monospace;font-size:9px;letter-spacing:2px;color:#20c060;margin-bottom:8px;">THE NUMBERS · 6:00–8:00</div>
    <div style="font-size:13px;color:#444;line-height:1.8;">${brief.data||''}</div>
  </td></tr>
  <tr><td style="padding:16px 28px 0;"><div style="height:1px;background:#eee;"></div></td></tr>
  <tr><td style="padding:16px 28px 0;">
    <div style="background:linear-gradient(135deg,#f5f0ff,#f0f4ff);border:1px solid #d0c0f0;border-radius:6px;padding:14px 16px;">
      <div style="font-family:monospace;font-size:9px;letter-spacing:2px;color:#9050f0;margin-bottom:8px;">🔑 THE HIDDEN ANGLE — "lekin ek cheez aur hai"</div>
      <div style="font-size:13px;color:#333;line-height:1.8;font-style:italic;">${brief.pivot||''}</div>
    </div>
  </td></tr>
  <tr><td style="padding:14px 28px 0;">
    <div style="font-family:monospace;font-size:9px;letter-spacing:2px;color:#f06030;margin-bottom:8px;">WHAT HAPPENS NEXT</div>
    <div style="font-size:13px;color:#444;line-height:1.8;">${brief.what_next||''}</div>
  </td></tr>
  <tr><td style="padding:14px 28px 16px;">
    <div style="background:#07080b;border-radius:6px;padding:16px 20px;">
      <div style="font-family:monospace;font-size:9px;letter-spacing:2px;color:#888;margin-bottom:8px;">CLOSING QUESTION</div>
      <div style="font-size:15px;font-style:italic;color:#fff;line-height:1.65;">"${brief.closing_question||''}"</div>
    </div>
  </td></tr>
  <tr><td style="padding:0 28px 16px;">
    <div style="font-family:monospace;font-size:9px;letter-spacing:2px;color:#888;margin-bottom:8px;">GOVT · <span style="color:#3b7ef6;">${brief.perspective_govt||''}</span></div>
    <div style="font-family:monospace;font-size:9px;letter-spacing:2px;color:#888;margin-bottom:8px;">CRITIC · <span style="color:#e8392a;">${brief.perspective_critic||''}</span></div>
  </td></tr>
  <tr><td style="padding:0 28px 16px;">
    <div style="font-family:monospace;font-size:9px;letter-spacing:2px;color:#888;margin-bottom:8px;">SUGGESTED SOURCES TO VERIFY</div>
    <div style="font-size:11px;color:#3b7ef6;line-height:2;">${(brief.suggested_sources||[]).map(s=>`→ ${s}`).join('<br>')}</div>
  </td></tr>
  <tr><td style="background:#f8f8fc;padding:14px 28px;border-top:1px solid #eee;">
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td><span style="font-family:monospace;font-size:9px;color:#aaa;">NarrativeIntel · Automated Research Engine</span></td>
      <td align="right"><span style="font-family:monospace;font-size:9px;color:#aaa;">Score ${score}/99 · ${topic}</span></td>
    </tr></table>
  </td></tr>
</table>
</td></tr>
</table>
</body></html>`;

  const subject = `${brief.urgency==='HIGH'?'🔴':'🟡'} [NarrativeIntel] ${brief.video_title||story.title.slice(0,60)}`;
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${env.resendKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'NarrativeIntel <onboarding@resend.dev>', to: [env.toEmail], subject, html }),
  });
  if (!r.ok) throw new Error(`Resend error: ${await r.text()}`);
  return await r.json();
}

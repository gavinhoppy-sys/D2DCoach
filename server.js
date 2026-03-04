require('dotenv').config();
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { Pool } = require('pg');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static('public'));

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── PostgreSQL setup ──────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      id           SERIAL PRIMARY KEY,
      rep_name     TEXT NOT NULL,
      created_at   TIMESTAMPTZ DEFAULT NOW(),
      duration     INTEGER,
      rep_messages INTEGER,
      analysis     JSONB NOT NULL
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS knowledge_files (
      id          SERIAL PRIMARY KEY,
      filename    TEXT NOT NULL,
      content     TEXT NOT NULL,
      uploaded_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  console.log('Database ready.');
}
initDB().catch(err => console.error('DB init error:', err.message));

// ── Knowledge base cache ──────────────────────────────────
let knowledgeCache    = null;
let knowledgeCacheTime = 0;

async function getKnowledgeBase() {
  const now = Date.now();
  if (knowledgeCache && (now - knowledgeCacheTime) < 60_000) return knowledgeCache;
  const result = await pool.query('SELECT filename, content FROM knowledge_files ORDER BY uploaded_at');
  knowledgeCache     = result.rows;
  knowledgeCacheTime = now;
  return knowledgeCache;
}

// ── Per-session state ─────────────────────────────────────
const activeSessions = new Map(); // sessionId → { history, persona, scenario, weakAreas, lastActivity }

function getSession(id) {
  if (!activeSessions.has(id)) {
    activeSessions.set(id, {
      history: [],
      persona: 'standard',
      scenario: 'cold-knock',
      weakAreas: [],
      lastActivity: Date.now(),
    });
  }
  const s = activeSessions.get(id);
  s.lastActivity = Date.now();
  return s;
}

// Prune sessions idle for more than 2 hours
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [id, s] of activeSessions) {
    if (s.lastActivity < cutoff) activeSessions.delete(id);
  }
}, 30 * 60 * 1000);

// ── Homeowner personas ────────────────────────────────────
const PERSONAS = {
  standard:       'You are mildly annoyed at the interruption but willing to hear a short pitch.',
  budget:         'Money is very tight right now. You keep steering back to cost and whether insurance will cover it. Push back hard on price.',
  bad_contractor: 'A contractor scammed you two years ago — took a large deposit and left the job unfinished. You are deeply suspicious of any home-services salesperson.',
  has_contractor: 'Your brother-in-law does roofing and you always use family for home projects. You deflect to this whenever possible.',
  spouse_away:    'You cannot make any financial decisions without your spouse, who is at work. You are somewhat interested but keep deferring.',
  skeptical:      'You are very busy and skeptical of door-to-door salespeople. You are about to close the door and the rep has very little time to earn your attention.',
};

// ── Scenarios ─────────────────────────────────────────────
const SCENARIOS = {
  'cold-knock': 'A door-to-door roofing sales rep has just knocked on your door unexpectedly.',
  'post-storm': 'There was a significant hailstorm in your neighborhood two days ago. A roofing rep came by. You noticed granules in your gutters but have not had a professional look yet.',
  'referral':   'Your next-door neighbor mentioned a roofing company might stop by. You vaguely remember them saying that, so you are slightly more open than usual but still cautious.',
  'insurance':  'Your insurance adjuster recently confirmed you have a legitimate storm damage claim, but you have not started the repair process yet.',
};

// ── Build system prompt ───────────────────────────────────
async function buildSystemPrompt(persona = 'standard', scenario = 'cold-knock', weakAreas = []) {
  const personaTxt  = PERSONAS[persona]   || PERSONAS.standard;
  const scenarioTxt = SCENARIOS[scenario] || SCENARIOS['cold-knock'];

  const weakAreaNote = weakAreas.length > 0
    ? `\n\n[COACHING FOCUS: This rep historically struggles with ${weakAreas.join(' and ')}. Watch closely for these patterns and call them out immediately when they appear.]`
    : '';

  const base = `You are roleplaying as a homeowner. ${scenarioTxt} ${personaTxt}

After each rep message, respond in character as the homeowner, then on a new line add:
COACH: [2-3 sentences of direct, specific feedback. Quote the exact words or phrases the rep just used. Always end your feedback with a suggested alternative — format it as: Try instead: "[exact phrase to use]". If voice metrics are present (WPM, energy, filler words), address them explicitly — ideal pace: 130-150 WPM, filler words kill credibility, monotone delivery loses attention. Reference training materials when relevant.]

Adjust your skepticism dynamically: if the rep builds genuine rapport and handles your concerns well, warm up gradually. If they fumble objections, sound scripted, or ignore your concerns, increase your resistance.${weakAreaNote}`;

  const files = await getKnowledgeBase();
  if (files.length === 0) return base;

  const totalBudget = 15000;
  const perFile = Math.min(6000, Math.floor(totalBudget / Math.max(files.length, 1)));
  const kb = files.map(f => {
    let content = f.content;
    if (content.length > perFile) {
      const cut = content.lastIndexOf('\n', perFile);
      content = content.slice(0, cut > 0 ? cut : perFile) + '\n[…truncated]';
    }
    return `--- ${f.filename} ---\n${content}`;
  }).join('\n\n');

  return `${base}\n\n[TRAINING MATERIALS — reference these when coaching]\n${kb}`;
}

// ── Chat ──────────────────────────────────────────────────
app.post('/chat', async (req, res) => {
  try {
    const { message, sessionId, persona, scenario, weakAreas } = req.body;
    if (!message || !message.trim()) {
      return res.status(400).json({ error: 'Message is required.' });
    }
    const session = getSession(sessionId || 'default');
    if (persona)              session.persona   = persona;
    if (scenario)             session.scenario  = scenario;
    if (Array.isArray(weakAreas)) session.weakAreas = weakAreas;

    session.history.push({ role: 'user', content: message });

    const systemPrompt = await buildSystemPrompt(session.persona, session.scenario, session.weakAreas);
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: systemPrompt,
      messages: session.history,
    });

    const assistantMessage = response.content[0].text;
    session.history.push({ role: 'assistant', content: assistantMessage });

    res.json({ response: assistantMessage });
  } catch (err) {
    console.error('Chat error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── End session (scorecard + analysis + save in one call) ─
app.post('/end-session', async (req, res) => {
  try {
    const { sessionId, repName, duration, repMessages } = req.body;
    const session = getSession(sessionId || 'default');
    if (session.history.length === 0) {
      return res.status(400).json({ error: 'No conversation to analyze.' });
    }
    const conversationText = session.history
      .map(m => `${m.role === 'user' ? 'SALES REP' : 'HOMEOWNER/COACH'}: ${m.content}`)
      .join('\n\n');

    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      messages: [{
        role: 'user',
        content: `You are an expert door-to-door sales coach. Analyze this roofing sales practice session and return ONLY a valid JSON object — no markdown, no extra text.

Conversation:
${conversationText}

Return exactly this structure:
{
  "scorecard": "Opening: [score]/10 — [one sentence feedback]\\nObjection Handling: [score]/10 — [one sentence feedback]\\nRapport: [score]/10 — [one sentence feedback]\\nClosing Attempt: [score]/10 — [one sentence feedback]\\nOverall: [score]/10 — [summary sentence]",
  "overall": <integer 0-100>,
  "breakdown": {
    "opening":           { "score": <0-100>, "feedback": "<one sentence>" },
    "objectionHandling": { "score": <0-100>, "feedback": "<one sentence>" },
    "rapport":           { "score": <0-100>, "feedback": "<one sentence>" },
    "tonality":          { "score": <0-100>, "feedback": "<one sentence>" },
    "timing":            { "score": <0-100>, "feedback": "<one sentence>" },
    "closing":           { "score": <0-100>, "feedback": "<one sentence>" }
  },
  "summary": "<2-3 sentences describing how the session went>",
  "keyStrength": "<one specific thing they did well>",
  "keyImprovement": "<one specific thing to work on next time>"
}

Use any [Voice: ...] metrics in the rep's messages to inform tonality and timing scores. Ideal pace is 130-150 WPM.`,
      }],
    });

    const raw = response.content[0].text.trim();
    const objMatch = raw.match(/\{[\s\S]*\}/);
    const result = JSON.parse(objMatch ? objMatch[0] : raw);
    const { scorecard, ...analysis } = result;

    if (repName && analysis.overall != null) {
      await pool.query(
        'INSERT INTO sessions (rep_name, duration, rep_messages, analysis) VALUES ($1, $2, $3, $4)',
        [repName.trim(), duration || 0, repMessages || 0, JSON.stringify(analysis)]
      );
    }

    res.json({ scorecard, analysis });
  } catch (err) {
    console.error('End session error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Scorecard (legacy) ────────────────────────────────────
app.post('/scorecard', async (req, res) => {
  try {
    const { sessionId } = req.body || {};
    const session = getSession(sessionId || 'default');
    if (session.history.length === 0) {
      return res.status(400).json({ error: 'No conversation to score yet.' });
    }
    const conversationText = session.history
      .map(m => `${m.role === 'user' ? 'SALES REP' : 'HOMEOWNER/COACH'}: ${m.content}`)
      .join('\n\n');
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: [{ role: 'user', content: `Here is the full practice sales conversation:\n\n${conversationText}\n\nYou are an expert sales coach. Rate the rep 1-10 on each category with one sentence of feedback:\n\nOpening: [score]/10 — [feedback]\nObjection Handling: [score]/10 — [feedback]\nRapport: [score]/10 — [feedback]\nClosing Attempt: [score]/10 — [feedback]\nOverall: [score]/10 — [summary]` }],
    });
    res.json({ scorecard: response.content[0].text });
  } catch (err) {
    console.error('Scorecard error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Analyze (legacy) ──────────────────────────────────────
app.post('/analyze', async (req, res) => {
  try {
    const { sessionId } = req.body || {};
    const session = getSession(sessionId || 'default');
    if (session.history.length === 0) {
      return res.status(400).json({ error: 'No conversation to analyze.' });
    }
    const conversationText = session.history
      .map(m => `${m.role === 'user' ? 'SALES REP' : 'HOMEOWNER/COACH'}: ${m.content}`)
      .join('\n\n');
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: `You are an expert door-to-door sales coach. Analyze this roofing sales practice session and return ONLY a valid JSON object — no markdown, no extra text.\n\nConversation:\n${conversationText}\n\nReturn exactly this structure:\n{\n  "overall": <integer 0-100>,\n  "breakdown": {\n    "opening":           { "score": <0-100>, "feedback": "<one sentence>" },\n    "objectionHandling": { "score": <0-100>, "feedback": "<one sentence>" },\n    "rapport":           { "score": <0-100>, "feedback": "<one sentence>" },\n    "tonality":          { "score": <0-100>, "feedback": "<one sentence>" },\n    "timing":            { "score": <0-100>, "feedback": "<one sentence>" },\n    "closing":           { "score": <0-100>, "feedback": "<one sentence>" }\n  },\n  "summary": "<2-3 sentences>",\n  "keyStrength": "<one specific thing they did well>",\n  "keyImprovement": "<one specific thing to work on>"\n}\n\nUse any [Voice: ...] metrics to inform tonality and timing scores. Ideal pace is 130-150 WPM.`,
      }],
    });
    const raw = response.content[0].text.trim();
    const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
    const jsonStr = jsonMatch ? jsonMatch[1] : raw;
    const objMatch = jsonStr.match(/\{[\s\S]*\}/);
    const analysis = JSON.parse(objMatch ? objMatch[0] : jsonStr);
    res.json({ analysis });
  } catch (err) {
    console.error('Analyze error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Save session (legacy) ─────────────────────────────────
app.post('/save-session', async (req, res) => {
  try {
    const { repName, duration, repMessages, analysis } = req.body;
    if (!repName || !analysis) return res.status(400).json({ error: 'repName and analysis are required.' });
    await pool.query(
      'INSERT INTO sessions (rep_name, duration, rep_messages, analysis) VALUES ($1, $2, $3, $4)',
      [repName.trim(), duration || 0, repMessages || 0, JSON.stringify(analysis)]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Save session error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Get sessions ──────────────────────────────────────────
app.get('/sessions', async (req, res) => {
  try {
    const { name } = req.query;
    if (!name) return res.status(400).json({ error: 'name query param required.' });
    const result = await pool.query(
      'SELECT * FROM sessions WHERE LOWER(rep_name) = LOWER($1) ORDER BY created_at DESC LIMIT 100',
      [name.trim()]
    );
    const sessions = result.rows.map(row => ({
      id: row.id, date: row.created_at, duration: row.duration,
      repMessages: row.rep_messages, analysis: row.analysis,
    }));
    res.json({ sessions });
  } catch (err) {
    console.error('Get sessions error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Knowledge file endpoints ──────────────────────────────
app.post('/knowledge-file', async (req, res) => {
  try {
    const { filename, content } = req.body;
    if (!filename || !content) return res.status(400).json({ error: 'filename and content required.' });
    const result = await pool.query(
      'INSERT INTO knowledge_files (filename, content) VALUES ($1, $2) RETURNING id',
      [filename.trim(), content.trim()]
    );
    knowledgeCache = null;
    res.json({ success: true, id: result.rows[0].id });
  } catch (err) {
    console.error('Knowledge file error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/knowledge-files', async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, filename, LEFT(content, 120) AS preview, uploaded_at FROM knowledge_files ORDER BY uploaded_at DESC"
    );
    res.json({ files: result.rows });
  } catch (err) {
    console.error('Knowledge list error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/knowledge-file/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM knowledge_files WHERE id = $1', [req.params.id]);
    knowledgeCache = null;
    res.json({ success: true });
  } catch (err) {
    console.error('Knowledge delete error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Manager endpoints ─────────────────────────────────────
function checkPin(req, res) {
  const pin = process.env.MANAGER_PIN || '1234';
  if (req.query.pin !== pin) {
    res.status(401).json({ error: 'Invalid PIN.' });
    return false;
  }
  return true;
}

app.get('/manager/reps', async (req, res) => {
  if (!checkPin(req, res)) return;
  try {
    const days = parseInt(req.query.days) || null;
    const result = await pool.query(
      `SELECT
         rep_name,
         COUNT(*)::int AS session_count,
         ROUND(AVG((analysis->>'overall')::numeric))::int AS avg_score,
         MAX((analysis->>'overall')::numeric)::int AS best_score,
         MAX(created_at) AS last_active,
         json_agg(analysis ORDER BY created_at DESC) AS all_analyses
       FROM sessions
       ${days ? `WHERE created_at >= NOW() - ($1 || ' days')::interval` : ''}
       GROUP BY rep_name
       ORDER BY avg_score DESC`,
      days ? [days] : []
    );
    const reps = result.rows.map(row => {
      const analyses = row.all_analyses || [];
      const scores = analyses.map(a => a.overall || 0);
      const latestScore = scores[0] || 0;
      let improvement = null;
      if (scores.length >= 4) {
        const half = Math.floor(scores.length / 2);
        const newer = scores.slice(0, half).reduce((a, b) => a + b, 0) / half;
        const older = scores.slice(-half).reduce((a, b) => a + b, 0) / half;
        improvement = Math.round(newer - older);
      }
      const catKeys = ['opening', 'objectionHandling', 'rapport', 'tonality', 'timing', 'closing'];
      const catAvgs = {};
      catKeys.forEach(k => {
        const vals = analyses.map(a => a.breakdown?.[k]?.score).filter(v => v != null);
        catAvgs[k] = vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
      });
      const issues = analyses.map(a => a.keyImprovement).filter(Boolean);
      return {
        name: row.rep_name,
        sessionCount: row.session_count,
        avgScore: row.avg_score,
        bestScore: row.best_score,
        latestScore,
        lastActive: row.last_active,
        improvement,
        catAvgs,
        topIssues: issues.slice(0, 3),
      };
    });
    res.json({ reps });
  } catch (err) {
    console.error('Manager reps error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/manager/sessions', async (req, res) => {
  if (!checkPin(req, res)) return;
  try {
    const { rep, days } = req.query;
    if (!rep) return res.status(400).json({ error: 'rep query param required.' });
    const daysInt = parseInt(days) || null;
    const result = await pool.query(
      `SELECT * FROM sessions
       WHERE LOWER(rep_name) = LOWER($1)
       ${daysInt ? `AND created_at >= NOW() - ($2 || ' days')::interval` : ''}
       ORDER BY created_at DESC LIMIT 100`,
      daysInt ? [rep.trim(), daysInt] : [rep.trim()]
    );
    const sessions = result.rows.map(row => ({
      id: row.id, date: row.created_at, duration: row.duration,
      repMessages: row.rep_messages, analysis: row.analysis,
    }));
    res.json({ sessions });
  } catch (err) {
    console.error('Manager sessions error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Reset ─────────────────────────────────────────────────
app.post('/reset', (req, res) => {
  const { sessionId } = req.body || {};
  if (sessionId) activeSessions.delete(sessionId);
  res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`D2D Roofing Sales Coach running at http://localhost:${PORT}`);
});

require('dotenv').config();
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { Pool } = require('pg');

const app = express();
app.use(express.json({ limit: '4mb' }));
app.use(express.static('public'));

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── PostgreSQL ────────────────────────────────────────────
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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS session_feedback (
      id         SERIAL PRIMARY KEY,
      rep_name   TEXT NOT NULL,
      session_id INTEGER,
      message    TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      read_at    TIMESTAMPTZ
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
const activeSessions = new Map();

function getSession(id) {
  if (!activeSessions.has(id)) {
    activeSessions.set(id, {
      history: [],
      persona: 'standard',
      scenario: 'cold-knock',
      weakAreas: [],
      drillObjection: null,
      sessionGoal: null,
      curriculumLesson: null,
      lastActivity: Date.now(),
    });
  }
  const s = activeSessions.get(id);
  s.lastActivity = Date.now();
  return s;
}

setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [id, s] of activeSessions) {
    if (s.lastActivity < cutoff) activeSessions.delete(id);
  }
}, 30 * 60 * 1000);

// ── Personas ──────────────────────────────────────────────
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

// ── Curriculum lesson notes ───────────────────────────────
const CURRICULUM = {
  1: '\n\nCURRICULUM — LESSON 1 (Opener Only): Keep the conversation brief. Coach exclusively on the rep\'s opening — name, company, specific reason for being there. After 3-4 exchanges wrap up.',
  2: '\n\nCURRICULUM — LESSON 2 (Opener + Rapport): Let the conversation develop but focus coaching almost entirely on rapport-building. Is the rep connecting as a human or just pitching?',
  3: '\n\nCURRICULUM — LESSON 3 (Objection Handling): Throw at least 2-3 solid objections. Coach should focus almost entirely on how the rep handles each one.',
  4: '\n\nCURRICULUM — LESSON 4 (Full Pitch): Full natural conversation from opener to close attempt. Coach on all aspects equally.',
  5: '\n\nCURRICULUM — LESSON 5 (Elite Challenge): You are maximally skeptical on a cold knock. Push back on everything. The rep must score 70+ to pass this lesson.',
};

// ── Build system prompt ───────────────────────────────────
async function buildSystemPrompt(persona = 'standard', scenario = 'cold-knock', weakAreas = [], opts = {}) {
  const { drillObjection, sessionGoal, curriculumLesson } = opts;

  const personaTxt  = PERSONAS[persona]   || PERSONAS.standard;
  const scenarioTxt = SCENARIOS[scenario] || SCENARIOS['cold-knock'];

  const weakAreaNote = weakAreas.length > 0
    ? `\n\n[COACHING FOCUS: This rep historically struggles with ${weakAreas.join(' and ')}. Watch closely for these patterns and call them out immediately when they appear.]`
    : '';

  const drillNote = drillObjection
    ? `\n\nDRILL MODE: Throw the following objection every single turn in different variations: "${drillObjection}". The coach should focus exclusively on how well the rep handles this objection and give very specific corrective guidance each turn.`
    : '';

  const goalNote = sessionGoal
    ? `\n\nSESSION GOAL: The rep has set this goal for today: "${sessionGoal}". Note in your COACH feedback each turn whether they are making progress toward it.`
    : '';

  const currNote = curriculumLesson ? (CURRICULUM[curriculumLesson] || '') : '';

  const base = `You are roleplaying as a homeowner. ${scenarioTxt} ${personaTxt}

After each rep message, respond in character as the homeowner, then on a new line add:
COACH: [2-3 sentences of direct, specific feedback. Quote the exact words or phrases the rep just used. Always end your feedback with a suggested alternative — format it as: Try instead: "[exact phrase to use]". If voice metrics are present (WPM, energy, filler words), address them explicitly — ideal pace: 130-150 WPM, filler words kill credibility, monotone delivery loses attention. Reference training materials when relevant.]

Adjust your skepticism dynamically: if the rep builds genuine rapport and handles your concerns well, warm up gradually. If they fumble objections, sound scripted, or ignore your concerns, increase your resistance.${weakAreaNote}${drillNote}${goalNote}${currNote}`;

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
    const { message, sessionId, persona, scenario, weakAreas, drillObjection, sessionGoal, curriculumLesson } = req.body;
    if (!message || !message.trim()) return res.status(400).json({ error: 'Message is required.' });

    const session = getSession(sessionId || 'default');
    if (persona)                  session.persona          = persona;
    if (scenario)                 session.scenario         = scenario;
    if (Array.isArray(weakAreas)) session.weakAreas        = weakAreas;
    if (drillObjection !== undefined) session.drillObjection = drillObjection;
    if (sessionGoal !== undefined)    session.sessionGoal    = sessionGoal;
    if (curriculumLesson !== undefined) session.curriculumLesson = curriculumLesson;

    session.history.push({ role: 'user', content: message });

    const systemPrompt = await buildSystemPrompt(session.persona, session.scenario, session.weakAreas, {
      drillObjection:  session.drillObjection,
      sessionGoal:     session.sessionGoal,
      curriculumLesson: session.curriculumLesson,
    });

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

// ── End session ───────────────────────────────────────────
app.post('/end-session', async (req, res) => {
  try {
    const { sessionId, repName, duration, repMessages, transcript, sessionGoal, curriculumLesson } = req.body;
    const session = getSession(sessionId || 'default');
    if (session.history.length === 0) return res.status(400).json({ error: 'No conversation to analyze.' });

    const conversationText = session.history
      .map(m => `${m.role === 'user' ? 'SALES REP' : 'HOMEOWNER/COACH'}: ${m.content}`)
      .join('\n\n');

    const goalInstruction = sessionGoal
      ? `\nThe rep set this session goal: "${sessionGoal}". Also include in your JSON: "goalAchieved": <true or false>, "goalFeedback": "<one sentence on whether/how they met it>"`
      : '';

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
  "keyImprovement": "<one specific thing to work on next time>"${goalInstruction ? ',\n  "goalAchieved": <true/false>,\n  "goalFeedback": "<one sentence>"' : ''}
}

Use any [Voice: ...] metrics in the rep's messages to inform tonality and timing scores. Ideal pace is 130-150 WPM.${goalInstruction}`,
      }],
    });

    const raw = response.content[0].text.trim();
    const objMatch = raw.match(/\{[\s\S]*\}/);
    const result = JSON.parse(objMatch ? objMatch[0] : raw);
    const { scorecard, ...analysis } = result;

    // Merge extra context into analysis before saving
    const fullAnalysis = {
      ...analysis,
      ...(transcript     ? { transcript }     : {}),
      ...(sessionGoal    ? { sessionGoal }     : {}),
      ...(curriculumLesson ? { curriculumLesson } : {}),
    };

    if (repName && fullAnalysis.overall != null) {
      await pool.query(
        'INSERT INTO sessions (rep_name, duration, rep_messages, analysis) VALUES ($1, $2, $3, $4)',
        [repName.trim(), duration || 0, repMessages || 0, JSON.stringify(fullAnalysis)]
      );
    }

    res.json({ scorecard, analysis: fullAnalysis });
  } catch (err) {
    console.error('End session error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Leaderboard (public) ──────────────────────────────────
app.get('/leaderboard', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT rep_name,
         COUNT(*)::int AS session_count,
         ROUND(AVG((analysis->>'overall')::numeric))::int AS avg_score,
         MAX((analysis->>'overall')::numeric)::int AS best_score,
         MAX(created_at) AS last_active
       FROM sessions
       GROUP BY rep_name
       ORDER BY avg_score DESC
       LIMIT 50`
    );
    res.json({ leaderboard: result.rows });
  } catch (err) {
    console.error('Leaderboard error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Manager feedback ──────────────────────────────────────
app.post('/manager/feedback', async (req, res) => {
  if (!checkPin(req, res)) return;
  try {
    const { repName, sessionId: sid, message } = req.body;
    if (!repName || !message) return res.status(400).json({ error: 'repName and message required.' });
    await pool.query(
      'INSERT INTO session_feedback (rep_name, session_id, message) VALUES ($1, $2, $3)',
      [repName.trim(), sid || null, message.trim()]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Feedback error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Rep feedback (get) ────────────────────────────────────
app.get('/feedback', async (req, res) => {
  try {
    const { name } = req.query;
    if (!name) return res.status(400).json({ error: 'name query param required.' });
    const result = await pool.query(
      `SELECT id, message, session_id, created_at, read_at
       FROM session_feedback
       WHERE LOWER(rep_name) = LOWER($1)
       ORDER BY created_at DESC LIMIT 20`,
      [name.trim()]
    );
    res.json({ feedback: result.rows });
  } catch (err) {
    console.error('Get feedback error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Rep feedback (mark read) ──────────────────────────────
app.post('/feedback/read', async (req, res) => {
  try {
    const { ids } = req.body;
    if (!ids || !ids.length) return res.json({ success: true });
    await pool.query(
      'UPDATE session_feedback SET read_at = NOW() WHERE id = ANY($1::int[])',
      [ids]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Mark read error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Legacy scorecard ──────────────────────────────────────
app.post('/scorecard', async (req, res) => {
  try {
    const { sessionId } = req.body || {};
    const session = getSession(sessionId || 'default');
    if (session.history.length === 0) return res.status(400).json({ error: 'No conversation to score yet.' });
    const conversationText = session.history
      .map(m => `${m.role === 'user' ? 'SALES REP' : 'HOMEOWNER/COACH'}: ${m.content}`)
      .join('\n\n');
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: [{ role: 'user', content: `Conversation:\n\n${conversationText}\n\nRate the rep 1-10 on each:\n\nOpening: [score]/10 — [feedback]\nObjection Handling: [score]/10 — [feedback]\nRapport: [score]/10 — [feedback]\nClosing Attempt: [score]/10 — [feedback]\nOverall: [score]/10 — [summary]` }],
    });
    res.json({ scorecard: response.content[0].text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Legacy analyze ────────────────────────────────────────
app.post('/analyze', async (req, res) => {
  try {
    const { sessionId } = req.body || {};
    const session = getSession(sessionId || 'default');
    if (session.history.length === 0) return res.status(400).json({ error: 'No conversation to analyze.' });
    const conversationText = session.history
      .map(m => `${m.role === 'user' ? 'SALES REP' : 'HOMEOWNER/COACH'}: ${m.content}`)
      .join('\n\n');
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: [{ role: 'user', content: `Analyze and return JSON only:\n\n${conversationText}\n\n{"overall":<0-100>,"breakdown":{"opening":{"score":<0-100>,"feedback":""},"objectionHandling":{"score":<0-100>,"feedback":""},"rapport":{"score":<0-100>,"feedback":""},"tonality":{"score":<0-100>,"feedback":""},"timing":{"score":<0-100>,"feedback":""},"closing":{"score":<0-100>,"feedback":""}},"summary":"","keyStrength":"","keyImprovement":""}` }],
    });
    const raw = response.content[0].text.trim();
    const objMatch = raw.match(/\{[\s\S]*\}/);
    const analysis = JSON.parse(objMatch ? objMatch[0] : raw);
    res.json({ analysis });
  } catch (err) {
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
    res.json({ sessions: result.rows.map(r => ({ id: r.id, date: r.created_at, duration: r.duration, repMessages: r.rep_messages, analysis: r.analysis })) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Knowledge files ───────────────────────────────────────
app.post('/knowledge-file', async (req, res) => {
  try {
    const { filename, content } = req.body;
    if (!filename || !content) return res.status(400).json({ error: 'filename and content required.' });
    const result = await pool.query('INSERT INTO knowledge_files (filename, content) VALUES ($1, $2) RETURNING id', [filename.trim(), content.trim()]);
    knowledgeCache = null;
    res.json({ success: true, id: result.rows[0].id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/knowledge-files', async (req, res) => {
  try {
    const result = await pool.query("SELECT id, filename, LEFT(content, 120) AS preview, uploaded_at FROM knowledge_files ORDER BY uploaded_at DESC");
    res.json({ files: result.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/knowledge-file/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM knowledge_files WHERE id = $1', [req.params.id]);
    knowledgeCache = null;
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Manager endpoints ─────────────────────────────────────
function checkPin(req, res) {
  const pin = process.env.MANAGER_PIN || '1234';
  if (req.query.pin !== pin && req.body?.pin !== pin) {
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
      `SELECT rep_name, COUNT(*)::int AS session_count,
         ROUND(AVG((analysis->>'overall')::numeric))::int AS avg_score,
         MAX((analysis->>'overall')::numeric)::int AS best_score,
         MAX(created_at) AS last_active,
         json_agg(analysis ORDER BY created_at DESC) AS all_analyses
       FROM sessions
       ${days ? `WHERE created_at >= NOW() - ($1 || ' days')::interval` : ''}
       GROUP BY rep_name ORDER BY avg_score DESC`,
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
      return { name: row.rep_name, sessionCount: row.session_count, avgScore: row.avg_score, bestScore: row.best_score, latestScore, lastActive: row.last_active, improvement, catAvgs, topIssues: analyses.map(a => a.keyImprovement).filter(Boolean).slice(0, 3) };
    });
    res.json({ reps });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/manager/sessions', async (req, res) => {
  if (!checkPin(req, res)) return;
  try {
    const { rep, days } = req.query;
    if (!rep) return res.status(400).json({ error: 'rep query param required.' });
    const daysInt = parseInt(days) || null;
    const result = await pool.query(
      `SELECT * FROM sessions WHERE LOWER(rep_name) = LOWER($1) ${daysInt ? `AND created_at >= NOW() - ($2 || ' days')::interval` : ''} ORDER BY created_at DESC LIMIT 100`,
      daysInt ? [rep.trim(), daysInt] : [rep.trim()]
    );
    res.json({ sessions: result.rows.map(r => ({ id: r.id, date: r.created_at, duration: r.duration, repMessages: r.rep_messages, analysis: r.analysis })) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Reset ─────────────────────────────────────────────────
app.post('/reset', (req, res) => {
  const { sessionId } = req.body || {};
  if (sessionId) activeSessions.delete(sessionId);
  res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`D2D Roofing Sales Coach running at http://localhost:${PORT}`));

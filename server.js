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

// ── Build system prompt with knowledge base ───────────────
const BASE_SYSTEM_PROMPT = `You are roleplaying as a skeptical homeowner. A door-to-door roofing sales rep has just knocked on your door. You are mildly annoyed but willing to listen. After each rep message, respond in character as the homeowner, then on a new line add: COACH: [1-2 sentences of direct, specific feedback on the rep's technique and vocal delivery. If the message includes voice metrics (WPM, energy, pitch, filler words), address them explicitly — ideal sales pace is 130-150 WPM, energy should be warm and confident, filler words undermine credibility, monotone delivery kills rapport. Always say what to do differently. If training materials are provided below, reference them specifically when relevant.]`;

async function buildSystemPrompt() {
  const files = await getKnowledgeBase();
  if (files.length === 0) return BASE_SYSTEM_PROMPT;
  const kb = files
    .map(f => `--- ${f.filename} ---\n${f.content.slice(0, 3000)}`)
    .join('\n\n');
  return `${BASE_SYSTEM_PROMPT}\n\n[TRAINING MATERIALS — reference these when coaching]\n${kb}`;
}

const SCORECARD_PROMPT = `You are an expert sales coach. Review this door-to-door roofing sales practice conversation and rate the rep 1-10 on each category with one sentence of feedback. Use exactly this format:

Opening: [score]/10 — [one sentence of feedback]
Objection Handling: [score]/10 — [one sentence of feedback]
Rapport: [score]/10 — [one sentence of feedback]
Closing Attempt: [score]/10 — [one sentence of feedback]
Overall: [score]/10 — [one sentence summarizing performance]`;

// ── In-memory conversation history ────────────────────────
let conversationHistory = [];

// ── Chat ──────────────────────────────────────────────────
app.post('/chat', async (req, res) => {
  try {
    const { message } = req.body;
    if (!message || !message.trim()) {
      return res.status(400).json({ error: 'Message is required.' });
    }

    conversationHistory.push({ role: 'user', content: message });

    const systemPrompt = await buildSystemPrompt();
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: systemPrompt,
      messages: conversationHistory,
    });

    const assistantMessage = response.content[0].text;
    conversationHistory.push({ role: 'assistant', content: assistantMessage });

    res.json({ response: assistantMessage });
  } catch (err) {
    console.error('Chat error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Scorecard ─────────────────────────────────────────────
app.post('/scorecard', async (req, res) => {
  try {
    if (conversationHistory.length === 0) {
      return res.status(400).json({ error: 'No conversation to score yet.' });
    }
    const conversationText = conversationHistory
      .map(m => `${m.role === 'user' ? 'SALES REP' : 'HOMEOWNER/COACH'}: ${m.content}`)
      .join('\n\n');
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: [{ role: 'user', content: `Here is the full practice sales conversation:\n\n${conversationText}\n\n${SCORECARD_PROMPT}` }],
    });
    res.json({ scorecard: response.content[0].text });
  } catch (err) {
    console.error('Scorecard error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Analyze ───────────────────────────────────────────────
app.post('/analyze', async (req, res) => {
  try {
    if (conversationHistory.length === 0) {
      return res.status(400).json({ error: 'No conversation to analyze.' });
    }
    const conversationText = conversationHistory
      .map(m => `${m.role === 'user' ? 'SALES REP' : 'HOMEOWNER/COACH'}: ${m.content}`)
      .join('\n\n');
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: `You are an expert door-to-door sales coach. Analyze this roofing sales practice session and return ONLY a valid JSON object — no markdown, no extra text.

Conversation:
${conversationText}

Return exactly this structure:
{
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
    const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
    const analysis = JSON.parse(jsonMatch ? jsonMatch[1] : raw);
    res.json({ analysis });
  } catch (err) {
    console.error('Analyze error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Save session ──────────────────────────────────────────
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
    knowledgeCache = null; // invalidate cache
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

// ── Reset ─────────────────────────────────────────────────
app.post('/reset', (req, res) => {
  conversationHistory = [];
  res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`D2D Roofing Sales Coach running at http://localhost:${PORT}`);
});

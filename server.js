require('dotenv').config();
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are roleplaying as a skeptical homeowner. A door-to-door roofing sales rep has just knocked on your door. You are mildly annoyed but willing to listen. After each rep message, respond in character as the homeowner, then on a new line add: COACH: [1-2 sentences of honest feedback on the rep's technique — what worked, what didn't, and what to try instead].`;

const SCORECARD_PROMPT = `You are an expert sales coach. Review this door-to-door roofing sales practice conversation and rate the rep 1-10 on each category with one sentence of feedback. Use exactly this format:

Opening: [score]/10 — [one sentence of feedback]
Objection Handling: [score]/10 — [one sentence of feedback]
Rapport: [score]/10 — [one sentence of feedback]
Closing Attempt: [score]/10 — [one sentence of feedback]
Overall: [score]/10 — [one sentence summarizing performance]`;

// In-memory conversation history for the session
let conversationHistory = [];

app.post('/chat', async (req, res) => {
  try {
    const { message } = req.body;
    if (!message || !message.trim()) {
      return res.status(400).json({ error: 'Message is required.' });
    }

    conversationHistory.push({ role: 'user', content: message });

    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
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
      messages: [{
        role: 'user',
        content: `Here is the full practice sales conversation:\n\n${conversationText}\n\n${SCORECARD_PROMPT}`,
      }],
    });

    res.json({ scorecard: response.content[0].text });
  } catch (err) {
    console.error('Scorecard error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/reset', (req, res) => {
  conversationHistory = [];
  res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`D2D Roofing Sales Coach running at http://localhost:${PORT}`);
});

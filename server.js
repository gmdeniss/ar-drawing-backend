const express = require('express');
const app = express();

app.use(express.json({ limit: '15mb' })); // large enough for photo b64

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const FREE_LIMIT_PER_DAY = parseInt(process.env.FREE_LIMIT_PER_DAY || '10', 10);

// ── In-memory rate limiter ────────────────────────────────────────────────────
// Resets on server restart (Railway free tier: sleeps after ~30 min idle).
// Good enough for MVP; replace with Redis for production.
const rateLimits = new Map(); // deviceId → { count, dateStr }

function checkRateLimit(deviceId) {
    const today = new Date().toDateString();
    const entry = rateLimits.get(deviceId);
    if (!entry || entry.date !== today) {
        rateLimits.set(deviceId, { count: 1, date: today });
        return { allowed: true, remaining: FREE_LIMIT_PER_DAY - 1 };
    }
    if (entry.count >= FREE_LIMIT_PER_DAY) {
        return { allowed: false, remaining: 0 };
    }
    entry.count++;
    return { allowed: true, remaining: FREE_LIMIT_PER_DAY - entry.count };
}

// ── OpenAI helper ─────────────────────────────────────────────────────────────

async function callOpenAI(endpoint, body) {
    const res = await fetch(`https://api.openai.com/v1/${endpoint}`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${OPENAI_API_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error?.message || `OpenAI HTTP ${res.status}`);
    }
    return res.json();
}

// ── System prompt (locked style template) ────────────────────────────────────

const SYSTEM_PROMPT = `You are a prompt engineer for a children's AR drawing app. \
Your ONLY job: translate the user's input (may be Russian) to English \
and describe the subject in 3–6 words, then place it into the template below.

OUTPUT THE TEMPLATE EXACTLY, replacing only [SUBJECT]:

"Transparent background. [SUBJECT], children's coloring book style: \
thick clean black outlines only, no fill, no color, no shading, no gradients, \
flat design. Simple cute cartoon, friendly, age-appropriate for kids 6–12. \
Single centered subject, clear silhouette suitable for tracing on paper. \
No text, no watermarks, no background elements, no shadows."

Rules:
- Replace [SUBJECT] with a 3–6 word English subject description only
- Do NOT add anything else before or after the template
- Output ONLY the completed template text, nothing else`;

// ── GET /health ───────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => res.json({ ok: true }));

// ── POST /generate-template ───────────────────────────────────────────────────
// Headers: X-Device-ID: <uuid>
// Body:    { "input": "кот" }
// Returns: { "b64_json": "...", "remaining": 4 }

app.post('/generate-template', async (req, res) => {
    const deviceId = req.headers['x-device-id'];
    if (!deviceId || !/^[0-9a-f-]{36}$/i.test(deviceId)) {
        return res.status(400).json({ error: 'Missing or invalid X-Device-ID header' });
    }

    const { allowed, remaining } = checkRateLimit(deviceId);
    if (!allowed) {
        return res.status(429).json({
            error: 'Лимит использован на сегодня. Попробуй завтра! 🌙',
            remaining: 0
        });
    }

    const input = (req.body.input || '').trim();
    if (!input) return res.status(400).json({ error: 'Missing input' });

    try {
        // Step 1: GPT-4o fills the style template (guarantees consistent visual style)
        const chatResult = await callOpenAI('chat/completions', {
            model: 'gpt-4o',
            messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user',   content: input }
            ],
            max_tokens: 160,
            temperature: 0.2
        });
        const prompt = chatResult.choices[0].message.content.trim();

        // Step 2: gpt-image-1.5 renders transparent PNG coloring outline
        const imageResult = await callOpenAI('images/generations', {
            model:         'gpt-image-1.5',
            prompt,
            size:          '1024x1024',
            quality:       'medium',
            background:    'transparent',
            output_format: 'png',
            moderation:    'auto'
        });

        const b64_json = imageResult.data[0].b64_json;
        res.json({ b64_json, remaining });

    } catch (err) {
        console.error('/generate-template error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── POST /describe-photo ──────────────────────────────────────────────────────
// Headers: X-Device-ID: <uuid>
// Body:    { "b64jpeg": "..." }
// Returns: { "subject": "sitting orange cat" }
// Note: Photo description does NOT count against the rate limit.
//       Only /generate-template counts (one full generation = one charge).

app.post('/describe-photo', async (req, res) => {
    const deviceId = req.headers['x-device-id'];
    if (!deviceId || !/^[0-9a-f-]{36}$/i.test(deviceId)) {
        return res.status(400).json({ error: 'Missing or invalid X-Device-ID header' });
    }

    const b64jpeg = (req.body.b64jpeg || '').trim();
    if (!b64jpeg) return res.status(400).json({ error: 'Missing b64jpeg' });

    try {
        const chatResult = await callOpenAI('chat/completions', {
            model: 'gpt-4o',
            max_tokens: 60,
            messages: [{
                role: 'user',
                content: [
                    {
                        type: 'image_url',
                        image_url: { url: `data:image/jpeg;base64,${b64jpeg}`, detail: 'low' }
                    },
                    {
                        type: 'text',
                        text: "Describe the main subject of this photo in 3–5 English words suitable for a children's coloring outline (e.g. 'sitting cat', 'running dinosaur'). Output ONLY those words, nothing else."
                    }
                ]
            }]
        });
        const subject = chatResult.choices[0].message.content.trim();
        res.json({ subject });

    } catch (err) {
        console.error('/describe-photo error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`AR Drawing backend running on port ${PORT}`);
    if (!OPENAI_API_KEY) console.warn('WARNING: OPENAI_API_KEY is not set!');
});

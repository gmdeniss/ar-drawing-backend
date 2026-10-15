const express = require('express');
const app = express();

app.use(express.json({ limit: '15mb' })); // large enough for photo b64

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
// The GPT-4 line leaves the API on 2027-01-14; gpt-6-luna is OpenAI's recommended replacement.
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-6-luna';
// gpt-image-1.5 shuts down on 2026-12-01; both 2.5 models keep transparent backgrounds.
const IMAGE_MODEL = process.env.IMAGE_MODEL || 'gpt-image-1.5';
const IMAGE_QUALITY = process.env.IMAGE_QUALITY || 'medium';
// Models a comparison request may pick (only with the app secret, see /generate-template).
const IMAGE_MODELS = ['gpt-image-1.5', 'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst'];
const APP_SECRET = process.env.APP_SECRET;  // shared with the app

function hasAppSecret(req) {
    return Boolean(APP_SECRET) && req.headers['x-app-secret'] === APP_SECRET;
}
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
- Output ONLY the completed template text, nothing else
- IMPORTANT: Never use trademarked or copyrighted character names. \
Replace them with generic equivalents: \
Spider-Man → web-crawling spider hero, Batman → dark cape bat hero, \
Iron Man → red metal armor hero, Superman → flying caped hero, \
Mickey Mouse → cheerful round-eared mouse, Elsa → ice magic princess, \
Minecraft Steve → blocky pixel character, Pokemon → cute pocket monster. \
Apply this rule to ANY trademarked character from games, movies, or comics.`;

// ── GET /health ───────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => res.json({ ok: true, animate: Boolean(FAL_KEY) }));

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
    if (!input) {
        // refund the count we just incremented
        const entry = rateLimits.get(deviceId);
        if (entry) entry.count--;
        return res.status(400).json({ error: 'Missing input' });
    }

    try {
        // Step 1: the chat model fills the style template (guarantees consistent visual style)
        const chatResult = await callOpenAI('chat/completions', {
            model: OPENAI_MODEL,
            reasoning_effort: 'none',
            messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user',   content: input }
            ],
            max_completion_tokens: 160
        });
        const prompt = chatResult.choices[0].message.content.trim();

        // Step 2: the image model renders a transparent PNG coloring outline.
        // With the app secret a request may pick another model or quality, to compare them.
        const trusted = hasAppSecret(req);
        const model = trusted && IMAGE_MODELS.includes(req.body.imageModel) ? req.body.imageModel : IMAGE_MODEL;
        const quality = trusted && ['low', 'medium', 'high'].includes(req.body.quality) ? req.body.quality : IMAGE_QUALITY;
        const started = Date.now();
        const imageResult = await callOpenAI('images/generations', {
            model,
            prompt,
            size:          '1024x1024',
            quality,
            background:    'transparent',
            output_format: 'png',
            moderation:    'auto'
        });
        console.log(`/generate-template ${model} ${quality} in ${Date.now() - started} ms`);

        const b64_json = imageResult.data[0].b64_json;
        res.json({ b64_json, remaining });

    } catch (err) {
        console.error('/generate-template error:', err.message);

        // Refund rate limit on any generation failure — child shouldn't lose a slot for a blocked/failed request
        const entry = rateLimits.get(deviceId);
        if (entry) entry.count--;

        // Return a kid-friendly message for moderation/content blocks
        const msg = err.message || '';
        const isModeration = msg.toLowerCase().includes('safety') ||
                             msg.toLowerCase().includes('content') ||
                             msg.toLowerCase().includes('policy') ||
                             msg.toLowerCase().includes('moderat');
        if (isModeration) {
            return res.status(422).json({
                error: 'Такой рисунок не получается создать 🙈 Попробуй что-нибудь другое — кот, дракон, ракета!'
            });
        }
        res.status(500).json({ error: 'Что-то пошло не так 😅 Попробуй ещё раз!' });
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
            model: OPENAI_MODEL,
            reasoning_effort: 'none',
            max_completion_tokens: 60,
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

// ── Living drawings ───────────────────────────────────────────────────────────
// A "director" (GPT-4o vision) picks one gentle motion for the child's drawing,
// then fal.ai (MiniMax H3 Max Turbo) animates it with the drawing as both the first and
// the last frame, so the clip loops back to the picture.

const FAL_KEY = process.env.FAL_KEY;
const ANIMATE_MODEL = process.env.ANIMATE_MODEL || 'minimax/h3-max-turbo/image-to-video';
const ANIMATE_RESOLUTION = process.env.ANIMATE_RESOLUTION || '768P';
const ANIMATE_PER_DEVICE = parseInt(process.env.ANIMATE_PER_DEVICE || '5', 10);
const ANIMATE_PER_DAY = parseInt(process.env.ANIMATE_PER_DAY || '10', 10);

// Every clip costs real money, so besides the per-device limit the whole server has a daily cap.
const animateCounts = new Map(); // deviceId → { count, date }
let animateTotal = { count: 0, date: '' };

function takeAnimationSlot(deviceId) {
    const today = new Date().toDateString();
    if (animateTotal.date !== today) animateTotal = { count: 0, date: today };
    let entry = animateCounts.get(deviceId);
    if (!entry || entry.date !== today) {
        entry = { count: 0, date: today };
        animateCounts.set(deviceId, entry);
    }
    if (entry.count >= ANIMATE_PER_DEVICE || animateTotal.count >= ANIMATE_PER_DAY) return null;
    entry.count++;
    animateTotal.count++;
    return ANIMATE_PER_DEVICE - entry.count;
}

function refundAnimationSlot(deviceId) {
    const entry = animateCounts.get(deviceId);
    if (entry && entry.count > 0) entry.count--;
    if (animateTotal.count > 0) animateTotal.count--;
}

const DIRECTOR_PROMPT = `You direct short animations for a children's drawing app.

Input: one picture drawn by a child aged 6–11 on a tablet, sometimes on top of a black-outline coloring page, plus the template name if there is one.
Task: choose ONE simple, gentle motion that brings the drawing to life. The video starts and ends on the original drawing.

Rules
1. Use only what is actually drawn. Never add objects, characters, scenery, text, sparkles or other effects.
2. Animate the main subject: the largest or most central figure. At most two figures move; everything else stays still.
3. Pick a motion that fits the subject and keeps it inside the frame:
   - person, animal, creature: blink, smile, wave, nod, wag a tail, flap wings, small hop;
   - vehicle: wheels turn, gentle bounce in place;
   - plant, object, building: gentle sway;
   - abstract or unclear drawing: the whole picture gently wobbles like a hand-drawn cartoon.
4. Calm and kind: nothing scary, violent or sudden, even for monsters, dragons and superheroes.
5. If a template name is given, use it to understand the subject, but never write character, franchise or brand names in "motion", and never describe their trademark look either (moderation recognizes that too). Use plain words: "the character", "the hero", "the animal", "the car".
6. The motion starts and ends in the drawn pose.

Reply with JSON only:
{"subject_ru": "что нарисовано, 1–3 слова по-русски", "motion": "one short English sentence describing the motion"}`;

const videoPrompt = motion => `Animate this child's hand-drawn picture: ${motion}
Static camera. Keep the exact drawing: same wobbly hand-drawn lines, same flat colors, same paper background; uncolored areas stay uncolored. Flat 2D hand-drawn cartoon look. No new objects, characters, text or effects. Gentle, smooth motion that returns to the original pose.`;

const FALLBACK_MOTION = 'The whole picture gently wobbles like a hand-drawn cartoon.';

const DIRECTION_SCHEMA = {
    name: 'direction',
    strict: true,
    schema: {
        type: 'object',
        properties: { subject_ru: { type: 'string' }, motion: { type: 'string' } },
        required: ['subject_ru', 'motion'],
        additionalProperties: false
    }
};

// The director never blocks a clip: if it fails, the picture just wobbles.
async function directMotion(dataUri, subject, kind) {
    const hint = subject ? `Template name: ${subject}`
        : kind === 'blank' ? 'Drawn on a blank sheet, no template.' : 'No template name.';
    try {
        const result = await callOpenAI('chat/completions', {
            model: OPENAI_MODEL,
            reasoning_effort: 'none',
            max_completion_tokens: 200,
            response_format: { type: 'json_schema', json_schema: DIRECTION_SCHEMA },
            messages: [
                { role: 'system', content: DIRECTOR_PROMPT },
                { role: 'user', content: [
                    { type: 'image_url', image_url: { url: dataUri, detail: 'low' } },
                    { type: 'text', text: hint }
                ] }
            ]
        });
        const parsed = JSON.parse(result.choices[0].message.content);
        const motion = String(parsed.motion || '').trim();
        if (!motion) throw new Error('empty motion');
        return { subject: String(parsed.subject_ru || '').trim(), motion: motion.slice(0, 300), directed: true };
    } catch (err) {
        console.warn('/animate director fallback:', err.message);
        return { subject: '', motion: FALLBACK_MOTION, directed: false };
    }
}

async function falCall(url, body) {
    const res = await fetch(url, {
        method: body ? 'POST' : 'GET',
        headers: { 'Authorization': `Key ${FAL_KEY}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
        const detail = typeof json.detail === 'string' ? json.detail : JSON.stringify(json.detail || json);
        const err = new Error(`fal HTTP ${res.status}: ${detail}`);
        err.status = res.status;
        throw err;
    }
    return json;
}

async function generateClip(dataUri, motion) {
    const job = await falCall(`https://queue.fal.run/${ANIMATE_MODEL}`, {
        prompt: videoPrompt(motion),
        image_url: dataUri,
        end_image_url: dataUri,           // same first and last frame: the clip loops back to the drawing
        resolution: ANIMATE_RESOLUTION,
        duration: 5,
        prompt_expansion_mode: 'disabled' // the expander invents dialogue and sounds
    });
    const deadline = Date.now() + 150000;
    while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 1500));
        const status = await falCall(job.status_url);
        if (status.status === 'COMPLETED') break;
    }
    const result = await falCall(job.response_url);
    const url = result.video && result.video.url;
    if (!url) throw new Error('fal: no video in the result');
    return url;
}

// ── POST /animate ─────────────────────────────────────────────────────────────
// Headers: X-Device-ID: <uuid>, X-App-Secret: <secret> (when APP_SECRET is set)
// Body:    { "image": "<base64 jpeg or png>", "subject": "Акула", "kind": "catalog|ai|blank" }
// Returns: { "videoUrl": "https://…mp4", "subject": "акула", "motion": "…", "directed": true, "remaining": 4 }
// A failed or refused clip doesn't count against the limits.

app.post('/animate', async (req, res) => {
    const deviceId = req.headers['x-device-id'];
    if (!deviceId || !/^[0-9a-f-]{36}$/i.test(deviceId)) {
        return res.status(400).json({ error: 'Missing or invalid X-Device-ID header' });
    }
    if (APP_SECRET && !hasAppSecret(req)) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    if (!FAL_KEY) {
        return res.status(503).json({ error: 'Оживление пока не настроено 🛠️' });
    }

    const image = String(req.body.image || '').trim();
    if (!image || image.length > 8000000 || !/^[A-Za-z0-9+/=]+$/.test(image.slice(0, 200))) {
        return res.status(400).json({ error: 'Missing image' });
    }
    const mime = image.startsWith('iVBOR') ? 'image/png' : 'image/jpeg';
    const dataUri = `data:${mime};base64,${image}`;
    const subject = String(req.body.subject || '').trim().slice(0, 80);
    const kind = String(req.body.kind || '');

    const remaining = takeAnimationSlot(deviceId);
    if (remaining === null) {
        return res.status(429).json({
            error: 'На сегодня оживления закончились. Завтра оживим ещё! 🌙',
            remaining: 0
        });
    }

    const started = Date.now();
    try {
        const direction = await directMotion(dataUri, subject, kind);
        const videoUrl = await generateClip(dataUri, direction.motion);
        console.log(`/animate ok in ${Date.now() - started} ms (${kind} "${subject}"): ${direction.motion}`);
        res.json({ videoUrl, subject: direction.subject, motion: direction.motion,
                   directed: direction.directed, remaining });
    } catch (err) {
        console.error('/animate error:', err.message);
        refundAnimationSlot(deviceId);
        const msg = (err.message || '').toLowerCase();
        if (err.status === 422 || /safety|content|policy|moderat|nsfw|sensitive/.test(msg)) {
            return res.status(422).json({ error: 'Этот рисунок у меня не получилось оживить 🙈 Попробуй другой!' });
        }
        res.status(502).json({ error: 'Что-то пошло не так 😅 Попробуй ещё раз!' });
    }
});

// ── POST /guess ───────────────────────────────────────────────────────────────
// Кисточка looks at the drawing and says what she sees.
// Headers: X-Device-ID: <uuid>, X-App-Secret: <secret> (when APP_SECRET is set)
// Body:    { "image": "<base64 jpeg or png>", "subject": "Акула", "kind": "catalog|ai|blank", "mode": "little|artist|master" }
// Returns: { "phrase": "Ого, это солнышко над травкой! ☀️" }

const GUESS_PER_DEVICE = parseInt(process.env.GUESS_PER_DEVICE || '40', 10);
const guessCounts = new Map(); // deviceId → { count, date }

const GUESS_PROMPT = `You are Кисточка, a cheerful puppy who lives in a children's drawing app and loves the kids' pictures.
A child aged 6–11 shows you a drawing made on a tablet, sometimes on top of a black-outline coloring page.

Say what you see, in Russian, as Кисточка talking to the child:
- one or two short sentences, at most 120 characters, warm and playful, one emoji at most;
- if the drawing has no template, guess what it shows, naming things and colors you really see; if it's unclear, make a happy guess and ask, e.g. "Это ракета? Или волшебная рыбка? 🤔";
- if a template name is given, don't guess the subject: praise something specific about how it's colored;
- never criticize, never mention mistakes, nothing scary; don't name brands or famous characters;
- for "little" mode use very simple words; for "master" mode speak like to an older kid, a bit less cute.

Reply with JSON only: {"phrase": "..."}`;

const GUESS_SCHEMA = {
    name: 'guess',
    strict: true,
    schema: {
        type: 'object',
        properties: { phrase: { type: 'string' } },
        required: ['phrase'],
        additionalProperties: false
    }
};

app.post('/guess', async (req, res) => {
    const deviceId = req.headers['x-device-id'];
    if (!deviceId || !/^[0-9a-f-]{36}$/i.test(deviceId)) {
        return res.status(400).json({ error: 'Missing or invalid X-Device-ID header' });
    }
    if (APP_SECRET && !hasAppSecret(req)) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    const image = String(req.body.image || '').trim();
    if (!image || image.length > 8000000 || !/^[A-Za-z0-9+/=]+$/.test(image.slice(0, 200))) {
        return res.status(400).json({ error: 'Missing image' });
    }

    const today = new Date().toDateString();
    let entry = guessCounts.get(deviceId);
    if (!entry || entry.date !== today) {
        entry = { count: 0, date: today };
        guessCounts.set(deviceId, entry);
    }
    if (entry.count >= GUESS_PER_DEVICE) {
        return res.status(429).json({ error: 'Я сегодня уже много угадывала, глазки устали 😴 Давай завтра!' });
    }
    entry.count++;

    const mime = image.startsWith('iVBOR') ? 'image/png' : 'image/jpeg';
    const subject = String(req.body.subject || '').trim().slice(0, 80);
    const mode = ['little', 'artist', 'master'].includes(req.body.mode) ? req.body.mode : 'artist';
    const hint = `${subject ? `Template name: ${subject}` : 'No template: drawn on a blank sheet or over an AI picture.'} Mode: ${mode}.`;
    try {
        const result = await callOpenAI('chat/completions', {
            model: OPENAI_MODEL,
            reasoning_effort: 'none',
            max_completion_tokens: 200,
            response_format: { type: 'json_schema', json_schema: GUESS_SCHEMA },
            messages: [
                { role: 'system', content: GUESS_PROMPT },
                { role: 'user', content: [
                    { type: 'image_url', image_url: { url: `data:${mime};base64,${image}`, detail: 'low' } },
                    { type: 'text', text: hint }
                ] }
            ]
        });
        const phrase = String(JSON.parse(result.choices[0].message.content).phrase || '').trim().slice(0, 200);
        if (!phrase) throw new Error('empty phrase');
        res.json({ phrase });
    } catch (err) {
        console.error('/guess error:', err.message);
        entry.count--;
        res.status(502).json({ error: 'Ой, я задумалась и не разглядела 🙈 Покажи ещё раз!' });
    }
});

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`AR Drawing backend running on port ${PORT}`);
    if (!OPENAI_API_KEY) console.warn('WARNING: OPENAI_API_KEY is not set!');
    if (!FAL_KEY) console.warn('WARNING: FAL_KEY is not set — /animate is off');
});

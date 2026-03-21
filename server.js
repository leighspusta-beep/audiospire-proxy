// AudioSpire™ AI Proxy Server — with ElevenLabs TTS
// Requirements: Node.js 18+
// Install: npm install express cors
// Run:     ANTHROPIC_API_KEY=your_key ELEVENLABS_API_KEY=your_key node server.js

const express = require('express');
const cors    = require('cors');

const app           = express();
const PORT          = process.env.PORT || 3000;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const ELEVEN_KEY    = process.env.ELEVENLABS_API_KEY;

if (!ANTHROPIC_KEY) { console.error('❌  ANTHROPIC_API_KEY not set. Exiting.'); process.exit(1); }
if (!ELEVEN_KEY)    { console.warn('⚠️   ELEVENLABS_API_KEY not set — /tts endpoint will not work.'); }

// ── CORS ─────────────────────────────────────────────────────────────────────
// Lock this down to your actual domain(s) before going live, e.g.:
//   origin: ['https://yourdomain.com']
app.use(cors({ origin: '*', methods: ['POST', 'GET'], allowedHeaders: ['Content-Type'] }));
app.use(express.json({ limit: '64kb' }));

// ── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'AudioSpire AI Proxy online', tts: !!ELEVEN_KEY }));

// =============================================================================
// /ai  — Anthropic Claude streaming endpoint (unchanged)
// =============================================================================
app.post('/ai', async (req, res) => {
    const { messages, system, model, max_tokens } = req.body;
    if (!messages || !Array.isArray(messages) || messages.length === 0)
        return res.status(400).json({ error: 'messages array is required' });
    if (JSON.stringify(messages).length > 32000)
        return res.status(413).json({ error: 'Conversation history too large' });

    // Allow client to select model and token limit — whitelist for safety
    const ALLOWED_MODELS = [
        'claude-sonnet-4-20250514',
        'claude-haiku-4-5-20251001',
        'claude-opus-4-6'
    ];
    const safeModel   = ALLOWED_MODELS.includes(model) ? model : 'claude-sonnet-4-20250514';
    const safeTokens  = (typeof max_tokens === 'number' && max_tokens > 0 && max_tokens <= 2048)
                        ? max_tokens : 1024;

    try {
        const upstream = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type':      'application/json',
                'x-api-key':         ANTHROPIC_KEY,
                'anthropic-version': '2023-06-01',
                'anthropic-beta':    'messages-2023-12-15'
            },
            body: JSON.stringify({
                model:      safeModel,
                max_tokens: safeTokens,
                stream:     true,
                system:     system || '',
                messages
            })
        });

        if (!upstream.ok) {
            const err = await upstream.json().catch(() => ({}));
            return res.status(upstream.status).json({ error: err.error?.message || 'Upstream API error' });
        }

        res.setHeader('Content-Type',  'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection',    'keep-alive');

        const reader = upstream.body.getReader();
        const pump   = async () => {
            while (true) {
                const { done, value } = await reader.read();
                if (done) { res.end(); break; }
                res.write(value);
            }
        };
        pump().catch(err => { console.error('AI stream error:', err.message); res.end(); });

    } catch (err) {
        console.error('AI proxy error:', err.message);
        res.status(500).json({ error: 'Proxy server error' });
    }
});

// =============================================================================
// /tts  — ElevenLabs text-to-speech streaming endpoint
//
// POST body: { text, voiceId, modelId?, stability?, similarityBoost?, styleExaggeration? }
// Returns:   audio/mpeg stream
// =============================================================================
app.post('/tts', async (req, res) => {
    if (!ELEVEN_KEY)
        return res.status(503).json({ error: 'ElevenLabs API key not configured on server' });

    const {
        text,
        voiceId,
        modelId           = 'eleven_turbo_v2_5',
        stability         = 0.45,
        similarityBoost   = 0.82,
        styleExaggeration = 0.35,
        speakerBoost      = true
    } = req.body;

    if (!text || !text.trim())
        return res.status(400).json({ error: 'text is required' });
    if (!voiceId)
        return res.status(400).json({ error: 'voiceId is required' });
    if (text.length > 5000)
        return res.status(413).json({ error: 'Text too long — max 5000 chars per request' });

    try {
        const upstream = await fetch(
            `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'xi-api-key':   ELEVEN_KEY
            },
            body: JSON.stringify({
                text,
                model_id: modelId,
                voice_settings: {
                    stability,
                    similarity_boost:   similarityBoost,
                    style:              styleExaggeration,
                    use_speaker_boost:  speakerBoost
                }
            })
        });

        if (!upstream.ok) {
            const err = await upstream.json().catch(() => ({}));
            return res.status(upstream.status).json({
                error: err.detail?.message || err.detail || 'ElevenLabs API error'
            });
        }

        res.setHeader('Content-Type',       'audio/mpeg');
        res.setHeader('Cache-Control',      'no-cache');
        res.setHeader('Transfer-Encoding',  'chunked');

        const reader = upstream.body.getReader();
        const pump   = async () => {
            while (true) {
                const { done, value } = await reader.read();
                if (done) { res.end(); break; }
                res.write(Buffer.from(value));
            }
        };
        pump().catch(err => { console.error('TTS stream error:', err.message); res.end(); });

    } catch (err) {
        console.error('TTS proxy error:', err.message);
        res.status(500).json({ error: 'TTS proxy server error' });
    }
});

// =============================================================================
// /voices  — returns the account's ElevenLabs voice list for the dropdown
// =============================================================================
app.get('/voices', async (req, res) => {
    if (!ELEVEN_KEY)
        return res.status(503).json({ error: 'ElevenLabs API key not configured on server' });
    try {
        const upstream = await fetch('https://api.elevenlabs.io/v1/voices', {
            headers: { 'xi-api-key': ELEVEN_KEY }
        });
        if (!upstream.ok)
            return res.status(upstream.status).json({ error: 'Could not fetch voices' });
        const data = await upstream.json();
        const voices = (data.voices || []).map(v => ({
            voice_id: v.voice_id,
            name:     v.name,
            category: v.category
        }));
        res.json({ voices });
    } catch (err) {
        console.error('Voices fetch error:', err.message);
        res.status(500).json({ error: 'Could not fetch voices' });
    }
});

app.listen(PORT, () => {
    console.log(`✅  AudioSpire AI Proxy running on port ${PORT}`);
    console.log(`    Anthropic AI:    ${ANTHROPIC_KEY ? '✅  ready' : '❌  missing key'}`);
    console.log(`    ElevenLabs TTS:  ${ELEVEN_KEY    ? '✅  ready' : '❌  ELEVENLABS_API_KEY missing'}`);
});

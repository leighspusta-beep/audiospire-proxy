// AudioSpire™ AI Proxy Server — Anthropic Claude + OpenAI TTS
// Requirements: Node.js 18+
// Install: npm install express cors
// Run:     ANTHROPIC_API_KEY=your_key OPENAI_API_KEY=your_key node server.js

const express = require('express');
const cors    = require('cors');

const app           = express();
const PORT          = process.env.PORT || 3000;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const OPENAI_KEY    = process.env.OPENAI_API_KEY;

if (!ANTHROPIC_KEY) { console.error('❌  ANTHROPIC_API_KEY not set. Exiting.'); process.exit(1); }
if (!OPENAI_KEY)    { console.warn('⚠️   OPENAI_API_KEY not set — /tts endpoint will not work.'); }

// ── CORS ─────────────────────────────────────────────────────────────────────
// Lock this down to your actual domain(s) before going live, e.g.:
//   origin: ['https://yourdomain.com']
app.use(cors({ origin: '*', methods: ['POST', 'GET'], allowedHeaders: ['Content-Type'] }));
app.use(express.json({ limit: '64kb' }));

// ── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({
    status:    'AudioSpire AI Proxy online',
    anthropic: !!ANTHROPIC_KEY,
    tts:       !!OPENAI_KEY
}));

// =============================================================================
// /ai  — Anthropic Claude streaming endpoint
// =============================================================================
app.post('/ai', async (req, res) => {
    const { messages, system, model, max_tokens } = req.body;
    if (!messages || !Array.isArray(messages) || messages.length === 0)
        return res.status(400).json({ error: 'messages array is required' });
    if (JSON.stringify(messages).length > 32000)
        return res.status(413).json({ error: 'Conversation history too large' });

    // Whitelist models for safety
    const ALLOWED_MODELS = [
        'claude-sonnet-4-20250514',
        'claude-haiku-4-5-20251001',
        'claude-opus-4-6'
    ];
    const safeModel  = ALLOWED_MODELS.includes(model) ? model : 'claude-sonnet-4-20250514';
    const safeTokens = (typeof max_tokens === 'number' && max_tokens > 0 && max_tokens <= 2048)
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
// /tts  — OpenAI text-to-speech endpoint
//
// POST body: { text, voice?, model? }
// Returns:   audio/mpeg
// =============================================================================
app.post('/tts', async (req, res) => {
    if (!OPENAI_KEY)
        return res.status(503).json({ error: 'OpenAI API key not configured on server' });

    const {
        text,
        voice = 'nova',    // default voice — change here to switch global default
        model = 'tts-1'    // tts-1 or tts-1-hd
    } = req.body;

    if (!text || !text.trim())
        return res.status(400).json({ error: 'text is required' });
    if (text.length > 4096)
        return res.status(413).json({ error: 'Text too long — max 4096 chars' });

    // Whitelist for safety
    const ALLOWED_VOICES = ['alloy','echo','fable','onyx','nova','shimmer',
                            'coral','sage','ash','ballad','verse'];
    const ALLOWED_MODELS = ['tts-1', 'tts-1-hd'];
    const safeVoice = ALLOWED_VOICES.includes(voice) ? voice : 'nova';
    const safeModel = ALLOWED_MODELS.includes(model) ? model : 'tts-1';

    try {
        const upstream = await fetch('https://api.openai.com/v1/audio/speech', {
            method: 'POST',
            headers: {
                'Content-Type':  'application/json',
                'Authorization': `Bearer ${OPENAI_KEY}`
            },
            body: JSON.stringify({
                model:           safeModel,
                voice:           safeVoice,
                input:           text,
                response_format: 'mp3'
            })
        });

        if (!upstream.ok) {
            const err = await upstream.json().catch(() => ({}));
            return res.status(upstream.status).json({
                error: err.error?.message || 'OpenAI TTS error'
            });
        }

        // Stream MP3 directly back to the dashboard
        res.setHeader('Content-Type',      'audio/mpeg');
        res.setHeader('Cache-Control',     'no-cache');
        res.setHeader('Transfer-Encoding', 'chunked');

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

app.listen(PORT, () => {
    console.log(`✅  AudioSpire AI Proxy running on port ${PORT}`);
    console.log(`    Anthropic AI:  ${ANTHROPIC_KEY ? '✅  ready' : '❌  missing key'}`);
    console.log(`    OpenAI TTS:    ${OPENAI_KEY    ? '✅  ready' : '❌  OPENAI_API_KEY missing'}`);
});

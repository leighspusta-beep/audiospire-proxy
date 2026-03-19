// AudioSpire™ AI Proxy Server
// Requirements: Node.js 18+
// Install: npm install express cors node-fetch
// Run:     ANTHROPIC_API_KEY=your_key_here node server.js
// Or set the key in a .env file and use: npm install dotenv, then require('dotenv').config()

const express = require('express');
const cors    = require('cors');

const app  = express();
const PORT = process.env.PORT || 3000;
const KEY  = process.env.ANTHROPIC_API_KEY;

if (!KEY) {
    console.error('❌  ANTHROPIC_API_KEY environment variable is not set. Exiting.');
    process.exit(1);
}

// ── CORS ─────────────────────────────────────────────────────────────────────
// Lock this down to your actual domain(s) in production, e.g.:
//   origin: ['https://yourdomain.com', 'https://www.yourdomain.com']
// For local testing you can use origin: '*'
app.use(cors({
    origin: '*',          // ← replace with your domain(s) before going live
    methods: ['POST'],
    allowedHeaders: ['Content-Type']
}));

app.use(express.json({ limit: '64kb' }));

// ── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'AudioSpire AI Proxy online' }));

// ── MAIN PROXY ENDPOINT ───────────────────────────────────────────────────────
app.post('/ai', async (req, res) => {
    const { messages, system } = req.body;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
        return res.status(400).json({ error: 'messages array is required' });
    }

    // Basic input sanitation — reject absurdly large payloads
    if (JSON.stringify(messages).length > 32000) {
        return res.status(413).json({ error: 'Conversation history too large' });
    }

    try {
        const upstream = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type':         'application/json',
                'x-api-key':            KEY,
                'anthropic-version':    '2023-06-01',
                'anthropic-beta':       'messages-2023-12-15'
            },
            body: JSON.stringify({
                model:      'claude-sonnet-4-20250514',
                max_tokens: 1024,
                stream:     true,
                system:     system || '',
                messages
            })
        });

        if (!upstream.ok) {
            const err = await upstream.json().catch(() => ({}));
            return res.status(upstream.status).json({ error: err.error?.message || 'Upstream API error' });
        }

        // Stream the SSE response straight through to the client
        res.setHeader('Content-Type',  'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection',    'keep-alive');

        const reader = upstream.body.getReader();
        const pump   = async () => {
            while (true) {
                const { done, value } = await reader.read();
                if (done) { res.end(); break; }
                res.write(value);          // forward raw SSE bytes
            }
        };
        pump().catch(err => {
            console.error('Stream error:', err.message);
            res.end();
        });

    } catch (err) {
        console.error('Proxy error:', err.message);
        res.status(500).json({ error: 'Proxy server error' });
    }
});

app.listen(PORT, () => {
    console.log(`✅  AudioSpire AI Proxy running on port ${PORT}`);
});

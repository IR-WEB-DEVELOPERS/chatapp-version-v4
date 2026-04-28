// ============================================================
//  server.js - Render deployment server
//  Serves static files + Web Push + OTP email endpoints
// ============================================================

try {
    require('dotenv').config();
} catch (err) {
    // Render and other hosts inject env vars directly; dotenv is only for local runs.
}

const express = require('express');
const webpush = require('web-push');
const admin = require('firebase-admin');
const path = require('path');
const crypto = require('crypto');

let nodemailer = null;
try {
    nodemailer = require('nodemailer');
} catch (err) {
    console.warn('Nodemailer not installed yet. Run: npm install');
}

const app = express();
const PORT = process.env.PORT || 8080;

// ── CORS middleware ──────────────────────────────────────────
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (!origin || ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin)) {
        if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

app.use(express.json());

// NOTE: express.static is registered AFTER all API routes below,
// so /firebase-config, /vapid-public-key etc. are never shadowed by disk lookups.

// ── OTP store (backed by Firestore when available, in-memory fallback) ──
// The in-memory Map is used as a write-through cache; Firestore is the
// source of truth so OTPs survive server restarts / cold-starts.
const otpMemCache = new Map();

async function otpStoreSet(key, value, db) {
    otpMemCache.set(key, value);
    if (db) {
        try {
            await db.collection('_otpStore').doc(key.replace(/[^a-zA-Z0-9_-]/g, '_')).set(value);
        } catch (e) { console.warn('OTP Firestore write failed:', e.message); }
    }
}

async function otpStoreGet(key, db) {
    if (otpMemCache.has(key)) return otpMemCache.get(key);
    if (db) {
        try {
            const snap = await db.collection('_otpStore').doc(key.replace(/[^a-zA-Z0-9_-]/g, '_')).get();
            if (snap.exists) {
                const val = snap.data();
                otpMemCache.set(key, val);
                return val;
            }
        } catch (e) { console.warn('OTP Firestore read failed:', e.message); }
    }
    return null;
}

async function otpStoreDelete(key, db) {
    otpMemCache.delete(key);
    if (db) {
        try {
            await db.collection('_otpStore').doc(key.replace(/[^a-zA-Z0-9_-]/g, '_')).delete();
        } catch (e) { console.warn('OTP Firestore delete failed:', e.message); }
    }
}

// ── Rate limiting for /send-otp ──────────────────────────────
// Tracks per-IP and per-email send counts with a rolling 1-hour window
const otpRateLimit = new Map(); // key -> { count, windowStart }
const OTP_RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const OTP_MAX_PER_IP = 10;
const OTP_MAX_PER_EMAIL = 5;

function checkOtpRateLimit(ip, email) {
    const now = Date.now();
    for (const key of [`ip:${ip}`, `email:${email}`]) {
        const limit = key.startsWith('ip:') ? OTP_MAX_PER_IP : OTP_MAX_PER_EMAIL;
        let entry = otpRateLimit.get(key);
        if (!entry || now - entry.windowStart > OTP_RATE_WINDOW_MS) {
            entry = { count: 0, windowStart: now };
        }
        if (entry.count >= limit) return false;
        entry.count++;
        otpRateLimit.set(key, entry);
    }
    return true;
}

function loadServiceAccount() {
    if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
        const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON.trim();
        const json = raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
        const parsed = JSON.parse(json);
        if (parsed.private_key) parsed.private_key = parsed.private_key.replace(/\\n/g, '\n');
        return parsed;
    }

    if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
        return {
            type: 'service_account',
            project_id: process.env.FIREBASE_PROJECT_ID,
            private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
            private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
            client_email: process.env.FIREBASE_CLIENT_EMAIL,
            client_id: process.env.FIREBASE_CLIENT_ID,
            auth_uri: 'https://accounts.google.com/o/oauth2/auth',
            token_uri: 'https://oauth2.googleapis.com/token',
            auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
            client_x509_cert_url: process.env.FIREBASE_CLIENT_CERT_URL
        };
    }

    return null;
}

function configureWebPush() {
    const publicKey = process.env.VAPID_PUBLIC_KEY;
    const privateKey = process.env.VAPID_PRIVATE_KEY;
    const email = process.env.VAPID_EMAIL || 'mailto:admin@educhat.app';

    if (!publicKey || !privateKey) {
        console.warn('VAPID keys are not configured. Web push sending will be disabled.');
        return false;
    }

    webpush.setVapidDetails(email, publicKey, privateKey);
    return true;
}

function getMailer() {
    if (!nodemailer) return null;
    if (process.env.SMTP_URL) {
        return nodemailer.createTransport(process.env.SMTP_URL);
    }
    if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
        return null;
    }
    return nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT || 587),
        secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true' || Number(process.env.SMTP_PORT) === 465,
        auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS
        }
    });
}

async function sendOtpEmail({ to, code, purpose }) {
    const mailer = getMailer();
    if (!mailer) return { sent: false, reason: 'SMTP_NOT_CONFIGURED' };

    const label = purpose === 'privacy-reset' ? 'private chats' : 'login';
    await mailer.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to,
        subject: `EduChat ${label} OTP`,
        text: `Your EduChat ${label} OTP is ${code}. It expires in 10 minutes.`,
        html: `<p>Your EduChat ${label} OTP is <strong>${code}</strong>.</p><p>It expires in 10 minutes.</p>`
    });
    return { sent: true };
}

function getOtpKey({ uid, email, purpose }) {
    return `${purpose || 'login'}:${uid || email}`;
}

function generateOTP() {
    return crypto.randomInt(100000, 1000000).toString();
}

const pushEnabled = configureWebPush();
const serviceAccount = loadServiceAccount();

let db = null;
try {
    if (serviceAccount) {
        admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    } else {
        admin.initializeApp();
    }
    db = admin.firestore();
    console.log('Firebase Admin initialized');
} catch (err) {
    console.error('Firebase Admin init error:', err.message);
}

app.post('/send-push', async (req, res) => {
    const { uid, title, body, icon, chatId, isGroup, type } = req.body;

    if (!uid || !db) {
        return res.status(400).json({ error: 'Missing uid or db not ready' });
    }
    if (!pushEnabled) {
        return res.status(503).json({ error: 'Web push is not configured' });
    }

    try {
        const subsSnap = await db
            .collection('users')
            .doc(uid)
            .collection('pushSubscriptions')
            .get();

        if (subsSnap.empty) {
            return res.json({ sent: 0, message: 'No subscriptions for this user' });
        }

        const payload = JSON.stringify({ title, body, icon, chatId, isGroup, type });
        const options = { TTL: 86400 };

        let sent = 0;
        await Promise.allSettled(
            subsSnap.docs.map(async (subDoc) => {
                const sub = subDoc.data();
                try {
                    await webpush.sendNotification(
                        { endpoint: sub.endpoint, keys: sub.keys },
                        payload,
                        options
                    );
                    sent++;
                } catch (err) {
                    if (err.statusCode === 410 || err.statusCode === 404) {
                        await subDoc.ref.delete();
                    }
                }
            })
        );

        res.json({ sent, total: subsSnap.size });
    } catch (err) {
        console.error('/send-push error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/send-otp', async (req, res) => {
    const { uid, email, purpose = 'login' } = req.body || {};
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ ok: false, error: 'Valid email is required' });
    }

    // Rate limiting — block abuse before touching SMTP quota
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    if (!checkOtpRateLimit(ip, email)) {
        return res.status(429).json({ ok: false, error: 'Too many OTP requests. Please wait before trying again.' });
    }

    const code = generateOTP();
    const expiresAt = Date.now() + 10 * 60 * 1000;
    const key = getOtpKey({ uid, email, purpose });
    await otpStoreSet(key, { code, expiresAt, email, purpose, attempts: 0 }, db);

    try {
        const delivery = await sendOtpEmail({ to: email, code, purpose });
        console.log(`[OTP] ${purpose} for ${email}: ${delivery.sent ? 'emailed' : delivery.reason}`);
        if (!delivery.sent) {
            await otpStoreDelete(key, db);
            return res.status(503).json({ ok: false, error: 'SMTP is not configured' });
        }
        res.json({ ok: true, sent: true, message: 'OTP sent to email' });
    } catch (err) {
        await otpStoreDelete(key, db);
        console.error('/send-otp error:', err);
        res.status(500).json({ ok: false, error: 'Email failed' });
    }
});

app.post('/verify-otp', async (req, res) => {
    const { uid, email, purpose = 'login', code } = req.body || {};
    const key = getOtpKey({ uid, email, purpose });
    const entry = await otpStoreGet(key, db);

    if (!entry) {
        return res.status(400).json({ ok: false, error: 'OTP not found or expired' });
    }
    if (Date.now() > entry.expiresAt) {
        await otpStoreDelete(key, db);
        return res.status(400).json({ ok: false, error: 'OTP expired' });
    }
    entry.attempts = (entry.attempts || 0) + 1;
    if (entry.attempts > 5) {
        await otpStoreDelete(key, db);
        return res.status(429).json({ ok: false, error: 'Too many attempts' });
    }
    // Update attempt count in store
    await otpStoreSet(key, entry, db);

    if (entry.code !== String(code || '').trim()) {
        return res.status(400).json({ ok: false, error: 'Invalid OTP' });
    }

    await otpStoreDelete(key, db);
    res.json({ ok: true });
});

app.get('/health', (_, res) => res.json({ status: 'ok' }));

// ── VAPID public key endpoint — clients read this instead of hardcoding ──
app.get('/vapid-public-key', (req, res) => {
    const key = process.env.VAPID_PUBLIC_KEY;
    if (!key) return res.status(503).json({ error: 'VAPID not configured' });
    res.json({ key });
});

// ── Firebase client config — safe to expose, served from env vars ──
app.get('/firebase-config', (req, res) => {
    const cfg = {
        apiKey:            process.env.FIREBASE_API_KEY,
        authDomain:        process.env.FIREBASE_AUTH_DOMAIN,
        projectId:         process.env.FIREBASE_PROJECT_ID,
        storageBucket:     process.env.FIREBASE_STORAGE_BUCKET,
        messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
        appId:             process.env.FIREBASE_APP_ID,
        measurementId:     process.env.FIREBASE_MEASUREMENT_ID,
    };
    if (!cfg.apiKey || !cfg.projectId) {
        return res.status(503).json({ error: 'Firebase client config not set in env' });
    }
    res.json(cfg);
});

// ── Static files — registered after API routes so dynamic endpoints win ──
app.use(express.static(path.join(__dirname)));

// ── SPA catch-all — ONLY for navigation requests, not missing assets ──
// This prevents /sw.js, /manifest.json, and module JS from returning chat.html.
app.use((req, res, next) => {
    // Only handle GET requests that look like page navigations (Accept: text/html)
    const acceptsHtml = (req.headers.accept || '').includes('text/html');
    if (req.method === 'GET' && acceptsHtml) {
        return res.sendFile(path.join(__dirname, 'chat.html'));
    }
    next();
});

// ── Final 404 for anything else (missing JS/CSS/JSON assets) ──
app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
});

app.listen(PORT, () => {
    console.log(`EduChat server running on port ${PORT}`);
});

// ============================================================
//  globals.js — Shared state, Firebase init, utility helpers
// ============================================================

// ── Firebase Initialization ──────────────────────────────────
const firebaseConfig = {
    apiKey: "AIzaSyBclTC8gK3QKi1X6Q-YCK2jT38yJ83xOcQ",
    authDomain: "chat-app-a0f95.firebaseapp.com",
    projectId: "chat-app-a0f95",
    storageBucket: "chat-app-a0f95.appspot.com",
    messagingSenderId: "754786153113",
    appId: "1:754786153113:web:7543bfb097732ad229fe08",
    measurementId: "G-JFKWR83KYJ"
};
// Expose as a single source of truth for other scripts (e.g. pushNotifications.js)
window._firebaseConfig = firebaseConfig;

console.log('Initializing Firebase...');
try {
    if (!firebase.apps.length) {
        firebase.initializeApp(firebaseConfig);
    } else {
        firebase.app();
    }
    console.log('Firebase initialized successfully');
} catch (error) {
    console.error('Firebase initialization error:', error);
}

const auth = firebase.auth();
const db   = firebase.firestore();

// ── Firestore offline persistence (serves reads from local cache — zero quota cost) ──
db.enablePersistence({ synchronizeTabs: true }).catch(err => {
    if (err.code === 'failed-precondition') {
        // Multiple tabs — persistence only in one tab (still fine)
        console.warn('Firestore persistence: multiple tabs open');
    } else if (err.code === 'unimplemented') {
        console.warn('Firestore persistence not supported in this browser');
    }
});

// ── Global App State ─────────────────────────────────────────
let currentUser     = null;
let currentUserData = null;
let chatWithUID     = null;
let groupChatID     = null;
let unreadMap       = {};
let activeTab       = 'chats';
let notificationPermissionRequested = false;
let isGroupInfoOpen = false;
let unsubscribeDirectMessages = null;
let unsubscribeGroupMessages  = null;

// Pagination state
const MSG_PAGE_SIZE       = 40;          // fewer re-fetches on initial open
let directMsgLastDoc      = null;
let directMsgAllLoaded    = false;
let directMsgLoadingOlder = false;
let groupMsgLastDoc       = null;
let groupMsgAllLoaded     = false;

// Presence — poll every 15 min instead of 5 (3× fewer reads)
let presencePollInterval = null;
const PRESENCE_POLL_MS   = 15 * 60 * 1000;

// Reply state
let replyingTo = null; // { id, text, senderName }

// Typing indicator
let typingTimeout      = null;
let unsubscribeTyping  = null;

// Pinned messages
let pinnedMessages = {};

// Voice recording
let mediaRecorder     = null;
let audioChunks       = [];
let isRecording       = false;
let recordingTimer    = null;
let recordingSeconds  = 0;

// WebRTC
let webRTCManager    = null;
let signalingManager = null;

// Friends presence
let friendsPresenceUnsubscribers = [];

// ── Last-message cache (chatId → {text, time, timeStr}) ──────
// Populated by the messages onSnapshot so loadFriendsList never
// needs an extra Firestore read per friend.
const lastMsgCache = new Map();

// ── Friends-list render deduplication ────────────────────────
// Prevents re-rendering the list when nothing changed.
let _lastFriendsRenderKey = '';
let _lastFriendsHTML      = '';

// ── Escape helpers ──────────────────────────────────────────
function escapeHTML(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function escapeAttribute(value) {
    return escapeHTML(value);
}

// ── Chat ID helper ──────────────────────────────────────────
function generateChatId(uid1, uid2) {
    return [uid1, uid2].sort().join('_');
}

function generateUsername(name) {
    return name.toLowerCase().replace(/\s/g, '') + Math.floor(Math.random() * 1000);
}

// ── Status helpers ──────────────────────────────────────────
function statusDotColor(status) {
    if (status === 'online') return '#22c55e';
    if (status === 'away')   return '#f59e0b';
    return '#9ca3af';
}

function formatStatus(status, lastSeen) {
    if (status === 'online') return '\u{1F7E2} Online';
    if (status === 'away')   return '\u{1F7E1} Away';
    if (lastSeen) {
        const date = lastSeen?.toDate ? lastSeen.toDate() : new Date(lastSeen);
        const diff = Math.floor((Date.now() - date.getTime()) / 60000);
        if (diff < 1)    return '\u26AB Just now';
        if (diff < 60)   return '\u26AB ' + diff + 'm ago';
        if (diff < 1440) return '\u26AB ' + Math.floor(diff / 60) + 'h ago';
    }
    return '\u26AB Offline';
}

function getDateLabel(date) {
    const now       = new Date();
    const today     = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    const msgDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());

    if (msgDay.getTime() === today.getTime())     return 'Today';
    if (msgDay.getTime() === yesterday.getTime()) return 'Yesterday';
    return date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

// ── Toast shorthand (used by autoBackup + loadArchivedMessages) ──
function showToast(msg, type = 'info') {
    const icons = { success: '✅', error: '❌', info: 'ℹ️', warning: '⚠️' };
    if (window.toastManager) {
        window.toastManager.show({
            icon: icons[type] || 'ℹ️',
            title: msg,
            body: '',
            type: 'message',
            duration: 3500
        });
    }
}

// ── Enhanced cache (localStorage + TTL) ─────────────────────
const enhancedCache = {
    set(key, data, ttl = 60 * 60 * 1000) {
        try {
            localStorage.setItem(key, JSON.stringify({ data, expiry: Date.now() + ttl }));
        } catch (e) { console.log('Cache set error:', e); }
    },
    get(key) {
        try {
            const item = localStorage.getItem(key);
            if (!item) return null;
            const parsed = JSON.parse(item);
            if (Date.now() > parsed.expiry) { this.remove(key); return null; }
            return parsed.data;
        } catch (e) { console.log('Cache get error:', e); return null; }
    },
    remove(key) {
        try { localStorage.removeItem(key); } catch (e) { /**/ }
    },
    cleanup() {
        Object.keys(localStorage).forEach(key => this.get(key));
    }
};

// ── getUserData (needed by multiple modules) ─────────────────
async function getUserData(uid) {
    const cacheKey = `user_${uid}`;
    const cached   = enhancedCache.get(cacheKey);
    if (cached) return cached;

    try {
        const userDoc = await db.collection('users').doc(uid).get();
        if (userDoc.exists) {
            const userData = userDoc.data();
            enhancedCache.set(cacheKey, userData, 30 * 60 * 1000);
            return userData;
        }
    } catch (error) {
        console.error('Error getting user data:', error);
    }
    return null;
}

// ── Expose globals ───────────────────────────────────────────
window.db             = db;
window.auth           = auth;
window.currentUser    = currentUser;
window.currentUserData = currentUserData;
window.enhancedCache  = enhancedCache;
window.getUserData    = getUserData;
window.escapeHTML     = escapeHTML;
window.escapeAttribute = escapeAttribute;
window.generateChatId = generateChatId;
window.showToast      = showToast;
window.formatStatus   = formatStatus;
window.getDateLabel   = getDateLabel;
window.statusDotColor = statusDotColor;
window.lastMsgCache   = lastMsgCache;

console.log('globals.js loaded');

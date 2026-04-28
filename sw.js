// ============================================================
//  EduChat Service Worker — PWA + Real Push Notifications
//
//  Notification paths:
//  A) Web Push 'push' event — server sends it (browser CLOSED) 
//  B) Main app pings SW via postMessage when tab is open
//
//  NO Firestore in SW — avoids importScripts network issues
// ============================================================

const CACHE_NAME  = 'educhat-v6';
const OFFLINE_URL = '/index.html';

const PRECACHE = [
    '/',
    '/index.html',
    '/chat.html',
    '/chat.css',
    '/login.css',
    '/login.js',
    '/call-styles.css',
    '/emojiPicker.css',
    '/emojiPicker.js',
    '/driveFileShare.js',
    '/memoryCache.js',
    '/sessionCache.js',
    '/cacheManager.js',
    '/hybridCache.js',
    '/manifest.json',
    '/icon-192.png',
    // ── Module scripts (chat.html's main app) ───────────────
    '/modules/globals.js',
    '/modules/ui.js',
    '/modules/app.js',
    '/modules/messaging.js',
    '/modules/friends.js',
    '/modules/groups.js',
    '/modules/presence.js',
    '/modules/calls.js',
    // ── Other app scripts ────────────────────────────────────
    '/pushNotifications.js',
    '/autoBackup.js',
    '/privateChats.js',
    '/profile.js',
    '/icons.js',
    '/chatInteractions.js',
    '/friendProfile.css',
    '/profile.css',
    '/signaling.js',
    '/webrtc.js',
];

// ── Install ──────────────────────────────────────────────────
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(PRECACHE))
            .then(() => self.skipWaiting())
    );
});

// ── Activate ─────────────────────────────────────────────────
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(
                keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
            ))
            .then(() => self.clients.claim())
            .then(() => {
                // Notify all open tabs that a new version is active → they auto-reload
                return self.clients.matchAll({ type: 'window', includeUncontrolled: true });
            })
            .then(clients => {
                clients.forEach(client => client.postMessage({ type: 'SW_UPDATED' }));
            })
    );
});

// ── Fetch (cache-first for shell) ────────────────────────────
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    if (
        event.request.method !== 'GET' ||
        url.hostname.includes('firestore.googleapis.com') ||
        url.hostname.includes('firebase') ||
        url.hostname.includes('googleapis.com') ||
        url.hostname.includes('gstatic.com') ||
        url.hostname.includes('accounts.google.com')
    ) { return; }

    event.respondWith(
        caches.match(event.request).then(cached => {
            if (cached) return cached;
            return fetch(event.request)
                .then(response => {
                    if (response && response.status === 200 && response.type === 'basic') {
                        const clone = response.clone();
                        caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
                    }
                    return response;
                })
                .catch(() => {
                    if (event.request.destination === 'document') return caches.match(OFFLINE_URL);
                });
        })
    );
});

// ============================================================
//  PATH A — Web Push event (browser fully CLOSED)
//  Server calls Web Push API → OS wakes SW → shows notification
// ============================================================
self.addEventListener('push', (event) => {
    let data = {};
    try {
        data = event.data ? event.data.json() : {};
    } catch (e) {
        data = { title: 'EduChat', body: event.data ? event.data.text() : 'New message' };
    }
    console.log('[SW] Push event received:', data);
    event.waitUntil(showPushNotification(data));
});

// ============================================================
//  PATH B — Message from main app (tab open/minimised)
//  pushNotifications.js posts SHOW_NOTIFICATION to SW
// ============================================================
self.addEventListener('message', (event) => {
    const { type } = event.data || {};
    if (type === 'SHOW_NOTIFICATION') {
        showPushNotification(event.data);
    }
    // ignore SET_USER / CLEAR_USER — no longer needed
});

// ============================================================
//  Show the system notification
// ============================================================
async function showPushNotification({ title, body, icon, chatId, isGroup, type }) {
    const clients    = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const foreground = clients.some(c => c.visibilityState === 'visible');
    const isCall     = type === 'call_video' || type === 'call_voice';
    // FIX: Call notifications ని app foreground లో ఉన్నా show చేయాలి — in-app ring UI ఉన్నా OS notification కూడా కావాలి
    // Regular messages: app visible అయితే in-app toast చాలు
    if (foreground && !isCall) return;

    // FIX: Call notifications కి special urgent style

    await self.registration.showNotification(title || 'EduChat', {
        body:     body  || '',
        icon:     icon  || '/icon-192.png',
        badge:    '/icon-192.png',
        vibrate:  isCall ? [500, 200, 500, 200, 500] : [200, 100, 200],
        tag:      isCall ? 'educhat-call' : (chatId || 'educhat'),
        renotify: true,
        requireInteraction: isCall, // FIX: call notification auto close కాదు — user dismiss చేయాలి
        data:     { chatId, isGroup, type },
        actions:  isCall
            ? [{ action: 'open', title: '📲 Answer' }, { action: 'close', title: '❌ Decline' }]
            : [{ action: 'open', title: '💬 Open' }, { action: 'close', title: '✕' }]
    });
}

// ── Notification clicked ─────────────────────────────────────
self.addEventListener('notificationclick', (event) => {
    event.notification.close();

    const { chatId, isGroup, type } = event.notification.data || {};
    const isCall = type === 'call_video' || type === 'call_voice';

    // Decline button
    if (event.action === 'close') {
        if (isCall && chatId) {
            // FIX: SW లో Firebase access లేదు కాబట్టి app background లో open చేసి decline చేయాలి
            event.waitUntil(
                self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
                    const existing = clients.find(c =>
                        c.url.includes('/chat.html') || c.url.includes(self.location.origin)
                    );
                    if (existing) {
                        existing.postMessage({ type: 'DECLINE_CALL', callId: chatId, callType: type });
                    } else {
                        self.clients.openWindow(`/chat.html?declineCall=${chatId}&callType=${type}`);
                    }
                })
            );
        }
        return;
    }

    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
            const existing = clients.find(c =>
                c.url.includes('/chat.html') || c.url.includes(self.location.origin)
            );
            if (existing) {
                existing.focus();
                // FIX: type కూడా pass చేయాలి — app call ring చేయాలి
                existing.postMessage({ type: 'NOTIFICATION_CLICKED', chatId, isGroup, callType: type });
            } else {
                // Browser closed గా ఉంది — app open చేసి, load అయిన తర్వాత call handle చేయాలి
                // callType ని URL లో pass చేద్దాం
                const url = isCall
                    ? `/chat.html?callType=${type}&chatId=${chatId || ''}`
                    : '/chat.html';
                self.clients.openWindow(url);
            }
        })
    );
});

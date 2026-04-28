// ============================================================
//  autoBackup.js — Auto Backup & Restore
//  7 days కి ఒకసారి messages Drive కి backup చేసి Firestore నుండి delete చేస్తుంది
//
//  BUG FIXES:
//  1. Permission maati maatiki vastondi — fixed by caching the
//     access token in sessionStorage with expiry. Google OAuth2
//     tokens last ~1 hour; we store it so the same session never
//     triggers the consent popup twice.
//  2. showToast / getUserData were undefined — now resolved via
//     window.showToast and window.getUserData (defined in globals.js
//     and ui.js which load before this file).
// ============================================================

const BACKUP_INTERVAL_DAYS = 7;
const BACKUP_FOLDER        = 'EduChat Files';
const BACKUP_SUBFOLDER     = 'Backups';
const BACKUP_SCOPE         = 'https://www.googleapis.com/auth/drive.file';

// Token cache key in sessionStorage
const BACKUP_TOKEN_CACHE_KEY    = 'backupAccessToken';
const BACKUP_TOKEN_EXPIRY_KEY   = 'backupAccessTokenExpiry';
// Google tokens expire in 3600s; we treat 55 min as safe window
const BACKUP_TOKEN_TTL_MS       = 55 * 60 * 1000;

let backupTokenClient    = null;
let backupPendingResolve = null;

// ── In-memory token (primary) with sessionStorage fallback ──
function getCachedToken() {
    try {
        const token  = sessionStorage.getItem(BACKUP_TOKEN_CACHE_KEY);
        const expiry = parseInt(sessionStorage.getItem(BACKUP_TOKEN_EXPIRY_KEY) || '0', 10);
        if (token && Date.now() < expiry) return token;
    } catch (e) { /* private browsing may block sessionStorage */ }
    return null;
}

function setCachedToken(token) {
    try {
        sessionStorage.setItem(BACKUP_TOKEN_CACHE_KEY, token);
        sessionStorage.setItem(BACKUP_TOKEN_EXPIRY_KEY, String(Date.now() + BACKUP_TOKEN_TTL_MS));
    } catch (e) { /* ignore */ }
}

function clearCachedToken() {
    try {
        sessionStorage.removeItem(BACKUP_TOKEN_CACHE_KEY);
        sessionStorage.removeItem(BACKUP_TOKEN_EXPIRY_KEY);
    } catch (e) { /* ignore */ }
}

// ── Drive auth ───────────────────────────────────────────────
function initBackupAuth() {
    if (!window.google?.accounts?.oauth2) return;
    if (backupTokenClient) return;

    const clientId = window.DRIVE_CLIENT_ID || (window.driveShare && window.driveShare._clientId);
    if (!clientId) {
        // driveFileShare.js hasn't loaded yet; autoBackup will retry via getBackupToken()
        console.warn('autoBackup: DRIVE_CLIENT_ID not available yet, skipping initBackupAuth');
        return;
    }

    backupTokenClient = google.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: BACKUP_SCOPE,
        callback: (resp) => {
            if (resp.error) {
                console.error('Backup auth error:', resp.error);
                clearCachedToken();
                if (backupPendingResolve) { backupPendingResolve(null); backupPendingResolve = null; }
                return;
            }
            // FIX: cache token so we don't prompt again this session
            setCachedToken(resp.access_token);
            if (backupPendingResolve) { backupPendingResolve(resp.access_token); backupPendingResolve = null; }
        },
        error_callback: (err) => {
            console.error('Backup token error:', err);
            clearCachedToken();
            if (backupPendingResolve) { backupPendingResolve(null); backupPendingResolve = null; }
        }
    });
}

async function getBackupToken(allowPrompt = false) {
    // 1. Return cached valid token — no popup needed
    const cached = getCachedToken();
    if (cached) return cached;

    // 2. Initialize token client if needed
    if (!backupTokenClient) initBackupAuth();
    if (!backupTokenClient) {
        console.warn('autoBackup: cannot get token — Drive client not initialized (no client_id)');
        return null;
    }

    // 3. Only show OAuth popup when triggered by a real user gesture (allowPrompt=true).
    //    Automatic background backups must not open a popup — browsers block it and it
    //    also triggers Cross-Origin-Opener-Policy errors.
    if (!allowPrompt) {
        console.log('autoBackup: no cached token and not a user-initiated backup — skipping.');
        return null;
    }

    // 4. User-initiated: show consent popup if truly needed
    return new Promise((resolve) => {
        backupPendingResolve = resolve;
        backupTokenClient.requestAccessToken({ prompt: '' });
    });
}

// ── Drive folder helpers ─────────────────────────────────────
async function getBackupFolderId(token) {
    const parentSearch = await fetch(
        `https://www.googleapis.com/drive/v3/files?q=name='${BACKUP_FOLDER}' and mimeType='application/vnd.google-apps.folder' and trashed=false&fields=files(id)`,
        { headers: { Authorization: `Bearer ${token}` } }
    ).then(r => r.json());

    let parentId;
    if (parentSearch.files?.length) {
        parentId = parentSearch.files[0].id;
    } else {
        const cr = await fetch('https://www.googleapis.com/drive/v3/files', {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: BACKUP_FOLDER, mimeType: 'application/vnd.google-apps.folder' })
        }).then(r => r.json());
        parentId = cr.id;
    }

    const subSearch = await fetch(
        `https://www.googleapis.com/drive/v3/files?q=name='${BACKUP_SUBFOLDER}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false&fields=files(id)`,
        { headers: { Authorization: `Bearer ${token}` } }
    ).then(r => r.json());

    if (subSearch.files?.length) return subSearch.files[0].id;

    const cr = await fetch('https://www.googleapis.com/drive/v3/files', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: BACKUP_SUBFOLDER, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] })
    }).then(r => r.json());
    return cr.id;
}

async function uploadBackupToDrive(token, folderId, fileName, jsonData) {
    const blob = new Blob([JSON.stringify(jsonData, null, 2)], { type: 'application/json' });
    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify({ name: fileName, parents: [folderId] })], { type: 'application/json' }));
    form.append('file', blob);

    const res = await fetch(
        'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name',
        { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form }
    ).then(r => r.json());

    return res.id;
}

// ── Helper: retry fetch with token refresh on 401 ───────────
async function fetchWithTokenRefresh(url, token) {
    let res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });

    if (res.status === 401) {
        // Token expired mid-session — clear cache and get fresh token
        clearCachedToken();
        const newToken = await getBackupToken();
        if (!newToken) return null;
        res = await fetch(url, { headers: { Authorization: `Bearer ${newToken}` } });
    }

    return res.ok ? res : null;
}

// ── Main backup function ─────────────────────────────────────
async function runAutoBackup() {
    if (!currentUser) return;

    // FIX: use window.getUserData so it works regardless of load order
    const _getUserData = window.getUserData || (async (uid) => null);
    const userData     = currentUserData || await _getUserData(currentUser.uid);
    if (!userData) return;

    const lastBackup    = userData.lastBackup?.toDate ? userData.lastBackup.toDate() : (userData.lastBackup ? new Date(userData.lastBackup) : null);
    const daysSinceLast = lastBackup ? (Date.now() - lastBackup.getTime()) / (1000 * 60 * 60 * 24) : 999;

    if (daysSinceLast < BACKUP_INTERVAL_DAYS) {
        console.log(`Backup: ${Math.round(daysSinceLast)} days since last backup, skipping.`);
        return;
    }

    console.log('Starting auto backup...');
    // FIX: use window.showToast which is guaranteed to be defined by ui.js
    window.showToast('📦 Backing up old messages to Drive...', 'info');

    const token = await getBackupToken();
    if (!token) {
        // Silent skip — user will see the toast only when backup actually runs
        console.warn('Backup skipped: no Drive token (will retry on next session)');
        return;
    }

    try {
        const folderId   = await getBackupFolderId(token);
        const cutoffDate = new Date(Date.now() - BACKUP_INTERVAL_DAYS * 24 * 60 * 60 * 1000);
        const uid        = currentUser.uid;
        let totalBacked  = 0;

        // ── Direct messages ─────────────────────────────────
        const dmSnap = await db.collection('messages')
            .where('participants', 'array-contains', uid)
            .where('time', '<', cutoffDate)
            .get();

        if (!dmSnap.empty) {
            const byChat = {};
            dmSnap.forEach(doc => {
                const d = doc.data();
                if (!byChat[d.chatId]) byChat[d.chatId] = [];
                byChat[d.chatId].push({ id: doc.id, ...d });
            });

            for (const [chatId, msgs] of Object.entries(byChat)) {
                const otherUid  = msgs[0]?.participants?.find(p => p !== uid) || 'unknown';
                const otherUser = await _getUserData(otherUid).catch(() => null);
                const otherName = otherUser?.name || otherUid;
                const fileName  = `dm_${otherName}_${chatId}_${Date.now()}.json`;

                const fileId = await uploadBackupToDrive(token, folderId, fileName, {
                    type: 'direct', chatId,
                    participants: [uid, otherUid],
                    exportedAt:   new Date().toISOString(),
                    messages:     msgs.map(m => ({ ...m, time: m.time?.toDate ? m.time.toDate().toISOString() : m.time }))
                });

                await db.collection('messageArchives').add({
                    type: 'direct', chatId, owner: uid, driveFileId: fileId, fileName,
                    msgCount: msgs.length,
                    dateRange: {
                        from: msgs[msgs.length - 1]?.time?.toDate?.() || cutoffDate,
                        to:   msgs[0]?.time?.toDate?.() || cutoffDate
                    },
                    createdAt: new Date()
                });

                const batch = db.batch();
                dmSnap.docs.filter(doc => doc.data().chatId === chatId).forEach(doc => batch.delete(doc.ref));
                await batch.commit();

                totalBacked += msgs.length;
            }
        }

        // ── Group messages ───────────────────────────────────
        const gmSnap = await db.collection('groupMessages')
            .where('sender', '==', uid)
            .where('time', '<', cutoffDate)
            .get();

        if (!gmSnap.empty) {
            const byGroup = {};
            gmSnap.forEach(doc => {
                const d = doc.data();
                if (!byGroup[d.groupId]) byGroup[d.groupId] = [];
                byGroup[d.groupId].push({ id: doc.id, ...d });
            });

            for (const [groupId, msgs] of Object.entries(byGroup)) {
                const groupDoc  = await db.collection('groups').doc(groupId).get();
                const groupName = groupDoc.data()?.name || groupId;
                const fileName  = `group_${groupName}_${groupId}_${Date.now()}.json`;

                const fileId = await uploadBackupToDrive(token, folderId, fileName, {
                    type: 'group', groupId, groupName,
                    exportedAt: new Date().toISOString(),
                    messages:   msgs.map(m => ({ ...m, time: m.time?.toDate ? m.time.toDate().toISOString() : m.time }))
                });

                await db.collection('messageArchives').add({
                    type: 'group', groupId, groupName, owner: uid,
                    driveFileId: fileId, fileName, msgCount: msgs.length, createdAt: new Date()
                });

                const batch = db.batch();
                gmSnap.docs.filter(doc => doc.data().groupId === groupId).forEach(doc => batch.delete(doc.ref));
                await batch.commit();

                totalBacked += msgs.length;
            }
        }

        await db.collection('users').doc(uid).update({ lastBackup: new Date() });
        if (currentUserData) currentUserData.lastBackup = new Date();

        if (totalBacked > 0) {
            window.showToast(`✅ ${totalBacked} messages backed up to Drive!`, 'success');
        } else {
            console.log('Backup: no old messages to backup');
        }

    } catch (err) {
        console.error('Auto backup error:', err);
        window.showToast('Backup failed: ' + err.message, 'error');
    }
}

// ── Fetch archived messages ───────────────────────────────────
async function fetchArchivedMessages(chatId, type = 'direct') {
    if (!currentUser) return [];

    // User clicked 'Load archived messages' — allow OAuth popup
    const token = await getBackupToken(true);
    if (!token) {
        window.showToast('Drive access needed to load old messages', 'error');
        return [];
    }

    try {
        const field = type === 'group' ? 'groupId' : 'chatId';
        const snap  = await db.collection('messageArchives')
            .where('owner', '==', currentUser.uid)
            .where(field, '==', chatId)
            .orderBy('createdAt', 'desc')
            .get();

        if (snap.empty) return [];

        const allMessages = [];

        for (const doc of snap.docs) {
            const { driveFileId } = doc.data();
            try {
                const res = await fetchWithTokenRefresh(
                    `https://www.googleapis.com/drive/v3/files/${driveFileId}?alt=media`,
                    token
                );
                if (res) {
                    const data = await res.json();
                    allMessages.push(...(data.messages || []));
                }
            } catch (e) {
                console.error('Error fetching archive file:', e);
            }
        }

        allMessages.sort((a, b) => new Date(a.time) - new Date(b.time));
        return allMessages;

    } catch (err) {
        console.error('fetchArchivedMessages error:', err);
        return [];
    }
}

// ── Check archives exist ──────────────────────────────────────
async function hasArchives(chatId, type = 'direct') {
    if (!currentUser) return false;
    const field = type === 'group' ? 'groupId' : 'chatId';
    try {
        const snap = await db.collection('messageArchives')
            .where('owner', '==', currentUser.uid)
            .where(field, '==', chatId)
            .limit(1)
            .get();
        return !snap.empty;
    } catch (e) {
        return false;
    }
}

// ── Expose ───────────────────────────────────────────────────
window.autoBackup = {
    run:            runAutoBackup,
    fetchArchived:  fetchArchivedMessages,
    hasArchives,
    // Call this from a button click to connect Drive manually
    requestToken:   () => getBackupToken(true),
};

// ============================================================
//  friendProfile.js — Friend Profile Viewer with Media Tab
// ============================================================

const friendProfileViewer = (() => {
    let _overlay    = null;
    let _currentUID = null;
    let _activeTab  = 'about';
    let _mediaCache = new Map(); // chatId → media[]

    // ── Open ─────────────────────────────────────────────────
    async function open(uid) {
        if (!uid) return;
        if (_overlay) close();
        _currentUID = uid;
        _activeTab  = 'about';

        _overlay = document.createElement('div');
        _overlay.className = 'fp-overlay';
        _overlay.innerHTML = _skeletonHTML();
        document.body.appendChild(_overlay);
        _overlay.addEventListener('click', (e) => { if (e.target === _overlay) close(); });

        try {
            const data = await window.getUserData(uid);
            if (!data) { close(); window.showToast?.('Could not load profile', 'error'); return; }
            _render(uid, data);
        } catch (e) {
            console.error('friendProfile open error:', e);
            close();
        }
    }

    function close() {
        if (_overlay) { _overlay.remove(); _overlay = null; _currentUID = null; }
    }

    // ── Render ───────────────────────────────────────────────
    function _render(uid, data) {
        if (!_overlay) return;
        const I = window.Icons;

        const isBlocked = window.privateChatsManager?.isBlocked(uid);
        const isFriend  = (window.currentUserData?.friends || []).includes(uid);
        const statusTxt = window.formatStatus?.(data.status, data.lastSeen) || data.status || 'Offline';
        const dotColor  = window.statusDotColor?.(data.status) || '#9ca3af';
        const photoURL  = data.photoURL || '';
        const initials  = (data.name?.charAt(0)?.toUpperCase()) || '?';
        const joinDate  = data.createdAt
            ? new Date(data.createdAt?.toDate ? data.createdAt.toDate() : data.createdAt)
                .toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })
            : null;

        _overlay.innerHTML = `
            <div class="fp-modal" role="dialog" aria-modal="true">
                <!-- Banner -->
                <div class="fp-banner"></div>

                <!-- Close -->
                <button class="fp-close-btn" id="fpCloseBtn" aria-label="Close">
                    ${I ? I.get('close', 14) : '✕'}
                </button>

                <!-- Avatar -->
                <div class="fp-avatar-wrap">
                    ${photoURL
                        ? `<img class="fp-avatar-img" src="${window.escapeAttribute(photoURL)}"
                               alt="${window.escapeHTML(initials)}"
                               onerror="this.style.display='none';this.nextElementSibling.style.display='flex';">
                           <span class="fp-avatar-fallback" style="display:none;">${window.escapeHTML(initials)}</span>`
                        : `<span class="fp-avatar-fallback">${window.escapeHTML(initials)}</span>`
                    }
                    <span class="fp-status-dot" style="background:${dotColor};" title="${window.escapeHTML(statusTxt)}"></span>
                </div>

                <!-- Name / status above tabs -->
                <div class="fp-header-info">
                    <h2 class="fp-name">${window.escapeHTML(data.name || 'Unknown')}</h2>
                    <p class="fp-username">@${window.escapeHTML(data.username || '')}</p>
                    <p class="fp-status-text">${window.escapeHTML(statusTxt)}</p>
                </div>

                <!-- Tabs -->
                <div class="fp-tabs">
                    <button class="fp-tab active" data-tab="about">
                        ${I ? I.get('user', 15) : ''} About
                    </button>
                    <button class="fp-tab" data-tab="media">
                        ${I ? I.get('image', 15) : ''} Media
                    </button>
                </div>

                <!-- Tab: About -->
                <div class="fp-tab-panel fp-panel-about" id="fpPanelAbout">
                    ${data.bio ? `
                    <div class="fp-section">
                        <span class="fp-section-icon">${I ? I.get('pen', 16) : ''}</span>
                        <p class="fp-bio">${window.escapeHTML(data.bio)}</p>
                    </div>` : ''}

                    ${data.email ? `
                    <div class="fp-section fp-email-row">
                        <span class="fp-section-icon">${I ? I.get('mail', 16) : ''}</span>
                        <p class="fp-email">${window.escapeHTML(data.email)}</p>
                    </div>` : ''}

                    ${joinDate ? `
                    <div class="fp-section">
                        <span class="fp-section-icon">${I ? I.get('info', 16) : ''}</span>
                        <p class="fp-joined">Joined ${joinDate}</p>
                    </div>` : ''}

                    <!-- Action buttons -->
                    <div class="fp-actions">
                        ${isFriend ? `
                        <button class="fp-btn fp-btn-primary" id="fpMsgBtn">
                            ${I ? I.get('chat', 15) : ''} Message
                        </button>` : `
                        <button class="fp-btn fp-btn-primary" id="fpAddBtn">
                            ${I ? I.get('addUser', 15) : ''} Add Friend
                        </button>`}

                        ${isBlocked ? `
                        <button class="fp-btn fp-btn-secondary" id="fpUnblockBtn">
                            ${I ? I.get('check2', 15) : ''} Unblock
                        </button>` : `
                        <button class="fp-btn fp-btn-danger" id="fpBlockBtn">
                            ${I ? I.get('block', 15) : ''} Block
                        </button>`}
                    </div>
                </div>

                <!-- Tab: Media -->
                <div class="fp-tab-panel fp-panel-media" id="fpPanelMedia" style="display:none;">
                    <div class="fp-media-grid" id="fpMediaGrid">
                        <div class="fp-media-loading">
                            <div class="fp-media-spinner"></div>
                        </div>
                    </div>
                </div>
            </div>
        `;

        // ── Tab switching ─────────────────────────────────────
        _overlay.querySelectorAll('.fp-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                _overlay.querySelectorAll('.fp-tab').forEach(t => t.classList.remove('active'));
                tab.classList.add('active');
                const name = tab.dataset.tab;
                _overlay.querySelectorAll('.fp-tab-panel').forEach(p => p.style.display = 'none');
                document.getElementById(`fpPanel${name.charAt(0).toUpperCase() + name.slice(1)}`).style.display = '';
                if (name === 'media') _loadMedia(uid);
            });
        });

        // ── Bind action buttons ──────────────────────────────
        document.getElementById('fpCloseBtn').onclick = close;

        const msgBtn     = document.getElementById('fpMsgBtn');
        const addBtn     = document.getElementById('fpAddBtn');
        const blockBtn   = document.getElementById('fpBlockBtn');
        const unblockBtn = document.getElementById('fpUnblockBtn');

        if (msgBtn) msgBtn.onclick = () => { close(); window.openChat?.(uid); };

        if (addBtn) {
            addBtn.onclick = async () => {
                addBtn.disabled = true;
                addBtn.innerHTML = (I ? I.get('check2', 15) : '') + ' Sent';
                await window.sendFriendRequest?.(uid);
            };
        }

        if (blockBtn) {
            blockBtn.onclick = async () => {
                const confirmed = await window.modalManager?.showModal(
                    'Block Contact',
                    `Block ${data.name || 'User'}? They will be hidden from your chats.`,
                    'warning', 'Block', 'Cancel'
                );
                if (confirmed) {
                    window.privateChatsManager?.blockContact(uid, data.name || 'User');
                    close();
                    window.loadFriendsList?.();
                    window.loadAllFriends?.();
                }
            };
        }

        if (unblockBtn) {
            unblockBtn.onclick = () => { window.privateChatsManager?.unblockContact(uid); open(uid); };
        }
    }

    // ── Load Media ───────────────────────────────────────────
    async function _loadMedia(friendUID) {
        const grid = document.getElementById('fpMediaGrid');
        if (!grid) return;

        const me     = window.currentUser?.uid;
        const chatId = window.generateChatId?.(me, friendUID);
        if (!chatId || !window.db) { _renderNoMedia(grid); return; }

        // Use cache if already loaded
        if (_mediaCache.has(chatId)) {
            _renderMediaGrid(grid, _mediaCache.get(chatId), friendUID);
            return;
        }

        grid.innerHTML = '<div class="fp-media-loading"><div class="fp-media-spinner"></div></div>';

        try {
            // Fetch messages that are images, files, or voice
            const snap = await window.db.collection('messages')
                .where('chatId', '==', chatId)
                .where('type', 'in', ['file', 'voice', 'image'])
                .orderBy('time', 'desc')
                .limit(60)
                .get();

            // Also fetch regular messages that have image URLs
            const imgSnap = await window.db.collection('messages')
                .where('chatId', '==', chatId)
                .where('hasImage', '==', true)
                .orderBy('time', 'desc')
                .limit(30)
                .get();

            const seen  = new Set();
            const items = [];

            const process = (doc) => {
                if (seen.has(doc.id)) return;
                seen.add(doc.id);
                const d = doc.data();
                const t = d.time?.toDate ? d.time.toDate() : new Date(d.time || 0);
                items.push({ ...d, id: doc.id, _date: t });
            };

            snap.forEach(process);
            imgSnap.forEach(process);

            // Sort newest first
            items.sort((a, b) => b._date - a._date);

            _mediaCache.set(chatId, items);
            _renderMediaGrid(grid, items, friendUID);
        } catch (e) {
            console.error('Media load error:', e);
            // Fallback: try without 'in' operator (older Firestore)
            try {
                const snap = await window.db.collection('messages')
                    .where('chatId', '==', chatId)
                    .orderBy('time', 'desc')
                    .limit(200)
                    .get();

                const items = [];
                snap.forEach(doc => {
                    const d = doc.data();
                    if (d.type === 'file' || d.type === 'voice' || d.type === 'image' ||
                        d.fileURL || d.imageURL || d.voiceURL || d.driveFileUrl) {
                        const t = d.time?.toDate ? d.time.toDate() : new Date(d.time || 0);
                        items.push({ ...d, id: doc.id, _date: t });
                    }
                });

                _mediaCache.set(chatId, items);
                _renderMediaGrid(grid, items, friendUID);
            } catch (e2) {
                console.error('Media fallback error:', e2);
                _renderNoMedia(grid);
            }
        }
    }

    // ── Render Media Grid ─────────────────────────────────────
    function _renderMediaGrid(grid, items, friendUID) {
        const I = window.Icons;

        if (!items || items.length === 0) {
            _renderNoMedia(grid);
            return;
        }

        // Separate into images, files, voice
        const images = [];
        const files  = [];
        const voices = [];

        items.forEach(item => {
            const url = item.driveFileUrl || item.fileURL || item.imageURL || item.voiceURL || item.fileData;
            if (!url) return;

            if (item.type === 'voice' || item.voiceURL) {
                voices.push({ ...item, _url: url });
            } else if (
                item.type === 'image' ||
                item.imageURL ||
                (item.fileName && /\.(jpg|jpeg|png|gif|webp|heic|svg)$/i.test(item.fileName)) ||
                (item.mimeType && item.mimeType.startsWith('image/'))
            ) {
                images.push({ ...item, _url: url });
            } else {
                files.push({ ...item, _url: url });
            }
        });

        let html = '';

        // ── Images section ────────────────────────────────────
        if (images.length > 0) {
            html += `<div class="fp-media-section-label">
                ${I ? I.get('image', 14) : ''} Photos (${images.length})
            </div>`;
            html += '<div class="fp-img-grid">';
            images.forEach(item => {
                const dateStr = item._date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
                html += `
                    <a class="fp-img-thumb" href="${window.escapeAttribute(item._url)}"
                       target="_blank" rel="noopener" title="${window.escapeHTML(item.fileName || dateStr)}">
                        <img src="${window.escapeAttribute(item._url)}"
                             alt="${window.escapeHTML(item.fileName || 'Image')}"
                             loading="lazy"
                             onerror="this.parentElement.classList.add('fp-img-broken');this.parentElement.innerHTML='${(I ? I.get('image', 24) : '').replace(/'/g, "\\'")}'"
                        >
                        <span class="fp-img-overlay">${I ? I.get('image', 16) : ''}</span>
                    </a>`;
            });
            html += '</div>';
        }

        // ── Files section ─────────────────────────────────────
        if (files.length > 0) {
            html += `<div class="fp-media-section-label">
                ${I ? I.get('paperclip', 14) : ''} Files (${files.length})
            </div>`;
            files.forEach(item => {
                const name    = item.fileName || 'File';
                const dateStr = item._date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
                const ext     = name.split('.').pop().toUpperCase().slice(0, 4);
                html += `
                    <a class="fp-file-row" href="${window.escapeAttribute(item._url)}"
                       target="_blank" rel="noopener">
                        <div class="fp-file-icon">
                            <span class="fp-file-ext">${window.escapeHTML(ext)}</span>
                        </div>
                        <div class="fp-file-info">
                            <span class="fp-file-name">${window.escapeHTML(name)}</span>
                            <span class="fp-file-date">${dateStr}</span>
                        </div>
                        <span class="fp-file-arrow">${I ? I.get('share', 14) : ''}</span>
                    </a>`;
            });
        }

        // ── Voice section ─────────────────────────────────────
        if (voices.length > 0) {
            html += `<div class="fp-media-section-label">
                ${I ? I.get('mic', 14) : ''} Voice Messages (${voices.length})
            </div>`;
            voices.forEach((item, idx) => {
                const dateStr = item._date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
                const dur     = item.duration ? `${Math.round(item.duration)}s` : '';
                html += `
                    <div class="fp-voice-row">
                        <button class="fp-voice-play" data-src="${window.escapeAttribute(item._url)}"
                                data-idx="${idx}" title="Play voice message">
                            ${I ? I.get('play', 16) : '▶'}
                        </button>
                        <div class="fp-voice-info">
                            <span class="fp-voice-label">Voice message</span>
                            <span class="fp-voice-meta">${dateStr}${dur ? ' · ' + dur : ''}</span>
                        </div>
                    </div>`;
            });
        }

        grid.innerHTML = html;

        // Wire voice play buttons
        grid.querySelectorAll('.fp-voice-play').forEach(btn => {
            btn.addEventListener('click', () => {
                const src = btn.dataset.src;
                if (!src) return;
                const existing = grid.querySelector('audio.fp-audio-player');
                if (existing) existing.remove();
                const audio = document.createElement('audio');
                audio.className = 'fp-audio-player';
                audio.controls  = true;
                audio.src       = src;
                audio.style.cssText = 'width:100%;margin:6px 0 4px;border-radius:8px;';
                btn.closest('.fp-voice-row').appendChild(audio);
                audio.play().catch(() => {});
            });
        });
    }

    function _renderNoMedia(grid) {
        const I = window.Icons;
        grid.innerHTML = `
            <div class="fp-no-media">
                <span class="fp-no-media-icon">${I ? I.get('image', 36) : ''}</span>
                <p>No media shared yet</p>
            </div>`;
    }

    // ── Skeleton ─────────────────────────────────────────────
    function _skeletonHTML() {
        return `
        <div class="fp-modal">
            <div class="fp-banner"></div>
            <button class="fp-close-btn" onclick="window.friendProfileViewer.close()">✕</button>
            <div class="fp-avatar-wrap fp-skeleton-avatar"></div>
            <div class="fp-header-info">
                <div class="fp-skeleton fp-skeleton-name"></div>
                <div class="fp-skeleton fp-skeleton-sub"></div>
            </div>
            <div class="fp-tabs">
                <button class="fp-tab active">About</button>
                <button class="fp-tab">Media</button>
            </div>
            <div class="fp-tab-panel fp-panel-about">
                <div class="fp-skeleton fp-skeleton-bio"></div>
                <div class="fp-skeleton fp-skeleton-bio" style="width:60%;margin-top:6px;"></div>
            </div>
        </div>`;
    }

    return { open, close };
})();

window.friendProfileViewer = friendProfileViewer;
console.log('friendProfile.js loaded');

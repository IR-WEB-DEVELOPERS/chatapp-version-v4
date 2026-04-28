// ============================================================
//  friendProfile.js — View any user's profile (bio, avatar, status)
//  Usage: window.friendProfileViewer.open(uid)
// ============================================================

const friendProfileViewer = (() => {
    let _overlay = null;
    let _currentUID = null;

    // ── Open ─────────────────────────────────────────────────
    async function open(uid) {
        if (!uid) return;
        if (_overlay) close();
        _currentUID = uid;

        // Show skeleton while loading
        _overlay = document.createElement('div');
        _overlay.className = 'fp-overlay';
        _overlay.innerHTML = _skeletonHTML();
        document.body.appendChild(_overlay);
        _overlay.addEventListener('click', (e) => { if (e.target === _overlay) close(); });

        try {
            const data = await window.getUserData(uid);
            if (!data) {
                close();
                if (window.showToast) window.showToast('Could not load profile', 'error');
                return;
            }
            _render(uid, data);
        } catch (e) {
            console.error('friendProfile open error:', e);
            close();
        }
    }

    function close() {
        if (_overlay) {
            _overlay.remove();
            _overlay = null;
            _currentUID = null;
        }
    }

    // ── Render ───────────────────────────────────────────────
    function _render(uid, data) {
        if (!_overlay) return;

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
            <div class="fp-modal" role="dialog" aria-modal="true" aria-label="${window.escapeHTML(data.name || 'User')} Profile">
                <!-- Banner -->
                <div class="fp-banner"></div>

                <!-- Close -->
                <button class="fp-close-btn" id="fpCloseBtn" aria-label="Close">✕</button>

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

                <!-- Body -->
                <div class="fp-body">
                    <h2 class="fp-name">${window.escapeHTML(data.name || 'Unknown')}</h2>
                    <p class="fp-username">@${window.escapeHTML(data.username || '')}</p>
                    <p class="fp-status-text">${window.escapeHTML(statusTxt)}</p>

                    ${data.bio ? `
                    <div class="fp-section">
                        <span class="fp-section-icon">📝</span>
                        <p class="fp-bio">${window.escapeHTML(data.bio)}</p>
                    </div>` : ''}

                    ${data.email ? `
                    <div class="fp-section fp-email-row">
                        <span class="fp-section-icon">✉️</span>
                        <p class="fp-email">${window.escapeHTML(data.email)}</p>
                    </div>` : ''}

                    ${joinDate ? `
                    <div class="fp-section">
                        <span class="fp-section-icon">📅</span>
                        <p class="fp-joined">Joined ${joinDate}</p>
                    </div>` : ''}

                    <!-- Action buttons -->
                    <div class="fp-actions">
                        ${isFriend ? `
                        <button class="fp-btn fp-btn-primary" id="fpMsgBtn">
                            💬 Message
                        </button>` : `
                        <button class="fp-btn fp-btn-primary" id="fpAddBtn">
                            ➕ Add Friend
                        </button>`}

                        ${isBlocked ? `
                        <button class="fp-btn fp-btn-secondary" id="fpUnblockBtn">
                            ✅ Unblock
                        </button>` : `
                        <button class="fp-btn fp-btn-danger" id="fpBlockBtn">
                            🚫 Block
                        </button>`}
                    </div>
                </div>
            </div>
        `;

        // Bind buttons
        document.getElementById('fpCloseBtn').onclick = close;

        const msgBtn     = document.getElementById('fpMsgBtn');
        const addBtn     = document.getElementById('fpAddBtn');
        const blockBtn   = document.getElementById('fpBlockBtn');
        const unblockBtn = document.getElementById('fpUnblockBtn');

        if (msgBtn) {
            msgBtn.onclick = () => {
                close();
                if (window.openChat) window.openChat(uid);
            };
        }

        if (addBtn) {
            addBtn.onclick = async () => {
                addBtn.disabled = true;
                addBtn.textContent = 'Sending...';
                await window.sendFriendRequest?.(uid);
                addBtn.textContent = '✅ Sent';
            };
        }

        if (blockBtn) {
            blockBtn.onclick = async () => {
                const name = data.name || 'User';
                const confirmed = await window.modalManager?.showModal(
                    'Block Contact',
                    `Block ${name}? They will be hidden from your chats.`,
                    'warning', 'Block', 'Cancel'
                );
                if (confirmed) {
                    window.privateChatsManager?.blockContact(uid, name);
                    close();
                    window.loadFriendsList?.();
                    window.loadAllFriends?.();
                }
            };
        }

        if (unblockBtn) {
            unblockBtn.onclick = () => {
                window.privateChatsManager?.unblockContact(uid);
                // Re-render updated
                open(uid);
            };
        }
    }

    // ── Skeleton loading HTML ────────────────────────────────
    function _skeletonHTML() {
        return `
        <div class="fp-modal">
            <div class="fp-banner"></div>
            <button class="fp-close-btn" onclick="window.friendProfileViewer.close()">✕</button>
            <div class="fp-avatar-wrap fp-skeleton-avatar"></div>
            <div class="fp-body">
                <div class="fp-skeleton fp-skeleton-name"></div>
                <div class="fp-skeleton fp-skeleton-sub"></div>
                <div class="fp-skeleton fp-skeleton-bio"></div>
                <div class="fp-skeleton fp-skeleton-bio" style="width:60%;margin-top:6px;"></div>
            </div>
        </div>`;
    }

    // ── Expose ────────────────────────────────────────────────
    return { open, close };
})();

window.friendProfileViewer = friendProfileViewer;
console.log('friendProfile.js loaded');

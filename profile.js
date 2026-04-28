// ============================================================
//  profile.js — User Profile Page: display name, bio, avatar
//               Stories/Status: 24hr disappearing WhatsApp-style
// ============================================================

const profileManager = (() => {

    // ── State ─────────────────────────────────────────────────
    let _overlay = null;
    let _newAvatarURL = null;
    let _newAvatarBase64 = null; // compressed base64 for Firestore storage

    // ── Open Profile Modal ────────────────────────────────────
    function open() {
        if (_overlay) return;

        const user = window.currentUserData || {};
        const auth = window.currentUser || {};

        _newAvatarURL = null;

        _overlay = document.createElement('div');
        _overlay.className = 'profile-modal-overlay';
        _overlay.innerHTML = `
            <div class="profile-modal" id="profileModalBox">
                <div class="profile-banner"></div>
                <button class="profile-close-btn" id="profileCloseBtn">✕</button>

                <div class="profile-avatar-section">
                    <div class="profile-avatar-ring" id="profileAvatarRing">
                        ${auth.photoURL || user.photoURL
                            ? `<img class="profile-avatar-img" id="profileAvatarImg"
                                src="${escapeAttribute(auth.photoURL || user.photoURL)}"
                                onerror="this.style.display='none';document.getElementById('profileAvatarFallback').style.display='flex';"
                               />`
                            : ''}
                        <div class="profile-avatar-fallback" id="profileAvatarFallback"
                             style="${(auth.photoURL || user.photoURL) ? 'display:none;' : ''}">
                            👤
                        </div>
                        <button class="profile-avatar-edit-btn" id="profileAvatarEditBtn" title="Change photo">📷</button>
                    </div>
                    <input type="file" id="avatarFileInput" accept="image/*" style="display:none;">
                </div>

                <div class="profile-body">
                    <div class="profile-display-name">
                        <h2 id="profileDisplayName">${escapeHTML(user.name || auth.displayName || 'User')}</h2>
                    </div>
                    <div class="profile-username-tag">@${escapeHTML(user.username || '')}</div>

                    <hr class="profile-divider">

                    <!-- Display Name -->
                    <div class="profile-field">
                        <label>Display Name</label>
                        <div class="profile-field-wrap">
                            <input type="text" class="profile-input" id="profileNameInput"
                                value="${escapeAttribute(user.name || auth.displayName || '')}"
                                maxlength="40" placeholder="Your display name">
                            <span class="profile-field-edit-icon">✏️</span>
                        </div>
                    </div>

                    <!-- Bio -->
                    <div class="profile-field">
                        <label>Bio</label>
                        <div class="profile-field-wrap">
                            <textarea class="profile-input profile-textarea" id="profileBioInput"
                                maxlength="150" placeholder="Write something about yourself...">${escapeHTML(user.bio || '')}</textarea>
                        </div>
                        <div class="profile-char-count" id="profileBioCount">
                            ${(user.bio || '').length}/150
                        </div>
                    </div>

                    <!-- Email (read-only) -->
                    <div class="profile-field">
                        <label>Email</label>
                        <div class="profile-field-wrap">
                            <input type="email" class="profile-input" readonly
                                value="${escapeAttribute(user.email || auth.email || '')}">
                        </div>
                    </div>

                    <button class="profile-save-btn" id="profileSaveBtn">Save Changes</button>

                    <!-- QR Code Section -->
                    <hr class="profile-divider" style="margin-top:20px;">
                    <div class="profile-field">
                        <label>My QR Code</label>
                        <div class="profile-qr-wrap" id="profileQrWrap">
                            <div class="profile-qr-box" id="profileQrBox"></div>
                            <div class="profile-qr-actions">
                                <button class="profile-qr-btn" id="profileQrShareBtn">Share QR</button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        `;

        document.body.appendChild(_overlay);
        _bindEvents();
    }

    function close() {
        if (_overlay) {
            _overlay.remove();
            _overlay = null;
            _newAvatarURL = null;
            _newAvatarBase64 = null;
        }
    }

    function _bindEvents() {
        // Close
        document.getElementById('profileCloseBtn').onclick = close;
        _overlay.onclick = (e) => { if (e.target === _overlay) close(); };

        // Avatar edit — trigger file picker
        document.getElementById('profileAvatarEditBtn').onclick = () => {
            document.getElementById('avatarFileInput').click();
        };

        // File selected — compress with canvas and preview
        document.getElementById('avatarFileInput').onchange = (e) => {
            const file = e.target.files[0];
            if (!file) return;

            if (!file.type.startsWith('image/')) {
                showToast('Image file మాత్రమే select చేయండి', 'error');
                return;
            }

            const reader = new FileReader();
            reader.onload = (ev) => {
                const original = new Image();
                original.onload = () => {
                    // Compress: resize to 200x200, JPEG quality 0.7
                    const canvas = document.createElement('canvas');
                    canvas.width = 200;
                    canvas.height = 200;
                    const ctx = canvas.getContext('2d');

                    // Crop square from center
                    const size = Math.min(original.width, original.height);
                    const sx = (original.width - size) / 2;
                    const sy = (original.height - size) / 2;
                    ctx.drawImage(original, sx, sy, size, size, 0, 0, 200, 200);

                    const base64 = canvas.toDataURL('image/jpeg', 0.7);
                    _newAvatarBase64 = base64;

                    // Live preview
                    let img = document.getElementById('profileAvatarImg');
                    const fallback = document.getElementById('profileAvatarFallback');
                    if (!img) {
                        img = document.createElement('img');
                        img.className = 'profile-avatar-img';
                        img.id = 'profileAvatarImg';
                        document.getElementById('profileAvatarRing').prepend(img);
                    }
                    img.src = base64;
                    img.style.display = 'block';
                    fallback.style.display = 'none';
                };
                original.src = ev.target.result;
            };
            reader.readAsDataURL(file);
        };

        // Bio char count
        document.getElementById('profileBioInput').oninput = (e) => {
            const len = e.target.value.length;
            const counter = document.getElementById('profileBioCount');
            counter.textContent = `${len}/150`;
            counter.className = 'profile-char-count' + (len > 140 ? ' over' : '');
        };

        // Save
        document.getElementById('profileSaveBtn').onclick = _save;

        // QR Code for own profile
        const user  = window.currentUserData || {};
        const auth  = window.currentUser || {};
        const myUID = auth.uid;
        if (myUID && window.QRManager) {
            const box = document.getElementById('profileQrBox');
            if (box) {
                const qrText = window.QRManager.profileQRData(myUID, user.name || auth.displayName || 'Me');
                window.QRManager.generateQR(box, qrText, { size: 180 });
            }
            document.getElementById('profileQrShareBtn').onclick = () => {
                const b = document.getElementById('profileQrBox');
                window.QRManager.shareQR(b, user.name || auth.displayName || 'Me');
            };
        }
    }

    async function _save() {
        const btn = document.getElementById('profileSaveBtn');
        const nameVal = document.getElementById('profileNameInput').value.trim();
        const bioVal  = document.getElementById('profileBioInput').value.trim();

        if (!nameVal) {
            showToast('Display name cannot be empty', 'error');
            return;
        }

        btn.disabled = true;
        btn.classList.add('saving');
        btn.textContent = 'Saving...';

        // Use new base64 if selected, else keep existing photoURL
        const avatarURL = _newAvatarBase64
            ? _newAvatarBase64
            : (_newAvatarURL || document.getElementById('avatarUrlInput')?.value.trim() || null);

        try {
            const updates = {
                name:     nameVal,
                bio:      bioVal,
                photoURL: avatarURL
            };

            await window.db.collection('users').doc(window.currentUser.uid).update(updates);

            // Update cached data
            if (window.currentUserData) {
                window.currentUserData.name     = nameVal;
                window.currentUserData.bio      = bioVal;
                window.currentUserData.photoURL = avatarURL;
                window.enhancedCache.set(`user_${window.currentUser.uid}`, window.currentUserData, 30 * 60 * 1000);
            }

            // Update sidebar UI
            const userNameEl = document.getElementById('userName');
            if (userNameEl) userNameEl.textContent = nameVal;

            const userAvatarEl   = document.getElementById('userAvatar');
            const avatarFallback = document.getElementById('avatarFallback');
            if (avatarURL) {
                if (userAvatarEl) {
                    userAvatarEl.src = avatarURL;
                    userAvatarEl.style.display = 'block';
                }
                if (avatarFallback) avatarFallback.style.display = 'none';
            }

            showToast('Profile updated successfully!', 'success');
            close();
        } catch (err) {
            console.error('Profile save error:', err);
            showToast('Failed to save profile: ' + err.message, 'error');
            btn.disabled = false;
            btn.classList.remove('saving');
            btn.textContent = 'Save Changes';
        }
    }

    return { open, close };
})();

window.profileManager = profileManager;


// ============================================================
//  storiesManager — WhatsApp-style 24hr disappearing status
// ============================================================

const storiesManager = (() => {

    const STORY_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
    let _stories = []; // local cache: [{uid, name, photoURL, stories:[...]}]
    let _unsubscribe = null;

    // ── Bootstrap: render bar + subscribe ────────────────────
    function init() {
        _renderBar();
        _subscribe();
    }

    // ── Subscribe to Firestore stories ───────────────────────
    function _subscribe() {
        if (_unsubscribe) _unsubscribe();
        if (!window.db || !window.currentUser) return;

        const cutoff = new Date(Date.now() - STORY_TTL_MS);

        _unsubscribe = window.db.collection('stories')
            .where('createdAt', '>=', cutoff)
            .orderBy('createdAt', 'desc')
            .onSnapshot(snap => {
                const raw = [];
                snap.forEach(doc => {
                    raw.push({ id: doc.id, ...doc.data() });
                });
                _processAndRender(raw);
            }, err => console.error('Stories snapshot error:', err));
    }

    // ── Group stories by user ─────────────────────────────────
    async function _processAndRender(rawStories) {
        // Group by uid
        const map = new Map();
        for (const s of rawStories) {
            if (!map.has(s.uid)) map.set(s.uid, []);
            map.get(s.uid).push(s);
        }

        // Build grouped array, mine first
        const myUID = window.currentUser.uid;
        const friends = window.currentUserData?.friends || [];

        const grouped = [];

        // Always show "my status" first
        const myStories = map.get(myUID) || [];
        grouped.push({
            uid: myUID,
            name: window.currentUserData?.name || 'You',
            photoURL: window.currentUserData?.photoURL || window.currentUser.photoURL,
            stories: myStories,
            isMine: true
        });

        // Then friends who have stories
        for (const [uid, stories] of map.entries()) {
            if (uid === myUID) continue;
            if (!friends.includes(uid)) continue; // only friends' stories
            let userData = window.enhancedCache.get(`user_${uid}`);
            if (!userData) {
                try {
                    userData = await window.getUserData(uid);
                } catch (_) {}
            }
            grouped.push({
                uid,
                name: userData?.name || 'User',
                photoURL: userData?.photoURL || null,
                stories,
                isMine: false
            });
        }

        _stories = grouped;
        _renderBar();
    }

    // ── Render the stories bar in sidebar ────────────────────
    function _renderBar() {
        const bar = document.getElementById('storiesBar');
        if (!bar) return;

        const scroll = bar.querySelector('.stories-scroll');
        if (!scroll) return;

        scroll.innerHTML = '';

        for (const group of _stories) {
            const hasStories = group.stories.length > 0;
            const bubble = document.createElement('div');
            bubble.className = 'story-bubble';
            bubble.dataset.uid = group.uid;

            const ringClass = hasStories && !group.isMine ? 'story-ring' : (group.isMine ? 'story-ring' : 'story-ring seen');

            bubble.innerHTML = `
                <div class="${ringClass}">
                    <div class="story-ring-inner">
                        ${group.photoURL
                            ? `<img src="${escapeAttribute(group.photoURL)}" alt="" onerror="this.style.display='none';this.nextSibling.style.display='flex';">
                               <div class="story-fallback" style="display:none;">👤</div>`
                            : `<div class="story-fallback">👤</div>`}
                    </div>
                    ${group.isMine ? '<div class="story-add-btn">+</div>' : ''}
                </div>
                <span class="story-name ${group.isMine ? 'mine' : ''}">${escapeHTML(group.isMine ? 'My Status' : group.name)}</span>
            `;

            bubble.onclick = () => {
                if (group.isMine && !hasStories) {
                    _openComposer();
                } else if (group.isMine) {
                    // Long press to add — just click to view
                    _openViewer(group);
                } else {
                    if (hasStories) _openViewer(group);
                }
            };

            // My status: right-click / long-press to add new
            if (group.isMine) {
                const addBtn = bubble.querySelector('.story-add-btn');
                if (addBtn) {
                    addBtn.onclick = (e) => {
                        e.stopPropagation();
                        _openComposer();
                    };
                }
            }

            scroll.appendChild(bubble);
        }
    }

    // ── Story Composer Modal ──────────────────────────────────
    // ── Instagram URL validator ───────────────────────────────
    function _isInstagramURL(url) {
        return /^https?:\/\/(www\.)?instagram\.com\/(p|reel|tv)\/[\w-]+/.test(url);
    }

    function _openComposer(prefillURL = '') {
        const overlay = document.createElement('div');
        overlay.className = 'story-composer-overlay';
        overlay.innerHTML = `
            <div class="story-composer">
                <h3>📸 Add Status</h3>

                <div class="story-type-tabs">
                    <button class="story-type-tab ${!prefillURL ? 'active' : ''}" data-type="text">✍️ Text</button>
                    <button class="story-type-tab ${prefillURL ? 'active' : ''}" data-type="instagram">📱 Instagram</button>
                </div>

                <!-- Text panel -->
                <div id="storyTextPanel" style="display:${!prefillURL ? 'block' : 'none'};">
                    <textarea class="story-text-input" id="storyTextInput"
                        placeholder="What's on your mind? Your status disappears in 24 hrs ⏳"
                        maxlength="280"></textarea>
                </div>

                <!-- Instagram panel -->
                <div id="storyInstaPanel" style="display:${prefillURL ? 'block' : 'none'};">
                    <input type="url" class="story-insta-input" id="storyInstaInput"
                        placeholder="https://www.instagram.com/reel/..."
                        value="${escapeAttribute(prefillURL)}">
                    <div id="storyInstaPreview" class="story-insta-preview"></div>
                </div>

                <div class="story-composer-actions">
                    <button class="story-cancel-btn" id="storyCancelBtn">Cancel</button>
                    <button class="story-post-btn" id="storyPostBtn">Post Status</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        let _instaEmbedData = null; // { url, thumbnailUrl, embedHtml, title }

        // Type tabs
        overlay.querySelectorAll('.story-type-tab').forEach(tab => {
            tab.onclick = () => {
                overlay.querySelectorAll('.story-type-tab').forEach(t => t.classList.remove('active'));
                tab.classList.add('active');
                const type = tab.dataset.type;
                document.getElementById('storyTextPanel').style.display    = type === 'text'      ? 'block' : 'none';
                document.getElementById('storyInstaPanel').style.display   = type === 'instagram' ? 'block' : 'none';
            };
        });

        // Instagram URL input → fetch embed preview
        let _debounceTimer = null;
        const _fetchPreview = async (url) => {
            const previewEl = document.getElementById('storyInstaPreview');
            if (!url) { previewEl.innerHTML = ''; _instaEmbedData = null; return; }
            if (!_isInstagramURL(url)) {
                previewEl.innerHTML = `<p class="insta-preview-error">Instagram post/reel link paste చేయండి</p>`;
                _instaEmbedData = null;
                return;
            }
            previewEl.innerHTML = `<p class="insta-preview-loading">⏳ Loading preview...</p>`;
            try {
                const res = await fetch(`/instagram-embed?url=${encodeURIComponent(url)}`);
                if (!res.ok) throw new Error('Preview fetch failed');
                const data = await res.json();
                _instaEmbedData = { url, ...data };
                previewEl.innerHTML = `
                    <div class="insta-preview-card">
                        ${data.thumbnailUrl ? `<img src="${escapeAttribute(data.thumbnailUrl)}" class="insta-preview-thumb" alt="preview">` : ''}
                        <p class="insta-preview-title">${escapeHTML(data.title || 'Instagram Reel')}</p>
                        <span class="insta-preview-badge">Instagram</span>
                    </div>`;
            } catch (err) {
                previewEl.innerHTML = `<p class="insta-preview-error">Preview load అవ్వలేదు — link valid గా ఉంటే post చేయవచ్చు</p>`;
                // Still allow posting with just the URL
                _instaEmbedData = { url, thumbnailUrl: null, embedHtml: null, title: null };
            }
        };

        document.getElementById('storyInstaInput').oninput = (e) => {
            clearTimeout(_debounceTimer);
            _debounceTimer = setTimeout(() => _fetchPreview(e.target.value.trim()), 600);
        };

        // If prefilled (from Instagram share), auto-fetch preview
        if (prefillURL) {
            setTimeout(() => _fetchPreview(prefillURL), 300);
        }

        // Cancel
        document.getElementById('storyCancelBtn').onclick = () => overlay.remove();
        overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

        // Post
        document.getElementById('storyPostBtn').onclick = async () => {
            const activeTab = overlay.querySelector('.story-type-tab.active').dataset.type;
            let storyData = null;

            if (activeTab === 'text') {
                const text = document.getElementById('storyTextInput').value.trim();
                if (!text) { showToast('Please enter some text', 'warning'); return; }
                storyData = { type: 'text', text };
            } else {
                const url = document.getElementById('storyInstaInput').value.trim();
                if (!url || !_isInstagramURL(url)) {
                    showToast('Valid Instagram link paste చేయండి', 'warning');
                    return;
                }
                storyData = {
                    type: 'instagram',
                    instaURL: url,
                    thumbnailUrl: _instaEmbedData?.thumbnailUrl || null,
                    embedHtml:    _instaEmbedData?.embedHtml    || null,
                    title:        _instaEmbedData?.title        || null,
                };
            }

            const btn = document.getElementById('storyPostBtn');
            btn.disabled = true;
            btn.textContent = 'Posting...';

            try {
                await window.db.collection('stories').add({
                    uid:       window.currentUser.uid,
                    name:      window.currentUserData?.name || window.currentUser.displayName,
                    photoURL:  window.currentUserData?.photoURL || window.currentUser.photoURL || null,
                    createdAt: new Date(),
                    expiresAt: new Date(Date.now() + STORY_TTL_MS),
                    ...storyData
                });
                showToast('Status posted! 🎉 Disappears in 24hrs', 'success');
                overlay.remove();
            } catch (err) {
                console.error('Story post error:', err);
                showToast('Failed to post status: ' + err.message, 'error');
                btn.disabled = false;
                btn.textContent = 'Post Status';
            }
        };
    }

    // ── Upload status media to Google Drive (returns {viewLink}) ─
    async function _uploadStatusFileToDrive(file) {
        // Reuse driveFileShare.js token infrastructure
        const token = await _getStatusDriveToken();

        // Get/create EduChat Status folder
        const folderId = await _getOrCreateStatusFolder(token);

        const metadata = { name: file.name, parents: [folderId] };
        const form = new FormData();
        form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
        form.append('file', file);

        const uploadRes = await fetch(
            'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,webViewLink,webContentLink',
            {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}` },
                body: form,
            }
        );

        if (!uploadRes.ok) {
            const err = await uploadRes.json();
            throw new Error(err.error?.message || 'Drive upload failed');
        }

        const fileData = await uploadRes.json();

        // Make publicly readable
        await fetch(`https://www.googleapis.com/drive/v3/files/${fileData.id}/permissions`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ role: 'reader', type: 'anyone' }),
        });

        // Use thumbnail URL for images (embeddable in <img> tags, no CORS/auth issues).
        // For videos, fall back to uc?export=download (best available without Firebase Storage).
        const isImage = file.type.startsWith('image/');
        const viewLink = isImage
            ? `https://drive.google.com/thumbnail?id=${fileData.id}&sz=w800`
            : `https://drive.google.com/uc?export=download&id=${fileData.id}`;

        return { viewLink, fileId: fileData.id };
    }

    // ── Get Drive access token (reuses driveFileShare token cache) ─
    function _getStatusDriveToken() {
        return new Promise((resolve, reject) => {
            // Try cached token from driveFileShare.js session cache
            const cached = sessionStorage.getItem('driveShareAccessToken');
            const expiry = parseInt(sessionStorage.getItem('driveShareAccessTokenExpiry') || '0', 10);
            if (cached && Date.now() < expiry) {
                resolve(cached);
                return;
            }

            // Request new token via Google Identity Services
            if (!window.google?.accounts?.oauth2) {
                reject(new Error('Google Identity Services not loaded'));
                return;
            }

            const client = google.accounts.oauth2.initTokenClient({
                client_id: window.DRIVE_CLIENT_ID || '191214500535-6nironkv53bia01cct6lbfgmi6u0286s.apps.googleusercontent.com',
                scope: 'https://www.googleapis.com/auth/drive.file',
                callback: (tokenResponse) => {
                    if (tokenResponse.error) {
                        reject(new Error(tokenResponse.error));
                        return;
                    }
                    // Cache it for reuse
                    sessionStorage.setItem('driveShareAccessToken', tokenResponse.access_token);
                    sessionStorage.setItem('driveShareAccessTokenExpiry', String(Date.now() + 55 * 60 * 1000));
                    resolve(tokenResponse.access_token);
                },
                error_callback: (err) => {
                    if (err.type === 'popup_closed') reject(new Error('Google sign-in was closed'));
                    else reject(new Error('Drive auth failed: ' + err.type));
                }
            });
            client.requestAccessToken({ prompt: '' });
        });
    }

    // ── Get or create "EduChat Status" folder in Drive ──────────
    async function _getOrCreateStatusFolder(token) {
        const folderName = 'EduChat Status';
        const searchRes = await fetch(
            `https://www.googleapis.com/drive/v3/files?q=name='${folderName}' and mimeType='application/vnd.google-apps.folder' and trashed=false&fields=files(id)`,
            { headers: { Authorization: `Bearer ${token}` } }
        );
        const searchData = await searchRes.json();
        if (searchData.files?.length > 0) return searchData.files[0].id;

        const createRes = await fetch('https://www.googleapis.com/drive/v3/files', {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: folderName, mimeType: 'application/vnd.google-apps.folder' }),
        });
        const folder = await createRes.json();
        return folder.id;
    }

    // ── Story Viewer ──────────────────────────────────────────
    function _openViewer(group) {
        if (!group.stories || group.stories.length === 0) return;

        let current = 0;
        let timer = null;
        const DURATION = 5000; // 5s per story

        const overlay = document.createElement('div');
        overlay.className = 'story-viewer-overlay';
        document.body.appendChild(overlay);

        function _render(idx) {
            current = idx;
            const story = group.stories[idx];
            clearTimeout(timer);

            const timeAgo = _timeAgo(story.createdAt?.toDate ? story.createdAt.toDate() : new Date(story.createdAt));

            overlay.innerHTML = `
                <div class="story-viewer">
                    <!-- Progress bars -->
                    <div class="story-progress-bars" id="storyProgressBars">
                        ${group.stories.map((_, i) => `
                            <div class="story-progress-bar">
                                <div class="story-progress-fill ${i < idx ? 'done' : ''}" 
                                     id="storyFill_${i}"
                                     style="${i === idx ? '--story-duration:' + DURATION + 'ms' : ''}">
                                </div>
                            </div>
                        `).join('')}
                    </div>

                    <!-- Header -->
                    <div class="story-viewer-header">
                        <div class="story-viewer-user">
                            ${group.photoURL
                                ? `<img class="story-viewer-avatar" src="${escapeAttribute(group.photoURL)}" alt="">`
                                : `<div class="story-viewer-avatar-fallback">👤</div>`}
                            <div>
                                <div class="story-viewer-name">${escapeHTML(group.name)}</div>
                                <div class="story-viewer-time">${timeAgo}</div>
                            </div>
                        </div>
                        <button class="story-viewer-close" id="storyViewerClose">✕</button>
                    </div>

                    <!-- Content -->
                    <div class="story-content" id="storyContent">
                        ${story.type === 'instagram'
                            ? (() => {
                                  const _getEmbedSrc = (url) => {
                                      const m = url.match(/instagram\.com\/(p|reel|tv)\/([\w-]+)/);
                                      return m ? `https://www.instagram.com/${m[1]}/${m[2]}/embed/` : null;
                                  };
                                  const embedSrc = _getEmbedSrc(story.instaURL);
                                  return `<div class="story-insta-embed" id="storyInstaEmbed">
                                      ${embedSrc
                                          ? `<iframe
                                                 src="${escapeAttribute(embedSrc)}"
                                                 class="story-insta-iframe"
                                                 frameborder="0"
                                                 scrolling="no"
                                                 allowtransparency="true"
                                                 allowfullscreen="true"
                                                 allow="autoplay; clipboard-write; encrypted-media; picture-in-picture; web-share"
                                             ></iframe>`
                                          : `<div class="story-insta-no-thumb">
                                                 <a href="${escapeAttribute(story.instaURL)}" target="_blank" rel="noopener" class="story-insta-open-btn">
                                                     📱 Instagram లో చూడు
                                                 </a>
                                             </div>`
                                      }
                                  </div>`;
                              })()
                            : story.type === 'image'
                            ? `<img class="story-content-image"
                                    src="${escapeAttribute(story.imageURL)}"
                                    alt="Status"
                                    onerror="this.style.display='none';document.getElementById('storyMediaFallback').style.display='flex';">
                               <div id="storyMediaFallback" class="story-media-fallback" style="display:none;">
                                   <span>🖼️ Image couldn't load</span>
                               </div>`
                            : story.type === 'video'
                                ? `<video class="story-content-video"
                                          src="${escapeAttribute(story.imageURL)}"
                                          autoplay controls playsinline
                                          style="max-width:100%;max-height:70vh;border-radius:8px;"
                                          onerror="this.style.display='none';document.getElementById('storyMediaFallback').style.display='flex'">
                                   </video>
                                   <div id="storyMediaFallback" class="story-media-fallback" style="display:none;text-align:center;padding:20px;color:#fff;">
                                       <span>🎬 Video load కాలేదు</span>
                                   </div>`
                                : `<div class="story-content-text">${escapeHTML(story.text)}</div>`}
                    </div>

                    <!-- Nav zones -->
                    <button class="story-nav-prev" id="storyNavPrev"></button>
                    <button class="story-nav-next" id="storyNavNext"></button>

                    ${group.isMine ? `<button class="story-delete-btn" id="storyDeleteBtn">🗑️ Delete</button>` : ''}
                </div>
            `;

            // Start progress animation
            setTimeout(() => {
                const fill = document.getElementById(`storyFill_${idx}`);
                if (fill) fill.classList.add('active');
            }, 50);

            // Load Instagram embed script if needed
            if (story.type === 'instagram' && story.embedHtml) {
                if (window.instgrm) {
                    window.instgrm.Embeds.process();
                } else if (!document.getElementById('instagram-embed-script')) {
                    const s = document.createElement('script');
                    s.id = 'instagram-embed-script';
                    s.src = 'https://www.instagram.com/embed.js';
                    s.async = true;
                    s.onload = () => window.instgrm?.Embeds.process();
                    document.body.appendChild(s);
                }
            }

            // Auto-advance — skip timer for Instagram reels (user watches at own pace)
            if (story.type !== 'instagram') {
                timer = setTimeout(() => {
                    if (idx + 1 < group.stories.length) _render(idx + 1);
                    else overlay.remove();
                }, DURATION);
            }

            // Binds
            document.getElementById('storyViewerClose').onclick = () => { clearTimeout(timer); overlay.remove(); };
            document.getElementById('storyNavPrev').onclick = () => {
                if (idx > 0) _render(idx - 1);
            };
            document.getElementById('storyNavNext').onclick = () => {
                if (idx + 1 < group.stories.length) _render(idx + 1);
                else { clearTimeout(timer); overlay.remove(); }
            };

            if (group.isMine) {
                document.getElementById('storyDeleteBtn').onclick = async () => {
                    if (!confirm('Delete this status?')) return;
                    clearTimeout(timer);
                    try {
                        await window.db.collection('stories').doc(story.id).delete();
                        showToast('Status deleted', 'info');
                    } catch (e) {
                        showToast('Delete failed: ' + e.message, 'error');
                    }
                    overlay.remove();
                };
            }

            overlay.onclick = (e) => {
                if (e.target === overlay) { clearTimeout(timer); overlay.remove(); }
            };
        }

        _render(0);
    }

    // ── Time formatting ───────────────────────────────────────
    function _timeAgo(date) {
        const diffMs = Date.now() - date.getTime();
        const diffM  = Math.floor(diffMs / 60000);
        if (diffM < 1)    return 'Just now';
        if (diffM < 60)   return `${diffM}m ago`;
        const diffH = Math.floor(diffM / 60);
        if (diffH < 24)   return `${diffH}h ago`;
        return 'Yesterday';
    }

    // ── Public API ────────────────────────────────────────────
    return { init, openComposer: _openComposer };
})();

window.storiesManager = storiesManager;
console.log('profile.js loaded');

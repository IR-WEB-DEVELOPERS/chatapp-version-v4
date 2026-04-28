// ============================================================
//  privateChats.js — Private Chats with 4-digit passcode,
//                    email OTP fallback, block contacts
// ============================================================

window.privateChatsManager = (() => {

    // ── State ─────────────────────────────────────────────────
    let _initialized     = false;
    let _unlocked        = false;
    let _passcodeBuffer  = '';
    let _otpCode         = '';
    let _otpExpiry       = 0;
    let _otpResendTimer  = null;
    let _otpPurpose      = 'reset';
    let _privateContacts = [];

    // ── Helpers ───────────────────────────────────────────────
    function _getStoredCode() {
        if (!window.currentUser) return null;
        return localStorage.getItem(`pc_code_${window.currentUser.uid}`);
    }
    function _setStoredCode(code) {
        if (!window.currentUser) return;
        localStorage.setItem(`pc_code_${window.currentUser.uid}`, code);
    }
    function _getPrivateList() {
        if (!window.currentUser) return [];
        try {
            return JSON.parse(localStorage.getItem(`pc_list_${window.currentUser.uid}`) || '[]');
        } catch { return []; }
    }
    function _setPrivateList(arr) {
        if (!window.currentUser) return;
        localStorage.setItem(`pc_list_${window.currentUser.uid}`, JSON.stringify(arr));
    }
    function _getBlockedList() {
        if (!window.currentUser) return [];
        try {
            return JSON.parse(localStorage.getItem(`blocked_${window.currentUser.uid}`) || '[]');
        } catch { return []; }
    }
    function _setBlockedList(arr) {
        if (!window.currentUser) return;
        localStorage.setItem(`blocked_${window.currentUser.uid}`, JSON.stringify(arr));
    }

    // ── Dot indicator update ──────────────────────────────────
    function _updateDots(containerId, count) {
        const container = document.getElementById(containerId);
        if (!container) return;
        const dots = container.querySelectorAll('.dot');
        dots.forEach((dot, i) => {
            dot.classList.toggle('filled', i < count);
        });
    }

    // ── Passcode Entry Modal ──────────────────────────────────
    function _openPasscodeModal() {
        _passcodeBuffer = '';
        _updateDots('passcodeDots', 0);
        const errEl = document.getElementById('passcodeError');
        if (errEl) errEl.style.display = 'none';
        document.getElementById('privateChatsPasscodeModal').style.display = 'flex';
    }

    function _closePasscodeModal() {
        document.getElementById('privateChatsPasscodeModal').style.display = 'none';
        _passcodeBuffer = '';
    }

    function _onPasscodeEntry(buf) {
        _updateDots('passcodeDots', buf.length);
        if (buf.length === 4) {
            setTimeout(() => _checkPasscode(buf), 100);
        }
    }

    function _checkPasscode(code) {
        const stored = _getStoredCode();
        if (code === stored) {
            _unlocked = true;
            _closePasscodeModal();
            _showPrivateChatsSection();
            if (window.showToast) showToast('Private chats unlocked!', 'success');
        } else {
            _passcodeBuffer = '';
            _updateDots('passcodeDots', 0);
            const errEl = document.getElementById('passcodeError');
            if (errEl) { errEl.style.display = 'block'; errEl.textContent = 'Wrong passcode! Try again.'; }
            setTimeout(() => { if (errEl) errEl.style.display = 'none'; }, 2000);
        }
    }

    // ── Setup Modal (first time) ──────────────────────────────
    let _setupStep = 'set';
    let _setupFirstCode = '';
    let _setupBuffer = '';

    function _openSetupModal() {
        _setupStep    = 'set';
        _setupBuffer  = '';
        _setupFirstCode = '';
        _updateDots('setupPasscodeDots', 0);
        document.getElementById('setupModalSubtitle').textContent = 'Create a 4-digit passcode';
        const errEl = document.getElementById('setupError');
        if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }
        document.getElementById('privateChatsSetupModal').style.display = 'flex';
    }

    function _onSetupEntry(buf) {
        _updateDots('setupPasscodeDots', buf.length);
        if (buf.length === 4) {
            setTimeout(() => {
                if (_setupStep === 'set') {
                    _setupFirstCode = buf;
                    _setupBuffer = '';
                    _setupStep = 'confirm';
                    _updateDots('setupPasscodeDots', 0);
                    document.getElementById('setupModalSubtitle').textContent = 'Confirm your passcode';
                } else {
                    if (buf === _setupFirstCode) {
                        _setStoredCode(buf);
                        document.getElementById('privateChatsSetupModal').style.display = 'none';
                        _unlocked = true;
                        _showPrivateChatsSection();
                        if (window.showToast) showToast('Private chats enabled!', 'success');
                    } else {
                        _setupBuffer = '';
                        _setupStep = 'set';
                        _setupFirstCode = '';
                        _updateDots('setupPasscodeDots', 0);
                        document.getElementById('setupModalSubtitle').textContent = 'Create a 4-digit passcode';
                        const errEl = document.getElementById('setupError');
                        if (errEl) { errEl.textContent = "Passcodes didn't match! Try again."; errEl.style.display = 'block'; }
                        setTimeout(() => { if (errEl) errEl.style.display = 'none'; }, 2000);
                    }
                }
            }, 100);
        }
    }

    // ── Change Passcode Modal ─────────────────────────────────
    let _changeStep   = 'old';
    let _changeBuffer = '';
    let _changeNewCode = '';

    function _openChangePasscodeModal() {
        _changeStep   = 'old';
        _changeBuffer = '';
        _changeNewCode = '';
        _updateDots('changePasscodeDots', 0);
        document.getElementById('changePasscodeSubtitle').textContent = 'Enter your CURRENT passcode';
        const errEl = document.getElementById('changePasscodeError');
        if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }
        document.getElementById('changePasscodeModal').style.display = 'flex';
    }

    function _onChangeEntry(buf) {
        _updateDots('changePasscodeDots', buf.length);
        if (buf.length === 4) {
            setTimeout(() => {
                if (_changeStep === 'old') {
                    if (buf === _getStoredCode()) {
                        _changeBuffer = '';
                        _changeStep = 'new';
                        _updateDots('changePasscodeDots', 0);
                        document.getElementById('changePasscodeSubtitle').textContent = 'Enter NEW passcode';
                    } else {
                        _changeBuffer = '';
                        _updateDots('changePasscodeDots', 0);
                        const errEl = document.getElementById('changePasscodeError');
                        if (errEl) { errEl.textContent = 'Wrong passcode!'; errEl.style.display = 'block'; }
                        setTimeout(() => { if (errEl) errEl.style.display = 'none'; }, 2000);
                    }
                } else if (_changeStep === 'new') {
                    _changeNewCode = buf;
                    _changeBuffer  = '';
                    _changeStep    = 'confirm';
                    _updateDots('changePasscodeDots', 0);
                    document.getElementById('changePasscodeSubtitle').textContent = 'Confirm NEW passcode';
                } else {
                    if (buf === _changeNewCode) {
                        _setStoredCode(buf);
                        document.getElementById('changePasscodeModal').style.display = 'none';
                        if (window.showToast) showToast('Passcode changed!', 'success');
                    } else {
                        _changeBuffer  = '';
                        _changeStep    = 'new';
                        _changeNewCode = '';
                        _updateDots('changePasscodeDots', 0);
                        document.getElementById('changePasscodeSubtitle').textContent = "Didn't match. Enter NEW passcode again.";
                        const errEl = document.getElementById('changePasscodeError');
                        if (errEl) { errEl.textContent = "Passcodes didn't match!"; errEl.style.display = 'block'; }
                        setTimeout(() => { if (errEl) errEl.style.display = 'none'; }, 2000);
                    }
                }
            }, 100);
        }
    }

    // ── Email OTP ─────────────────────────────────────────────
    function _generateOTP() {
        return Math.floor(100000 + Math.random() * 900000).toString();
    }

    async function _sendOTP() {
        const user  = window.currentUser;
        const email = user?.email || '';
        if (!email) {
            if (window.showToast) showToast('No email found for this account', 'error');
            return false;
        }

        try {
            _otpCode = '';
            _otpExpiry = 0;
            const result = await fetch('/send-otp', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    uid: user.uid,
                    email,
                    purpose: 'privacy-reset'
                })
            }).then(r => r.json());

            if (!result?.ok) throw new Error(result?.error || 'Failed to send OTP');

            const emailLabel = document.getElementById('otpEmailLabel');
            if (emailLabel) emailLabel.textContent = email;
            if (window.showToast) showToast(result.sent ? `OTP sent to ${email}` : 'OTP send failed. Check server SMTP settings.', result.sent ? 'success' : 'error');
            return true;
        } catch (err) {
            console.error('OTP send error:', err);
            if (window.showToast) showToast('Failed to send OTP. Check SMTP settings.', 'error');
            return false;
        }
    }

    function _openOTPModal(purpose) {
        _otpPurpose = purpose;
        const emailLabel = document.getElementById('otpEmailLabel');
        if (emailLabel) emailLabel.textContent = window.currentUser?.email || '';
        document.getElementById('emailOtpModal').style.display = 'flex';
        const otpInput = document.getElementById('otpInput');
        if (otpInput) { otpInput.value = ''; otpInput.focus(); }
        const errEl = document.getElementById('otpError');
        if (errEl) errEl.style.display = 'none';

        let secs = 60;
        const resendBtn = document.getElementById('resendOtpBtn');
        if (resendBtn) { resendBtn.disabled = true; resendBtn.textContent = `Resend OTP (${secs}s)`; }
        if (_otpResendTimer) clearInterval(_otpResendTimer);
        _otpResendTimer = setInterval(() => {
            secs--;
            if (resendBtn) resendBtn.textContent = `Resend OTP (${secs}s)`;
            if (secs <= 0) {
                clearInterval(_otpResendTimer);
                if (resendBtn) { resendBtn.disabled = false; resendBtn.textContent = 'Resend OTP'; }
            }
        }, 1000);

        _sendOTP();
    }

    async function _verifyOTP(inputCode) {
        try {
            const user = window.currentUser;
            const result = await fetch('/verify-otp', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    uid: user.uid,
                    email: user.email,
                    purpose: 'privacy-reset',
                    code: inputCode
                })
            }).then(r => r.json());
            return !!result.ok;
        } catch (err) {
            console.warn('Backend OTP verify failed, using browser fallback OTP:', err);
        }
        return inputCode === _otpCode && Date.now() < _otpExpiry;
    }

    // ── Show/hide private chats section ──────────────────────
    function _showPrivateChatsSection() {
        const section = document.getElementById('privateChatsSection');
        if (section) section.style.display = 'block';
        _loadPrivateChatsUI();
    }

    function _hidePrivateChatsSection() {
        const section = document.getElementById('privateChatsSection');
        if (section) section.style.display = 'none';
        _unlocked = false;
    }

    function _loadPrivateChatsUI() {
        const list = document.getElementById('privateChatsListUI');
        if (!list) return;
        _privateContacts = _getPrivateList();
        if (_privateContacts.length === 0) {
            list.innerHTML = `<div class="empty-state" style="padding:16px;text-align:center;color:var(--text-secondary);font-size:13px;">
                No private chats yet.<br>Right-click a friend → "Move to Private"
            </div>`;
            return;
        }
        list.innerHTML = '';
        _privateContacts.forEach(uid => {
            const userData = (window.enhancedCache?.get && window.enhancedCache.get(`user_${uid}`)) || { name: uid.slice(0, 8) + '...', status: 'offline' };
            const item = document.createElement('div');
            item.className = 'friend-item private-chat-item';
            item.innerHTML = `
                <div class="friend-avatar"><span class="avatar-fallback" data-icon="lock"></span></div>
                <div class="friend-info">
                    <span class="friend-name">${window.escapeHTML ? escapeHTML(userData.name || uid) : (userData.name || uid)}</span>
                    <span class="friend-status">${window.escapeHTML ? escapeHTML(userData.status || 'offline') : (userData.status || 'offline')}</span>
                </div>
                <button class="remove-private-btn" data-uid="${uid}" title="Remove from private" data-icon-btn="close"></button>
            `;
            item.querySelector('.remove-private-btn')?.addEventListener('click', (e) => {
                e.stopPropagation();
                _removeFromPrivate(uid);
            });
            item.addEventListener('click', (e) => {
                if (e.target.classList.contains('remove-private-btn')) return;
                if (window.openChat) window.openChat(uid, userData.name || uid, userData);
            });
            list.appendChild(item);
        });
    }

    // ── Private list management ───────────────────────────────
    function _addToPrivate(uid) {
        const list = _getPrivateList();
        if (!list.includes(uid)) {
            list.push(uid);
            _setPrivateList(list);
            _privateContacts = list;
            if (window.showToast) showToast('Chat moved to private', 'success');
            if (_unlocked) _loadPrivateChatsUI();
            if (window.loadFriendsList) window.loadFriendsList();
        }
    }

    function _removeFromPrivate(uid) {
        let list = _getPrivateList();
        list = list.filter(u => u !== uid);
        _setPrivateList(list);
        _privateContacts = list;
        if (window.showToast) showToast('Removed from private chats', 'info');
        if (_unlocked) _loadPrivateChatsUI();
        if (window.loadFriendsList) window.loadFriendsList();
    }

    function isPrivate(uid) {
        return _getPrivateList().includes(uid);
    }

    // ── Block contacts ────────────────────────────────────────
    function blockContact(uid, name) {
        const list = _getBlockedList();
        if (!list.find(u => u.uid === uid)) {
            list.push({ uid, name: name || uid });
            _setBlockedList(list);
            if (window.showToast) showToast(`${name || 'User'} blocked`, 'success');
            if (window.loadFriendsList) window.loadFriendsList();
        }
    }

    function unblockContact(uid) {
        let list = _getBlockedList();
        list = list.filter(u => u.uid !== uid);
        _setBlockedList(list);
        if (window.showToast) showToast('Contact unblocked', 'info');
        if (window.loadFriendsList) window.loadFriendsList();
        if (window.loadAllFriends) window.loadAllFriends();
        openBlockedContacts();
    }

    function isBlocked(uid) {
        return _getBlockedList().some(u => u.uid === uid);
    }

    function openBlockedContacts() {
        const modal = document.getElementById('blockedContactsModal');
        if (!modal) return;
        const listEl = document.getElementById('blockedContactsList');
        if (!listEl) return;
        const blocked = _getBlockedList();
        if (blocked.length === 0) {
            listEl.innerHTML = `<div style="text-align:center;padding:20px;color:var(--text-secondary);">No blocked contacts</div>`;
        } else {
            listEl.innerHTML = blocked.map(u => `
                <div class="blocked-item" style="display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--border);">
                    <div style="display:flex;align-items:center;gap:10px;">
                        <span class="block-icon-svg" style="display:flex;align-items:center;"></span>
                        <span style="font-weight:500;">${window.escapeHTML ? escapeHTML(u.name) : u.name}</span>
                    </div>
                    <button class="btn-secondary" style="font-size:12px;padding:4px 10px;" onclick="window.privateChatsManager.unblockContact('${u.uid}')">Unblock</button>
                </div>
            `).join('');
        }
        modal.style.display = 'flex';
    }

    // ── Search passcode unlock ────────────────────────────────
    function tryUnlockFromSearch(code) {
        const stored = _getStoredCode();
        if (!stored) {
            if (window.showToast) showToast('Private chats not set up yet. Use the menu to set up.', 'info');
            return;
        }
        if (code === stored) {
            _unlocked = true;
            _showPrivateChatsSection();
            if (window.showToast) showToast('Private chats unlocked!', 'success');
        } else {
            if (window.showToast) showToast('Wrong passcode!', 'error');
        }
    }

    // ── Menu open ─────────────────────────────────────────────
    function openMenu() {
        const stored = _getStoredCode();
        if (!stored) {
            _openSetupModal();
        } else if (_unlocked) {
            _showPrivateChatsMenu();
        } else {
            _openPasscodeModal();
        }
    }

    function _showPrivateChatsMenu() {
        const opts = [
            { label: 'Change Passcode',    action: () => _openChangePasscodeModal() },
            { label: 'Lock Private Chats', action: () => { _hidePrivateChatsSection(); if (window.showToast) showToast('Private chats locked', 'info'); } },
        ];
        const modal = document.createElement('div');
        modal.className = 'modal-overlay';
        modal.style.display = 'flex';
        modal.innerHTML = `
            <div class="modal" style="max-width:300px;">
                <div class="modal-header"><h3>Private Chats</h3><button class="modal-close" id="pcMenuClose" data-icon-btn="close"></button></div>
                <div class="modal-body" style="padding:8px 0;">
                    ${opts.map((o, i) => `<button class="dropdown-item" style="width:100%;text-align:left;padding:12px 20px;" data-pc-opt="${i}">${o.label}</button>`).join('')}
                </div>
            </div>
        `;
        document.body.appendChild(modal);
        modal.querySelector('#pcMenuClose').onclick = () => modal.remove();
        modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
        modal.querySelectorAll('[data-pc-opt]').forEach(btn => {
            btn.onclick = () => { modal.remove(); opts[+btn.dataset.pcOpt].action(); };
        });
    }

    // ── Init ──────────────────────────────────────────────────
    function init() {
        if (_initialized) return;
        _initialized = true;

        document.getElementById('closePrivateModal')?.addEventListener('click', _closePasscodeModal);
        document.getElementById('closeSetupModal')?.addEventListener('click', () => {
            document.getElementById('privateChatsSetupModal').style.display = 'none';
        });
        document.getElementById('closeChangePasscodeModal')?.addEventListener('click', () => {
            document.getElementById('changePasscodeModal').style.display = 'none';
        });
        document.getElementById('closeOtpModal')?.addEventListener('click', () => {
            document.getElementById('emailOtpModal').style.display = 'none';
            clearInterval(_otpResendTimer);
        });
        document.getElementById('closeBlockedModal')?.addEventListener('click', () => {
            document.getElementById('blockedContactsModal').style.display = 'none';
        });
        document.getElementById('closeBlockedBtn')?.addEventListener('click', () => {
            document.getElementById('blockedContactsModal').style.display = 'none';
        });

        document.getElementById('lockPrivateBtn')?.addEventListener('click', () => {
            _hidePrivateChatsSection();
            if (window.showToast) showToast('Private chats locked', 'info');
        });

        // Passcode numpad
        document.querySelectorAll('#privateChatsPasscodeModal .num-btn[data-n]').forEach(btn => {
            btn.addEventListener('click', () => {
                if (_passcodeBuffer.length >= 4) return;
                _passcodeBuffer += btn.dataset.n;
                _onPasscodeEntry(_passcodeBuffer);
            });
        });
        document.getElementById('passcodeBackBtn')?.addEventListener('click', () => {
            _passcodeBuffer = _passcodeBuffer.slice(0, -1);
            _onPasscodeEntry(_passcodeBuffer);
        });

        // Setup numpad
        document.querySelectorAll('#privateChatsSetupModal .num-btn[data-setup]').forEach(btn => {
            btn.addEventListener('click', () => {
                if (_setupBuffer.length >= 4) return;
                _setupBuffer += btn.dataset.setup;
                _onSetupEntry(_setupBuffer);
            });
        });
        document.getElementById('setupBackBtn')?.addEventListener('click', () => {
            _setupBuffer = _setupBuffer.slice(0, -1);
            _onSetupEntry(_setupBuffer);
        });

        // Change passcode numpad
        document.querySelectorAll('#changePasscodeModal .num-btn[data-change]').forEach(btn => {
            btn.addEventListener('click', () => {
                if (_changeBuffer.length >= 4) return;
                _changeBuffer += btn.dataset.change;
                _onChangeEntry(_changeBuffer);
            });
        });
        document.getElementById('changeBackBtn')?.addEventListener('click', () => {
            _changeBuffer = _changeBuffer.slice(0, -1);
            _onChangeEntry(_changeBuffer);
        });

        // Forgot passcode → email OTP
        document.getElementById('forgotPasscodeBtn')?.addEventListener('click', () => {
            _closePasscodeModal();
            _otpPurpose = 'reset';
            _openOTPModal('reset');
        });

        // Resend OTP
        document.getElementById('resendOtpBtn')?.addEventListener('click', () => {
            _sendOTP();
            let secs = 60;
            const resendBtn = document.getElementById('resendOtpBtn');
            if (resendBtn) resendBtn.disabled = true;
            if (_otpResendTimer) clearInterval(_otpResendTimer);
            _otpResendTimer = setInterval(() => {
                secs--;
                if (resendBtn) resendBtn.textContent = `Resend OTP (${secs}s)`;
                if (secs <= 0) {
                    clearInterval(_otpResendTimer);
                    if (resendBtn) { resendBtn.disabled = false; resendBtn.textContent = 'Resend OTP'; }
                }
            }, 1000);
        });

        // Verify OTP
        document.getElementById('verifyOtpBtn')?.addEventListener('click', async () => {
            const inputCode = (document.getElementById('otpInput')?.value || '').trim();
            const errEl = document.getElementById('otpError');
            if (inputCode.length !== 6) {
                if (errEl) { errEl.textContent = 'Enter 6-digit OTP'; errEl.style.display = 'block'; }
                return;
            }
            const valid = await _verifyOTP(inputCode);
            if (valid) {
                clearInterval(_otpResendTimer);
                document.getElementById('emailOtpModal').style.display = 'none';
                if (_otpPurpose === 'reset') {
                    if (window.showToast) showToast('OTP verified! Set your new passcode.', 'success');
                    _setupStep = 'set';
                    _setupBuffer = '';
                    _setupFirstCode = '';
                    document.getElementById('setupModalSubtitle').textContent = 'Set a new 4-digit passcode';
                    document.getElementById('privateChatsSetupModal').style.display = 'flex';
                } else {
                    if (window.showToast) showToast('OTP verified!', 'success');
                    _openChangePasscodeModal();
                }
            } else {
                if (errEl) { errEl.textContent = 'Invalid or expired OTP!'; errEl.style.display = 'block'; }
            }
        });

        document.getElementById('otpInput')?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') document.getElementById('verifyOtpBtn')?.click();
        });

        // ── Search bar secret code detection ─────────────────
        // Listens on the main search input: type exactly 4 digits → unlock
        const searchInput = document.getElementById('searchUser');
        if (searchInput) {
            let _searchCodeTimer = null;
            searchInput.addEventListener('input', (e) => {
                const val = e.target.value.trim();
                if (/^\d{4}$/.test(val)) {
                    clearTimeout(_searchCodeTimer);
                    _searchCodeTimer = setTimeout(() => {
                        tryUnlockFromSearch(val);
                        searchInput.value = '';
                        // Clear search results if any
                        const results = document.getElementById('searchedUser');
                        if (results) results.innerHTML = '';
                    }, 300);
                }
            });
        }

        window._isPrivateChat    = isPrivate;
        window._isBlocked        = isBlocked;
        window._addToPrivateChat = _addToPrivate;
        window._blockContact     = blockContact;
    }

    return {
        init,
        openMenu,
        openBlockedContacts,
        tryUnlockFromSearch,
        unblockContact,
        blockContact,
        isPrivate,
        isBlocked,
        addToPrivate: _addToPrivate,
        removeFromPrivate: _removeFromPrivate,
        isUnlocked: () => _unlocked,
    };

})();

window.addEventListener('appInitialized', () => {
    window.privateChatsManager?.init();
});

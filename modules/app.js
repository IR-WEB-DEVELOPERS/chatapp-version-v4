// ============================================================
//  app.js — Auth, initialization, event listeners, tab switching
// ============================================================

// ── Auth state ───────────────────────────────────────────────
auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL).catch((err) => {
    console.warn('Firebase auth persistence setup failed:', err);
});

const LOGIN_VERIFIED_PREFIX = 'educhat_login_otp_verified_';

auth.onAuthStateChanged(async (user) => {
    console.log('Auth state changed:', user ? 'logged in' : 'no user');
    if (!user) {
        window.location.href = 'index.html';
        return;
    }
    if (localStorage.getItem(`${LOGIN_VERIFIED_PREFIX}${user.uid}`) !== 'true') {
        window.location.href = 'index.html';
        return;
    }
    currentUser        = user;
    window.currentUser = currentUser;
    await initializeApp();
});

// ── App initialization ───────────────────────────────────────
async function initializeApp() {
    console.log('Starting app initialization...');
    try {
        await loadUserData();
        initializeDarkMode();
        requestNotificationPermission();
        setupEventListeners();
        await initializeWebRTCManagers();
        startListeners();
        updateUI();
        setupPresence();
        enhancedCache.cleanup();

        // Initialize Profile Manager
        if (window.profileManager) {
            const avatarWrap = document.getElementById('userAvatarWrap');
            if (avatarWrap) {
                avatarWrap.addEventListener('click', () => window.profileManager.open());
            }
        }

        // Initialize Stories / Status Manager
        if (window.storiesManager) {
            window.storiesManager.init();
            const addStatusBtn = document.getElementById('addStatusBtn');
            if (addStatusBtn) {
                addStatusBtn.addEventListener('click', () => window.storiesManager.openComposer());
            }
        }

        // Initialize push notifications (Firestore-based, no server needed)
        if (window.pushNotifications) {
            window.pushNotifications.init();
        }

        // Initialize Private Chats / blocked contacts manager
        if (window.privateChatsManager) {
            window.privateChatsManager.init();
        }

        // Auto-backup check runs in background 5s after load
        setTimeout(() => {
            if (window.autoBackup) autoBackup.run();
        }, 5000);

        console.log('App initialized successfully');
        window.dispatchEvent(new Event('appInitialized'));
    } catch (error) {
        console.error('Error initializing app:', error);
        modalManager.showModal('Error', 'Error initializing app: ' + error.message, 'error');
    }
}

// ── Start realtime listeners ─────────────────────────────────
function startListeners() {
    let prevRequestCount  = 0;
    let firstReqSnapshot  = true;

    // Friend requests
    db.collection('friendRequests')
        .where('to', '==', currentUser.uid)
        .where('status', '==', 'pending')
        .onSnapshot(snapshot => {
            const newCount = snapshot.size;
            badgeManager.updateBadge('requests', newCount);

            if (!firstReqSnapshot && newCount > prevRequestCount) {
                badgeManager.playNotificationSound();
                snapshot.docChanges().forEach(change => {
                    if (change.type === 'added') {
                        const req = change.doc.data();
                        getUserData(req.from).then(senderData => {
                            toastManager.show({
                                icon: null, type: 'message', title: 'Friend Request',
                                body: `${senderData?.name || 'Someone'} sent you a friend request`,
                                type: 'request',
                                onClick: () => switchTab('friends')
                            });
                        });
                        if (Notification.permission === 'granted') {
                            new Notification('EduChat — Friend Request', { body: 'You have a new friend request!', icon: '/favicon.ico' });
                        }
                    }
                });
            }
            firstReqSnapshot  = false;
            prevRequestCount  = newCount;
            if (activeTab === 'friends') loadFriendRequests();
        });

    // Own user document (friends list changes)
    db.collection('users').doc(currentUser.uid)
        .onSnapshot(doc => {
            if (doc.exists) {
                const prevFriends  = currentUserData?.friends || [];
                currentUserData    = doc.data();
                window.currentUserData = currentUserData;
                // FIX: cache ని fresh data తో update చేయాలి, stale కాకుండా
                enhancedCache.set(`user_${currentUser.uid}`, currentUserData, 30 * 60 * 1000);
                // FIX: unreadMap ని కూడా sync చేయాలి
                if (currentUserData.unreadCounts) {
                    Object.keys(currentUserData.unreadCounts).forEach(chatId => {
                        unreadMap[chatId] = currentUserData.unreadCounts[chatId];
                    });
                }

                const newFriends = currentUserData.friends || [];
                if (JSON.stringify(prevFriends.sort()) !== JSON.stringify(newFriends.sort())) {
                    startFriendsPresenceListener();
                }

                if (activeTab === 'chats')   _renderFriendsList();   // pure render, zero reads
                else if (activeTab === 'friends') loadAllFriends();
            }
        });
}

function updateUI() {
    // Only load what the active tab needs — don't fetch everything at once
    if (activeTab === 'chats')   loadFriendsList();
    else if (activeTab === 'friends') { loadFriendRequests(); loadAllFriends(); }
    else if (activeTab === 'groups')  { loadGroupsList(); loadFriendsForGroup(); }
}

// ── Tab switching ────────────────────────────────────────────
function switchTab(tabName) {
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    const activeTabBtn = document.querySelector(`.tab-btn[data-tab="${tabName}"]`);
    if (activeTabBtn) activeTabBtn.classList.add('active');

    document.querySelectorAll('.tab-pane').forEach(pane => pane.classList.remove('active'));
    const activePane = document.getElementById(`${tabName}-tab`);
    if (activePane) activePane.classList.add('active');

    activeTab = tabName;

    switch (tabName) {
        case 'chats':   loadFriendsList(); break;
        case 'friends': loadFriendRequests(); loadAllFriends(); break;
        case 'groups':  loadGroupsList(); loadFriendsForGroup(); break;
    }
}

// ── Open individual chat ─────────────────────────────────────
async function openChat(friendUID) {
    chatWithUID   = friendUID;
    groupChatID   = null;

    if (unsubscribeGroupMessages) {
        unsubscribeGroupMessages();
        unsubscribeGroupMessages = null;
    }

    startFriendsPresenceListener();

    const defaultChat        = document.getElementById('defaultChat');
    const individualChat     = document.getElementById('individualChat');
    const groupChatContainer = document.getElementById('groupChatContainer');

    if (defaultChat)        defaultChat.style.display        = 'none';
    if (individualChat)     individualChat.style.display     = 'flex';
    if (groupChatContainer) groupChatContainer.style.display = 'none';
    const aiChatPane = document.getElementById('aiChatPane');
    if (aiChatPane)         aiChatPane.style.display         = 'none';

    if (window._hideSidebarOnMobile) window._hideSidebarOnMobile();

    const friendData       = await getUserData(friendUID);
    const chatPartnerName  = document.getElementById('chatPartnerName');
    const chatPartnerStatus = document.getElementById('chatPartnerStatus');
    const chatPartnerAvatar = document.getElementById('chatPartnerAvatar');

    if (chatPartnerAvatar) {
        const photoURL = friendData.photoURL || '';
        const initials = (friendData.name?.charAt(0)?.toUpperCase()) || '?';
        if (photoURL) {
            chatPartnerAvatar.innerHTML = `<img class="avatar-img" src="${escapeAttribute(photoURL)}" alt="${escapeAttribute(initials)}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex';"><span class="avatar-fallback" style="display:none;">${escapeHTML(initials)}</span>`;
        } else {
            chatPartnerAvatar.innerHTML = `<span class="avatar-fallback">${escapeHTML(initials)}</span>`;
        }
    }

    if (chatPartnerName) chatPartnerName.textContent = friendData.name;
    if (chatPartnerStatus) {
        chatPartnerStatus.textContent = formatStatus(friendData.status, friendData.lastSeen);
        chatPartnerStatus.className   = friendData.status === 'online' ? 'status-online' : 'status-offline';
    }

    // ── Make chat header avatar + name clickable → view friend profile ──
    const chatPartner = document.querySelector('#individualChat .chat-partner');
    if (chatPartner) {
        chatPartner.style.cursor = 'pointer';
        chatPartner.onclick = () => window.friendProfileViewer?.open(friendUID);
    }

    loadMessages();
    addCallButtonsToChat();
    markChatAsRead(generateChatId(currentUser.uid, friendUID));
    listenTypingIndicator();

    // Wire 3-dot menu in chat header
    const chatMoreBtn = document.getElementById('chatMoreBtn');
    if (chatMoreBtn) {
        chatMoreBtn.onclick = () => {
            openChatOptionsMenu(friendUID, friendData.name || 'User');
        };
    }

    // Show vanish mode banner if active
    updateVanishBanner(friendUID);

    const msgInput = document.getElementById('msg');
    if (msgInput) msgInput.oninput = onTypingInput;
}

// ── Event listeners setup ─────────────────────────────────────
function setupEventListeners() {
    // Tab buttons
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const tabBtn  = e.target.closest('.tab-btn');
            const tabName = tabBtn?.dataset.tab;
            if (tabName) switchTab(tabName);
        });
    });

    // Mobile sidebar
    function showSidebar() {
        const sidebar = document.querySelector('.sidebar');
        if (!sidebar) return;
        sidebar.classList.remove('mobile-hidden');
        let backdrop = document.getElementById('sidebarBackdrop');
        if (!backdrop) {
            backdrop            = document.createElement('div');
            backdrop.id         = 'sidebarBackdrop';
            backdrop.className  = 'sidebar-backdrop';
            backdrop.addEventListener('click', hideSidebar);
            document.body.appendChild(backdrop);
        }
        backdrop.style.display = 'block';
    }

    function hideSidebar() {
        const sidebar = document.querySelector('.sidebar');
        if (!sidebar) return;
        if (window.innerWidth <= 599) sidebar.classList.add('mobile-hidden');
        // FIX: display:none కాదు — DOM నుండి remove చేయాలి
        // కొన్ని Android browsers లో backdrop-filter blur linger అవుతుంది
        const backdrop = document.getElementById('sidebarBackdrop');
        if (backdrop) backdrop.remove();
    }

    window._hideSidebarOnMobile = hideSidebar;

    document.getElementById('backToSidebarBtn1')?.addEventListener('click', showSidebar);
    document.getElementById('backToSidebarBtn2')?.addEventListener('click', showSidebar);
    document.getElementById('openSidebarBtn')?.addEventListener('click', showSidebar);

    window.addEventListener('resize', () => {
        const sidebar = document.querySelector('.sidebar');
        if (!sidebar) return;
        if (window.innerWidth > 599) {
            sidebar.classList.remove('mobile-hidden');
            const backdrop = document.getElementById('sidebarBackdrop');
            if (backdrop) backdrop.remove();
        }
    });

    // Search. A 4-digit value is reserved as the Private Chats unlock code.
    document.getElementById('searchBtn')?.addEventListener('click', () => {
        const value = document.getElementById('searchUser')?.value.trim() || '';
        if (/^\d{4}$/.test(value)) {
            window.privateChatsManager?.tryUnlockFromSearch(value);
            document.getElementById('searchUser').value = '';
            document.getElementById('searchedUser').innerHTML = '';
            return;
        }
        searchUsers();
    });
    // Live-as-you-type debounced search
    document.getElementById('searchUser')?.addEventListener('input', () => {
        const val = document.getElementById('searchUser').value.trim();
        if (!val) { document.getElementById('searchedUser').innerHTML = ''; return; }
        searchUsersDebounced();
    });
    document.getElementById('searchUser')?.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            const value = e.currentTarget.value.trim();
            if (/^\d{4}$/.test(value)) {
                window.privateChatsManager?.tryUnlockFromSearch(value);
                e.currentTarget.value = '';
                const results = document.getElementById('searchedUser');
                if (results) results.innerHTML = '';
                return;
            }
            searchUsers();
        }
    });

    // Direct message send
    const sendBtn  = document.getElementById('sendBtn');
    const msgInput = document.getElementById('msg');
    if (sendBtn)  sendBtn.addEventListener('click', sendMessage);
    if (msgInput) {
        msgInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
        });
        msgInput.addEventListener('input', () => {
            msgInput.style.height = 'auto';
            msgInput.style.height = Math.min(msgInput.scrollHeight, 120) + 'px';
        });
    }

    // Group message send
    const sendGroupBtn  = document.getElementById('sendGroupBtn');
    const groupMsgInput = document.getElementById('groupMsg');
    if (sendGroupBtn)  sendGroupBtn.addEventListener('click', sendGroupMessage);
    if (groupMsgInput) {
        groupMsgInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendGroupMessage(); }
        });
        groupMsgInput.addEventListener('input', () => {
            groupMsgInput.style.height = 'auto';
            groupMsgInput.style.height = Math.min(groupMsgInput.scrollHeight, 120) + 'px';
        });
    }

    // Group creation
    document.getElementById('createGroupBtn')?.addEventListener('click', createGroup);

    // Toggle create group panel
    document.getElementById('toggleCreateGroup')?.addEventListener('click', () => {
        const body  = document.getElementById('createGroupBody');
        const arrow = document.getElementById('createGroupArrow');
        if (body && arrow) {
            body.classList.toggle('open');
            arrow.classList.toggle('open');
        }
    });

    // Add member
    document.getElementById('addMemberBtn')?.addEventListener('click', openAddMemberModal);
    document.getElementById('closeAddMemberModal')?.addEventListener('click', () => {
        document.getElementById('addMemberModal').style.display = 'none';
    });
    document.getElementById('cancelAddMember')?.addEventListener('click', () => {
        document.getElementById('addMemberModal').style.display = 'none';
    });
    document.getElementById('confirmAddMember')?.addEventListener('click', confirmAddMembers);

    // Leave group
    document.getElementById('leaveGroupBtn')?.addEventListener('click', openLeaveGroupModal);
    document.getElementById('closeLeaveModal')?.addEventListener('click', () => {
        document.getElementById('leaveGroupModal').style.display = 'none';
    });
    document.getElementById('cancelLeave')?.addEventListener('click', () => {
        document.getElementById('leaveGroupModal').style.display = 'none';
    });
    document.getElementById('confirmLeave')?.addEventListener('click', confirmLeaveGroup);

    setupSidebarMenu();

    // Legacy logout & dark mode buttons, if an older HTML build still has them
    document.getElementById('logoutBtn')?.addEventListener('click', logout);
    document.getElementById('toggleDark')?.addEventListener('click', toggleDarkMode);

    // Emoji picker
    document.querySelectorAll('.emoji-toggle').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const input = e.target.closest('.message-input-container')?.querySelector('textarea');
            if (input && window.emojiPicker) window.emojiPicker.toggle(input);
        });
    });
}

function setupSidebarMenu() {
    const menuBtn  = document.getElementById('sidebarMenuBtn');
    const dropdown = document.getElementById('sidebarDropdown');
    if (!menuBtn || !dropdown || menuBtn.dataset.bound === 'true') return;

    menuBtn.dataset.bound = 'true';

    const closeMenu = () => dropdown.classList.remove('open');
    const runAndClose = (handler) => {
        closeMenu();
        if (handler) handler();
    };

    menuBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        dropdown.classList.toggle('open');
    });

    document.addEventListener('click', (e) => {
        if (!dropdown.contains(e.target) && e.target !== menuBtn) closeMenu();
    });

    document.getElementById('sdropProfile')?.addEventListener('click', () => {
        runAndClose(() => window.profileManager?.open());
    });
    document.getElementById('sdropTheme')?.addEventListener('click', () => {
        // Close dropdown first, then open theme panel
        document.getElementById('sidebarDropdown')?.classList.remove('open');
        if (window.ThemeManager) ThemeManager.openPanel();
        else toggleDarkMode();
    });
    document.getElementById('sdropPrivate')?.addEventListener('click', () => {
        runAndClose(() => window.privateChatsManager?.openMenu());
    });
    document.getElementById('sdropBlocked')?.addEventListener('click', () => {
        runAndClose(() => window.privateChatsManager?.openBlockedContacts());
    });
    document.getElementById('sdropNotifications')?.addEventListener('click', () => {
        runAndClose(requestNotificationPermission);
    });
    document.getElementById('sdropHelp')?.addEventListener('click', () => {
        runAndClose(() => {
            const helpModal = document.getElementById('helpAboutModal');
            if (helpModal) helpModal.style.display = 'flex';
        });
    });
    document.getElementById('sdropLogout')?.addEventListener('click', () => {
        runAndClose(logout);
    });
    document.getElementById('closeHelpModal')?.addEventListener('click', () => {
        const helpModal = document.getElementById('helpAboutModal');
        if (helpModal) helpModal.style.display = 'none';
    });

    if (window._syncThemeDropdownLabel) window._syncThemeDropdownLabel();
}

// ── Logout ────────────────────────────────────────────────────
async function logout() {
    try {
        if (currentUser) {
            await db.collection('users').doc(currentUser.uid).update({
                status: 'offline', lastSeen: new Date()
            });
        }
        friendsPresenceUnsubscribers.forEach(unsub => unsub());
        friendsPresenceUnsubscribers = [];
        localStorage.removeItem(`${LOGIN_VERIFIED_PREFIX}${currentUser.uid}`);
        localStorage.removeItem('educhat_last_verified_uid');
        await auth.signOut();
        window.location.href = 'index.html';
    } catch (error) {
        console.error('Logout error:', error);
        window.location.href = 'index.html';
    }
}

// Init Drive file sharing after GIS loads
window.addEventListener('load', () => {
    setTimeout(() => {
        if (window.driveShare) window.driveShare.init();
    }, 1500);
});

// ── Vanish Mode Banner ────────────────────────────────────────
let _vanishBannerUnsub = null;

function _showVanishBanner(on) {
    const existing = document.getElementById('vanishModeBanner');
    if (existing) existing.remove();
    if (!on) return;
    const individualChat = document.getElementById('individualChat');
    if (!individualChat) return;
    const banner = document.createElement('div');
    banner.id        = 'vanishModeBanner';
    banner.className = 'vanish-mode-banner';
    banner.innerHTML = `
        <span class="vanish-banner-icon">👻</span>
        <span class="vanish-banner-text">Vanish Mode is <strong>ON</strong> — messages will disappear when turned off</span>
    `;
    const chatHeader = individualChat.querySelector('.chat-header');
    if (chatHeader && chatHeader.nextSibling) {
        individualChat.insertBefore(banner, chatHeader.nextSibling);
    } else {
        individualChat.prepend(banner);
    }
}

function updateVanishBanner(friendUID) {
    // Unsubscribe previous listener
    if (_vanishBannerUnsub) { _vanishBannerUnsub(); _vanishBannerUnsub = null; }

    const existing = document.getElementById('vanishModeBanner');
    if (existing) existing.remove();

    if (!friendUID || !currentUser) return;
    const chatId = generateChatId(currentUser.uid, friendUID);

    // Listen to Firestore for real-time vanish state (syncs with other user)
    _vanishBannerUnsub = db.collection('vanishMode').doc(chatId).onSnapshot(doc => {
        // Only update banner if still in the same chat
        if (chatWithUID !== friendUID) return;
        const enabled = doc.exists && doc.data()?.enabled === true;
        // Keep localStorage in sync
        localStorage.setItem(`vanishMode_${chatId}`, enabled ? 'true' : 'false');
        _showVanishBanner(enabled);

        // If vanish was turned OFF by the other person, hard-delete vanish messages
        if (!enabled && doc.exists && doc.data()?.toggledBy !== currentUser.uid) {
            if (window.deleteVanishMessages) window.deleteVanishMessages(chatId);
        }
    });
}
window.updateVanishBanner = updateVanishBanner;

window.initializeApp      = initializeApp;
window.switchTab          = switchTab;
window.openChat           = openChat;

// ── openChatById — notification tap నుండి call అవుతుంది ──────
// chatId format: "uid1_uid2" (direct) లేదా groupId (group)
function openChatById(chatId, isGroup) {
    if (!chatId) return;
    if (isGroup) {
        if (window.openGroupChat) window.openGroupChat(chatId);
        return;
    }
    // Direct chat: chatId లో current user uid కాకుండా ఉన్న uid extract చేయాలి
    if (!currentUser) return;
    const parts = chatId.split('_');
    const friendUID = parts.find(p => p !== currentUser.uid);
    if (friendUID) openChat(friendUID);
}
window.openChatById = openChatById;
window.updateUI           = updateUI;
window.logout             = logout;

console.log('app.js loaded');

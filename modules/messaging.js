// ============================================================
//  messaging.js — Message display, send, scroll, typing,
//                 seen receipts, pin, voice recording
// ============================================================

// ── Scroll to bottom helper (FIX: chat top problem) ─────────
function scrollToBottom(containerId) {
    const el = document.getElementById(containerId);
    if (el) {
        // Use requestAnimationFrame so the DOM is painted first
        requestAnimationFrame(() => {
            el.scrollTop = el.scrollHeight;
        });
    }
}

// ── Message rendering helpers ─────────────────────────────────
function renderMessageActions(msg, isSent) {
    const safeId   = escapeAttribute(msg.id || '');
    const isPinned = msg.pinned;
    const I = window.Icons;
    const replyIcon  = I ? I.get('reply',   16) : '↩';
    const fwdIcon    = I ? I.get('forward', 16) : '↪';
    const pinIcon    = isPinned ? (I ? I.get('pinFill',16) : '⊕') : (I ? I.get('pin',16) : '⊕');
    const trashIcon  = I ? I.get('trash',   16) : '[del]';
    return `
        <div class="msg-actions">
            <button class="msg-action-btn" data-action="reply"   data-id="${safeId}" title="Reply">${replyIcon}</button>
            <button class="msg-action-btn" data-action="forward" data-id="${safeId}" title="Forward">${fwdIcon}</button>
            <button class="msg-action-btn${isPinned ? ' pinned-active' : ''}" data-action="pin" data-id="${safeId}" title="${isPinned ? 'Unpin' : 'Pin'}">${pinIcon}</button>
            <button class="msg-action-btn msg-action-delete" data-action="delete" data-id="${safeId}" title="Delete">${trashIcon}</button>
        </div>
    `;
}

function renderReplyQuote(msg) {
    if (!msg.replyTo) return '';
    return `
        <div class="reply-quote">
            <span class="reply-quote-author">${escapeHTML(msg.replyTo.senderName || 'User')}</span>
            <span class="reply-quote-text">${escapeHTML((msg.replyTo.text || '').substring(0, 80))}</span>
        </div>
    `;
}

function renderSeenTicks(msg, isSent) {
    if (!isSent) return '';
    const I    = window.Icons;
    const seen = msg.seenBy && msg.seenBy.some(uid => uid !== currentUser.uid);
    if (I) {
        return seen
            ? `<span class="msg-ticks ticks-seen" title="Seen">${I.get('checkDouble', 14)}</span>`
            : `<span class="msg-ticks ticks-delivered" title="Delivered">${I.get('check', 14)}</span>`;
    }
    return seen
        ? '<span class="msg-ticks ticks-seen">✓✓</span>'
        : '<span class="msg-ticks ticks-delivered">✓</span>';
}

function renderVoiceMessage(msg) {
    const safeUrl = escapeAttribute(msg.audioUrl || '');
    const dur     = msg.audioDuration ? `${Math.floor(msg.audioDuration)}s` : '';
    const I = window.Icons;
    const playIcon  = I ? I.get('play',  18) : '▶';
    const pauseIcon = I ? I.get('pause', 18) : '⏸';
    return `
        <div class="voice-msg-bubble">
            <button class="voice-play-btn" data-playing="false"
                onclick="
                    const a=this.nextElementSibling;
                    const playing=a.paused;
                    playing?a.play():a.pause();
                    this.dataset.playing=playing?'true':'false';
                    this.innerHTML=playing?'${pauseIcon.replace(/'/g,"\\'")}':'${playIcon.replace(/'/g,"\\'")}';
                ">${playIcon}</button>
            <audio src="${safeUrl}" style="display:none"
                onended="this.previousElementSibling.dataset.playing='false';this.previousElementSibling.innerHTML='${playIcon.replace(/'/g,"\\'")}';"></audio>
            <div class="voice-waveform">
                <div class="voice-wave-bar"></div><div class="voice-wave-bar"></div><div class="voice-wave-bar"></div>
                <div class="voice-wave-bar"></div><div class="voice-wave-bar"></div><div class="voice-wave-bar"></div>
                <div class="voice-wave-bar"></div><div class="voice-wave-bar"></div>
            </div>
            <span class="voice-duration">${dur}</span>
        </div>
    `;
}

function buildMessageHTML(msg, isSent, isGroup) {
    const I          = window.Icons;
    const rawTime    = msg.time || msg.timestamp || Date.now();
    const time       = rawTime?.toDate ? rawTime.toDate() : new Date(rawTime);
    const timeString = time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const dateLabel  = getDateLabel(time);

    if (msg.type === 'call') {
        const callIcon = msg.callType === 'video' ? (I ? I.get('callVideo',16) : '[video]') : (I ? I.get('callPhone',16) : '[call]');
        const missed   = msg.missed ? ' · Missed' : (msg.duration ? ` · ${msg.duration}` : '');
        const who      = isSent ? 'Outgoing call' : 'Incoming call';
        return { html: `
            <div class="message call-log">
                <div class="call-log-bubble">
                    <span class="call-log-icon">${callIcon}</span>
                    <span class="call-log-label">${who}${missed}</span>
                    <span class="call-log-time">${timeString}</span>
                </div>
            </div>
        `, dateLabel };
    }

    if (msg.deletedForAll) {
        return { html: `
            <div class="message ${isSent ? 'sent' : 'received'} deleted-msg">
                <div class="message-text deleted-text"><span class="del-icon"></span> This message was deleted</div>
                <div class="message-time">${timeString}</div>
            </div>
        `, dateLabel };
    }

    if (msg.deletedFor && msg.deletedFor.includes(currentUser.uid)) {
        return { html: '', dateLabel };
    }

    let bodyHtml;
    if (msg.type === 'voice') {
        bodyHtml = renderVoiceMessage(msg);
    } else if (msg.type === 'file' && window.driveShare) {
        bodyHtml = window.driveShare.renderFileMessage(msg, isSent);
    } else {
        bodyHtml = `<div class="message-text">${escapeHTML(msg.text || '').replace(/\n/g, '<br>')}</div>`;
    }

    const pinnedBadge = msg.pinned
        ? `<span class="pinned-badge">${I ? I.get('pinFill', 12) : ''}</span>`
        : '';
    const senderLabel = (isGroup && !isSent && msg.sender !== 'system')
        ? `<div class="message-sender">${escapeHTML(msg.senderName || 'User')}</div>` : '';
    const reactionsHTML = window.chatInteractions
        ? window.chatInteractions.buildReactionsHTML(msg.reactions)
        : '';

    return { html: `
        <div class="message ${isSent ? 'sent' : 'received'}${msg.pinned ? ' is-pinned' : ''}" data-id="${escapeAttribute(msg.id || '')}">
            ${renderMessageActions(msg, isSent)}
            ${senderLabel}
            ${renderReplyQuote(msg)}
            ${bodyHtml}
            <div class="message-time">
                ${pinnedBadge}
                ${timeString}
                ${renderSeenTicks(msg, isSent)}
            </div>
            ${reactionsHTML}
        </div>
    `, dateLabel };
}

// ── Shared render core ────────────────────────────────────────
function renderMessagesToHTML(messages, isGroup) {
    let html = '';
    let lastDateLabel = null;
    let archivedSectionStarted = false;
    let archivedSectionEnded   = false;

    messages.forEach(msg => {
        const isSent = msg.sender === currentUser.uid;

        if (msg._archived && !archivedSectionStarted) {
            html += `<div class="date-separator" style="opacity:0.6"><span>Archived messages</span></div>`;
            archivedSectionStarted = true;
        }
        if (!msg._archived && archivedSectionStarted && !archivedSectionEnded) {
            html += `<div class="date-separator" style="opacity:0.6"><span>─── Recent messages ───</span></div>`;
            archivedSectionEnded = true;
        }

        const { html: msgHtml, dateLabel } = buildMessageHTML(msg, isSent, isGroup);

        if (dateLabel !== lastDateLabel) {
            html += `<div class="date-separator"><span>${dateLabel}</span></div>`;
            lastDateLabel = dateLabel;
        }

        html += msgHtml;
    });
    return html;
}

// ── Direct messages display ──────────────────────────────────
function displayMessages(messages) {
    const chatContainer = document.getElementById('chat');
    if (!chatContainer) return;

    renderPinnedBanner(messages.find(m => m.pinned && !m.deletedForAll), 'direct');
    markMessagesAsSeen(messages);

    chatContainer.innerHTML = renderMessagesToHTML(messages, false);
    attachMessageActionListeners(chatContainer, messages, 'direct');
    window.chatInteractions?.attach(chatContainer, messages, 'direct');

    // FIX: always scroll to bottom after rendering
    scrollToBottom('chat');
}

// ── Group messages display ───────────────────────────────────
function displayGroupMessages(messages) {
    const chatContainer = document.getElementById('groupChat');
    if (!chatContainer) return;

    renderPinnedBanner(messages.find(m => m.pinned && !m.deletedForAll), 'group');

    chatContainer.innerHTML = renderMessagesToHTML(messages, true);
    attachMessageActionListeners(chatContainer, messages, 'group');
    window.chatInteractions?.attach(chatContainer, messages, 'group');

    // FIX: always scroll to bottom after rendering
    scrollToBottom('groupChat');
}

// ── Load direct messages ─────────────────────────────────────
async function loadMessages() {
    const chatContainer = document.getElementById('chat');
    if (!chatContainer) return;

    // FIX: chatWithUID ని local variable లో capture చేయాలి
    // async await తర్వాత chatWithUID change అయిపోయే race condition fix
    const capturedUID = chatWithUID;
    const chatId = generateChatId(currentUser.uid, capturedUID);

    directMsgLastDoc      = null;
    directMsgAllLoaded    = false;

    if (unsubscribeDirectMessages) {
        unsubscribeDirectMessages();
        unsubscribeDirectMessages = null;
    }

    // Show cached messages immediately
    const cachedMessages = await hybridCache.getMessages(chatId);
    // FIX: await తర్వాత user వేరే chat కి switch అయి ఉంటే — stale display skip చేయాలి
    if (cachedMessages && cachedMessages.length > 0 && chatWithUID === capturedUID) {
        displayMessages(cachedMessages);
    }

    // FIX: switch అయ్యాక subscription ని create చేయకూడదు
    if (chatWithUID !== capturedUID) return;

    // Inject archive button
    autoBackup.hasArchives(chatId, 'direct').then(() => {
        injectArchiveButton(chatContainer, chatId, 'direct');
    });

    let prevMessageCount = 0;
    let firstMsgSnapshot = true;

    try {
        unsubscribeDirectMessages = db.collection('messages')
            .where('chatId', '==', chatId)
            .orderBy('time', 'desc')
            .limit(MSG_PAGE_SIZE)
            .onSnapshot(snapshot => {
                // FIX: Snapshot callback లో wrong chat update కాకుండా guard చేయాలి
                if (chatWithUID !== capturedUID) return;

                if (!snapshot.empty) {
                    directMsgLastDoc = snapshot.docs[snapshot.docs.length - 1];
                }

                const messages = [];
                snapshot.forEach(doc => messages.push({ id: doc.id, ...doc.data() }));
                messages.sort((a, b) => {
                    const tA = a.time?.toDate ? a.time.toDate().getTime() : new Date(a.time).getTime();
                    const tB = b.time?.toDate ? b.time.toDate().getTime() : new Date(b.time).getTime();
                    return tA - tB;
                });

                // Notify on new incoming message
                if (!firstMsgSnapshot && messages.length > prevMessageCount) {
                    const newest = messages[messages.length - 1];
                    if (newest && newest.sender !== currentUser.uid) {
                        badgeManager.playNotificationSound();
                        if (document.visibilityState !== 'visible' && Notification.permission === 'granted') {
                            new Notification('EduChat — New Message', { body: newest.text, icon: '/favicon.ico' });
                        }
                        getUserData(newest.sender).then(senderData => {
                            toastManager.show({
                                icon: null, type: 'message', title: senderData?.name || 'New Message',
                                body: newest.text, type: 'message', onClick: () => {}
                            });
                        });
                    }
                }

                firstMsgSnapshot = false;
                prevMessageCount = messages.length;
                displayMessages(messages);
                hybridCache.setMessages(chatId, messages);
            }, error => {
                // Index not yet built — fall back to unordered query (client-side sort still works)
                console.warn('loadMessages: index not ready, falling back to unordered query:', error.code);
                if (error.code === 'failed-precondition') {
                    unsubscribeDirectMessages = db.collection('messages')
                        .where('chatId', '==', chatId)
                        .onSnapshot(snapshot => {
                            const messages = [];
                            snapshot.forEach(doc => messages.push({ id: doc.id, ...doc.data() }));
                            messages.sort((a, b) => {
                                const tA = a.time?.toDate ? a.time.toDate().getTime() : new Date(a.time).getTime();
                                const tB = b.time?.toDate ? b.time.toDate().getTime() : new Date(b.time).getTime();
                                return tA - tB;
                            });
                            displayMessages(messages);
                            hybridCache.setMessages(chatId, messages);
                        }, err2 => console.error('loadMessages fallback error:', err2));
                }
            });
    } catch (error) {
        console.error('Error loading messages:', error);
    }
}

// ── Load group messages ──────────────────────────────────────
async function loadGroupMessages() {
    const chatContainer = document.getElementById('groupChat');
    if (!chatContainer) return;

    if (unsubscribeGroupMessages) {
        unsubscribeGroupMessages();
        unsubscribeGroupMessages = null;
    }

    injectArchiveButton(chatContainer, groupChatID, 'group');

    let prevGroupMsgCount  = 0;
    let firstGroupSnapshot = true;

    try {
        unsubscribeGroupMessages = db.collection('groupMessages')
            .where('groupId', '==', groupChatID)
            .orderBy('time', 'desc')
            .limit(MSG_PAGE_SIZE)
            .onSnapshot(snapshot => {
                if (!snapshot.empty) groupMsgLastDoc = snapshot.docs[snapshot.docs.length - 1];

                const messages = [];
                snapshot.forEach(doc => messages.push({ id: doc.id, ...doc.data() }));
                messages.sort((a, b) => {
                    const tA = a.time?.toDate ? a.time.toDate().getTime() : new Date(a.time).getTime();
                    const tB = b.time?.toDate ? b.time.toDate().getTime() : new Date(b.time).getTime();
                    return tA - tB;
                });

                if (!firstGroupSnapshot && messages.length > prevGroupMsgCount) {
                    const newest = messages[messages.length - 1];
                    if (newest && newest.sender !== currentUser.uid && newest.sender !== 'system') {
                        badgeManager.playNotificationSound();
                        if (document.visibilityState !== 'visible' && Notification.permission === 'granted') {
                            const groupChatName = document.getElementById('groupChatName');
                            new Notification(`EduChat — ${groupChatName?.textContent || 'Group'}`, {
                                body: `${newest.senderName || 'Someone'}: ${newest.text}`, icon: '/favicon.ico'
                            });
                        }
                        const groupChatNameEl = document.getElementById('groupChatName');
                        toastManager.show({
                            icon: null, type: 'message',
                            title: groupChatNameEl?.textContent || 'Group Message',
                            body: `${newest.senderName || 'Someone'}: ${newest.text}`,
                            type: 'group'
                        });
                    }
                }

                firstGroupSnapshot = false;
                prevGroupMsgCount  = messages.length;
                displayGroupMessages(messages);
            }, error => {
                // Index not yet built — fall back to unordered query
                console.warn('loadGroupMessages: index not ready, falling back:', error.code);
                if (error.code === 'failed-precondition') {
                    unsubscribeGroupMessages = db.collection('groupMessages')
                        .where('groupId', '==', groupChatID)
                        .onSnapshot(snapshot => {
                            const messages = [];
                            snapshot.forEach(doc => messages.push({ id: doc.id, ...doc.data() }));
                            messages.sort((a, b) => {
                                const tA = a.time?.toDate ? a.time.toDate().getTime() : new Date(a.time).getTime();
                                const tB = b.time?.toDate ? b.time.toDate().getTime() : new Date(b.time).getTime();
                                return tA - tB;
                            });
                            displayGroupMessages(messages);
                        }, err2 => console.error('loadGroupMessages fallback error:', err2));
                }
            });
    } catch (error) {
        console.error('Error loading group messages:', error);
    }
}

// ── Load older direct messages ───────────────────────────────
async function loadOlderDirectMessages() {
    if (directMsgLoadingOlder || directMsgAllLoaded || !directMsgLastDoc) return;
    const chatId        = generateChatId(currentUser.uid, chatWithUID);
    const chatContainer = document.getElementById('chat');
    directMsgLoadingOlder = true;

    const btn = document.getElementById('loadOlderBtn');
    if (btn) btn.textContent = 'Loading...';

    try {
        const snap = await db.collection('messages')
            .where('chatId', '==', chatId)
            .orderBy('time', 'desc')
            .startAfter(directMsgLastDoc)
            .limit(MSG_PAGE_SIZE)
            .get();

        if (snap.empty || snap.docs.length < MSG_PAGE_SIZE) {
            directMsgAllLoaded = true;
            if (btn) btn.style.display = 'none';
        } else {
            directMsgLastDoc = snap.docs[snap.docs.length - 1];
            if (btn) btn.textContent = 'Load older messages';
        }

        const older = [];
        snap.forEach(doc => older.push({ id: doc.id, ...doc.data() }));
        older.sort((a, b) => {
            const tA = a.time?.toDate ? a.time.toDate().getTime() : new Date(a.time).getTime();
            const tB = b.time?.toDate ? b.time.toDate().getTime() : new Date(b.time).getTime();
            return tA - tB;
        });

        const prevHeight = chatContainer.scrollHeight;
        const cachedNow  = (await hybridCache.getMessages(chatId)) || [];
        displayMessages([...older, ...cachedNow]);
        // Restore scroll position (don't jump to bottom for older messages)
        requestAnimationFrame(() => {
            chatContainer.scrollTop = chatContainer.scrollHeight - prevHeight;
        });
    } catch (e) {
        console.error('loadOlderDirectMessages error:', e);
    } finally {
        directMsgLoadingOlder = false;
    }
}

// ── Load older group messages ────────────────────────────────
async function loadOlderGroupMessages() {
    if (groupMsgAllLoaded || !groupMsgLastDoc) return;
    const chatContainer = document.getElementById('groupChat');
    if (!chatContainer) return;

    const btn = document.getElementById('loadOlderBtn');
    if (btn) btn.textContent = 'Loading...';

    try {
        const snap = await db.collection('groupMessages')
            .where('groupId', '==', groupChatID)
            .orderBy('time', 'desc')
            .startAfter(groupMsgLastDoc)
            .limit(MSG_PAGE_SIZE)
            .get();

        if (snap.empty || snap.docs.length < MSG_PAGE_SIZE) {
            groupMsgAllLoaded = true;
            if (btn) btn.style.display = 'none';
        } else {
            groupMsgLastDoc = snap.docs[snap.docs.length - 1];
            if (btn) btn.textContent = 'Load older messages';
        }

        const older = [];
        snap.forEach(doc => older.push({ id: doc.id, ...doc.data() }));
        older.sort((a, b) => {
            const tA = a.time?.toDate ? a.time.toDate().getTime() : new Date(a.time).getTime();
            const tB = b.time?.toDate ? b.time.toDate().getTime() : new Date(b.time).getTime();
            return tA - tB;
        });

        const prevHeight = chatContainer.scrollHeight;
        const cachedNow  = (await hybridCache.getMessages(groupChatID)) || [];
        displayGroupMessages([...older, ...cachedNow]);
        requestAnimationFrame(() => {
            chatContainer.scrollTop = chatContainer.scrollHeight - prevHeight;
        });
    } catch (e) {
        console.error('loadOlderGroupMessages error:', e);
        if (btn) btn.textContent = 'Load older messages';
    }
}

// ── Archive button injection ─────────────────────────────────
function injectArchiveButton(container, chatId, type) {
    if (document.getElementById('loadOlderBtn')) return;

    const wrap     = document.createElement('div');
    wrap.style.cssText = 'text-align:center;padding:8px 0 4px;';

    const olderBtn = document.createElement('button');
    olderBtn.id    = 'loadOlderBtn';
    olderBtn.textContent = 'Load older messages';
    olderBtn.style.cssText = 'font-size:12px;padding:4px 14px;border-radius:20px;border:1px solid #ccc;background:transparent;cursor:pointer;margin-right:6px;';
    olderBtn.onclick = () => type === 'group' ? loadOlderGroupMessages() : loadOlderDirectMessages();

    const archBtn = document.createElement('button');
    archBtn.id    = 'loadArchiveBtn';
    archBtn.textContent = 'Load archived messages';
    archBtn.style.cssText = 'font-size:12px;padding:4px 14px;border-radius:20px;border:1px solid #6366f1;color:#6366f1;background:transparent;cursor:pointer;';
    archBtn.onclick = () => loadArchivedMessages(chatId, type);

    wrap.appendChild(olderBtn);
    wrap.appendChild(archBtn);
    container.insertBefore(wrap, container.firstChild);
}

// ── Load archived messages ───────────────────────────────────
async function loadArchivedMessages(chatId, type) {
    const chatContainer = document.getElementById(type === 'group' ? 'groupChat' : 'chat');
    if (!chatContainer) return;

    const archBtn = document.getElementById('loadArchiveBtn');
    if (archBtn) { archBtn.textContent = 'Fetching from Drive...'; archBtn.disabled = true; }

    showToast('Loading archived messages from Drive...', 'info');

    const archived = await autoBackup.fetchArchived(chatId, type);

    if (archived.length === 0) {
        showToast('No archived messages found', 'info');
        if (archBtn) { archBtn.textContent = 'Load archived messages'; archBtn.disabled = false; }
        return;
    }

    const cachedNow    = (await hybridCache.getMessages(chatId)) || [];
    const normalised   = archived.map(m => ({ ...m, _archived: true }));
    const allMsgs      = [...normalised, ...cachedNow];

    if (type === 'group') displayGroupMessages(allMsgs);
    else                  displayMessages(allMsgs);

    if (archBtn) archBtn.style.display = 'none';
    showToast(`Loaded ${archived.length} archived messages`, 'success');
}

// ── Send direct message ──────────────────────────────────────
async function sendMessage() {
    const input = document.getElementById('msg');
    if (!input) return;
    const text = input.value.trim();
    if (!text || !chatWithUID) return;

    try {
        const chatId  = generateChatId(currentUser.uid, chatWithUID);
        const msgData = {
            chatId,
            participants: [currentUser.uid, chatWithUID],
            sender: currentUser.uid,
            text,
            time: new Date(),
            type: 'text',
            delivered: true,
            seenBy: []
        };
        if (replyingTo) msgData.replyTo = replyingTo;

        await db.collection('messages').add(msgData);
        input.value = '';
        input.style.height = 'auto';
        cancelReply('directReplyBar');
        clearTypingIndicator();

        await db.collection('users').doc(chatWithUID).update({
            [`unreadCounts.${chatId}`]: firebase.firestore.FieldValue.increment(1)
        });

        // Push notification to receiver
        if (window.pushNotifications) {
            window.pushNotifications.notifyNewMessage({
                toUID:       chatWithUID,
                fromName:    currentUserData?.name || 'Someone',
                messageText: text,
                chatId,
                isGroup:     false
            });
        }
    } catch (error) {
        console.error('Error sending message:', error);
        modalManager.showModal('Error', 'Failed to send message', 'error');
    }
}

// ── Send group message ───────────────────────────────────────
async function sendGroupMessage() {
    const input = document.getElementById('groupMsg');
    if (!input) return;
    const text = input.value.trim();
    if (!text || !groupChatID) return;

    try {
        const msgData = {
            groupId:    groupChatID,
            sender:     currentUser.uid,
            senderName: currentUserData?.name || 'User',
            text,
            time:       new Date(),
            type:       'text',
            delivered:  true,
            seenBy:     []
        };
        if (replyingTo) msgData.replyTo = replyingTo;

        await db.collection('groupMessages').add(msgData);
        input.value = '';
        input.style.height = 'auto';
        cancelReply('groupReplyBar');

        // Push notification to all group members (except sender)
        if (window.pushNotifications) {
            try {
                const groupDoc = await db.collection('groups').doc(groupChatID).get();
                const groupData = groupDoc.data();
                const members = (groupData?.members || []).filter(uid => uid !== currentUser.uid);
                const groupName = groupData?.name || 'Group';
                members.forEach(uid => {
                    window.pushNotifications.notifyNewMessage({
                        toUID:       uid,
                        fromName:    currentUserData?.name || 'Someone',
                        messageText: text,
                        chatId:      groupChatID,
                        isGroup:     true,
                        groupName
                    });
                });
            } catch (e) { /* non-critical */ }
        }
    } catch (error) {
        console.error('Error sending group message:', error);
        modalManager.showModal('Error', 'Failed to send message', 'error');
    }
}

// ── Reply helpers ────────────────────────────────────────────
async function setReply(msg, chatType) {
    let senderName = msg.senderName || '';
    if (!senderName) {
        if (msg.sender === currentUser.uid) {
            senderName = currentUserData?.name || 'You';
        } else {
            const ud = await getUserData(msg.sender).catch(() => null);
            senderName = ud?.name || 'User';
        }
    }
    replyingTo = { id: msg.id, text: msg.text || '', senderName };

    const inputId     = chatType === 'group' ? 'groupMsg' : 'msg';
    const containerId = chatType === 'group' ? 'groupReplyBar' : 'directReplyBar';

    let bar = document.getElementById(containerId);
    if (!bar) {
        const inputArea = document.getElementById(inputId)?.closest('.message-input');
        if (inputArea) {
            bar = document.createElement('div');
            bar.id        = containerId;
            bar.className = 'reply-bar';
            bar.innerHTML = `
                <div class="reply-bar-inner">
                    <span class="reply-bar-icon">${window.Icons ? window.Icons.get('reply', 16) : '↩'}</span>
                    <div class="reply-bar-content">
                        <span class="reply-bar-author">${escapeHTML(replyingTo.senderName)}</span>
                        <span class="reply-bar-text">${escapeHTML(replyingTo.text.substring(0, 60))}</span>
                    </div>
                    <button class="reply-bar-cancel" id="${containerId}Cancel">${window.Icons ? window.Icons.get('close', 16) : '✕'}</button>
                </div>
            `;
            inputArea.insertBefore(bar, inputArea.firstChild);
            document.getElementById(containerId + 'Cancel').onclick = () => cancelReply(containerId);
        }
    } else {
        bar.querySelector('.reply-bar-author').textContent = replyingTo.senderName;
        bar.querySelector('.reply-bar-text').textContent   = replyingTo.text.substring(0, 60);
        bar.style.display = '';
    }
    document.getElementById(inputId)?.focus();
}

function cancelReply(containerId) {
    replyingTo = null;
    const bar  = document.getElementById(containerId);
    if (bar) bar.style.display = 'none';
}

// ── Delete menu ──────────────────────────────────────────────
async function showDeleteMenu(msgId, chatType) {
    const overlay = document.createElement('div');
    overlay.className = 'delete-overlay';
    overlay.innerHTML = `
        <div class="delete-sheet">
            <p class="delete-sheet-title">Delete message?</p>
            <button class="delete-opt delete-for-me">Delete for Me</button>
            <button class="delete-opt delete-for-all">Delete for Everyone</button>
            <button class="delete-opt delete-cancel">Cancel</button>
        </div>
    `;
    document.body.appendChild(overlay);

    const collection = chatType === 'group' ? 'groupMessages' : 'messages';

    overlay.querySelector('.delete-for-me').onclick = async () => {
        try {
            await db.collection(collection).doc(msgId).update({
                deletedFor: firebase.firestore.FieldValue.arrayUnion(currentUser.uid)
            });
        } catch (e) { console.error(e); }
        overlay.remove();
    };
    overlay.querySelector('.delete-for-all').onclick = async () => {
        try {
            await db.collection(collection).doc(msgId).update({ deletedForAll: true });
        } catch (e) { console.error(e); }
        overlay.remove();
    };
    overlay.querySelector('.delete-cancel').onclick = () => overlay.remove();
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
}

// ── Forward modal ────────────────────────────────────────────
async function showForwardModal(msg) {
    const friends = currentUserData.friends || [];
    if (friends.length === 0) {
        modalManager.showModal('Forward', 'No friends to forward to.', 'info');
        return;
    }

    const overlay = document.createElement('div');
    overlay.className = 'delete-overlay';

    let friendsHtml = '';
    for (const uid of friends) {
        const fd = await getUserData(uid);
        if (fd) friendsHtml += `<button class="forward-friend-btn" data-uid="${escapeAttribute(uid)}">${escapeHTML(fd.name)}</button>`;
    }

    overlay.innerHTML = `
        <div class="delete-sheet">
            <p class="delete-sheet-title">Forward to...</p>
            <div class="forward-list">${friendsHtml}</div>
            <button class="delete-opt delete-cancel" style="margin-top:8px">Cancel</button>
        </div>
    `;
    document.body.appendChild(overlay);

    overlay.querySelectorAll('.forward-friend-btn').forEach(btn => {
        btn.onclick = async () => {
            const toUID  = btn.dataset.uid;
            const chatId = generateChatId(currentUser.uid, toUID);
            try {
                await db.collection('messages').add({
                    chatId,
                    participants: [currentUser.uid, toUID],
                    sender:       currentUser.uid,
                    text:         msg.text || '',
                    time:         new Date(),
                    type:         msg.type || 'text',
                    forwarded:    true
                });
                await db.collection('users').doc(toUID).update({
                    [`unreadCounts.${chatId}`]: firebase.firestore.FieldValue.increment(1)
                });
            } catch (e) { console.error(e); }
            overlay.remove();
            toastManager.show({ icon: null, type: 'success', title: 'Forwarded', body: `Message forwarded to ${btn.textContent}`, type: 'message', duration: 2500 });
        };
    });
    overlay.querySelector('.delete-cancel').onclick = () => overlay.remove();
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
}

// ── Attach action listeners ───────────────────────────────────
function attachMessageActionListeners(container, messages, chatType) {
    container.querySelectorAll('.msg-action-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const action = btn.dataset.action;
            const msgId  = btn.dataset.id;
            const msg    = messages.find(m => m.id === msgId);
            if (!msg) return;

            if (action === 'reply')   await setReply(msg, chatType);
            else if (action === 'forward') showForwardModal(msg);
            else if (action === 'delete')  showDeleteMenu(msgId, chatType);
            else if (action === 'pin')     togglePinMessage(msgId, chatType, !msg.pinned);
        });
    });
}

// ── Typing indicator ─────────────────────────────────────────
function setTypingIndicator(isTyping) {
    if (!chatWithUID || !currentUser) return;
    const chatId = generateChatId(currentUser.uid, chatWithUID);
    const ref    = db.collection('typing').doc(chatId);
    ref.set({ [currentUser.uid]: isTyping }, { merge: true }).catch(() => {});
}

function clearTypingIndicator() {
    if (typingTimeout) clearTimeout(typingTimeout);
    setTypingIndicator(false);
}

function listenTypingIndicator() {
    if (!chatWithUID || !currentUser) return;
    if (unsubscribeTyping) { unsubscribeTyping(); unsubscribeTyping = null; }
    const chatId = generateChatId(currentUser.uid, chatWithUID);
    unsubscribeTyping = db.collection('typing').doc(chatId).onSnapshot(doc => {
        const data            = doc.data() || {};
        const isPartnerTyping = data[chatWithUID] === true;
        const el              = document.getElementById('typingIndicator');
        if (el) el.style.display = isPartnerTyping ? 'flex' : 'none';
    });
}

function onTypingInput() {
    setTypingIndicator(true);
    if (typingTimeout) clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => setTypingIndicator(false), 2500);
}

// ── Seen receipts ────────────────────────────────────────────
function markMessagesAsSeen(messages) {
    if (!chatWithUID || !currentUser) return;
    messages
        .filter(m => m.sender !== currentUser.uid && !(m.seenBy || []).includes(currentUser.uid) && !m.deletedForAll)
        .forEach(msg => {
            db.collection('messages').doc(msg.id).update({
                seenBy: firebase.firestore.FieldValue.arrayUnion(currentUser.uid)
            }).catch(() => {});
        });
}

// ── Pin messages ─────────────────────────────────────────────
async function togglePinMessage(msgId, chatType, shouldPin) {
    const collection = chatType === 'group' ? 'groupMessages' : 'messages';
    const chatId     = chatType === 'group' ? groupChatID : generateChatId(currentUser.uid, chatWithUID);
    const field      = chatType === 'group' ? 'groupId' : 'chatId';

    try {
        const pinned = await db.collection(collection).where(field, '==', chatId).where('pinned', '==', true).get();
        const batch  = db.batch();
        pinned.forEach(doc => batch.update(doc.ref, { pinned: false }));
        if (shouldPin) batch.update(db.collection(collection).doc(msgId), { pinned: true });
        await batch.commit();
        toastManager.show({ icon: null, type: shouldPin ? 'success' : 'info', title: shouldPin ? 'Message pinned' : 'Message unpinned', body: '', type: 'info', duration: 2000 });
    } catch (e) { console.error('Pin error:', e); }
}

function renderPinnedBanner(pinnedMsg, chatType) {
    const containerId = chatType === 'group' ? 'groupChat'       : 'chat';
    const bannerId    = chatType === 'group' ? 'groupPinnedBanner' : 'directPinnedBanner';

    let banner        = document.getElementById(bannerId);
    const container   = document.getElementById(containerId);
    if (!container) return;
    const parent = container.parentElement;
    if (!parent)  return;

    if (!pinnedMsg) { if (banner) banner.remove(); return; }

    if (!banner) {
        banner = document.createElement('div');
        banner.id        = bannerId;
        banner.className = 'pinned-banner';
        parent.insertBefore(banner, container);
    }

    const text = pinnedMsg.type === 'voice' ? 'Voice message' : (pinnedMsg.text || '').substring(0, 60);
    const I = window.Icons;
    const pinIc   = I ? I.get('pinFill', 16) : '📌';
    const closeIc = I ? I.get('close',   16) : '✕';
    banner.innerHTML = `
        <span class="pinned-banner-icon">${pinIc}</span>
        <div class="pinned-banner-content">
            <span class="pinned-banner-label">Pinned Message</span>
            <span class="pinned-banner-text">${escapeHTML(text)}</span>
        </div>
        <button class="pinned-banner-close" onclick="togglePinMessage('${escapeAttribute(pinnedMsg.id)}','${chatType}',false)">${closeIc}</button>
    `;
}

// ── Voice recording ──────────────────────────────────────────
async function startVoiceRecording(chatType) {
    if (isRecording) { stopVoiceRecording(chatType); return; }
    try {
        const stream  = await navigator.mediaDevices.getUserMedia({ audio: true });
        mediaRecorder = new MediaRecorder(stream);
        audioChunks   = [];
        isRecording   = true;
        recordingSeconds = 0;

        mediaRecorder.ondataavailable = e => { if (e.data.size > 0) audioChunks.push(e.data); };
        mediaRecorder.onstop = async () => {
            stream.getTracks().forEach(t => t.stop());
            const blob = new Blob(audioChunks, { type: 'audio/webm' });
            await uploadAndSendVoice(blob, recordingSeconds, chatType);
        };

        mediaRecorder.start(100);

        const btn = document.getElementById(chatType === 'group' ? 'groupVoiceBtn' : 'voiceBtn');
        if (btn) { btn.classList.add('recording'); btn.title = 'Stop recording'; btn.innerHTML = window.Icons ? window.Icons.get('micStop', 20) : '[stop]'; }

        const timerEl = document.getElementById(chatType === 'group' ? 'groupVoiceTimer' : 'voiceTimer');
        if (timerEl) timerEl.style.display = 'inline';

        recordingTimer = setInterval(() => {
            recordingSeconds++;
            if (timerEl) timerEl.textContent = `${Math.floor(recordingSeconds/60).toString().padStart(2,'0')}:${(recordingSeconds%60).toString().padStart(2,'0')}`;
            if (recordingSeconds >= 120) stopVoiceRecording(chatType);
        }, 1000);

    } catch (e) {
        console.error('Mic error:', e);
        modalManager.showModal('Error', 'Microphone access denied. Please allow mic permission.', 'error');
    }
}

function stopVoiceRecording(chatType) {
    if (!isRecording || !mediaRecorder) return;
    isRecording = false;
    if (recordingTimer) { clearInterval(recordingTimer); recordingTimer = null; }
    mediaRecorder.stop();

    const btn = document.getElementById(chatType === 'group' ? 'groupVoiceBtn' : 'voiceBtn');
    if (btn) { btn.classList.remove('recording'); btn.title = 'Voice message'; btn.innerHTML = window.Icons ? window.Icons.get('mic', 20) : '[mic]'; }

    const timerEl = document.getElementById(chatType === 'group' ? 'groupVoiceTimer' : 'voiceTimer');
    if (timerEl) { timerEl.style.display = 'none'; timerEl.textContent = '00:00'; }
}

async function uploadAndSendVoice(blob, duration, chatType) {
    try {
        const storage = firebase.storage ? firebase.storage() : null;
        let audioUrl  = '';

        if (storage) {
            const fileName = `voice_${currentUser.uid}_${Date.now()}.webm`;
            const ref      = storage.ref(`voice/${fileName}`);
            await ref.put(blob);
            audioUrl = await ref.getDownloadURL();
        } else {
            audioUrl = await new Promise(res => {
                const reader    = new FileReader();
                reader.onload   = () => res(reader.result);
                reader.readAsDataURL(blob);
            });
        }

        if (chatType === 'group') {
            await db.collection('groupMessages').add({
                groupId: groupChatID, sender: currentUser.uid,
                senderName: currentUserData?.name || 'User',
                type: 'voice', audioUrl, audioDuration: duration,
                time: new Date(), delivered: true, seenBy: []
            });
            if (replyingTo) cancelReply('groupReplyBar');
        } else {
            const chatId = generateChatId(currentUser.uid, chatWithUID);
            await db.collection('messages').add({
                chatId, participants: [currentUser.uid, chatWithUID],
                sender: currentUser.uid, type: 'voice', audioUrl,
                audioDuration: duration, time: new Date(), delivered: true, seenBy: []
            });
            await db.collection('users').doc(chatWithUID).update({
                [`unreadCounts.${chatId}`]: firebase.firestore.FieldValue.increment(1)
            });
        }
    } catch (e) {
        console.error('Voice upload error:', e);
        modalManager.showModal('Error', 'Failed to send voice message', 'error');
    }
}

// ── Mark as read ─────────────────────────────────────────────
function markChatAsRead(chatId) {
    if (unreadMap[chatId]) {
        unreadMap[chatId] = 0;
        db.collection('users').doc(currentUser.uid).update({
            [`unreadCounts.${chatId}`]: 0
        }).catch(console.error);
        loadFriendsList();
    }
}

// ── Expose ───────────────────────────────────────────────────
window.displayMessages       = displayMessages;
window.displayGroupMessages  = displayGroupMessages;
window.loadMessages          = loadMessages;
window.loadGroupMessages     = loadGroupMessages;
window.loadOlderDirectMessages = loadOlderDirectMessages;
window.loadOlderGroupMessages  = loadOlderGroupMessages;
window.sendMessage           = sendMessage;
window.sendGroupMessage      = sendGroupMessage;
window.setReply              = setReply;
window.cancelReply           = cancelReply;
window.showDeleteMenu        = showDeleteMenu;
window.showForwardModal      = showForwardModal;
window.togglePinMessage      = togglePinMessage;
window.renderPinnedBanner    = renderPinnedBanner;
window.startVoiceRecording   = startVoiceRecording;
window.stopVoiceRecording    = stopVoiceRecording;
window.markChatAsRead        = markChatAsRead;
window.listenTypingIndicator = listenTypingIndicator;
window.onTypingInput         = onTypingInput;
window.clearTypingIndicator  = clearTypingIndicator;
window.injectArchiveButton   = injectArchiveButton;
window.scrollToBottom        = scrollToBottom;

console.log('messaging.js loaded');

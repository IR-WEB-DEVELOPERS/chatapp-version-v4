// ============================================================
//  groupCall.js — Group Video/Voice Conference (Mesh WebRTC)
//  Each participant connects peer-to-peer with every other.
//  Firestore collection: groupCalls/{roomId}/peers/{uid}
// ============================================================

const GroupCallManager = (() => {

    // ── ICE servers (same as 1-to-1) ────────────────────────
    const ICE_CONFIG = {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun2.l.google.com:19302' },
        ]
    };

    // ── State ────────────────────────────────────────────────
    let _roomId       = null;   // groupChatID used as room
    let _localStream  = null;
    let _peers        = {};     // uid → { pc, stream, videoEl, audioMuted, videoMuted }
    let _unsubRoom    = null;   // Firestore room listener unsub
    let _unsubPeers   = null;   // Firestore peers collection unsub
    let _isVideoCall  = true;
    let _myUID        = null;
    let _myName       = null;
    let _audioMuted   = false;
    let _videoMuted   = false;
    let _active       = false;
    let _offerQueue   = {};     // uid → pending offer while pc not ready

    // ── Firestore refs ───────────────────────────────────────
    const _roomRef  = () => window.db.collection('groupCalls').doc(_roomId);
    const _peersRef = () => _roomRef().collection('peers');
    const _sigRef   = (uid) => _peersRef().doc(uid).collection('signals');

    // ─────────────────────────────────────────────────────────
    //  PUBLIC: Start a group call
    // ─────────────────────────────────────────────────────────
    async function startCall(groupId, isVideo = true) {
        if (_active) { console.warn('Group call already active'); return; }

        _roomId      = groupId;
        _isVideoCall = isVideo;
        _myUID       = window.currentUser.uid;
        _myName      = window.currentUserData?.name || 'Me';

        try {
            // 1. Get local media
            _localStream = await navigator.mediaDevices.getUserMedia({
                video: isVideo ? { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } } : false,
                audio: true
            });

            // 2. Register myself in Firestore room
            await _peersRef().doc(_myUID).set({
                uid:      _myUID,
                name:     _myName,
                isVideo:  isVideo,
                joined:   new Date(),
                active:   true
            });

            _active = true;

            // 3. Show UI
            _showCallUI();

            // 4. Listen for other peers joining/leaving
            _listenPeers();

            // 5. Listen for incoming signals addressed to me
            _listenMySignals();

            console.log('✅ Group call started, room:', _roomId);
        } catch (err) {
            console.error('Group call start error:', err);
            showToast('Camera/Mic access denied: ' + err.message, 'error');
            await _cleanup();
        }
    }

    // ─────────────────────────────────────────────────────────
    //  PRIVATE: Listen for peers joining / leaving
    // ─────────────────────────────────────────────────────────
    function _listenPeers() {
        _unsubPeers = _peersRef().onSnapshot(snap => {
            snap.docChanges().forEach(async change => {
                const uid  = change.doc.id;
                const data = change.doc.data();
                if (uid === _myUID) return;

                if (change.type === 'added' && data.active) {
                    // New peer joined → I initiate offer to them
                    console.log('👤 Peer joined:', uid);
                    await _connectToPeer(uid, data, true);
                    _addPeerTile(uid, data.name || uid.slice(0, 8));

                } else if (change.type === 'modified' && !data.active) {
                    // Peer left
                    console.log('👤 Peer left:', uid);
                    _removePeer(uid);

                } else if (change.type === 'removed') {
                    _removePeer(uid);
                }
            });
        });
    }

    // ─────────────────────────────────────────────────────────
    //  PRIVATE: Listen for signals sent TO me
    // ─────────────────────────────────────────────────────────
    function _listenMySignals() {
        _peersRef().doc(_myUID).collection('signals')
            .orderBy('created', 'asc')
            .onSnapshot(snap => {
                snap.docChanges().forEach(async change => {
                    if (change.type !== 'added') return;
                    const sig = change.doc.data();
                    const fromUID = sig.from;

                    if (sig.type === 'offer') {
                        console.log('📩 Got offer from', fromUID);
                        await _handleOffer(fromUID, sig);
                    } else if (sig.type === 'answer') {
                        console.log('📩 Got answer from', fromUID);
                        await _handleAnswer(fromUID, sig);
                    } else if (sig.type === 'candidate') {
                        await _handleCandidate(fromUID, sig);
                    }

                    // Delete processed signal
                    change.doc.ref.delete().catch(() => {});
                });
            });
    }

    // ─────────────────────────────────────────────────────────
    //  PRIVATE: Create RTCPeerConnection to a peer
    // ─────────────────────────────────────────────────────────
    async function _connectToPeer(uid, peerData, initiator) {
        if (_peers[uid]?.pc) return; // already connected

        const pc = new RTCPeerConnection(ICE_CONFIG);
        _peers[uid] = { pc, stream: null, audioMuted: false, videoMuted: false };

        // Add local tracks
        _localStream.getTracks().forEach(track => pc.addTrack(track, _localStream));

        // ICE candidates → send to peer
        pc.onicecandidate = async ({ candidate }) => {
            if (!candidate) return;
            await _sendSignal(uid, {
                type:      'candidate',
                from:      _myUID,
                candidate: candidate.toJSON()
            });
        };

        // Remote stream → attach to tile
        pc.ontrack = (event) => {
            const stream = event.streams[0];
            if (_peers[uid]) _peers[uid].stream = stream;
            _attachStream(uid, stream);
        };

        pc.onconnectionstatechange = () => {
            console.log(`Peer ${uid} connection:`, pc.connectionState);
            if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
                _removePeer(uid);
            }
        };

        if (initiator) {
            // Create & send offer
            const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: _isVideoCall });
            await pc.setLocalDescription(offer);
            await _sendSignal(uid, { type: 'offer', from: _myUID, sdp: offer.sdp });
        }

        return pc;
    }

    // ─────────────────────────────────────────────────────────
    //  PRIVATE: Handle incoming offer
    // ─────────────────────────────────────────────────────────
    async function _handleOffer(fromUID, sig) {
        if (!_peers[fromUID]?.pc) {
            await _connectToPeer(fromUID, {}, false);
        }
        const pc = _peers[fromUID].pc;
        if (!pc) return;

        await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: sig.sdp }));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await _sendSignal(fromUID, { type: 'answer', from: _myUID, sdp: answer.sdp });
    }

    async function _handleAnswer(fromUID, sig) {
        const pc = _peers[fromUID]?.pc;
        if (!pc) return;
        if (pc.signalingState !== 'have-local-offer') return;
        await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: sig.sdp }));
    }

    async function _handleCandidate(fromUID, sig) {
        const pc = _peers[fromUID]?.pc;
        if (!pc || !sig.candidate) return;
        try {
            await pc.addIceCandidate(new RTCIceCandidate(sig.candidate));
        } catch (e) { console.warn('ICE candidate error:', e); }
    }

    // ─────────────────────────────────────────────────────────
    //  PRIVATE: Send signal to a peer via Firestore
    // ─────────────────────────────────────────────────────────
    async function _sendSignal(targetUID, data) {
        try {
            await _peersRef().doc(targetUID).collection('signals').add({
                ...data,
                created: new Date()
            });
        } catch (e) { console.error('Signal send error:', e); }
    }

    // ─────────────────────────────────────────────────────────
    //  PRIVATE: Remove a peer
    // ─────────────────────────────────────────────────────────
    function _removePeer(uid) {
        if (_peers[uid]) {
            _peers[uid].pc?.close();
            delete _peers[uid];
        }
        const tile = document.getElementById(`gc-tile-${uid}`);
        if (tile) tile.remove();
        _updateLayout();
    }

    // ─────────────────────────────────────────────────────────
    //  UI: Show group call overlay
    // ─────────────────────────────────────────────────────────
    function _showCallUI() {
        const I = window.Icons;
        const overlay = document.createElement('div');
        overlay.id = 'groupCallOverlay';
        overlay.className = 'gc-overlay';
        overlay.innerHTML = `
            <div class="gc-header">
                <span class="gc-title">Group ${_isVideoCall ? 'Video' : 'Voice'} Call</span>
                <span class="gc-timer" id="gcTimer">00:00</span>
            </div>
            <div class="gc-grid" id="gcGrid">
                <!-- Local tile -->
                <div class="gc-tile gc-tile-local" id="gc-tile-local">
                    ${_isVideoCall
                        ? `<video id="gcLocalVideo" class="gc-video" autoplay playsinline muted></video>`
                        : `<div class="gc-avatar-placeholder"><span class="gc-initials">${(_myName[0]||'M').toUpperCase()}</span></div>`
                    }
                    <div class="gc-tile-name">You</div>
                    <div class="gc-tile-mute-icon" id="gc-mute-local" style="display:none">${I ? I.get('micStop', 16) : '🔇'}</div>
                </div>
            </div>
            <div class="gc-controls">
                <button class="gc-btn gc-btn-mute" id="gcMuteBtn" title="Mute/Unmute">
                    ${I ? I.get('micFill', 24) : '🎤'}
                </button>
                ${_isVideoCall ? `
                <button class="gc-btn gc-btn-video" id="gcVideoBtn" title="Camera on/off">
                    ${I ? I.get('videoFill', 24) : '📹'}
                </button>
                <button class="gc-btn gc-btn-cam" id="gcCamBtn" title="Switch Camera">
                    ${I ? I.get('switchCam', 24) : '🔄'}
                </button>` : ''}
                <button class="gc-btn gc-btn-end" id="gcEndBtn" title="End Call">
                    ${I ? I.get('phoneEnd', 24) : '📵'}
                </button>
            </div>
        `;
        document.body.appendChild(overlay);

        // Attach local video
        if (_isVideoCall) {
            const localVid = document.getElementById('gcLocalVideo');
            if (localVid) localVid.srcObject = _localStream;
        }

        // Controls
        document.getElementById('gcMuteBtn').addEventListener('click', _toggleAudio);
        if (_isVideoCall) {
            document.getElementById('gcVideoBtn').addEventListener('click', _toggleVideo);
            document.getElementById('gcCamBtn').addEventListener('click', _switchCamera);
        }
        document.getElementById('gcEndBtn').addEventListener('click', endCall);

        // Start timer
        _startTimer();
        _updateLayout();
    }

    // ─────────────────────────────────────────────────────────
    //  UI: Add remote peer tile
    // ─────────────────────────────────────────────────────────
    function _addPeerTile(uid, name) {
        const grid = document.getElementById('gcGrid');
        if (!grid || document.getElementById(`gc-tile-${uid}`)) return;

        const I = window.Icons;
        const initials = (name[0] || '?').toUpperCase();
        const tile = document.createElement('div');
        tile.className = 'gc-tile';
        tile.id = `gc-tile-${uid}`;
        tile.innerHTML = `
            <video class="gc-video" id="gc-video-${uid}" autoplay playsinline style="display:${_isVideoCall ? 'block' : 'none'}"></video>
            <div class="gc-avatar-placeholder" id="gc-avatar-${uid}" style="display:${_isVideoCall ? 'none' : 'flex'}">
                <span class="gc-initials">${escapeHTML(initials)}</span>
            </div>
            <div class="gc-tile-name">${escapeHTML(name)}</div>
            <div class="gc-tile-mute-icon" id="gc-mute-${uid}" style="display:none">${I ? I.get('micStop', 16) : '🔇'}</div>
        `;
        grid.appendChild(tile);
        _updateLayout();
    }

    function _attachStream(uid, stream) {
        const vid = document.getElementById(`gc-video-${uid}`);
        if (vid) {
            vid.srcObject = stream;
            vid.style.display = 'block';
            const avatar = document.getElementById(`gc-avatar-${uid}`);
            if (avatar) avatar.style.display = 'none';
        }
    }

    // ─────────────────────────────────────────────────────────
    //  UI: Responsive grid layout
    // ─────────────────────────────────────────────────────────
    function _updateLayout() {
        const grid = document.getElementById('gcGrid');
        if (!grid) return;
        const count = grid.children.length;
        grid.className = 'gc-grid ' + (
            count <= 1 ? 'gc-grid-1' :
            count <= 2 ? 'gc-grid-2' :
            count <= 4 ? 'gc-grid-4' : 'gc-grid-many'
        );
    }

    // ─────────────────────────────────────────────────────────
    //  Controls
    // ─────────────────────────────────────────────────────────
    function _toggleAudio() {
        _audioMuted = !_audioMuted;
        _localStream.getAudioTracks().forEach(t => t.enabled = !_audioMuted);
        const btn = document.getElementById('gcMuteBtn');
        const I = window.Icons;
        if (btn) {
            btn.innerHTML = I ? I.get(_audioMuted ? 'micStop' : 'micFill', 24) : (_audioMuted ? '🔇' : '🎤');
            btn.classList.toggle('gc-btn-active', _audioMuted);
        }
        const muteIcon = document.getElementById('gc-mute-local');
        if (muteIcon) muteIcon.style.display = _audioMuted ? 'flex' : 'none';
    }

    function _toggleVideo() {
        _videoMuted = !_videoMuted;
        _localStream.getVideoTracks().forEach(t => t.enabled = !_videoMuted);
        const btn = document.getElementById('gcVideoBtn');
        const I = window.Icons;
        if (btn) {
            btn.innerHTML = I ? I.get(_videoMuted ? 'videoOff' : 'videoFill', 24) : (_videoMuted ? '📵' : '📹');
            btn.classList.toggle('gc-btn-active', _videoMuted);
        }
        const localVid = document.getElementById('gcLocalVideo');
        if (localVid) localVid.style.display = _videoMuted ? 'none' : 'block';
        const localAvatar = document.querySelector('#gc-tile-local .gc-avatar-placeholder');
        if (localAvatar) localAvatar.style.display = _videoMuted ? 'flex' : 'none';
    }

    let _facingMode = 'user';
    async function _switchCamera() {
        _facingMode = _facingMode === 'user' ? 'environment' : 'user';
        try {
            const newStream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: _facingMode }, audio: true
            });
            const newVideoTrack = newStream.getVideoTracks()[0];
            // Replace track in all peer connections
            Object.values(_peers).forEach(({ pc }) => {
                const sender = pc.getSenders().find(s => s.track?.kind === 'video');
                if (sender) sender.replaceTrack(newVideoTrack);
            });
            // Update local video
            const localVid = document.getElementById('gcLocalVideo');
            if (localVid) localVid.srcObject = newStream;
            // Stop old video track
            _localStream.getVideoTracks().forEach(t => t.stop());
            // Swap audio tracks keep same
            const audioTrack = _localStream.getAudioTracks()[0];
            _localStream = newStream;
            if (audioTrack && !newStream.getAudioTracks().length) _localStream.addTrack(audioTrack);
        } catch (e) { console.error('Switch camera error:', e); }
    }

    // ─────────────────────────────────────────────────────────
    //  Timer
    // ─────────────────────────────────────────────────────────
    let _timerInterval = null;
    let _timerSeconds  = 0;
    function _startTimer() {
        _timerInterval = setInterval(() => {
            _timerSeconds++;
            const m = String(Math.floor(_timerSeconds / 60)).padStart(2, '0');
            const s = String(_timerSeconds % 60).padStart(2, '0');
            const el = document.getElementById('gcTimer');
            if (el) el.textContent = `${m}:${s}`;
        }, 1000);
    }

    // ─────────────────────────────────────────────────────────
    //  PUBLIC: End call
    // ─────────────────────────────────────────────────────────
    async function endCall() {
        await _cleanup();
    }

    async function _cleanup() {
        _active = false;

        // Stop timer
        clearInterval(_timerInterval);
        _timerInterval = null;
        _timerSeconds  = 0;

        // Unsubscribe Firestore listeners
        if (_unsubPeers) { _unsubPeers(); _unsubPeers = null; }
        if (_unsubRoom)  { _unsubRoom();  _unsubRoom  = null; }

        // Mark myself as inactive
        if (_roomId && _myUID) {
            try {
                await _peersRef().doc(_myUID).update({ active: false });
                // Delete my signals subcollection docs
                const sigs = await _peersRef().doc(_myUID).collection('signals').get();
                sigs.forEach(d => d.ref.delete());
            } catch(e) {}
        }

        // Close all peer connections
        Object.keys(_peers).forEach(uid => {
            _peers[uid]?.pc?.close();
        });
        _peers = {};

        // Stop local stream
        if (_localStream) {
            _localStream.getTracks().forEach(t => t.stop());
            _localStream = null;
        }

        // Remove UI
        const overlay = document.getElementById('groupCallOverlay');
        if (overlay) overlay.remove();

        _roomId      = null;
        _myUID       = null;
        _audioMuted  = false;
        _videoMuted  = false;
        _facingMode  = 'user';

        console.log('✅ Group call ended');
    }

    // ─────────────────────────────────────────────────────────
    //  PUBLIC: Check if group call is active in a room
    // ─────────────────────────────────────────────────────────
    async function checkActiveCall(groupId) {
        try {
            const snap = await window.db.collection('groupCalls').doc(groupId)
                .collection('peers')
                .where('active', '==', true)
                .get();
            return snap.size;
        } catch(e) { return 0; }
    }

    // ─────────────────────────────────────────────────────────
    //  PUBLIC: Join an existing group call room
    //  Used when a 1-1 call is upgraded — the 3rd person gets
    //  a Firestore invite and calls this to join the mesh room.
    // ─────────────────────────────────────────────────────────
    async function joinExistingCall(roomId, isVideo = true) {
        if (_active) {
            console.warn('Already in a call, cannot join another');
            return;
        }
        await startCall(roomId, isVideo);
    }

    // ─────────────────────────────────────────────────────────
    //  PUBLIC: Send a Firestore invite to a user to join the
    //  current group-call room. The invitee's listener shows
    //  an incoming-call UI and calls joinExistingCall() on accept.
    // ─────────────────────────────────────────────────────────
    async function inviteToRoom(targetUID, roomId, isVideo = true) {
        try {
            const callerName = window.currentUserData?.name || 'Someone';
            await window.db.collection('groupCallInvites').add({
                to:       targetUID,
                from:     window.currentUser.uid,
                fromName: callerName,
                roomId:   roomId,
                isVideo:  isVideo,
                status:   'pending',
                created:  new Date()
            });
            console.log('✅ Group call invite sent to', targetUID);
            return true;
        } catch(e) {
            console.error('Error sending group call invite:', e);
            return false;
        }
    }

    // Expose room info for the 1-1 → group upgrade path
    function getRoomId() { return _roomId; }
    function isActive()  { return _active; }

    return { startCall, endCall, checkActiveCall, joinExistingCall, inviteToRoom, getRoomId, isActive };

})();

window.GroupCallManager = GroupCallManager;
console.log('✅ groupCall.js loaded');

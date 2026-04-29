// webrtc.js — WebRTCManager: handles peer connection, media, and call UI
// This file was MISSING from the project — that's why calls weren't working.

class WebRTCManager {
    constructor() {
        this.peerConnection     = null;
        this.localStream        = null;
        this.remoteStream       = null;
        this.currentCallId      = null;
        this.currentCallTarget  = null;
        this.isVideoCall        = false;
        this.isCaller           = false;
        this.callTimer          = null;
        this.callSeconds        = 0;
        this.isMuted            = false;
        this.isVideoOff         = false;
        this.pendingICEQueue    = [];
        this.remoteDescSet      = false;

        // STUN/TURN servers — add TURN credentials for production
        this.iceServers = {
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' },
                { urls: 'stun:stun2.l.google.com:19302' }
            ]
        };

        console.log('✅ WebRTCManager created');
    }

    // ─── Start an outgoing call ────────────────────────────────────────
    async startCall(targetUID, isVideo = false) {
        if (this.currentCallId) {
            console.warn('Call already in progress');
            return;
        }

        try {
            console.log(`📞 Starting ${isVideo ? 'video' : 'voice'} call to:`, targetUID);
            this.isVideoCall       = isVideo;
            this.isCaller          = true;
            this.currentCallTarget = targetUID;

            // Get media
            this.localStream = await this._getMedia(isVideo);

            // Generate a unique call ID
            this.currentCallId = `call_${window.currentUser.uid}_${targetUID}_${Date.now()}`;

            // Show outgoing call UI
            const targetData = await window.getUserData(targetUID);
            this._showOutgoingCallUI(targetData);

            // Create peer connection
            this._createPeerConnection();

            // Add local tracks
            this.localStream.getTracks().forEach(track => {
                this.peerConnection.addTrack(track, this.localStream);
            });

            // Create and send offer
            const offer = await this.peerConnection.createOffer({
                offerToReceiveAudio: true,
                offerToReceiveVideo: isVideo
            });
            await this.peerConnection.setLocalDescription(offer);

            await window.signalingManager.sendOffer(
                this.currentCallId,
                offer,
                targetUID,
                isVideo
            );

            console.log('✅ Offer sent, waiting for answer...');
        } catch (error) {
            console.error('❌ Error starting call:', error);
            this._showError('Could not start call: ' + error.message);
            this.cleanup();
        }
    }

    // ─── Handle incoming offer ─────────────────────────────────────────
    async handleOffer(callId, offer, callerUID, isVideo) {
        if (this.currentCallId) {
            // Already in a call — auto-decline
            console.warn('Already in call, declining new offer');
            await window.signalingManager.declineCall(callId);
            return;
        }

        console.log('📞 Handling incoming offer from:', callerUID);
        this.currentCallId      = callId;
        this.currentCallTarget  = callerUID;
        this.isVideoCall        = isVideo;
        this.isCaller           = false;

        const callerData = await window.getUserData(callerUID);
        this._showIncomingCallUI(callerData, callId, isVideo);

        // Store offer to use when accepted
        this._pendingOffer = offer;
    }

    // ─── Accept incoming call ──────────────────────────────────────────
    async acceptCall() {
        if (!this._pendingOffer || !this.currentCallId) {
            console.error('No pending offer to accept');
            return;
        }

        try {
            console.log('✅ Accepting call:', this.currentCallId);

            this._removeIncomingCallUI();

            // Get media
            this.localStream = await this._getMedia(this.isVideoCall);

            // Create peer connection
            this._createPeerConnection();

            // Add local tracks
            this.localStream.getTracks().forEach(track => {
                this.peerConnection.addTrack(track, this.localStream);
            });

            // Set remote description (the offer)
            await this.peerConnection.setRemoteDescription(this._pendingOffer);
            this.remoteDescSet  = true;
            this._pendingOffer  = null;

            // Process any queued ICE candidates
            this._processPendingICECandidates();

            // Create and send answer
            const answer = await this.peerConnection.createAnswer();
            await this.peerConnection.setLocalDescription(answer);

            await window.signalingManager.sendAnswer(this.currentCallId, answer);

            // Show active call UI
            const callerData = await window.getUserData(this.currentCallTarget);
            this._showActiveCallUI(callerData);

            console.log('✅ Answer sent');
        } catch (error) {
            console.error('❌ Error accepting call:', error);
            this._showError('Could not accept call: ' + error.message);
            this.cleanup();
        }
    }

    // ─── Handle received answer ────────────────────────────────────────
    async handleAnswer(answer) {
        if (!this.peerConnection) {
            console.error('No peer connection to set answer on');
            return;
        }

        try {
            console.log('📥 Setting remote answer');
            await this.peerConnection.setRemoteDescription(answer);
            this.remoteDescSet = true;

            // Process any queued ICE candidates
            this._processPendingICECandidates();

            // Switch to active call UI
            const targetData = await window.getUserData(this.currentCallTarget);
            this._showActiveCallUI(targetData);

            console.log('✅ Remote description set, call active');
        } catch (error) {
            console.error('❌ Error setting remote answer:', error);
        }
    }

    // ─── Handle incoming ICE candidate ────────────────────────────────
    handleICECandidate(candidate) {
        if (!this.peerConnection) {
            this.pendingICEQueue.push(candidate);
            return;
        }

        if (!this.remoteDescSet) {
            // Queue until remote description is set
            this.pendingICEQueue.push(candidate);
            return;
        }

        this._addICECandidate(candidate);
    }

    _addICECandidate(candidate) {
        this.peerConnection.addIceCandidate(candidate).catch(err => {
            console.warn('⚠️ addIceCandidate error (usually safe to ignore):', err.message);
        });
    }

    _processPendingICECandidates() {
        if (this.pendingICEQueue.length === 0) return;
        console.log(`🧊 Processing ${this.pendingICEQueue.length} queued ICE candidates`);
        this.pendingICEQueue.forEach(c => this._addICECandidate(c));
        this.pendingICEQueue = [];
    }

    // ─── End the current call ──────────────────────────────────────────
    async endCall(silent = false) {
        console.log('📞 Ending call:', this.currentCallId);

        if (this.currentCallId && !silent) {
            try {
                await window.signalingManager.sendCallEnd(this.currentCallId);
            } catch (e) {
                console.warn('sendCallEnd error:', e);
            }
        }

        this.cleanup();
    }

    // ─── Handle remote side ending call ───────────────────────────────
    handleCallDisconnected() {
        console.log('📞 Remote call disconnected');
        this._showToast('Call ended');
        this.cleanup();
    }

    // ─── Decline incoming call ─────────────────────────────────────────
    async declineCall() {
        if (!this.currentCallId) return;

        try {
            await window.signalingManager.declineCall(this.currentCallId);
        } catch (e) {
            console.warn('declineCall error:', e);
        }

        this._removeIncomingCallUI();
        this.cleanup(true);
    }

    // ─── Toggle mute ──────────────────────────────────────────────────
    toggleMute() {
        if (!this.localStream) return;
        this.isMuted = !this.isMuted;
        this.localStream.getAudioTracks().forEach(t => { t.enabled = !this.isMuted; });

        const btn = document.querySelector('.mute-audio');
        if (btn) btn.classList.toggle('muted', this.isMuted);
        console.log('🎤 Mute:', this.isMuted);
    }

    // ─── Toggle video ─────────────────────────────────────────────────
    toggleVideo() {
        if (!this.localStream) return;
        this.isVideoOff = !this.isVideoOff;
        this.localStream.getVideoTracks().forEach(t => { t.enabled = !this.isVideoOff; });

        const btn = document.querySelector('.mute-video');
        if (btn) btn.classList.toggle('muted', this.isVideoOff);
        console.log('📷 Video off:', this.isVideoOff);
    }

    // ─── Create RTCPeerConnection ──────────────────────────────────────
    _createPeerConnection() {
        this.peerConnection = new RTCPeerConnection(this.iceServers);
        this.remoteDescSet  = false;
        this.pendingICEQueue = [];

        // Send our ICE candidates via signaling
        this.peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                window.signalingManager.sendICECandidate(
                    this.currentCallId,
                    event.candidate,
                    this.isCaller
                );
            }
        };

        // Receive remote tracks
        this.remoteStream = new MediaStream();
        this.peerConnection.ontrack = (event) => {
            console.log('📡 Remote track received:', event.track.kind);
            event.streams[0].getTracks().forEach(track => {
                this.remoteStream.addTrack(track);
            });

            const remoteVideo = document.getElementById('remoteVideo');
            if (remoteVideo) remoteVideo.srcObject = this.remoteStream;
        };

        this.peerConnection.onconnectionstatechange = () => {
            const state = this.peerConnection?.connectionState;
            console.log('🔗 Connection state:', state);
            if (state === 'disconnected' || state === 'failed' || state === 'closed') {
                if (this.currentCallId) {
                    this._showToast('Call connection lost');
                    this.cleanup();
                }
            }
            if (state === 'connected') {
                this._startCallTimer();
            }
        };

        this.peerConnection.oniceconnectionstatechange = () => {
            console.log('🧊 ICE state:', this.peerConnection?.iceConnectionState);
        };
    }

    // ─── Get local media ──────────────────────────────────────────────
    async _getMedia(isVideo) {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: true,
                video: isVideo ? { width: { ideal: 1280 }, height: { ideal: 720 } } : false
            });
            console.log('🎥 Got local media, tracks:', stream.getTracks().map(t => t.kind));
            return stream;
        } catch (error) {
            if (error.name === 'NotAllowedError') {
                throw new Error('Microphone/camera permission denied. Please allow access and try again.');
            } else if (error.name === 'NotFoundError') {
                throw new Error('Microphone/camera not found on this device.');
            }
            throw error;
        }
    }

    // ─── Call Timer ───────────────────────────────────────────────────
    _startCallTimer() {
        this.callSeconds = 0;
        this.callTimer = setInterval(() => {
            this.callSeconds++;
            const timerEl = document.getElementById('callTimer');
            if (timerEl) timerEl.textContent = this._formatTime(this.callSeconds);
        }, 1000);
    }

    _formatTime(s) {
        const m = Math.floor(s / 60).toString().padStart(2, '0');
        const sec = (s % 60).toString().padStart(2, '0');
        return `${m}:${sec}`;
    }

    // ─── UI: Show Outgoing Call ────────────────────────────────────────
    _showOutgoingCallUI(userData) {
        this._removeCallUI();

        const name   = userData?.displayName || userData?.name || 'Unknown';
        const avatar = userData?.photoURL || '';

        const el = document.createElement('div');
        el.id = 'callContainer';
        el.className = 'call-container';
        el.innerHTML = `
            <div class="call-header">
                <h3>${this.isVideoCall ? 'Video Call' : 'Voice Call'}</h3>
                <span id="callTimer" class="call-timer"></span>
            </div>

            ${this.isVideoCall ? `
            <div class="video-container">
                <video id="remoteVideo" class="remote-video" autoplay playsinline></video>
                <video id="localVideo"  class="local-video"  autoplay playsinline muted></video>
            </div>` : `
            <div class="voice-call-display">
                <div class="user-avatar large">
                    ${avatar ? `<img src="${avatar}" alt="${name}">` : `<span>${name.charAt(0).toUpperCase()}</span>`}
                </div>
                <div class="call-status" id="callStatusText">Calling...</div>
                <p style="margin-top:8px;font-size:1.1rem;">${name}</p>
            </div>`}

            <div class="call-controls">
                ${this.isVideoCall ? `
                <button class="call-btn mute-video" title="Toggle Camera" onclick="window.webRTCManager.toggleVideo()">📷</button>` : ''}
                <button class="call-btn mute-audio" title="Mute" onclick="window.webRTCManager.toggleMute()">🎤</button>
                <button class="call-btn end-call" title="End Call" onclick="window.webRTCManager.endCall()">📵</button>
            </div>
        `;

        document.body.appendChild(el);

        // Attach local video
        if (this.isVideoCall && this.localStream) {
            const lv = document.getElementById('localVideo');
            if (lv) lv.srcObject = this.localStream;
        }
    }

    // ─── UI: Show Incoming Call ────────────────────────────────────────
    _showIncomingCallUI(callerData, callId, isVideo) {
        this._removeIncomingCallUI();

        const name   = callerData?.displayName || callerData?.name || 'Unknown';
        const avatar = callerData?.photoURL || '';

        const overlay = document.createElement('div');
        overlay.id = 'incomingCallOverlay';
        overlay.className = 'incoming-call-overlay';
        overlay.innerHTML = `
            <div class="incoming-call-modal">
                <div class="caller-info">
                    <div class="caller-avatar large">
                        ${avatar ? `<img src="${avatar}" alt="${name}">` : `<span>${name.charAt(0).toUpperCase()}</span>`}
                    </div>
                    <h3>${name}</h3>
                    <p>${isVideo ? 'Incoming Video Call' : 'Incoming Voice Call'}</p>
                </div>
                <div class="incoming-call-controls">
                    <button class="call-btn accept-call" title="Accept" onclick="window.webRTCManager.acceptCall()">✅</button>
                    <button class="call-btn decline-call" title="Decline" onclick="window.webRTCManager.declineCall()">❌</button>
                </div>
            </div>
        `;

        document.body.appendChild(overlay);

        // Play ringtone
        this._playRingtone();
    }

    // ─── UI: Show Active Call ──────────────────────────────────────────
    _showActiveCallUI(userData) {
        this._removeCallUI();

        const name   = userData?.displayName || userData?.name || 'Unknown';
        const avatar = userData?.photoURL || '';

        const el = document.createElement('div');
        el.id = 'callContainer';
        el.className = 'call-container';
        el.innerHTML = `
            <div class="call-header">
                <h3>${name}</h3>
                <span id="callTimer" class="call-timer">00:00</span>
            </div>

            ${this.isVideoCall ? `
            <div class="video-container">
                <video id="remoteVideo" class="remote-video" autoplay playsinline></video>
                <video id="localVideo"  class="local-video"  autoplay playsinline muted></video>
            </div>` : `
            <div class="voice-call-display">
                <div class="user-avatar large">
                    ${avatar ? `<img src="${avatar}" alt="${name}">` : `<span>${name.charAt(0).toUpperCase()}</span>`}
                </div>
                <p style="margin-top:8px;font-size:1.1rem;">${name}</p>
            </div>`}

            <div class="call-controls">
                ${this.isVideoCall ? `
                <button class="call-btn mute-video" title="Toggle Camera" onclick="window.webRTCManager.toggleVideo()">📷</button>` : ''}
                <button class="call-btn mute-audio" title="Mute" onclick="window.webRTCManager.toggleMute()">🎤</button>
                <button class="call-btn end-call" title="End Call" onclick="window.webRTCManager.endCall()">📵</button>
            </div>
        `;

        document.body.appendChild(el);

        // Attach streams
        if (this.isVideoCall) {
            const lv = document.getElementById('localVideo');
            const rv = document.getElementById('remoteVideo');
            if (lv && this.localStream)  lv.srcObject = this.localStream;
            if (rv && this.remoteStream) rv.srcObject = this.remoteStream;
        }
    }

    // ─── UI: Remove helpers ────────────────────────────────────────────
    _removeCallUI() {
        const el = document.getElementById('callContainer');
        if (el) el.remove();
    }

    _removeIncomingCallUI() {
        const el = document.getElementById('incomingCallOverlay');
        if (el) el.remove();
        this._stopRingtone();
    }

    // ─── Ringtone ─────────────────────────────────────────────────────
    _playRingtone() {
        try {
            this._ringtone = new Audio('modules/ring.mp3');
            this._ringtone.loop = true;
            this._ringtone.play().catch(e => console.warn('Ringtone play failed:', e));
        } catch (e) { /* ignore */ }
    }

    _stopRingtone() {
        if (this._ringtone) {
            this._ringtone.pause();
            this._ringtone.currentTime = 0;
            this._ringtone = null;
        }
    }

    // ─── Toast ────────────────────────────────────────────────────────
    _showError(msg) {
        if (window.modalManager) {
            window.modalManager.showModal('Call Error', msg, 'error');
        } else {
            alert(msg);
        }
    }

    _showToast(msg) {
        if (window.showToast) {
            window.showToast(msg, 'info');
        }
    }

    // ─── Cleanup ──────────────────────────────────────────────────────
    cleanup(keepCallId = false) {
        console.log('🧹 WebRTCManager cleanup');

        // Stop timer
        if (this.callTimer) {
            clearInterval(this.callTimer);
            this.callTimer = null;
        }

        // Stop media
        if (this.localStream) {
            this.localStream.getTracks().forEach(t => t.stop());
            this.localStream = null;
        }
        this.remoteStream = null;

        // Close peer connection
        if (this.peerConnection) {
            this.peerConnection.close();
            this.peerConnection = null;
        }

        // Remove UI
        this._removeCallUI();
        this._removeIncomingCallUI();

        // Reset state
        if (!keepCallId) this.currentCallId = null;
        this.currentCallTarget = null;
        this.isCaller          = false;
        this.isMuted           = false;
        this.isVideoOff        = false;
        this.remoteDescSet     = false;
        this.pendingICEQueue   = [];
        this._pendingOffer     = null;

        console.log('✅ WebRTCManager cleaned up');
    }
}

// ── Expose globally ────────────────────────────────────────────────────
window.webRTCManager = new WebRTCManager();

console.log('✅ webrtc.js loaded — WebRTCManager ready');

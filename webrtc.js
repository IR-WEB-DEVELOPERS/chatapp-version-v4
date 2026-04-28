class WebRTCManager {
    constructor() {
        this.peerConnection = null;
        this.localStream = null;
        this.remoteStream = null;
        this.dataChannel = null;
        this.isCaller = false;
        this.currentCallId = null;
        this.callTarget = null;
        this.callTimer = null;
        this.isVideoCall = true;
        this.screenStream = null;        // screen share stream
        this.isScreenSharing = false;    // screen share active flag
        
        // FIX: Call duration timer - only starts when connected
        this.callDurationTimer = null;
        this.callDurationStartTime = null;
        this.callLogSaved = false;
        
        // State management
        this.signalingState = 'stable';
        this.pendingAnswer = null;
        this.isSettingRemoteDescription = false;
        
        // Better ICE servers configuration
        this.iceServers = {
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' },
                { urls: 'stun:stun2.l.google.com:19302' },
                { urls: 'stun:stun3.l.google.com:19302' },
                { urls: 'stun:stun4.l.google.com:19302' }
            ],
            iceCandidatePoolSize: 10
        };
        
        this.mediaConstraints = {
            video: {
                width: { ideal: 640 },
                height: { ideal: 480 },
                frameRate: { ideal: 24 }
            },
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
                channelCount: 1
            }
        };
        
        this.pendingICECandidates = [];
        
        this.init();
    }

    init() {
        this.setupEventListeners();
        console.log('WebRTCManager initialized with better state management');
    }

    setupEventListeners() {
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.currentCallId) {
                this.endCall();
            }
        });
    }

    async startCall(targetUID, isVideoCall = true) {
        try {
            console.log(`🚀 Starting ${isVideoCall ? 'video' : 'voice'} call to:`, targetUID);
            
            if (!this.checkWebRTCSupport()) {
                throw new Error('WebRTC not supported in this browser');
            }
            
            if (!window.signalingManager) {
                throw new Error('Signaling system not ready');
            }

            this.callTarget = targetUID;
            this.isCaller = true;
            this.isVideoCall = isVideoCall;
            this.currentCallId = this.generateCallId();
            this.pendingICECandidates = [];
            this.signalingState = 'have-local-offer';
            
            // Get user media with better error handling
            try {
                const constraints = isVideoCall ? {
                    audio: this.mediaConstraints.audio,
                    video: {
                        width: { ideal: 640, max: 1280 },
                        height: { ideal: 480, max: 720 },
                        frameRate: { ideal: 24, max: 30 }
                    }
                } : { audio: true, video: false };
                
                console.log('Requesting media with constraints:', constraints);
                
                this.localStream = await navigator.mediaDevices.getUserMedia(constraints);
                console.log('✅ Media access granted:', {
                    audio: this.localStream.getAudioTracks().length > 0,
                    video: this.localStream.getVideoTracks().length > 0
                });
            } catch (mediaError) {
                console.error('Media access error:', mediaError);
                throw new Error(`Media access failed: ${mediaError.message}`);
            }

            // Create peer connection
            this.createPeerConnection();
            
            // Add local tracks to connection
            this.localStream.getTracks().forEach(track => {
                console.log(`Adding track: ${track.kind}`, track);
                this.peerConnection.addTrack(track, this.localStream);
            });

            // Create data channel for call metadata
            this.dataChannel = this.peerConnection.createDataChannel('callData', {
                ordered: true
            });
            this.setupDataChannel();

            // Create and send offer
            const offer = await this.peerConnection.createOffer({
                offerToReceiveAudio: true,
                offerToReceiveVideo: isVideoCall
            });
            
            await this.peerConnection.setLocalDescription(offer);
            console.log('✅ Local description set, signaling state:', this.peerConnection.signalingState);

            // Send offer via signaling
            await window.signalingManager.sendOffer(this.currentCallId, offer, targetUID, isVideoCall);
            console.log('✅ Offer sent via signaling');

            // FIX: Push notification పంపాలి — browser closed అయినా ring అవ్వాలి
            if (window.pushNotifications) {
                const callerName = window.currentUserData?.name || 'Someone';
                window.pushNotifications.notifyIncomingCall({
                    toUID:    targetUID,
                    fromName: callerName,
                    isVideo:  isVideoCall,
                    callId:   this.currentCallId  // FIX: callId pass చేయాలి — decline/answer notification కి కావాలి
                });
            }

            // Show call interface
            this.showCallInterface(true, isVideoCall);
            
            return this.currentCallId;
            
        } catch (error) {
            console.error('❌ Error starting call:', error);
            this.handleCallError('Failed to start call: ' + error.message);
            this.cleanup();
            throw error;
        }
    }

    async acceptCall(callId, offer, callerUID, isVideoCall = true) {
        try {
            console.log(`✅ Accepting ${isVideoCall ? 'video' : 'voice'} call from:`, callerUID);
            
            this.currentCallId = callId;
            this.callTarget = callerUID;
            this.isCaller = false;
            this.isVideoCall = isVideoCall;
            this.pendingICECandidates = [];
            this.signalingState = 'have-remote-offer';

            // Get user media
            try {
                const constraints = isVideoCall ? {
                    audio: this.mediaConstraints.audio,
                    video: {
                        width: { ideal: 640, max: 1280 },
                        height: { ideal: 480, max: 720 },
                        frameRate: { ideal: 24, max: 30 }
                    }
                } : { audio: true, video: false };
                this.localStream = await navigator.mediaDevices.getUserMedia(constraints);
                console.log('✅ Media access granted for answer');
            } catch (mediaError) {
                console.error('Media access error:', mediaError);
                throw new Error(`Media access failed: ${mediaError.message}`);
            }

            // Create peer connection
            this.createPeerConnection();
            
            // Add local tracks
            this.localStream.getTracks().forEach(track => {
                this.peerConnection.addTrack(track, this.localStream);
            });

            // Setup data channel handler
            this.peerConnection.ondatachannel = (event) => {
                this.dataChannel = event.channel;
                this.setupDataChannel();
            };

            // Set remote description FIRST
            console.log('🔄 Setting remote description (offer)...');
            await this.peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
            console.log('✅ Remote description set, signaling state:', this.peerConnection.signalingState);

            // Create and send answer
            const answer = await this.peerConnection.createAnswer();
            await this.peerConnection.setLocalDescription(answer);
            console.log('✅ Answer created and local description set');

            // Send answer via signaling
            await window.signalingManager.sendAnswer(callId, answer);
            console.log('✅ Answer sent via signaling');

            // Process any pending ICE candidates
            await this.processPendingICECandidates();

            // Show call interface
            this.showCallInterface(false, isVideoCall);
            
        } catch (error) {
            console.error('❌ Error accepting call:', error);
            this.handleCallError('Failed to accept call: ' + error.message);
            this.cleanup();
            throw error;
        }
    }

    createPeerConnection() {
        try {
            this.peerConnection = new RTCPeerConnection(this.iceServers);
            console.log('✅ Peer connection created');

            // Track signaling state changes
            this.peerConnection.onsignalingstatechange = () => {
                if (this.peerConnection) {
                    this.signalingState = this.peerConnection.signalingState;
                    console.log('📡 Signaling state changed:', this.signalingState);
                    
                    // Process pending answer when state becomes stable
                    if (this.signalingState === 'stable' && this.pendingAnswer) {
                        console.log('🔄 Processing pending answer now that state is stable');
                        this.processPendingAnswer();
                    }
                }
            };

            // ICE candidate handler
            this.peerConnection.onicecandidate = (event) => {
                if (event.candidate && this.currentCallId) {
                    console.log('📨 Sending ICE candidate, isCaller:', this.isCaller);
                    window.signalingManager.sendICECandidate(this.currentCallId, event.candidate, this.isCaller);
                }
            };

            // Track handler — handles both audio-only (voice) and video calls
            this.peerConnection.ontrack = (event) => {
                console.log('🎬 Remote track received:', event.track.kind, event.streams);

                if (event.streams && event.streams[0]) {
                    this.remoteStream = event.streams[0];
                }

                if (event.track.kind === 'audio' && !this.isVideoCall) {
                    // Voice call: pipe audio to a dedicated <audio> element
                    let remoteAudio = document.getElementById('remoteCallAudio');
                    if (!remoteAudio) {
                        remoteAudio = document.createElement('audio');
                        remoteAudio.id = 'remoteCallAudio';
                        remoteAudio.autoplay = true;
                        remoteAudio.style.display = 'none';
                        document.body.appendChild(remoteAudio);
                    }
                    remoteAudio.srcObject = this.remoteStream || new MediaStream([event.track]);
                    remoteAudio.play().catch(e => console.error('Remote audio play error:', e));
                    console.log('🔊 Remote audio element connected for voice call');
                } else {
                    // Video call: use the video element
                    this.updateRemoteVideo();
                    setTimeout(() => {
                        const remoteVideo = document.getElementById('remoteVideo');
                        if (remoteVideo) {
                            remoteVideo.play().catch(e => console.log('Remote video play error:', e));
                        }
                    }, 500);
                }
            };

            // Connection state monitoring
            this.peerConnection.onconnectionstatechange = () => {
                if (!this.peerConnection) return;
                
                const state = this.peerConnection.connectionState;
                console.log('🔗 Connection state:', state);
                
                switch (state) {
                    case 'connected':
                        this.handleCallConnected();
                        break;
                    case 'disconnected':
                    case 'failed':
                        console.log('❌ Connection failed/disconnected');
                        this.handleCallDisconnected();
                        break;
                    case 'closed':
                        this.cleanup();
                        break;
                }
            };

            // ICE connection state
            this.peerConnection.oniceconnectionstatechange = () => {
                if (!this.peerConnection) return;
                console.log('🧊 ICE connection state:', this.peerConnection.iceConnectionState);
            };

        } catch (error) {
            console.error('❌ Error creating peer connection:', error);
            throw error;
        }
    }

    setupDataChannel() {
        if (this.dataChannel) {
            this.dataChannel.onopen = () => {
                console.log('Data channel opened');
                this.sendCallMetadata();
            };
            
            this.dataChannel.onmessage = (event) => {
                this.handleDataChannelMessage(event.data);
            };
            
            this.dataChannel.onclose = () => {
                console.log('Data channel closed');
            };
            
            this.dataChannel.onerror = (error) => {
                console.error('Data channel error:', error);
            };
        }
    }

    async handleOffer(callId, offer, callerUID, isVideoCall) {
        console.log('📞 Handling incoming call offer:', callId);
        this.showIncomingCallUI(callId, offer, callerUID, isVideoCall);
    }

    async handleAnswer(answer) {
        console.log('✅ Handling answer, current signaling state:', this.signalingState);
        
        if (!this.peerConnection) {
            console.error('❌ No peer connection available for answer');
            return;
        }
        
        // Check if we're in the right state to set remote description
        if (this.signalingState !== 'have-local-offer') {
            console.warn('⚠️ Not in correct state for answer. Current state:', this.signalingState);
            console.log('📥 Queueing answer for later processing');
            this.pendingAnswer = answer;
            return;
        }
        
        if (this.isSettingRemoteDescription) {
            console.log('⏳ Already setting remote description, queuing answer');
            this.pendingAnswer = answer;
            return;
        }
        
        try {
            this.isSettingRemoteDescription = true;
            console.log('🔄 Setting remote description (answer)...');
            
            await this.peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
            console.log('✅ Remote description set successfully, new signaling state:', this.peerConnection.signalingState);
            
            // Process any pending ICE candidates
            await this.processPendingICECandidates();
            
            this.pendingAnswer = null;
            
        } catch (error) {
            console.error('❌ Error setting remote description:', error);
            
            if (error.toString().includes('wrong state') || error.toString().includes('stable')) {
                console.log('🔄 Answer arrived too late, connection already established');
                // This is often not a critical error - the connection might already be working
            } else {
                throw error;
            }
        } finally {
            this.isSettingRemoteDescription = false;
        }
    }

    async processPendingAnswer() {
        if (this.pendingAnswer && this.peerConnection) {
            console.log('🔄 Processing queued answer');
            try {
                await this.peerConnection.setRemoteDescription(new RTCSessionDescription(this.pendingAnswer));
                console.log('✅ Queued answer processed successfully');
                this.pendingAnswer = null;
            } catch (error) {
                console.error('❌ Error processing queued answer:', error);
            }
        }
    }

    async handleICECandidate(candidate) {
        if (!this.peerConnection) {
            console.warn('❌ No peer connection for ICE candidate');
            this.pendingICECandidates.push(candidate);
            return;
        }
        
        try {
            // Wait a bit if we're currently setting remote description
            if (this.isSettingRemoteDescription) {
                console.log('⏳ Delaying ICE candidate due to ongoing remote description setting');
                setTimeout(() => this.handleICECandidate(candidate), 100);
                return;
            }
            
            await this.peerConnection.addIceCandidate(candidate);
            console.log('✅ ICE candidate added');
            
        } catch (error) {
            console.error('❌ Error adding ICE candidate:', error);
            
            // If we get a "remote description not set" error, queue the candidate
            if (error.toString().includes('remote description') || !this.peerConnection.remoteDescription) {
                console.log('📥 Queuing ICE candidate (remote description not ready)');
                this.pendingICECandidates.push(candidate);
            }
        }
    }

    async processPendingICECandidates() {
        if (!this.peerConnection || !this.pendingICECandidates.length) return;
        
        console.log(`🔄 Processing ${this.pendingICECandidates.length} pending ICE candidates`);
        
        const candidatesToProcess = [...this.pendingICECandidates];
        this.pendingICECandidates = [];
        
        for (const candidate of candidatesToProcess) {
            try {
                await this.peerConnection.addIceCandidate(candidate);
                console.log('✅ Processed queued ICE candidate');
            } catch (error) {
                console.error('❌ Error processing queued ICE candidate:', error);
                // Don't re-queue failed candidates to avoid infinite loops
            }
        }
    }

    // Media control methods
    toggleVideo() {
        if (this.localStream) {
            const videoTrack = this.localStream.getVideoTracks()[0];
            if (videoTrack) {
                videoTrack.enabled = !videoTrack.enabled;
                this.updateLocalVideo();
                return videoTrack.enabled;
            }
        }
        return false;
    }

    toggleAudio() {
        if (this.localStream) {
            const audioTrack = this.localStream.getAudioTracks()[0];
            if (audioTrack) {
                audioTrack.enabled = !audioTrack.enabled;
                return audioTrack.enabled;
            }
        }
        return false;
    }

    async switchCamera() {
        if (!this.localStream) return;
        
        try {
            const videoTrack = this.localStream.getVideoTracks()[0];
            if (!videoTrack) {
                console.warn('No video track available');
                this.showModal('Info', 'No camera available on this device', 'info');
                return;
            }
            
            // Check available video input devices
            const devices = await navigator.mediaDevices.enumerateDevices();
            const videoDevices = devices.filter(device => device.kind === 'videoinput');
            
            if (videoDevices.length < 2) {
                console.warn('Only one camera available on this device');
                this.showModal('Info', 'Only one camera available on this device', 'info');
                return;
            }
            
            const currentFacingMode = videoTrack.getSettings().facingMode;
            const newFacingMode = currentFacingMode === 'user' ? 'environment' : 'user';
            
            const constraints = {
                video: {
                    width: { ideal: 640 },
                    height: { ideal: 480 },
                    frameRate: { ideal: 24 },
                    facingMode: { exact: newFacingMode }
                },
                audio: this.mediaConstraints.audio
            };
            
            const newStream = await navigator.mediaDevices.getUserMedia(constraints);
            const newVideoTrack = newStream.getVideoTracks()[0];
            
            if (!newVideoTrack) {
                throw new Error('Failed to get new video track');
            }
            
            const sender = this.peerConnection?.getSenders().find(s => 
                s.track && s.track.kind === 'video'
            );
            
            if (sender && this.peerConnection) {
                await sender.replaceTrack(newVideoTrack);
            }
            
            // Stop old video track
            this.localStream.getVideoTracks().forEach(track => {
                if (track !== newVideoTrack) {
                    track.stop();
                }
            });
            
            // Remove old video tracks and add new one
            this.localStream.getTracks().forEach(track => {
                if (track.kind === 'video' && track !== newVideoTrack) {
                    this.localStream.removeTrack(track);
                }
            });
            
            if (!this.localStream.getVideoTracks().some(t => t === newVideoTrack)) {
                this.localStream.addTrack(newVideoTrack);
            }
            
            this.updateLocalVideo();
            console.log('✅ Camera switched successfully');
            
        } catch (error) {
            console.error('❌ Error switching camera:', error);
            let errorMsg = error.message;
            
            if (error.name === 'NotFoundError' || error.name === 'PermissionDenied') {
                errorMsg = 'Camera not found or permission denied. Make sure you have at least 2 cameras.';
            } else if (error.name === 'NotAllowedError') {
                errorMsg = 'Camera permission denied by user';
            }
            
            this.showModal('Camera Switch Failed', errorMsg, 'error');
        }
    }

    // ── Screen Sharing ──────────────────────────────────────
    isMobileDevice() {
        return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) ||
               (navigator.maxTouchPoints > 1 && !window.matchMedia('(pointer: fine)').matches);
    }

    async toggleScreenShare() {
        if (!this.isVideoCall) {
            window.showToast?.('Screen sharing is only available during video calls', 'info');
            return false;
        }

        // Mobile browsers don't support getDisplayMedia — OS level restriction
        if (this.isMobileDevice() || typeof navigator.mediaDevices?.getDisplayMedia !== 'function') {
            window.showToast?.('Screen sharing is not supported on mobile devices', 'info');
            return false;
        }

        if (this.isScreenSharing) {
            // ── Stop screen share, restore camera ──────────
            try {
                if (this.screenStream) {
                    this.screenStream.getTracks().forEach(t => t.stop());
                    this.screenStream = null;
                }

                // Restore original camera track
                const cameraTrack = this.localStream?.getVideoTracks()[0];
                if (cameraTrack) {
                    const sender = this.peerConnection?.getSenders().find(s => s.track?.kind === 'video');
                    if (sender) await sender.replaceTrack(cameraTrack);
                }

                this.isScreenSharing = false;
                this.updateLocalVideo();

                // Update button UI
                const btn = document.querySelector('.screen-share');
                if (btn) {
                    btn.style.background = '#718096';
                    btn.title = 'Share Screen';
                    btn.textContent = '🖥️';
                }
                window.showToast?.('Screen sharing stopped', 'info');
                return false;
            } catch (err) {
                console.error('Error stopping screen share:', err);
                return false;
            }
        } else {
            // ── Start screen share ─────────────────────────
            try {
                this.screenStream = await navigator.mediaDevices.getDisplayMedia({
                    video: { cursor: 'always' },
                    audio: false
                });

                const screenTrack = this.screenStream.getVideoTracks()[0];

                // Replace video track in peer connection
                const sender = this.peerConnection?.getSenders().find(s => s.track?.kind === 'video');
                if (sender) await sender.replaceTrack(screenTrack);

                // Show screen in local preview
                const localVideo = document.getElementById('localVideo');
                if (localVideo) localVideo.srcObject = this.screenStream;

                // Auto-stop when user clicks browser's "Stop sharing"
                screenTrack.addEventListener('ended', () => {
                    this.isScreenSharing = true; // set true so toggleScreenShare stops it
                    this.toggleScreenShare();
                });

                this.isScreenSharing = true;

                // Update button UI
                const btn = document.querySelector('.screen-share');
                if (btn) {
                    btn.style.background = '#38a169';
                    btn.title = 'Stop Sharing';
                    btn.textContent = '🛑';
                }
                window.showToast?.('Screen sharing started', 'success');
                return true;
            } catch (err) {
                if (err.name === 'NotAllowedError') {
                    console.log('Screen share cancelled by user');
                } else {
                    console.error('Screen share error:', err);
                    window.showToast?.('Screen sharing failed: ' + err.message, 'error');
                }
                return false;
            }
        }
    }

    // UI Methods (same as before, but included for completeness)
    showCallInterface(isCaller, isVideoCall) {
        this.cleanupCallUI();
        
        const callHTML = `
            <div id="callContainer" class="call-container">
                <div class="call-header">
                    <h3>${isVideoCall ? 'Video Call' : 'Voice Call'} with ${this.getUserName(this.callTarget)}</h3>
                    <div class="call-timer">00:00</div>
                    <div class="call-status">${isCaller ? 'Calling...' : 'Connecting...'}</div>
                </div>
                
                <div class="video-container">
                    ${isVideoCall ? `
                        <video id="remoteVideo" class="remote-video" autoplay playsinline></video>
                        <video id="localVideo" class="local-video" autoplay playsinline muted></video>
                    ` : `
                        <div class="voice-call-display">
                            <div class="user-avatar large">${this.getUserAvatar(this.callTarget)}</div>
                            <h4>${this.getUserName(this.callTarget)}</h4>
                            <div class="call-status">${isCaller ? 'Calling...' : 'Connecting...'}</div>
                        </div>
                    `}
                </div>
                
                <div class="call-controls">
                    <button class="call-btn mute-audio" title="Mute Audio">🎤</button>
                    ${isVideoCall ? `<button class="call-btn mute-video" title="Mute Video">📹</button>` : ''}
                    ${isVideoCall && !this.isMobileDevice() ? `<button class="call-btn screen-share" title="Share Screen">🖥️</button>` : ''}
                    ${isVideoCall ? `<button class="call-btn switch-camera" title="Switch Camera">🔄</button>` : ''}
                    <button class="call-btn end-call" title="End Call">📞</button>
                </div>
            </div>
        `;
        
        document.body.insertAdjacentHTML('beforeend', callHTML);
        this.setupCallUIEventListeners();
        this.updateLocalVideo();
        // NOTE: Timer is NOT started here — it starts in handleCallConnected() when peer connects
        
        console.log('✅ Call interface shown');
    }

    showIncomingCallUI(callId, offer, callerUID, isVideoCall) {
        const existingCall = document.getElementById('incomingCall');
        if (existingCall) existingCall.remove();

        // Play ring.mp3 (loops) — with AudioContext unlock for autoplay policy
        this._ringInterval = null;
        const ringAudio = document.getElementById('ringSound');

        const tryPlayRing = () => {
            if (!ringAudio) return;
            ringAudio.currentTime = 0;
            ringAudio.play().then(() => {
                console.log('🔔 Ring started successfully');
            }).catch((err) => {
                console.warn('⚠️ Ring play blocked, trying AudioContext unlock:', err);
                // AudioContext unlock trick — works even without recent user gesture
                // if audio was pre-unlocked on first interaction
                const audioCtx = window._unlockedAudioContext;
                if (audioCtx && audioCtx.state === 'running') {
                    // Resume and retry
                    audioCtx.resume().then(() => {
                        ringAudio.play().catch(() => {
                            // Final fallback: ping.mp3 on repeat
                            const ping = document.getElementById('notifSound');
                            if (ping) {
                                const pingLoop = () => { ping.currentTime = 0; ping.play().catch(() => {}); };
                                pingLoop();
                                this._ringInterval = setInterval(pingLoop, 2500);
                            }
                        });
                    });
                } else {
                    // Fallback: ping.mp3 on repeat
                    const ping = document.getElementById('notifSound');
                    if (ping) {
                        const pingLoop = () => { ping.currentTime = 0; ping.play().catch(() => {}); };
                        pingLoop();
                        this._ringInterval = setInterval(pingLoop, 2500);
                    }
                }
            });
        };

        // If AudioContext exists and is suspended, resume first then play
        if (window._unlockedAudioContext && window._unlockedAudioContext.state === 'suspended') {
            window._unlockedAudioContext.resume().then(tryPlayRing);
        } else {
            tryPlayRing();
        }
        
        const incomingCallHTML = `
            <div id="incomingCall" class="incoming-call-overlay">
                <div class="incoming-call-modal">
                    <div class="caller-info">
                        <div class="caller-avatar large">${this.getUserAvatar(callerUID)}</div>
                        <h3>${this.getUserName(callerUID)}</h3>
                        <p>Incoming ${isVideoCall ? 'Video' : 'Voice'} Call</p>
                    </div>
                    <div class="incoming-call-controls">
                        <button class="call-btn accept-call">✓</button>
                        <button class="call-btn decline-call">✕</button>
                    </div>
                </div>
            </div>
        `;
        
        document.body.insertAdjacentHTML('beforeend', incomingCallHTML);
        
        const acceptBtn = document.querySelector('.accept-call');
        const declineBtn = document.querySelector('.decline-call');
        
        const stopRing = () => {
            const ringAudio = document.getElementById('ringSound');
            if (ringAudio) { ringAudio.pause(); ringAudio.currentTime = 0; }
            if (this._ringInterval) { clearInterval(this._ringInterval); this._ringInterval = null; }
        };

        if (acceptBtn) {
            acceptBtn.onclick = () => {
                stopRing();
                this.acceptCall(callId, offer, callerUID, isVideoCall);
                const incomingCall = document.getElementById('incomingCall');
                if (incomingCall) incomingCall.remove();
            };
        }
        
        if (declineBtn) {
            declineBtn.onclick = () => {
                stopRing();
                this.declineCall(callId);
                const incomingCall = document.getElementById('incomingCall');
                if (incomingCall) incomingCall.remove();
            };
        }
        
        // Auto decline after 45 seconds
        setTimeout(() => {
            const incomingCall = document.getElementById('incomingCall');
            if (incomingCall) {
                stopRing();
                this.declineCall(callId);
                incomingCall.remove();
            }
        }, 45000);
    }

    generateCallId() {
        return `call_${currentUser.uid}_${Date.now()}`;
    }

    updateRemoteVideo() {
        const remoteVideo = document.getElementById('remoteVideo');
        const voiceDisplay = document.querySelector('.voice-call-display');
        
        if (this.remoteStream && remoteVideo) {
            console.log('🎥 Setting remote video source');
            remoteVideo.srcObject = this.remoteStream;
            
            // Ensure video plays
            remoteVideo.play().catch(e => {
                console.error('Remote video play failed:', e);
            });
            
            // Hide voice display if this is a video call
            if (voiceDisplay && this.isVideoCall) {
                voiceDisplay.style.display = 'none';
            }
        } else if (!this.isVideoCall && voiceDisplay) {
            // Show voice call UI
            voiceDisplay.style.display = 'block';
        }
    }

    updateLocalVideo() {
        const localVideo = document.getElementById('localVideo');
        if (localVideo && this.localStream) {
            console.log('📹 Setting local video source');
            localVideo.srcObject = this.localStream;
            localVideo.play().catch(e => console.log('Local video play error:', e));
        }
    }

    startCallTimer() {
        // Timer now starts in handleCallConnected() when the peer actually connects.
        // This method is kept for compatibility but does nothing.
        console.log('⏱️ Timer will start when call connects.');
    }

    async endCall(sendSignal = true) {
        console.log('📞 Ending call');

        // Save call log — only once, only by the caller
        try {
            const db = window.db;
            const currentUser = window.currentUser;
            const target = this.callTarget;
            const isVideo = this.isVideoCall;

            if (db && currentUser && target && this.isCaller && !this.callLogSaved) {
                this.callLogSaved = true;
                let durationStr = null;
                if (this.callDurationStartTime) {
                    const secs = Math.floor((Date.now() - this.callDurationStartTime) / 1000);
                    if (secs >= 1) {
                        const m = Math.floor(secs / 60);
                        const s = secs % 60;
                        durationStr = m > 0 ? `${m}m ${s}s` : `${s}s`;
                    }
                }
                const missed = !this.callDurationStartTime;
                const chatId = [currentUser.uid, target].sort().join('_');

                await db.collection('messages').add({
                    chatId,
                    participants: [currentUser.uid, target],
                    sender: currentUser.uid,
                    text: isVideo ? '📹 Video call' : '📞 Voice call',
                    callType: isVideo ? 'video' : 'voice',
                    duration: durationStr,
                    missed,
                    time: new Date(),
                    type: 'call'
                });
            }
        } catch (err) {
            console.error('Error saving call log:', err);
        }
        
        if (sendSignal && this.currentCallId && window.signalingManager) {
            try {
                await window.signalingManager.sendCallEnd(this.currentCallId);
            } catch (error) {
                console.error('❌ Error sending call end:', error);
            }
        }
        
        if (this.localStream) {
            this.localStream.getTracks().forEach(track => {
                track.stop();
                track.enabled = false;
            });
        }

        // Clean up screen share stream if active
        if (this.screenStream) {
            this.screenStream.getTracks().forEach(t => t.stop());
            this.screenStream = null;
        }
        this.isScreenSharing = false;
        
        if (this.peerConnection) {
            try {
                this.peerConnection.close();
            } catch (error) {
                console.error('❌ Error closing peer connection:', error);
            }
        }
        
        this.cleanupCallUI();
        this.cleanup();
    }

    cleanup() {
        if (this.callTimer) {
            clearInterval(this.callTimer);
            this.callTimer = null;
        }
        
        // FIX: Clean up duration timer
        if (this.callDurationTimer) {
            clearInterval(this.callDurationTimer);
            this.callDurationTimer = null;
        }
        this.callDurationStartTime = null;
        this.callLogSaved = false;
        
        // Remove remote audio element for voice calls
        const remoteAudio = document.getElementById('remoteCallAudio');
        if (remoteAudio) remoteAudio.remove();

        this.peerConnection = null;
        this.localStream = null;
        this.remoteStream = null;
        this.dataChannel = null;
        this.currentCallId = null;
        this.callTarget = null;
        this.pendingICECandidates = [];
        this.pendingAnswer = null;
        this.isSettingRemoteDescription = false;
        this.signalingState = 'stable';
        
        console.log('🧹 WebRTC cleanup completed');
    }

    cleanupCallUI() {
        const callContainer = document.getElementById('callContainer');
        if (callContainer) {
            callContainer.remove();
        }
        
        const incomingCall = document.getElementById('incomingCall');
        if (incomingCall) {
            incomingCall.remove();
        }

        // Stop ring audio
        const ringAudio = document.getElementById('ringSound');
        if (ringAudio) { ringAudio.pause(); ringAudio.currentTime = 0; }
        if (this._ringInterval) { clearInterval(this._ringInterval); this._ringInterval = null; }
    }

    handleCallConnected() {
        console.log('✅ Call connected successfully!');
        
        // Start duration timer only once when actually connected
        if (!this.callDurationTimer && !this.callDurationStartTime) {
            this.callDurationStartTime = Date.now();
            console.log('⏱️ Starting call duration timer');
            
            this.callDurationTimer = setInterval(() => {
                if (this.callDurationStartTime) {
                    const elapsed = Math.floor((Date.now() - this.callDurationStartTime) / 1000);
                    const mins = Math.floor(elapsed / 60);
                    const secs = elapsed % 60;
                    const display = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
                    
                    const timerElement = document.querySelector('.call-timer');
                    if (timerElement) timerElement.textContent = display;
                }
            }, 1000);
        }
        
        const statusElement = document.querySelector('.call-status');
        if (statusElement) {
            statusElement.textContent = 'Connected ✓';
            statusElement.style.color = '#48bb78';
        }
        
        // Ensure videos are playing
        this.updateRemoteVideo();
        this.updateLocalVideo();
    }

    handleCallDisconnected() {
        console.log('❌ Call disconnected');
        this.endCall(false);
    }

    handleCallError(message) {
        console.error('❌ Call error:', message);
        this.showModal('Call Error', message, 'error');
        this.cleanup();
    }

    checkWebRTCSupport() {
        return !!(navigator.mediaDevices && 
                  navigator.mediaDevices.getUserMedia && 
                  window.RTCPeerConnection);
    }

    async declineCall(callId) {
        try {
            if (window.signalingManager) {
                await window.signalingManager.declineCall(callId);
            }
            this.cleanup();
        } catch (error) {
            console.error('❌ Error declining call:', error);
        }
    }

    getUserName(uid) {
        const cached = window.enhancedCache?.get(`user_${uid}`);
        if (cached?.name) return cached.name;
        // Async fetch so next time the name shows correctly
        if (window.db && uid) {
            window.db.collection('users').doc(uid).get().then(doc => {
                if (doc.exists) {
                    window.enhancedCache?.set(`user_${uid}`, doc.data(), 30 * 60 * 1000);
                }
            }).catch(() => {});
        }
        return 'User';
    }

    getUserAvatar(uid) {
        const cached = window.enhancedCache?.get(`user_${uid}`);
        return cached?.name?.charAt(0)?.toUpperCase() || 'U';
    }

    showModal(title, message, type = 'info') {
        if (window.modalManager) {
            window.modalManager.showModal(title, message, type);
        } else {
            alert(`${title}: ${message}`);
        }
    }

    setupCallUIEventListeners() {
        const muteAudioBtn = document.querySelector('.mute-audio');
        const muteVideoBtn = document.querySelector('.mute-video');
        const screenShareBtn = document.querySelector('.screen-share');
        const switchCameraBtn = document.querySelector('.switch-camera');
        const endCallBtn = document.querySelector('.end-call');

        if (muteAudioBtn) {
            muteAudioBtn.addEventListener('click', () => {
                const isMuted = !this.toggleAudio();
                muteAudioBtn.style.background = isMuted ? '#e53e3e' : '#718096';
                muteAudioBtn.title = isMuted ? 'Unmute Audio' : 'Mute Audio';
            });
        }

        if (muteVideoBtn) {
            muteVideoBtn.addEventListener('click', () => {
                const isVideoMuted = !this.toggleVideo();
                muteVideoBtn.style.background = isVideoMuted ? '#e53e3e' : '#718096';
                muteVideoBtn.title = isVideoMuted ? 'Enable Video' : 'Disable Video';
            });
        }

        if (screenShareBtn) {
            screenShareBtn.addEventListener('click', () => {
                this.toggleScreenShare();
            });
        }

        if (switchCameraBtn) {
            switchCameraBtn.addEventListener('click', () => {
                this.switchCamera();
            });
        }

        if (endCallBtn) {
            endCallBtn.addEventListener('click', () => {
                this.endCall();
            });
        }
    }

    sendCallMetadata() {
        if (this.dataChannel && this.dataChannel.readyState === 'open') {
            this.dataChannel.send(JSON.stringify({
                type: 'metadata',
                user: currentUserData?.name || 'User',
                timestamp: new Date().toISOString()
            }));
        }
    }

    handleDataChannelMessage(data) {
        try {
            const message = JSON.parse(data);
            console.log('Data channel message:', message);
        } catch (error) {
            console.error('Error parsing data channel message:', error);
        }
    }
}

window.webRTCManager = new WebRTCManager();

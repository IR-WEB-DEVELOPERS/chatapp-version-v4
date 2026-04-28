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

        // BUG 2 FIX: Queue for tracks that arrived before DOM was ready
        this._pendingRemoteTracks = [];
        
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
            this._pendingRemoteTracks = [];
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
            this._pendingRemoteTracks = [];
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

            // BUG 2 FIX: ontrack race condition — video element DOM లో లేనప్పుడు track వస్తే
            // updateRemoteVideo() fail అవుతుంది. Solution: track ని queue చేసి,
            // showCallInterface() DOM insert చేసిన తర్వాత flush చేయాలి.
            // BUG 3 FIX: Mobile autoplay — audio-only calls కి dedicated <audio> element
            // వాడాలి. Video calls లో <video> element playsinline + muted=false గా set చేయాలి.
            // User gesture తర్వాత play() call చేయాలి (acceptCall/startCall లో gesture ఉంది).
            this.peerConnection.ontrack = (event) => {
                console.log('🎬 Remote track received:', event.track.kind, event.streams);

                if (event.streams && event.streams[0]) {
                    this.remoteStream = event.streams[0];
                } else {
                    // No stream attached — build one from the track directly
                    if (!this.remoteStream) {
                        this.remoteStream = new MediaStream();
                    }
                    this.remoteStream.addTrack(event.track);
                }

                if (event.track.kind === 'audio' && !this.isVideoCall) {
                    // ── Voice call: pipe audio to a dedicated <audio> element ──────────
                    // BUG 3 FIX: Use <audio> not <video> for audio-only calls.
                    // autoplay alone is blocked on mobile; call play() explicitly after
                    // setting srcObject so the browser treats it as user-gesture-triggered.
                    this._attachRemoteAudio(this.remoteStream || new MediaStream([event.track]));
                } else {
                    // ── Video call: attach to <video> element ─────────────────────────
                    // BUG 2 FIX: Check if DOM element exists yet. If not, queue and retry
                    // after DOM is inserted (showCallInterface calls _flushPendingTracks).
                    const remoteVideo = document.getElementById('remoteVideo');
                    if (remoteVideo) {
                        this._attachRemoteVideo(remoteVideo);
                    } else {
                        console.log('⏳ remoteVideo DOM not ready — queuing track for later');
                        this._pendingRemoteTracks.push({ kind: event.track.kind, stream: this.remoteStream });
                    }
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

    // BUG 2 FIX: Called by showCallInterface() after DOM is fully inserted.
    // Flushes any remote tracks that arrived before the video element existed.
    _flushPendingTracks() {
        if (!this._pendingRemoteTracks.length) return;
        console.log(`🔄 Flushing ${this._pendingRemoteTracks.length} pending remote track(s)`);
        const remoteVideo = document.getElementById('remoteVideo');
        this._pendingRemoteTracks.forEach(({ kind }) => {
            if (kind !== 'audio' && remoteVideo) {
                this._attachRemoteVideo(remoteVideo);
            }
        });
        this._pendingRemoteTracks = [];
    }

    // BUG 3 FIX: Centralised helper — attaches stream to <video> and calls play()
    // with the playsInline + muted=false combination required for mobile autoplay policy.
    _attachRemoteVideo(videoEl) {
        if (!videoEl || !this.remoteStream) return;
        console.log('🎥 Attaching remote stream to video element');
        videoEl.srcObject = this.remoteStream;
        // playsInline is already set via HTML attribute; ensure it programmatically too
        videoEl.playsInline = true;
        videoEl.muted = false;
        videoEl.play().catch(e => {
            console.warn('Remote video play() blocked, will retry on user gesture:', e);
            // Retry once on the next user-interaction event
            const retry = () => {
                videoEl.play().catch(err => console.error('Remote video retry play failed:', err));
                document.removeEventListener('touchstart', retry);
                document.removeEventListener('click', retry);
            };
            document.addEventListener('touchstart', retry, { once: true });
            document.addEventListener('click', retry, { once: true });
        });
    }

    // BUG 3 FIX: Dedicated audio helper for voice calls.
    // <audio> avoids the mobile autoplay restrictions that affect <video> elements
    // when not initiated from a direct user gesture on the media element itself.
    _attachRemoteAudio(stream) {
        let remoteAudio = document.getElementById('remoteCallAudio');
        if (!remoteAudio) {
            remoteAudio = document.createElement('audio');
            remoteAudio.id = 'remoteCallAudio';
            remoteAudio.style.display = 'none';
            // BUG 3 FIX: playsInline prevents iOS from opening the system audio player
            remoteAudio.setAttribute('playsinline', '');
            remoteAudio.autoplay = true;
            document.body.appendChild(remoteAudio);
        }
        remoteAudio.srcObject = stream;
        remoteAudio.play().catch(e => {
            console.warn('Remote audio play() blocked, will retry on user gesture:', e);
            const retry = () => {
                remoteAudio.play().catch(err => console.error('Remote audio retry play failed:', err));
                document.removeEventListener('touchstart', retry);
                document.removeEventListener('click', retry);
            };
            document.addEventListener('touchstart', retry, { once: true });
            document.addEventListener('click', retry, { once: true });
        });
        console.log('🔊 Remote audio element connected for voice call');
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
                    btn.innerHTML = window.Icons ? window.Icons.get('monitor', 22) : '⬜';
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
                    btn.innerHTML = window.Icons ? window.Icons.get('stopShare', 22) : '⬜';
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

    // UI Methods
    showCallInterface(isCaller, isVideoCall) {
        this.cleanupCallUI();

        // SVG icon for "add person" — inline so no Icons dependency needed
        const addPersonSVG = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/></svg>`;
        
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
                    <button class="call-btn mute-audio" title="Mute Audio">${window.Icons.get('micFill', 24)}</button>
                    ${isVideoCall ? `<button class="call-btn mute-video" title="Mute Video">${window.Icons.get('videoFill', 24)}</button>` : ''}
                    ${isVideoCall && !this.isMobileDevice() ? `<button class="call-btn screen-share" title="Share Screen">${window.Icons.get('monitor', 24)}</button>` : ''}
                    ${isVideoCall ? `<button class="call-btn switch-camera" title="Switch Camera">${window.Icons.get('switchCam', 24)}</button>` : ''}
                    <button class="call-btn add-member" title="Add Member">${addPersonSVG}</button>
                    <button class="call-btn end-call" title="End Call">${window.Icons.get('phoneEnd', 24)}</button>
                </div>
            </div>
        `;
        
        document.body.insertAdjacentHTML('beforeend', callHTML);
        this.setupCallUIEventListeners();
        this.updateLocalVideo();

        // BUG 2 FIX: DOM is now ready — flush any tracks that arrived before the
        // video element existed. Must run AFTER insertAdjacentHTML completes.
        this._flushPendingTracks();

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
                        <button class="call-btn accept-call">${window.Icons.get('phoneAccept', 24)}</button>
                        <button class="call-btn decline-call">${window.Icons.get('phoneEnd', 24)}</button>
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
            this._attachRemoteVideo(remoteVideo);
            
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
            // BUG 3 FIX: local video is always muted (no echo), playsInline for mobile
            localVideo.muted = true;
            localVideo.playsInline = true;
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
                    text: isVideo ? 'Video call' : 'Voice call',
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
        this._pendingRemoteTracks = [];
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

        const addMemberBtn = document.querySelector('.add-member');
        if (addMemberBtn) {
            addMemberBtn.addEventListener('click', () => {
                this.showAddMemberPicker();
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

    // ──────────────────────────────────────────────────────────
    //  Add Member: Show friend picker bottom sheet
    // ──────────────────────────────────────────────────────────
    showAddMemberPicker() {
        // Remove any existing picker
        document.getElementById('addMemberOverlay')?.remove();

        const friends = window.currentUserData?.friends || [];
        // Exclude the person already in the call
        const candidates = friends.filter(uid => uid !== this.callTarget);

        // Already-invited set (persists while picker is open)
        const invited = new Set();

        const overlay = document.createElement('div');
        overlay.className = 'add-member-overlay';
        overlay.id = 'addMemberOverlay';

        const renderList = (filter = '') => {
            const lower = filter.toLowerCase();
            const filtered = candidates.filter(uid => {
                const d = window.enhancedCache?.get(`user_${uid}`);
                if (!d) return false;
                return !filter || (d.name || '').toLowerCase().includes(lower);
            });

            if (filtered.length === 0) {
                return `<div class="add-member-empty">${filter ? 'No friends match your search' : 'No other friends to add'}</div>`;
            }

            return filtered.map(uid => {
                const d = window.enhancedCache?.get(`user_${uid}`) || {};
                const initial = (d.name || 'U').charAt(0).toUpperCase();
                const avatarInner = d.photoURL
                    ? `<img src="${d.photoURL}" alt="${initial}" onerror="this.style.display='none';this.parentNode.textContent='${initial}'">`
                    : initial;
                const isInvited = invited.has(uid);
                return `
                    <button class="am-friend-item" data-uid="${uid}" ${isInvited ? 'disabled' : ''}>
                        <div class="am-avatar">${avatarInner}</div>
                        <div class="am-info">
                            <div class="am-name">${(d.name || 'User').replace(/</g, '&lt;')}</div>
                            <div class="am-status">${d.status === 'online' ? '🟢 Online' : '⚫ Offline'}</div>
                        </div>
                        <span class="${isInvited ? 'am-invited-badge' : 'am-invite-badge'}">${isInvited ? 'Invited' : 'Invite'}</span>
                    </button>`;
            }).join('');
        };

        overlay.innerHTML = `
            <div class="add-member-sheet">
                <div class="add-member-header">
                    <h3>Add to Call</h3>
                    <button class="add-member-close" id="amCloseBtn">✕</button>
                </div>
                <div class="add-member-search">
                    <input type="text" id="amSearch" placeholder="Search friends…" autocomplete="off">
                </div>
                <div class="add-member-list" id="amList">
                    ${renderList()}
                </div>
            </div>
        `;

        document.body.appendChild(overlay);

        // Close on backdrop click
        overlay.addEventListener('click', e => {
            if (e.target === overlay) overlay.remove();
        });
        document.getElementById('amCloseBtn').addEventListener('click', () => overlay.remove());

        // Search filter
        document.getElementById('amSearch').addEventListener('input', e => {
            document.getElementById('amList').innerHTML = renderList(e.target.value);
            this._bindAmItems(overlay, invited, renderList);
        });

        this._bindAmItems(overlay, invited, renderList);
    }

    _bindAmItems(overlay, invited, renderList) {
        overlay.querySelectorAll('.am-friend-item:not([disabled])').forEach(btn => {
            btn.addEventListener('click', async () => {
                const uid = btn.dataset.uid;
                if (invited.has(uid)) return;
                invited.add(uid);

                // Re-render to show "Invited" badge
                document.getElementById('amList').innerHTML = renderList(
                    document.getElementById('amSearch')?.value || ''
                );
                this._bindAmItems(overlay, invited, renderList);

                await this.upgradeToGroupCall(uid);
            });
        });
    }

    // ──────────────────────────────────────────────────────────
    //  Upgrade 1-1 call → group call mesh
    //
    //  Flow:
    //  1. Create a groupCalls room keyed on a sorted uid pair
    //  2. Current call's two participants join the room
    //  3. Send a Firestore invite to the new member
    //  4. End the 1-1 peer connection (GroupCallManager handles its own)
    //  5. GroupCallManager takes over the UI
    // ──────────────────────────────────────────────────────────
    async upgradeToGroupCall(newMemberUID) {
        if (!window.GroupCallManager) {
            window.showToast?.('Group call system not available', 'error');
            return;
        }

        const myUID     = window.currentUser?.uid;
        const otherUID  = this.callTarget;
        const isVideo   = this.isVideoCall;

        // Deterministic room id from the original two participants
        const roomId = 'room_' + [myUID, otherUID].sort().join('_');

        console.log('🔄 Upgrading 1-1 call to group call, room:', roomId);
        window.showToast?.('Adding member…', 'info');

        try {
            // 1. Send invite to the new member BEFORE ending 1-1 call
            const invited = await window.GroupCallManager.inviteToRoom(newMemberUID, roomId, isVideo);
            if (!invited) throw new Error('Could not send invite');

            // 2. End the 1-1 signaling cleanly (don't show "call ended" to other peer yet)
            //    We keep localStream alive — GroupCallManager will acquire its own stream,
            //    so stop ours now to avoid double-camera-use on mobile.
            if (this.localStream) {
                this.localStream.getTracks().forEach(t => t.stop());
            }
            if (this.peerConnection) {
                try { this.peerConnection.close(); } catch(_) {}
            }
            // Signal the other side that 1-1 is ending (they will also see the group invite)
            if (this.currentCallId && window.signalingManager) {
                window.signalingManager.sendCallEnd(this.currentCallId).catch(() => {});
            }

            // 3. Clean up 1-1 UI (NOT full cleanup — let GroupCallManager build its own)
            const cc = document.getElementById('callContainer');
            if (cc) cc.remove();
            document.getElementById('addMemberOverlay')?.remove();

            // 4. Reset 1-1 state
            this.cleanup();

            // 5. Start group call — this peer becomes the first participant
            await window.GroupCallManager.startCall(roomId, isVideo);

        } catch (err) {
            console.error('❌ Upgrade to group call failed:', err);
            window.showToast?.('Could not add member: ' + err.message, 'error');
        }
    }

window.webRTCManager = new WebRTCManager();

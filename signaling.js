// signaling.js - Fixed version with better error handling
class SignalingManager {
    constructor() {
        this.callCollection = null;
        this.initialized = false;
        this.pendingInitialization = false;
        
        // Better reconnection settings
        this.reconnectTimeout = null;
        this.maxReconnectDelay = 5000;
        
        console.log('🚀 SignalingManager created');
    }

    initialize() {
        if (this.initialized || this.pendingInitialization) return;
        
        // Wait for Firebase and currentUser
        if (typeof window.db === 'undefined' || !window.currentUser || !window.currentUser.uid) {
            console.log('⏳ Waiting for Firebase and user...');
            setTimeout(() => this.initialize(), 500);
            return;
        }
        
        this.pendingInitialization = true;
        console.log('✅ Initializing signaling for user:', window.currentUser.uid);
        
        try {
            this.callCollection = window.db.collection('calls');
            this.setupSignalingListeners();
            this.initialized = true;
            this.pendingInitialization = false;
            
            console.log('🎉 Signaling manager initialized successfully');
        } catch (error) {
            console.error('❌ Signaling initialization failed:', error);
            this.pendingInitialization = false;
        }
    }

    setupSignalingListeners() {
        if (!this.callCollection) {
            console.error('Call collection not initialized');
            return;
        }

        console.log('🔍 Setting up signaling listeners for user:', window.currentUser.uid);
        
        // FIX: Single listener for incoming calls (added + modified) — prevents double-firing
        this.callCollection
            .where('to', '==', window.currentUser.uid)
            .onSnapshot(snapshot => {
                snapshot.docChanges().forEach(change => {
                    const callData = change.doc.data();
                    if (change.type === 'added') {
                        console.log('📞 Incoming call received:', change.doc.id, callData);
                        this.handleIncomingCall(change.doc.id, callData);
                    } else if (change.type === 'modified') {
                        console.log('📨 Call update received:', change.doc.id, callData.type);
                        this.handleCallUpdate(change.doc.id, callData);
                    }
                });
            }, error => {
                console.error('❌ Error listening for incoming calls:', error);
            });

        // Listen for outgoing call updates
        this.callCollection
            .where('from', '==', window.currentUser.uid)
            .onSnapshot(snapshot => {
                snapshot.docChanges().forEach(change => {
                    if (change.type === 'modified') {
                        const callData = change.doc.data();
                        console.log('📤 Outgoing call update:', change.doc.id, callData.type);
                        this.handleOutgoingCallUpdate(change.doc.id, callData);
                    }
                });
            }, error => {
                console.error('❌ Error listening for outgoing calls:', error);
            });
    }

    async sendOffer(callId, offer, targetUID, isVideoCall = true) {
        if (!this.isReady()) {
            throw new Error('Signaling manager not ready');
        }

        try {
            console.log('📤 Sending offer for call:', callId);
            
            const offerData = {
                type: offer.type,
                sdp: offer.sdp
            };
            
            await this.callCollection.doc(callId).set({
                type: 'offer',
                offer: offerData,
                from: window.currentUser.uid,
                to: targetUID,
                status: 'pending',
                timestamp: new Date(),
                isVideoCall: isVideoCall,
                callerCandidates: [],
                calleeCandidates: []
            });
            
            console.log('✅ Offer sent successfully');
        } catch (error) {
            console.error('❌ Error sending offer:', error);
            throw error;
        }
    }

    async sendAnswer(callId, answer) {
        if (!this.isReady()) {
            throw new Error('Signaling manager not ready');
        }

        try {
            console.log('📤 Sending answer for call:', callId);
            
            const answerData = {
                type: answer.type,
                sdp: answer.sdp
            };
            
            await this.callCollection.doc(callId).update({
                type: 'answer',
                answer: answerData,
                status: 'answered',
                answeredAt: new Date()
            });
            
            console.log('✅ Answer sent successfully');
        } catch (error) {
            console.error('❌ Error sending answer:', error);
            throw error;
        }
    }

    async sendICECandidate(callId, candidate, isCaller = true) {
        if (!this.isReady()) {
            console.warn('Signaling manager not ready, skipping ICE candidate');
            return;
        }

        try {
            if (!candidate.candidate) {
                console.log('No candidate data to send');
                return;
            }

            console.log('🧊 Sending ICE candidate for call:', callId, 'isCaller:', isCaller);
            
            const serializedCandidate = {
                candidate: candidate.candidate,
                sdpMid: candidate.sdpMid || '',
                sdpMLineIndex: candidate.sdpMLineIndex || 0,
                usernameFragment: candidate.usernameFragment || '',
                type: 'candidate'
            };

            // FIX: Use separate arrays so each peer only receives the other's candidates
            const field = isCaller ? 'callerCandidates' : 'calleeCandidates';
            
            await this.callCollection.doc(callId).update({
                [field]: firebase.firestore.FieldValue.arrayUnion(serializedCandidate)
            });
            
            console.log('✅ ICE candidate sent to', field);
        } catch (error) {
            console.error('❌ Error sending ICE candidate:', error);
        }
    }

    async sendCallEnd(callId) {
        if (!this.isReady()) {
            console.warn('Signaling manager not ready, skipping call end');
            return;
        }

        try {
            console.log('📞 Sending call end for call:', callId);
            
            await this.callCollection.doc(callId).update({
                status: 'ended',
                endedAt: new Date()
            });
            
            console.log('✅ Call end sent successfully');
            
            setTimeout(() => {
                this.cleanupCallDocument(callId);
            }, 5000);
            
        } catch (error) {
            console.error('❌ Error sending call end:', error);
            throw error;
        }
    }

    async cleanupCallDocument(callId) {
        if (!this.isReady()) return;

        try {
            await this.callCollection.doc(callId).delete();
            console.log('🗑️ Call document cleaned up:', callId);
        } catch (error) {
            console.error('❌ Error cleaning up call document:', error);
        }
    }

    handleIncomingCall(callId, callData) {
        if (callData.type === 'offer' && callData.status === 'pending') {

            // FIX: Page refresh చేసినప్పుడు stale call documents ring చేయకూడదు
            // Call 30 seconds కంటే పాతదైతే ignore చేయాలి
            const callTime = callData.timestamp?.toDate
                ? callData.timestamp.toDate()
                : new Date(callData.timestamp);
            const ageSeconds = (Date.now() - callTime.getTime()) / 1000;
            if (ageSeconds > 30) {
                console.log('⏭️ Ignoring stale call (age:', Math.round(ageSeconds), 's):', callId);
                // Stale call document cleanup
                this.cleanupCallDocument(callId);
                return;
            }

            console.log('📞 Handling incoming call offer:', callId, '(age:', Math.round(ageSeconds), 's)');

            const offer = new RTCSessionDescription({
                type: callData.offer.type,
                sdp: callData.offer.sdp
            });

            if (window.webRTCManager) {
                window.webRTCManager.handleOffer(callId, offer, callData.from, callData.isVideoCall);
            } else {
                console.error('❌ WebRTCManager not initialized');
            }
        }
    }

    handleCallUpdate(callId, callData) {
        console.log('📨 Handling call update:', callData.type, callData.status);
        
        if (callData.type === 'answer' && callData.status === 'answered') {
            this.handleAnswer(callId, callData);
        } else if (callData.status === 'ended') {
            this.handleCallEnd(callId, callData);
        } else if (callData.status === 'declined') {
            this.handleCallDeclined(callId, callData);
        }
        // FIX: callee reads callerCandidates (the caller's ICE candidates)
        if (callData.callerCandidates && callData.callerCandidates.length > 0) {
            this.handleICECandidates(callId, callData.callerCandidates);
        }
    }

    handleOutgoingCallUpdate(callId, callData) {
        console.log('📤 Handling outgoing call update:', callData.type, callData.status);
        
        if (callData.status === 'answered') {
            this.handleAnswer(callId, callData);
        } else if (callData.status === 'ended') {
            this.handleCallEnd(callId, callData);
        } else if (callData.status === 'declined') {
            this.handleCallDeclined(callId, callData);
        }
        // FIX: caller reads calleeCandidates (the callee's ICE candidates)
        if (callData.calleeCandidates && callData.calleeCandidates.length > 0) {
            this.handleICECandidates(callId, callData.calleeCandidates);
        }
    }

    handleAnswer(callId, callData) {
        console.log('✅ Handling answer for call:', callId);
        
        if (!callData.answer) {
            console.error('❌ No answer data in call update');
            return;
        }
        
        const answer = new RTCSessionDescription({
            type: callData.answer.type,
            sdp: callData.answer.sdp
        });
        
        if (window.webRTCManager) {
            window.webRTCManager.handleAnswer(answer);
        } else {
            console.error('❌ WebRTCManager not initialized');
        }
    }

    handleICECandidates(callId, candidates) {
        console.log('🧊 Handling ICE candidates for call:', callId, 'Count:', candidates.length);
        
        candidates.forEach((candidate, index) => {
            if (candidate.type === 'candidate' && candidate.candidate) {
                try {
                    const iceCandidate = new RTCIceCandidate({
                        candidate: candidate.candidate,
                        sdpMid: candidate.sdpMid || null,
                        sdpMLineIndex: candidate.sdpMLineIndex || 0,
                        usernameFragment: candidate.usernameFragment || null
                    });
                    
                    console.log(`🧊 Processing ICE candidate ${index + 1}/${candidates.length}`);
                    
                    if (window.webRTCManager) {
                        window.webRTCManager.handleICECandidate(iceCandidate);
                    } else {
                        console.error('❌ WebRTCManager not initialized');
                    }
                } catch (error) {
                    console.error('❌ Error handling ICE candidate:', error, candidate);
                }
            } else {
                console.log('Skipping invalid candidate:', candidate);
            }
        });
    }

    handleCallEnd(callId, callData) {
        console.log('📞 Handling call end for call:', callId);
        
        if (window.webRTCManager) {
            window.webRTCManager.handleCallDisconnected();
        }
        
        this.cleanupCallDocument(callId);
    }

    handleCallDeclined(callId, callData) {
        console.log('❌ Handling call declined for call:', callId);
        
        if (window.webRTCManager) {
            window.webRTCManager.handleCallDisconnected();
        }
        
        // Show notification to user
        if (window.modalManager) {
            window.modalManager.showModal('Call Declined', 'The call was declined.', 'info');
        }
        
        setTimeout(() => {
            this.cleanupCallDocument(callId);
        }, 3000);
    }

    async declineCall(callId) {
        if (!this.isReady()) {
            throw new Error('Signaling manager not ready');
        }

        try {
            console.log('❌ Declining call:', callId);
            
            await this.callCollection.doc(callId).update({
                status: 'declined',
                declinedAt: new Date()
            });
            
            console.log('✅ Call declined successfully');
            
            setTimeout(() => {
                this.cleanupCallDocument(callId);
            }, 3000);
            
        } catch (error) {
            console.error('❌ Error declining call:', error);
            throw error;
        }
    }

    async getCallStatus(callId) {
        if (!this.isReady()) return null;

        try {
            const doc = await this.callCollection.doc(callId).get();
            if (doc.exists) {
                return doc.data();
            }
            return null;
        } catch (error) {
            console.error('❌ Error getting call status:', error);
            return null;
        }
    }

    async cleanupOldCalls() {
        if (!this.isReady()) return;

        try {
            const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
            
            const endedCalls = await this.callCollection
                .where('status', 'in', ['ended', 'declined'])
                .where('timestamp', '<', twentyFourHoursAgo)
                .get();
            
            const batch = window.db.batch();
            endedCalls.forEach(doc => {
                batch.delete(doc.ref);
            });
            
            await batch.commit();
            console.log(`🗑️ Cleaned up ${endedCalls.size} old calls`);
            
        } catch (error) {
            console.error('❌ Error cleaning up old calls:', error);
        }
    }

    // Utility method to check if signaling is ready
    isReady() {
        return this.initialized && this.callCollection !== null && window.currentUser !== null;
    }

    // Method to reset signaling (for logout, etc.)
    reset() {
        this.initialized = false;
        this.callCollection = null;
    }
}

// Make SignalingManager globally available  
window.signalingManager = new SignalingManager();

console.log('🚀 Signaling manager loaded successfully - waiting for initialization');
// ── Firebase auth is initialised by the Firebase SDK scripts loaded in
//    index.html before this file. Do NOT call firebase.initializeApp() here —
//    globals.js (on chat.html) or the compat SDK handles that, and calling it
//    twice causes "Firebase App named '[DEFAULT]' already exists" crashes.

// auth.setPersistence is called once here for the login page context.
const auth = firebase.auth();
auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL).catch((err) => {
    console.warn('Firebase auth persistence setup failed:', err);
});


const LOGIN_VERIFIED_PREFIX = 'educhat_login_otp_verified_';

let currentOtp = '';
let currentOtpExpiry = 0;
let resendTimer = null;
let pendingUser = null;
let otpSendInFlight = false;
let lastOtpKey = '';

function markLoginVerified(uid) {
    localStorage.setItem(`${LOGIN_VERIFIED_PREFIX}${uid}`, 'true');
    localStorage.setItem('educhat_last_verified_uid', uid);
}

function isLoginVerified(uid) {
    return localStorage.getItem(`${LOGIN_VERIFIED_PREFIX}${uid}`) === 'true';
}

function generateOtp() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

function ensureOtpModal() {
    let modal = document.getElementById('loginOtpModal');
    if (modal) return modal;

    modal = document.createElement('div');
    modal.id = 'loginOtpModal';
    modal.className = 'login-otp-overlay';
    modal.innerHTML = `
        <div class="login-otp-card">
            <div class="login-otp-header">
                <div>
                    <h3>Email OTP Verification</h3>
                    <p>Enter the 6-digit OTP sent to your email.</p>
                </div>
                <button id="closeLoginOtp" class="login-otp-close" type="button">&times;</button>
            </div>
            <div class="login-otp-body">
                <div class="login-otp-email" id="loginOtpEmail"></div>
                <input id="loginOtpInput" class="login-otp-input" type="text" inputmode="numeric" maxlength="6" placeholder="000000">
                <div id="loginOtpError" class="login-otp-error"></div>
                <button id="verifyLoginOtp" class="login-otp-primary" type="button">Verify OTP</button>
                <button id="resendLoginOtp" class="login-otp-secondary" type="button">Resend OTP</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);

    document.getElementById('closeLoginOtp').addEventListener('click', async () => {
        modal.style.display = 'none';
        clearInterval(resendTimer);
        await auth.signOut();
        pendingUser = null;
        otpSendInFlight = false;
        lastOtpKey = '';
    });
    document.getElementById('verifyLoginOtp').addEventListener('click', verifyLoginOtp);
    document.getElementById('resendLoginOtp').addEventListener('click', () => sendLoginOtp(pendingUser));
    document.getElementById('loginOtpInput').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') verifyLoginOtp();
    });

    return modal;
}

async function sendLoginOtp(user) {
    if (!user?.email) {
        alert('No email found for this account.');
        await auth.signOut();
        return;
    }
    const existingModal = document.getElementById('loginOtpModal');
    const key = `${user.uid}:${user.email}`;
    if (otpSendInFlight || (lastOtpKey === key && existingModal?.style.display === 'flex')) return;

    otpSendInFlight = true;
    lastOtpKey = key;
    pendingUser = user;
    currentOtp = '';
    currentOtpExpiry = 0;

    // ── Show modal immediately — don't wait for SMTP round-trip ──
    const modal = ensureOtpModal();
    document.getElementById('loginOtpEmail').textContent = user.email;
    document.getElementById('loginOtpInput').value = '';
    document.getElementById('loginOtpError').textContent = 'Sending OTP to your email…';
    document.getElementById('verifyLoginOtp').disabled = true;
    document.getElementById('resendLoginOtp').disabled = true;
    modal.style.display = 'flex';
    document.getElementById('loginOtpInput').focus();

    let response;
    try {
        response = await fetch('/send-otp', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ uid: user.uid, email: user.email, purpose: 'login' })
        }).then(r => r.json());
    } catch (err) {
        console.error('Backend OTP send failed:', err);
        response = { ok: false, error: 'Failed to send OTP. Check SMTP settings.' };
    }

    document.getElementById('verifyLoginOtp').disabled = false;

    if (!response?.ok) {
        otpSendInFlight = false;
        lastOtpKey = '';
        modal.style.display = 'none';
        await auth.signOut();
        alert(response?.error || 'Failed to send OTP.');
        return;
    }

    document.getElementById('loginOtpError').textContent = '';
    startResendCountdown();
    otpSendInFlight = false;
}

function startResendCountdown() {
    let seconds = 60;
    const resendBtn = document.getElementById('resendLoginOtp');
    resendBtn.disabled = true;
    resendBtn.textContent = `Resend OTP (${seconds}s)`;
    clearInterval(resendTimer);
    resendTimer = setInterval(() => {
        seconds--;
        resendBtn.textContent = `Resend OTP (${seconds}s)`;
        if (seconds <= 0) {
            clearInterval(resendTimer);
            resendBtn.disabled = false;
            resendBtn.textContent = 'Resend OTP';
        }
    }, 1000);
}

async function verifyLoginOtp() {
    const input = (document.getElementById('loginOtpInput')?.value || '').trim();
    const error = document.getElementById('loginOtpError');
    if (!/^\d{6}$/.test(input)) {
        error.textContent = 'Enter a valid 6-digit OTP.';
        return;
    }

    let valid = input === currentOtp && Date.now() < currentOtpExpiry;
    try {
        const result = await fetch('/verify-otp', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                uid: pendingUser.uid,
                email: pendingUser.email,
                purpose: 'login',
                code: input
            })
        }).then(r => r.json());
        valid = !!result.ok;
        if (!valid && result.error) error.textContent = result.error;
    } catch (err) {
        console.warn('Backend OTP verify failed, using browser fallback OTP:', err);
    }

    if (!valid) {
        if (!error.textContent) error.textContent = 'Invalid or expired OTP.';
        return;
    }

    clearInterval(resendTimer);
    markLoginVerified(pendingUser.uid);
    window.location.href = 'chat.html';
}

// Tracks whether OTP flow was triggered by a manual button click.
// onAuthStateChanged fires on every page load for existing sessions —
// we must NOT send OTP automatically; only redirect if already verified.
let _otpTriggeredByClick = false;

document.getElementById('googleLogin').onclick = async () => {
    try {
        const provider = new firebase.auth.GoogleAuthProvider();
        _otpTriggeredByClick = true;
        const result = await auth.signInWithPopup(provider);
        await sendLoginOtp(result.user);
    } catch (error) {
        _otpTriggeredByClick = false;
        console.error('Login error:', error);
        alert('Login failed. Please try again.');
    }
};

auth.onAuthStateChanged(user => {
    if (!user) return;

    // Always redirect if OTP already verified this session
    if (isLoginVerified(user.uid)) {
        window.location.href = 'chat.html';
        return;
    }

    // Only send OTP if user explicitly clicked the Google button.
    // Existing Firebase sessions trigger this callback on page load —
    // we do NOT want to auto-show the OTP modal in that case.
    if (_otpTriggeredByClick) {
        _otpTriggeredByClick = false;
        sendLoginOtp(user);
    }
});

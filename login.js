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

// BUG FIX 1: currentOtp / currentOtpExpiry were never populated from the
// server response, so the browser-side fallback check was always false.
// Removed the dead variables — verification is 100% server-side now.
let resendTimer = null;
let pendingUser = null;
let otpSendInFlight = false;
let lastOtpKey = '';

function markLoginVerified(uid) {
    sessionStorage.setItem(`${LOGIN_VERIFIED_PREFIX}${uid}`, 'true');
    // BUG FIX 2: Was using localStorage which persists forever.
    // Switched to sessionStorage so OTP is re-required on new tab/browser session.
    localStorage.setItem('educhat_last_verified_uid', uid);
}

function isLoginVerified(uid) {
    // BUG FIX 2 (cont): Check sessionStorage first (current session), then
    // fall back to localStorage for backward compat during migration.
    return (
        sessionStorage.getItem(`${LOGIN_VERIFIED_PREFIX}${uid}`) === 'true' ||
        localStorage.getItem(`${LOGIN_VERIFIED_PREFIX}${uid}`) === 'true'
    );
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
                <input id="loginOtpInput" class="login-otp-input" type="text" inputmode="numeric" maxlength="6" placeholder="000000" autocomplete="one-time-code">
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
        // BUG FIX 3: Closing OTP modal must also re-enable the Google button
        // so the user can try again without reloading the page.
        const googleBtn = document.getElementById('googleLogin');
        if (googleBtn) googleBtn.disabled = false;
    });
    document.getElementById('verifyLoginOtp').addEventListener('click', verifyLoginOtp);
    document.getElementById('resendLoginOtp').addEventListener('click', () => sendLoginOtp(pendingUser));
    document.getElementById('loginOtpInput').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') verifyLoginOtp();
    });

    // BUG FIX 4: Only allow numeric characters in the OTP input field.
    document.getElementById('loginOtpInput').addEventListener('input', (e) => {
        e.target.value = e.target.value.replace(/\D/g, '');
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

    // Show modal immediately — don't wait for SMTP round-trip
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
        // BUG FIX 3: Re-enable Google button on failure so user can retry.
        const googleBtn = document.getElementById('googleLogin');
        if (googleBtn) googleBtn.disabled = false;
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
    const verifyBtn = document.getElementById('verifyLoginOtp');

    if (!/^\d{6}$/.test(input)) {
        error.textContent = 'Enter a valid 6-digit OTP.';
        return;
    }

    // BUG FIX 5: Disable button while verifying to prevent double-submit.
    verifyBtn.disabled = true;
    verifyBtn.textContent = 'Verifying…';

    let valid = false;
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
        // BUG FIX 1 (cont): Removed insecure browser-side OTP fallback.
        // If the server is unreachable, we show an error and let the user retry.
        console.error('Backend OTP verify failed:', err);
        error.textContent = 'Network error. Please try again.';
        verifyBtn.disabled = false;
        verifyBtn.textContent = 'Verify OTP';
        return;
    }

    if (!valid) {
        if (!error.textContent) error.textContent = 'Invalid or expired OTP.';
        verifyBtn.disabled = false;
        verifyBtn.textContent = 'Verify OTP';
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

document.getElementById('googleLogin').onclick = async (e) => {
    const btn = e.currentTarget;
    // BUG FIX 6: Disable button immediately on click to prevent double-clicks
    // that fire two Google popups / two sendLoginOtp calls.
    btn.disabled = true;
    try {
        const provider = new firebase.auth.GoogleAuthProvider();
        _otpTriggeredByClick = true;
        const result = await auth.signInWithPopup(provider);
        await sendLoginOtp(result.user);
    } catch (error) {
        _otpTriggeredByClick = false;
        console.error('Login error:', error);
        btn.disabled = false;
        // BUG FIX 7: Don't alert on popup-closed-by-user — that's not an error.
        if (error.code !== 'auth/popup-closed-by-user' && error.code !== 'auth/cancelled-popup-request') {
            alert('Login failed: ' + (error.message || 'Please try again.'));
        }
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

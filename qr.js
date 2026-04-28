// ============================================================
//  qr.js — QR Code generation & scanning utilities
//  CDN: qrcode.js (davidshimjs) for generation
//       html5-qrcode for scanning
// ============================================================

const QRManager = (() => {

    const QRCODE_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';
    const SCANNER_CDN = 'https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js';

    let _qrLib = null;      // loaded QRCode constructor
    let _scannerLib = null; // loaded Html5Qrcode
    let _scannerInstance = null;

    // ── Load CDN script once ──────────────────────────────────
    function _loadScript(src, globalKey) {
        return new Promise((resolve, reject) => {
            if (window[globalKey]) { resolve(window[globalKey]); return; }
            const existing = document.querySelector(`script[src="${src}"]`);
            if (existing) {
                existing.addEventListener('load', () => resolve(window[globalKey]));
                existing.addEventListener('error', reject);
                return;
            }
            const s = document.createElement('script');
            s.src = src;
            s.onload = () => resolve(window[globalKey]);
            s.onerror = () => reject(new Error(`Failed to load ${src}`));
            document.head.appendChild(s);
        });
    }

    // ── Generate QR into a container element ─────────────────
    async function generateQR(containerEl, text, options = {}) {
        try {
            containerEl.innerHTML = '';
            await _loadScript(QRCODE_CDN, 'QRCode');
            new window.QRCode(containerEl, {
                text,
                width:  options.size || 200,
                height: options.size || 200,
                colorDark:  options.dark  || '#111827',
                colorLight: options.light || '#ffffff',
                correctLevel: window.QRCode.CorrectLevel.M
            });
        } catch (e) {
            console.error('QRManager generateQR error:', e);
            containerEl.innerHTML = `<p style="color:var(--danger,#ef4444);font-size:12px;">QR load failed</p>`;
        }
    }

    // ── Build profile QR data string ─────────────────────────
    function profileQRData(uid, name) {
        const base = window.location.origin || 'https://yourapp.com';
        return `${base}/add?uid=${uid}&name=${encodeURIComponent(name || '')}`;
    }

    // ── Share QR as image ─────────────────────────────────────
    async function shareQR(containerEl, name) {
        const canvas = containerEl.querySelector('canvas');
        const img    = containerEl.querySelector('img');
        let dataUrl  = null;

        if (canvas) {
            dataUrl = canvas.toDataURL('image/png');
        } else if (img) {
            // draw img to canvas
            const c = document.createElement('canvas');
            c.width = img.naturalWidth || 200;
            c.height = img.naturalHeight || 200;
            c.getContext('2d').drawImage(img, 0, 0);
            dataUrl = c.toDataURL('image/png');
        }

        if (!dataUrl) { window.showToast?.('QR not ready yet', 'error'); return; }

        if (navigator.share && navigator.canShare) {
            try {
                const blob = await (await fetch(dataUrl)).blob();
                const file = new File([blob], `${name || 'profile'}-qr.png`, { type: 'image/png' });
                if (navigator.canShare({ files: [file] })) {
                    await navigator.share({ files: [file], title: `${name}'s QR Code` });
                    return;
                }
            } catch (err) { /* fall through to download */ }
        }

        // Fallback: download
        const a = document.createElement('a');
        a.href = dataUrl;
        a.download = `${name || 'profile'}-qr.png`;
        a.click();
        window.showToast?.('QR image downloaded!', 'success');
    }

    // ── Scanner Modal ─────────────────────────────────────────
    async function openScannerModal() {
        if (document.getElementById('qrScannerOverlay')) return;

        const overlay = document.createElement('div');
        overlay.id = 'qrScannerOverlay';
        overlay.style.cssText = `
            position:fixed;inset:0;z-index:9999;
            background:rgba(0,0,0,0.85);
            display:flex;flex-direction:column;align-items:center;justify-content:center;
            padding:20px;box-sizing:border-box;
        `;
        overlay.innerHTML = `
            <div style="
                background:var(--bg-primary,#fff);
                border-radius:16px;
                width:100%;max-width:360px;
                overflow:hidden;
                box-shadow:0 20px 60px rgba(0,0,0,0.4);
            ">
                <div style="
                    display:flex;align-items:center;justify-content:space-between;
                    padding:16px 20px;
                    border-bottom:1px solid var(--border-color,#e5e7eb);
                ">
                    <span style="font-size:15px;font-weight:600;color:var(--text-primary,#111);">📷 Scan QR Code</span>
                    <button id="qrScannerClose" style="
                        background:none;border:none;cursor:pointer;
                        font-size:18px;color:var(--text-secondary,#6b7280);padding:4px;
                    ">✕</button>
                </div>

                <div style="padding:16px 20px;">
                    <div id="qrScannerView" style="
                        width:100%;border-radius:12px;
                        overflow:hidden;background:#000;
                        min-height:280px;position:relative;
                    "></div>
                    <p id="qrScannerStatus" style="
                        text-align:center;margin:12px 0 0;
                        font-size:13px;color:var(--text-secondary,#6b7280);
                    ">Loading camera…</p>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        document.getElementById('qrScannerClose').onclick = closeScannerModal;
        overlay.addEventListener('click', (e) => { if (e.target === overlay) closeScannerModal(); });

        try {
            await _loadScript(SCANNER_CDN, 'Html5Qrcode');
            _scannerLib = window.Html5Qrcode;

            _scannerInstance = new _scannerLib('qrScannerView');
            await _scannerInstance.start(
                { facingMode: 'environment' },
                { fps: 10, qrbox: { width: 220, height: 220 } },
                (decodedText) => {
                    closeScannerModal();
                    _handleScanResult(decodedText);
                },
                () => {} // ignore per-frame errors
            );
            document.getElementById('qrScannerStatus').textContent = 'Point camera at a profile QR code';
        } catch (err) {
            console.error('QR scanner start error:', err);
            document.getElementById('qrScannerStatus').textContent = '❌ Camera access denied or unavailable';
        }
    }

    async function closeScannerModal() {
        try {
            if (_scannerInstance) {
                await _scannerInstance.stop();
                _scannerInstance = null;
            }
        } catch (_) {}
        document.getElementById('qrScannerOverlay')?.remove();
    }

    function _handleScanResult(text) {
        // Try to parse uid from URL: ?uid=xxx
        try {
            const url  = new URL(text);
            const uid  = url.searchParams.get('uid');
            const name = url.searchParams.get('name') || '';
            if (uid) {
                window.showToast?.(`Opening ${decodeURIComponent(name)}'s profile…`, 'info');
                setTimeout(() => window.friendProfileViewer?.open(uid), 400);
                return;
            }
        } catch (_) {}
        // Fallback: show raw content
        window.showToast?.(`Scanned: ${text}`, 'info');
    }

    // ── Public API ────────────────────────────────────────────
    return { generateQR, profileQRData, shareQR, openScannerModal, closeScannerModal };
})();

window.QRManager = QRManager;
console.log('qr.js loaded');

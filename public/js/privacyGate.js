import { hasCurrentPrivacyConsent, savePrivacyConsent } from './privacy/consent.js';

const publicHome = document.getElementById('publicHome');
const appShell = document.getElementById('appShell');
const gate = document.getElementById('privacyGate');
const checkbox = document.getElementById('privacyConsentCheckbox');
const acceptButton = document.getElementById('privacyConsentAcceptBtn');
const cancelButton = document.getElementById('privacyGateCancelBtn');
const guestButton = document.getElementById('publicGuestBtn');
const loginButton = document.getElementById('publicLoginBtn');
const error = document.getElementById('privacyGateError');
const legalFooter = document.getElementById('legalFooter');

let requestedMode = 'guest';
let appStarted = false;

function loadRealtimeClient() {
  if (globalThis.mqtt || document.querySelector('script[data-rync-mqtt]')) return;
  const script = document.createElement('script');
  script.dataset.ryncMqtt = 'true';
  script.src = 'https://cdnjs.cloudflare.com/ajax/libs/mqtt/5.10.3/mqtt.min.js';
  script.async = true;
  script.referrerPolicy = 'strict-origin-when-cross-origin';
  document.head.appendChild(script);
}

function hideGate() {
  gate.hidden = true;
  publicHome.inert = false;
  publicHome.removeAttribute('aria-hidden');
  error.hidden = true;
  document.body.classList.remove('privacy-gated');
}

function showGate(mode) {
  requestedMode = mode;
  error.hidden = true;
  checkbox.checked = false;
  acceptButton.disabled = true;
  publicHome.inert = true;
  publicHome.setAttribute('aria-hidden', 'true');
  gate.hidden = false;
  document.body.classList.add('privacy-gated');
  checkbox.focus();
}

async function startRync() {
  if (appStarted) return;
  loadRealtimeClient();
  const { startApp } = await import('./app.js');
  const app = startApp();
  appStarted = true;
  appShell.inert = false;
  appShell.removeAttribute('aria-hidden');
  publicHome.hidden = true;
  gate.hidden = true;
  legalFooter.inert = false;
  legalFooter.removeAttribute('aria-hidden');
  document.body.classList.remove('privacy-gated');

  if (requestedMode === 'login') {
    const authModal = app?.uiManager?.elements?.authModal;
    authModal?.classList.add('active');
    authModal?.querySelector('button, [href], input')?.focus();
  }
}

guestButton.addEventListener('click', () => {
  if (hasCurrentPrivacyConsent()) {
    requestedMode = 'guest';
    startRync().catch(showLoadError);
    return;
  }
  showGate('guest');
});

loginButton.addEventListener('click', () => {
  if (hasCurrentPrivacyConsent()) {
    requestedMode = 'login';
    startRync().catch(showLoadError);
    return;
  }
  showGate('login');
});

function showLoadError() {
  gate.hidden = true;
  publicHome.hidden = false;
  publicHome.inert = false;
  publicHome.removeAttribute('aria-hidden');
  error.hidden = false;
  error.textContent = 'Rync gagal dimuat. Periksa koneksi lalu coba masuk lagi.';
  document.body.classList.remove('privacy-gated');
}

cancelButton.addEventListener('click', () => {
  hideGate();
  (requestedMode === 'login' ? loginButton : guestButton).focus();
});

checkbox.addEventListener('change', () => {
  acceptButton.disabled = !checkbox.checked;
});

acceptButton.addEventListener('click', async () => {
  if (!checkbox.checked) return;
  acceptButton.disabled = true;
  error.hidden = true;
  if (!savePrivacyConsent()) {
    acceptButton.disabled = false;
    error.hidden = false;
    return;
  }
  try {
    await startRync();
  } catch {
      acceptButton.disabled = false;
    showLoadError();
  }
});

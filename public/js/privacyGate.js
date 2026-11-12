import { hasCurrentPrivacyConsent, savePrivacyConsent } from './privacy/consent.js';

const appShell = document.getElementById('appShell');
const gate = document.getElementById('privacyGate');
const checkbox = document.getElementById('privacyConsentCheckbox');
const acceptButton = document.getElementById('privacyConsentAcceptBtn');
const error = document.getElementById('privacyGateError');
const legalFooter = document.getElementById('legalFooter');

function loadRealtimeClient() {
  if (globalThis.mqtt || document.querySelector('script[data-rync-mqtt]')) return;
  const script = document.createElement('script');
  script.dataset.ryncMqtt = 'true';
  script.src = 'https://cdnjs.cloudflare.com/ajax/libs/mqtt/5.10.3/mqtt.min.js';
  script.async = true;
  script.referrerPolicy = 'strict-origin-when-cross-origin';
  document.head.appendChild(script);
}

async function startRync() {
  loadRealtimeClient();
  const { startApp } = await import('./app.js');
  gate.hidden = true;
  appShell.inert = false;
  appShell.removeAttribute('aria-hidden');
  legalFooter.inert = false;
  legalFooter.removeAttribute('aria-hidden');
  document.body.classList.remove('privacy-gated');
  startApp();
}

if (hasCurrentPrivacyConsent()) {
  startRync().catch(() => {
    gate.hidden = false;
    error.hidden = false;
    error.textContent = 'Rync gagal dimuat. Muat ulang halaman untuk mencoba lagi.';
  });
} else {
  document.body.classList.add('privacy-gated');
  checkbox.focus();
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
      error.hidden = false;
      error.textContent = 'Rync gagal dimuat. Muat ulang halaman untuk mencoba lagi.';
    }
  });
}

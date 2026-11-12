export const PRIVACY_CONSENT_VERSION = '2026-11-12';
export const PRIVACY_CONSENT_KEY = 'rync_privacy_consent';

export function hasCurrentPrivacyConsent(storage) {
  try {
    const target = storage === undefined ? globalThis.localStorage : storage;
    const record = JSON.parse(target?.getItem(PRIVACY_CONSENT_KEY) || 'null');
    return record?.version === PRIVACY_CONSENT_VERSION && Number.isFinite(record?.acceptedAt);
  } catch {
    return false;
  }
}

export function savePrivacyConsent(storage, acceptedAt = Date.now()) {
  if (!Number.isFinite(acceptedAt)) return false;
  try {
    const target = storage === undefined ? globalThis.localStorage : storage;
    if (!target) return false;
    target.setItem(PRIVACY_CONSENT_KEY, JSON.stringify({ version: PRIVACY_CONSENT_VERSION, acceptedAt }));
    return true;
  } catch {
    return false;
  }
}

const STORAGE_KEY = 'rync_metrics_v1';
const MAX_METRICS = 10;
const MAX_SAMPLES = 100;
const METRIC_NAME = /^[a-z][a-z0-9_]{0,39}$/;

export function readLocalMetrics() {
  try {
    const metrics = JSON.parse(globalThis.localStorage?.getItem(STORAGE_KEY) || '{}');
    return metrics && typeof metrics === 'object' && !Array.isArray(metrics) ? metrics : {};
  } catch {
    return {};
  }
}

export function recordLocalMetric(name, durationMs, { outcome = 'success' } = {}) {
  if (!METRIC_NAME.test(name) || !Number.isFinite(durationMs) || durationMs < 0) return;
  try {
    const metrics = readLocalMetrics();
    if (!Object.hasOwn(metrics, name) && Object.keys(metrics).length >= MAX_METRICS) return;
    const samples = Array.isArray(metrics[name]) ? metrics[name] : [];
    samples.push({ durationMs: Math.round(durationMs), outcome: outcome === 'failure' ? 'failure' : 'success' });
    metrics[name] = samples.slice(-MAX_SAMPLES);
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(metrics));
  } catch {}
}

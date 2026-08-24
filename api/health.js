export default function handler(req, res) {
  const t1 = Date.now();
  const clientTimestamp = parseInt(req.query?.t0 || '0', 10);
  const t2 = Date.now();
  
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(200).json({
    status: 'ok',
    app: 'Rync432',
    t0: clientTimestamp,
    t1: t1,
    t2: t2,
    timestamp: t2,
    engine: 'Web Audio API + NTP Cristian Synchronizer'
  });
}

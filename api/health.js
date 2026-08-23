export default function handler(req, res) {
  res.status(200).json({
    status: 'ok',
    app: 'Rync432',
    timestamp: Date.now(),
    engine: 'Web Audio API + NTP Cristian Synchronizer'
  });
}

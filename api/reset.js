const fetch = require('node-fetch');

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

module.exports = async (req, res) => {
  const keys = ['pending_events', 'processed_events'];
  const results = {};

  for (const key of keys) {
    const r = await fetch(`${KV_URL}/del/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KV_TOKEN}` }
    });
    results[key] = r.ok ? 'deleted' : 'error';
  }

  return res.status(200).json({ success: true, results, message: 'KV store reset. Run a new scan.' });
};

const fetch = require('node-fetch');

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

async function kvGet(key) {
  try {
    const res = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` }
    });
    const data = await res.json();
    return data.result ? JSON.parse(data.result) : null;
  } catch (e) {
    return null;
  }
}

async function kvSet(key, value) {
  try {
    await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(JSON.stringify(value))
    });
  } catch (e) {
    console.error('KV set error:', e);
  }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    const pending = await kvGet('pending_events') || [];
    const learned = await kvGet('learned_patterns') || {};
    const processed = await kvGet('processed_events') || [];
    return res.status(200).json({ pending, learned, processedCount: processed.length });
  }

  if (req.method === 'POST') {
    const { eventId, decision, attend } = req.body;

    const pending = await kvGet('pending_events') || [];
    const learned = await kvGet('learned_patterns') || {};
    const processed = await kvGet('processed_events') || [];

    const event = pending.find(e => e.id === eventId);
    if (!event) return res.status(404).json({ error: 'Event not found' });

    // Update learned patterns
    const patternKey = `${event.sport}_${event.title.toLowerCase().split(' ')[0]}`;
    if (!learned[patternKey]) {
      learned[patternKey] = { attend, confidence: 1, sport: event.sport, kid: event.kid };
    } else {
      if (learned[patternKey].attend === attend) {
        learned[patternKey].confidence = Math.min(learned[patternKey].confidence + 1, 10);
      } else {
        learned[patternKey].confidence = Math.max(learned[patternKey].confidence - 1, 0);
        if (learned[patternKey].confidence === 0) {
          learned[patternKey].attend = attend;
          learned[patternKey].confidence = 1;
        }
      }
    }

    // Remove from pending
    const updatedPending = pending.filter(e => e.id !== eventId);
    processed.push(eventId);

    await kvSet('pending_events', updatedPending);
    await kvSet('learned_patterns', learned);
    await kvSet('processed_events', processed);

    return res.status(200).json({
      success: true,
      attend,
      patternKey,
      confidence: learned[patternKey].confidence,
      message: attend ? 'Got it — will block your calendar for this type of event' : 'Got it — will skip blocking for this type of event'
    });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};

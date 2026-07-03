const fetch = require('node-fetch');
const ical = require('ical');

// Calendar feeds
const CALENDARS = [
  {
    name: 'Legion Baseball',
    kid: 'Kainen',
    sport: 'Baseball',
    url: 'https://api.team-manager.gc.com/ics-calendar-documents/user/f5b5dfba-e649-453c-8874-53f42662908c.ics?teamId=23164a2c-a510-48e6-950f-923f4056cbbf&token=c8c7650eaf9736895fca205d672e4fd3a900d27e622850e78012bca51bd05d5d'
  },
  {
    name: 'Palmer Moose Hockey',
    kid: 'Kainen',
    sport: 'Hockey',
    url: 'https://calendar.sportsyou.com/access/us-7ca1c5a8-39c2-46d1-957f-027449c9cf88/6415d121-51ac-407d-ba84-b215499336cd'
  },
  {
    name: 'Palmer Moose Football',
    kid: 'Kainen',
    sport: 'Football',
    url: 'https://calendar.sportsyou.com/access/us-7ca1c5a8-39c2-46d1-957f-027449c9cf88/00168bed-7b68-42a8-b7cd-5ef60b263b11'
  },
  {
    name: 'Polar Pitch Softball',
    kid: 'Kiya',
    sport: 'Softball',
    url: 'https://api.team-manager.gc.com/ics-calendar-documents/user/f5b5dfba-e649-453c-8874-53f42662908c.ics?teamId=02fb2008-1fbd-49fe-b345-e356153e4848&token=89631388a50a7990bb2661baf79cb89e2e8a3278358c344b7c0a8b0b2c8756cd'
  }
];

const HOME_ADDRESS = '1403 E Hidden Ranch Loop, Palmer, AK 99645';
const PREP_BUFFER_MINUTES = 30;
const SCAN_DAYS_AHEAD = 14;
const MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

// Keywords that strongly suggest parent attendance required
const ATTEND_KEYWORDS = ['game', 'tournament', 'meet', 'match', 'playoff', 'championship', 'showcase', 'scrimmage', 'jamboree', 'competition', 'vs', 'versus', '@'];
// Keywords that suggest player-only events
const SKIP_KEYWORDS = ['practice', 'workout', 'training', 'conditioning', 'tryout', 'open skate', 'team meeting', 'picture day'];

// KV store helpers using Vercel KV REST API
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

// Get learned decisions from KV store
async function getLearnedPatterns() {
  return await kvGet('learned_patterns') || {};
}

async function getPendingEvents() {
  return await kvGet('pending_events') || [];
}

async function getProcessedEvents() {
  return await kvGet('processed_events') || [];
}

// AI decision engine
function makeDecision(event, calendar, learnedPatterns) {
  const title = (event.summary || '').toLowerCase();
  const description = (event.description || '').toLowerCase();
  const fullText = `${title} ${description}`;

  // Check learned patterns first
  const patternKey = `${calendar.sport}_${getEventType(title)}`;
  if (learnedPatterns[patternKey]) {
    const pattern = learnedPatterns[patternKey];
    if (pattern.confidence >= 3) {
      return {
        decision: pattern.attend ? 'BLOCK' : 'SKIP',
        confidence: pattern.confidence,
        reason: `Learned: ${pattern.attend ? 'You attend' : 'You skip'} ${calendar.sport} ${getEventType(title)}s (confirmed ${pattern.confidence} times)`,
        needsConfirmation: false
      };
    }
  }

  // Keyword analysis
  let attendScore = 0;
  let skipScore = 0;

  ATTEND_KEYWORDS.forEach(kw => { if (fullText.includes(kw)) attendScore++; });
  SKIP_KEYWORDS.forEach(kw => { if (fullText.includes(kw)) skipScore++; });

  // Duration analysis - games tend to be longer
  const durationMs = event.end - event.start;
  const durationHours = durationMs / (1000 * 60 * 60);
  if (durationHours >= 2) attendScore++;
  if (durationHours < 1.5) skipScore++;

  // Day of week analysis - games more likely on weekends
  const dayOfWeek = new Date(event.start).getDay();
  if (dayOfWeek === 0 || dayOfWeek === 6) attendScore++;
  if (dayOfWeek >= 1 && dayOfWeek <= 5 && skipScore > 0) skipScore++;

  if (skipScore > attendScore) {
    return {
      decision: 'LIKELY_SKIP',
      confidence: skipScore,
      reason: `Looks like a practice/player-only event (${SKIP_KEYWORDS.filter(kw => fullText.includes(kw)).join(', ')})`,
      needsConfirmation: true
    };
  } else if (attendScore > 0) {
    return {
      decision: 'LIKELY_BLOCK',
      confidence: attendScore,
      reason: `Looks like an event you'd attend (${ATTEND_KEYWORDS.filter(kw => fullText.includes(kw)).join(', ')})`,
      needsConfirmation: true
    };
  }

  return {
    decision: 'UNKNOWN',
    confidence: 0,
    reason: 'Not sure — needs your input',
    needsConfirmation: true
  };
}

function getEventType(title) {
  for (const kw of SKIP_KEYWORDS) { if (title.includes(kw)) return kw; }
  for (const kw of ATTEND_KEYWORDS) { if (title.includes(kw)) return kw; }
  return 'event';
}

// Calculate drive time using Google Maps
async function getDriveTime(destination) {
  if (!destination) return null;
  try {
    const origin = encodeURIComponent(HOME_ADDRESS);
    const dest = encodeURIComponent(destination);
    const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${origin}&destinations=${dest}&key=${MAPS_API_KEY}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.rows?.[0]?.elements?.[0]?.status === 'OK') {
      const seconds = data.rows[0].elements[0].duration.value;
      return Math.ceil(seconds / 60); // minutes
    }
  } catch (e) {
    console.error('Drive time error:', e);
  }
  return null;
}

// Fetch and parse iCal feed
async function fetchCalendar(calendar) {
  try {
    const url = calendar.url.replace('webcal://', 'https://');
    const res = await fetch(url, { timeout: 10000 });
    const text = await res.text();
    const parsed = ical.parseICS(text);
    return Object.values(parsed).filter(e => e.type === 'VEVENT');
  } catch (e) {
    console.error(`Error fetching ${calendar.name}:`, e.message);
    return [];
  }
}

module.exports = async (req, res) => {
  // Allow manual trigger via GET, cron via any
  const now = new Date();
  const cutoff = new Date(now.getTime() + SCAN_DAYS_AHEAD * 24 * 60 * 60 * 1000);

  const learnedPatterns = await getLearnedPatterns();
  let processedEvents = await getProcessedEvents();
  const newPendingEvents = [];
  const autoBlocked = [];

  for (const calendar of CALENDARS) {
    const events = await fetchCalendar(calendar);

    for (const event of events) {
      if (!event.start) continue;
      const eventStart = new Date(event.start);
      if (isNaN(eventStart.getTime())) continue;
      if (eventStart <= now) continue;
      if (eventStart > cutoff) continue;

      // Skip events under 15 minutes — likely reminders not real events
      if (event.end) {
        const durationMs = new Date(event.end) - eventStart;
        if (durationMs < 15 * 60 * 1000) continue;
      }

      const eventId = `${calendar.name}_${eventStart.toISOString()}_${(event.summary || '').replace(/\s/g, '_')}`;

      // Skip already processed
      if (processedEvents.includes(eventId)) continue;

      const decision = makeDecision(event, calendar, learnedPatterns);
      const driveTime = event.location ? await getDriveTime(event.location) : null;
      const totalBuffer = (driveTime || 30) + PREP_BUFFER_MINUTES;
      const leaveBy = new Date(eventStart.getTime() - totalBuffer * 60 * 1000);

      const eventData = {
        id: eventId,
        calendar: calendar.name,
        kid: calendar.kid,
        sport: calendar.sport,
        title: event.summary || 'Unknown Event',
        location: event.location || null,
        start: eventStart.toISOString(),
        end: event.end ? new Date(event.end).toISOString() : null,
        driveTime,
        totalBuffer,
        leaveBy: leaveBy.toISOString(),
        decision: decision.decision,
        confidence: decision.confidence,
        reason: decision.reason,
        needsConfirmation: decision.needsConfirmation,
        scannedAt: now.toISOString()
      };

      if (!decision.needsConfirmation && decision.decision === 'BLOCK') {
        autoBlocked.push(eventData);
        processedEvents.push(eventId);
      } else if (!decision.needsConfirmation && decision.decision === 'SKIP') {
        processedEvents.push(eventId);
      } else {
        newPendingEvents.push(eventData);
      }
    }
  }

  // Save pending events — cap at 50, keeping the NEWEST entries
  const existingPending = await getPendingEvents();
  const existingIds = existingPending.map(e => e.id);
  const merged = [...existingPending, ...newPendingEvents.filter(e => !existingIds.includes(e.id))];
  const capped = merged.slice(-50);
  await kvSet('pending_events', capped);

  // Prevent processed_events from growing forever — keep last 500
  processedEvents = processedEvents.slice(-500);
  await kvSet('processed_events', processedEvents);

  return res.status(200).json({
    success: true,
    scanned: now.toISOString(),
    newPending: newPendingEvents.length,
    autoBlocked: autoBlocked.length,
    message: `Found ${newPendingEvents.length} events needing your review, ${autoBlocked.length} auto-blocked`
  });
};

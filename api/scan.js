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
// Alaska is UTC-8 in summer (AKDT). All-day blocks run 9 AM - 8 PM Alaska.
const AK_UTC_OFFSET = 8;
const ALLDAY_START_HOUR_AK = 9;   // 9:00 AM Alaska
const ALLDAY_END_HOUR_AK = 20;    // 8:00 PM Alaska
const MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

// Keywords that strongly suggest parent attendance required
const ATTEND_KEYWORDS = ['game', 'tournament', 'tourney', 'meet', 'match', 'playoff', 'championship', 'showcase', 'scrimmage', 'jamboree', 'competition', 'vs', 'versus', '@'];
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
      body: JSON.stringify(value)
    });
  } catch (e) {
    console.error('KV set error:', e);
  }
}

async function getLearnedPatterns() {
  return await kvGet('learned_patterns') || {};
}

async function getPendingEvents() {
  return await kvGet('pending_events') || [];
}

async function getProcessedEvents() {
  return await kvGet('processed_events') || [];
}

// Detect all-day / date-only events
function isAllDayEvent(event) {
  if (event.datetype === 'date') return true;
  if (event.start && event.start.dateOnly) return true;
  if (event._allDay) return true;
  const start = new Date(event.start);
  if (start.getUTCHours() === 0 && start.getUTCMinutes() === 0 && start.getUTCSeconds() === 0) {
    if (!event.end) return true;
    const durationMs = new Date(event.end) - start;
    if (durationMs === 0) return true;
    if (durationMs % (24 * 60 * 60 * 1000) === 0) return true;
  }
  return false;
}

// AI decision engine
function makeDecision(event, calendar, learnedPatterns) {
  const title = (event.summary || '').toLowerCase();
  const description = (event.description || '').toLowerCase();
  const fullText = `${title} ${description}`;

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

  let attendScore = 0;
  let skipScore = 0;

  ATTEND_KEYWORDS.forEach(kw => { if (fullText.includes(kw)) attendScore++; });
  SKIP_KEYWORDS.forEach(kw => { if (fullText.includes(kw)) skipScore++; });

  // All-day events are usually tournaments/jamborees — lean toward attend
  if (isAllDayEvent(event)) attendScore++;

  // Duration analysis - games tend to be longer (skip for all-day events)
  if (!isAllDayEvent(event) && event.end) {
    const durationMs = new Date(event.end) - new Date(event.start);
    const durationHours = durationMs / (1000 * 60 * 60);
    if (durationHours >= 2) attendScore++;
    if (durationHours < 1.5) skipScore++;
  }

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
      reason: `Looks like an event you'd attend (${ATTEND_KEYWORDS.filter(kw => fullText.includes(kw)).join(', ') || 'all-day event'})`,
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

// Fix malformed date-only DTSTART/DTEND lines (GameChanger writes
// "DTSTART:20260709" without the required VALUE=DATE label, which
// breaks the parser). Rewrites them to spec before parsing.
function fixMalformedDates(icsText) {
  return icsText.replace(/^(DTSTART|DTEND):(\d{8})(\r?\n)/gm, '$1;VALUE=DATE:$2$3');
}

// Fetch and parse iCal feed
async function fetchCalendar(calendar) {
  try {
    const url = calendar.url.replace('webcal://', 'https://');
    const res = await fetch(url, { timeout: 10000 });
    let text = await res.text();
    text = fixMalformedDates(text);
    const parsed = ical.parseICS(text);
    const events = Object.values(parsed).filter(e => e.type === 'VEVENT');

    // Belt and suspenders: manually recover any event whose date the
    // parser still failed on, by reading the raw text ourselves.
    const rawBlocks = text.split('BEGIN:VEVENT').slice(1);
    for (const event of events) {
      const start = new Date(event.start);
      if (!event.start || isNaN(start.getTime())) {
        const uid = event.uid;
        const block = rawBlocks.find(b => uid && b.includes(uid));
        if (block) {
          const ds = block.match(/DTSTART(?:;VALUE=DATE)?:(\d{4})(\d{2})(\d{2})/);
          const de = block.match(/DTEND(?:;VALUE=DATE)?:(\d{4})(\d{2})(\d{2})/);
          if (ds) {
            event.start = new Date(Date.UTC(+ds[1], +ds[2] - 1, +ds[3]));
            event._allDay = true;
          }
          if (de) {
            event.end = new Date(Date.UTC(+de[1], +de[2] - 1, +de[3]));
          }
        }
      }
    }

    return events;
  } catch (e) {
    console.error(`Error fetching ${calendar.name}:`, e.message);
    return [];
  }
}

module.exports = async (req, res) => {
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
      let eventStart = new Date(event.start);
      if (isNaN(eventStart.getTime())) continue;

      const allDay = isAllDayEvent(event);
      let eventEnd = event.end ? new Date(event.end) : null;

      // All-day events arrive as UTC midnight, which renders as 4 PM the
      // previous day in Alaska. Pin them to 9 AM - 8 PM Alaska time instead.
      // Note: an all-day DTEND is exclusive (the day AFTER the last day).
      if (allDay) {
        const y = eventStart.getUTCFullYear();
        const m = eventStart.getUTCMonth();
        const d = eventStart.getUTCDate();
        eventStart = new Date(Date.UTC(y, m, d, ALLDAY_START_HOUR_AK + AK_UTC_OFFSET, 0, 0));

        if (eventEnd && eventEnd > eventStart) {
          const lastDay = new Date(eventEnd.getTime() - 24 * 60 * 60 * 1000);
          eventEnd = new Date(Date.UTC(
            lastDay.getUTCFullYear(),
            lastDay.getUTCMonth(),
            lastDay.getUTCDate(),
            ALLDAY_END_HOUR_AK + AK_UTC_OFFSET, 0, 0
          ));
        } else {
          // Single-day all-day event: block 9 AM - 8 PM same day
          eventEnd = new Date(Date.UTC(y, m, d, ALLDAY_END_HOUR_AK + AK_UTC_OFFSET, 0, 0));
        }
      }

      // Skip past events — but keep multi-day events still in progress
      const effectiveEnd = eventEnd && eventEnd > eventStart ? eventEnd : eventStart;
      if (effectiveEnd <= now) continue;
      if (eventStart > cutoff) continue;

      // Skip events under 15 minutes — likely reminders, NOT all-day events
      if (!allDay && eventEnd) {
        const durationMs = eventEnd - eventStart;
        if (durationMs < 15 * 60 * 1000) continue;
      }

      const eventId = `${calendar.name}_${eventStart.toISOString()}_${(event.summary || '').replace(/\s/g, '_')}`;

      if (processedEvents.includes(eventId)) continue;

      const decision = makeDecision(event, calendar, learnedPatterns);
      const driveTime = event.location ? await getDriveTime(event.location) : null;
      const totalBuffer = (driveTime || 30) + PREP_BUFFER_MINUTES;
      const leaveBy = allDay ? null : new Date(eventStart.getTime() - totalBuffer * 60 * 1000);

      const eventData = {
        id: eventId,
        calendar: calendar.name,
        kid: calendar.kid,
        sport: calendar.sport,
        title: event.summary || 'Unknown Event',
        location: event.location || null,
        start: eventStart.toISOString(),
        end: eventEnd ? eventEnd.toISOString() : null,
        allDay,
        driveTime,
        totalBuffer,
        leaveBy: leaveBy ? leaveBy.toISOString() : null,
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

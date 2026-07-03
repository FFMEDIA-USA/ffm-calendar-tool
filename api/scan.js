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
    const durationMs = new Date(event.end) -

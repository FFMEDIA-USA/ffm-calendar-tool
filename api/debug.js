const fetch = require('node-fetch');
const ical = require('ical');

const CALENDARS = [
  { name: 'Legion Baseball', url: 'https://api.team-manager.gc.com/ics-calendar-documents/user/f5b5dfba-e649-453c-8874-53f42662908c.ics?teamId=23164a2c-a510-48e6-950f-923f4056cbbf&token=c8c7650eaf9736895fca205d672e4fd3a900d27e622850e78012bca51bd05d5d' },
  { name: 'Palmer Moose Hockey', url: 'https://calendar.sportsyou.com/access/us-7ca1c5a8-39c2-46d1-957f-027449c9cf88/6415d121-51ac-407d-ba84-b215499336cd' },
  { name: 'Palmer Moose Football', url: 'https://calendar.sportsyou.com/access/us-7ca1c5a8-39c2-46d1-957f-027449c9cf88/00168bed-7b68-42a8-b7cd-5ef60b263b11' },
  { name: 'Polar Pitch Softball', url: 'https://api.team-manager.gc.com/ics-calendar-documents/user/f5b5dfba-e649-453c-8874-53f42662908c.ics?teamId=02fb2008-1fbd-49fe-b345-e356153e4848&token=89631388a50a7990bb2661baf79cb89e2e8a3278358c344b7c0a8b0b2c8756cd' }
];

module.exports = async (req, res) => {
  const windowStart = new Date('2026-07-06T00:00:00Z');
  const windowEnd = new Date('2026-07-13T00:00:00Z');
  const output = [];

  for (const calendar of CALENDARS) {
    try {
      const url = calendar.url.replace('webcal://', 'https://');
      const r = await fetch(url, { timeout: 10000 });
      const text = await r.text();
      const parsed = ical.parseICS(text);
      const events = Object.values(parsed).filter(e => e.type === 'VEVENT');

      for (const event of events) {
        if (!event.start) continue;
        const start = new Date(event.start);
        if (isNaN(start.getTime())) continue;
        if (start < windowStart || start > windowEnd) continue;

        output.push({
          calendar: calendar.name,
          summary: event.summary || null,
          start: String(event.start),
          startISO: start.toISOString(),
          end: event.end ? String(event.end) : null,
          datetype: event.datetype || null,
          startDateOnly: event.start && event.start.dateOnly !== undefined ? event.start.dateOnly : null,
          utcHours: start.getUTCHours(),
          durationHours: event.end ? (new Date(event.end) - start) / 3600000 : null,
          hasRrule: !!event.rrule
        });
      }

      output.push({ calendar: calendar.name, totalEventsInFeed: events.length });
    } catch (e) {
      output.push({ calendar: calendar.name, error: e.message });
    }
  }

  return res.status(200).json({ window: 'July 6-13, 2026', events: output });
};

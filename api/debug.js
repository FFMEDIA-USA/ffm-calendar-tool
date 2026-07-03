const fetch = require('node-fetch');

const CALENDARS = [
  { name: 'Legion Baseball', url: 'https://api.team-manager.gc.com/ics-calendar-documents/user/f5b5dfba-e649-453c-8874-53f42662908c.ics?teamId=23164a2c-a510-48e6-950f-923f4056cbbf&token=c8c7650eaf9736895fca205d672e4fd3a900d27e622850e78012bca51bd05d5d' },
  { name: 'Palmer Moose Hockey', url: 'https://calendar.sportsyou.com/access/us-7ca1c5a8-39c2-46d1-957f-027449c9cf88/6415d121-51ac-407d-ba84-b215499336cd' },
  { name: 'Palmer Moose Football', url: 'https://calendar.sportsyou.com/access/us-7ca1c5a8-39c2-46d1-957f-027449c9cf88/00168bed-7b68-42a8-b7cd-5ef60b263b11' },
  { name: 'Polar Pitch Softball', url: 'https://api.team-manager.gc.com/ics-calendar-documents/user/f5b5dfba-e649-453c-8874-53f42662908c.ics?teamId=02fb2008-1fbd-49fe-b345-e356153e4848&token=89631388a50a7990bb2661baf79cb89e2e8a3278358c344b7c0a8b0b2c8756cd' }
];

const SEARCH_TERMS = ['birchwood', 'jamboree', 'wood bat', 'tourney', 'tournament', 'VALUE=DATE'];

module.exports = async (req, res) => {
  const output = [];

  for (const calendar of CALENDARS) {
    try {
      const url = calendar.url.replace('webcal://', 'https://');
      const r = await fetch(url, { timeout: 10000 });
      const text = await r.text();
      const lower = text.toLowerCase();

      const result = { calendar: calendar.name, feedLength: text.length, matches: {} };

      for (const term of SEARCH_TERMS) {
        result.matches[term] = lower.includes(term.toLowerCase());
      }

      // Pull the full raw VEVENT block for anything matching our target events
      const blocks = text.split('BEGIN:VEVENT');
      const hits = [];
      for (const block of blocks) {
        const bl = block.toLowerCase();
        if (bl.includes('birchwood') || bl.includes('jamboree') || bl.includes('wood bat') || bl.includes('tourney')) {
          hits.push('BEGIN:VEVENT' + block.split('END:VEVENT')[0] + 'END:VEVENT');
        }
      }
      result.rawEventBlocks = hits;

      output.push(result);
    } catch (e) {
      output.push({ calendar: calendar.name, error: e.message });
    }
  }

  return res.status(200).json(output);
};

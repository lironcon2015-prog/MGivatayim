// Pure logic: the spreadsheet importer and the live-match model.
//   node tests/units.mjs
import assert from 'node:assert/strict';
import { deflateRawSync, crc32 } from 'node:zlib';
import { readRows, parseDelimited, detectColumns, rowsToPlayers, planImport, applyImport } from '../src/importer.js';

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ✓', name); }
  catch (e) { failures.push(name); console.log('  ✗', name, '\n     ', e.message.split('\n')[0]); }
}

// A real .xlsx, built the way Excel stores one: a zip of deflated XML parts.
function zip(files) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text, 'utf8');
    const comp = deflateRawSync(data);
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10); central.writeUInt32LE(crc, 16); central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBuf.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, comp);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
const asFile = (buf) => ({ arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) });

const XLSX = zip({
  'xl/workbook.xml': '<workbook xmlns:r="r"><sheets><sheet name="סגל" sheetId="1" r:id="rId7"/></sheets></workbook>',
  'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId7" Type="ws" Target="worksheets/sheet3.xml"/></Relationships>',
  'xl/sharedStrings.xml': '<sst><si><t>שם השחקן</t></si><si><t>מספר</t></si><si><t>עמדה</t></si>'
    + '<si><r><t>איתי</t></r><r><rPr><b/></rPr><t xml:space="preserve"> כהן</t></r></si>'
    + '<si><t>מגן שמאלי</t></si><si><t>שוער</t></si><si><t>דניאל &amp; לוי</t></si></sst>',
  'xl/worksheets/sheet3.xml': '<worksheet><sheetData>'
    + '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c><c r="D1" t="s"><v>2</v></c></row>'
    + '<row r="2"><c r="A2" s="3" t="s"><v>3</v></c><c r="C2"><v>7</v></c><c r="D2" t="s"><v>4</v></c></row>'
    + '<row r="3"><c r="A3" t="inlineStr"><is><t>רותם בר</t></is></c><c r="C3"><v>1</v></c><c r="D3" t="s"><v>5</v></c></row>'
    + '<row r="4"><c r="A4" t="s"><v>6</v></c><c r="C4"><v>10</v></c></row>'
    + '</sheetData></worksheet>',
});

console.log('importer:');

await test('reads the first sheet in workbook order, not the file named sheet1', async () => {
  const rows = await readRows(asFile(XLSX));
  assert.equal(rows.length, 4);
  assert.equal(rows[0][0], 'שם השחקן');
});

await test('joins rich-text runs, keeps skipped columns in place, decodes entities', async () => {
  const rows = await readRows(asFile(XLSX));
  assert.equal(rows[1][0], 'איתי כהן');
  assert.equal(rows[1][1], '');
  assert.equal(rows[1][2], '7');
  assert.equal(rows[3][0], 'דניאל & לוי');
});

await test('a Hebrew header row maps name, number and position', async () => {
  const rows = await readRows(asFile(XLSX));
  const cols = detectColumns(rows);
  assert.equal(cols.headerRow, true);
  const players = rowsToPlayers(rows, cols);
  assert.deepEqual(players[0], { name: 'איתי כהן', number: 7, pos: 'LB', pos2: '' });
  assert.equal(players[1].pos, 'GK');
  assert.equal(players.length, 3);
});

await test('cells pasted from a spreadsheet, with no header, are judged by content', async () => {
  const rows = parseDelimited('7\tאיתי כהן\tכנף שמאל\n10\tדניאל לוי\tקשר קדמי\n9\tיובל מזרחי\tחלוץ\n');
  const cols = detectColumns(rows);
  assert.equal(cols.headerRow, false);
  const players = rowsToPlayers(rows, cols);
  assert.deepEqual(players.map((p) => [p.name, p.number, p.pos]), [['איתי כהן', 7, 'LW'], ['דניאל לוי', 10, 'AM'], ['יובל מזרחי', 9, 'ST']]);
});

await test('a Windows-1255 CSV from Hebrew Excel decodes correctly', async () => {
  // "שם,מספר\nאיתי,7" in cp1255: Hebrew letters 0xE0–0xFA.
  const map = { 'ש': 0xf9, 'ם': 0xed, 'מ': 0xee, 'ס': 0xf1, 'פ': 0xf4, 'ר': 0xf8, 'א': 0xe0, 'י': 0xe9, 'ת': 0xfa };
  const enc = (s) => [...s].map((c) => map[c] ?? c.charCodeAt(0));
  const buf = Buffer.from([...enc('שם,מספר\nאיתי,7\n')]);
  const rows = await readRows(asFile(buf));
  assert.deepEqual(rows, [['שם', 'מספר'], ['איתי', '7']]);
});

await test('quoted CSV fields and semicolon separators', () => {
  const rows = parseDelimited('שם;מספר\n"כהן; איתי";7\n"אבי ""הקטן""";8\n');
  assert.deepEqual(rows[1], ['כהן; איתי', '7']);
  assert.equal(rows[2][0], 'אבי "הקטן"');
});

await test('an unfamiliar number header is recognised, and content decides the rest', () => {
  // The owner's real squad file, first rows: "שם,מספר שחקן".
  const rows = parseDelimited('שם,מספר שחקן\nמיכאלי כהן,1\nאביב איצחקי,2\nתום יונו,5\n');
  const players = rowsToPlayers(rows, detectColumns(rows));
  assert.deepEqual(players.map((p) => [p.name, p.number]), [['מיכאלי כהן', 1], ['אביב איצחקי', 2], ['תום יונו', 5]]);
  const odd = parseDelimited('שם,חולצה לעונה\nאיתי,7\nדני,10\n');
  assert.deepEqual(rowsToPlayers(odd, detectColumns(odd)).map((p) => p.number), [7, 10]);
});

await test('separate first/last name columns are joined', () => {
  const rows = parseDelimited('שם פרטי,שם משפחה,מספר\nאיתי,כהן,7\n');
  const players = rowsToPlayers(rows, detectColumns(rows));
  assert.equal(players[0].name, 'איתי כהן');
});

await test('an old binary .xls is refused with instructions, not garbage', async () => {
  const buf = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0, 0, 0, 0]);
  await assert.rejects(readRows(asFile(buf)), /xlsx|CSV/);
});

await test('import plan: matches by name, then number; keeps ids; flags missing', () => {
  const existing = [
    { id: 'a', name: 'איתי כהן', number: 7 },
    { id: 'b', name: 'דניאל לוי', number: 10 },
    { id: 'c', name: 'עוזב', number: 4 },
  ];
  const plan = planImport(existing, [
    { name: 'איתי כהן', number: 11, pos: 'LW', pos2: '' },
    { name: 'דניאל  לוי', number: 10, pos: '', pos2: '' },
    { name: 'חדש', number: 5, pos: 'ST', pos2: '' },
  ]);
  assert.deepEqual(plan.rows.map((r) => r.kind), ['update', 'same', 'new']);
  assert.deepEqual(plan.missing.map((p) => p.id), ['c']);
  let n = 0;
  const out = applyImport(existing, plan, { include: [true, true, true], removeMissing: true, newId: () => 'n' + ++n });
  assert.deepEqual(out.map((p) => [p.id, p.name, p.number]), [['a', 'איתי כהן', 11], ['b', 'דניאל לוי', 10], ['n1', 'חדש', 5]]);
});

await test('a name that repeats in the squad is matched by name and number together', () => {
  const inc = [20, 21, 23, 22, 33].map((number) => ({ name: 'ספיר', number, pos: '', pos2: '' }));
  let n = 0;
  const first = applyImport([], planImport([], inc), { include: inc.map(() => true), removeMissing: false, newId: () => 'id' + ++n });
  assert.equal(first.length, 5);
  const again = planImport(first, inc);
  assert.deepEqual(again.rows.map((r) => r.kind), ['same', 'same', 'same', 'same', 'same']);
  assert.deepEqual(again.rows.map((r) => r.match.number), [20, 21, 23, 22, 33]);
  const renamed = planImport(first, [{ name: 'ספיר לוי', number: 21, pos: '', pos2: '' }]);
  assert.equal(renamed.rows[0].kind, 'update');
  assert.equal(renamed.rows[0].match.id, 'id2');
});

await test('unticked rows and kept-missing players are left alone', () => {
  const existing = [{ id: 'a', name: 'איתי', number: 7 }, { id: 'c', name: 'עוזב', number: 4 }];
  const plan = planImport(existing, [{ name: 'איתי', number: 8, pos: '', pos2: '' }, { name: 'חדש', number: 5, pos: '', pos2: '' }]);
  const out = applyImport(existing, plan, { include: [false, true], removeMissing: false, newId: () => 'x' });
  assert.deepEqual(out.map((p) => [p.id, p.number]), [['a', 7], ['c', 4], ['x', 5]]);
});

await test('short names: first name and the surname initial', async () => {
  const { shortName } = await import('../src/format.js');
  assert.equal(shortName('אורי כהן'), 'אורי כ.');
  assert.equal(shortName('  אלכסנדר   בן-שושן '), 'אלכסנדר ב.');
  assert.equal(shortName('יוסי בן דוד'), 'יוסי ב.');
  assert.equal(shortName('איתי'), 'איתי');
  assert.equal(shortName(''), '');
  assert.equal(shortName(undefined), '');
});

await test('the season label is computed when the manager left it empty', async () => {
  const { currentSeasonLabel, seasonLabel } = await import('../src/format.js');
  assert.equal(currentSeasonLabel(new Date(2026, 8, 22)), '2026/27');
  assert.equal(currentSeasonLabel(new Date(2027, 2, 1)), '2026/27');
  assert.equal(currentSeasonLabel(new Date(2027, 6, 1)), '2027/28');
  assert.equal(currentSeasonLabel(new Date(2099, 7, 1)), '2099/00');
  assert.equal(seasonLabel({ season: ' 2025/26 ' }), '2025/26', "the manager's own label wins");
  assert.equal(seasonLabel({ season: '' }, new Date(2026, 8, 1)), '2026/27');
  assert.equal(seasonLabel(undefined, new Date(2026, 8, 1)), '2026/27');
});

await test('success rate is points taken out of points available', async () => {
  const { buildSeason } = await import('../src/season.js');
  const m = (gf, ga) => ({ date: '2026-09-01', opponent: 'x', home: true, gf, ga });
  const o = buildSeason({ matches: [m(2, 1), m(1, 1), m(0, 3)] }).overall;
  assert.equal(o.points, 4);
  assert.equal(o.maxPoints, 9);
  assert.equal(o.pointsRate, 4 / 9);
  assert.equal(buildSeason({}).overall.pointsRate, 0, 'no matches, no division by zero');
});

await test('an empty scorers list says why: a friendly, unassigned goals, or none yet', async () => {
  const { buildSeason } = await import('../src/season.js');
  const m = (o) => ({ date: '2026-09-01', opponent: 'x', home: true, gf: 1, ga: 0, ...o });
  assert.equal(buildSeason({}).emptyScorers, 'טרם נרשמו שערים העונה.');
  assert.equal(buildSeason({ matches: [m()] }).emptyScorers, 'עוד לא שויכו שערים לשחקנים.');
  const friendly = m({ friendly: true, liveId: 'L1', events: [{ type: 'goal', side: 'us', scorer: 'p1' }] });
  assert.equal(buildSeason({ matches: [friendly] }).emptyScorers, 'שערים ממשחקי אימון לא נספרים בטבלה.');
});

await test('the schedule row of a next match set by hand carries its kickoff', async () => {
  const { buildSeason } = await import('../src/season.js');
  const now = new Date('2026-09-24T12:00:00+03:00');
  const s = buildSeason({
    fixtures: [{ date: '2026-10-01', time: '', opponent: 'שיכון', home: false }, { date: '2026-10-17', time: '17:30', opponent: 'רמת גן', home: true }],
    nextMatch: { opponent: 'שיכון', home: false, kickoff: '2026-10-01T09:30:00+03:00' },
  }, now);
  assert.equal(s.schedule[0].time, '09:30');
  assert.equal(s.schedule[1].time, '17:30');
});

await test('opponent crests: kept by name, and only a Drive id reaches the page', async () => {
  const { buildSeason, opponentLogo } = await import('../src/season.js');
  const s = buildSeason({ opponentLogos: { ' הפועל  כוכבים ': 'abcDEF12345_-x', 'בני לוד': '"><img src=x onerror=alert(1)>', x: 7 } });
  assert.deepEqual(s.opponentLogos, { 'הפועל כוכבים': 'abcDEF12345_-x' });
  assert.equal(opponentLogo(s, 'הפועל כוכבים '), 'abcDEF12345_-x');
  assert.equal(opponentLogo(s, 'בני לוד'), null);
  assert.deepEqual(buildSeason({}).opponentLogos, {});
});

await test('fixtures: dates and times as spreadsheets write them', async () => {
  const { parseDate, parseTime, parseHome } = await import('../src/fixtures.js');
  assert.equal(parseDate('19/09/2026').date, '2026-09-19');
  assert.equal(parseDate('19.9.26').date, '2026-09-19');
  assert.equal(parseDate('2026-09-19').date, '2026-09-19');
  assert.equal(parseDate('31/02/2026').date, '', 'no 31 February');
  assert.deepEqual(parseDate('46284'), { date: '2026-09-19', time: '' }, 'Excel serial');
  assert.deepEqual(parseDate('46284.729166667'), { date: '2026-09-19', time: '17:30' }, 'serial with a time');
  assert.equal(parseDate('19/09/2026 17:30').time, '17:30');
  assert.equal(parseTime('17:30'), '17:30');
  assert.equal(parseTime('9.00'), '09:00');
  assert.equal(parseTime('0.5'), '12:00');
  assert.equal(parseTime('25:00'), '');
  assert.equal(parseHome('בית'), true);
  assert.equal(parseHome('ח'), false);
  assert.equal(parseHome('?'), null);
});

await test('fixtures: our-view format (opponent, home/away, our goals)', async () => {
  const F = await import('../src/fixtures.js');
  const rows = [
    ['מחזור', 'תאריך', 'שעה', 'יריבה', 'בית/חוץ', 'מגרש', 'שערים שלנו', 'שערי היריבה'],
    ['1', '15/08/2026', '17:00', 'בני יהודה', 'בית', 'גבעתיים', '3', '1'],
    ['2', '22/08/2026', '', 'מכבי יפו', 'חוץ', '', '', ''],
    ['', '', '', '', '', '', '', ''],
    ['3', '', '', 'בלי תאריך', 'בית', '', '', ''],
  ];
  const cols = F.detectFixtureColumns(rows);
  assert.equal(cols.headerRow, true);
  const out = F.rowsToFixtures(rows, cols);
  assert.deepEqual(out.results, [{ date: '2026-08-15', opponent: 'בני יהודה', home: true, round: 1, gf: 3, ga: 1 }]);
  assert.equal(out.fixtures.length, 1);
  assert.deepEqual(out.fixtures[0], { date: '2026-08-22', time: '', opponent: 'מכבי יפו', home: false, round: 2, venue: { name: '', address: '' } });
  assert.equal(out.skipped, 1, 'the row without a date is counted, the empty row is not');
});

await test('fixtures: league format (home team, away team, home/away goals)', async () => {
  const F = await import('../src/fixtures.js');
  const rows = [
    ['מחזור', 'תאריך', 'קבוצת בית', 'קבוצת חוץ', 'שערי בית', 'שערי חוץ'],
    ['1', '15/08/2026', 'מכבי גבעתיים', 'בני יהודה', '3', '1'],
    ['2', '22/08/2026', 'מכבי יפו', 'מכבי גבעתיים', '2', '0'],
    ['3', '29/08/2026', 'מ.כ. גבעתיים ', 'הפועל חולון', '', ''],
    ['4', '05/09/2026', 'הפועל רמת גן', 'מכבי גבעתיים', '', ''],
  ];
  const out = F.rowsToFixtures(rows, F.detectFixtureColumns(rows), 'מכבי גבעתיים');
  assert.deepEqual(out.results.map((r) => [r.opponent, r.home, r.gf, r.ga]),
    [['בני יהודה', true, 3, 1], ['מכבי יפו', false, 0, 2]], 'away: our goals are the away column');
  assert.deepEqual(out.fixtures.map((f) => [f.opponent, f.home]), [['הפועל רמת גן', false]],
    'a row where neither side is spelled like us is skipped, not guessed');
  assert.equal(out.skipped, 1);
});

await test('fixtures: what is still ahead, and the next match derived from it', async () => {
  const F = await import('../src/fixtures.js');
  const { buildSeason } = await import('../src/season.js');
  const now = new Date('2026-09-23T09:00:00+03:00');
  const fx = (date, opponent, time = '') => ({ date, time, opponent, home: true, round: null, venue: { name: '', address: '' } });
  const fixtures = [fx('2026-09-20', 'עבר'), fx('2026-09-23', 'היום', '18:00'), fx('2026-09-30', 'שוחק'), fx('2026-10-07', 'אחר כך')];
  const matches = [{ date: '2026-09-30', opponent: 'שוחק', home: true, gf: 1, ga: 0 }];
  assert.deepEqual(F.upcomingFixtures(fixtures, matches, now).map((f) => f.opponent), ['היום', 'אחר כך'],
    'past fixtures and dates that already have a result drop out');
  const s = buildSeason({ fixtures, matches }, now);
  assert.equal(s.nextMatch.opponent, 'היום');
  assert.equal(s.nextMatch.kickoff, '2026-09-23T18:00:00+03:00');
  assert.equal(s.nextMatch.fromFixtures, true);
  assert.deepEqual(s.upcoming.map((f) => f.opponent), ['אחר כך'], 'the card shows the first; the list the rest');
  assert.equal(s.schedule.length, 2);
  const tbd = buildSeason({ fixtures: [fx('2026-10-07', 'בלי שעה')] }, now).nextMatch;
  assert.equal(tbd.timeTbd, true);
  const manual = buildSeason({ fixtures, matches, nextMatch: { opponent: 'ידני', kickoff: '2026-09-23T18:00:00+03:00' } }, now);
  assert.equal(manual.nextMatch.opponent, 'ידני', 'a next match set by hand wins');
  assert.deepEqual(manual.upcoming.map((f) => f.opponent), ['אחר כך'], 'the same day is not listed twice');
  assert.equal(buildSeason({}, now).nextMatch, null);
});

await test('trainings: the week is the routine plus this week\'s changes, and the game closes it', async () => {
  const { buildSeason } = await import('../src/season.js');
  const tuesday = new Date('2026-09-29T10:00:00Z');
  const base = {
    team: { homeVenue: { name: 'בורוכוב', address: 'בורוכוב 5' } },
    trainings: [{ day: '4', start: '17:00', end: '18:30' }, { day: '0', start: '17:00', end: '18:30' }, { day: '2', start: '17:00', end: '18:30', venue: { name: 'אחר' } }],
    trainingChanges: [
      { date: '2026-10-01', start: '16:30', venue: { name: 'רמת חן' } },   // moved: time and venue
      { date: '2026-09-27', cancelled: true },
      { date: '2026-09-30', start: '19:00', end: '20:00' },                  // extra, on a free day
      { date: '2026-09-22', cancelled: true },                               // last week: ignored
    ],
    fixtures: [{ date: '2026-10-03', time: '10:30', opponent: 'יריבה', home: true }],
  };
  const w = buildSeason(base, tuesday).week;
  assert.equal(w.start, '2026-09-27');
  assert.equal(w.end, '2026-10-03');
  assert.deepEqual(w.items.map((i) => [i.date, i.kind, i.start]), [
    ['2026-09-27', 'training', '17:00'], ['2026-09-29', 'training', '17:00'], ['2026-09-30', 'training', '19:00'],
    ['2026-10-01', 'training', '16:30'], ['2026-10-03', 'game', '10:30'],
  ]);
  const [sun, tue, wed, thu] = w.items;
  assert.equal(sun.change, 'cancelled');
  assert.ok(sun.past);
  assert.ok(tue.today && !tue.past && !tue.change);
  assert.equal(tue.venue.name, 'אחר', 'a venue given wins over the home ground');
  assert.equal(sun.venue.name, 'בורוכוב', 'no venue = the home ground');
  assert.equal(thu.change, 'changed');
  assert.equal(thu.end, '18:30', 'an empty field keeps the routine\'s');
  assert.equal(thu.venue.name, 'רמת חן');
  assert.deepEqual([thu.was.start, thu.was.venue.name], ['17:00', 'בורוכוב'], 'the routine is kept for the sheet');
  assert.equal(wed.change, 'extra');
  assert.equal(wed.venue.name, 'בורוכוב', 'an extra training without a venue is at home');

  // Saturday offers the week after; its game is the next fixture in it.
  const sat = buildSeason({ ...base, fixtures: [...base.fixtures, { date: '2026-10-10', time: '09:00', opponent: 'הבאה' }] }, new Date('2026-10-03T16:00:00Z'));
  assert.ok(sat.offersNextWeek);
  assert.equal(sat.week.start, '2026-09-27', 'Saturday still shows its own week');
  assert.equal(sat.nextWeek.start, '2026-10-04');
  assert.ok(sat.nextWeek.ahead && sat.nextWeek.items.every((i) => !i.past && !i.today));
  assert.deepEqual(sat.nextWeek.items.map((i) => i.kind + ' ' + i.date), ['training 2026-10-04', 'training 2026-10-06', 'training 2026-10-08', 'game 2026-10-10']);
  assert.ok(!buildSeason(base, tuesday).offersNextWeek, 'only from Saturday');
  assert.equal(buildSeason(base, new Date('2026-10-04T08:00:00Z')).week.start, '2026-10-04', 'Sunday starts the next week');
  assert.equal(buildSeason({ ...base, trainings: [], trainingChanges: [] }, tuesday).week.trainings, 0, 'no trainings, no strip');
});

await test('the next match folds into the schedule, with what only it had', async () => {
  const F = await import('../src/fixtures.js');
  const { buildSeason } = await import('../src/season.js');
  const nm = { opponent: 'שיכון המזרח', home: false, round: null, friendly: true, kickoff: '2026-10-01T09:30:00+03:00',
    arrival: '08:45', kit: 'לבן', venue: { name: 'שיכון', address: 'הרצל 12', waze: '31.9,34.8' } };
  const fixtures = [{ date: '2026-10-01', time: '', opponent: 'שיכון המזרח', home: false, round: null, venue: { name: '', address: '' } },
    { date: '2026-10-10', time: '12:00', opponent: 'בני יהודה', home: true }];
  const r = F.mergeNextMatch({ nextMatch: nm, fixtures });
  assert.ok(r.merged);
  assert.equal(r.fixtures.length, 2, 'into its row, not beside it');
  assert.deepEqual(
    [r.fixtures[0].time, r.fixtures[0].arrival, r.fixtures[0].kit, r.fixtures[0].venue.waze, r.fixtures[0].friendly],
    ['09:30', '08:45', 'לבן', '31.9,34.8', true]);
  // Not on the schedule: it becomes a row.
  const alone = F.mergeNextMatch({ nextMatch: nm, fixtures: [] });
  assert.equal(alone.fixtures.length, 1);
  assert.equal(alone.fixtures[0].date, '2026-10-01');
  assert.equal(F.mergeNextMatch({ nextMatch: null, fixtures }).merged, false);
  // Parents see the same next match from the row as they did from the record.
  const s = buildSeason({ fixtures: r.fixtures }, new Date('2026-09-29T10:00:00Z'));
  assert.deepEqual([s.nextMatch.opponent, s.nextMatch.arrival, s.nextMatch.kit, s.nextMatch.venue.waze, s.nextMatch.timeTbd],
    ['שיכון המזרח', '08:45', 'לבן', '31.9,34.8', false]);
  assert.equal(s.upcoming.length, 1, 'the next match is not listed again after it');
});

await test('a schedule imported again keeps the gathering, kit and Waze link of the same game', async () => {
  const F = await import('../src/fixtures.js');
  const season = { fixtures: [{ date: '2026-10-01', opponent: 'שיכון המזרח', arrival: '08:45', kit: 'לבן', venue: { name: 'שיכון', address: '', waze: '31.9,34.8' } }], matches: [] };
  const out = F.applyFixtureImport(season, { fixtures: [
    { date: '2026-10-01', time: '09:30', opponent: 'שיכון המזרח', home: false, venue: { name: '', address: 'הרצל 12' } },
    { date: '2026-10-10', time: '12:00', opponent: 'בני יהודה', home: true },
  ], results: [] });
  const [a, b] = out.fixtures;
  assert.deepEqual([a.time, a.arrival, a.kit, a.venue.name, a.venue.address, a.venue.waze], ['09:30', '08:45', 'לבן', 'שיכון', 'הרצל 12', '31.9,34.8']);
  assert.equal(b.arrival, undefined, 'a new game gets nothing it did not have');
});

await test('a Google Maps link routes in Waze by its coordinates', async () => {
  const { navLink, mapsCoords, isShortMapLink } = await import('../src/format.js');
  const W = (c) => `https://www.waze.com/ul?ll=${c}&navigate=yes`;
  // The place's own pin wins over the map's centre.
  assert.equal(navLink('https://www.google.com/maps/place/X/@32.0701,34.8105,17z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d32.0703!4d34.8123!16s'), W('32.0703,34.8123'));
  assert.equal(navLink('https://www.google.com/maps/search/31.956020,+34.834553?entry=tts'), W('31.956020,34.834553'));
  assert.equal(navLink('https://maps.google.com/?q=31.9%2C34.8'), W('31.9,34.8'));
  assert.equal(navLink('https://www.google.com/maps/@32.07,34.81,15z'), W('32.07,34.81'));
  assert.equal(navLink('31.956020,34.834553'), W('31.956020,34.834553'));
  // A short link has nothing to read until the bridge opens it.
  assert.equal(mapsCoords('https://maps.app.goo.gl/abc'), null);
  assert.ok(isShortMapLink('https://maps.app.goo.gl/abc'));
  assert.equal(navLink('https://waze.com/ul/abc'), 'https://waze.com/ul/abc', 'a Waze link is left as it is');
  assert.equal(mapsCoords('https://example.com/?q=1.5,2.5'), '1.5,2.5', 'mapsCoords reads any text; navLink asks it only for Google');
  assert.equal(navLink('https://example.com/?q=1.5,2.5'), 'https://example.com/?q=1.5,2.5');
});

await test('fixtures: an import never overwrites a result already there', async () => {
  const F = await import('../src/fixtures.js');
  const season = { matches: [{ date: '2026-08-15', opponent: 'בני יהודה', gf: 4, ga: 4, liveId: 'L1' }] };
  const r = F.applyFixtureImport(season, {
    fixtures: [{ date: '2026-10-01', opponent: 'X' }],
    results: [{ date: '2026-08-15', opponent: 'בני יהודה', gf: 3, ga: 1 }, { date: '2026-08-22', opponent: 'יפו', gf: 1, ga: 1 }],
  });
  assert.equal(r.added, 1);
  assert.equal(r.matches.find((m) => m.date === '2026-08-15').gf, 4, 'the live-recorded score stays');
  assert.equal(r.fixtures.length, 1);
});

await test('the demo schedule in docs/fixtures imports as documented', async () => {
  const F = await import('../src/fixtures.js');
  const { readFileSync } = await import('node:fs');
  const rows = await readRows(new Blob([readFileSync(new URL('../docs/fixtures/schedule-demo.xlsx', import.meta.url))]));
  const out = F.rowsToFixtures(rows, F.detectFixtureColumns(rows), 'מכבי גבעתיים');
  assert.equal(out.results.length, 5);
  assert.equal(out.fixtures.length, 17);
  assert.equal(out.skipped, 0);
  assert.deepEqual([out.results[1].opponent, out.results[1].home, out.results[1].gf, out.results[1].ga], ['מכבי יפו', false, 1, 1]);
  assert.equal(out.fixtures[0].time, '16:45', 'Excel time cells');
  assert.equal(out.fixtures.at(-1).time, '', 'late rounds without a time');
  const tpl = await readRows(new Blob([readFileSync(new URL('../docs/fixtures/schedule-template.xlsx', import.meta.url))]));
  assert.equal(F.rowsToFixtures(tpl, F.detectFixtureColumns(tpl), 'מכבי גבעתיים').fixtures.length, 1);
});

await test('the Waze link searches the address alone', async () => {
  const { wazeLink } = await import('../src/format.js');
  assert.equal(wazeLink('שדרות ירושלים 24, גבעתיים'), 'https://www.waze.com/ul?q=' + encodeURIComponent('שדרות ירושלים 24, גבעתיים'));
  assert.ok(!wazeLink('x').includes('navigate='), 'navigate=yes needs coordinates; with q it opened Waze empty');
  assert.equal(wazeLink('  '), null);
  const { navLink } = await import('../src/format.js');
  assert.equal(navLink(' 31.956020, 34.834553 '), 'https://www.waze.com/ul?ll=31.956020,34.834553&navigate=yes', 'coordinates become a Waze route');
  assert.equal(navLink('https://maps.app.goo.gl/abc'), 'https://maps.app.goo.gl/abc');
  assert.equal(navLink('95.1,34.8'), null, 'out of range');
  assert.equal(navLink('רחוב הרצל'), null, 'a bare string is not a relative link');
  assert.equal(navLink('javascript:alert(1)'), null);
});

await test('a fixture played live on another day leaves the schedule', async () => {
  const F = await import('../src/fixtures.js');
  const now = new Date('2026-09-23T09:00:00+03:00');
  const fixtures = [{ date: '2030-11-08', opponent: 'בני לוח' }, { date: '2030-11-15', opponent: 'אחרת' }];
  const matches = [{ date: '2026-09-23', opponent: 'בני לוח', gf: 1, ga: 0, liveId: 'm1', fixture: { date: '2030-11-08', opponent: 'בני לוח' } }];
  assert.deepEqual(F.upcomingFixtures(fixtures, matches, now).map((f) => f.opponent), ['אחרת']);
  assert.equal(F.upcomingFixtures(fixtures, [], now).length, 2, 'a cancelled live match left nothing, so the row is back');
});

export { test, failures };
export const done = () => passed;

if (process.argv[1].endsWith('units.mjs')) {
  const model = await import('./units-live.mjs').catch((e) => (e.code === 'ERR_MODULE_NOT_FOUND' ? null : Promise.reject(e)));
  if (model) await model.run(test);
  await (await import('./units-minutes.mjs')).run(test);
await test('a home game with no venue is at the home ground; its own venue and away games are left alone', async () => {
  const { buildSeason } = await import('../src/season.js');
  const now = new Date('2026-10-01T12:00:00+03:00');
  const team = { name: 'מכבי גבעתיים', homeVenue: { name: 'אצטדיון גבעתיים', address: 'רחוב המעיין 4, גבעתיים' } };
  const fixtures = [
    { date: '2026-10-03', opponent: 'א', home: true, venue: { name: '', address: '' } },
    { date: '2026-10-10', opponent: 'ב', home: true, venue: { name: 'מגרש חלופי', address: 'רחוב אחר 1' } },
    { date: '2026-10-17', opponent: 'ג', home: false, venue: { name: '', address: '' } },
    { date: '2026-10-24', opponent: 'ד', home: true },
  ];
  const s = buildSeason({ team, fixtures }, now);
  const by = Object.fromEntries(s.schedule.map((f) => [f.opponent, f.venue?.name || '']));
  assert.deepEqual(by, { 'א': 'אצטדיון גבעתיים', 'ב': 'מגרש חלופי', 'ג': '', 'ד': 'אצטדיון גבעתיים' });
  assert.equal(s.nextMatch.venue.address, 'רחוב המעיין 4, גבעתיים', 'the next-match card (and its Waze link) has no address');
  assert.equal(fixtures[0].venue.name, '', 'the stored fixture was written to');
  assert.equal(buildSeason({ team: { name: 'x' }, fixtures }, now).schedule[0].venue.name, '', 'no home ground set, yet a venue appeared');
});

await test('a training match is listed with the results but counts in no figure', async () => {
  const { buildSeason } = await import('../src/season.js');
  const F = await import('../src/fixtures.js');
  const { cleanPlayedMatch, cleanLive } = await import('../src/live/model.js');
  const players = [{ id: 'a', name: 'איתי', goals: 0, assists: 0 }];
  const goal = [{ id: 'g1', type: 'goal', side: 'us', scorer: 'a', period: 1, atMs: 60000 }];
  const matches = [
    { date: '2026-08-22', opponent: 'א', home: true, round: 1, gf: 1, ga: 0 },
    { date: '2026-08-29', opponent: 'ב', home: false, round: null, friendly: true, gf: 0, ga: 5, liveId: 'x', events: goal },
    { date: '2026-09-05', opponent: 'ג', home: true, round: 2, gf: 2, ga: 0 },
  ];
  const s = buildSeason({ team: { name: 'x' }, matches, players });
  assert.equal(s.recent.length, 3, 'the training match left the results list');
  assert.equal(s.overall.played, 2);
  assert.deepEqual([s.overall.gf, s.overall.ga, s.splits.away.played], [3, 0, 0]);
  assert.equal(s.overall.streak.current, 2, 'the loss in training broke the winning streak');
  assert.deepEqual(s.form.map((m) => m.opponent), ['ג', 'א']);
  assert.equal(s.players[0].goals, 0, 'a goal in training counted in the player table');
  // The flag is a boolean whatever arrived, in the season and in live state.
  assert.equal(cleanPlayedMatch({ date: '2026-01-01', friendly: '<b>' }).friendly, false);
  assert.equal(cleanLive({ id: 'm', friendly: true }).friendly, true);
  assert.equal(cleanLive({ id: 'm', friendly: 'yes' }).friendly, false);
  // "אימון" in the round column of a schedule file.
  const rows = [['מחזור', 'תאריך', 'יריבה', 'בית/חוץ'], ['משחק אימון', '12/10/2026', 'הפועל', 'בית'], ['4', '19/10/2026', 'בני', 'חוץ']];
  const out = F.rowsToFixtures(rows, F.detectFixtureColumns(rows));
  assert.deepEqual(out.fixtures.map((f) => [f.round, f.friendly === true]), [[null, true], [4, false]]);
  assert.equal(F.fixtureAsNext(out.fixtures[0]).friendly, true, 'the next-match card lost the flag');
});

await test('lists keep one order: squad by number, videos as parents see them even without a round', async () => {
  const { byNumber } = await import('../src/format.js');
  const { videoOrder } = await import('../src/views/media.js');
  const squad = [{ name: 'ב', number: 9 }, { name: 'א' }, { name: 'ג', number: 3 }, { name: 'ד', number: 9 }];
  assert.deepEqual(squad.sort(byNumber).map((p) => p.name), ['ג', 'ב', 'ד', 'א']);
  const vids = [{ title: 'x' }, { title: 'r2', round: 2 }, { title: 'f', featured: true }, { title: 'r5', round: 5 }, { title: 'y', round: '' }];
  assert.deepEqual(vids.sort(videoOrder).map((v) => v.title), ['f', 'r5', 'r2', 'x', 'y']);
});

await test('a game date carries its year', async () => {
  const { shortDate } = await import('../src/format.js');
  const { roundText } = await import('../src/components.js');
  assert.equal(shortDate('2026-09-05'), '05.09.26');
  assert.equal(roundText(3), 'מחזור 3');
  assert.equal(roundText(null, true), 'משחק אימון');
  assert.equal(roundText(null), '');
});

await test('a gallery upload can go to any past game — with a result or only on the schedule', async () => {
  const { photoMatches } = await import('../src/fixtures.js');
  const now = new Date('2026-10-20T12:00:00+03:00');
  const matches = [{ date: '2026-09-19', opponent: 'בני לוד' }, { date: '2026-10-03', opponent: 'הפועל כפר סבא' }];
  const fixtures = [
    { date: '2026-10-10', opponent: 'מכבי יפו' },          // played, no result entered
    { date: '2026-10-03', opponent: 'הפועל כפר סבא' },     // has its result
    { date: '2026-10-24', opponent: 'בית"ר ת"א' },         // still ahead
  ];
  const got = photoMatches(matches, fixtures, now).map((m) => m.opponent);
  assert.deepEqual(got, ['מכבי יפו', 'הפועל כפר סבא', 'בני לוד']);
});

await test('an uploaded crest loses its transparent margin', async () => {
  const { opaqueBounds } = await import('../src/imaging.js');
  const w = 10, h = 12, px = new Uint8ClampedArray(w * h * 4);
  const set = (x, y, a) => { px[(y * w + x) * 4 + 3] = a; };
  set(3, 2, 255); set(6, 8, 255); set(4, 5, 128);
  set(0, 0, 5);                                  // a faint fringe does not count
  assert.deepEqual(opaqueBounds(px, w, h), { x: 3, y: 2, w: 4, h: 7 });
  assert.equal(opaqueBounds(new Uint8ClampedArray(16), 2, 2), null);
});

await test('sharpening lifts an edge, leaves flat colour, alpha and empty pixels alone', async () => {
  const { unsharp } = await import('../src/imaging.js');
  const w = 6, h = 3, px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4, v = x < 3 ? 60 : 180;
    px.set(x === 5 ? [0, 0, 0, 0] : [v, v, v, 200], i);
  }
  unsharp(px, w, h, 0.5);
  const at = (x, y = 1) => px[(y * w + x) * 4];
  assert.equal(at(0), 60, 'flat colour moved');
  assert.ok(at(2) < 60 && at(3) > 180, `edge not sharpened: ${at(2)} ${at(3)}`);
  assert.equal(at(4), 180, 'a transparent neighbour darkened its edge');
  assert.deepEqual([...px.slice((1 * w + 5) * 4, (1 * w + 5) * 4 + 4)], [0, 0, 0, 0]);
  assert.equal(px[(1 * w + 2) * 4 + 3], 200, 'alpha changed');
});

// A w×h RGBA image from a painter: (x, y) → [r, g, b] (alpha 255).
const paint = (w, h, f) => {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px.set([...f(x, y), 255], (y * w + x) * 4);
  return px;
};
const NAVY = [27, 21, 85], GREEN = [7, 245, 7], WHITE = [255, 255, 255];
const alphaAt = (px, w, x, y) => px[(y * w + x) * 4 + 3];

await test('a flat green background is removed; the crest and the white inside it stay', async () => {
  const { keyBackground } = await import('../src/imaging.js');
  // A navy ring (6..13) round a white centre, on green — the white must stay:
  // it does not touch the border.
  const w = 20, h = 20;
  const px = paint(w, h, (x, y) => (x >= 6 && x <= 13 && y >= 6 && y <= 13) ? ((x >= 8 && x <= 11 && y >= 8 && y <= 11) ? WHITE : NAVY) : GREEN);
  assert.equal(keyBackground(px, w, h), true);
  assert.equal(alphaAt(px, w, 0, 0), 0);
  assert.equal(alphaAt(px, w, 5, 10), 0);
  assert.equal(alphaAt(px, w, 6, 10), 255, 'the crest edge went');
  assert.equal(alphaAt(px, w, 10, 10), 255, 'the white inside the crest went');
});

await test('a white page goes too, and a painted checkerboard', async () => {
  const { keyBackground } = await import('../src/imaging.js');
  const w = 16, h = 16, inside = (x, y) => x >= 5 && x <= 10 && y >= 5 && y <= 10;
  const white = paint(w, h, (x, y) => inside(x, y) ? NAVY : [250, 251, 249]);
  assert.equal(keyBackground(white, w, h), true);
  assert.equal(alphaAt(white, w, 1, 1), 0);
  const check = paint(w, h, (x, y) => inside(x, y) ? NAVY : ((x >> 1) + (y >> 1)) % 2 ? [216, 216, 216] : WHITE);
  assert.equal(keyBackground(check, w, h), true);
  assert.equal(alphaAt(check, w, 1, 1) + alphaAt(check, w, 3, 1), 0, 'a square of the checkerboard stayed');
  assert.equal(alphaAt(check, w, 7, 7), 255);
});

await test('an edge pixel half green becomes half transparent, and loses the green', async () => {
  const { keyBackground } = await import('../src/imaging.js');
  const w = 12, h = 12;
  const mix = NAVY.map((c, i) => Math.round((c + GREEN[i]) / 2));
  const px = paint(w, h, (x, y) => (x >= 4 && x <= 7 && y >= 4 && y <= 7) ? (x === 4 ? mix : NAVY) : GREEN);
  keyBackground(px, w, h);
  const a = alphaAt(px, w, 4, 5), g = px[(5 * w + 4) * 4 + 1];
  assert.ok(a > 60 && a < 200, 'alpha ' + a);
  assert.ok(g < 60, 'green left in the edge: ' + g);
});

await test('a border that is not one plain colour is left alone', async () => {
  const { keyBackground } = await import('../src/imaging.js');
  const w = 16, h = 16;
  // A photo-like border: a gradient.
  const grad = paint(w, h, (x, y) => [x * 16, y * 16, 128]);
  const before = Uint8ClampedArray.from(grad);
  assert.equal(keyBackground(grad, w, h), false);
  assert.deepEqual(grad, before);
  // A crest cut to its edge on green on two sides: navy on a third of the
  // border is not a second background colour.
  const cut = paint(w, h, (x) => x < 6 ? NAVY : GREEN);
  assert.equal(keyBackground(cut, w, h), false);
  // Already transparent: nothing to do.
  const clear = new Uint8ClampedArray(w * h * 4);
  assert.equal(keyBackground(clear, w, h), false);
});

  console.log(`\nunits: ${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
}

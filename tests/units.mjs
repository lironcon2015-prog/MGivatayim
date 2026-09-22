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

await test('unticked rows and kept-missing players are left alone', () => {
  const existing = [{ id: 'a', name: 'איתי', number: 7 }, { id: 'c', name: 'עוזב', number: 4 }];
  const plan = planImport(existing, [{ name: 'איתי', number: 8, pos: '', pos2: '' }, { name: 'חדש', number: 5, pos: '', pos2: '' }]);
  const out = applyImport(existing, plan, { include: [false, true], removeMissing: false, newId: () => 'x' });
  assert.deepEqual(out.map((p) => [p.id, p.number]), [['a', 7], ['c', 4], ['x', 5]]);
});

export { test, failures };
export const done = () => passed;

if (process.argv[1].endsWith('units.mjs')) {
  const model = await import('./units-live.mjs').catch((e) => (e.code === 'ERR_MODULE_NOT_FOUND' ? null : Promise.reject(e)));
  if (model) await model.run(test);
  console.log(`\nunits: ${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
}

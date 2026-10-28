import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { planStock, formatShortageCsv, formatMarkdown } from '../src/index.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));
const bom = 'Reference,MPN,Quantity,DNP\n"R1,R2",A,2,\nR3,A,1,\nU1,B,1,\nJ1,,1,DNP\n';
const stock = 'MPN,Stock\nA,7\nB,2\n';

test('aggregates by exact identifier before multiplying and allocating stock', () => {
  const r = planStock(bom, stock, { boards: 3, spares: 1 });
  assert.equal(r.complete, true); assert.equal(r.excludedRows, 1);
  assert.deepEqual(r.items.map(x => [x.key, x.required, x.available, x.shortage]), [['A', 10, 7, 3], ['B', 4, 2, 2]]);
  assert.equal(r.summary.shortageUnits, 5);
});
test('duplicate stock rows fail closed instead of double-counting inventory', () => {
  const r = planStock(bom, stock + 'A,4\n');
  assert.equal(r.complete, false); assert.equal(r.items[0].available, null);
  assert.throws(() => formatShortageCsv(r), /incomplete/);
});
test('missing parts are zero-stock warnings and case-sensitive keys stay distinct', () => {
  const r = planStock('MPN,Quantity\nA,2\na,1\n', 'MPN,Stock\nA,3\n');
  assert.equal(r.complete, true); assert.equal(r.items[1].shortage, 1);
  assert.equal(r.diagnostics[0].code, 'unlisted-stock');
});
test('custom headers, BOM, TSV, quoted fields and newlines use mature CSV parser', () => {
  const r = planStock('\ufeffSKU\tQty\tRef\n"a\tb"\t2\t"R1\nR2"\n', 'Key\tCount\n"a\tb"\t1\n', {
    delimiter: '\t', columns: { bomKey: 'SKU', stockKey: 'Key', quantity: 'Qty', stock: 'Count', reference: 'Ref' },
  });
  assert.equal(r.items[0].key, 'a\tb'); assert.equal(r.items[0].shortage, 1);
});
test('invalid and overflowing quantities do not yield a usable purchase plan', () => {
  for (const quantity of ['-1', '1.2', 'Infinity', '9007199254740992', '']) {
    const r = planStock(`MPN,Quantity\nA,${quantity}\n`, stock); assert.equal(r.complete, false);
  }
  assert.equal(planStock('MPN,Quantity\nA,9007199254740991\n', stock, { boards: 2 }).complete, false);
  assert.throws(() => planStock(bom, stock, { boards: 0 }), /boards/);
});
test('unknown DNP and missing part numbers require correction', () => {
  const r = planStock('MPN,Quantity,DNP\n,1,\nA,2,maybe\n', stock);
  assert.equal(r.complete, false); assert.equal(r.diagnostics.length, 2);
});
test('repeated reference tokens flag duplicated or conflicting BOM rows', () => {
  const r = planStock('Reference,MPN,Quantity\nR1,A,1\nR1,B,1\n', stock);
  assert.equal(r.complete, false); assert.ok(r.diagnostics.some(x => x.code === 'duplicate-reference'));
});
test('CSV rejects duplicate headers, missing columns and ragged rows', () => {
  assert.throws(() => planStock('MPN,MPN,Quantity\nA,A,1\n', stock), /unique/);
  assert.throws(() => planStock('Value,Quantity\nR,1\n', stock), /Missing/);
  assert.throws(() => planStock('MPN,Quantity\nA,1,extra\n', stock));
});
test('spreadsheet formula prefixes and Markdown special content are escaped', () => {
  const r = planStock('MPN,Quantity,Reference\n=1+1,1,<img>|x\n', 'MPN,Stock\n');
  assert.match(formatShortageCsv(r), /'=1\+1/);
  assert.match(formatMarkdown(r), /&lt;img&gt;\\\|x/);
});
test('CLI demo produces JSON and check mode has meaningful exit codes', () => {
  const args = ['src/cli.mjs', '--bom', 'examples/bom.csv', '--stock', 'examples/stock.csv', '--boards', '3', '--format', 'json'];
  const ok = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr); assert.equal(JSON.parse(ok.stdout).summary.shortageUnits, 3);
  assert.equal(spawnSync(process.execPath, [...args, '--check'], { cwd: root }).status, 1);
  assert.equal(spawnSync(process.execPath, ['src/cli.mjs', '--unknown'], { cwd: root }).status, 2);
});

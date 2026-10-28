import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';

const defaults = Object.freeze({ bomKey: 'MPN', stockKey: 'MPN', quantity: 'Quantity', stock: 'Stock', reference: 'Reference', dnp: 'DNP' });

function integer(value, label, minimum = 0) {
  const text = String(value).trim();
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text)) || Number(text) < minimum) {
    throw new Error(`${label} must be a safe integer >= ${minimum}`);
  }
  return Number(text);
}

function table(text, required, delimiter) {
  if (typeof text !== 'string') throw new TypeError('CSV input must be a string');
  if (typeof delimiter !== 'string' || [...delimiter].length !== 1) throw new Error('delimiter must be one character');
  const records = parse(text, { bom: true, delimiter, skip_empty_lines: true, relax_column_count: false });
  if (!records.length) throw new Error('CSV has no header');
  const header = records.shift().map(x => x.trim());
  if (new Set(header).size !== header.length || header.some(x => !x)) throw new Error('CSV headers must be nonempty and unique');
  for (const name of required) if (!header.includes(name)) throw new Error(`Missing CSV column: ${name}`);
  return records.map((row, i) => ({ row: i + 2, values: Object.fromEntries(header.map((name, j) => [name, row[j]])) }));
}

/** Plan local stock use without modifying either input. Keys are trimmed, case-sensitive identifiers. */
export function planStock(bomCsv, stockCsv, options = {}) {
  const columns = { ...defaults, ...options.columns };
  for (const [key, name] of Object.entries(columns)) if (typeof name !== 'string' || !name) throw new Error(`Invalid column mapping: ${key}`);
  const boards = integer(options.boards ?? 1, 'boards', 1);
  const spares = integer(options.spares ?? 0, 'spares');
  const delimiter = options.delimiter ?? ',';
  const bom = table(bomCsv, [columns.bomKey, columns.quantity], delimiter);
  const stock = table(stockCsv, [columns.stockKey, columns.stock], delimiter);
  const diagnostics = [];
  const error = (source, row, code, message) => diagnostics.push({ severity: 'error', source, row, code, message });
  const inventory = new Map();
  const invalidInventory = new Set();
  for (const { row, values } of stock) {
    const key = values[columns.stockKey].trim();
    if (!key) { error('stock', row, 'missing-key', 'Stock row has no item identifier'); continue; }
    if (inventory.has(key) || invalidInventory.has(key)) {
      error('stock', row, 'duplicate-stock-key', `Duplicate inventory identifier: ${key}; consolidate stock locations first`);
      invalidInventory.add(key); inventory.delete(key); continue;
    }
    try { inventory.set(key, integer(values[columns.stock], `Stock row ${row}`)); }
    catch (e) { error('stock', row, 'invalid-stock', e.message); invalidInventory.add(key); }
  }
  const groups = new Map();
  const referencesSeen = new Set();
  let excludedRows = 0;
  for (const { row, values } of bom) {
    const dnp = (values[columns.dnp] ?? '').trim().toLowerCase();
    if (['1', 'true', 'yes', 'y', 'dnp', 'x'].includes(dnp)) { excludedRows++; continue; }
    if (!['', '0', 'false', 'no', 'n'].includes(dnp)) { error('bom', row, 'invalid-dnp', 'Unknown DNP marker; use blank/false/0/no or true/1/yes/DNP'); continue; }
    const key = values[columns.bomKey].trim();
    if (!key) { error('bom', row, 'missing-key', 'Populated BOM row has no exact part identifier'); continue; }
    let quantity;
    try { quantity = integer(values[columns.quantity], `BOM row ${row}`, 1); }
    catch (e) { error('bom', row, 'invalid-quantity', e.message); continue; }
    for (const reference of (values[columns.reference] ?? '').split(/[,;\s]+/).filter(Boolean)) {
      if (referencesSeen.has(reference)) error('bom', row, 'duplicate-reference', `Repeated reference token: ${reference}; review duplicated or conflicting BOM rows`);
      referencesSeen.add(reference);
    }
    const group = groups.get(key) ?? { key, perBoard: 0, references: [], sourceRows: [] };
    group.perBoard += quantity;
    if (!Number.isSafeInteger(group.perBoard)) error('bom', row, 'quantity-overflow', `Total quantity exceeds safe integer range: ${key}`);
    if (values[columns.reference]?.trim()) group.references.push(values[columns.reference].trim());
    group.sourceRows.push(row);
    groups.set(key, group);
  }
  const items = [...groups.values()].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0).map(group => {
    const required = group.perBoard * boards + spares;
    if (!Number.isSafeInteger(required)) error('bom', group.sourceRows[0], 'quantity-overflow', `Build quantity exceeds safe integer range: ${group.key}`);
    const knownStock = inventory.has(group.key);
    const available = invalidInventory.has(group.key) ? null : (inventory.get(group.key) ?? 0);
    if (!knownStock && available === 0) diagnostics.push({ severity: 'warning', source: 'stock', row: null, code: 'unlisted-stock', message: `${group.key} is absent from the inventory; planned as zero available` });
    return { ...group, required, available, shortage: available === null || !Number.isSafeInteger(required) ? null : Math.max(0, required - available), knownStock };
  });
  const shortageUnits = items.reduce((sum, x) => sum + (x.shortage ?? 0), 0);
  if (!Number.isSafeInteger(shortageUnits)) error('bom', null, 'quantity-overflow', 'Total shortage exceeds safe integer range');
  const complete = !diagnostics.some(d => d.severity === 'error');
  return { schemaVersion: 1, complete, options: { boards, spares }, excludedRows, items, diagnostics,
    summary: { uniqueParts: items.length, shortageParts: complete ? items.filter(x => x.shortage > 0).length : null, shortageUnits: complete ? shortageUnits : null } };
}

function md(value) { return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('|', '\\|').replaceAll('\r', ' ').replaceAll('\n', ' ').replace(/[\u0000-\u001f\u007f]/g, ''); }
export function formatMarkdown(report) {
  const rows = report.items.map(x => `| ${md(x.key)} | ${x.perBoard} | ${x.required} | ${x.available ?? '?'} | ${x.shortage ?? '?'} | ${md(x.references.join('; '))} |`);
  return `# KiCad stock plan\n\n${report.complete ? 'Ready for human review.' : '**INCOMPLETE: resolve errors before using this plan.**'}\n\nBoards: ${report.options.boards}; spares per unique part: ${report.options.spares}; DNP rows skipped: ${report.excludedRows}.\n\n| Part | Per board | Required | Available | Shortage | References |\n| --- | ---: | ---: | ---: | ---: | --- |\n${rows.join('\n')}\n\n## Diagnostics\n\n${report.diagnostics.length ? report.diagnostics.map(d => `- ${d.severity}: ${md(d.source)} ${d.row ?? ''} — ${md(d.message)}`).join('\n') : 'None.'}\n`;
}
export function formatShortageCsv(report) {
  if (!report.complete) throw new Error('Refusing to produce a purchase CSV from an incomplete plan');
  return stringify(report.items.filter(x => x.shortage > 0).map(x => ({ Part: x.key, Required: x.required, Available: x.available, Shortage: x.shortage, References: x.references.join('; ') })), {
    header: true, columns: ['Part', 'Required', 'Available', 'Shortage', 'References'], escape_formulas: true,
  });
}

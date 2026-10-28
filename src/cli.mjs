#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { planStock, formatMarkdown, formatShortageCsv } from './index.mjs';

const help = `kicad-stock-bridge --bom BOM.csv --stock stock.csv [options]
Read-only local inventory planning. Output goes to stdout.
  --boards N             Number of boards (default 1)
  --spares N             Extra pieces per unique part, after multiplication (0)
  --format markdown|json|csv    Output format (markdown)
  --delimiter CHAR       CSV delimiter (comma; use "tab" for TSV)
  --bom-key NAME         BOM identifier column (MPN)
  --stock-key NAME       Inventory identifier column (MPN)
  --quantity-column NAME BOM quantity column (Quantity)
  --stock-column NAME    Inventory quantity column (Stock)
  --reference-column NAME  Optional reference column (Reference)
  --dnp-column NAME      Optional DNP column (DNP)
  --check                Exit 1 on shortages, otherwise shortages exit 0
  --help                 Show help
Exit 2: invalid input/incomplete plan. No files are changed.\n`;
try {
  const { values } = parseArgs({ options: {
    bom: { type: 'string' }, stock: { type: 'string' }, boards: { type: 'string' }, spares: { type: 'string' },
    format: { type: 'string', default: 'markdown' }, delimiter: { type: 'string', default: ',' },
    'bom-key': { type: 'string' }, 'stock-key': { type: 'string' }, 'quantity-column': { type: 'string' },
    'stock-column': { type: 'string' }, 'reference-column': { type: 'string' }, 'dnp-column': { type: 'string' },
    check: { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h', default: false },
  }, strict: true, allowPositionals: false });
  if (values.help) process.stdout.write(help);
  else {
    if (!values.bom || !values.stock) throw new Error('--bom and --stock are required');
    if (!['markdown', 'json', 'csv'].includes(values.format)) throw new Error('Unsupported --format');
    const names = { 'bom-key': 'bomKey', 'stock-key': 'stockKey', 'quantity-column': 'quantity', 'stock-column': 'stock', 'reference-column': 'reference', 'dnp-column': 'dnp' };
    const columns = Object.fromEntries(Object.entries(names).filter(([flag]) => values[flag] !== undefined).map(([flag, key]) => [key, values[flag]]));
    const result = planStock(readFileSync(values.bom, 'utf8'), readFileSync(values.stock, 'utf8'), { boards: values.boards, spares: values.spares, columns, delimiter: values.delimiter === 'tab' ? '\t' : values.delimiter });
    if (values.format === 'csv' && !result.complete) {
      process.stderr.write(formatMarkdown(result)); process.exitCode = 2;
    } else {
      process.stdout.write(values.format === 'json' ? JSON.stringify(result, null, 2) + '\n' : values.format === 'csv' ? formatShortageCsv(result) : formatMarkdown(result));
      process.exitCode = !result.complete ? 2 : values.check && result.summary.shortageParts > 0 ? 1 : 0;
    }
  }
} catch (error) { process.stderr.write(`kicad-stock-bridge: ${error.message}\n`); process.exitCode = 2; }

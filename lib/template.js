import fs from 'node:fs';
import path from 'node:path';
import XLSX from 'xlsx';
import Handlebars from 'handlebars';

/**
 * Resolves a CSV/JS path as given or against cwd. Returns null if not found.
 */
export function resolvePath(filePath) {
  if (!filePath) return null;
  if (fs.existsSync(filePath)) return path.resolve(filePath);
  const cwdPath = path.resolve(process.cwd(), filePath);
  if (fs.existsSync(cwdPath)) return cwdPath;
  return null;
}

/**
 * Reads the first sheet of a CSV/Excel file as an array of row objects (all values as strings).
 */
export function readRows(file) {
  // raw: keep CSV text exactly as written; otherwise "1/2/1990" is parsed as a date and comes back as "1/2/90".
  const wb = XLSX.readFile(file, { raw: true });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });
}

/**
 * Returns the row's data plus lowercase aliases for each header.
 */
export function rowWithAliases(row) {
  const rowData = { ...row };
  // ponytail: case-insensitive aliases for headers to tolerate case variance
  for (const [k, v] of Object.entries(rowData)) {
    rowData[k.toLowerCase()] = v;
  }
  return rowData;
}

/**
 * Substitutes {{header}} placeholders in code with the row's values. Throws on unknown headers.
 */
export function renderTemplate(code, row) {
  const render = Handlebars.compile(code, { noEscape: true, strict: true });
  return render(rowWithAliases(row));
}

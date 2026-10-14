/**
 * Bravo file, document and folder naming standard (ISO 9001:2015 deck,
 * 2026-10-13 "File Naming Conventions", adopted 2026-10-15).
 *
 * ONE FILE, TWO COPIES, BYTE-IDENTICAL:
 *   apps/auth-service/src/common/naming/file-naming.ts
 *   apps/ops-console/src/lib/fileNaming.ts
 * The apps build and ship separately, so they cannot import each other; a test
 * (fileNamingParity.test.ts) fails the moment the two copies differ. Edit one,
 * copy it over the other. No imports, no platform APIs — pure functions only.
 *
 * The rules, from the deck:
 *   - machine readable, human readable, sorts well: most important part first;
 *     a date-first name when the file will be looked up by date;
 *   - dates ISO 8601 basic, YYYYMMDD; a time stamp is YYYYMMDDThhmm, 24-hour.
 *     Bravo stamps are UTC, the same clock the console shows;
 *   - no spaces and no special characters ~ ! @ # $ % ^ & * ( ) ` ; : < > ? . ,
 *     [ ] { } ' " | — words are CamelCase, parts are joined with "_";
 *   - versions as _v2, _v3 …;
 *   - short: aim for 40–50 characters (hard cap MAX_FILE_NAME here).
 *
 * Folders: 13 main folders (department codes) × 4 document categories, and
 * controlled documents numbered "BRV-FN 100-001 Expense Tracking Procedure".
 */

export const COMPANY_PREFIX = 'BRV';

/** Hard cap for a generated file name, extension included. */
export const MAX_FILE_NAME = 60;

export interface Department {
  code: DepartmentCode;
  /** Main folder number, e.g. "012" → "012. FINANCE". */
  folder: string;
  name: string;
}

export type DepartmentCode =
  | 'EX' | 'MS' | 'SS' | 'GR' | 'EC' | 'TR' | 'BC' | 'HR' | 'SC' | 'LG' | 'IT' | 'FN' | 'QH';

/** The main folder structure, in the deck's order. */
export const DEPARTMENTS: readonly Department[] = [
  {code: 'EX', folder: '001', name: 'Executive Director'},
  {code: 'MS', folder: '002', name: 'Messenger'},
  {code: 'SS', folder: '003', name: 'Secure Services'},
  {code: 'GR', folder: '004', name: 'GeoRisk'},
  {code: 'EC', folder: '005', name: 'Enterprise Channels'},
  {code: 'TR', folder: '006', name: 'Training & Development'},
  {code: 'BC', folder: '007', name: 'Bravo Care'},
  {code: 'HR', folder: '008', name: 'Human Resources'},
  {code: 'SC', folder: '009', name: 'Supply Chain'},
  {code: 'LG', folder: '010', name: 'Legal'},
  {code: 'IT', folder: '011', name: 'Information Technology'},
  {code: 'FN', folder: '012', name: 'Finance'},
  {code: 'QH', folder: '013', name: 'Quality, Health, Safety, Security, Environment'},
];

export type DocCategoryCode = 100 | 200 | 300 | 400;

/** The sub-folders inside every main folder. */
export const DOC_CATEGORIES: ReadonlyArray<{code: DocCategoryCode; name: string}> = [
  {code: 100, name: 'Policy / Procedures'},
  {code: 200, name: 'Work Instructions'},
  {code: 300, name: 'Forms'},
  {code: 400, name: 'Organizational Charts and Drawings'},
];

export function isDepartmentCode(v: unknown): v is DepartmentCode {
  return typeof v === 'string' && DEPARTMENTS.some(d => d.code === v);
}

export function isDocCategory(v: unknown): v is DocCategoryCode {
  return typeof v === 'number' && DOC_CATEGORIES.some(c => c.code === v);
}

export function departmentOf(code: DepartmentCode): Department {
  return DEPARTMENTS.find(d => d.code === code) as Department;
}

/** "012. FINANCE" */
export function departmentFolderLabel(code: DepartmentCode): string {
  const d = departmentOf(code);
  return `${d.folder}. ${d.name.toUpperCase()}`;
}

/** "100. Policy / Procedures" */
export function categoryFolderLabel(code: DocCategoryCode): string {
  return `${code}. ${DOC_CATEGORIES.find(c => c.code === code)?.name ?? ''}`;
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** ISO 8601 basic date, UTC: "20261015". */
export function isoDate(at: Date): string {
  return `${at.getUTCFullYear()}${pad(at.getUTCMonth() + 1)}${pad(at.getUTCDate())}`;
}

/** ISO 8601 basic time stamp, UTC, 24-hour: "20261015T0930". */
export function isoStamp(at: Date): string {
  return `${isoDate(at)}T${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}`;
}

/** "2026-10-15" (an ISO date someone typed) → "20261015"; anything else → null. */
export function compactIsoDate(v: string | null | undefined): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v ?? '');
  return m ? `${m[1]}${m[2]}${m[3]}` : null;
}

/**
 * Free text → one CamelCase word with only A–Z, a–z, 0–9.
 * "Tangible fixed-asset policy (draft)" → "TangibleFixedAssetPolicyDraft".
 * Accents are folded ("Résumé" → "Resume"); an all-caps word keeps its caps
 * ("HR & Training" → "HRTraining").
 */
export function descriptor(text: string | null | undefined, maxLen = 40): string {
  const folded = (text ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '');
  const words = folded.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const out = words.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('');
  return out.slice(0, Math.max(1, maxLen));
}

/** A safe lowercase extension without the dot ("PDF" → "pdf"); '' if none. */
export function cleanExtension(ext: string | null | undefined): string {
  return (ext ?? '').replace(/^\./, '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5);
}

/** Split "Some File.v2.PDF" into base "Some File.v2" and ext "pdf". */
export function splitName(name: string | null | undefined): {base: string; ext: string} {
  const n = (name ?? '').trim();
  const i = n.lastIndexOf('.');
  if (i <= 0 || i === n.length - 1) {return {base: n, ext: ''};}
  return {base: n.slice(0, i), ext: cleanExtension(n.slice(i + 1))};
}

function join(parts: readonly string[], ext: string): string {
  const e = cleanExtension(ext);
  return parts.filter(Boolean).join('_') + (e ? `.${e}` : '');
}

/**
 * Fit a name under MAX_FILE_NAME by shortening the FLEXIBLE parts (the
 * descriptors), never the date, the codes or the version.
 */
function fit(fixed: {before: string[]; flex: string[]; after: string[]}, ext: string): string {
  const flex = [...fixed.flex];
  let name = join([...fixed.before, ...flex, ...fixed.after], ext);
  while (name.length > MAX_FILE_NAME) {
    // Shorten the longest flexible part by one character at a time.
    let longest = -1;
    for (let i = 0; i < flex.length; i++) {
      if (longest < 0 || flex[i].length > flex[longest].length) {longest = i;}
    }
    if (longest < 0 || flex[longest].length <= 4) {break;}
    flex[longest] = flex[longest].slice(0, -1);
    name = join([...fixed.before, ...flex, ...fixed.after], ext);
  }
  return name;
}

/**
 * A file the platform EXPORTS (CSV, PDF report …): date first, then whose it
 * is, then what it is.
 *   exportFileName({dept: 'FN', subject: 'Wallet ledger', ext: 'csv', at})
 *     → "20261015T0930_BRV-FN_WalletLedger.csv"
 *   exportFileName({dept: 'HR', subject: 'Attendance', scope: 'GardaWorld Africa', ext: 'csv', at})
 *     → "20261015T0930_BRV-HR_Attendance_GardaWorldAfrica.csv"
 */
export function exportFileName(input: {
  dept: DepartmentCode; subject: string; ext: string; at?: Date;
  /** Optional qualifier: an organisation, a provider, a date range … */
  scope?: string | null;
}): string {
  const at = input.at ?? new Date();
  const flex = [descriptor(input.subject) || 'Export'];
  // Dates in the scope ("20261001" or "20261001-20261015") stay intact as their
  // own part — they are what the file will be looked up by — and are never
  // shortened; the words around them become one CamelCase part.
  const tokens = (input.scope ?? '').split(/\s+/).filter(Boolean);
  const isDate = (t: string) => /^\d{8}(-\d{8})?$/.test(t);
  const words = descriptor(tokens.filter(t => !isDate(t)).join(' '));
  if (words) {flex.push(words);}
  return fit({before: [isoStamp(at), `${COMPANY_PREFIX}-${input.dept}`], flex, after: tokens.filter(isDate)}, input.ext);
}

/** A date range qualifier for exportFileName: "20261001-20261015". */
export function dateRangeScope(from: string | null | undefined, to: string | null | undefined): string | null {
  const a = compactIsoDate(from);
  const b = compactIsoDate(to);
  if (a && b) {return a === b ? a : `${a}-${b}`;}
  return a ?? b ?? null;
}

/**
 * A file someone UPLOADS, as the platform stores it: date first, then the
 * descriptor from their own file name, then the version.
 *   uploadFileName('Passport scan (front).JPG', at) → "20261015T0930_PassportScanFront_v1.jpg"
 * `version` > 1 when a file with the same stamp and descriptor already exists.
 */
export function uploadFileName(originalName: string | null | undefined, at: Date = new Date(), version = 1): string {
  const {base, ext} = splitName(originalName);
  return fit({before: [isoStamp(at)], flex: [descriptor(base) || 'File'], after: [`v${Math.max(1, Math.trunc(version))}`]}, ext);
}

/** "BRV-FN 100-001" — the controlled document number, as written on the document. */
export function controlledDocNumber(dept: DepartmentCode, category: DocCategoryCode, seq: number): string {
  return `${COMPANY_PREFIX}-${dept} ${category}-${pad(seq, 3)}`;
}

/** "BRV-FN 100-001 Expense Tracking Procedure" — the title line. */
export function controlledDocTitle(dept: DepartmentCode, category: DocCategoryCode, seq: number, title: string): string {
  return `${controlledDocNumber(dept, category, seq)} ${title.trim()}`;
}

/**
 * The controlled document AS A FILE (no spaces, versioned):
 *   "BRV-FN-100-001_ExpenseTrackingProcedure_v2.pdf"
 */
export function controlledDocFileName(input: {
  dept: DepartmentCode; category: DocCategoryCode; seq: number; title: string; version: number; ext: string;
}): string {
  const id = controlledDocNumber(input.dept, input.category, input.seq).replace(' ', '-');
  return fit({before: [id], flex: [descriptor(input.title) || 'Document'],
    after: [`v${Math.max(1, Math.trunc(input.version))}`]}, input.ext);
}

/** Does a name follow the standard's character rules (no spaces, no specials)? */
export function isConventionSafe(name: string): boolean {
  return /^[A-Za-z0-9_-]+(\.[a-z0-9]{1,5})?$/.test(name);
}

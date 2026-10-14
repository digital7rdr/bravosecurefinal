import {CHANNEL_POST_MODES, type ChannelPostMode} from './dto/channel.dto';

/**
 * Enterprise structure (2026-10-15) — per-level CHANNEL TEMPLATES.
 *
 * When ops adds a node to an organisation's tree (a country, a province, an
 * area), the node's standard channels are created with it as LATERALS of the
 * node, e.g. an area gets "Area Broadcast", "Operations", "Administration",
 * "Logistics" and "HR & Training". Each is an ordinary channel afterwards: it
 * can be renamed, re-moded or archived like any other.
 *
 * Stored per organisation in `org_workspace_settings.channel_templates`
 * (PRESENTATION / creation defaults only — nothing here is read by an
 * authorisation check, which is that table's rule). An organisation that never
 * saved templates gets DEFAULT_CHANNEL_TEMPLATES.
 *
 * Keyed by STORED level (0 = the organisation itself … 3 = the deepest tier),
 * which is what department_channels.level holds and what the UI calls L1..L4.
 */

export interface ChannelTemplate {
  name: string;
  post_mode: ChannelPostMode;
}
export type ChannelTemplates = Record<'0' | '1' | '2' | '3', ChannelTemplate[]>;

export const TEMPLATE_LEVELS = ['0', '1', '2', '3'] as const;
export const MAX_TEMPLATES_PER_LEVEL = 12;
export const MAX_TEMPLATE_NAME = 80;

/** The founder's sample (GardaWorld Africa › country › province › area). */
export const DEFAULT_CHANNEL_TEMPLATES: ChannelTemplates = {
  '0': [{name: 'Group Broadcast', post_mode: 'announcement'}],
  '1': [{name: 'National Broadcast', post_mode: 'announcement'}],
  '2': [
    {name: 'Provincial Broadcast', post_mode: 'announcement'},
    {name: 'Committees', post_mode: 'open'},
    {name: 'Announcements', post_mode: 'announcement'},
    {name: 'Knowledge Hub', post_mode: 'read_only'},
  ],
  '3': [
    {name: 'Area Broadcast', post_mode: 'announcement'},
    {name: 'Operations', post_mode: 'open'},
    {name: 'Administration', post_mode: 'open'},
    {name: 'Logistics', post_mode: 'open'},
    {name: 'HR & Training', post_mode: 'open'},
  ],
};

/**
 * Validate and normalise a templates object from a request or from the
 * database. Throws a short code string on invalid input (the caller maps it to
 * a 400); stored rows are read with `lenient` so one bad entry never breaks
 * the editor.
 */
export function normaliseTemplates(input: unknown, lenient = false): ChannelTemplates {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    if (lenient) {return emptyTemplates();}
    throw new Error('templates_must_be_an_object');
  }
  const src = input as Record<string, unknown>;
  const out = emptyTemplates();
  for (const key of Object.keys(src)) {
    if (!(TEMPLATE_LEVELS as readonly string[]).includes(key)) {
      if (lenient) {continue;}
      throw new Error('template_level_out_of_range');
    }
  }
  for (const level of TEMPLATE_LEVELS) {
    const list = src[level];
    if (list === undefined || list === null) {continue;}
    if (!Array.isArray(list)) {
      if (lenient) {continue;}
      throw new Error('template_level_must_be_a_list');
    }
    if (list.length > MAX_TEMPLATES_PER_LEVEL && !lenient) {throw new Error('too_many_templates');}
    const seen = new Set<string>();
    for (const raw of list.slice(0, MAX_TEMPLATES_PER_LEVEL)) {
      const e = raw as {name?: unknown; post_mode?: unknown} | null;
      const name = typeof e?.name === 'string' ? e.name.trim().slice(0, MAX_TEMPLATE_NAME) : '';
      const mode = e?.post_mode;
      if (!name || !(CHANNEL_POST_MODES as readonly unknown[]).includes(mode)) {
        if (lenient) {continue;}
        throw new Error('invalid_template_entry');
      }
      const k = name.toLowerCase();
      if (seen.has(k)) {
        if (lenient) {continue;}
        throw new Error('duplicate_template_name');
      }
      seen.add(k);
      out[level].push({name, post_mode: mode as ChannelPostMode});
    }
  }
  return out;
}

export function emptyTemplates(): ChannelTemplates {
  return {'0': [], '1': [], '2': [], '3': []};
}

/** Stored value → effective templates (defaults when never saved). */
export function effectiveTemplates(stored: unknown): {templates: ChannelTemplates; is_default: boolean} {
  const isSaved = !!stored && typeof stored === 'object' && !Array.isArray(stored)
    && Object.keys(stored as object).length > 0;
  return isSaved
    ? {templates: normaliseTemplates(stored, true), is_default: false}
    : {templates: DEFAULT_CHANNEL_TEMPLATES, is_default: true};
}

/** Template entries a node is still missing (case-insensitive by name). */
export function missingTemplates(
  templates: readonly ChannelTemplate[], existingNames: readonly string[],
): ChannelTemplate[] {
  const have = new Set(existingNames.map(n => n.trim().toLowerCase()));
  return templates.filter(t => !have.has(t.name.trim().toLowerCase()));
}

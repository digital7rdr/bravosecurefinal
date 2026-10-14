import {
  DEFAULT_CHANNEL_TEMPLATES, effectiveTemplates, missingTemplates, normaliseTemplates,
} from './channel-templates';

/** Enterprise structure (2026-10-15) — per-level channel templates. */
describe('channel templates', () => {
  it('the defaults are the founder\'s sample (province and area channels)', () => {
    expect(DEFAULT_CHANNEL_TEMPLATES['2'].map(t => t.name))
      .toEqual(['Provincial Broadcast', 'Committees', 'Announcements', 'Knowledge Hub']);
    expect(DEFAULT_CHANNEL_TEMPLATES['3'].map(t => t.name))
      .toEqual(['Area Broadcast', 'Operations', 'Administration', 'Logistics', 'HR & Training']);
    // Every default validates.
    expect(() => normaliseTemplates(DEFAULT_CHANNEL_TEMPLATES)).not.toThrow();
  });

  it('a never-saved organisation gets the defaults; a saved empty set stays empty', () => {
    expect(effectiveTemplates(undefined).is_default).toBe(true);
    expect(effectiveTemplates({}).is_default).toBe(true);
    const saved = effectiveTemplates({'0': [], '1': [], '2': [], '3': []});
    expect(saved.is_default).toBe(false);
    expect(saved.templates['3']).toEqual([]);
  });

  it('rejects bad input with a short code', () => {
    expect(() => normaliseTemplates([])).toThrow('templates_must_be_an_object');
    expect(() => normaliseTemplates({'4': []})).toThrow('template_level_out_of_range');
    expect(() => normaliseTemplates({'1': [{name: 'x', post_mode: 'shout'}]})).toThrow('invalid_template_entry');
    expect(() => normaliseTemplates({'1': [{name: 'Ops', post_mode: 'open'}, {name: 'ops', post_mode: 'open'}]}))
      .toThrow('duplicate_template_name');
  });

  it('trims names and reads stored rows leniently', () => {
    expect(normaliseTemplates({'3': [{name: '  Ops  ', post_mode: 'open'}]})['3']).toEqual([{name: 'Ops', post_mode: 'open'}]);
    expect(normaliseTemplates({'3': [{name: '', post_mode: 'open'}, {name: 'A', post_mode: 'open'}], x: 1}, true)['3'])
      .toEqual([{name: 'A', post_mode: 'open'}]);
  });

  it('"apply template" only adds what a node is missing', () => {
    const missing = missingTemplates(DEFAULT_CHANNEL_TEMPLATES['3'], ['operations', 'Area Broadcast ']);
    expect(missing.map(t => t.name)).toEqual(['Administration', 'Logistics', 'HR & Training']);
  });
});

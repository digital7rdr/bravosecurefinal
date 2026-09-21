import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {MissionStateMachine, type MissionStatus} from './mission-state-machine.service';

/**
 * 2026-09-04 — the mission FSM has TWO definitions: the TypeScript table
 * (MissionStateMachine, actor-aware) and the Postgres trigger
 * `missions_fsm_check()` (actor-blind, last line of defence). Until today
 * nothing compared them — a transition added to one and not the other only
 * surfaced as a production `invalid_mission_transition` 500. This spec parses
 * the LATEST migration that (re)defines the trigger and requires the two graphs
 * to be identical once the actor dimension is collapsed.
 *
 * When the trigger body moves to a newer migration, point MIGRATION_PATH at it.
 */
const MIGRATION_PATH = join(
  __dirname, '..', '..', '..', '..', 'supabase', 'migrations', '20260904120001_mission_crewed_fsm.sql',
);

function parseTrigger(): Map<MissionStatus, Set<MissionStatus>> {
  const sql = readFileSync(MIGRATION_PATH, 'utf8').replace(/\r\n/g, '\n');
  const start = sql.indexOf('missions_fsm_check() RETURNS TRIGGER');
  expect(start).toBeGreaterThan(-1);
  const end = sql.indexOf('$$ LANGUAGE plpgsql', start);
  expect(end).toBeGreaterThan(start);
  const body = sql.slice(start, end);
  const re = /OLD\.status\s*=\s*'([A-Z_]+)'\s+AND\s+NEW\.status\s+IN\s*\(([^)]+)\)/g;
  const edges = new Map<MissionStatus, Set<MissionStatus>>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const from = m[1] as MissionStatus;
    const tos = m[2].split(',').map(s => s.trim().replace(/'/g, '') as MissionStatus);
    edges.set(from, new Set(tos));
  }
  expect(edges.size).toBeGreaterThan(0);
  return edges;
}

describe('mission FSM drift — TypeScript table vs missions_fsm_check() trigger', () => {
  const trigger = parseTrigger();
  const ts = MissionStateMachine.edges();

  it('every from-state the trigger knows, the TypeScript table knows (and vice versa)', () => {
    expect([...trigger.keys()].sort()).toEqual([...ts.keys()].sort());
  });

  it.each([...trigger.keys()])('%s → the same to-set in both', (from) => {
    expect([...trigger.get(from)!].sort()).toEqual([...ts.get(from)!].sort());
  });

  it('CREWED can reach DISPATCHED but never PICKUP or LIVE, in both definitions', () => {
    for (const graph of [trigger, ts]) {
      const tos = graph.get('CREWED')!;
      expect(tos.has('DISPATCHED')).toBe(true);
      expect(tos.has('PICKUP')).toBe(false);
      expect(tos.has('LIVE')).toBe(false);
    }
  });

  it('the trigger file re-pins search_path and keeps the BEFORE UPDATE trigger', () => {
    const sql = readFileSync(MIGRATION_PATH, 'utf8');
    expect(sql).toMatch(/ALTER FUNCTION public\.missions_fsm_check\(\) SET search_path = pg_catalog/);
    expect(sql).toMatch(/BEFORE UPDATE ON public\.missions/);
  });
});

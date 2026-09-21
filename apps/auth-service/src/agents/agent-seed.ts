import type {Tx} from '../database/database.service';
import {KYC_KINDS, DEPLOYMENT_CHECKS} from './dto/agent.dto';

export const REVIEW_STEPS = ['submit', 'docs', 'kyc', 'ops', 'partner'] as const;

export const AGENT_DOC_SEED: {slot: string; required: boolean; title: string}[] = [
  {slot: 'sia',       required: true,  title: 'Security License / CPO Profile'},
  {slot: 'passport',  required: true,  title: 'Passport / National ID'},
  {slot: 'insurance', required: true,  title: 'Professional Indemnity Insurance'},
  {slot: 'dbs',       required: true,  title: 'Police Clearance / DBS Enhanced'},
  {slot: 'firstaid',  required: false, title: 'First Aid Certificate'},
  {slot: 'cv',        required: false, title: 'Professional CV / Résumé'},
];

/**
 * Onboarding scaffold shared by self-serve agent creation and managed-CPO
 * minting (50k audit P1-14): KYC checks, the 6 doc slots, the review pipeline
 * and the deployment checks — four batched inserts instead of ~20 sequential
 * ones, and one definition so the two copies can't drift.
 */
export async function seedAgentScaffold(q: Pick<Tx, 'q'>, userId: string): Promise<void> {
  await q.q(
    `INSERT INTO agent_kyc_checks (user_id, kind, state)
     SELECT $1, k, 'queued' FROM unnest($2::text[]) AS t(k)
     ON CONFLICT DO NOTHING`,
    [userId, [...KYC_KINDS]],
  );
  await q.q(
    `INSERT INTO agent_documents (user_id, slot, required, title, state)
     SELECT $1, t.slot, t.required, t.title, 'upload'
       FROM unnest($2::text[], $3::bool[], $4::text[]) AS t(slot, required, title)
     ON CONFLICT (user_id, slot) DO NOTHING`,
    [userId, AGENT_DOC_SEED.map(d => d.slot), AGENT_DOC_SEED.map(d => d.required), AGENT_DOC_SEED.map(d => d.title)],
  );
  await q.q(
    `INSERT INTO agent_review_pipeline (user_id, step, state)
     SELECT $1, s, 'pending' FROM unnest($2::text[]) AS t(s)
     ON CONFLICT DO NOTHING`,
    [userId, [...REVIEW_STEPS]],
  );
  await q.q(
    `INSERT INTO agent_deployment_checks (user_id, check_key, state)
     SELECT $1, k, 'pending' FROM unnest($2::text[]) AS t(k)
     ON CONFLICT DO NOTHING`,
    [userId, [...DEPLOYMENT_CHECKS]],
  );
}

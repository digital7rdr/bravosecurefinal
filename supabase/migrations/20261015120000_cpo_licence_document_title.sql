-- Wording (2026-10-15): the word "security" is no longer used as a descriptor
-- on any Bravo screen — Bravo is positioned as an enterprise secure solution
-- (comms, movement, management and processes).
--
-- Every other label is in code. This one was COPIED into each agent's own
-- document checklist when the agent was created (agents/agent-seed.ts), so
-- existing agents would keep reading "Security License / CPO Profile" after
-- the code changed. Only the untouched default title is rewritten; a title
-- someone edited is left alone. The slot key ('sia') is unchanged.
--
-- Idempotent (re-running matches nothing).

UPDATE public.agent_documents
   SET title = 'Protection Licence / CPO Profile'
 WHERE slot = 'sia'
   AND title = 'Security License / CPO Profile';

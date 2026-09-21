/**
 * B-847 — the one place the console turns a stored `payment_method` into words.
 *
 * `BookingDetail` used to render `payment_method.toUpperCase()`, which read
 * "CARD" for a booking whose escrow hold is charged in Bravo Credits, and would
 * have read "BRAVO_CREDITS" — underscore and all — once the value became
 * honest. An unknown method degrades to its own text with the underscores
 * opened out: a label this table has not been taught yet is still more useful to
 * an operator than a blank cell.
 *
 * Dependency-free on purpose (node test project, no DOM).
 */
const PAYMENT_METHOD_LABELS: Record<string, string> = {
  bravo_credits: 'Bravo Credits',
  card: 'Card',
  corporate: 'Corporate',
};

export function paymentMethodLabel(method: string | null | undefined): string {
  const raw = (method ?? '').toString().trim();
  if (raw === '') return '—';
  return PAYMENT_METHOD_LABELS[raw] ?? raw.replace(/_/g, ' ');
}

/**
 * Who is signed in to the Bravo Web App, and what they may do. No imports, so
 * tests can load it without the API client.
 */
export type AccountKind = 'individual' | 'agency' | 'cpo';

export interface WebMe {
  user: {
    id: string; email: string | null; display_name: string | null; role: string;
    phone_e164: string | null; avatar_url: string | null;
  };
  account_kind: AccountKind;
  must_set_password: boolean;
  is_org_manager: boolean;
  auto_dispatch_enabled: boolean;
  identity_document_status?: 'missing' | 'submitted' | 'unknown';
  identity_document_required?: boolean;
  disabled_modules?: string[];
}

/**
 * Who may book on the web: a client account, exactly the people the mobile
 * app routes to its client home (resolveRoute.ts). Officers, agencies and
 * agency managers get Messenger only.
 */
export function canBook(me: WebMe | undefined | null): boolean {
  if (!me) return false;
  return me.account_kind === 'individual' && !me.is_org_manager
    && me.user.role !== 'agent' && me.user.role !== 'service_provider';
}


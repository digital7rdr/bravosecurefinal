import {createClient} from '@supabase/supabase-js';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {SUPABASE_URL, SUPABASE_ANON_KEY} from '@utils/constants';

const url = SUPABASE_URL || 'https://placeholder.supabase.co';
const key = SUPABASE_ANON_KEY || 'placeholder-key';

export const supabase = createClient(url, key, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: false,
    persistSession: false,
    detectSessionInUrl: false,
  },
  realtime: {
    params: {
      eventsPerSecond: 10,
    },
  },
});

// Supabase Auth is no longer used — custom API owns auth via Argon2id+JWT.
// We keep the supabase-js client around only for DB (`supabase.from`), storage,
// and realtime channels (e.g. SOS broadcasts).

// ─── User helpers ─────────────────────────────────────────────────────────────

export const userService = {
  getProfile: (userId: string) =>
    supabase.from('users').select('*').eq('id', userId).single(),

  updateProfile: (userId: string, updates: Record<string, unknown>) =>
    supabase.from('users').update(updates).eq('id', userId),

};

// ─── Realtime ─────────────────────────────────────────────────────────────────
//
// FIX-14/§18 — there is deliberately NO `realtimeService` here any more.
//
// It used to export `subscribeToChannel` / `subscribeToTable` helpers that
// called `.subscribe()`. Nothing ever called them, and that was the only thing
// keeping the app on one socket: a single `.subscribe()` opens a SECOND,
// independent Phoenix WebSocket alongside the messenger transport — the exact
// duplicate-connection shape B-152 was fixed to remove and that the connection
// contract forbids ("one authenticated WebSocket").
//
// The one live realtime use is SOSScreen's `supabase.channel(...).send({type:
// 'broadcast'})`. On supabase-js 2.x an UNJOINED broadcast goes out over the
// HTTP broadcast endpoint, so it opens no socket. Keep it that way: if a
// feature genuinely needs Supabase realtime, route it through the central
// connection manager rather than re-adding a parallel subscribe helper.

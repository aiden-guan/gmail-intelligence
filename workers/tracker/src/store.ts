import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Tracking metadata store.
 * Supabase when both URL and service role key are real.
 * Otherwise an in-memory store for `wrangler dev` (cleared when the process stops).
 */

export class StoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoreError';
  }
}

export type EmailRow = {
  tracking_id: string;
  subject: string;
  sender: string;
  recipients: string[];
  gmail_thread_id: string | null;
  gmail_message_id: string | null;
  sent_at: string;
  first_opened_at: string | null;
  last_opened_at: string | null;
  open_count: number;
  first_clicked_at: string | null;
  last_clicked_at: string | null;
  click_count: number;
  created_at: string;
};

export type LinkRow = {
  click_id: string;
  tracking_id: string;
  destination: string;
};

export type EventRow = {
  id: string;
  tracking_id: string;
  type: 'OPEN' | 'CLICK';
  timestamp: string;
  user_agent: string | null;
  ip_hash: string | null;
  suspected_self_open: boolean;
  confidence: number;
  click_id?: string | null;
  destination?: string | null;
};

export interface TrackerStore {
  readonly kind: 'memory' | 'supabase';
  insertEmail(row: EmailRow): Promise<void>;
  insertLink(row: LinkRow): Promise<void>;
  getEmail(id: string): Promise<EmailRow | null>;
  listEmails(limit: number): Promise<EmailRow[]>;
  listEvents(trackingId: string): Promise<EventRow[]>;
  recentEvents(): Promise<EventRow[]>;
  insertEvent(row: EventRow): Promise<void>;
  updateEmail(id: string, patch: Partial<EmailRow>): Promise<void>;
  getLink(clickId: string): Promise<LinkRow | null>;
}

type MemoryState = {
  emails: Map<string, EmailRow>;
  links: Map<string, LinkRow>;
  events: EventRow[];
};

let memory: MemoryState | null = null;

export function resetMemoryStore(): void {
  memory = null;
}

function memoryState(): MemoryState {
  memory ??= { emails: new Map(), links: new Map(), events: [] };
  return memory;
}

function isPlaceholder(value: string | undefined): boolean {
  if (!value?.trim()) return true;
  return value.includes('YOUR_PROJECT') || value.includes('your-service-role-key');
}

export function getStore(env: {
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
}): TrackerStore {
  if (!isPlaceholder(env.SUPABASE_URL) && !isPlaceholder(env.SUPABASE_SERVICE_ROLE_KEY)) {
    return supabaseStore(env.SUPABASE_URL!.trim(), env.SUPABASE_SERVICE_ROLE_KEY!.trim());
  }
  return memoryStore();
}

function memoryStore(): TrackerStore {
  const state = memoryState();
  return {
    kind: 'memory',
    async insertEmail(row) {
      state.emails.set(row.tracking_id, { ...row });
    },
    async insertLink(row) {
      state.links.set(row.click_id, { ...row });
    },
    async getEmail(id) {
      const row = state.emails.get(id);
      return row ? { ...row, recipients: [...row.recipients] } : null;
    },
    async listEmails(limit) {
      return [...state.emails.values()]
        .sort((a, b) => (a.sent_at < b.sent_at ? 1 : -1))
        .slice(0, limit)
        .map((row) => ({ ...row, recipients: [...row.recipients] }));
    },
    async listEvents(trackingId) {
      return state.events
        .filter((event) => event.tracking_id === trackingId)
        .sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1))
        .slice(0, 200)
        .map((event) => ({ ...event }));
    },
    async recentEvents() {
      return [...state.events]
        .sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1))
        .slice(0, 50)
        .map((event) => ({ ...event }));
    },
    async insertEvent(row) {
      state.events.push({ ...row });
    },
    async updateEmail(id, patch) {
      const current = state.emails.get(id);
      if (!current) return;
      state.emails.set(id, { ...current, ...patch });
    },
    async getLink(clickId) {
      const row = state.links.get(clickId);
      return row ? { ...row } : null;
    },
  };
}

function supabaseStore(url: string, serviceRoleKey: string): TrackerStore {
  const supabase: SupabaseClient = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  return {
    kind: 'supabase',
    async insertEmail(row) {
      const { error } = await supabase.from('tracked_emails').insert(row);
      if (error) throw new StoreError(error.message);
    },
    async insertLink(row) {
      const { error } = await supabase.from('tracked_links').insert(row);
      if (error) throw new StoreError(error.message);
    },
    async getEmail(id) {
      const { data, error } = await supabase
        .from('tracked_emails')
        .select('*')
        .eq('tracking_id', id)
        .maybeSingle();
      if (error) throw new StoreError(error.message);
      return (data as EmailRow | null) ?? null;
    },
    async listEmails(limit) {
      const { data, error } = await supabase
        .from('tracked_emails')
        .select('*')
        .order('sent_at', { ascending: false })
        .limit(limit);
      if (error) throw new StoreError(error.message);
      return (data as EmailRow[] | null) ?? [];
    },
    async listEvents(trackingId) {
      const { data, error } = await supabase
        .from('tracking_events')
        .select('*')
        .eq('tracking_id', trackingId)
        .order('timestamp', { ascending: false })
        .limit(200);
      if (error) throw new StoreError(error.message);
      return (data as EventRow[] | null) ?? [];
    },
    async recentEvents() {
      const { data, error } = await supabase
        .from('tracking_events')
        .select('*')
        .order('timestamp', { ascending: false })
        .limit(50);
      if (error) throw new StoreError(error.message);
      return (data as EventRow[] | null) ?? [];
    },
    async insertEvent(row) {
      const { error } = await supabase.from('tracking_events').insert(row);
      if (error) throw new StoreError(error.message);
    },
    async updateEmail(id, patch) {
      const { error } = await supabase.from('tracked_emails').update(patch).eq('tracking_id', id);
      if (error) throw new StoreError(error.message);
    },
    async getLink(clickId) {
      const { data, error } = await supabase
        .from('tracked_links')
        .select('*')
        .eq('click_id', clickId)
        .maybeSingle();
      if (error) throw new StoreError(error.message);
      return (data as LinkRow | null) ?? null;
    },
  };
}

/**
 * MAIN-world script — minimal.
 * Never receives AI keys, tracking secrets, Supabase keys, or personal tokens.
 * Emits sanitized events only via window.postMessage.
 *
 * Gmail.js is optional: if the library is present on the page (injected separately),
 * we bind observers. Capability detection marks gmailJsCaptureAvailable accordingly.
 * Live Gmail verification was not possible in this CI/agent environment.
 */

const SOURCE = 'gi-main-world';

function emit(type: string, payload?: unknown): void {
  window.postMessage({ source: SOURCE, type, payload, ts: Date.now() }, '*');
}

type GmailJsLike = {
  observe?: {
    on?: (event: string, cb: (id?: string, url?: string, data?: unknown) => void) => void;
  };
  get?: {
    email_data?: (id: string) => unknown;
    visible_emails?: () => string[];
  };
};

function tryBindGmailJs(): boolean {
  const g = (window as unknown as { gmail?: GmailJsLike; Gmail?: unknown }).gmail;
  if (!g?.observe?.on) {
    emit('capability', { gmailJsCaptureAvailable: false });
    return false;
  }

  try {
    g.observe.on('view_thread', () => {
      emit('gmailjs_capture', { type: 'view_thread' });
    });
    g.observe.on('load', () => {
      emit('capability', { gmailJsCaptureAvailable: true });
    });
    // Best-effort new email observation — methods may break with Gmail updates
    g.observe.on('new_email', (id?: string) => {
      try {
        const data = id && g.get?.email_data ? g.get.email_data(id) : null;
        const d = data as {
          subject?: string;
          from?: string | { email?: string };
          to?: string[];
          content_plain?: string;
          content_html?: string;
          date?: string;
          thread_id?: string;
        } | null;
        emit('gmailjs_capture', {
          type: 'email_data',
          threadId: d?.thread_id || id,
          messageId: id,
          subject: d?.subject,
          bodyText: d?.content_plain || '',
          senderEmail: typeof d?.from === 'string' ? d.from : d?.from?.email,
          recipients: d?.to,
          timestamp: d?.date,
        });
      } catch {
        emit('gmailjs_capture', { type: 'new_email', messageId: id });
      }
    });
    emit('capability', { gmailJsCaptureAvailable: true });
    return true;
  } catch {
    emit('capability', { gmailJsCaptureAvailable: false });
    return false;
  }
}

emit('main_world_ready', {});
tryBindGmailJs();

// Periodic soft re-check (Gmail.js may load late)
let attempts = 0;
const timer = window.setInterval(() => {
  attempts += 1;
  if (tryBindGmailJs() || attempts > 20) {
    window.clearInterval(timer);
  }
}, 1000);

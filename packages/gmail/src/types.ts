import type { Contact, GmailActionResult, GmailCapabilities } from '@gi/shared';

export type ThreadRoute =
  | 'inbox'
  | 'sent'
  | 'drafts'
  | 'starred'
  | 'spam'
  | 'trash'
  | 'search'
  | 'custom'
  | 'unknown';

export type VisibleThreadRow = {
  threadId: string;
  subject: string;
  snippet: string;
  participants: Contact[];
  latestSender?: Contact;
  latestTimestamp?: string;
  unread: boolean;
  starred: boolean;
  labels: string[];
};

export type ThreadMessageView = {
  messageId: string;
  threadId: string;
  sender: Contact;
  recipients: Contact[];
  cc: Contact[];
  timestamp: string;
  bodyText: string;
  bodyHtml?: string;
  attachmentsMetadata: { filename: string; mimeType?: string; sizeBytes?: number }[];
};

export type CurrentThreadView = {
  threadId: string;
  subject: string;
  messages: ThreadMessageView[];
  route: ThreadRoute;
};

export type ComposeViewState = {
  composeId: string;
  to: Contact[];
  cc: Contact[];
  bcc: Contact[];
  subject: string;
  bodyText: string;
  isReply: boolean;
  threadId?: string;
};

export type MailboxEvent =
  | { type: 'inbox_observed'; rows: VisibleThreadRow[]; at: number }
  | { type: 'new_message'; row: VisibleThreadRow; at: number }
  | { type: 'thread_opened'; thread: CurrentThreadView; at: number }
  | { type: 'compose_opened'; compose: ComposeViewState; at: number }
  | { type: 'compose_sent'; compose: ComposeViewState; at: number }
  | { type: 'route_changed'; route: ThreadRoute; query?: string; at: number }
  | { type: 'capability_changed'; capabilities: GmailCapabilities; at: number };

export type MailboxEventHandler = (event: MailboxEvent) => void;

export interface GmailAdapter {
  readonly name: string;
  detectCapabilities(): Promise<GmailCapabilities>;
  start(handler: MailboxEventHandler): Promise<void>;
  stop(): Promise<void>;

  observeInbox(): Promise<GmailActionResult & { rows?: VisibleThreadRow[] }>;
  observeNewMessages(): Promise<GmailActionResult>;
  observeThreadOpened(): Promise<GmailActionResult>;
  observeCompose(): Promise<GmailActionResult>;

  getVisibleThreadMetadata(): Promise<GmailActionResult & { rows?: VisibleThreadRow[] }>;
  getCurrentThread(): Promise<GmailActionResult & { thread?: CurrentThreadView }>;
  getCurrentCompose(): Promise<GmailActionResult & { compose?: ComposeViewState }>;

  openThread(threadId: string): Promise<GmailActionResult>;
  archiveThread(threadId: string): Promise<GmailActionResult>;
  markRead(threadId: string): Promise<GmailActionResult>;
  markUnread(threadId: string): Promise<GmailActionResult>;
  starThread(threadId: string): Promise<GmailActionResult>;
  createReplyDraft(threadId: string): Promise<GmailActionResult>;
  insertComposeBody(text: string): Promise<GmailActionResult>;
  navigateToSearch(query: string): Promise<GmailActionResult>;
  navigateToInbox(): Promise<GmailActionResult>;
}

export type QueuedGmailAction =
  | { kind: 'ARCHIVE_THREAD'; threadId: string }
  | { kind: 'MARK_READ'; threadId: string }
  | { kind: 'MARK_UNREAD'; threadId: string }
  | { kind: 'STAR'; threadId: string }
  | { kind: 'OPEN_THREAD'; threadId: string }
  | { kind: 'CREATE_REPLY_DRAFT'; threadId: string }
  | { kind: 'INSERT_COMPOSE_BODY'; text: string }
  | { kind: 'NAVIGATE_SEARCH'; query: string }
  | { kind: 'NAVIGATE_INBOX' };

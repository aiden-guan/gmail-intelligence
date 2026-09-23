export const VISIBLE_COMMANDS = [
  { id: 'ask', label: 'Ask Inbox' },
  { id: 'summarize', label: 'Summarize Thread' },
  { id: 'draft', label: 'Draft Reply' },
  { id: 'remind', label: 'Remind Me' },
  { id: 'archive', label: 'Archive' },
  { id: 'settings', label: 'Settings' },
  { id: 'mark_respond', label: 'Mark Respond' },
  { id: 'mark_waiting', label: 'Mark Waiting' },
  { id: 'mark_fyi', label: 'Mark FYI' },
] as const;

export type CommandId = (typeof VISIBLE_COMMANDS)[number]['id'];

const IDS = new Set<string>(VISIBLE_COMMANDS.map((command) => command.id));

export function isVisibleCommand(id: string): id is CommandId {
  return IDS.has(id);
}

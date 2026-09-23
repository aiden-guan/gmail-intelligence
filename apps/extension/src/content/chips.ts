const LABELS: Record<string, string> = {
  RESPOND: 'Respond',
  WAITING: 'Waiting',
  FYI: 'FYI',
  NOTIFICATIONS: 'Notifications',
  PROMOTIONS: 'Promotions',
  NEWS: 'News',
};

export function categoryLabel(category: string | undefined): string {
  if (!category) return '';
  return LABELS[category] || category;
}

export function applyCategoryChip(row: HTMLElement, category: string, manual: boolean): void {
  const label = categoryLabel(category);
  if (!label) return;
  let chip = row.querySelector<HTMLElement>('.gi-cat-chip');
  if (!chip) {
    chip = document.createElement('span');
    chip.className = 'gi-cat-chip';
    chip.setAttribute('data-gi-ui', 'chip');
    const host = row.querySelector('.y6') || row.querySelector('.bog')?.parentElement || row;
    host.append(chip);
  }
  chip.dataset.category = category;
  chip.dataset.manual = manual ? '1' : '0';
  chip.textContent = manual ? `${label} ·` : label;
  chip.title = manual ? `${label}. You set this category.` : label;
}

export function rowsForThread(threadId: string, root: ParentNode = document): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('tr.zA, tr[data-legacy-thread-id], div[role="listitem"]')].filter((row) => {
    const ids = [
      row.getAttribute('data-legacy-thread-id'),
      row.getAttribute('data-thread-id'),
      row.getAttribute('data-gi-thread-id'),
    ];
    return ids.includes(threadId);
  });
}

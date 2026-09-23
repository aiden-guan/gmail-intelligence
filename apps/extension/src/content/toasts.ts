export function showToast(message: string, retry?: () => void): void {
  document.querySelector('[data-gi-ui="toast"]')?.remove();
  const toast = document.createElement('div');
  toast.setAttribute('data-gi-ui', 'toast');
  toast.style.cssText = [
    'position:fixed',
    'left:50%',
    'bottom:24px',
    'transform:translateX(-50%)',
    'z-index:2147483646',
    'background:#202124',
    'color:#fff',
    'border-radius:8px',
    'padding:10px 14px',
    'font:13px/1.4 "Google Sans",Roboto,Arial,sans-serif',
    'display:flex',
    'gap:12px',
    'align-items:center',
    'box-shadow:0 4px 16px rgba(0,0,0,.28)',
    'max-width:420px',
  ].join(';');
  const text = document.createElement('span');
  text.textContent = message;
  toast.append(text);
  if (retry) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Retry';
    button.style.cssText = 'border:0;background:transparent;color:#8ab4f8;font:inherit;cursor:pointer;padding:0';
    button.onclick = () => {
      toast.remove();
      retry();
    };
    toast.append(button);
  }
  document.documentElement.append(toast);
  window.setTimeout(() => toast.remove(), 6000);
}

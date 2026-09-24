/** Injected into Gmail. Every selector is namespaced so it cannot restyle the host page. */
export const SURFACE_CSS = `
:host {
  display: inline-block;
  width: max-content;
  max-width: calc(100vw - 24px);
  overflow: visible;
  scrollbar-width: none;
}
:host([data-gi-ui="thread-sidebar"]) {
  display: block;
  width: 100%;
  max-width: 100%;
}
#gi-thread-panel {
  position: fixed !important;
  top: 72px !important;
  right: 16px !important;
  z-index: 2147483000 !important;
  display: block !important;
  width: max-content !important;
  margin: 0 !important;
  padding: 0 !important;
  border: 0 !important;
  background: transparent !important;
  box-shadow: none !important;
  overflow: visible !important;
  scrollbar-width: none !important;
}
:host::-webkit-scrollbar,
#gi-thread-panel::-webkit-scrollbar,
.gi-shell::-webkit-scrollbar,
.gi-core::-webkit-scrollbar {
  width: 0 !important;
  height: 0 !important;
  display: none !important;
}
#gi-mount {
  all: initial;
  display: block;
  font: 13px/1.45 ui-sans-serif, system-ui, sans-serif;
  color: #f4f5f8;
  -webkit-font-smoothing: antialiased;
}
#gi-mount p { margin: 0; }

.gi-shell, .gi-pill {
  transform-origin: top right;
  transition: opacity 200ms cubic-bezier(0.23, 1, 0.32, 1), transform 200ms cubic-bezier(0.23, 1, 0.32, 1);
}
.gi-shell {
  width: 308px;
  max-height: calc(100vh - 96px);
  padding: 4px;
  border-radius: 22px;
  background: rgba(255, 255, 255, 0.06);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.1), 0 22px 50px rgba(5, 6, 12, 0.28);
  backdrop-filter: blur(18px) saturate(160%);
  -webkit-backdrop-filter: blur(18px) saturate(160%);
}
.gi-shell[data-variant="sidebar"] { width: 100%; }
.gi-shell {
  @starting-style {
    opacity: 0;
    transform: translateY(-4px) scale(0.98);
  }
}
.gi-core {
  max-height: calc(100vh - 112px);
  overflow: auto;
  border-radius: 18px;
  padding: 12px;
  background:
    radial-gradient(90% 70% at 0% 0%, rgba(139, 124, 255, 0.28), transparent 48%),
    linear-gradient(180deg, #171924 0%, #0c0d14 100%);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.16);
  scrollbar-width: none;
}
.gi-shell { overflow: hidden; scrollbar-width: none; }
.gi-bar { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.gi-brand { display: flex; align-items: center; gap: 8px; min-width: 0; }
.gi-mark {
  width: 16px;
  height: 16px;
  flex: 0 0 auto;
  border-radius: 5px;
  background: linear-gradient(160deg, #ebe7ff 0%, #8b7cff 42%, #2a2158 100%);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.75);
}
.gi-kicker {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: #c9c4ef;
}
.gi-hide {
  appearance: none;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: #b7bcc8;
  padding: 6px 8px;
  font: 600 11px/1 ui-sans-serif, system-ui, sans-serif;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  cursor: pointer;
  transition: transform 140ms cubic-bezier(0.23, 1, 0.32, 1), color 160ms ease, background 160ms ease;
}
.gi-hide:active { transform: scale(0.97); }
.gi-hide:focus-visible { outline: 2px solid #c9c2ff; outline-offset: 2px; }
.gi-icon {
  appearance: none;
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 999px;
  padding: 0;
  background: transparent;
  color: #c5c9d6;
  cursor: pointer;
  transition: transform 140ms cubic-bezier(0.23, 1, 0.32, 1), background 160ms ease, color 160ms ease;
}
.gi-icon:active { transform: scale(0.96); }
.gi-catrow { display: flex; align-items: center; gap: 8px; margin-top: 10px; }
.gi-cat {
  font-size: 16px;
  font-weight: 600;
  letter-spacing: -0.03em;
  line-height: 1.15;
  color: #f7f7fb;
}
.gi-you { color: #9aa3b8; font-size: 11px; }
.gi-sum { margin-top: 8px; color: #c9cdd8; font-size: 13px; line-height: 1.5; user-select: text; }
.gi-sum.is-wait { color: #9aa3b8; }
.gi-open { margin-top: 12px; }
.gi-open-label {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: #9aa3b8;
}
.gi-open-label.is-open { color: #d9d4ff; }
.gi-open-line { margin-top: 6px; color: #f4f5f8; font-size: 13px; line-height: 1.4; }
.gi-open-sub { margin-top: 4px; color: #9aa3b8; font-size: 12px; line-height: 1.4; }
.gi-open-count {
  margin-top: 10px;
  border-radius: 12px;
  text-align: center;
  font-weight: 600;
  font-size: 12px;
  letter-spacing: -0.01em;
  padding: 8px 10px;
  background: rgba(255, 255, 255, 0.05);
  color: #c9cdd8;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.06);
}
.gi-open-count.is-open {
  background: rgba(139, 124, 255, 0.16);
  color: #efeaff;
  box-shadow: inset 0 0 0 1px rgba(139, 124, 255, 0.32);
}
.gi-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
.gi-action {
  appearance: none;
  border: 0;
  border-radius: 999px;
  padding: 8px 12px;
  background: #f4f5f8;
  color: #12131a;
  font: 600 12px/1 ui-sans-serif, system-ui, sans-serif;
  letter-spacing: -0.01em;
  cursor: pointer;
  transition: transform 140ms cubic-bezier(0.23, 1, 0.32, 1), background 160ms ease;
}
.gi-action:active { transform: scale(0.97); }
.gi-action.is-ghost {
  background: transparent;
  color: #f4f5f8;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.14);
}
.gi-points {
  margin: 10px 0 0;
  padding: 0;
  list-style: none;
}
.gi-points li {
  position: relative;
  margin: 0;
  padding: 3px 0 3px 12px;
  color: #e6e8f0;
  font-size: 13px;
  line-height: 1.45;
}
.gi-points li::before {
  content: "";
  position: absolute;
  left: 0;
  top: 0.62em;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: #8b7cff;
}
.gi-dates { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.gi-date {
  border-radius: 999px;
  padding: 3px 8px;
  color: #efeaff;
  background: rgba(139, 124, 255, 0.16);
  font-size: 11px;
  font-weight: 600;
}
.gi-pill {
  appearance: none;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 36px;
  padding: 0 12px 0 6px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 999px;
  background: rgba(12, 13, 18, 0.9);
  color: #f4f5f8;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.16), 0 12px 32px rgba(5, 6, 12, 0.28);
  backdrop-filter: blur(16px) saturate(160%);
  -webkit-backdrop-filter: blur(16px) saturate(160%);
  cursor: pointer;
}
.gi-pill {
  @starting-style {
    opacity: 0;
    transform: translateY(-4px) scale(0.98);
  }
}
.gi-pill:active { transform: scale(0.97); }
.gi-pill .gi-mark { width: 22px; height: 22px; border-radius: 999px; }
.gi-pill-label { font-size: 12px; font-weight: 600; letter-spacing: -0.01em; }
.gi-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #8b7cff;
  box-shadow: 0 0 0 3px rgba(139, 124, 255, 0.18);
}
.gi-dot.is-quiet { background: #6d7384; box-shadow: none; }
.gi-dot.is-live { animation: gi-pulse 1.4s cubic-bezier(0.45, 0, 0.55, 1) infinite; }
@keyframes gi-pulse { 50% { opacity: 0.35; } }
.gi-pill:focus-visible, .gi-icon:focus-visible, .gi-action:focus-visible {
  outline: 2px solid #c9c2ff;
  outline-offset: 2px;
}

.gi-cmdk {
  position: absolute;
  inset: 0;
  display: flex;
  justify-content: center;
  padding-top: 14vh;
  background: rgba(7, 8, 12, 0.55);
  font: 14px/1.4 ui-sans-serif, system-ui, sans-serif;
  color: #f4f5f8;
}
.gi-cmdk-panel {
  width: min(520px, calc(100vw - 32px));
  height: max-content;
  padding: 5px;
  border-radius: 22px;
  background: rgba(255, 255, 255, 0.06);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.1), 0 30px 70px rgba(5, 6, 12, 0.4);
  backdrop-filter: blur(20px) saturate(160%);
  -webkit-backdrop-filter: blur(20px) saturate(160%);
}
.gi-cmdk-core {
  border-radius: 17px;
  overflow: hidden;
  background:
    radial-gradient(80% 80% at 0% 0%, rgba(139, 124, 255, 0.22), transparent 46%),
    #101219;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.14);
}
.gi-cmdk-input {
  width: 100%;
  border: 0;
  outline: none;
  background: transparent;
  color: #f4f5f8;
  font: 500 16px/1.3 ui-sans-serif, system-ui, sans-serif;
  letter-spacing: -0.02em;
  padding: 14px 14px 10px;
}
.gi-cmdk-input::placeholder { color: #8b919f; }
.gi-cmdk-list { max-height: 320px; overflow: auto; padding: 0 6px 4px; }
.gi-cmdk-row {
  display: flex;
  width: 100%;
  text-align: left;
  border: 0;
  border-radius: 12px;
  padding: 9px 10px;
  background: transparent;
  color: #f4f5f8;
  font: 500 14px/1.3 ui-sans-serif, system-ui, sans-serif;
  letter-spacing: -0.015em;
  cursor: pointer;
}
.gi-cmdk-row[data-active="true"] { background: rgba(139, 124, 255, 0.16); }
.gi-cmdk-row:active { transform: scale(0.99); }
.gi-cmdk-empty { padding: 12px; color: #9aa3b8; font-size: 13px; }
.gi-cmdk-foot {
  display: flex;
  gap: 14px;
  padding: 4px 12px 10px;
  color: #8b919f;
  font-size: 11px;
}
.gi-kbd {
  font-family: ui-monospace, monospace;
  font-size: 10px;
  color: #d5d8e2;
  border-radius: 5px;
  padding: 1px 4px;
  margin-right: 4px;
  background: rgba(255, 255, 255, 0.06);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.1);
}

.gi-toast-wrap {
  display: flex;
  justify-content: center;
  width: 100%;
  pointer-events: none;
}
.gi-toast {
  pointer-events: auto;
  display: flex;
  align-items: center;
  gap: 14px;
  max-width: min(420px, calc(100vw - 32px));
  padding: 10px 14px;
  border-radius: 999px;
  background: #12141c;
  color: #f4f5f8;
  border: 1px solid rgba(255, 255, 255, 0.1);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.14), 0 16px 40px rgba(5, 6, 12, 0.35);
  font: 13px/1.35 ui-sans-serif, system-ui, sans-serif;
  transition: opacity 180ms cubic-bezier(0.23, 1, 0.32, 1), transform 180ms cubic-bezier(0.23, 1, 0.32, 1);
}
.gi-toast {
  @starting-style {
    opacity: 0;
    transform: translateY(8px);
  }
}
.gi-toast-retry {
  border: 0;
  background: transparent;
  color: #d9d4ff;
  font: inherit;
  font-weight: 600;
  cursor: pointer;
  padding: 0;
}
.gi-toast-retry:active { transform: scale(0.97); }

.gi-cat-chip {
  display: inline-flex !important;
  align-items: center !important;
  margin: 0 0 0 8px !important;
  padding: 0 !important;
  border: 0 !important;
  background: transparent !important;
  color: #5c4ed0 !important;
  font: 600 11px/1 ui-sans-serif, system-ui, sans-serif !important;
  letter-spacing: -0.01em !important;
  vertical-align: middle !important;
  white-space: nowrap !important;
}
.gi-cat-chip[data-category="WAITING"] { color: #8d6b1f !important; }
.gi-cat-chip[data-category="FYI"] { color: #5f6b7a !important; }
.gi-cat-chip[data-category="NOTIFICATIONS"] { color: #3d6fbf !important; }
.gi-cat-chip[data-category="PROMOTIONS"] { color: #a14d6c !important; }
.gi-cat-chip[data-category="NEWS"] { color: #2f7a56 !important; }
.gi-cat-chip[data-category="PRIORITY"], .gi-cat-chip[data-category="FOLLOW_UPS"] { color: #8d4b16 !important; }

.gi-track-slot { display: inline-flex !important; align-items: center; margin: 0 8px 0 0; vertical-align: middle; flex: 0 0 auto; min-width: 16px; line-height: 0; overflow: visible; }
.gi-track-btn { display: inline-flex; align-items: center; gap: 4px; cursor: pointer; }
.gi-track-btn[data-state="opened"] { color: #5c4ed0 !important; }
.gi-track-btn[data-state="pending"] { color: #80868b !important; }
.gi-track-label, .gi-track-n { font: 600 12px/1 ui-sans-serif, system-ui, sans-serif; }
.gi-track-backdrop { position: fixed; inset: 0; z-index: 2147483645; background: transparent; }
.gi-track-card {
  position: fixed;
  z-index: 2147483646;
  box-sizing: border-box;
  width: 340px;
  padding: 16px 16px 12px;
  border-radius: 18px;
  background: #12141c !important;
  color: #f4f5f8 !important;
  border: 1px solid rgba(255, 255, 255, 0.1) !important;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.14), 0 24px 50px rgba(5, 6, 12, 0.4) !important;
  font: 14px/1.4 ui-sans-serif, system-ui, sans-serif !important;
}
.gi-track-headline { margin: 0; color: #f4f5f8 !important; }
.gi-track-headline strong { font-weight: 600; }
.gi-track-detail { display: flex; align-items: flex-start; gap: 8px; margin: 10px 0 0; color: #9aa3b8 !important; font-size: 13px; }
.gi-track-detail svg { flex: 0 0 auto; margin-top: 1px; }
.gi-track-count {
  margin-top: 14px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.06) !important;
  color: #c9cdd8 !important;
  text-align: center;
  font-weight: 600;
  padding: 10px 12px;
}
.gi-track-count.is-open {
  background: rgba(139, 124, 255, 0.18) !important;
  color: #efeaff !important;
  box-shadow: inset 0 0 0 1px rgba(139, 124, 255, 0.35);
}
.gi-track-warning { margin: 10px 0 0; color: #e7c27a !important; font-size: 12px; line-height: 1.4; }
.gi-track-footer {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 12px;
  padding-top: 12px;
  background-image: linear-gradient(rgba(255, 255, 255, 0.08), rgba(255, 255, 255, 0.08));
  background-size: 100% 1px;
  background-repeat: no-repeat;
}
.gi-track-notify { color: #e6e8f0 !important; font-size: 13px; }
.gi-switch {
  position: relative;
  width: 36px;
  height: 22px;
  flex: 0 0 auto;
  border: 0;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.14);
  padding: 0;
  cursor: pointer;
}
.gi-switch[aria-checked="true"] { background: #8b7cff; }
.gi-switch-knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: #fff;
  transition: transform 160ms cubic-bezier(0.23, 1, 0.32, 1);
}
.gi-switch[aria-checked="true"] .gi-switch-knob { transform: translateX(14px); }
.gi-switch:active { transform: scale(0.97); }
.gi-track-arrow {
  position: absolute;
  width: 12px;
  height: 12px;
  background: #12141c !important;
  transform: translateX(-50%) rotate(45deg);
}
.gi-track-card[data-placement="above"] .gi-track-arrow { bottom: -6px; }
.gi-track-card[data-placement="below"] .gi-track-arrow { top: -6px; }

.gi-menu {
  position: fixed;
  z-index: 2147483646;
  min-width: 196px;
  padding: 6px;
  border-radius: 16px;
  background: #12141c !important;
  color: #f4f5f8 !important;
  color-scheme: dark;
  border: 1px solid rgba(255, 255, 255, 0.1) !important;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.14), 0 18px 40px rgba(5, 6, 12, 0.35) !important;
  font: 13px/1.4 ui-sans-serif, system-ui, sans-serif !important;
}
.gi-menu-row {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 7px 8px;
  border-radius: 10px;
  cursor: pointer;
  color: #f4f5f8 !important;
}
.gi-compose-track {
  margin: 0 8px !important;
  border: 0 !important;
  border-radius: 999px !important;
  background: transparent !important;
  color: #5f6368 !important;
  font: 600 12px/1 ui-sans-serif, system-ui, sans-serif !important;
  cursor: pointer !important;
  padding: 5px 8px !important;
}
.gi-compose-track[data-on="1"] {
  color: #3c2f8f !important;
  background: rgba(139, 124, 255, 0.16) !important;
}
.gi-compose-track:active { transform: scale(0.97); }

@media (hover: hover) and (pointer: fine) {
  .gi-icon:hover, .gi-hide:hover { background: rgba(255, 255, 255, 0.06); color: #fff; }
  .gi-action.is-ghost:hover { background: rgba(255, 255, 255, 0.05); }
  .gi-cmdk-row:hover { background: rgba(255, 255, 255, 0.04); }
  .gi-cmdk-row[data-active="true"]:hover { background: rgba(139, 124, 255, 0.2); }
  .gi-menu-row:hover { background: rgba(255, 255, 255, 0.05); }
}
@media (prefers-reduced-motion: reduce) {
  .gi-shell, .gi-pill, .gi-toast, .gi-action, .gi-icon, .gi-switch-knob {
    animation: none;
    transition: opacity 120ms ease;
  }
  .gi-dot.is-live { animation: none; }
}
@media (prefers-reduced-transparency: reduce) {
  .gi-shell, .gi-pill, .gi-cmdk-panel, .gi-toast, .gi-track-card, .gi-menu {
    background: #14161e !important;
    backdrop-filter: none !important;
    -webkit-backdrop-filter: none !important;
  }
  .gi-core, .gi-cmdk-core { background: #101219; }
}
`;

export function ensureSurface(): void {
  let style = document.getElementById('gi-surface') as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement('style');
    style.id = 'gi-surface';
    document.documentElement.append(style);
  }
  if (style.textContent !== SURFACE_CSS) style.textContent = SURFACE_CSS;
}

export function shadowMount(host: HTMLElement): HTMLElement {
  let shadow = host.shadowRoot;
  if (!shadow) {
    shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.dataset.giSurface = '1';
    style.textContent = SURFACE_CSS;
    const mount = document.createElement('div');
    mount.id = 'gi-mount';
    shadow.append(style, mount);
  } else {
    const style = shadow.querySelector('style');
    if (style && style.textContent !== SURFACE_CSS) style.textContent = SURFACE_CSS;
  }
  return shadow.querySelector('#gi-mount') as HTMLElement;
}

/** Keep the floating card to the left of the thread pane's scrollbar. */
export function floatPanelRightPx(viewportWidth: number, mainRight: number, scrollbarWidth: number): number {
  const gutter = Math.max(scrollbarWidth, 16);
  return Math.max(20, Math.round(viewportWidth - mainRight + gutter + 14));
}

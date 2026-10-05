const RECOVERY_KEY = "pronto-live-update";

function controlKey(el) {
  const row = el.closest('[data-id]')?.getAttribute('data-id') ?? '';
  const form = el.closest('form');
  const owner = form?.id || form?.getAttribute('data-entity') || '';
  return el.id ? `${row}|${el.localName}#${el.id}` : el.name ? `${row}|${owner}|${el.localName}[${el.name}]` : undefined;
}

const controls = (root) => [...root.querySelectorAll('input,textarea,select')]
  .filter(el => !['password','hidden','file','submit','button','reset'].includes(el.type));

export function readUpdateRecovery(cfg, appBase) {
  try {
    const saved = JSON.parse(sessionStorage.getItem(RECOVERY_KEY));
    if (!saved || saved.appBase !== String(appBase)) return null;
    for (const [table, rows] of Object.entries(saved.rows)) {
      if (cfg.local?.[table] === 'tab' && JSON.stringify(cfg.schema?.[table]) === JSON.stringify(saved.schema?.[table])) {
        (cfg.seed ??= {})[table] = rows;
      }
    }
    return saved;
  } catch { return null; }
}

export function restoreUpdatedPage(root, saved) {
  if (!saved) return;
  const fields = controls(root);
  for (const field of saved.fields) {
    const matches = fields.filter(el => controlKey(el) === field.key);
    if (matches.length !== 1) continue;
    const el = matches[0];
    if (el.localName === 'select' && ![...el.options].some(option => option.value === field.value)) continue;
    if (['checkbox','radio'].includes(el.type)) el.checked = field.checked;
    else el.value = field.value;
    el._prontoUpdateDirty = true;
    el._prontoDirty = true;
  }
  const focus = fields.filter(el => controlKey(el) === saved.focus);
  if (focus.length === 1) {
    focus[0].focus({preventScroll:true});
    if (saved.selection && typeof focus[0].setSelectionRange === 'function') {
      try { focus[0].setSelectionRange(...saved.selection); } catch {}
    }
  }
}

export function installLiveUpdates({ cfg, appBase, store, mount, entries, ready, recovery, configUrl }) {
  const dirty = new WeakSet();
  let edits = 0;
  for (const type of ['input','change','click']) mount.addEventListener(type, event => {
    edits++;
    if (type !== 'click') dirty.add(event.target);
  }, true);
  // A deployment need not change the worker or cause another navigation.
  // Revalidate loaded assets while the reader is active; HTTP validators avoid
  // transferring unchanged files, and the worker announces any replacement.
  let checking = false;
  const discover = async () => {
    if (checking || document.visibilityState === 'hidden') return;
    checking = true;
    try {
      const assets = new Set([String(configUrl)]);
      for (const entry of entries()) for (const file of Object.values(entry.route.files ?? {}).flat()) assets.add(new URL(file, appBase).href);
      for (const resource of performance.getEntriesByType('resource')) {
        const url = new URL(resource.name);
        if (url.origin === location.origin && (url.pathname.startsWith('/shell/') || url.pathname.startsWith('/omnishell/'))) assets.add(url.href);
      }
      await Promise.allSettled([...assets].map(url => fetch(url, {cache:'no-cache'})));
    } finally { checking = false; }
  };
  setInterval(discover, 60000);
  window.addEventListener('focus', discover);
  document.addEventListener('visibilitychange', discover);
  let pending = false;
  const blocked = () => {
    const typing = document.activeElement?.matches('textarea,input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]),[contenteditable=true]');
    const sending = mount.querySelector('[data-submitting],[data-pending="true"],[data-state="sending"],[data-state="form-submit"]');
    const files = [...mount.querySelectorAll('input[type=file]')].some(el => el.files?.length);
    return !ready() || typing || sending || files;
  };
  const attempt = async () => {
    if (blocked()) {
      setTimeout(attempt, 500);
      return;
    }
    const revision = edits;
    try {
      const rows = {};
      for (const table of Object.keys(cfg.local ?? {}).filter(table => cfg.local[table] === 'tab')) rows[table] = await store.query(table);
      // Reads may yield to another gesture. Never cross a newly started edit.
      if (blocked() || edits !== revision) {
        setTimeout(attempt, 500);
        return;
      }
      const pages = {...recovery?.pages};
      for (const entry of entries()) {
        const fields = controls(entry.el);
        const focused = document.activeElement;
        pages[entry.key] = {
          fields: fields.filter(el => (dirty.has(el) || el._prontoUpdateDirty) && controlKey(el)).map(el => ({key:controlKey(el),value:el.value,checked:el.checked})),
          focus: fields.includes(focused) ? controlKey(focused) : undefined,
          selection: fields.includes(focused) && typeof focused.selectionStart === 'number' ? [focused.selectionStart,focused.selectionEnd,focused.selectionDirection] : undefined,
          scrollY: entry.el.hidden ? entry.scrollY : window.scrollY,
        };
      }
      sessionStorage.setItem(RECOVERY_KEY, JSON.stringify({appBase:String(appBase),schema:cfg.schema,rows,pages}));
      location.reload();
    } catch (error) {
      // Do not destroy drafts when recovery cannot be saved.
      pending = false;
      console.error('Could not safely apply updated app files', error);
    }
  };
  navigator.serviceWorker?.addEventListener('message', event => {
    if (!['PRONTO_ASSETS_UPDATED','PRONTO_SKELETON_UPDATED','PRONTO_STYLE_UPDATED'].includes(event.data?.type)) return;
    if (pending) return;
    pending = true;
    setTimeout(attempt, 250);
  });
}

export function clearUpdateRecovery() {
  sessionStorage.removeItem(RECOVERY_KEY);
}

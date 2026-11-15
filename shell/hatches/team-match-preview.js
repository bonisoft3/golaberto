export default function mount(screen, { signal }) {
  let active = null;
  let dismissed = null;
  let pointer;
  let dismissal;
  let observer;
  const window = screen.ownerDocument.defaultView;
  const dismissalDelay = Number.parseFloat(window.getComputedStyle(screen).getPropertyValue('--motion-base'));
  const cellFor = (node) => node instanceof Element ? node.closest('td[data-team-match-preview]') : null;
  const buttonFor = (cell) => cell.querySelector('.team-match-preview-toggle');
  const cancelDismissal = () => { window.clearTimeout(dismissal); dismissal = undefined; };
  const buttonState = (cell, expanded, pinned = false) => {
    const button = buttonFor(cell);
    if (!button) return;
    button.setAttribute('aria-expanded', String(expanded));
    button.setAttribute('aria-pressed', String(pinned));
    button.title = pinned ? button.dataset.previewUnpin : button.dataset.previewPin;
  };
  const close = () => {
    cancelDismissal();
    const current = active;
    active = null;
    if (!current) return;
    buttonState(current.cell, false);
    if (current.popover.isConnected && current.popover.matches(':popover-open')) current.popover.hidePopover();
  };
  const cleanup = () => { observer?.disconnect(); close(); dismissed = null; };
  signal.addEventListener('abort', cleanup, { once: true });
  const position = (entry, mode) => {
    const { cell, popover } = entry;
    popover.style.inlineSize = '';
    const style = window.getComputedStyle(popover);
    const margin = Number.parseFloat(style.getPropertyValue('--sp-md'));
    const minimum = 2 * Number.parseFloat(style.getPropertyValue('--measure-side'));
    const bounds = cell.getBoundingClientRect();
    let width = popover.getBoundingClientRect().width;
    let left;
    let overlaps = false;
    const rightSpace = window.innerWidth - margin - bounds.right;
    const leftSpace = bounds.left - margin;
    if (mode === 'hover') {
      left = pointer.x + margin;
      if (left + width > window.innerWidth - margin) left = pointer.x - margin - width;
      left = Math.max(margin, Math.min(left, window.innerWidth - margin - width));
    } else if (rightSpace >= Math.min(minimum, width)) {
      width = Math.min(width, rightSpace);
      left = bounds.right;
    } else if (leftSpace >= Math.min(minimum, width)) {
      width = Math.min(width, leftSpace);
      left = bounds.left - width;
    } else {
      left = Math.max(margin, Math.min(bounds.left, window.innerWidth - margin - width));
      overlaps = true;
    }
    popover.style.inlineSize = `${width}px`;
    const height = popover.getBoundingClientRect().height;
    const preferredTop = mode === 'hover'
      ? (pointer.y + margin + height <= window.innerHeight - margin ? pointer.y + margin : pointer.y - margin - height)
      : overlaps
        ? (window.innerHeight - margin - bounds.bottom >= height ? bounds.bottom : bounds.top - height)
        : bounds.top;
    const top = Math.max(margin, Math.min(preferredTop, window.innerHeight - margin - height));
    Object.assign(popover.style, { inset: 'auto', margin: '0', left: `${left}px`, top: `${top}px` });
    entry.anchor = bounds;
    entry.mode = mode === 'hover' ? 'hover-passive' : mode;
    popover.dataset.previewMode = entry.mode;
  };
  const show = (cell, mode) => {
    if (!cell || !screen.contains(cell) || (mode === 'hover' && cell === dismissed)) return;
    cancelDismissal();
    if (active?.cell === cell) {
      if (mode !== 'hover' && active.mode !== 'pinned') {
        active.mode = mode;
        active.popover.dataset.previewMode = mode;
        buttonState(cell, true, mode === 'pinned');
      }
      return;
    }
    close();
    if (mode !== 'hover') dismissed = null;
    const popover = cell.querySelector('.team-match-preview');
    active = { cell, popover, mode };
    popover.dataset.previewMode = mode === 'hover' ? 'hover-passive' : mode;
    if (!popover.matches(':popover-open')) popover.showPopover();
    position(active, mode);
    buttonState(cell, true, mode === 'pinned');
  };
  screen.addEventListener('pointerover', (event) => {
    if (event.pointerType === 'touch') return;
    pointer = { x: event.clientX, y: event.clientY };
    if (active && ['pinned', 'focused'].includes(active.mode)) return;
    show(cellFor(event.target), 'hover');
  }, { signal });
  screen.addEventListener('pointermove', (event) => {
    if (event.pointerType === 'touch') return;
    pointer = { x: event.clientX, y: event.clientY };
    if (active?.mode === 'hover-passive' && cellFor(event.target) === active.cell) position(active, 'hover');
  }, { signal });
  screen.addEventListener('pointerout', (event) => {
    if (event.pointerType === 'touch') return;
    const cell = cellFor(event.target);
    if (!cell || (event.relatedTarget instanceof Node && cell.contains(event.relatedTarget))) return;
    if (dismissed === cell) dismissed = null;
    if (active?.cell !== cell || ['pinned', 'focused'].includes(active.mode)) return;
    cancelDismissal();
    dismissal = window.setTimeout(() => {
      if (active?.cell === cell && !cell.contains(screen.ownerDocument.activeElement)) close();
    }, dismissalDelay);
  }, { signal });
  screen.addEventListener('focusin', (event) => {
    if (event.target.matches(':focus-visible')) show(cellFor(event.target), 'focused');
  }, { signal });
  screen.addEventListener('focusout', (event) => {
    const cell = cellFor(event.target);
    if (!cell || (event.relatedTarget instanceof Node && cell.contains(event.relatedTarget))) return;
    if (dismissed === cell) dismissed = null;
    if (active?.cell !== cell || active.mode === 'pinned') return;
    if (!cell.matches(':hover')) close();
    else if (active.mode === 'focused') {
      position(active, 'hover');
    }
  }, { signal });
  screen.addEventListener('click', (event) => {
    if (!event.target.closest('.team-match-preview-toggle')) return;
    event.preventDefault();
    const cell = cellFor(event.target);
    if (active?.cell === cell && active.mode === 'pinned') { close(); dismissed = cell.matches(':hover') ? cell : null; }
    else show(cell, 'pinned');
  }, { signal });
  screen.addEventListener('toggle', (event) => {
    if (!event.target.matches('.team-match-preview')) return;
    const cell = cellFor(event.target);
    if (!cell) return;
    if (event.newState === 'open') {
      if (active?.popover !== event.target) show(cell, 'pinned');
    } else if (active?.popover === event.target) {
      cancelDismissal();
      buttonState(cell, false);
      dismissed = cell.matches(':hover') ? cell : null;
      active = null;
    }
  }, { capture: true, signal });
  window.addEventListener('scroll', (event) => {
    if (active && !(event.target instanceof Node && active.popover.contains(event.target))) close();
  }, { capture: true, signal });
  window.addEventListener('resize', close, { signal });
  observer = new MutationObserver(() => {
    if (!active) return;
    const bounds = active.cell.getBoundingClientRect();
    if (!active.cell.isConnected || !active.popover.isConnected ||
        ['top', 'left', 'right', 'bottom'].some(edge => bounds[edge] !== active.anchor[edge])) close();
  });
  observer.observe(screen, { childList: true, subtree: true });
  const opened = screen.querySelector('.team-match-preview:popover-open');
  if (opened) show(cellFor(opened), 'pinned');
  return cleanup;
}

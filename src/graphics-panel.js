// Settings panel (Graphics section): quality preset, render scale, one
// override per effect, adaptive resolution and the frame-rate readout.
// Changes apply immediately (graphics.set → renderers re-apply) and persist.

import { PRESETS, CATEGORIES, presetTier, describe, pixelRatio } from './gfx.js';
import { graphics } from './gfx-settings.js';
import { strings } from './gfx-i18n.js';

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) node.setAttribute(k, v === true ? '' : v);
  }
  node.append(...children);
  return node;
}

/** The Settings button used on menus and tables. */
export function settingsButton(extraClass = '') {
  const t = strings();
  return el('button', {
    type: 'button',
    class: `settings-btn ${extraClass}`.trim(),
    'data-action': 'open-settings',
    'aria-haspopup': 'dialog',
    'aria-label': t.openSettings,
    title: t.settings,
    onclick: (e) => { e.stopPropagation(); openSettings(e.currentTarget); },
  }, el('span', { class: 'settings-icon', 'aria-hidden': 'true', text: '⚙' }),
  el('span', { class: 'settings-label', text: t.settings }));
}

let openPanel = null;

export function openSettings(opener) {
  if (openPanel) return openPanel;
  const t = strings();
  const tierName = (tier) => t[`tier_${tier}`] || tier;
  const presetName = (p) => t[`preset_${p}`] || p;

  const presetSel = el('select', { id: 'gfx-preset', 'data-gfx': 'preset' });
  const scale = el('input', {
    id: 'gfx-scale', type: 'range', min: '50', max: '200', step: '10', 'data-gfx': 'render_scale',
  });
  const scaleOut = el('output', { class: 'gfx-scale-value', for: 'gfx-scale' });
  const catSelects = {};
  const adaptive = el('input', { id: 'gfx-adaptive', type: 'checkbox', 'data-gfx': 'adaptive' });
  const fps = el('input', { id: 'gfx-fps', type: 'checkbox', 'data-gfx': 'show_fps' });
  const summary = el('p', { id: 'gfx-summary', class: 'gfx-summary', 'aria-live': 'polite' });
  const note = el('p', { id: 'gfx-post-note', class: 'gfx-note', hidden: true, text: t.postFailed });

  const rows = [];
  for (const cat of Object.keys(CATEGORIES)) {
    const sel = el('select', { id: `gfx-cat-${cat}`, 'data-gfx': cat });
    sel.addEventListener('change', () => graphics.set({ [cat]: sel.value }));
    catSelects[cat] = sel;
    rows.push(el('label', { class: 'gfx-row', for: sel.id },
      el('span', { class: 'gfx-label', text: t[`cat_${cat}`] || cat }), sel));
  }

  presetSel.addEventListener('change', () => graphics.setPreset(presetSel.value));
  scale.addEventListener('input', () => {
    scaleOut.textContent = `${scale.value}%`;
    graphics.set({ render_scale: Number(scale.value) / 100 });
  });
  adaptive.addEventListener('change', () => graphics.set({ adaptive: adaptive.checked }));
  fps.addEventListener('change', () => graphics.set({ show_fps: fps.checked }));

  const closeBtn = el('button', {
    type: 'button', class: 'gfx-close', 'data-action': 'close-settings', 'aria-label': t.close, text: '✕',
  });
  const dialog = el('div', {
    class: 'settings-panel', id: 'settings-panel', role: 'dialog', 'aria-modal': 'true',
    'aria-labelledby': 'settings-title',
  },
  el('div', { class: 'settings-head' },
    el('h2', { id: 'settings-title', text: t.settings }), closeBtn),
  el('section', { class: 'settings-section', 'data-section': 'graphics', 'aria-labelledby': 'gfx-heading' },
    el('h3', { id: 'gfx-heading', text: t.graphics }),
    el('label', { class: 'gfx-row', for: 'gfx-preset' },
      el('span', { class: 'gfx-label', text: t.quality }), presetSel),
    el('label', { class: 'gfx-row', for: 'gfx-scale' },
      el('span', { class: 'gfx-label', text: t.renderScale }),
      el('span', { class: 'gfx-scale' }, scale, scaleOut)),
    ...rows,
    el('label', { class: 'gfx-row gfx-check', for: 'gfx-adaptive', title: t.adaptiveHint },
      el('span', { class: 'gfx-label', text: t.adaptive }), adaptive),
    el('label', { class: 'gfx-row gfx-check', for: 'gfx-fps' },
      el('span', { class: 'gfx-label', text: t.showFps }), fps),
    summary, note));
  const backdrop = el('div', { class: 'settings-backdrop' }, dialog);

  const refresh = () => {
    const saved = graphics.saved;
    const r = graphics.resolved;
    presetSel.textContent = '';
    presetSel.append(el('option', { value: 'auto', text: t.auto(presetName(graphics.detected)) }));
    for (const p of PRESETS) presetSel.append(el('option', { value: p, text: presetName(p) }));
    presetSel.value = PRESETS.includes(saved.preset) ? saved.preset : 'auto';
    const pct = Math.round(r.userScale * 100);
    scale.value = String(pct);
    scaleOut.textContent = `${pct}%`;
    for (const [cat, tiers] of Object.entries(CATEGORIES)) {
      const sel = catSelects[cat];
      sel.textContent = '';
      sel.append(el('option', { value: 'preset', text: t.fromPreset(tierName(presetTier(r.preset, cat))) }));
      for (const tier of tiers) sel.append(el('option', { value: tier, text: tierName(tier) }));
      sel.value = tiers.includes(saved[cat]) ? saved[cat] : 'preset';
    }
    adaptive.checked = r.adaptive;
    fps.checked = r.showFps;
    refreshSummary();
  };
  const refreshSummary = () => {
    const r = graphics.resolved;
    const view = graphics.view;
    const px = view && view.size && view.size[0] ? view.pixels()
      : [Math.round(innerWidth * pixelRatio(r, devicePixelRatio || 1)), Math.round(innerHeight * pixelRatio(r, devicePixelRatio || 1))];
    summary.textContent = `${graphics.gpu || t.unknownGpu} · ${describe(r, px, t)}`;
    note.hidden = !(view && view.postFailed);
  };
  refresh();
  // Pixel size / post status settle a frame after a change.
  const unsub = graphics.subscribe(() => { refresh(); requestAnimationFrame(refreshSummary); });
  const poll = setInterval(refreshSummary, 1000);

  const focusables = () => [...dialog.querySelectorAll('button, select, input')].filter((n) => !n.disabled);
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key === 'Tab') {
      const f = focusables();
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    e.stopPropagation(); // keep menu shortcuts (intro skip etc.) out of the panel
  };
  function close() {
    unsub();
    clearInterval(poll);
    backdrop.removeEventListener('keydown', onKey);
    backdrop.remove();
    openPanel = null;
    if (opener && opener.isConnected) opener.focus();
  }
  closeBtn.addEventListener('click', close);
  backdrop.addEventListener('pointerdown', (e) => { e.stopPropagation(); if (e.target === backdrop) close(); });
  backdrop.addEventListener('keydown', onKey);
  document.body.append(backdrop);
  presetSel.focus();
  openPanel = { close, element: dialog };
  return openPanel;
}

export function closeSettings() {
  if (openPanel) openPanel.close();
}

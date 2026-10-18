// Graphics benchmark hook for tools/gfx-bench.mjs (dev-only): picks a preset in the menu's Settings →
// Graphics, takes the primary Play button to the offline 3D table against the AI and keeps playing hands
// through the visible action bar (check, call small bets, fold big ones; New match when one ends) — cards
// are dealt and flipped, chips stack and slide to the pot, the lounge backdrop and motes animate.
export const presets = ['low', 'balanced', 'high', 'ultra'];
export const levels = { low: 0, balanced: 4, high: 10, ultra: 17 };

export async function setPreset(page, preset) {
  await page.waitForSelector('.main-menu [data-action="open-settings"]', { timeout: 30000 });
  await page.click('.main-menu [data-action="open-settings"]');
  await page.waitForSelector('#settings-panel');
  await page.locator('#gfx-preset').scrollIntoViewIfNeeded();
  await page.selectOption('#gfx-preset', preset);
  await page.waitForFunction((p) => document.body.dataset.gfxPreset === p, preset);
  await page.click('#settings-panel [data-action="close-settings"]');
  await page.waitForSelector('#settings-panel', { state: 'detached' });
}

const btn = (page, re) => page.locator('.action-bar .action-buttons button', { hasText: re }).first();

async function act(page) {
  if (await page.locator('.match-result').count()) {
    await page.locator('.table-screen button', { hasText: 'New match' }).click({ timeout: 2000 });
    return;
  }
  const t = await page.evaluate(() => {
    const fold = document.querySelector('.action-bar button');
    const b = [...document.querySelectorAll('.action-bar .action-buttons button')].find((x) => /^Check|^Call/.test(x.textContent.trim()));
    return { mine: fold ? !fold.disabled : false, cc: b ? b.textContent.trim() : '' };
  });
  if (!t.mine) return;
  if (t.cc === 'Check') return btn(page, 'Check').click({ timeout: 2000 });
  const amount = parseInt((t.cc.match(/Call\s+([\d,]+)/) || [])[1]?.replace(/,/g, ''), 10) || 0;
  if (amount > 0 && amount <= 800) return btn(page, /^Call/).click({ timeout: 2000 });
  return btn(page, 'Fold').click({ timeout: 2000 });
}

export async function start(page) {
  await page.locator('.menu-actions button.primary').click();
  await page.waitForSelector('.table-stage.has-3d canvas', { timeout: 20000 });
  await page.waitForFunction(() => /Hand #\d+/.test(document.querySelector('.table-status')?.textContent || ''), null, { timeout: 20000 });
  let open = true;
  page.once('close', () => { open = false; });
  (async () => {
    while (open) {
      try { await act(page); } catch (e) { if (!open) return; if (process.env.BENCH_DEBUG) console.error(e.message); }
      await page.waitForTimeout(500).catch(() => {});
    }
  })();
  await page.waitForTimeout(1500);
}

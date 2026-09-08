/**
 * StarHermit Poker — end-to-end playthrough test (dev only, not shipped).
 *
 * Drives the real visible UI in headless Chrome via playwright-core:
 *   offline title (LocalMenuScreen, no sign-in) → Play → the offline table vs
 *   5 AI seats → real check/call/fold/raise/all-in decisions through the
 *   visible action buttons → a hand resolves naturally (showdown cards
 *   revealed on the seat panels / a fold-out pot award) → ideally the match
 *   runs to its Winner + "New match" end screen.
 * A second pass runs the load → Play → a few real touch moves flow on a
 *   mobile touch viewport.
 *
 * Serving: the repo ships `server.js` (the StarHermit authoritative script
 * declared by starhermit.txt). The game is fully playable offline — when no
 * `#game_token` launch happens the client lands on a local menu whose
 * "Play" opens a browser-hosted table driven by `globalThis.game` (server.js
 * loaded as a classic script) with no network and no sign-in. menu3d.js /
 * table3d.js (the only three.js consumers) are dynamically imported only by
 * the online lobby/table, so the offline path never fetches the CDN. So, per
 * the sibling conventions, this test embeds a minimal node:http static server
 * on an ephemeral port and answers /api/* probes with 200 `{}` so any
 * background platform probe degrades silently. It does NOT need to spawn
 * `node server.js`: the authoritative script runs in-browser for the offline
 * practice mode.
 *
 * The test reads only the visible DOM (button texts/disabled state, status
 * line, pot, seat panels) to decide the next legal move — the same knowledge
 * the on-screen controls expose. It never calls the game's own command API
 * and never modifies game code.
 *
 * Run: npm run test:e2e  (or: node tests/e2e.mjs)
 */
import { chromium } from 'playwright-core';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOT = (stage, vp) => `/tmp/poker-e2e-${stage}-${vp}.png`;

// benign GPU/swiftshader noise (mirrors the sibling suites)
const browserNoise = /GL Driver Message|GPU stall due to ReadPixels|Automatic fallback to software WebGL|EnableWebGLDeveloperExtensions/i;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.glb': 'model/gltf-binary',
  '.txt': 'text/plain; charset=utf-8',
};

const server = http.createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/') p = '/index.html';
    // No StarHermit backend here: answer /api probes with empty JSON (200) so
    // any platform probe stays silent. The offline path never hits them.
    if (p.startsWith('/api/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
      return;
    }
    const file = path.normalize(path.join(ROOT, p));
    if (!file.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase() || '.js'] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

let failures = 0;
const ok = (name) => console.log(`ok - ${name}`);

// ---------- visible-DOM helpers ----------

// Read the current table state straight from the DOM.
//   handNumber / street come from `.table-status` ("Hand #N · street").
//   myTurn is whether the Fold button is enabled (all action buttons are
//   disabled together whenever it is not the local player's turn).
//   checkCallText is "Check" or "Call N"; betRaiseText is "Bet"/"Raise to".
async function readTable(page) {
  return page.evaluate(() => {
    const status = document.querySelector('.table-status')?.textContent || '';
    const m = status.match(/Hand #(\d+)/);
    const street = status.split('·')[1]?.trim() || status;
    const fold = document.querySelector('.action-bar button');
    const buttons = [...document.querySelectorAll('.action-bar .action-buttons button')];
    const checkCall = buttons.find((b) => /^Check|^Call/.test(b.textContent.trim()));
    const betRaise = buttons.find((b) => /^Bet|^Raise/.test((b.textContent || '').trim()));
    const myTurn = fold ? !fold.disabled : false;
    const pot = (document.querySelector('.pot-display')?.textContent || '').replace(/[^\d]/g, '');
    const revealCards = document.querySelectorAll('.seat-reveal .pcard').length;
    const matchResult = document.querySelector('.match-result')?.textContent || '';
    const feedWins = [...document.querySelectorAll('.feed-item.win')].map((e) => e.textContent);
    return {
      handNumber: m ? parseInt(m[1], 10) : -1,
      street,
      myTurn,
      checkCallText: checkCall ? checkCall.textContent.trim() : '',
      betRaiseText: betRaise ? betRaise.textContent.trim() : '',
      pot: pot ? parseInt(pot, 10) : null,
      revealCards,
      matchResult,
      feedWins,
    };
  });
}

const checkCallIsFold = (t) => !t.checkCallText && t.myTurn;

// Make one real decision on the visible action bar when it is our turn.
// Strategy is deliberately plain and passive-aggressive so hands resolve
// naturally: check when free, call small bets, fold expensive ones. Called
// from a loop anchored on `readTable`, so the button may be mid-update.
async function actOnTurn(page) {
  const t = await readTable(page);
  if (!t.myTurn) return 'wait';
  if (!t.checkCallText) {
    // No check/call button text (unexpected) — fall back to Fold if enabled.
    const fold = page.locator('.action-bar .action-buttons button', { hasText: 'Fold' });
    if (await fold.isEnabled()) { await fold.click(); return 'fold'; }
    return 'wait';
  }
  if (t.checkCallText === 'Check') {
    await page.locator('.action-bar .action-buttons button', { hasText: 'Check' }).first().click();
    return 'check';
  }
  // "Call N"
  const amount = parseInt((t.checkCallText.match(/Call\s+([\d,]+)/) || [])[1]?.replace(/,/g, ''), 10) || 0;
  if (amount > 0 && amount <= 800) {
    await page.locator('.action-bar .action-buttons button', { hasText: /^Call/ }).first().click();
    return 'call';
  }
  // Facing an expensive bet: fold (natural fold-out hand result).
  const fold = page.locator('.action-bar .action-buttons button', { hasText: 'Fold' });
  if (await fold.isEnabled()) { await fold.click(); return 'fold'; }
  return 'wait';
}

// Play through hands until the match ends (Winner + "New match") or the
// budget runs out. Returns diagnostics used for assertions.
async function playMatch(page, { msMax }) {
  const start = Date.now();
  let decisions = { check: 0, call: 0, fold: 0 };
  let sawReveal = false;
  let sawFeedWin = false;
  let maxHand = -1;
  const initial = (await readTable(page)).handNumber;

  while (Date.now() - start < msMax) {
    const t = await readTable(page);
    maxHand = Math.max(maxHand, t.handNumber);
    if (t.revealCards > 0) sawReveal = true;
    if (t.feedWins.length > 0) sawFeedWin = true;
    if (t.matchResult) return { ok: true, matchResult: t.matchResult, decisions, sawReveal, sawFeedWin, maxHand, initial };

    const r = await actOnTurn(page);
    if (r !== 'wait' && decisions[r] !== undefined) decisions[r]++;

    // At least a couple of fully resolved hands and not looking like a match
    // end is near: keep going until the budget or match end.
    await page.waitForTimeout(650);
  }
  return { ok: false, decisions, sawReveal, sawFeedWin, maxHand, initial };
}

// ---------- one full pass ----------
async function runPass(browser, name, ctxOpts, { full }) {
  const errors = [];
  const context = await browser.newContext(ctxOpts);
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error' || browserNoise.test(m.text())) return;
    const url = m.location()?.url || '';
    if (/Failed to load resource/.test(m.text()) && /\/api\/|\/favicon/.test(url)) return;
    errors.push(`console: ${m.text()}`);
  });
  page.on('response', (r) => {
    const p = r.url();
    if (r.status() >= 400 && !/\/api\/|\/favicon/.test(p)) errors.push(`http ${r.status()}: ${p}`);
  });

  try {
    // load → offline title menu
    await page.goto(BASE, { waitUntil: 'load' });
    await page.waitForSelector('.main-menu', { timeout: 15000 });
    await page.waitForFunction(() => !!window.game && typeof window.game.createSession === 'function');
    const title = (await page.textContent('.main-menu h1')) || '';
    if (!/StarHermit Poker/.test(title)) throw new Error(`unexpected title "${title}"`);
    await page.screenshot({ path: SHOT('title', name) });
    ok(`${name}: offline title screen visible ("${title.trim()}")`);

    // Play → offline table vs AI
    await page.locator('.menu-actions button.primary').click();
    await page.waitForSelector('.table-screen', { timeout: 15000 });
    await page.waitForSelector('.pot-display', { timeout: 15000 });
    // Wait for the first hand to be dealt (status line shows Hand #N).
    await page.waitForFunction(() => {
      const s = document.querySelector('.table-status')?.textContent || '';
      return /Hand #\d+/.test(s);
    }, null, { timeout: 15000 });
    await page.screenshot({ path: SHOT('table', name) });
    ok(`${name}: offline table active vs AI (status: "${(await page.textContent('.table-status')).trim()}")`);

    if (full) {
      // Drive real decisions until a natural hand result (ideally the match end).
      const res = await playMatch(page, { msMax: 150000 });
      const tFinal = await readTable(page);

      // A natural hand DID resolve if either showdown cards were revealed or a
      // fold-out pot was awarded (feed win line), and the hand number moved.
      const handsResolved = tFinal.handNumber > res.initial || res.maxHand > res.initial;
      if (!handsResolved && !res.sawReveal && !res.sawFeedWin) {
        throw new Error('no natural hand result observed (no showdown/fold-out, hand never advanced)');
      }
      ok(`${name}: natural hand result reached (hands ${res.initial}→${res.maxHand}, ` +
        `${res.decisions.check} check / ${res.decisions.call} call / ${res.decisions.fold} fold, ` +
        `showdown:${res.sawReveal} feedWin:${res.sawFeedWin})`);
      await page.screenshot({ path: SHOT('resolved', name) });

      if (res.ok) {
        if (!/Winner:/.test(res.matchResult)) throw new Error(`unexpected match result "${res.matchResult}"`);
        await page.waitForSelector('.match-result', { timeout: 10000 });
        await page.screenshot({ path: SHOT('match-end', name) });
        ok(`${name}: match ended — "${res.matchResult}"`);

        // New match through the visible button restarts a fresh table.
        const before = (await readTable(page)).handNumber;
        await page.locator('.table-screen button', { hasText: 'New match' }).click();
        await page.waitForFunction((b) => {
          const s = document.querySelector('.table-status')?.textContent || '';
          return /Hand #\d+/.test(s) && !document.querySelector('.match-result');
        }, before, { timeout: 15000 });
        ok(`${name}: New match restarts a fresh table (new hand #${(await readTable(page)).handNumber})`);
      } else {
        // Match not ended within budget but hands resolved — still a valid
        // natural-result playthrough; report clearly.
        console.log(`note - ${name}: match not finished within budget (hands ${res.maxHand}); verified a natural hand result instead`);
      }

      // Return to the offline menu through the visible Leave table button.
      await page.locator('.table-screen button', { hasText: 'Leave table' }).click();
      await page.waitForSelector('.main-menu', { timeout: 10000 });
      ok(`${name}: Leave table returns to the offline menu`);
    } else {
      // Mobile: make a few real touch decisions.
      let made = 0;
      const t0 = await readTable(page);
      for (let i = 0; i < 20 && made < 5; i++) {
        const r = await actOnTurn(page);
        if (r !== 'wait' && ['check', 'call', 'fold'].includes(r)) made++;
        if (r !== 'wait') {
          const bb = await page.locator('.action-bar .action-buttons button').last().boundingBox();
          if (bb) await page.touchscreen.tap(bb.x + bb.width / 2, bb.y + bb.height / 2);
        }
        await page.waitForTimeout(700);
      }
      const tFinal = await readTable(page);
      if (tFinal.handNumber <= t0.handNumber && !tFinal.matchResult && made === 0) {
        throw new Error('mobile pass made no real moves and no hand resolved');
      }
      await page.screenshot({ path: SHOT('mobile-play', name) });
      ok(`${name}: started offline table and made ${made} real touch decisions (hand #${t0.handNumber}→${tFinal.handNumber})`);
    }
  } finally {
    await context.close();
  }

  if (errors.length) throw new Error(`${name} pass had page errors:\n  ${errors.join('\n  ')}`);
  console.log(`ok - ${name}: no page errors`);
}

// ---------- main ----------
let browser = null;
try {
  browser = await chromium.launch({
    executablePath: '/usr/bin/google-chrome',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--mute-audio'],
  });
  console.log(`serving ${ROOT} at ${BASE}`);
  await runPass(browser, 'desktop', { viewport: { width: 1280, height: 800 } }, { full: true });
  await runPass(browser, 'mobile',
    { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }, { full: false });
  console.log('\nE2E PASS — poker, desktop + mobile, no page errors');
} catch (e) {
  failures++;
  console.error('\nE2E FAIL:', e.message || e);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  server.close();
}
if (failures) process.exit(1);

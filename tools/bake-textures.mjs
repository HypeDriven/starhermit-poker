// Bakes the browser build's procedural canvas textures (src/table3d.js and
// src/menu3d.js before the engine port: cardCanvas, labelTexture,
// backdropTexture, radialTexture, noiseTexture, feltTexture, chipFaceTexture,
// chipSideTexture and the menu's holo cardTexture) into assets/textures/ by
// running that canvas code unchanged in Chrome (~/games/tools/gpu-chrome.mjs).
// Their fibre strokes, per-pixel noise, blur filters and Georgia glyphs paint
// far too slowly on the engine's canvas at start-up (and the filter does not
// exist there), so the engine client loads these images instead:
//   cards/<px>/<c>.webp  card c's face (0–51: rank c % 13, suit c / 13) and the
//                        back (back.webp), px × px·356/256, per preset card
//                        budget (Low 128, Balanced/High 256, Ultra 512); one
//                        image a card, loaded when a card first shows, as the
//                        old renderer made a canvas a card on demand
//   felt-<px>.webp       the printed baize (Table detail: Detailed), per felt budget
//   felt-bump-<px>.webp  the baize's fibre bump (half the felt budget)
//   grain.png            the leather rail's grain bump
//   label.png            the STARHERMIT felt print
//   backdrop.webp        the stage's backdrop gradient
//   pool.png             the warm spill-light pool on the carpet
//   chips-<px>.png       the five chip faces in a row (Low 64, Balanced/High 128, Ultra 256)
//   chip-sides.png       the five chip edge stripes, 256 × 8 each, stacked
//   holo-cards.webp      the menu's 52 holographic cards (13 ranks × 4 suits, 128 × 180 each)
// Run once; commit the images.   node tools/bake-textures.mjs
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
function findPlaywright() {
  const roots = [root, resolve(root, '..'), ...readdirSync(resolve(root, '..')).map((d) => resolve(root, '..', d))];
  for (const r of roots) {
    const p = join(r, 'node_modules', 'playwright-core');
    if (existsSync(p)) return createRequire(join(r, 'package.json'))('playwright-core');
  }
  throw new Error('playwright-core not found');
}
const { chromium } = findPlaywright();

// The old painters, verbatim but returning canvases (document.createElement
// canvases; three.js's CanvasTexture wrappers dropped).
const painters = String.raw`
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const SUITS = ['♣', '♦', '♥', '♠'];
const RED_SUITS = new Set([1, 2]);
function roundedRect(ctx, x, y, w, h, radius) { ctx.beginPath(); ctx.roundRect(x, y, w, h, radius); ctx.closePath(); }
function cardCanvas(card, px = 256) {
  const canvas = document.createElement('canvas');
  canvas.width = px;
  canvas.height = Math.round(px * 356 / 256);
  const g = canvas.getContext('2d');
  g.scale(px / 256, canvas.height / 356);
  roundedRect(g, 3, 3, 250, 350, 18);
  if (card === -1) {
    const bg = g.createLinearGradient(0, 0, 256, 356);
    bg.addColorStop(0, '#101a4d'); bg.addColorStop(0.5, '#263d91'); bg.addColorStop(1, '#090f31');
    g.fillStyle = bg; g.fill();
    g.save(); roundedRect(g, 17, 17, 222, 322, 13); g.clip();
    g.strokeStyle = 'rgba(111, 189, 255, .48)'; g.lineWidth = 3;
    for (let i = -360; i < 400; i += 22) {
      g.beginPath(); g.moveTo(i, 0); g.lineTo(i + 356, 356); g.stroke();
      g.beginPath(); g.moveTo(i + 356, 0); g.lineTo(i, 356); g.stroke();
    }
    g.restore();
    g.strokeStyle = '#8bd5ff'; g.lineWidth = 5; roundedRect(g, 13, 13, 230, 330, 14); g.stroke();
    g.fillStyle = 'rgba(4, 10, 35, .78)'; g.beginPath(); g.arc(128, 178, 48, 0, Math.PI * 2); g.fill();
    g.strokeStyle = '#d7b760'; g.lineWidth = 3; g.stroke();
    g.fillStyle = '#f4d675'; g.font = '700 46px Georgia, serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('S', 128, 178);
  } else {
    g.fillStyle = '#fffdf7'; g.fill();
    g.strokeStyle = '#d6d0c4'; g.lineWidth = 3; g.stroke();
    const rank = RANKS[card % 13];
    const suitIndex = (card / 13) | 0;
    const suit = SUITS[suitIndex];
    const color = RED_SUITS.has(suitIndex) ? '#c72535' : '#121826';
    g.fillStyle = color;
    g.textAlign = 'left'; g.textBaseline = 'top';
    g.font = '800 70px Georgia, serif'; g.fillText(rank, 20, 12);
    g.font = '58px Georgia, serif'; g.fillText(suit, 23, 82);
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = '116px Georgia, serif'; g.globalAlpha = 0.92; g.fillText(suit, 128, 205); g.globalAlpha = 1;
    g.save(); g.translate(256, 356); g.rotate(Math.PI);
    g.textAlign = 'left'; g.textBaseline = 'top';
    g.font = '800 70px Georgia, serif'; g.fillText(rank, 20, 12);
    g.font = '58px Georgia, serif'; g.fillText(suit, 23, 82);
    g.restore();
  }
  return canvas;
}
function labelTexture(text) {
  const canvas = document.createElement('canvas'); canvas.width = 768; canvas.height = 192;
  const g = canvas.getContext('2d');
  g.clearRect(0, 0, canvas.width, canvas.height);
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = '600 66px Georgia, serif'; g.letterSpacing = '14px';
  g.fillStyle = 'rgba(223, 199, 121, .3)'; g.fillText(text, 384, 96);
  return canvas;
}
function backdropTexture() {
  const c = document.createElement('canvas'); c.width = 512; c.height = 288;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(256, 100, 0, 256, 100, 330);
  grad.addColorStop(0, '#182942'); grad.addColorStop(0.56, '#090d16'); grad.addColorStop(1, '#05070c');
  g.fillStyle = grad; g.fillRect(0, 0, 512, 288);
  return c;
}
function radialTexture(inner, outer) {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  grad.addColorStop(0, inner); grad.addColorStop(1, outer);
  g.fillStyle = grad; g.fillRect(0, 0, 256, 256);
  return c;
}
function noiseTexture(size, blur, lo, hi) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d');
  const img = g.createImageData(size, size);
  let r = 12345;
  for (let i = 0; i < size * size; i++) {
    r = (r * 16807) % 2147483647;
    const v = lo + (r / 2147483647) * (hi - lo);
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  if (blur > 1) { g.filter = 'blur(' + (blur - 1) + 'px)'; g.drawImage(c, 0, 0); g.filter = 'none'; }
  return c;
}
function feltTexture(px = 1024) {
  const W = 1024, H = 592;
  const c = document.createElement('canvas'); c.width = px; c.height = Math.round(px * H / W);
  const g = c.getContext('2d');
  g.scale(px / W, c.height / H);
  const grad = g.createRadialGradient(W / 2, H / 2, 40, W / 2, H / 2, W * 0.56);
  grad.addColorStop(0, '#0c6a4e'); grad.addColorStop(0.7, '#08573f'); grad.addColorStop(1, '#053a2b');
  g.fillStyle = grad; g.fillRect(0, 0, W, H);
  let r = 99;
  const rnd = () => ((r = (r * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 9000; i++) {
    const x = rnd() * W, y = rnd() * H, a = rnd() * Math.PI;
    g.strokeStyle = rnd() > 0.5 ? 'rgba(170,255,210,.05)' : 'rgba(0,20,10,.08)';
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * 4, y + Math.sin(a) * 4); g.stroke();
  }
  g.strokeStyle = 'rgba(232, 200, 120, .34)'; g.lineWidth = 3; g.setLineDash([]);
  g.beginPath(); g.ellipse(W / 2, H / 2, W * 0.36, H * 0.33, 0, 0, Math.PI * 2); g.stroke();
  g.strokeStyle = 'rgba(232, 200, 120, .16)'; g.lineWidth = 2;
  g.beginPath(); g.roundRect(W / 2 - 280, H / 2 - 62, 560, 124, 16); g.stroke();
  return c;
}
const CHIP_COLORS = [0xf0e6d0, 0xc72e45, 0x2458b8, 0x159061, 0x21252e];
function chipFaceTexture(color, px = 128) {
  const c = document.createElement('canvas'); c.width = c.height = px;
  const g = c.getContext('2d');
  g.scale(px / 128, px / 128);
  const hex = '#' + color.toString(16).padStart(6, '0');
  const light = color === 0xf0e6d0 || color === 0x21252e ? '#c7a24c' : '#f5ecd6';
  g.fillStyle = hex; g.beginPath(); g.arc(64, 64, 64, 0, Math.PI * 2); g.fill();
  g.fillStyle = light;
  for (let i = 0; i < 8; i++) { g.save(); g.translate(64, 64); g.rotate((i / 8) * Math.PI * 2); g.fillRect(-7, -64, 14, 15); g.restore(); }
  g.strokeStyle = light; g.lineWidth = 3; g.beginPath(); g.arc(64, 64, 40, 0, Math.PI * 2); g.stroke();
  g.fillStyle = 'rgba(0,0,0,.18)'; g.beginPath(); g.arc(64, 64, 37, 0, Math.PI * 2); g.fill();
  g.fillStyle = light; g.font = '700 34px Georgia, serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText('★', 64, 66);
  return c;
}
function chipFaces(px) {
  const cv = document.createElement('canvas'); cv.width = 5 * px; cv.height = px;
  const g = cv.getContext('2d');
  CHIP_COLORS.forEach((col, i) => g.drawImage(chipFaceTexture(col, px), i * px, 0));
  return cv;
}
function chipSideTexture(color) {
  const c = document.createElement('canvas'); c.width = 256; c.height = 8;
  const g = c.getContext('2d');
  g.fillStyle = '#' + color.toString(16).padStart(6, '0'); g.fillRect(0, 0, 256, 8);
  g.fillStyle = color === 0xf0e6d0 || color === 0x21252e ? '#c7a24c' : '#f5ecd6';
  for (let i = 0; i < 8; i++) g.fillRect(i * 32 + 9, 0, 14, 8);
  return c;
}
function chipSides() {
  const cv = document.createElement('canvas'); cv.width = 256; cv.height = 40;
  const g = cv.getContext('2d');
  CHIP_COLORS.forEach((col, i) => g.drawImage(chipSideTexture(col), 0, i * 8));
  return cv;
}
// menu3d.js: holo-styled faces ('AKQJT98765432' ranks, suits ♠ ♥ ♦ ♣).
const HOLO_RANKS = 'AKQJT98765432';
const HOLO_SUITS = ['♠', '♥', '♦', '♣'];
const HOLO_RED = new Set(['♥', '♦']);
function holoCard(rank, suit) {
  const c = document.createElement('canvas'); c.width = 128; c.height = 180;
  const g = c.getContext('2d');
  g.clearRect(0, 0, 128, 180);
  g.beginPath(); g.roundRect(4, 4, 120, 172, 12);
  g.fillStyle = 'rgba(8, 14, 28, 0.92)'; g.fill();
  g.strokeStyle = 'rgba(110, 220, 255, 0.85)'; g.lineWidth = 3; g.stroke();
  const color = HOLO_RED.has(suit) ? '#ff6b81' : '#bfeaff';
  g.fillStyle = color; g.shadowColor = color; g.shadowBlur = 12;
  g.font = '700 34px Georgia, serif'; g.textAlign = 'left'; g.fillText(rank, 16, 44);
  g.font = '400 30px Georgia, serif'; g.fillText(suit, 16, 78);
  g.font = '400 54px Georgia, serif'; g.textAlign = 'center'; g.fillText(suit, 64, 142);
  return c;
}
function holoSheet() {
  const cv = document.createElement('canvas'); cv.width = 13 * 128; cv.height = 4 * 180;
  const g = cv.getContext('2d');
  for (let s = 0; s < 4; s++) for (let r = 0; r < 13; r++) g.drawImage(holoCard(HOLO_RANKS[r], HOLO_SUITS[s]), r * 128, s * 180);
  return cv;
}
`;

const jobs = [];
for (const px of [128, 256, 512]) {
  for (let c = 0; c < 52; c++) jobs.push([`cards/${px}/${c}.webp`, `cardCanvas(${c}, ${px})`]);
  jobs.push([`cards/${px}/back.webp`, `cardCanvas(-1, ${px})`]);
}
for (const px of [512, 1024, 2048]) jobs.push([`felt-${px}.webp`, `feltTexture(${px})`]);
for (const px of [256, 512, 1024]) jobs.push([`felt-bump-${px}.webp`, `noiseTexture(${px}, 1, 110, 150)`]);
jobs.push(['grain.png', 'noiseTexture(256, 3, 90, 165)']);
jobs.push(['label.png', "labelTexture('STARHERMIT')"]);
jobs.push(["backdrop.webp", "backdropTexture()"]);
jobs.push(['pool.png', "radialTexture('rgba(255,196,120,.16)', 'rgba(255,196,120,0)')"]);
for (const px of [64, 128, 256]) jobs.push([`chips-${px}.png`, `chipFaces(${px})`]);
jobs.push(['chip-sides.png', 'chipSides()']);
jobs.push(['holo-cards.webp', 'holoSheet()']);

const out = join(root, 'assets', 'textures');
mkdirSync(out, { recursive: true });
for (const px of [128, 256, 512]) mkdirSync(join(out, 'cards', String(px)), { recursive: true });
const { launchChrome } = await import('/home/albert/games/tools/gpu-chrome.mjs');
const { browser, close } = await launchChrome(chromium);
try {
  const page = await browser.newPage();
  await page.setContent('<!doctype html><html><body></body></html>');
  await page.addScriptTag({ content: painters });
  await page.evaluate(() => document.fonts.ready);
  for (const [file, expr] of jobs) {
    const url = await page.evaluate(async ([e, webp]) => {
      const cv = await (0, eval)(e);
      return webp ? cv.toDataURL('image/webp', 0.92) : cv.toDataURL('image/png');
    }, [expr, file.endsWith('.webp')]);
    writeFileSync(join(out, file), Buffer.from(url.split(',')[1], 'base64'));
    console.log(file);
  }
} finally { await close(); }

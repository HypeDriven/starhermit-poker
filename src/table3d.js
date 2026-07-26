// three.js poker-table renderer: felt, community cards, per-seat hole cards
// (faces for the owner/revealed hands, backs otherwise), and chip stacks.
// Text stays in DOM overlays (see table.js) — this module draws objects only.

import * as THREE from 'three';
import { seatVisual, seatUnit } from './table-utils.js';

export { seatVisual, seatUnit };

const RX = 3.4; // seat ellipse radii
const RZ = 2.35;
const RANKS = '23456789TJQKA';
const SUITS = ['♣', '♦', '♥', '♠'];
const RED_SUITS = new Set([1, 2]); // diamonds, hearts

const cardTextureCache = new Map();

function cardTexture(card) {
  // card: int 0..51, or -1 for the back.
  const key = card;
  if (cardTextureCache.has(key)) return cardTextureCache.get(key);
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 180;
  const g = canvas.getContext('2d');
  g.fillStyle = card === -1 ? '#1d2f6f' : '#f7f5f0';
  g.beginPath();
  g.roundRect(0, 0, 128, 180, 12);
  g.fill();
  if (card === -1) {
    g.strokeStyle = '#4da3ff';
    g.lineWidth = 4;
    for (let i = -180; i < 180; i += 18) {
      g.beginPath();
      g.moveTo(i, 0);
      g.lineTo(i + 180, 180);
      g.stroke();
    }
  } else {
    const rank = RANKS[card % 13];
    const suit = SUITS[(card / 13) | 0];
    g.fillStyle = RED_SUITS.has((card / 13) | 0) ? '#c62f2f' : '#1a1a1a';
    g.font = 'bold 44px system-ui, sans-serif';
    g.textAlign = 'left';
    g.textBaseline = 'top';
    g.fillText(rank, 12, 8);
    g.font = '44px system-ui, sans-serif';
    g.fillText(suit, 12, 52);
    g.textAlign = 'right';
    g.textBaseline = 'bottom';
    g.fillText(suit, 116, 128);
    g.font = 'bold 44px system-ui, sans-serif';
    g.fillText(rank, 116, 172);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  cardTextureCache.set(key, tex);
  return tex;
}

function makeCardMesh(card) {
  const mat = new THREE.MeshBasicMaterial({ map: cardTexture(card) });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.55, 0.77), mat);
  mesh.rotation.x = -Math.PI / 2;
  return mesh;
}

function makeChipStack(amount) {
  const group = new THREE.Group();
  const chips = Math.min(12, Math.max(1, Math.round(amount / 200)));
  const colors = [0xd6d6d6, 0xc62f2f, 0x2f6fc6, 0x2fa04f];
  for (let i = 0; i < chips; i++) {
    const chip = new THREE.Mesh(
      new THREE.CylinderGeometry(0.16, 0.16, 0.045, 24),
      new THREE.MeshStandardMaterial({ color: colors[i % colors.length] }));
    chip.position.y = 0.025 + i * 0.05;
    group.add(chip);
  }
  return group;
}

export class TableRenderer {
  constructor(container) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0e1420);
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
    this.camera.position.set(0, 5.6, 6.2);
    this.camera.lookAt(0, 0, 0.6);

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.85));
    const dir = new THREE.DirectionalLight(0xffffff, 0.8);
    dir.position.set(2, 6, 3);
    this.scene.add(dir);

    // Felt + rail.
    const felt = new THREE.Mesh(
      new THREE.CircleGeometry(1, 72),
      new THREE.MeshStandardMaterial({ color: 0x1f5c40 }));
    felt.scale.set(4.2, 2.9, 1);
    felt.rotation.x = -Math.PI / 2;
    this.scene.add(felt);
    const rail = new THREE.Mesh(
      new THREE.RingGeometry(0.94, 1.12, 72),
      new THREE.MeshStandardMaterial({ color: 0x4a3220 }));
    rail.scale.set(4.2, 2.9, 1);
    rail.rotation.x = -Math.PI / 2;
    rail.position.y = -0.01;
    this.scene.add(rail);

    this.boardGroup = new THREE.Group();
    this.scene.add(this.boardGroup);
    this.potGroup = new THREE.Group();
    this.scene.add(this.potGroup);
    this.seatGroups = [];
    for (let v = 0; v < 6; v++) {
      const group = new THREE.Group();
      const { x, y } = seatUnit(v);
      group.position.set(x * RX, 0, y * RZ);
      this.scene.add(group);
      this.seatGroups.push(group);
    }

    this._onResize = () => this.resize();
    this.resizeObserver = new ResizeObserver(this._onResize);
    this.resizeObserver.observe(container);
    this.resize();

    this._disposed = false;
    const loop = () => {
      if (this._disposed) return;
      this.renderer.render(this.scene, this.camera);
      this._raf = requestAnimationFrame(loop);
    };
    loop();
  }

  resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // Full redraw from a projected public state + the viewer's private view.
  update(publicState, you) {
    // Board cards.
    this.boardGroup.clear();
    const board = publicState.board || [];
    board.forEach((card, i) => {
      const mesh = makeCardMesh(card);
      mesh.position.set((i - (board.length - 1) / 2) * 0.68, 0.01, 0);
      this.boardGroup.add(mesh);
    });

    // Pot chips.
    this.potGroup.clear();
    if (publicState.pot > 0) {
      const stack = makeChipStack(publicState.pot);
      stack.position.set(0, 0, 0.85);
      this.potGroup.add(stack);
    }

    // Seats.
    const youSeat = you && typeof you.seat === 'number' ? you.seat : -1;
    for (const s of publicState.seats || []) {
      const group = this.seatGroups[seatVisual(s.seat, Math.max(0, youSeat))];
      group.clear();
      if (!s.inHand && !s.folded) {
        // No cards this hand (sitting out / between hands).
      } else if (s.folded && !publicState.revealed?.[s.seat]) {
        // Folded: no cards shown.
      } else {
        const revealed = publicState.revealed && publicState.revealed[s.seat];
        const own = youSeat === s.seat && you && you.holeCards;
        const cards = revealed || own || [-1, -1];
        cards.forEach((card, k) => {
          const mesh = makeCardMesh(card);
          mesh.position.set((k - 0.5) * 0.42, 0.01, 0);
          mesh.rotation.z = (k - 0.5) * -0.12;
          group.add(mesh);
        });
      }
      if (s.roundCommit > 0) {
        const bet = makeChipStack(s.roundCommit);
        // Bets sit toward the pot from the seat.
        bet.position.multiplyScalar(0.62);
        group.add(bet);
      }
    }
  }

  dispose() {
    this._disposed = true;
    if (this._raf) cancelAnimationFrame(this._raf);
    this.resizeObserver.disconnect();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

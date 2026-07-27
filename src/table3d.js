// Cinematic three.js poker table. The renderer receives only the server's
// addressed projection; visibleCardsForSeat adds a client-side privacy guard
// so an opponent's live cards can only ever be rendered as backs.

import * as THREE from 'three';
import { seatVisual, seatUnit, visibleCardsForSeat } from './table-utils.js';

export { seatVisual, seatUnit };

const TABLE_RX = 4.35;
const TABLE_RZ = 2.72;
const SEAT_RX = 3.62;
const SEAT_RZ = 2.34;
const RANKS = '23456789TJQKA';
const SUITS = ['♣', '♦', '♥', '♠'];
const RED_SUITS = new Set([1, 2]);

function ellipseShape(rx, ry) {
  const shape = new THREE.Shape();
  shape.absellipse(0, 0, rx, ry, 0, Math.PI * 2, false, 0);
  return shape;
}

function ellipseRing(outerX, outerY, innerX, innerY) {
  const shape = ellipseShape(outerX, outerY);
  const hole = new THREE.Path();
  hole.absellipse(0, 0, innerX, innerY, 0, Math.PI * 2, true, 0);
  shape.holes.push(hole);
  return shape;
}

function horizontalExtrusion(shape, depth, bevelSize = 0.04) {
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: true,
    bevelSegments: 3,
    bevelSize,
    bevelThickness: bevelSize,
    curveSegments: 96,
  });
  geometry.center();
  geometry.rotateX(Math.PI / 2);
  return geometry;
}

function roundedRect(ctx, x, y, w, h, radius) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, radius);
  ctx.closePath();
}

function cardCanvas(card) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 356;
  const g = canvas.getContext('2d');

  roundedRect(g, 3, 3, 250, 350, 18);
  if (card === -1) {
    const bg = g.createLinearGradient(0, 0, 256, 356);
    bg.addColorStop(0, '#101a4d');
    bg.addColorStop(0.5, '#263d91');
    bg.addColorStop(1, '#090f31');
    g.fillStyle = bg;
    g.fill();
    g.save();
    roundedRect(g, 17, 17, 222, 322, 13);
    g.clip();
    g.strokeStyle = 'rgba(111, 189, 255, .48)';
    g.lineWidth = 3;
    for (let i = -360; i < 400; i += 22) {
      g.beginPath(); g.moveTo(i, 0); g.lineTo(i + 356, 356); g.stroke();
      g.beginPath(); g.moveTo(i + 356, 0); g.lineTo(i, 356); g.stroke();
    }
    g.restore();
    g.strokeStyle = '#8bd5ff';
    g.lineWidth = 5;
    roundedRect(g, 13, 13, 230, 330, 14);
    g.stroke();
    g.fillStyle = 'rgba(4, 10, 35, .78)';
    g.beginPath(); g.arc(128, 178, 48, 0, Math.PI * 2); g.fill();
    g.strokeStyle = '#d7b760'; g.lineWidth = 3; g.stroke();
    g.fillStyle = '#f4d675';
    g.font = '700 46px Georgia, serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('S', 128, 178);
  } else {
    g.fillStyle = '#fffdf7';
    g.fill();
    g.strokeStyle = '#d6d0c4';
    g.lineWidth = 3;
    g.stroke();
    const rank = RANKS[card % 13];
    const suitIndex = (card / 13) | 0;
    const suit = SUITS[suitIndex];
    const color = RED_SUITS.has(suitIndex) ? '#c72535' : '#121826';
    g.fillStyle = color;
    g.textAlign = 'left'; g.textBaseline = 'top';
    g.font = '800 70px Georgia, serif';
    g.fillText(rank, 20, 12);
    g.font = '58px Georgia, serif';
    g.fillText(suit, 23, 82);
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = '116px Georgia, serif';
    g.globalAlpha = 0.92;
    g.fillText(suit, 128, 205);
    g.globalAlpha = 1;
    g.save();
    g.translate(256, 356); g.rotate(Math.PI);
    g.textAlign = 'left'; g.textBaseline = 'top';
    g.font = '800 70px Georgia, serif'; g.fillText(rank, 20, 12);
    g.font = '58px Georgia, serif'; g.fillText(suit, 23, 82);
    g.restore();
  }
  return canvas;
}

function labelTexture(text) {
  const canvas = document.createElement('canvas');
  canvas.width = 768;
  canvas.height = 192;
  const g = canvas.getContext('2d');
  g.clearRect(0, 0, canvas.width, canvas.height);
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = '600 66px Georgia, serif';
  g.letterSpacing = '14px';
  g.fillStyle = 'rgba(223, 199, 121, .3)';
  g.fillText(text, 384, 96);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

export class TableRenderer {
  constructor(container) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x070b15, 0.055);
    this.camera = new THREE.PerspectiveCamera(39, 1, 0.1, 80);
    this.camera.position.set(0, 6.65, 7.15);
    this.camera.lookAt(0, 0.05, 0.35);
    this.clock = new THREE.Clock();
    this.cardTextures = new Map();
    this.dynamicGroups = [];

    this.buildLights();
    this.buildRoom();
    this.buildTable();
    this.buildDynamicGroups();

    this._onResize = () => this.resize();
    this.resizeObserver = new ResizeObserver(this._onResize);
    this.resizeObserver.observe(container);
    this.resize();

    this._disposed = false;
    const loop = () => {
      if (this._disposed) return;
      const t = this.clock.getElapsedTime();
      if (this.actingRing) {
        const glow = 0.58 + Math.sin(t * 4.2) * 0.25;
        this.actingRing.material.opacity = glow;
        this.actingRing.rotation.z = t * 0.18;
      }
      this.renderer.render(this.scene, this.camera);
      this._raf = requestAnimationFrame(loop);
    };
    loop();
  }

  buildLights() {
    this.scene.add(new THREE.HemisphereLight(0xb9d9ff, 0x160c08, 1.35));
    const key = new THREE.SpotLight(0xfff0d3, 42, 25, Math.PI / 4.2, 0.7, 1.2);
    key.position.set(-3.5, 8, 4.5);
    key.target.position.set(0, 0, 0);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    this.scene.add(key, key.target);
    const rim = new THREE.PointLight(0x3d7dff, 22, 14, 2);
    rim.position.set(4.5, 2.5, -4);
    this.scene.add(rim);
    const warm = new THREE.PointLight(0xff9e53, 12, 10, 2);
    warm.position.set(-5, 1.5, 1);
    this.scene.add(warm);
  }

  buildRoom() {
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(12, 96),
      new THREE.MeshStandardMaterial({ color: 0x080b12, roughness: 0.88, metalness: 0.12 }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.64;
    floor.receiveShadow = true;
    this.scene.add(floor);

    const points = [];
    for (let i = 0; i < 240; i++) {
      const angle = i * 2.39996;
      const radius = 7 + (i % 29) * 0.22;
      points.push(Math.cos(angle) * radius, 2 + (i % 17) * 0.34, Math.sin(angle) * radius - 3);
    }
    const stars = new THREE.BufferGeometry();
    stars.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
    this.scene.add(new THREE.Points(stars, new THREE.PointsMaterial({
      color: 0x729bd3, size: 0.035, transparent: true, opacity: 0.45,
    })));
  }

  buildTable() {
    const pedestal = new THREE.Mesh(
      new THREE.CylinderGeometry(1.5, 2.05, 0.78, 64),
      new THREE.MeshStandardMaterial({ color: 0x11141b, roughness: 0.22, metalness: 0.74 }));
    pedestal.position.y = -0.38;
    pedestal.castShadow = true;
    this.scene.add(pedestal);

    const base = new THREE.Mesh(
      horizontalExtrusion(ellipseShape(TABLE_RX, TABLE_RZ), 0.34, 0.08),
      new THREE.MeshPhysicalMaterial({ color: 0x171217, roughness: 0.22, metalness: 0.5, clearcoat: 0.65 }));
    base.position.y = -0.05;
    base.castShadow = base.receiveShadow = true;
    this.scene.add(base);

    const rail = new THREE.Mesh(
      horizontalExtrusion(ellipseRing(TABLE_RX, TABLE_RZ, 3.82, 2.19), 0.25, 0.07),
      new THREE.MeshPhysicalMaterial({ color: 0x381a16, roughness: 0.28, metalness: 0.12, clearcoat: 0.85, clearcoatRoughness: 0.18 }));
    rail.position.y = 0.22;
    rail.castShadow = true;
    this.scene.add(rail);

    const felt = new THREE.Mesh(
      horizontalExtrusion(ellipseShape(3.84, 2.21), 0.09, 0.015),
      new THREE.MeshStandardMaterial({ color: 0x07543e, roughness: 0.92, metalness: 0.02 }));
    felt.position.y = 0.22;
    felt.receiveShadow = true;
    this.scene.add(felt);

    for (const [outer, inner, color, y] of [
      [[3.88, 2.25], [3.81, 2.18], 0xc69b42, 0.305],
      [[3.48, 1.88], [3.465, 1.865], 0x93a87b, 0.314],
    ]) {
      const trim = new THREE.Mesh(
        horizontalExtrusion(ellipseRing(...outer, ...inner), 0.018, 0.005),
        new THREE.MeshStandardMaterial({ color, metalness: 0.72, roughness: 0.28 }));
      trim.position.y = y;
      this.scene.add(trim);
    }

    const logo = new THREE.Mesh(
      new THREE.PlaneGeometry(2.7, 0.67),
      new THREE.MeshBasicMaterial({ map: labelTexture('STARHERMIT'), transparent: true, depthWrite: false }));
    logo.rotation.x = -Math.PI / 2;
    logo.position.set(0, 0.325, -0.72);
    this.scene.add(logo);
  }

  buildDynamicGroups() {
    this.boardGroup = new THREE.Group();
    this.boardGroup.position.y = 0.37;
    this.scene.add(this.boardGroup);
    this.potGroup = new THREE.Group();
    this.potGroup.position.y = 0.36;
    this.scene.add(this.potGroup);

    this.seatGroups = [];
    for (let visual = 0; visual < 6; visual++) {
      const group = new THREE.Group();
      const { x, y } = seatUnit(visual);
      group.position.set(x * SEAT_RX, 0.37, y * SEAT_RZ);
      this.scene.add(group);
      this.seatGroups.push(group);
    }

    this.actingRing = new THREE.Mesh(
      new THREE.TorusGeometry(0.48, 0.025, 10, 64),
      new THREE.MeshBasicMaterial({ color: 0xffd66d, transparent: true, opacity: 0 }));
    this.actingRing.rotation.x = Math.PI / 2;
    this.actingRing.visible = false;
    this.scene.add(this.actingRing);
  }

  textureForCard(card) {
    if (this.cardTextures.has(card)) return this.cardTextures.get(card);
    const texture = new THREE.CanvasTexture(cardCanvas(card));
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    this.cardTextures.set(card, texture);
    return texture;
  }

  makeCard(card) {
    const group = new THREE.Group();
    const edge = new THREE.Mesh(
      new THREE.BoxGeometry(0.59, 0.035, 0.82, 2, 1, 2),
      new THREE.MeshStandardMaterial({ color: 0xe7e1d5, roughness: 0.48 }));
    edge.castShadow = edge.receiveShadow = true;
    const face = new THREE.Mesh(
      new THREE.PlaneGeometry(0.565, 0.795),
      new THREE.MeshBasicMaterial({ map: this.textureForCard(card) }));
    face.rotation.x = -Math.PI / 2;
    face.position.y = 0.019;
    group.add(edge, face);
    return group;
  }

  makeChipStack(amount, compact = false) {
    const group = new THREE.Group();
    const count = Math.min(compact ? 10 : 14, Math.max(1, Math.ceil(Math.log2(Math.max(2, amount / 25)))));
    const colors = [0xf0e6d0, 0xc72e45, 0x2458b8, 0x159061, 0x21252e];
    const radius = compact ? 0.115 : 0.14;
    for (let i = 0; i < count; i++) {
      const color = colors[(Math.floor(amount / 100) + i) % colors.length];
      const chip = new THREE.Mesh(
        new THREE.CylinderGeometry(radius, radius, 0.042, 32),
        new THREE.MeshStandardMaterial({ color, roughness: 0.3, metalness: 0.12 }));
      chip.position.y = 0.022 + i * 0.045;
      chip.castShadow = true;
      group.add(chip);
      if (i % 2 === 0) {
        const stripe = new THREE.Mesh(
          new THREE.TorusGeometry(radius * 0.82, 0.009, 5, 24),
          new THREE.MeshBasicMaterial({ color: 0xf5e7bf }));
        stripe.rotation.x = Math.PI / 2;
        stripe.position.y = 0.045 + i * 0.045;
        group.add(stripe);
      }
    }
    return group;
  }

  clearGroup(group) {
    // Dynamic objects own their geometry/materials. Textures are cached and
    // disposed once with the renderer.
    for (const child of [...group.children]) {
      child.traverse((obj) => {
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) {
          const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
          for (const mat of mats) mat.dispose();
        }
      });
      group.remove(child);
    }
  }

  resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.position.y = w / h < 1 ? 7.4 : 6.65;
    this.camera.position.z = w / h < 1 ? 8.5 : 7.15;
    this.camera.lookAt(0, 0.05, 0.3);
    this.camera.updateProjectionMatrix();
  }

  // Full redraw from a projected public state + the viewer's private view.
  update(publicState, you) {
    this.clearGroup(this.boardGroup);
    const board = publicState.board || [];
    board.forEach((card, i) => {
      const mesh = this.makeCard(card);
      mesh.position.set((i - 2) * 0.67, 0, -0.08);
      mesh.rotation.y = (i - 2) * -0.018;
      this.boardGroup.add(mesh);
    });

    this.clearGroup(this.potGroup);
    if (publicState.pot > 0) {
      const stack = this.makeChipStack(publicState.pot);
      stack.position.set(0, 0, 0.72);
      this.potGroup.add(stack);
    }

    const youSeat = you && Number.isInteger(you.seat) ? you.seat : 0;
    for (const group of this.seatGroups) this.clearGroup(group);
    for (const seat of publicState.seats || []) {
      const visual = seatVisual(seat.seat, Math.max(0, youSeat));
      const group = this.seatGroups[visual];
      if (!group) continue;
      const cards = visibleCardsForSeat(seat, you, publicState.revealed);
      if (cards) {
        cards.forEach((card, index) => {
          const mesh = this.makeCard(card);
          mesh.position.set((index - 0.5) * 0.39, index * 0.012, 0);
          mesh.rotation.y = (index - 0.5) * -0.17;
          mesh.scale.setScalar(visual === 0 ? 1 : 0.84);
          group.add(mesh);
        });
      }
      if (seat.roundCommit > 0) {
        const bet = this.makeChipStack(seat.roundCommit, true);
        // Move from the seat toward the centre of the felt.
        bet.position.set(-group.position.x * 0.22, 0, -group.position.z * 0.22);
        group.add(bet);
      }
    }

    const actor = (publicState.seats || []).find((seat) => seat.seat === publicState.actingSeat);
    if (actor) {
      const visual = seatVisual(actor.seat, Math.max(0, youSeat));
      const target = this.seatGroups[visual];
      this.actingRing.visible = true;
      this.actingRing.position.set(target.position.x, 0.385, target.position.z);
      this.actingRing.scale.setScalar(visual === 0 ? 1.05 : 0.9);
    } else {
      this.actingRing.visible = false;
    }
  }

  dispose() {
    this._disposed = true;
    if (this._raf) cancelAnimationFrame(this._raf);
    this.resizeObserver.disconnect();
    this.scene.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) {
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const mat of mats) {
          if (mat.map && !this.cardTextures.has(mat.map)) mat.map.dispose();
          mat.dispose();
        }
      }
    });
    for (const texture of this.cardTextures.values()) texture.dispose();
    this.cardTextures.clear();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

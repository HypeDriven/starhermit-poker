// Removes the KHR_lights_punctual extension from assets/casino.glb (in place).
// The browser build dropped the hall's Blender lights at load time (menu3d.js
// lights it itself); the engine's GLTFLoader refuses a file that *requires* an
// extension it does not support, so the lights (and the extension's required
// flag) are taken out of the file instead. Nodes stay (empty transforms).
//   node tools/strip-glb-lights.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'casino.glb');
const buf = readFileSync(file);
if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('not a GLB');
const jsonLen = buf.readUInt32LE(12);
if (buf.readUInt32LE(16) !== 0x4e4f534a) throw new Error('first chunk is not JSON');
const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
const rest = buf.subarray(20 + jsonLen);
const EXT = 'KHR_lights_punctual';
let removed = 0;
for (const key of ['extensionsRequired', 'extensionsUsed']) {
  if (Array.isArray(json[key])) {
    json[key] = json[key].filter((e) => e !== EXT);
    if (!json[key].length) delete json[key];
  }
}
if (json.extensions) { delete json.extensions[EXT]; if (!Object.keys(json.extensions).length) delete json.extensions; }
for (const n of json.nodes || []) {
  if (n.extensions && n.extensions[EXT]) { delete n.extensions[EXT]; removed++; if (!Object.keys(n.extensions).length) delete n.extensions; }
}
let text = JSON.stringify(json);
while (Buffer.byteLength(text) % 4) text += ' ';
const jsonBuf = Buffer.from(text, 'utf8');
const header = Buffer.alloc(20);
header.writeUInt32LE(0x46546c67, 0);
header.writeUInt32LE(2, 4);
header.writeUInt32LE(20 + jsonBuf.length + rest.length, 8);
header.writeUInt32LE(jsonBuf.length, 12);
header.writeUInt32LE(0x4e4f534a, 16);
writeFileSync(file, Buffer.concat([header, jsonBuf, rest]));
console.log(`removed ${EXT} from ${removed} nodes`);

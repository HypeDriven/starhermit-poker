// Online tables on the runtime's local platform (`--dev --local-platform`): the
// first run serves a platform whose room-bound sessions run server.js, the
// later ones join it. Plays tests/online/host-private.play (one signed-in
// player, a private table with AI opponents, to the result), then
// two-host.play and two-guest.play at once (two players meet at a Quick Play
// table, the host starts it, both play to the result). Real time: a few
// minutes. STARHERMIT names the runtime; SHOTS a folder for the screenshots.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fallback = join(homedir(), 'sh/runtime/1.19.3/starhermit-1.19.3-linux-x86_64/starhermit');
const exe = process.env.STARHERMIT || (existsSync(fallback) ? fallback : null);
if (!exe) { console.error('set STARHERMIT to the engine runtime'); process.exit(1); }
const shots = process.env.SHOTS || mkdtempSync(join(tmpdir(), 'poker-online-'));

function run(player, script) {
  return new Promise((resolve) => {
    const p = spawn(exe, ['.', '--dev', '--local-platform', '--player', player, '--render-check', '--quiet', '--script', script],
      { cwd: root, env: { ...process.env, STARHERMIT_RENDER_CHECK_PNG: shots } });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => resolve({ code, out }));
  });
}
const report = (name, r) => {
  if (r.code === 0) console.log(`ok - ${name}`);
  else { console.log(`not ok - ${name}\n${r.out.trim().split('\n').slice(-6).join('\n')}`); failed++; }
};
let failed = 0;
report('host-private.play', await run('alice', 'tests/online/host-private.play'));
const host = run('alice', 'tests/online/two-host.play');
await new Promise((r) => setTimeout(r, 8000));
const guest = run('bob', 'tests/online/two-guest.play');
report('two-guest.play', await guest);
report('two-host.play', await host);
console.log(`screenshots: ${shots}`);
console.log(failed ? `ONLINE FAIL — ${failed} failed` : 'ONLINE PASS');
process.exit(failed ? 1 : 0);

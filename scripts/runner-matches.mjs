// The runner and MFTF builds wrangler.jsonc declares are the ones its image says it has.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const { containers, vars } = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8' }).trim();
const id = docker('run', '-d', '-p', '127.0.0.1::8080', containers[0].image);
try {
  const url = `http://${docker('port', id, '8080')}`;
  let about;
  for (let tried = 0; !about; tried++) {
    assert.ok(tried < 50, 'the runner did not answer');
    about = await fetch(url).then((answer) => answer.json(), () => new Promise((resolve) => setTimeout(resolve, 200)));
  }
  assert.equal(about.runner, vars.RUNNER, 'RUNNER is the image\'s version');
  assert.deepEqual(about.mftf, vars.MFTF, 'MFTF is the builds the image has');
  console.log(`${containers[0].image} is runner ${about.runner} with MFTF ${about.mftf.join(', ')}`);
} finally {
  docker('rm', '-f', id);
}

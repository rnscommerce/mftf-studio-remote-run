// One run through a deployed service, start to results, with no MFTF test
// and no browser: the actor is built as for any run, and the bundle's
// studio-job.php then leaves as Codeception's own run begins.
//   CONTROL  where the service answers
//   API_KEY  what it lets in
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const { CONTROL, API_KEY } = process.env;
const CEST = 'generated/_generated/default/SmokeCest.php';
const CODE = 3;
const call = (pathname, init = {}) =>
  fetch(`${CONTROL}${pathname}`, { ...init, headers: { Authorization: `Bearer ${API_KEY}` }, signal: AbortSignal.timeout(60_000) });

const dir = mkdtempSync(path.join(tmpdir(), 'smoke-'));
const files = {
  'bundle/project/composer.json': '{}',
  [`bundle/${CEST}`]: '<?php',
  'bundle/studio/studio-job.php': `<?php if (in_array('run', $argv)) { file_put_contents('tests/_output/smoke', 'ok'); echo "smoke\\n"; exit(${CODE}); }`,
};
for (const [name, content] of Object.entries(files)) {
  mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
  writeFileSync(path.join(dir, name), content);
}
const bundle = execFileSync('tar', ['czf', '-', '-C', dir, 'bundle']);
rmSync(dir, { recursive: true });
const sha = createHash('sha256').update(bundle).digest('hex');

assert.equal((await call(`/bundles/${sha}`, { method: 'PUT', body: bundle })).status, 201, 'the bundle is stored');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const request = { bundle: sha, mftf: '4.7.6', selector: CEST, env: '', credentials: '', capabilities: {}, extensions: [], writes: [] };

// A container of an image just rolled out can take longer to start than a start waits.
let id;
for (let tried = 0; id === undefined; tried++) {
  const started = await (await call('/runs', { method: 'POST', body: JSON.stringify(request) })).json();
  id = started.id;
  assert.ok(id !== undefined || tried < 3, `the run starts: ${started.error}`);
  if (id === undefined) await pause(5000);
}

let run;
for (let tried = 0; !run?.ended; tried++) {
  assert.ok(tried < 60, 'the run ends within two minutes');
  await pause(2000);
  run = await (await call(`/runs/${id}`)).json();
}
assert.equal(run.code, CODE, 'the run ends with its exit code');

// The results are stored just after the run says it has ended.
let results;
for (let tried = 0; !results?.ok; tried++) {
  assert.ok(tried < 30, 'the results are stored within a minute');
  if (tried > 0) await pause(2000);
  results = await call(`/runs/${id}/results`);
}
const listed = execFileSync('tar', ['tzf', '-'], { input: Buffer.from(await results.arrayBuffer()), encoding: 'utf8' });
assert.match(listed, /^\.\/smoke$/m, 'the results hold what the run wrote');
console.log(`run ${id} ended with ${run.code}`);

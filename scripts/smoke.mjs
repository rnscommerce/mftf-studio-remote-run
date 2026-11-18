// Every call of the API, against a deployed service, with no MFTF test and no
// browser: the actor is built as for any run, and the snapshot's
// studio-job.php then does what each run here asks in place of Codeception.
//   CONTROL  where the service answers
//   API_KEY  what it lets in
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const { CONTROL, API_KEY } = process.env;
const CEST = 'generated/_generated/default/SmokeCest.php';
const CODE = 3;
const headers = { Authorization: `Bearer ${API_KEY}` };
const call = (pathname, init = {}) => fetch(`${CONTROL}${pathname}`, { ...init, headers, signal: AbortSignal.timeout(60_000) });
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A snapshot whose run does what `job` says, and its SHA-256. */
function snapshot(job) {
  const dir = mkdtempSync(path.join(tmpdir(), 'smoke-'));
  const files = {
    'snapshot/project/composer.json': '{}',
    [`snapshot/${CEST}`]: '<?php',
    'snapshot/studio/studio-job.php': `<?php if (in_array('run', $argv)) { ${job} }`,
  };
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), content);
  }
  const archive = execFileSync('tar', ['czf', '-', '-C', dir, 'snapshot']);
  rmSync(dir, { recursive: true });
  return { archive, sha: createHash('sha256').update(archive).digest('hex') };
}

async function store({ archive, sha }) {
  if ((await call(`/snapshots/${sha}`, { method: 'HEAD' })).status === 200) return;
  assert.equal((await call(`/snapshots/${sha}`, { method: 'PUT', body: archive })).status, 201, 'the snapshot is stored');
  assert.equal((await call(`/snapshots/${sha}`, { method: 'HEAD' })).status, 200, 'a stored snapshot is held');
}

// A container of an image just rolled out can take longer to start than a start waits.
async function start(sha, mftf) {
  const request = { snapshot: sha, mftf, target: CEST, env: '', credentials: '', capabilities: {}, extensions: [], outputs: [] };
  for (let tried = 0; ; tried++) {
    const started = await (await call('/runs', { method: 'POST', body: JSON.stringify(request) })).json();
    if (started.id !== undefined) return started.id;
    assert.ok(tried < 3, `the run starts: ${started.error}`);
    await pause(5000);
  }
}

async function ended(id) {
  for (let tried = 0; ; tried++) {
    assert.ok(tried < 60, 'the run ends within two minutes');
    const run = await (await call(`/runs/${id}`)).json();
    if (run.status !== 'running') return run;
    await pause(2000);
  }
}

/** Every event the run said, read from `from` on through its WebSocket. */
function events(id, from) {
  const url = `${CONTROL.replace(/^http/, 'ws')}/runs/${id}/events?from=${from}`;
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    const said = [];
    socket.on('message', (data) => {
      const event = JSON.parse(data.toString('utf8'));
      if (event.type === 'frame') return;
      said.push(event);
      if (event.type === 'ended') socket.close();
    });
    socket.on('close', () => resolve(said));
    socket.on('error', (error) => reject(new Error(`the events could not be read: ${error.message}`)));
  });
}

assert.equal((await fetch(`${CONTROL}/`)).status, 401, 'a call without the key is refused');
const about = await (await call('/')).json();
assert.equal(about.api, 1, 'the service speaks API 1');
assert.ok(about.mftf.length > 0, 'the service names the MFTF builds it has');

const exits = snapshot(`file_put_contents('tests/_output/smoke', 'ok'); echo "smoke\\n"; exit(${CODE});`);
await store(exits);
const id = await start(exits.sha, about.mftf[0]);
const run = await ended(id);
assert.deepEqual([run.status, run.code], ['ended', CODE], 'the run ends with its exit code');
const said = await events(id, 0);
assert.deepEqual(said.map((event) => event.n), [...said.keys()], 'the events come in order, from 0');
assert.ok(said.some((event) => event.text === 'smoke'), 'the events hold what the run said');
assert.equal((await events(id, said.length - 1)).length, 1, 'the events are read again from any one');

// The results are stored just after the run says it has ended.
let results;
for (let tried = 0; !results?.ok; tried++) {
  assert.ok(tried < 30, 'the results are stored within a minute');
  if (tried > 0) await pause(2000);
  results = await call(`/runs/${id}/results`);
}
const listed = execFileSync('tar', ['tzf', '-'], { input: Buffer.from(await results.arrayBuffer()), encoding: 'utf8' });
assert.match(listed, /^\.\/smoke$/m, 'the results hold what the run wrote');

const waits = snapshot('echo "going\\n"; sleep(120);');
await store(waits);
const stopped = await start(waits.sha, about.mftf[0]);
await call(`/runs/${stopped}/stop`, { method: 'POST' });
assert.equal((await ended(stopped)).status, 'ended', 'a stopped run ends');

console.log(`runner ${about.runner}: run ${id} ended with ${run.code}, run ${stopped} stopped`);

// The runner as the Run object meets it: the image `npm test` builds, driven over HTTP. No MFTF
// runs and no browser is asked for. The build a run names is an empty stand-in
// for Codeception, and what a run does is the studio-job.php its bundle
// brings, which PHP loads ahead of it.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const IMAGE = 'mftf-studio-remote-runner:test';
const CEST = 'generated/_generated/default/SomeCest.php';
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** A bundle whose run does what `job` says: PHP, run in place of Codeception. */
function bundle(job, files = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'runner-test-'));
  const all = {
    'bundle/project/composer.json': '{}',
    [`bundle/${CEST}`]: '<?php',
    'bundle/studio/studio-job.php': `<?php\n$build = in_array('build', $argv);\n${job}`,
    ...files,
  };
  for (const [name, content] of Object.entries(all)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), content);
  }
  const archive = execFileSync('tar', ['czf', '-', '-C', dir, 'bundle']);
  rmSync(dir, { recursive: true });
  return archive;
}

/** A container of the image with the stand-in build in it, gone when the test ends. */
async function runner(t) {
  const id = docker('create', '-p', '127.0.0.1::8080', IMAGE);
  t.after(() => docker('rm', '-f', id));
  docker('cp', path.join(import.meta.dirname, 'fake-mftf'), `${id}:/opt/mftf/fake`);
  docker('start', id);
  const url = `http://${docker('port', id, '8080')}`;
  for (let tried = 0; ; tried++) {
    if (await fetch(url).then((answer) => answer.ok, () => false)) break;
    assert.ok(tried < 50, 'the runner did not answer');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const sh = (script) => docker('exec', id, 'sh', '-c', script);
  const events = async (from = 0) => {
    const text = await (await fetch(`${url}/events?from=${from}`)).text();
    return text.trim().split('\n').map((line) => JSON.parse(line));
  };
  return {
    url,
    events,
    sh,
    start: (request = {}) =>
      fetch(`${url}/start`, {
        method: 'POST',
        body: JSON.stringify({ mftf: 'fake', selector: CEST, env: 'KEY=value', credentials: 'secret', ...request }),
      }),
    upload: (archive) => fetch(`${url}/bundle`, { method: 'PUT', body: archive }),
    /** Follows the run as it goes until it has said `text`. */
    async said(text) {
      const answer = await fetch(`${url}/events?from=0`, { signal: AbortSignal.timeout(10_000) });
      const reader = answer.body.pipeThrough(new TextDecoderStream()).getReader();
      for (let sofar = ''; ; ) {
        const { value, done } = await reader.read();
        assert.ok(!done, `the run ended without saying ${text}`);
        sofar += value;
        if (sofar.includes(JSON.stringify(text))) return reader.cancel();
      }
    },
  };
}

const lines = (events) => events.filter((event) => event.type === 'line').map((event) => event.text);

test('a run says what it prints, in order, and ends with its exit code', async (t) => {
  const run = await runner(t);
  assert.equal((await run.upload(bundle(`if (!$build) { echo "one\\ntwo\\n"; fwrite(STDERR, "three\\n"); exit(7); }`))).status, 204);
  assert.equal((await run.start()).status, 201);

  const events = await run.events();
  assert.deepEqual(events.map((event) => event.n), events.map((_, n) => n));
  assert.equal(events[0].type, 'started');
  assert.deepEqual(lines(events).filter((line) => line !== 'three'), ['one', 'two']);
  assert.ok(lines(events).includes('three'));
  assert.deepEqual({ type: events.at(-1).type, code: events.at(-1).code }, { type: 'ended', code: 7 });
});

test('a run is read again from any event', async (t) => {
  const run = await runner(t);
  await run.upload(bundle(`if (!$build) { echo "one\\ntwo\\n"; }`));
  await run.start();

  const all = await run.events();
  assert.deepEqual(await run.events(2), all.slice(2));
  assert.equal(all.at(-1).code, 0);
});

test('a run is laid out with its profile, and the profile is gone when it ends', async (t) => {
  const run = await runner(t);
  const job = `if (!$build) {
    echo file_get_contents(getenv('MFTF_STUDIO_ENV_DIR') . '/.env'), "\\n";
    echo file_get_contents(getenv('MFTF_STUDIO_TESTS_BP') . '/.credentials'), "\\n";
    echo getenv('MFTF_STUDIO_PROJECT'), ' ', getcwd(), "\\n";
  }`;
  await run.upload(bundle(job));
  await run.start();

  assert.deepEqual(lines(await run.events()), ['KEY=value', 'secret', '/work/project /work/ws']);
  assert.equal(run.sh('ls -A /dev/shm; ls -d /work/ws/env /work/ws/.credentials 2>/dev/null || true'), '');
});

test('what a run writes comes back in its results', async (t) => {
  const run = await runner(t);
  const job = `if (!$build) {
    mkdir('tests/_output/allure-results');
    file_put_contents('tests/_output/allure-results/one-result.json', '{}');
    file_put_contents(getenv('SESSIONS_FILE'), 'a session');
    echo getenv('not_a_name') === false ? 'refused' : 'taken', "\\n";
  }`;
  await run.upload(bundle(job));
  await run.start({ writes: ['SESSIONS_FILE', 'not_a_name'] });

  assert.deepEqual(lines(await run.events()), ['refused']);
  const results = Buffer.from(await (await fetch(`${run.url}/results`)).arrayBuffer());
  const listed = execFileSync('tar', ['tzf', '-'], { input: results, encoding: 'utf8' });
  assert.match(listed, /allure-results\/one-result\.json/);
  assert.match(listed, /written\/SESSIONS_FILE/);
});

test('capabilities, extensions and a suite reach the configuration Codeception reads', async (t) => {
  const run = await runner(t);
  const suite = 'generated/_generated/SomeSuite';
  await run.upload(
    bundle('', {
      'bundle/studio/brought.php': '<?php class Brought {}',
      [`bundle/${suite}/SomeCest.php`]: '<?php',
      [`bundle/${suite}/group.php`]: '<?php // the group',
    }),
  );
  await run.start({
    selector: `${suite}/SomeCest.php`,
    extensions: [{ file: 'brought.php', name: 'Brought' }],
    capabilities: { acceptInsecureCerts: false, 'goog:chromeOptions': { args: ['--one'] }, 'sauce:options': { name: 'a run', tags: {} } },
  });
  await run.events();

  const config = run.sh('cat /work/ws/codeception.yml');
  assert.match(config, /AllureCodeception\n {4}- Group\\SomeSuite\n {4}- Brought\n/);
  assert.match(config, /groups:\n {2}SomeSuite:\n {4}- generated\/_generated\/SomeSuite\//);
  assert.match(config, /bootstrap: \/work\/ws\/studio-bootstrap\.php/);
  assert.match(run.sh('cat /work/ws/studio-bootstrap.php'), /require_once '\/bundle\/studio\/brought\.php';/);
  assert.equal(run.sh('cat /opt/mftf/fake/src/Magento/FunctionalTestingFramework/Group/SomeSuite.php'), '<?php // the group');
  const capabilities = run.sh('cat /work/ws/tests/functional.suite.yml');
  assert.match(capabilities, /"acceptInsecureCerts": false/);
  assert.doesNotMatch(capabilities, /acceptInsecureCerts: true/);
  assert.match(capabilities, /"sauce:options": \{"name":"a run","tags":\{\}\}/);
  assert.match(capabilities, /"goog:chromeOptions": \{"args":\["--one"\]\}/);
  assert.doesNotMatch(capabilities, /--no-sandbox/);
});

test('a BiDi build runs in the BiDi workspace, and the hosts a run names are known to it', async (t) => {
  const run = await runner(t);
  run.sh('cp -r /opt/mftf/fake /opt/mftf/fake-bidi');
  const job = `if (!$build) {
    echo str_contains(file_get_contents('tests/functional.suite.yml'), 'WebDriverBiDi') ? 'bidi' : 'classic', "\\n";
    echo file_get_contents('/etc/hosts');
  }`;
  await run.upload(bundle(job));
  await run.start({ mftf: 'fake-bidi', hosts: { 'an.instance': '10.1.2.3', 'this.machine': 'gateway' } });

  const said = lines(await run.events());
  assert.equal(said[0], 'bidi');
  assert.ok(said.includes('10.1.2.3 an.instance'));
  assert.ok(said.some((line) => /^\d+\.\d+\.\d+\.\d+ this\.machine$/.test(line)));
});

test('a build the runner does not have ends the run saying so', async (t) => {
  const run = await runner(t);
  await run.upload(bundle(''));
  await run.start({ mftf: '9.9.9' });

  const events = await run.events();
  assert.deepEqual(lines(events), ['ERROR: the runner has no MFTF 9.9.9']);
  assert.equal(events.at(-1).code, 2);
});

test('a failed actor build is said, and ends the run before it starts', async (t) => {
  const run = await runner(t);
  await run.upload(bundle(`if ($build) { fwrite(STDERR, "no actor\\n"); exit(4); } echo "ran\\n";`));
  await run.start();

  const events = await run.events();
  assert.deepEqual(lines(events), ['no actor']);
  assert.equal(events.at(-1).code, 4);
});

test('a bundle that will not unpack is refused with what tar said', async (t) => {
  const run = await runner(t);
  const answer = await run.upload(Buffer.from('not an archive'));
  assert.equal(answer.status, 500);
  assert.match(await answer.text(), /not in gzip format/);
});

test('a second start is refused, and the run going is left as it was', async (t) => {
  const run = await runner(t);
  await run.upload(bundle(`if (!$build) { echo "going\\n"; while (!file_exists('/tmp/go')) usleep(50000); echo "done\\n"; }`));
  await run.start();
  await run.said('going');

  const second = await run.start();
  assert.equal(second.status, 409);
  run.sh('touch /tmp/go');
  const events = await run.events();
  assert.deepEqual(events.map((event) => event.n), events.map((_, n) => n));
  assert.deepEqual(lines(events), ['going', 'done']);
  assert.equal(events.at(-1).code, 0);
});

test('a stop with nothing to ask ends the run at once', async (t) => {
  const run = await runner(t);
  await run.upload(bundle(`if (!$build) { echo "going\\n"; sleep(60); }`));
  await run.start();
  await run.said('going');
  await fetch(`${run.url}/stop`, { method: 'POST' });

  const events = await run.events();
  assert.equal(events.at(-1).code, null);
  assert.ok(events.at(-1).at - events.at(-2).at < 5000);
});

test('a stop is left with the hold extension, which ends the test through its hooks', async (t) => {
  const run = await runner(t);
  const job = `if (!$build) {
    echo "Test: \\e[32mgenerated/_generated/default/SomeCest.php:Some\\e[39m\\ngoing\\n";
    while (!file_exists('/hold/stop-test')) usleep(50000);
    echo 'asked to stop ', file_get_contents('/hold/stop-test'), "\\n";
    exit(1);
  }`;
  await run.upload(bundle(job, { 'bundle/studio/studio-hold.php': '<?php class Hold {}' }));
  await run.start({ extensions: [{ file: 'studio-hold.php', name: 'Hold' }] });
  await run.said('going');
  await fetch(`${run.url}/stop`, { method: 'POST' });

  const events = await run.events();
  assert.deepEqual(lines(events).slice(2), [
    '--- the run is being stopped, and its <after> hooks left to run',
    'asked to stop SomeCest.php',
  ]);
  assert.equal(events.at(-1).code, 1);
});

test('a stopped suite is told so', async (t) => {
  const run = await runner(t);
  const job = `if (!$build) {
    echo "going\\n";
    while (!file_exists('/hold/stop-suite')) usleep(50000);
    echo "suite asked to stop\\n";
  }`;
  await run.upload(bundle(job, { 'bundle/studio/studio-hold.php': '<?php class Hold {}' }));
  await run.start({ selector: 'generated/_generated/default', extensions: [{ file: 'studio-hold.php', name: 'Hold' }] });
  await run.said('going');
  await fetch(`${run.url}/stop`, { method: 'POST' });

  const events = await run.events();
  assert.equal(lines(events).at(-1), 'suite asked to stop');
  assert.equal(events.at(-1).code, 0);
});

test('a run that outlasts the kill is ended outright', { timeout: 60_000 }, async (t) => {
  const run = await runner(t);
  await run.upload(bundle(`if (!$build) { pcntl_signal(SIGTERM, SIG_IGN); echo "going\\n"; sleep(60); }`));
  await run.start();
  await run.said('going');
  await fetch(`${run.url}/stop`, { method: 'POST' });

  const events = await run.events();
  assert.equal(events.at(-1).code, null);
  const waited = events.at(-1).at - events.at(-2).at;
  assert.ok(waited > 9000 && waited < 20_000, `ended ${waited} ms after its last line`);
});

test('a run killed from outside ends with what it had said, a half line included', async (t) => {
  const run = await runner(t);
  await run.upload(bundle(`if (!$build) { file_put_contents('/tmp/pid', getmypid()); echo "going\\nhalf"; sleep(60); }`));
  await run.start();
  await run.said('going');
  run.sh('kill -9 $(cat /tmp/pid)');

  const [one, other] = await Promise.all([run.events(), run.events()]);
  assert.deepEqual(one, other);
  assert.deepEqual(lines(one), ['going', 'half']);
  assert.deepEqual({ type: one.at(-1).type, code: one.at(-1).code }, { type: 'ended', code: null });
});

test('what a run leaves unfinished on its error output is said before it ends', async (t) => {
  const run = await runner(t);
  await run.upload(bundle(`if (!$build) { echo "out\\n"; fwrite(STDERR, "tail"); exit(3); }`));
  await run.start();

  const events = await run.events();
  assert.deepEqual(lines(events), ['out', 'tail']);
  assert.deepEqual({ type: events.at(-1).type, code: events.at(-1).code }, { type: 'ended', code: 3 });
});

test('output that cannot be collected ends the run saying so', async (t) => {
  const run = await runner(t);
  await run.upload(bundle(`if (!$build) { mkdir('tests/_output', 0777, true); symlink('/nowhere', 'tests/_output/dangling'); }`));
  await run.start();

  const events = await run.events();
  assert.match(lines(events).at(-1), /^ERROR: /);
  assert.deepEqual({ type: events.at(-1).type, code: events.at(-1).code }, { type: 'ended', code: 1 });
});

test('a run that reads its input is not kept waiting', async (t) => {
  const run = await runner(t);
  await run.upload(bundle(`if (!$build) { var_dump(fgets(STDIN)); }`));
  await run.start();

  assert.deepEqual(lines(await run.events()), ['bool(false)']);
});

test('a large bundle that will not unpack is refused with what tar said', async (t) => {
  const run = await runner(t);
  const refused = await fetch(`${run.url}/bundle`, { method: 'PUT', body: Buffer.alloc(2 * 1024 * 1024, 'x') });
  assert.equal(refused.status, 500);
  assert.match(await refused.text(), /tar exited with/);
});

test('a follower is handed nothing before the event it asked from', async (t) => {
  const run = await runner(t);
  await run.upload(bundle(`if (!$build) { sleep(1); echo "one\\ntwo\\nthree\\n"; }`));
  await run.start();

  const events = await run.events(3);
  assert.deepEqual(events.map((event) => event.n), [3, 4]);
});

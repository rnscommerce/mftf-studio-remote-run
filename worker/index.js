// Control plane, all of it: a Worker as the door, and one Durable Object per
// run that owns the run's container, keeps its log, and writes its usage.
import { Container } from '@cloudflare/containers';

const json = (body, status = 200) => Response.json(body, { status });

const LEDGER = 'CREATE TABLE IF NOT EXISTS usage (run TEXT PRIMARY KEY, started INTEGER, ended INTEGER, seconds REAL, code INTEGER)';

export default {
  async fetch(request, env) {
    if (!env.RUN_TOKEN || request.headers.get('Authorization') !== `Bearer ${env.RUN_TOKEN}`) return json({ error: 'Unauthorized' }, 401);
    const [, resource, id, tail] = new URL(request.url).pathname.split('/');

    if (resource === 'bundles' && id) {
      const key = `bundles/${id}`;
      if (request.method === 'HEAD') return new Response(null, { status: (await env.FILES.head(key)) ? 200 : 404 });
      if (request.method === 'PUT') return (await env.FILES.put(key, request.body), new Response(null, { status: 201 }));
    }
    if (resource === 'runs' && !id && request.method === 'POST') {
      const run = `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 4)}`;
      const start = new Request(`http://run/runs/${run}/start`, { method: 'POST', body: request.body });
      const started = await env.RUNS.get(env.RUNS.idFromName(run)).fetch(start);
      return started.ok ? json({ id: run }, 201) : started;
    }
    if (resource === 'runs' && id && tail === 'results') {
      const results = await env.FILES.get(`runs/${id}/results.tgz`);
      return results ? new Response(results.body) : json({ error: 'No results' }, 404);
    }
    if (resource === 'runs' && id && tail !== 'start') return env.RUNS.get(env.RUNS.idFromName(id)).fetch(request);
    if (resource === 'usage') {
      await env.LEDGER.exec(LEDGER);
      const { results } = await env.LEDGER.prepare('SELECT * FROM usage ORDER BY started').all();
      return json(results);
    }
    return json({ error: 'Not found' }, 404);
  },
};

export class Run extends Container {
  defaultPort = 8080;
  sleepAfter = '10m';

  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS events (n INTEGER PRIMARY KEY, body TEXT NOT NULL)');
    // A run this object was following or finishing before it was restarted is taken up again.
    const id = ctx.storage.kv.get('run');
    if (id && !ctx.storage.kv.get('finished')) ctx.waitUntil(this.pump(id));
  }

  count() {
    return this.ctx.storage.sql.exec('SELECT COUNT(*) AS c FROM events').one().c;
  }

  event(type) {
    const [row] = this.ctx.storage.sql.exec(`SELECT body FROM events WHERE body LIKE ? LIMIT 1`, `%"type":"${type}"%`).toArray();
    return row ? JSON.parse(row.body) : null;
  }

  // A run in progress is activity, whether or not anyone is asking for it.
  async onActivityExpired() {
    if (this.event('ended')) await this.stop();
  }

  async fetch(request) {
    const url = new URL(request.url);
    const [, , id, tail] = url.pathname.split('/');

    if (tail === 'start') {
      const { bundle, ...start } = await request.json();
      const files = await this.env.FILES.get(`bundles/${bundle}`);
      if (!files) return json({ error: 'Unknown bundle' }, 400);
      try {
        await this.startAndWaitForPorts();
        const unpacked = await this.send('/bundle', { method: 'PUT', body: await files.arrayBuffer() });
        if (!unpacked.ok) throw new Error(`The bundle could not be unpacked: ${await unpacked.text()}`);
        const started = await this.send('/start', { method: 'POST', body: JSON.stringify(start) });
        if (!started.ok) throw new Error(await started.text());
      } catch (error) {
        // A container with no run in it would otherwise stay up.
        await this.destroy().catch(() => {});
        return json({ error: error.message }, 502);
      }
      this.ctx.storage.kv.put('run', id);
      this.ctx.waitUntil(this.pump(id));
      return json({}, 201);
    }

    // Asks the run to end; the container says so itself once it has, and the
    // run is finished and metered the way one that ran to its end is.
    if (tail === 'stop') {
      if (!this.event('ended') && this.ctx.container.running) await this.send('/stop', { method: 'POST' });
      return json({});
    }

    if (request.headers.get('Upgrade') !== 'websocket') {
      return json({ events: this.count(), ended: Boolean(this.event('ended')) });
    }
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    const from = Number(url.searchParams.get('from') ?? 0);
    for (const { body } of this.ctx.storage.sql.exec('SELECT body FROM events WHERE n >= ? ORDER BY n', from)) server.send(body);
    return new Response(null, { status: 101, webSocket: client });
  }

  send(path, init) {
    return this.containerFetch(`http://run${path}`, init);
  }

  // Reads the container's lines from what is already held, so a broken read
  // picks up where it stopped and no line is stored twice.
  async pump(id) {
    if (this.pumping) return;
    this.pumping = true;
    while (!this.event('ended')) {
      // Asking a container that has gone would start an empty one in its place.
      if (!this.ctx.container.running) return this.lost();
      try {
        const response = await this.send(`/events?from=${this.count()}`);
        if (!response.ok) throw new Error(await response.text());
        let rest = '';
        for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
          const lines = (rest + chunk).split('\n');
          rest = lines.pop();
          for (const line of lines) this.hold(line);
        }
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
    if (!this.event('ended').lost) await this.finish(id);
  }

  // The container went with the run still going: the run ends as one that
  // could not run, with no results and nothing written to the ledger.
  lost() {
    if (this.event('ended')) return;
    const say = (event) => this.hold(JSON.stringify({ n: this.count(), at: Date.now(), ...event }));
    say({ type: 'line', text: 'ERROR: the runner was lost before the run ended' });
    say({ type: 'ended', code: null, lost: true });
  }

  onStop() {
    if (this.ctx.storage.kv.get('run')) this.lost();
  }

  hold(body) {
    if (JSON.parse(body).n !== this.count()) return;
    this.ctx.storage.sql.exec('INSERT INTO events (n, body) VALUES (?, ?)', this.count(), body);
    for (const watcher of this.ctx.getWebSockets()) watcher.send(body);
  }

  async finish(id) {
    // Asking a container that has gone would start an empty one in its place.
    if (this.ctx.container.running) {
      const results = await this.send('/results');
      if (results.ok) await this.env.FILES.put(`runs/${id}/results.tgz`, await results.arrayBuffer());
    }
    const started = this.event('started').at;
    const ended = this.event('ended').at;
    await this.env.LEDGER.exec(LEDGER);
    await this.env.LEDGER.prepare('INSERT OR IGNORE INTO usage VALUES (?, ?, ?, ?, ?)')
      .bind(id, started, ended, (ended - started) / 1000, this.event('ended').code)
      .run();
    this.ctx.storage.kv.put('finished', true);
    await this.stop();
  }
}

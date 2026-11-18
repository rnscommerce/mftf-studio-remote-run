# API

What MFTF Studio calls. Every call carries `Authorization: Bearer <API_KEY>`;
one without it is answered `401`.

| Call                           | Answers                                                                                  |
| ------------------------------ | ---------------------------------------------------------------------------------------- |
| `GET /`                        | `{api, runner, mftf}`: the API spoken, the runner's version, the MFTF builds it has      |
| `HEAD /snapshots/{sha}`        | `200` where that snapshot is held, `404` where it is not                                 |
| `PUT /snapshots/{sha}`         | `201`, the snapshot stored: a gzipped tar of what one run runs, named by its SHA-256     |
| `POST /runs`                   | `201 {id}`, the run started; `400` or `502 {error}` where it was not                     |
| `GET /runs/{id}`               | `{status, code, events}`: `running`, `ended` or `lost`, its exit code, the events said   |
| `GET /runs/{id}/events?from=n` | A WebSocket: each event from `n` on as a message, then each as it is said, until it ends |
| `POST /runs/{id}/stop`         | `200`, the run asked to end, its `<after>` hooks run first                               |
| `GET /runs/{id}/results`       | What the run left, as a gzipped tar; `404` until it has ended and they are stored        |

`api` is `1`. A Studio that speaks another refuses the service.

## Starting a run

```json
{
  "snapshot": "<sha>",
  "mftf": "6.0.1-bidi",
  "target": "generated/_generated/default/SomeCest.php",
  "env": "<the profile, as .env>",
  "credentials": "<as .credentials>",
  "capabilities": {},
  "extensions": [{ "file": "studio-hold.php", "name": "StudioHold" }],
  "outputs": ["MFTF_STUDIO_SESSIONS"]
}
```

- `mftf` is one of the builds `GET /` names.
- `target` is a Cest, or a suite's folder under `generated/_generated`.
- `capabilities` are merged into the browser's, a key named here replacing the
  runner's own.
- `extensions` are Codeception extensions, each a file of the snapshot's
  `studio` folder and the class it defines.
- `outputs` are environment variables the run is given a file through; the
  results hold each under `written/`, by name.

## Events

Each is JSON with `n`, counting from 0, and `at`, in milliseconds since 1970:

- `{"type": "started"}`
- `{"type": "line", "text": "…"}`
- `{"type": "ended", "code": 0}`, with `"lost": true` where the runner was lost
  before the run ended, and `code` then `null`

## Snapshot

| Path                 | Holds                                           |
| -------------------- | ----------------------------------------------- |
| `snapshot/project`   | The project's Data and Metadata XML and PHP     |
| `snapshot/generated` | `_generated/<default or suite>/<Test>Cest.php`  |
| `snapshot/studio`    | `studio-job.php` and the extensions a run names |

## Checking a deployed service

`CONTROL=https://<name>.<subdomain>.workers.dev API_KEY=… node scripts/smoke.mjs`
makes every call above, with no browser and no MFTF test.

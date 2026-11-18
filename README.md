# MFTF Studio remote runs

The service a remote run goes to: a Cloudflare Worker as the door, one Durable
Object per run that owns the run's container, keeps its log and writes its
usage, and the runner image that container starts from.

|            |                                                                        |
| ---------- | ---------------------------------------------------------------------- |
| `worker/`  | The Worker and the Run object                                          |
| `runner/`  | The image: PHP, every MFTF build Studio offers, and the run program    |
| `npx wrangler dev` | The whole service on this machine, the container on local Docker |
| `npm test` | The runner image driven over HTTP, with a stand-in for Codeception and no browser |
| `node scripts/smoke.mjs` | One run through a deployed service, with `CONTROL` and `RUN_TOKEN` set, and no browser |

A pull request is checked and tested. A push to `main` is too, then deploys,
then runs the smoke test against what it deployed. The image carries nothing of Studio's own: a run's
bundle brings Studio's PHP, and its start request names the MFTF build.

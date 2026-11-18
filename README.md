# MFTF Studio remote runs

Runs MFTF Studio's tests on your own Cloudflare account, so a run carries on
when Studio closes. Studio generates the tests on your machine and sends them
here; the run drives your BrowserStack or Sauce Labs browser against your
instance.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/rnscommerce/mftf-studio-remote-run)

## Before you install

- The account needs the Workers Paid plan: a run is a container, and Containers
  are not on the free plan.
- A run's browser comes from BrowserStack or Sauce Labs, through the profile you
  run with in Studio.
- The instance has to be reachable from the internet. A run's container has no
  fixed outbound address to allowlist, and provider tunnels are not supported.

## Install

1. Press **Deploy to Cloudflare** and sign in to the account to install on.
2. Give the Worker a name, or keep the one offered.
3. Enter an **API_KEY**: a long random value, such as the output of
   `openssl rand -base64 32`.
4. Deploy. The first build takes several minutes, most of it the runner image.

The install creates, under the name you gave it:

- a Worker, with a Durable Object for each run
- a container application, from `runner/Dockerfile`
- an R2 bucket for the tests sent and the results that come back
- a copy of this repository in your GitHub or GitLab account, which deploys on
  every push to its default branch

Then, in MFTF Studio, open **Environment › Remote runner**, add the Worker's
address (`https://<name>.<your subdomain>.workers.dev`) with the same API key,
and use **Check API key**.

## Keeping it up to date

Bring this repository's changes into your copy and push: the push deploys them.
A deploy that changes the runner image ends any run still going, so deploy
between runs.

## Changing the API key

In the Cloudflare dashboard, open the Worker, then **Settings › Variables and
Secrets**, and replace `API_KEY`. Or run `npx wrangler secret put API_KEY` from
your copy. Then enter the new key in Studio under **Configure**.

## Removing it

Delete the Worker, its container application and its R2 bucket from the
Cloudflare dashboard, and the copy of this repository if you no longer want it.

## What is here

|                          |                                                                                           |
| ------------------------ | ----------------------------------------------------------------------------------------- |
| `worker/`                | The Worker, which checks the API key, and the Run object, which owns a run's container   |
| `runner/`                | The image: PHP, every MFTF build Studio offers, and the program that runs Codeception      |
| `npx wrangler dev`       | The whole service on this machine, the container on local Docker, the key in `.dev.vars`  |
| `npm test`               | The runner image driven over HTTP, with a stand-in for Codeception and no browser         |
| `node scripts/smoke.mjs` | One run through a deployed service, with `CONTROL` and `API_KEY` set, and no browser      |

The image carries nothing of Studio's own: a run's bundle brings Studio's PHP,
and its start request names the MFTF build.

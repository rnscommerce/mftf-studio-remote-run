# MFTF Studio remote runs

Runs MFTF Studio's tests on your own Cloudflare account. A run carries on when
Studio closes, and Studio picks it up again when it opens.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/rnscommerce/mftf-studio-remote-run-cloudflare)

## Before you install

- The Cloudflare account needs the Workers Paid plan.
- Runs use your BrowserStack or Sauce Labs browsers, through the profile you
  run with in Studio.
- The instance under test has to be reachable from the internet. Allowlisting
  by address and provider tunnels are not supported.

## Install

1. Press **Deploy to Cloudflare** and sign in to the account to install on.
2. Give it a name, or keep the one offered.
3. Enter an **API_KEY**: a long random value, such as the output of
   `openssl rand -base64 32`.
4. Deploy. The first one takes several minutes.

It adds to your Cloudflare account a Worker, a container application and an R2
bucket under that name, and to your GitHub or GitLab account a copy of this
repository, which deploys whenever you push to it.

Then, in MFTF Studio, open **Environment › Remote runner**, add the Worker's
address (`https://<name>.<your subdomain>.workers.dev`) with the same API key,
and use **Check API key**.

## Keeping it up to date

Bring this repository's changes into your copy and push. Deploying ends any run
still going, so deploy between runs.

## Changing the API key

In the Cloudflare dashboard, open the Worker, then **Settings › Variables and
Secrets**, and replace `API_KEY`. Then enter the new key in Studio under
**Configure**.

## Removing it

Delete the Worker, its container application and its R2 bucket from the
Cloudflare dashboard, and your copy of this repository.

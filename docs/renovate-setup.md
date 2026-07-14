# Renovate — one-time GitHub App setup

Renovate (`.github/workflows/renovate.yml`) opens PRs via a **GitHub App
installation token** minted per run by
[`actions/create-github-app-token`](https://github.com/actions/create-github-app-token).
No long-lived PAT lives in repo secrets; the workflow can only act inside the
short-lived token's scope, and there is nothing to rotate.

**Where the full runbook lives.** This repo uses the same GitHub App
(`kaelys-js-renovate`) as `kaelys-js/stardust`. The step-by-step App creation,
private key generation, and secret setup are documented once in
[`kaelys-js/stardust/docs/renovate-setup.md`](https://github.com/kaelys-js/stardust/blob/main/docs/renovate-setup.md).
Follow that runbook if the App does not yet exist; otherwise it's already set
up and you only need to install it on this repo.

App URL (once created): <https://github.com/apps/kaelys-js-renovate>.

## Extending the installation to this repo

Two things must be true for this repo:

1. **The App is installed on `kaelys-js/claude-multiacct`.** Open
   <https://github.com/settings/installations>, click **Configure** next to
   `kaelys-js-renovate`, tick `kaelys-js/claude-multiacct` under **Repository
   access** (or use _All repositories_), and Save.
2. **The two secrets are set on this repo:**

   ```sh
   gh secret set RENOVATE_APP_CLIENT_ID \
     --repo kaelys-js/claude-multiacct \
     --body "<the-client-id>"

   gh secret set RENOVATE_APP_PRIVATE_KEY \
     --repo kaelys-js/claude-multiacct \
     < ~/Downloads/<the-downloaded-key>.pem
   ```

   The `.pem` goes into the second secret via stdin — `gh` reads the file's
   bytes as the secret value verbatim (leading `-----BEGIN…` and all).

## Permission that already tripped us once

The App's **Commit statuses** permission must be **Read AND WRITE** (not just
Read). Renovate polls `GET /commits/{sha}/statuses` AND writes a
stability/cool-down status via `POST /statuses/{sha}`. Missing write access
returns 403 and Renovate aborts with the misleading `Repository has changed
during renovation - aborting` message, which reads like a race condition but
is actually a missing scope. If the App was set up correctly for stardust,
this is already fixed org-wide.

## Verify with a manual run

```sh
gh workflow run renovate.yml --repo kaelys-js/claude-multiacct

sleep 5
LATEST=$(gh run list --repo kaelys-js/claude-multiacct --workflow renovate.yml \
  --limit 1 --json databaseId --jq '.[0].databaseId')
gh run watch --repo kaelys-js/claude-multiacct "$LATEST"
```

If no eligible updates exist, the first run may open nothing at all — that's
fine. The workflow logs will confirm Renovate finished cleanly.

For any other symptom (Bad credentials, Integration unauthorized, workflow
push denied), follow the **Troubleshooting** section in stardust's runbook —
the causes and fixes are identical across the shared App.

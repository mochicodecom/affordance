# Publishing Affordance

Updated: 2026-09-13

Release `@affordance/core` and `@affordance/pg` together at the same version by
pushing a version tag. GitHub Actions builds, checks, and publishes both packages
to npm. Do not run local `npm publish` or `pnpm release:publish` for routine
releases or to recover a failed workflow. Both packages already exist on npm;
first-publication account setup is complete.

The root, reference app, UI, and testkit remain private. Public packages contain
compiled ESM, TypeScript declarations, source maps with embedded source, a README,
and the MIT license.

## What each workflow does

| Workflow | Trigger | Behavior | npm publishing authorization |
| --- | --- | --- | --- |
| [`ci.yml`](../.github/workflows/ci.yml) | Pull requests and pushes to `main` | Runs `pnpm release:check` | Not needed; does not publish |
| [`release.yml`](../.github/workflows/release.yml) | Pushed tags matching `v*` | Verifies package versions, runs `pnpm release:check`, then `pnpm release:publish` | Trusted publisher for `release.yml`, environment `npm`, and `id-token: write` |

A green CI run verifies the code and package artifacts. It does not verify npm
publishing permissions. The tag workflow publishes core first, then Postgres,
with public access and the `latest` npm tag. It does not create a GitHub release
page; that is a separate final step after both packages publish.

## Trusted publisher configuration

Configure this separately for **each package**, `@affordance/core` and
`@affordance/pg`, under its npm **Settings → Trusted Publisher** section:

| Field | Value |
| --- | --- |
| Provider | **GitHub Actions** |
| Organization or user | `mochicodecom` |
| Repository | `affordance` |
| Workflow filename | `release.yml` |
| Environment name | `npm` |
| Allowed actions | Enable **direct publishing with `npm publish`** |

Enter only `release.yml`, without the `.github/workflows/` prefix. Although the
environment field is optional in npm's form, fill in `npm` to match this workflow.
Allowing only staged publishing is insufficient: the workflow publishes directly.
Configuring core does not authorize publication of the Postgres package.

The GitHub repository must have an environment named `npm`. The release job uses
GitHub-hosted runners, Node 24, npm 11, and `id-token: write`. npm exchanges the
job's OIDC identity for short-lived publishing credentials and generates
provenance. No `NPM_TOKEN` secret or local npm login is needed. See
[npm's trusted publishing documentation](https://docs.npmjs.com/trusted-publishers/).

## Prepare and validate

1. Set the same unused version in `packages/core/package.json` and
   `packages/pg/package.json`. Update public documentation and note any breaking
   changes. Leave private package versions alone.
2. Use Node 24 and the repository's pinned pnpm. Install dependencies and update
   the lockfile if needed, then validate with Postgres running:

   ```bash
   pnpm install
   pnpm db:up
   pnpm release:check
   ```

3. Open a PR containing the version and documentation changes. Wait for its CI
   to pass, merge it, then wait for CI on the resulting `main` commit to pass.
   Record that exact commit SHA for the release tag.

`release:check` runs lint, typechecking, the reference UI build, and the full test
suite. It builds and packs both public packages using pnpm, replacing
`workspace:*` dependencies with release versions. An isolated consumer installs
those tarballs, checks public types with `skipLibCheck: false`, and exercises
scoped engine execution, guard refusals, and journal records with Postgres.

Tarballs, SHA-512 checksums, and a successful smoke-test receipt are written to
ignored `dist/npm/`. `pnpm release:pack` replaces that directory and invalidates
the receipt; `pnpm release:smoke` retests the current artifacts. The publisher
requires a receipt matching the tarballs' checksums and does not rebuild between
checking and uploading them. CI installs with `--frozen-lockfile`.

Tests and the consumer use the disposable `affordance_test` database by default.
Set `TEST_DATABASE_URL` to use another test database; the suite creates it if
needed. The consumer adds a case and journal entries.

## Tag and publish

Run the GitHub CLI commands from this repository with an authenticated GitHub
account. In the examples below, replace `0.4.1` with the unused version prepared
above and `VERIFIED_MAIN_COMMIT` with its green, merged commit SHA. Do not reuse
the already-published `v0.4.0` tag.

```bash
git fetch origin main --tags
git tag -a v0.4.1 VERIFIED_MAIN_COMMIT -m "Affordance 0.4.1"
git push origin v0.4.1
gh run list --workflow release.yml --branch v0.4.1
```

Select the run for the pushed tag, confirm its commit SHA, and wait for it to
finish. Replace `RUN_ID` below with that run's ID:

```bash
gh run view RUN_ID --json headSha,headBranch,status,conclusion,url
gh run watch RUN_ID --exit-status
```

The tag must be exactly `v` followed by both package versions. Confirm the
publication step succeeded and the version is available for both
[`@affordance/core`](https://www.npmjs.com/package/@affordance/core?activeTab=versions)
and [`@affordance/pg`](https://www.npmjs.com/package/@affordance/pg?activeTab=versions).
A pushed tag or a successful build alone does not mean publication completed.

## Finish the GitHub release

After both npm versions are available, write release notes covering the changes,
breaking APIs or schema requirements, and validation. Create the GitHub release
from the existing tag, using the actual notes file path:

```bash
gh release create v0.4.1 --verify-tag --latest \
  --title "Affordance 0.4.1" --notes-file /path/to/release-notes.md
```

If a draft already exists, update its notes and publish it instead:

```bash
gh release edit v0.4.1 --notes-file /path/to/release-notes.md
gh release edit v0.4.1 --draft=false --latest
```

Verify the result with `gh release view v0.4.1 --json isDraft,url,tagName`.
Keep the release as a draft while either npm package remains unpublished.

## Recover a failed tag workflow

Read the failing step before retrying:

```bash
gh run view RUN_ID --log-failed
```

If npm rejects an existing package with a permissions-related `E404`, check that
package's trusted-publisher configuration against the table above. Successful
publication of core does not prove that pg is configured. Correct the affected
package's settings, then rerun the failed job on the **same tag and commit**:

```bash
gh run rerun RUN_ID --failed
gh run watch RUN_ID --exit-status
```

The rerun rebuilds and checks the tagged source. For each version already on
npm, the publisher compares the registry's SHA-512 integrity with the new
artifact. Identical packages are skipped, and missing packages are published.
If it reports different contents for an existing version, stop and investigate;
do not bypass the integrity check, overwrite a version, or move the tag. Code
changes require a new version and tag.

This recovery was verified for 0.4.0: core published, pg was rejected, then the
same workflow succeeded after pg's trusted publisher was configured. Core was
verified and skipped; pg was published through GitHub Actions. Once the rerun
passes, verify both npm versions and finish the GitHub release as described above.

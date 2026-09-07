# Publishing Affordance

Updated: 2026-09-06

Publish `@affordance/contract`, `@affordance/core`, and `@affordance/http` together
at the same version, starting with `0.1.0`. The root, reference app, UI, and
testkit remain private. Packages contain compiled ESM, TypeScript declarations,
source maps with embedded source, a README, and the MIT license.

## Verify a release

Use Node 24 and the repository's pinned pnpm. Postgres must be running:

```bash
pnpm install --frozen-lockfile
pnpm db:up
pnpm release:check
```

The check runs lint, typechecking, the reference UI build, and the full test
suite. It then builds and packs the public packages using pnpm, which replaces
`workspace:*` dependencies with their release versions. A consumer outside the
workspace installs those exact tarballs, checks their public types with
`skipLibCheck: false`, and exercises a scoped step through Postgres and HTTP.
It also verifies guard refusals and journal records.

Tarballs, SHA-512 checksums, and the successful smoke-test receipt are written
to ignored `dist/npm/`. `pnpm release:pack` replaces that directory and
invalidates the receipt. `pnpm release:smoke` retests the current artifacts.
The upload command requires a receipt matching the tarballs' checksums.

The Postgres tests and consumer default to the disposable `affordance_test`
database. Set `TEST_DATABASE_URL` to use another test database; the test suite
creates it if needed. The consumer adds a case and journal entries.

## First publication

The publishing account must control the `@affordance` scope. An npm username or
organization named `affordance` owns that scope. To create an organization,
choose **Add an Organization** on npm, enter `affordance`, and select the free
public packages plan if the name is available. See
[npm's organization guide](https://docs.npmjs.com/creating-an-organization/).

After verifying the artifacts:

```bash
npm login
npm whoami
pnpm release:publish
```

Complete npm's authentication or two-factor prompt in your terminal. This
uploads the tested tarballs in dependency order: contract, core, then HTTP,
with public access and the `latest` tag. It never rebuilds during publication.
If an upload fails, rerun with the same artifacts: already-published versions
are skipped only when their registry checksum matches.

## Enable releases from GitHub

After creating the packages, configure a trusted publisher in **Settings →
Trusted publishing** for each of the three packages on npm:

| Field | Value |
| --- | --- |
| Provider | GitHub Actions |
| Organization or user | `mochicodecom` |
| Repository | `affordance` |
| Workflow filename | `release.yml` |
| Environment | `npm` |
| Allowed action | Direct publishing with `npm publish` |

Create the `npm` environment in the GitHub repository settings. The workflow
uses GitHub-hosted runners, Node 24, npm 11, and `id-token: write`. npm obtains
short-lived publishing credentials from GitHub; no `NPM_TOKEN` secret is needed.
With npm 11.19+, the same package setup is available from the CLI:

```bash
npm trust github @affordance/contract --file release.yml --repo mochicodecom/affordance --env npm --allow-publish
npm trust github @affordance/core --file release.yml --repo mochicodecom/affordance --env npm --allow-publish
npm trust github @affordance/http --file release.yml --repo mochicodecom/affordance --env npm --allow-publish
```

For a public repository and public packages, npm generates provenance during
trusted publishing. See [npm's trusted publishing documentation](https://docs.npmjs.com/trusted-publishers/).

## Subsequent releases

1. Set the same new version in the three public `package.json` files. Update
   their READMEs if the public API changed.
2. Run `pnpm install`, then `pnpm release:check`. Commit and push the changes.
3. Tag that commit with its version and push the tag, for example:

   ```bash
   git tag v0.1.1
   git push origin v0.1.1
   ```

The release workflow checks that the tag matches all three versions, repeats
the release checks, and uploads the tested tarballs. A normal branch push runs
the same checks without publishing. Never reuse a version for changed contents.

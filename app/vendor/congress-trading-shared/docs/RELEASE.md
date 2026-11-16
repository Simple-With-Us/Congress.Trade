# Release Process

This public package is distributed only as a tokenless Git dependency. There is no npm registry
publish. Production consumers use an exact immutable tag, and the tag, `package.json` version, and
installed package version must agree.

## 1. Prepare the release PR

1. Start from current `origin/main` on an owned branch and confirm unrelated work is preserved.
2. Bump `version` in both `package.json` and `package-lock.json` according to SemVer.
3. Update `CHANGELOG.md` and the relevant effort-log rows.
4. Run the local gates:

   ```bash
   npm ci
   npm run typecheck
   npm test -- --coverage
   npm run build
   npm run lint:package
   npm audit
   npm audit signatures
   npm run pack:dry
   ```

5. Open a PR. Do not merge until the required `verify` check is green and all review threads are
   resolved. That check installs the PR's exact Git commit with registry tokens unset, exercises the
   Git `prepare` lifecycle, loads both CJS and ESM exports, and compiles NodeNext and Bundler consumers.

## 2. Tag the merged commit

Announce the release in `#ag***-s**c`, then create an annotated tag on the merged `main` commit.
Never move or reuse an existing release tag.

```bash
version="$(node -p 'require("./package.json").version')"
test "$(git branch --show-current)" = main
test -z "$(git status --porcelain)"
git pull --ff-only origin main
git tag -a "v${version}" -m "v${version}"
git push origin "v${version}"
```

## 3. Verify the exact tag tokenlessly

Use an isolated home and cache so the proof does not depend on existing credentials or mutate a
consumer checkout:

```bash
version="$(node -p 'require("./package.json").version')"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
mkdir -p "$scratch/home" "$scratch/cache"
env -u NODE_AUTH_TOKEN -u NPM_TOKEN -u GH_PACKAGES_TOKEN -u GITHUB_TOKEN \
  HOME="$scratch/home" npm_config_cache="$scratch/cache" \
  npm install --prefix "$scratch" \
  "git+https://github.com/Simple-With-Us/congress-trading-shared.git#v${version}"
test "$(node -p "require('$scratch/node_modules/@jaywedgeworth22/congress-trading-shared/package.json').version")" = "$version"
node -e "require('$scratch/node_modules/@jaywedgeworth22/congress-trading-shared')"
(cd "$scratch" && node --input-type=module \
  -e "import('@jaywedgeworth22/congress-trading-shared')")
```

Lifecycle scripts must remain enabled: this source-only Git package builds `dist/` in `prepare`, so
`--ignore-scripts` is unsupported. `private: true` prevents accidental registry publication but does
not prevent `npm pack` or Git dependency installation.

## 4. Coordinate consumer adoption

Post the immutable tag and verification receipt to `#ag***-s**c`. Consumer-owned PRs must update
both the exact dependency and its lockfile entry, then pass their own gates:

- Congress.Trade: `app/package.json` and `app/package-lock.json`.
- Socratic.Trade: root `package.json` and `package-lock.json`.

Do not edit a consumer from this repository lane unless that consumer is explicitly placed in scope.

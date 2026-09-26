# Release process

## Versioning

One version for the whole repository: every `package.json` and `apps/extension/manifest.json`. Semantic versioning; Chrome requires each store upload to have a higher version.

```bash
npm run version:set -- 0.3.0     # writes all package.json files and manifest.json
npm install                      # updates package-lock.json
npm run check:versions
```

## Cut a release

1. Update `CHANGELOG.md`.
2. `npm run verify` locally.
3. Merge to `main` with a green CI run.
4. Tag and push:

   ```bash
   git tag v0.3.0
   git push origin v0.3.0
   ```

5. `.github/workflows/release.yml` then:
   - checks the tag equals the package and manifest versions,
   - runs a clean `npm ci` and `verify`,
   - builds the release package (`PIGEONBOX_RELEASE=1`),
   - rebuilds from scratch and fails if the ZIP's SHA-256 differs (reproducibility),
   - creates the GitHub Release with `PigeonBox-v0.3.0.zip` and `PigeonBox-v0.3.0.sha256`.

6. Upload the same ZIP to the Chrome Web Store dashboard (manual, see [chrome-web-store.md](chrome-web-store.md)).

## Reproducibility

`scripts/lib/zip.mjs` sorts entries, fixes timestamps to 1980-01-01 and writes no OS attributes. Given the same lockfile and Node.js version (`.nvmrc`), the ZIP is byte-identical. Users can check a download with:

```bash
shasum -a 256 -c PigeonBox-v0.3.0.sha256
```

## What is in the ZIP

Only the release build output in `apps/extension/dist-release`, minus anything `isExcludedFromPackage` matches. See the checks in [chrome-web-store.md](chrome-web-store.md).

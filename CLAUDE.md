# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration**: a Node.js service (Node 22+, ESM,
no build step) that runs in its own sandboxed Docker container and talks to
Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency. It started from the official JavaScript template.
It reads air-Q air quality sensors through their local HTTP API (answers
protected with AES-256 by the device password), read only, after the maker's
Python library aioairq (Apache-2.0).

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/app.test.js              # one file
node --test --test-name-pattern "429"     # tests whose name matches
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npx github:GladysAssistant/integration-store .   # store admission checks
```

The CI (`.github/workflows/ci.yml`) runs `format:check`, `lint` and `test` on
Node 22 and 24, and builds the Docker image: run the three commands before
pushing.

## Architecture

```
index.js                          SDK wiring only: handlers registered before connect()
src/app.js                        AirQApp: air-Q to read, due times, pauses, devices, states, status, test
src/airq.js                       the read routes of the local API, error kinds, device info
src/cipher.js                     AES-256-CBC of the local API (port of aioairq encrypt.py)
src/readings.js                   documents -> values, devices, states (pure)
src/store.js                      pauses and refusals persisted in /data (never the password)
src/config.js                     DEFAULT_CONFIG (mirrors the manifest defaults) + normalization
src/http.js                       fetch with timeout, no redirection, bounded body
gladys-assistant-integration.json manifest: name, config_schema, actions, image...
docs/en.md, docs/fr.md            user documentation, re-hosted by Gladys (mandatory)
test/                             node --test, against the SDK's fake Gladys (integration-sdk/testing)
.github/scripts/release.mjs       release helpers (manifest bump, changelog), tested in test/
.github/scripts/cover.mjs         draws cover.png with Node alone
```

## Rules

- **Read only.** Never call a writing route of the air-Q (POST `/config`,
  `/blink`...): `readRoute` refuses any route but `config`, `data`,
  `average`.
- **The password never leaves the integration**: not in a URL, a log, an
  error, a status nor `/data` (only a salted scrypt fingerprint there).
  Never describe a secret field as "encrypted": Gladys keeps it in clear in
  its database (`test/manifest.test.js` checks the manifest and the docs).
- **External ids are forever.** Build them with
  `gladys.externalIds(type, platformId)`, `platformId` being the device id
  of the air-Q, never a label nor the address. The same goes for every key
  users store: manifest `config_schema`, `actions`, feature keys (the air-Q
  field names).
- **Units of the core only** (`DEVICE_FEATURE_UNITS_BY_CATEGORY`), and never
  drop a feature of a created device from the Discovery list.
- **The container rootfs is read-only.** Write only under `/data`, the one
  writable volume.
- **Versions belong to the Release workflow** (Actions → Release). Never edit
  `version` in `package.json` or in the manifest, nor the `docker_image` tag,
  by hand (the first version, 0.1.0, was set by hand once, see TODO.md).
  `test/manifest.test.js` checks they agree.
- **Changelog.** Every user-visible change adds a line under `## [Unreleased]`
  in `CHANGELOG.md` (`### Added`, `Changed`, `Fixed`, `Removed`, `Security`).
  Never write a version heading: the Release workflow moves the section, and it
  becomes the notes of the GitHub Release.
- **Manifest.** Texts are multi-language objects `{ "en": ..., "fr": ... }`:
  `label`, `description` and `placeholder` alike, never a plain string. The
  catalog `description` holds 10 to 100 characters per language.
- **User-facing text** is bilingual (English and French): action messages,
  manifest texts, and `docs/en.md` / `docs/fr.md`, kept in sync.
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never touch the network.

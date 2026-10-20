# gladys-air-q

[Gladys Assistant](https://gladysassistant.com) external integration for the
[air-Q](https://www.air-q.com) air quality sensors: CO2, VOC, PM2.5, PM10,
the gases your model measures (CO, NO2, O3, SO2, formaldehyde), temperature,
humidity, pressure and noise, read from the device on the local network (no
cloud, no account). Read only. **Unofficial, not affiliated with Corant
GmbH. Never tested with a real air-Q yet.**

User documentation: [docs/en.md](docs/en.md) · [docs/fr.md](docs/fr.md).

## How it works

```
Gladys ⇄ SDK ⇄ src/app.js (AirQApp)   what is due, pauses, devices, states, status, test button
                 ├─ src/airq.js        GET /config, /data, /average; error kinds
                 ├─ src/cipher.js      AES-256-CBC of the local API (port of aioairq's AES module)
                 ├─ src/readings.js    documents -> values, devices, states (pure)
                 ├─ src/store.js       pauses and refusals persisted in /data (never the password)
                 └─ src/http.js        fetch, timeout, no redirection, bounded body
```

- **Local API**: `GET http://<address>/<route>` answers `{"content": "<base64>"}`;
  the content is AES-256-CBC (IV in front, PKCS#7) with a key taken from the
  device password ("0"-padded or cut to 32 bytes). A content that does not
  open means a wrong password.
- **Reads**: `/config` once (id, name), then `/average` (or `/data`) every
  2 minutes by default.
- **Pauses**: 429/5xx → `Retry-After`, else 5 minutes doubling, between
  1 minute and 6 hours; a refused password → one try every 6 hours (or at
  once with a new password). Both persisted in `/data/air-q-state.json`
  with a salted scrypt fingerprint of the password, never the password.
- **Devices**: one per air-Q, external id `airq:<device id>`, then the air-Q
  field (`co2`, `tvoc`, `pm2_5`, `co`, `sound`...). A feature once created is
  never dropped from the Discovery list.

No runtime dependency besides the Gladys SDK (Node's `crypto` and `fetch`).

## Development

```bash
npm install
npm test                                        # node --test, no network, no disk
npm run lint && npm run format:check
npm run audit                                   # npm audit --omit=dev
npx github:GladysAssistant/integration-store .  # store admission checks
node .github/scripts/cover.mjs                  # draws cover.png (no dependency)
```

The test answers are built with the real cipher from example documents shaped
after aioairq and Home Assistant's air-Q integration.

## Releasing

**Actions → Release → Run workflow** (patch / minor / major): bumps the
version in `package.json` and the manifest, rolls `CHANGELOG.md`, tags,
builds the multi-arch image to GHCR and publishes the GitHub Release.

## Credits

- [aioairq](https://github.com/CorantGmbH/aioairq) (Apache-2.0, Corant GmbH,
  the maker of the air-Q): the protection of the local API, the routes and
  the handling of the values are ported to JavaScript; its notice is in
  [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## License

Apache-2.0 ([LICENSE](LICENSE)). air-Q is a trademark of its owner.

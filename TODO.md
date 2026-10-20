# TODO

## Before announcing

- [ ] Test on a real Gladys 5.1+ with a real air-Q: the devices of the
      Discovery tab, their values, the status, the test button, a wrong
      password, the device restarting. Never done yet.
- [ ] Check the CI (Docker build, Node 22 and 24), then run the store
      validator once the image is published (at milestone 1 its only
      expected error is `docker_image` not yet pullable from GHCR). The
      validator was not run by the development agent (no access to it) and
      the Docker image was never built locally (no Docker on the
      development PC).
- [ ] Turn on "Private vulnerability reporting" (SECURITY.md points there).
- [ ] Add the `gladys-assistant-integration` topic to publish in the store.

## To confirm on a real device

- [ ] The exact answer of `/average` and `/data` of a recent firmware: the
      keys (`pm2_5` or `pm2_5_SPS30`, `sound`, `sound_max`, `ch2o_M10`), the
      `[value, uncertainty]` pairs, the `Status` while warming up.
- [ ] The HTTP status of an air-Q that is busy or restarting (429, 503?)
      and whether it sends `Retry-After`. Both are handled.
- [ ] Whether the air-Q ever answers anything else than 200 with a wrong
      password (aioairq only sees the content that does not open).
- [ ] The unit of `co` (aioairq / Home Assistant: mg/m³) and therefore the
      ppm conversion (× 24.45 / 28.01).
- [ ] Whether `<id>_air-q.local` resolves from the integration container
      (usually not: the docs ask for a fixed IP).

## Waiting for the Gladys core

- [ ] Radon (Bq/m³): the core has the `becquerel-per-cubic-meter` unit but no
      category that lists it in `DEVICE_FEATURE_UNITS_BY_CATEGORY`.
- [ ] Oxygen (%), PM1, the particle counts (`cnt0_3`...), the typical
      particle size, absolute humidity (g/m³), the "health" and
      "performance" indexes (0-1000), the virus and mold indexes, the rarer
      gases of the air-Q Science (`h2s`, `nh3_MR100`, `ch4_MIPEX`...): no
      category for them yet.

## Decisions

- **Version 0.1.0 set by hand** in `package.json`, `package-lock.json`, the
  manifest and the `docker_image` tag (`ghcr.io/lm1lc3n7/gladys-air-q:0.1.0`);
  the first patch release gives 0.1.1.
- **aioairq 0.6.0 (Apache-2.0, Corant GmbH, the maker) as the reference**,
  license read in its LICENSE file: the AES part of `encrypt.py` (key from
  the password "0"-padded or cut to 32 bytes, AES-256-CBC, IV in front,
  strict PKCS#7, a failure read as a wrong password), the read routes of
  `core.py`, the device info, `[value, uncertainty]`, the `_SPS30` suffix,
  the clipping of negative values, the warm-up status. Ported to JavaScript
  on `node:crypto`, credited in the docs and in `THIRD_PARTY_NOTICES.md`
  with the whole Apache-2.0 text (copied into the image with `LICENSE`).
  Its AES tests are ported too.
- **Read only**: only `GET /config`, `/data`, `/average`; none of the
  writing routes (POST `/config`: restart, shutdown, night mode, LED,
  device name, network) nor `/blink`. No command, so no sensitive command.
- **No runtime dependency** besides the Gladys SDK.
- **Up to three air-Q**, one address and one `secret` password field each
  (`airq_<n>_address`, `airq_<n>_password`): each device has its own
  password. A slot with an address but no password, a bad address or an
  address entered twice is reported in the status by its number only.
- **Addresses**: IPv4 or host name, optional port, a tolerated `http://`
  and trailing `/`; the 5-hex id becomes `<id>_air-q.local` (aioairq). No
  path, no credentials, no IPv6 (the air-Q has none). No redirection is
  followed. The URL never carries the password.
- **External ids**: `airq:<config.id>` (the device id, kept to
  `[a-z0-9]{5,64}`, lower-cased), then the air-Q field name. The address
  may change (DHCP) without changing the device. Two addresses giving the
  same id: only the first is published, the other says "same air-Q".
- **Categories and units of the core only** (`DEVICE_FEATURE_UNITS_BY_CATEGORY`
  of `server/utils/constants.js`, checked by `test/manifest.test.js` and the
  SDK's fake Gladys): `co2-sensor`/ppm, `voc-sensor`/ppb (`tvoc`,
  `tvoc_ionsc`), `pm25-sensor` and `pm10-sensor`/µg/m³,
  `co-sensor`/ppm (converted from mg/m³ × 24.45 / 28.01, 25 °C, 1 atm),
  `no2-sensor`, `o3-sensor`, `so2-sensor`, `formaldehyd-sensor`/µg/m³,
  `temperature-sensor`/celsius, `humidity-sensor`/percent,
  `pressure-sensor`/hPa. `noise-sensor` has no list in the core: its own
  `decibel` unit is used (as for the core's Netatmo and the approved
  Homey and Fibaro modules).
- **Left out**: the dew point (a `temperature-sensor` would skew the room
  temperature of Gladys), `pressure_rel`, and every value without a core
  category (see above).
- **Values**: averaged by default (`/average`, the default of aioairq and
  Home Assistant), momentary as an option. A value out of the feature
  bounds is left out, never clamped; a negative concentration reads 0 (as
  aioairq), a negative temperature stays. Never NaN, null or undefined
  published. Only known own keys are read (`Object.hasOwn`): no prototype
  pollution.
- **Features never lost**: the Discovery device holds every field ever read
  plus every feature of the created device (`gladys.devices`), so a sensor
  warming up never makes the core see a changed structure.
- **Pace**: 2 minutes by default (1 to 60); one read at a time across all
  air-Q (the test button waits its turn); `/config` once per address (and
  after a password change), then one request per read.
- **Errors**: a passing failure (network, another HTTP status, not an air-Q
  answer) is retried at the interval, never sooner; 429/5xx pause the device
  (`Retry-After`, else 5 min doubling, clamped to 1 min - 6 h, never shorter
  than the interval); a content that does not open is a refused password:
  no read for 6 hours (the test button may try at once, never during a
  429/5xx pause), at once with a new password. The outcome of a read of a
  previous configuration never touches the current one.
- **Persisted state (`/data/air-q-state.json`)**: per configured address,
  the end of the pause, the 429/5xx streak, the end of the refusal and, for
  a refusal only, a salted scrypt fingerprint of the password (16 bytes, a
  random salt per file) to know after a restart whether it is still the
  refused password. Never the password. Times read back are capped at a
  fresh pause (6 h). Written atomically; an unreadable file is warned once
  and ignored; a write failure is warned once, then memory only.
- **A reconnection to Gladys** (`connected`) keeps the pauses, the refusals,
  the device info and the due times; the status and the Discovery list are
  published again every time (the core keeps them in memory only).
- **Secrets**: the password is described as "kept by Gladys in its database,
  never shown again"; it never leaves the integration (it only opens the
  answers), is never logged (messages scrubbed as well), never in `/data`,
  a status or an error. The docs never call a secret field "encrypted".
- **Bounded answers**: 256 KB, 10 s per request; error messages carry the
  host and a short reason only.

## Ideas

- The air-Q cloud API (not needed: everything is local).
- The historical files of the SD card (aioairq `get_historical_file`).
- An option to publish the dew point anyway, once Gladys can keep it out of
  the room temperature.

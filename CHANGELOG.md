# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- Your air-Q sensors in Gladys, read on the local network (no cloud, no
  account), up to three, each with its address and device password: CO2,
  VOC, PM2.5, PM10, carbon monoxide, nitrogen dioxide, ozone, sulphur
  dioxide, formaldehyde, temperature, humidity, pressure and noise, as the
  model measures them. Read only: nothing is ever changed on the device.
- Averaged (default) or momentary values, read every 2 minutes by default.
- A 429 or 5xx from an air-Q pauses its reads (Retry-After, else 5 minutes
  doubling, between 1 minute and 6 hours); a refused password stops them,
  with one new try every 6 hours until it changes. Both survive a restart
  (kept under `/data` with a salted fingerprint of the password, never the
  password).
- A connection status that names the air-Q without value and why, and a
  "Test the air-Q" button that reads them all and shows their values.

[Unreleased]: https://github.com/LM1LC3N7/gladys-air-q/commits/main

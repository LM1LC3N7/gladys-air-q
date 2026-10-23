# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [0.1.2] - 2026-10-23

## [0.1.1] - 2026-10-20

### Added

- Your air-Q sensors in Gladys, read on the local network (no cloud, no
  account), up to three, each with its address and device password: CO2,
  VOC, PM2.5, PM10, carbon monoxide, nitrogen dioxide, ozone, sulphur
  dioxide, formaldehyde, temperature, humidity, pressure and noise, as the
  model measures them. Read only: nothing is ever changed on the device.
- Averaged (default) or momentary values, read every 2 minutes by default,
  never faster: not by the test button, a reconnection, a saved
  configuration nor a restart (the instant of the last request is kept
  under `/data`); only a new address or password is read at once.
- The values are published only under the air-Q that measured them (the id
  of each answer is checked): two air-Q that swap their addresses never mix
  their values. The known devices stay in the Discovery tab after a
  restart.
- A 429 or 5xx from an air-Q pauses its reads (Retry-After, else 5 minutes
  doubling, between 1 minute and 6 hours); a refused password stops them,
  with one new try every 6 hours until it changes. Both survive a restart
  (kept under `/data`, never the password; only while a password is
  refused, a salted fingerprint of that wrong password).
- A connection status that names the air-Q without value and why, and a
  "Test the air-Q" button that reads those whose interval has passed and
  shows the last values and the time of the next possible read.

[Unreleased]: https://github.com/LM1LC3N7/gladys-air-q/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/LM1LC3N7/gladys-air-q/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/LM1LC3N7/gladys-air-q/releases/tag/v0.1.1

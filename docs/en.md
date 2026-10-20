# air-Q

**Unofficial connector, not affiliated with Corant GmbH.** It brings into
Gladys the values of your **air-Q** air quality sensors, read directly on your
local network: no cloud, no account, no subscription.

> **This integration has never been tested with a real air-Q.** It follows
> aioairq, the Python library of the maker that Home Assistant uses. Please
> report what you see on the Gladys forum.

## What you get

One device per air-Q, named after the name you gave it in the air-Q app,
with the values your model measures (a value the device does not send is
simply not created):

| Sensor in Gladys    | air-Q field          | Unit  |
| ------------------- | -------------------- | ----- |
| CO2                 | `co2`                | ppm   |
| VOC                 | `tvoc`               | ppb   |
| VOC (ion sensor)    | `tvoc_ionsc`         | ppb   |
| PM2.5, PM10         | `pm2_5`, `pm10`      | µg/m³ |
| Carbon monoxide     | `co`                 | ppm   |
| Nitrogen dioxide    | `no2`                | µg/m³ |
| Ozone               | `o3`                 | µg/m³ |
| Sulphur dioxide     | `so2`                | µg/m³ |
| Formaldehyde        | `ch2o_M10`           | µg/m³ |
| Temperature         | `temperature`        | °C    |
| Humidity            | `humidity`           | %     |
| Pressure            | `pressure`           | hPa   |
| Noise, noise (peak) | `sound`, `sound_max` | dB(A) |

- The air-Q gives carbon monoxide in mg/m³; Gladys knows only ppm for it, so
  the value is converted (× 0.873, at 25 °C and normal pressure).
- Not in Gladys yet, because Gladys has no category for them: radon, oxygen,
  PM1, the particle counts, absolute humidity, the "health" and
  "performance" indexes, the virus and mold indexes, the dew point (a
  temperature that would skew the room temperature), the rarer gases of the
  air-Q Science. See TODO.md.
- A sensor that is still warming up after a restart of the air-Q sends no
  value for a while: its feature stays, the value comes back by itself.
- The names of the sensors are in English; rename them when you create them
  if you wish.

## Installation

1. Give the air-Q a **fixed IP address** in your router (DHCP reservation):
   the integration reaches it by its address. Inside the container of the
   integration, mDNS names (`<id>_air-q.local`) are usually not resolved.
2. Install the integration from the Gladys catalog (Gladys 5.1 or newer).
3. In the **Configuration** screen, enter the address and the **device
   password** of the air-Q, and save. Up to three air-Q.
4. Click **Test the air-Q**: the message shows the main values of each one.
5. Open the **Discovery** tab and add the devices. Their values arrive as
   soon as they are created.

## Configuration

- **Address**: the IPv4 address of the air-Q (`192.168.1.50`), optionally
  with a port, or its host name; the 5-character id printed on the device
  is turned into `<id>_air-q.local`, as aioairq does, for a network that
  resolves mDNS names. A path, an IPv6 address or credentials are refused.
- **Password**: the device password set in the air-Q app (`airqsetup` out of
  the box: change it in the app). It is kept by Gladys in its database (in
  clear, like every secret field of Gladys) and never shown again in the
  configuration screen. It never leaves the integration: the air-Q protects
  its answers with AES-256 and a key taken from this password, and the
  integration only uses it to open them. It is never written in the logs nor
  under `/data`.
- **Values**: averaged (smoothed by the air-Q, the default of its app and of
  Home Assistant) or momentary.
- **Read interval**: 2 minutes by default, 1 to 60.

## How often the air-Q is read

- One request per air-Q at each interval: `GET /average` (or `/data`),
  preceded by `GET /config` (the id and the name of the device) at the first
  read and after any failure, since the address may then lead to another
  air-Q.
- **Never faster than the interval**, counted from the last request sent:
  not by the test button, a reconnection to Gladys, a saved configuration
  nor a restart of the container. Only a new address or a new password is
  read at once. Before the interval has passed, the test button shows the
  last values and the time of the next possible read.
- **Read only**: the integration never writes to the air-Q (no
  configuration change, no blink, no restart).
- **The values belong to the device that measured them**: each answer
  carries the id of the air-Q; if another air-Q now answers at the address
  (two devices that swapped their addresses in the router), nothing is
  published until its id is read again, and then under its own device.
- A failure (no answer, another HTTP status, an answer that is not the one
  of an air-Q) is tried again at the next interval, never sooner.
- When the air-Q answers **429 or a 5xx** (busy, restarting), it is left
  alone for the `Retry-After` delay it gives, else 5 minutes, then 10, 20...;
  always between 1 minute and 6 hours, and never shorter than the interval.
- When the **password does not fit** (the answer cannot be opened), the reads
  of that air-Q stop and the status says so; one new try every 6 hours (the
  test button may try as soon as the interval has passed), until you change
  the password.
- The instant of the last request, the pauses, the refusals and the id, name
  and sensors of each air-Q (not secret) survive a reconnection to Gladys
  and a restart of the container: they are kept in a file under `/data`
  with a salted fingerprint (scrypt) of the password, never the password
  itself, to tell a new password (tried at once) from the same one. After a
  restart, the Discovery tab keeps showing the devices until the next read.
- An answer larger than 256 KB, or slower than 10 seconds, is abandoned.

## Troubleshooting

- **"password refused"**: check the device password in the air-Q app (it is
  the password of the device, not the one of your air-Q account).
- **"no answer"**: check the address (fixed IP), that the air-Q is on the
  same network as Gladys and that its Wi-Fi is not switched off by the night
  mode.
- **"not an air-Q answer"**: the address points to another device.
- **"same air-Q as another address"**: two addresses lead to the same device;
  keep one.
- Logs: the level is set with the `LOG_LEVEL` variable.

## Privacy

Everything stays on your local network: the integration talks only to the
addresses you enter, over HTTP (the air-Q has no HTTPS), and its answers are
protected by the device itself. No cloud, no account.

## Credits

Built after [aioairq](https://github.com/CorantGmbH/aioairq) (Apache-2.0,
Corant GmbH, the maker of the air-Q), the library of Home Assistant's air-Q
integration: the protection of the local API, the routes, the fields and the
handling of the values are ported to JavaScript. Its notice is in
`THIRD_PARTY_NOTICES.md`. air-Q is a trademark of its owner; this connector
is free and unofficial.

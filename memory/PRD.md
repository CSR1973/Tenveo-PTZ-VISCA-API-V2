# Tenveo PTZ Companion Module — PRD

## Original Problem Statement
Build a Bitfocus Companion 4.x module for Tenveo PTZ cameras (TEVO-VHD20HAN, TEVO-VHD20H-U) with:
- VISCA-over-IP (UDP 52381) transport
- Full PTZ + focus + exposure controls
- Button and rotary (Stream Deck XL+) variants
- Companion 4.3.4 compatibility
- Support for 4 cameras on 192.168.88.11–14

## Architecture
```
/app/companion-module-tenveo-ptz/
  ├── src/           (main.js, actions.js, commands.js, config.js, feedbacks.js, onvif.js,
  │                   presets.js, variables.js, visca.js)
  ├── test/          (13 automated test suites, 357 assertions)
  ├── companion/     (HELP.md, manifest.json)
  └── tenveo-ptz-1.16.0.tgz  (latest built artifact)
```

## Implementation Status

### v2.0.2 (2026-02) — Companion 5.x preset shape crash fix
- Fixed `TypeError: Cannot convert undefined or null to object at sanitisePresetDefinitions` on module init in Companion 5.0.4.
- Companion API v2 changed `setPresetDefinitions()` to a two-argument call `(structure, presets)` and moved `category` off individual presets into a top-level section list.
- `src/presets.js` now returns `{ structure, presets }`; `src/main.js` spreads both.
- Added `test/api-v2-preset-shape.test.js` regression suite (reproduces host's `Object.entries(presets)` sanitiser).
- **18 test files, 379 assertions passing.**
- Built artifact: `tenveo-ptz-2.0.2.tgz`.

### v2.0.1 — Companion 5.x variables shape crash fix
- Fixed `Variable definitions should be an object, not an array`.
- `src/variables.js` now exports an object keyed by variable id.
- Added `test/api-v2-variable-shape.test.js`.

### v2.0.0 — Companion API v2 migration
- Bumped to `@companion-module/base` 2.x, `@companion-module/tools` 3.x, Node 22+.
- Manifest updated (`type: connection`, `runtime.type: node22`, `apiVersion: 2.0.0`).
- Entry-point moved from `runEntrypoint()` → `export default TenveoInstance` + `export const UpgradeScripts`.
- Presets converted from `type: 'button'` → `type: 'simple'`.

### v1.16.1 — OSD menu navigation fix
- Replaced pan/tilt-drive-based OSD navigation with the correct standard
  VISCA CAM_Menu-Nav opcodes (`0x06 0x01 0x0E 0x0E …`).
- `menu_enter` → `0x06 06 05` (CAM_MenuReturn OK), `menu_back` → `0x06 06 04`
  (was accidentally identical to `menu_off`).
- `menu_toggle` now tracks `state.menuOpen` locally and sends the reliable
  on/off bytes (the preset-95 shortcut is not implemented on Tenveo VHD20HAN).
- Added `test/osd-menu.test.js` (16 assertions).

### v1.16.0 — Discrete per-tick Zoom Rotary
- New `zoom_rotary_tick_in` / `zoom_rotary_tick_out` actions. Each rotary
  click moves state.zoomPos by a fixed step (default 500 / max 8000 units),
  updates `zoom_position` + `zoom_percent` variables IMMEDIATELY, and sends
  `zoomDirect(newPos)` so the camera lands exactly where the variable claims.
- Added `test/zoom-rotary-tick.test.js` (17 assertions).

### v1.15.0 — Rotary preset browsing + smoother zoom rotary
- SAVE and RECALL rotaries with wrap-around index + PUSH-to-commit.
- Zoom-rotary default `idleMs` raised from 200/250 → 800 ms.

### v1.14.2 — ExpComp action labels renamed
### v1.14.1 — Upgrade-script shape fix (arrays not objects)
### v1.14.0 — Safe callback wrapper + legacy action-id upgrade script
### v1.13.0 — AE Mode toggle + focus polling on AF change
### v1.12.0 — ExpComp AE Mode variables + feedback, rotary Focus refactor
### v1.11.0 — Axis-independent Home + Backlight rename
### v1.10.0 — Pan/Tilt step calibration (108.74 units/deg)
### v1.0.0–v1.9.x — Base VISCA-over-IP module, ONVIF presets

## Known Limitations
- NDI firmware silently drops `CAM_FocusPosInq` → falls back to elapsed-time
  focus estimation (documented in HELP.md).
- Companion 3.x+ always shows a module's local version as "dev" in the UI.
- The transient green ▶ *action-running* indicator drawn top-right by
  Companion during callback execution can look yellow on colored Stream Deck
  LCD buttons — **not** an error.

## Backlog
- **P1** — Soft-preset snapshot: save current PTZ+I+F state into a Companion
  custom variable for unlimited restart-safe soft-presets.
- **P1** — "One-Touch Exposure" combo (Manual + ExpComp ±3 + Iris f/4 in one tap).
- **P2** — Split `src/actions.js` (~1650 lines) into `actions/ptz.js`,
  `actions/image.js`, `actions/preset.js`, etc.

## Testing
- `npm test` runs **18 suites, 379 assertions**, all passing (v2.0.2, 2026-02).
- Physical hardware testing on `192.168.88.11–14` requires user's local network.

## Credentials
- ONVIF: `admin` / `admin` (see `/app/memory/test_credentials.md`).

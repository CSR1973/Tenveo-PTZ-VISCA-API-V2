# Tenveo PTZ Companion Module

Control Tenveo PTZ cameras (e.g. **TEVO-VHD20HAN**, VHD10/20/30 series) from Bitfocus Companion 4.x using **VISCA over IP** (UDP port 52381). This module is tailored to Tenveo's command set, which is close to — but not identical to — Sony/PTZOptics VISCA. It includes both **standard button actions** and **Stream Deck + rotary/encoder variants**.

---

## Configuration

| Field | Description |
|-------|-------------|
| **Camera Name** | A friendly name shown in variable labels (e.g. "Stage Left") |
| **IP Address** | IPv4 address of the camera (e.g. `192.168.88.11`) |
| **VISCA Port** | UDP port (default **52381**) |
| **Pan Speed (default)** | 1–24 — used when a Pan action does not override speed |
| **Tilt Speed (default)** | 1–20 — used when a Tilt action does not override speed |
| **Zoom Speed (default)** | 0–7 — used when a Zoom action does not override speed |
| **Polling Interval (ms)** | How often to poll camera state for feedbacks (0 to disable) |
| **Verbose Logging** | Logs every TX/RX VISCA packet (debug only) |

---

## Actions

### Pan / Tilt / Zoom (Button)
- **Pan Left / Right / Stop**
- **Tilt Up / Down / Stop**
- **Pan/Tilt diagonal** (Up-Left, Up-Right, Down-Left, Down-Right) — auto-stops on release
- **Pan & Tilt (with speed override)** — pass custom speeds
- **Zoom In / Out / Stop** with optional speed override
- **Home position**

### Pan / Tilt / Zoom (Rotary / Encoder — Stream Deck +)
- **Pan (Rotary)** — rotate left = pan left, right = pan right. Speed scales with rotation magnitude.
- **Tilt (Rotary)** — rotate up/down
- **Zoom (Rotary)** — rotate to zoom in/out
- **Focus (Rotary)** — rotate to focus near/far (manual focus)

All rotary actions accept an **Amount Multiplier** so you can tune sensitivity per button.

### Presets
- **Recall Preset** (1–255)
- **Save Preset** (1–255)
- **Clear Preset** (1–255)
- **Preset Recall Speed** (0–24) — sets the global recall speed
- **Recall Preset (variable)** — accepts a Companion variable so a single button can recall a chosen preset

**Rotary preset browsing (Stream Deck + / XL+)** — v1.15.0
- **Preset SAVE rotary** — bind rotate CW / CCW to `Preset SAVE rotary: Scroll →/← next/previous index`, and bind push to `Preset SAVE rotary: PUSH → save preset at current index`. Show `$(tenveo:preset_save_index)` on the button so you always see which slot you're pointing at. `Preset SAVE rotary: Jump index directly` is a helper if you want a "reset to 1" button.
- **Preset RECALL rotary** — same pattern with `Preset RECALL rotary: Scroll →/←` on rotate and `PUSH → recall preset at current index` on push. Show `$(tenveo:preset_recall_index)` on the button.
- Both rotaries have configurable `min` / `max` / `step per click` options so you can constrain the wheel to e.g. presets 1–10 with wrap-around, or step by 5 for coarse scrolling.

### Focus
- **Auto Focus On / Off / Toggle**
- **Focus Near / Far / Stop** (manual)
- **One-Push Auto Focus**
- **Focus Lock / Unlock**
- **Focus (Rotary)** — see above

### Exposure & Image
- **Exposure Mode**: Full Auto / Manual / Shutter Priority / Iris Priority / Bright
- **Iris**: Up / Down / Direct value (0–13)
- **Shutter**: Up / Down / Direct value (0–21)
- **Gain**: Up / Down / Direct value (0–14)  ← *Tenveo-specific, missing from PTZOptics module*
- **Gain (Rotary)** — rotate to step gain up/down
- **Iris (Rotary)** — rotate to step iris up/down
- **Shutter (Rotary)** — rotate to step shutter up/down
- **Bright**: Up / Down / Direct value (0–27)
- **Exposure Compensation**: On / Off / Up / Down / Direct
- **Back Light Compensation**: On / Off

### White Balance
- **WB Mode**: Auto / Indoor / Outdoor / One-Push / Manual / ATW / Sodium / Color Temp
- **One-Push WB Trigger**
- **R-Gain / B-Gain**: Up / Down / Reset / Direct
- **Color Temperature**: Up / Down / Direct (2500–8000 K)

### System / OSD
- **Power On / Off / Toggle / Standby**
- **OSD Menu Open / Close / Toggle**
- **OSD Navigate**: Up / Down / Left / Right / Enter / Back
- **IR Receive On / Off**
- **Camera ID**: set for daisy-chained units
- **Custom VISCA**: send any raw VISCA hex string (e.g. `81 01 04 00 02 FF`)

---

## Feedbacks

- **Preset Recalled** — highlight buttons when a particular preset was the last one recalled
- **Power State** — On / Off
- **Auto Focus State** — On / Off
- **Exposure Mode** — matches selected mode
- **WB Mode** — matches selected mode
- **PTZ Moving** — highlight when camera is panning/tilting/zooming
- **Connection State** — turn red when camera is unreachable

---

## Variables

- `$(tenveo:camera_name)` — friendly name from config
- `$(tenveo:host)` — IP address
- `$(tenveo:connected)` — `true`/`false`
- `$(tenveo:last_preset)` — last preset number recalled
- `$(tenveo:power)` — `on` / `off`
- `$(tenveo:af)` — `on` / `off`
- `$(tenveo:exposure_mode)`, `$(tenveo:wb_mode)`
- `$(tenveo:gain)`, `$(tenveo:iris)`, `$(tenveo:shutter)`
- `$(tenveo:zoom_position)`, `$(tenveo:focus_position)`
- `$(tenveo:pan_position)`, `$(tenveo:tilt_position)`

---

## Stream Deck + Notes (Rotary / Encoder)

When you place a **Rotary** action on a Stream Deck + encoder, Companion calls the action repeatedly with the rotation `direction` and `step` size.

This module exposes dedicated rotary actions (`*_rotary`) that:
- read the rotation direction from the encoder event
- map step → VISCA speed value
- auto-issue a **stop** command when rotation halts (debounced 120 ms)

You can also assign any standard button action to an encoder press; rotation will simply not be processed.

---

## Tips

- Tenveo cameras default to **DHCP**. Pin them to a static IP in the camera OSD (Menu → Network).
- Some Tenveo firmware revisions ignore VISCA replies for inquiries (`0x09 …`). If polling causes warnings in your logs, disable polling.
- The Gain command set differs between Sony and PTZOptics firmware. This module uses Tenveo's mapping (`81 01 04 0C 0p FF` direct, where p = 0…14).
- For daisy-chained cameras over RS-485, set the proper camera address in the *Camera ID* action; the module always uses VISCA-over-IP packet header (always-on for IP).

---

## Troubleshooting

1. **No connection** — Verify UDP 52381 is open and the camera's VISCA-over-IP is enabled in the OSD (Menu → System → VISCA → Network).
2. **Commands work but feedbacks don't update** — Some Tenveo models do not respond to inquiries. Disable polling.
3. **Drifting position** — Lower the pan/tilt default speed; some servos overshoot on quick stops.
4. **Preset recall too fast/slow** — Use the *Preset Recall Speed* action.
5. **`$(instance:focus_position)` / `focus_percent` stays at 0 on NDI cameras** — Tenveo VHD20HAN (NDI firmware) silently drops `CAM_FocusPosInq` (`81 09 04 48 FF`), so the module can't read the real focus position from the camera. It falls back to an elapsed-time estimate that only updates while you actively drive focus with `Focus: Near/Far` or the rotary STEP actions. If the camera is in Auto Focus, the internal AF motor moves without notifying the module, so the tracker drifts. Workarounds: (a) switch to Manual Focus and drive with the module, (b) use `Focus: Reset tracker` to reseed the counter, (c) on non-NDI variants this variable populates from the poll automatically.
6. **`$(instance:iris_fstop)` / `exposure_compensation` don't update** — Same firmware caveat: if polling is disabled or ignored, the variable only updates when you press the corresponding action button. Enable `Polling Interval` in the connection config for automatic updates on non-NDI cameras.
7. **Yellow triangle on a Stream Deck button when pushed** — As of **v1.14.0** the module wraps every action callback in a safe try/catch that logs the real error to the Companion Log tab instead of surfacing as a yellow warning icon. If you still see a yellow triangle:
   - Open Companion → **Log** tab and look for a line beginning `Action "…" threw: …` — that message is the actual root cause.
   - v1.14.0 also ships an upgrade script that automatically migrates older ExpComp/Gain action IDs (e.g. `expcomp_step_up`, `gain_up_ndi`) to their current names, so existing buttons don't need to be recreated after an upgrade.

## Changelog

- **2.0.0** — Migrated to Companion API v2 (`@companion-module/base` 2.x, `@companion-module/tools` 3.x, Node 22+). Manifest updated to `type: "connection"`, `runtime.type: "node22"`, `apiVersion: "2.0.0"`. Entry-point changed from `runEntrypoint()` to `export default TenveoInstance` + `export const UpgradeScripts`. Presets converted from `type: "button"` → `type: "simple"`. All 16 test suites (460 assertions) still pass. Requires **Bitfocus Companion 5.0+**.
- **1.18.0** — Image Flip / Mirror actions. Three toggles: `Image: Toggle Flip` (vertical/upside-down), `Image: Toggle Mirror` (horizontal/LR reverse), and `Image: Toggle Flip + Mirror` (both at once from a single button). Plus explicit ON/OFF variants. New `image_flip` and `image_mirror` state variables for button feedback.
- **1.17.2** — OSD Menu Navigation is now always broadcast (fires CAM_Menu-Nav + pt-drive @ speeds 3, 6, 14 + a pt-stop). Removed the `OSD Menu Navigation style` dropdown from the connection config since field testing confirmed Tenveo VHD20HAN only responds when all styles are sent at once.
- **1.17.1** — Fixed Save button greyed out in the connection-edit panel after module upgrades. `init()` and `configUpdated()` now backfill any missing config keys with their defaults from `getConfigFields()` and persist back via `saveConfig()`, so newly-added fields no longer fail Companion's "A value must be provided" validation.
- **1.17.0** — OSD Nav dispatcher: connection config now has an `OSD Menu Navigation style` dropdown so users can switch between CAM_Menu-Nav (Sony spec), pan/tilt drive at speeds 3 / 6 / 14, or a "broadcast" mode that fires all styles at once — until one of them works on their firmware revision.
- **1.16.1** — Fixed OSD menu navigation opcodes (CAM_Menu-Nav, CAM_MenuReturn OK/Cancel, tracked toggle).
- **1.16.0** — New `Rotary TICK: Zoom In/Out` — discrete per-click zoom with instant `zoom_percent` update.
- **1.15.0** — Rotary preset browsing (SAVE + RECALL rotaries with wrap-around index + PUSH-to-commit). Zoom rotary default idle raised to 800 ms for smoother slow-spin drives.
- **1.14.2** — Renamed misleading ExpComp action labels (`expcomp_toggle` no longer confusable with AE-mode toggle).
- **1.14.1** — Fixed upgrade-script return shape (was crashing all connections to red).
- **1.14.0** — Safe callback wrapper (no more Yellow Triangle from runtime errors; errors log to the Companion Log). Auto-migration of legacy ExpComp/Gain action IDs from earlier module versions.
- **1.13.0** — AE Mode toggle (Auto ↔ Manual), Focus polling on `focus_auto`/`focus_manual`.
- **1.12.0** — ExpComp AE Mode variables + feedback, rotary Focus tracking refactor.
- **1.11.0** — Axis-independent Home (pan-only/tilt-only/zoom-only) + Backlight rename.
- **1.10.0** — Pan/Tilt step calibration (108.74 units/deg) + rotary summed absolute positioning.


See `README.md` in the module repository for development & contribution guidance.

import * as C from './commands.js'

const speedChoices = (min, max) =>
	Array.from({ length: max - min + 1 }, (_, i) => ({ id: min + i, label: String(min + i) }))

const PAN_SPEEDS = speedChoices(1, 24)
const TILT_SPEEDS = speedChoices(1, 20)
const ZOOM_SPEEDS = speedChoices(0, 7)

/** Smarter auto-stop pulse. Only sends the drive command when direction changes;
 *  each subsequent fire in the same direction just extends the auto-stop timer. */
function pulse(self, key, dirLabel, cmdFn, stopCmdFn, holdMs) {
	if (!self._pulseState) self._pulseState = {}
	const st = self._pulseState[key] || {}
	if (self._pulseTimers[key]) clearTimeout(self._pulseTimers[key])
	if (st.dir !== dirLabel) {
		self.send(cmdFn())
		st.dir = dirLabel
		st.lastSent = Date.now()
		self._pulseState[key] = st
	}
	self._pulseTimers[key] = setTimeout(() => {
		self.send(stopCmdFn())
		delete self._pulseTimers[key]
		st.dir = null
		self._pulseState[key] = st
	}, holdMs)
}

/** Pan/Tilt max degrees-per-second at top speed (for HOLD duration → degrees tracking). */
const panDpsMax = (self) => Math.max(1, +self.config.panDegPerSec || 100)
const tiltDpsMax = (self) => Math.max(1, +self.config.tiltDegPerSec || 60)
/** Is this connection configured as an NDI-quirks camera? */
const isNdi = (self) => (self.config.variant || 'standard') === 'ndi'

/* ─── Pan/Tilt absolute-position calibration (per-camera).
 *   panU  = panCenter  + panDeg  × panUnitsPerDeg   (flip sign of panUnitsPerDeg to invert)
 *   tiltU = tiltCenter + tiltDeg × tiltUnitsPerDeg  (flip sign of tiltUnitsPerDeg to invert)
 * Result is masked into signed 16-bit so ptAbsolute can encode it correctly on the wire. */
const panCenter = (self) => (self.config.panCenter ?? 19050) | 0
const tiltCenter = (self) => (self.config.tiltCenter ?? 8000) | 0
const panUPD = (self) => (Number.isFinite(+self.config.panUnitsPerDeg) ? +self.config.panUnitsPerDeg : 108.74)
const tiltUPD = (self) => (Number.isFinite(+self.config.tiltUnitsPerDeg) ? +self.config.tiltUnitsPerDeg : 86.66)
const panMinDeg = (self) => (Number.isFinite(+self.config.panMinDeg) ? +self.config.panMinDeg : -175)
const panMaxDeg = (self) => (Number.isFinite(+self.config.panMaxDeg) ? +self.config.panMaxDeg : 175)
const tiltMinDeg = (self) => (Number.isFinite(+self.config.tiltMinDeg) ? +self.config.tiltMinDeg : -90)
const tiltMaxDeg = (self) => (Number.isFinite(+self.config.tiltMaxDeg) ? +self.config.tiltMaxDeg : 90)

const clampPanDeg = (self, d) => Math.max(panMinDeg(self), Math.min(panMaxDeg(self), d))
const clampTiltDeg = (self, d) => Math.max(tiltMinDeg(self), Math.min(tiltMaxDeg(self), d))

/** Convert an unbounded integer into a signed 16-bit representation (-32768..32767).
 *  ptAbsolute in commands.js already handles this on the wire, but we normalise here so
 *  logs and any downstream consumers see a value inside int16 range. */
function toInt16(x) {
	let v = ((x | 0) & 0xffff)
	if (v >= 0x8000) v -= 0x10000
	return v
}

/** Dispatch an OSD navigation click. Tenveo VHD20HAN firmware ignores the
 *  standard CAM_Menu-Nav bytes AND some pt-drive speeds — the only reliable
 *  way is to fire every known style at once and let the camera respond to
 *  whichever it understands. (Verified by user field testing v1.17.0.) */
function osdNav(self, dir) {
	const ptCmd = {
		up: (s) => C.menuPtDriveUp(s),
		down: (s) => C.menuPtDriveDown(s),
		left: (s) => C.menuPtDriveLeft(s),
		right: (s) => C.menuPtDriveRight(s),
	}[dir]
	const camMenuCmd = {
		up: C.menuNavUp,
		down: C.menuNavDown,
		left: C.menuNavLeft,
		right: C.menuNavRight,
	}[dir]

	// Fire CAM_Menu-Nav + pt-drive @ speeds 3, 6, 14 — whichever the firmware
	// understands wins; the rest are silently ignored by the camera.
	self.send(camMenuCmd()).catch(() => {})
	self.send(ptCmd(3)).catch(() => {})
	self.send(ptCmd(6)).catch(() => {})
	self.send(ptCmd(0x0e)).catch(() => {})
	// Cancel any residual physical pan/tilt movement that the pt-drive bytes
	// may have triggered on the (in)correct axis if the menu was not open.
	setTimeout(() => self.send(C.menuPtStop()).catch(() => {}), 150)
}

/** Update zoom_position + zoom_percent variables from state.zoomPos (0..16384). */
function updateZoomVars(self) {
	const pos = Math.max(0, Math.min(16384, Math.round(self.state.zoomPos || 0)))
	self.setVariableValues({
		zoom_position: pos,
		zoom_percent: Math.round((pos / 16384) * 100),
	})
}

/** Zoom units-per-second at the given VISCA zoom speed (0..7).
 *  Uses config.zoomUnitsPerSec (default 3200 = full range in ~5s at speed 7) scaled linearly.
 *  Speed 0 is treated as ~1/8 of max so slow-speed clicks still move the tracker. */
function zoomUnitsPerSec(self, speed) {
	const max = Math.max(100, +self.config.zoomUnitsPerSec || 3200)
	const s = Math.max(0, Math.min(7, +speed))
	// s=0 → 12.5% of max, s=7 → 100% of max (linear interp)
	return max * (0.125 + (0.875 * s) / 7)
}

/** Variable-speed zoom drive with auto-stop after `idleMs` of no further clicks.
 *  Publishes zoom_position/zoom_percent on EVERY click (real-time estimate from elapsed
 *  drive time × zoomUnitsPerSec) so variables update visibly during rotary spins, not only
 *  when the auto-stop timer fires. */
function zoomDriveStep(self, dir, speed, idleMs) {
	const cmd = dir === 'tele' ? C.zoomTeleVar(speed) : C.zoomWideVar(speed)
	const now = Date.now()
	const same = self._zoomDriveDir === dir && self._zoomDriveSpeed === speed

	if (!same) {
		if (self._zoomDriveDir && self._zoomDriveStart != null && self._zoomDriveBaseline != null) {
			const elapsed = (now - self._zoomDriveStart) / 1000
			const delta = elapsed * zoomUnitsPerSec(self, self._zoomDriveSpeed) *
				(self._zoomDriveDir === 'tele' ? 1 : -1)
			self.state.zoomPos = Math.max(0, Math.min(16384, (self._zoomDriveBaseline + delta)))
		}
		self._zoomDriveDir = dir
		self._zoomDriveSpeed = speed
		self._zoomDriveStart = now
		self._zoomDriveBaseline = self.state.zoomPos || 0
		self.send(cmd).catch((e) => self.log('error', `zoom drive send failed: ${e.message}`))
	}

	// Publish real-time estimated position on every click
	const elapsedNow = (now - self._zoomDriveStart) / 1000
	const estimated = (self._zoomDriveBaseline || 0) + elapsedNow * zoomUnitsPerSec(self, speed) *
		(dir === 'tele' ? 1 : -1)
	self.state.zoomPos = Math.max(0, Math.min(16384, estimated))
	updateZoomVars(self)

	if (self._zoomStopTimer) clearTimeout(self._zoomStopTimer)
	self._zoomStopTimer = setTimeout(async () => {
		self._zoomStopTimer = null
		const startTime = self._zoomDriveStart
		const baseline = self._zoomDriveBaseline
		const spd = self._zoomDriveSpeed || 0
		const driveDir = self._zoomDriveDir
		self._zoomDriveDir = null
		self._zoomDriveSpeed = 0
		self._zoomDriveStart = null
		self._zoomDriveBaseline = null
		try { await self.send(C.zoomStop()) } catch (e) { self.log('error', `zoomStop send failed: ${e.message}`) }
		if (startTime != null && baseline != null) {
			const elapsed = (Date.now() - startTime) / 1000
			const est = baseline + elapsed * zoomUnitsPerSec(self, spd) * (driveDir === 'tele' ? 1 : -1)
			self.state.zoomPos = Math.max(0, Math.min(16384, est))
			updateZoomVars(self)
		}
	}, idleMs)
}

/** Update focus_position + focus_percent variables from state.focusPos (0..16384). */
function updateFocusVars(self) {
	const pos = Math.max(0, Math.min(16384, Math.round(self.state.focusPos || 0)))
	self.setVariableValues({
		focus_position: pos,
		focus_percent: Math.round((pos / 16384) * 100),
	})
}

/** Focus units-per-second at the given VISCA focus speed (0..7).
 *  Uses config.focusUnitsPerSec (default 3200 = full range in ~5s at speed 7). */
function focusUnitsPerSec(self, speed) {
	const max = Math.max(100, +self.config.focusUnitsPerSec || 3200)
	const s = Math.max(0, Math.min(7, +speed))
	return max * (0.125 + (0.875 * s) / 7)
}

/** Variable-speed focus drive with auto-stop after `idleMs` of no further clicks.
 *  Publishes focus_position/focus_percent on EVERY click (real-time estimate from elapsed
 *  drive time × focusUnitsPerSec) and again on auto-stop, so the variables update visibly
 *  during rotary spins — not only when the camera answers inqFocusPos (which Tenveo NDI
 *  firmware silently drops). */
function focusDriveStep(self, dir, speed, idleMs) {
	const cmd = dir === 'far' ? C.focusFarVar(speed) : C.focusNearVar(speed)
	const now = Date.now()
	const same = self._focusDriveDir === dir && self._focusDriveSpeed === speed

	if (!same) {
		// Flush any previous drive into the tracker before starting a new one
		if (self._focusDriveDir && self._focusDriveStart != null && self._focusDriveBaseline != null) {
			const elapsed = (now - self._focusDriveStart) / 1000
			const delta = elapsed * focusUnitsPerSec(self, self._focusDriveSpeed) *
				(self._focusDriveDir === 'far' ? 1 : -1)
			self.state.focusPos = Math.max(0, Math.min(16384, (self._focusDriveBaseline + delta)))
		}
		self._focusDriveDir = dir
		self._focusDriveSpeed = speed
		self._focusDriveStart = now
		self._focusDriveBaseline = self.state.focusPos || 0
		self.send(cmd).catch((e) => self.log('error', `focus drive send failed: ${e.message}`))
	}

	// Publish real-time estimated position on every click
	const elapsedNow = (now - self._focusDriveStart) / 1000
	const estimated = (self._focusDriveBaseline || 0) + elapsedNow * focusUnitsPerSec(self, speed) *
		(dir === 'far' ? 1 : -1)
	self.state.focusPos = Math.max(0, Math.min(16384, estimated))
	updateFocusVars(self)

	if (self._focusStopTimer) clearTimeout(self._focusStopTimer)
	self._focusStopTimer = setTimeout(async () => {
		self._focusStopTimer = null
		const startTime = self._focusDriveStart
		const baseline = self._focusDriveBaseline
		const spd = self._focusDriveSpeed || 0
		const driveDir = self._focusDriveDir
		self._focusDriveDir = null
		self._focusDriveSpeed = 0
		self._focusDriveStart = null
		self._focusDriveBaseline = null
		try { await self.send(C.focusStop()) } catch (e) { self.log('error', `focusStop send failed: ${e.message}`) }
		if (startTime != null && baseline != null) {
			const elapsed = (Date.now() - startTime) / 1000
			const est = baseline + elapsed * focusUnitsPerSec(self, spd) * (driveDir === 'far' ? 1 : -1)
			self.state.focusPos = Math.max(0, Math.min(16384, est))
			updateFocusVars(self)
		}
	}, idleMs)
}

/** Update iris + iris_fstop variables from state.iris (0..13). */
function updateIrisVars(self) {
	const v = Math.max(0, Math.min(13, +self.state.iris || 0))
	const label = C.IRIS_FSTOP[v] || 'unknown'
	self.state.iris = v
	self.state.irisFstop = label
	self.setVariableValues({ iris: v, iris_fstop: label })
}

/** Update exposure_compensation variable from state.expComp (-7..+7). */
function updateExpCompVar(self) {
	const v = Math.max(-7, Math.min(7, +self.state.expComp || 0))
	self.state.expComp = v
	self.setVariableValues({ exposure_compensation: v })
}

/** Best-effort refresh of state.focusPos from the physical camera via inqFocusPos.
 *  Works on non-NDI variants; NDI firmware silently drops the inquiry — in that case we
 *  leave the tracker at its last value (setVariableValues is only invoked on success). */
async function refreshFocusFromCamera(self) {
	if (!self.visca || typeof self.visca.inquiry !== 'function') return
	try {
		const r = await self.visca.inquiry(C.inqFocusPos())
		if (!r || !r.payload) return
		const data = C.parseInqReply(r.payload)
		if (!data || data.length < 4) return
		const v = C.denibble16(data.slice(0, 4))
		if (typeof v !== 'number' || Number.isNaN(v)) return
		self.state.focusPos = Math.max(0, Math.min(16384, v))
		updateFocusVars(self)
	} catch {
		// swallow — tracker stays as-is
	}
}

/** Best-effort refresh of state.panDeg / state.tiltDeg from the physical camera.
 *  Uses inqPtPos when a visca socket is available. Silently returns if the camera
 *  doesn't answer — tracker just stays at its previous estimate. */
async function refreshPanTiltFromCamera(self) {
	if (!self.visca || typeof self.visca.inquiry !== 'function') return
	try {
		const r = await self.visca.inquiry(C.inqPtPos())
		if (!r || !r.payload) return
		const data = C.parseInqReply(r.payload)
		if (!data || data.length < 8) return
		const rawPan = C.denibble16(data.slice(0, 4))
		const rawTilt = C.denibble16(data.slice(4, 8))
		const panS = rawPan >= 0x8000 ? rawPan - 0x10000 : rawPan
		const tiltS = rawTilt >= 0x8000 ? rawTilt - 0x10000 : rawTilt
		const panC = panCenter(self)
		const tiltC = tiltCenter(self)
		const puD = panUPD(self)
		const tuD = tiltUPD(self)
		if (puD !== 0) self.state.panDeg = (panS - panC) / puD
		if (tuD !== 0) self.state.tiltDeg = (tiltS - tiltC) / tuD
		self.setVariableValues({
			pan_degrees: (self.state.panDeg ?? 0).toFixed(1),
			tilt_degrees: (self.state.tiltDeg ?? 0).toFixed(1),
		})
	} catch {
		// swallow — tracker stays as-is
	}
}

/** Compute the (panU, tiltU) VISCA units for the current tracked degrees. */
function absoluteUnits(self) {
	const panU = toInt16(Math.round(panCenter(self) + (self.state.panDeg || 0) * panUPD(self)))
	const tiltU = toInt16(Math.round(tiltCenter(self) + (self.state.tiltDeg || 0) * tiltUPD(self)))
	return { panU, tiltU }
}

/** Coalesce rapid Pan/Tilt absolute-position updates so fast dial spins don't flood the socket.
 *  Every click updates state.panDeg/tiltDeg + the variable immediately, but only one ptAbsolute
 *  command is transmitted per ~30 ms window — always carrying the latest target. */
function sendPtAbsoluteThrottled(self, panSpeed, tiltSpeed) {
	self._ptTargetPanSpeed = panSpeed
	self._ptTargetTiltSpeed = tiltSpeed
	if (self._ptSendTimer) return
	self._ptSendTimer = setTimeout(async () => {
		self._ptSendTimer = null
		const { panU, tiltU } = absoluteUnits(self)
		try {
			await self.send(C.ptAbsolute(panU, tiltU, self._ptTargetPanSpeed, self._ptTargetTiltSpeed))
		} catch (e) {
			self.log('error', `ptAbsolute send failed: ${e.message}`)
		}
	}, 30)
}

/** Start tracking a HOLD-drive so pan_degrees/tilt_degrees update when the button is released.
 *  panDir/tiltDir: -1 | 0 | +1. Speeds are the VISCA speed values actually sent. */
function startDrive(self, panDir, tiltDir, panSpeed, tiltSpeed) {
	// If a previous drive is still running (e.g. user pressed a new direction without stopping),
	// close it out first so its motion is accounted for.
	finishDrive(self)
	self._drive = {
		startTime: Date.now(),
		panDir,
		tiltDir,
		panSpeed: +panSpeed || 0,
		tiltSpeed: +tiltSpeed || 0,
	}
}

/** Finalize a HOLD-drive: compute elapsed → degrees moved → update state + variables. */
function finishDrive(self) {
	const d = self._drive
	if (!d) return
	self._drive = null
	const ms = Date.now() - d.startTime
	if (ms <= 0) return
	const sec = ms / 1000
	if (d.panDir !== 0 && d.panSpeed > 0) {
		const dps = (d.panSpeed / 24) * panDpsMax(self)
		self.state.panDeg = clampPanDeg(self, (self.state.panDeg || 0) + d.panDir * dps * sec)
		self.setVariableValues({ pan_degrees: self.state.panDeg.toFixed(1) })
	}
	if (d.tiltDir !== 0 && d.tiltSpeed > 0) {
		const dps = (d.tiltSpeed / 20) * tiltDpsMax(self)
		self.state.tiltDeg = clampTiltDeg(self, (self.state.tiltDeg || 0) + d.tiltDir * dps * sec)
		self.setVariableValues({ tilt_degrees: self.state.tiltDeg.toFixed(1) })
	}
}

/** Wrap every action callback so that a runtime throw is logged to the module
 *  log instead of surfacing as a Bitfocus Companion "yellow triangle" on the
 *  Stream Deck button. The user then still gets a clear, actionable error line
 *  in the Companion Log tab instead of an opaque UI warning. */
function wrapCallbacksSafely(actions, self) {
	for (const [id, def] of Object.entries(actions)) {
		if (!def || typeof def.callback !== 'function') continue
		const original = def.callback
		def.callback = async (event, context) => {
			try {
				return await original(event, context)
			} catch (e) {
				const msg = (e && e.message) || String(e)
				const stack = (e && e.stack) || ''
				try {
					self.log('error', `Action "${id}" threw: ${msg}\n${stack}`)
				} catch (_) {
					/* logger unavailable — swallow */
				}
			}
		}
	}
	return actions
}

export function getActions(self) {
	return wrapCallbacksSafely({
		/* ───────── Pan / Tilt drive (hold style — tracks elapsed time for pan_degrees / tilt_degrees) ───────── */
		pt_up: {
			name: 'Pan/Tilt: Up (hold)',
			options: [
				{ type: 'dropdown', id: 'tilt', label: 'Tilt Speed', default: self.config.tiltSpeed || 10, choices: TILT_SPEEDS },
			],
			callback: async ({ options }) => {
				startDrive(self, 0, +1, self.config.panSpeed, +options.tilt)
				await self.send(C.ptDrive(C.PT_DIR.UP, self.config.panSpeed, +options.tilt))
			},
		},
		pt_down: {
			name: 'Pan/Tilt: Down (hold)',
			options: [
				{ type: 'dropdown', id: 'tilt', label: 'Tilt Speed', default: self.config.tiltSpeed || 10, choices: TILT_SPEEDS },
			],
			callback: async ({ options }) => {
				startDrive(self, 0, -1, self.config.panSpeed, +options.tilt)
				await self.send(C.ptDrive(C.PT_DIR.DOWN, self.config.panSpeed, +options.tilt))
			},
		},
		pt_left: {
			name: 'Pan/Tilt: Left (hold)',
			options: [
				{ type: 'dropdown', id: 'pan', label: 'Pan Speed', default: self.config.panSpeed || 12, choices: PAN_SPEEDS },
			],
			callback: async ({ options }) => {
				startDrive(self, -1, 0, +options.pan, self.config.tiltSpeed)
				await self.send(C.ptDrive(C.PT_DIR.LEFT, +options.pan, self.config.tiltSpeed))
			},
		},
		pt_right: {
			name: 'Pan/Tilt: Right (hold)',
			options: [
				{ type: 'dropdown', id: 'pan', label: 'Pan Speed', default: self.config.panSpeed || 12, choices: PAN_SPEEDS },
			],
			callback: async ({ options }) => {
				startDrive(self, +1, 0, +options.pan, self.config.tiltSpeed)
				await self.send(C.ptDrive(C.PT_DIR.RIGHT, +options.pan, self.config.tiltSpeed))
			},
		},
		pt_up_left: {
			name: 'Pan/Tilt: Up-Left (hold)',
			options: [],
			callback: async () => {
				startDrive(self, -1, +1, self.config.panSpeed, self.config.tiltSpeed)
				await self.send(C.ptDrive(C.PT_DIR.UP_LEFT, self.config.panSpeed, self.config.tiltSpeed))
			},
		},
		pt_up_right: {
			name: 'Pan/Tilt: Up-Right (hold)',
			options: [],
			callback: async () => {
				startDrive(self, +1, +1, self.config.panSpeed, self.config.tiltSpeed)
				await self.send(C.ptDrive(C.PT_DIR.UP_RIGHT, self.config.panSpeed, self.config.tiltSpeed))
			},
		},
		pt_down_left: {
			name: 'Pan/Tilt: Down-Left (hold)',
			options: [],
			callback: async () => {
				startDrive(self, -1, -1, self.config.panSpeed, self.config.tiltSpeed)
				await self.send(C.ptDrive(C.PT_DIR.DOWN_LEFT, self.config.panSpeed, self.config.tiltSpeed))
			},
		},
		pt_down_right: {
			name: 'Pan/Tilt: Down-Right (hold)',
			options: [],
			callback: async () => {
				startDrive(self, +1, -1, self.config.panSpeed, self.config.tiltSpeed)
				await self.send(C.ptDrive(C.PT_DIR.DOWN_RIGHT, self.config.panSpeed, self.config.tiltSpeed))
			},
		},
		pt_stop: {
			name: 'Pan/Tilt: Stop',
			options: [],
			callback: async () => {
				finishDrive(self)
				await self.send(C.ptDrive(C.PT_DIR.STOP))
			},
		},

		pt_home: {
			name: 'Pan/Tilt: Home (true center + wide zoom)',
			options: [],
			callback: async () => {
				if (isNdi(self)) {
					// VHD20HAN: raw VISCA Home works, ptAbsolute goes to extremes
					await self.send(C.ptHome())
				} else {
					await self.send(C.ptAbsolute(0, 0, self.config.panSpeed || 12, self.config.tiltSpeed || 10))
				}
				await self.send(C.zoomDirect(0))
				self.state.panDeg = 0
				self.state.tiltDeg = 0
				self.state.zoomPos = 0
				self.setVariableValues({ pan_degrees: '0.0', tilt_degrees: '0.0' })
				updateZoomVars(self)
			},
		},
		pan_home_only: {
			name: 'Home: Pan only (to 0°, keeps Tilt & Zoom)',
			options: [
				{ type: 'dropdown', id: 'panSpeed', label: 'Pan speed', default: self.config.panSpeed || 12, choices: PAN_SPEEDS },
			],
			callback: async ({ options }) => {
				// Sync tracker from the physical camera so the "kept" axis (tilt) is byte-exact
				await refreshPanTiltFromCamera(self)
				self.state.panDeg = 0
				self.setVariableValues({ pan_degrees: '0.0' })
				const { panU, tiltU } = absoluteUnits(self)
				await self.send(C.ptAbsolute(panU, tiltU, +options.panSpeed, self.config.tiltSpeed || 10))
			},
		},
		tilt_home_only: {
			name: 'Home: Tilt only (to 0°, keeps Pan & Zoom)',
			options: [
				{ type: 'dropdown', id: 'tiltSpeed', label: 'Tilt speed', default: self.config.tiltSpeed || 10, choices: TILT_SPEEDS },
			],
			callback: async ({ options }) => {
				// Sync tracker from the physical camera so the "kept" axis (pan) is byte-exact
				await refreshPanTiltFromCamera(self)
				self.state.tiltDeg = 0
				self.setVariableValues({ tilt_degrees: '0.0' })
				const { panU, tiltU } = absoluteUnits(self)
				await self.send(C.ptAbsolute(panU, tiltU, self.config.panSpeed || 12, +options.tiltSpeed))
			},
		},
		zoom_home_only: {
			name: 'Home: Zoom only (widest, keeps Pan & Tilt)',
			options: [],
			callback: async () => {
				self.state.zoomPos = 0
				updateZoomVars(self)
				await self.send(C.zoomDirect(0))
			},
		},
		pt_reset: {
			name: 'Pan/Tilt: Reset',
			options: [],
			callback: async () => {
				await self.send(C.ptReset())
				self.state.panDeg = 0
				self.state.tiltDeg = 0
				self.setVariableValues({ pan_degrees: '0.0', tilt_degrees: '0.0' })
			},
		},
		pt_absolute: {
			name: 'Pan/Tilt: Absolute Position (raw units)',
			options: [
				{ type: 'number', id: 'pan', label: 'Pan (-32768..32767)', default: 0, min: -32768, max: 32767 },
				{ type: 'number', id: 'tilt', label: 'Tilt (-32768..32767)', default: 0, min: -32768, max: 32767 },
				{ type: 'dropdown', id: 'panSpeed', label: 'Pan Speed', default: self.config.panSpeed || 12, choices: PAN_SPEEDS },
				{ type: 'dropdown', id: 'tiltSpeed', label: 'Tilt Speed', default: self.config.tiltSpeed || 10, choices: TILT_SPEEDS },
			],
			callback: async ({ options }) =>
				self.send(C.ptAbsolute(+options.pan, +options.tilt, +options.panSpeed, +options.tiltSpeed)),
		},

		/* ───────── Pan / Tilt rotary HOLD (auto-stop after rotation halts) ───────── */
		pan_rotary_left: {
			name: 'Rotary HOLD: Pan Left (Stream Deck +)',
			options: [
				{ type: 'dropdown', id: 'speed', label: 'Speed', default: self.config.panSpeed || 12, choices: PAN_SPEEDS },
				{ type: 'number', id: 'holdMs', label: 'Hold (ms)', default: 180, min: 80, max: 2000 },
			],
			callback: async ({ options }) =>
				pulse(self, 'pt', 'L', () => C.ptDrive(C.PT_DIR.LEFT, +options.speed, self.config.tiltSpeed), () => C.ptDrive(C.PT_DIR.STOP), +options.holdMs),
		},
		pan_rotary_right: {
			name: 'Rotary HOLD: Pan Right (Stream Deck +)',
			options: [
				{ type: 'dropdown', id: 'speed', label: 'Speed', default: self.config.panSpeed || 12, choices: PAN_SPEEDS },
				{ type: 'number', id: 'holdMs', label: 'Hold (ms)', default: 180, min: 80, max: 2000 },
			],
			callback: async ({ options }) =>
				pulse(self, 'pt', 'R', () => C.ptDrive(C.PT_DIR.RIGHT, +options.speed, self.config.tiltSpeed), () => C.ptDrive(C.PT_DIR.STOP), +options.holdMs),
		},
		tilt_rotary_up: {
			name: 'Rotary HOLD: Tilt Up (Stream Deck +)',
			options: [
				{ type: 'dropdown', id: 'speed', label: 'Speed', default: self.config.tiltSpeed || 10, choices: TILT_SPEEDS },
				{ type: 'number', id: 'holdMs', label: 'Hold (ms)', default: 180, min: 80, max: 2000 },
			],
			callback: async ({ options }) =>
				pulse(self, 'pt', 'U', () => C.ptDrive(C.PT_DIR.UP, self.config.panSpeed, +options.speed), () => C.ptDrive(C.PT_DIR.STOP), +options.holdMs),
		},
		tilt_rotary_down: {
			name: 'Rotary HOLD: Tilt Down (Stream Deck +)',
			options: [
				{ type: 'dropdown', id: 'speed', label: 'Speed', default: self.config.tiltSpeed || 10, choices: TILT_SPEEDS },
				{ type: 'number', id: 'holdMs', label: 'Hold (ms)', default: 180, min: 80, max: 2000 },
			],
			callback: async ({ options }) =>
				pulse(self, 'pt', 'D', () => C.ptDrive(C.PT_DIR.DOWN, self.config.panSpeed, +options.speed), () => C.ptDrive(C.PT_DIR.STOP), +options.holdMs),
		},

		/* ───────── Pan / Tilt rotary STEP (absolute-degree mapping — works on both variants) ─────────
		 * Every click adjusts an internal degree counter and schedules a single throttled
		 * ptAbsolute command. Fast dial spins are coalesced into the latest target so 37 clicks
		 * to the right end at exactly +37° from the previous position (subject to unitsPerDegree
		 * calibration). Works because Tenveo NDI firmware DOES accept ptAbsolute even though it
		 * ignores relative Pan/Tilt commands. */
		pan_step_left: {
			name: 'Rotary STEP: Pan Left (° per click)',
			options: [
				{ type: 'number', id: 'deg', label: 'Degrees per click', default: 1, min: 0.1, max: 30, step: 0.1 },
				{ type: 'dropdown', id: 'speed', label: 'Move speed', default: self.config.panSpeed || 12, choices: PAN_SPEEDS },
			],
			callback: async ({ options }) => {
				self.state.panDeg = clampPanDeg(self, (self.state.panDeg || 0) - +options.deg)
				self.setVariableValues({ pan_degrees: self.state.panDeg.toFixed(1) })
				sendPtAbsoluteThrottled(self, +options.speed, self.config.tiltSpeed || 10)
			},
		},
		pan_step_right: {
			name: 'Rotary STEP: Pan Right (° per click)',
			options: [
				{ type: 'number', id: 'deg', label: 'Degrees per click', default: 1, min: 0.1, max: 30, step: 0.1 },
				{ type: 'dropdown', id: 'speed', label: 'Move speed', default: self.config.panSpeed || 12, choices: PAN_SPEEDS },
			],
			callback: async ({ options }) => {
				self.state.panDeg = clampPanDeg(self, (self.state.panDeg || 0) + +options.deg)
				self.setVariableValues({ pan_degrees: self.state.panDeg.toFixed(1) })
				sendPtAbsoluteThrottled(self, +options.speed, self.config.tiltSpeed || 10)
			},
		},
		tilt_step_up: {
			name: 'Rotary STEP: Tilt Up (° per click)',
			options: [
				{ type: 'number', id: 'deg', label: 'Degrees per click', default: 1, min: 0.1, max: 30, step: 0.1 },
				{ type: 'dropdown', id: 'speed', label: 'Move speed', default: self.config.tiltSpeed || 10, choices: TILT_SPEEDS },
			],
			callback: async ({ options }) => {
				self.state.tiltDeg = clampTiltDeg(self, (self.state.tiltDeg || 0) + +options.deg)
				self.setVariableValues({ tilt_degrees: self.state.tiltDeg.toFixed(1) })
				sendPtAbsoluteThrottled(self, self.config.panSpeed || 12, +options.speed)
			},
		},
		tilt_step_down: {
			name: 'Rotary STEP: Tilt Down (° per click)',
			options: [
				{ type: 'number', id: 'deg', label: 'Degrees per click', default: 1, min: 0.1, max: 30, step: 0.1 },
				{ type: 'dropdown', id: 'speed', label: 'Move speed', default: self.config.tiltSpeed || 10, choices: TILT_SPEEDS },
			],
			callback: async ({ options }) => {
				self.state.tiltDeg = clampTiltDeg(self, (self.state.tiltDeg || 0) - +options.deg)
				self.setVariableValues({ tilt_degrees: self.state.tiltDeg.toFixed(1) })
				sendPtAbsoluteThrottled(self, self.config.panSpeed || 12, +options.speed)
			},
		},
		pt_step_reset: {
			name: 'Rotary STEP: Reset degree counter (no camera movement)',
			options: [],
			callback: async () => {
				self.state.panDeg = 0
				self.state.tiltDeg = 0
				self.setVariableValues({ pan_degrees: '0.0', tilt_degrees: '0.0' })
			},
		},

		/* ───────── Zoom ───────── */
		zoom_in: {
			name: 'Zoom: In (Tele)',
			options: [{ type: 'dropdown', id: 'speed', label: 'Speed', default: self.config.zoomSpeed || 4, choices: ZOOM_SPEEDS }],
			callback: async ({ options }) => {
				self._zoomDriveDir = 'tele'
				self._zoomDriveSpeed = +options.speed
				self._zoomDriveStart = Date.now()
				await self.send(C.zoomTeleVar(+options.speed))
			},
		},
		zoom_out: {
			name: 'Zoom: Out (Wide)',
			options: [{ type: 'dropdown', id: 'speed', label: 'Speed', default: self.config.zoomSpeed || 4, choices: ZOOM_SPEEDS }],
			callback: async ({ options }) => {
				self._zoomDriveDir = 'wide'
				self._zoomDriveSpeed = +options.speed
				self._zoomDriveStart = Date.now()
				await self.send(C.zoomWideVar(+options.speed))
			},
		},
		zoom_stop: {
			name: 'Zoom: Stop',
			options: [],
			callback: async () => {
				if (self._zoomStopTimer) { clearTimeout(self._zoomStopTimer); self._zoomStopTimer = null }
				const startTime = self._zoomDriveStart
				const spd = self._zoomDriveSpeed || 0
				const dir = self._zoomDriveDir
				self._zoomDriveDir = null
				self._zoomDriveSpeed = 0
				self._zoomDriveStart = null
				await self.send(C.zoomStop())
				if (dir && startTime) {
					const elapsed = (Date.now() - startTime) / 1000
					const delta = elapsed * zoomUnitsPerSec(self, spd) * (dir === 'tele' ? 1 : -1)
					self.state.zoomPos = Math.max(0, Math.min(16384, (self.state.zoomPos || 0) + delta))
					updateZoomVars(self)
				}
			},
		},
		zoom_direct: {
			name: 'Zoom: Direct Position (0-16384)',
			options: [{ type: 'number', id: 'pos', label: 'Position', default: 0, min: 0, max: 16384 }],
			callback: async ({ options }) => {
				const pos = Math.max(0, Math.min(16384, +options.pos))
				self.state.zoomPos = pos
				updateZoomVars(self)
				await self.send(C.zoomDirect(pos))
			},
		},
		zoom_rotary_in: {
			name: 'Rotary HOLD: Zoom In (tracked)',
			options: [
				{ type: 'dropdown', id: 'speed', label: 'Speed', default: self.config.zoomSpeed || 4, choices: ZOOM_SPEEDS },
				{ type: 'number', id: 'holdMs', label: 'Idle before auto-stop (ms)', default: 800, min: 100, max: 2000 },
			],
			callback: async ({ options }) => {
				zoomDriveStep(self, 'tele', +options.speed, +options.holdMs)
			},
		},
		zoom_rotary_out: {
			name: 'Rotary HOLD: Zoom Out (tracked)',
			options: [
				{ type: 'dropdown', id: 'speed', label: 'Speed', default: self.config.zoomSpeed || 4, choices: ZOOM_SPEEDS },
				{ type: 'number', id: 'holdMs', label: 'Idle before auto-stop (ms)', default: 800, min: 100, max: 2000 },
			],
			callback: async ({ options }) => {
				zoomDriveStep(self, 'wide', +options.speed, +options.holdMs)
			},
		},
		zoom_step_in: {
			name: 'Rotary STEP: Zoom In (Tele) — variable-speed drive + auto-stop',
			options: [
				{ type: 'dropdown', id: 'speed', label: 'Zoom speed', default: self.config.zoomSpeed || 4, choices: ZOOM_SPEEDS },
				{ type: 'number', id: 'idleMs', label: 'Idle time before auto-stop (ms)', default: 800, min: 100, max: 2000 },
			],
			callback: async ({ options }) => {
				zoomDriveStep(self, 'tele', +options.speed, +options.idleMs)
			},
		},
		zoom_step_out: {
			name: 'Rotary STEP: Zoom Out (Wide) — variable-speed drive + auto-stop',
			options: [
				{ type: 'dropdown', id: 'speed', label: 'Zoom speed', default: self.config.zoomSpeed || 4, choices: ZOOM_SPEEDS },
				{ type: 'number', id: 'idleMs', label: 'Idle time before auto-stop (ms)', default: 800, min: 100, max: 2000 },
			],
			callback: async ({ options }) => {
				zoomDriveStep(self, 'wide', +options.speed, +options.idleMs)
			},
		},

		/* ───────── Rotary TICK zoom (v1.16.0) ─────────
		 * True discrete-per-click zoom. Each rotary tick moves the zoom by a
		 * fixed number of units and updates zoom_position / zoom_percent
		 * IMMEDIATELY — no time-based estimation, no auto-stop drift. The
		 * VISCA send uses zoomDirect(newPos) so the camera lands exactly
		 * where the variable claims. Use this when you want the zoom_percent
		 * variable to move visibly in lock-step with the wheel.        */
		zoom_rotary_tick_in: {
			name: 'Rotary TICK: Zoom In (Tele) — discrete step, updates zoom_percent instantly',
			options: [
				{ type: 'number', id: 'step', label: 'Units per click (max 16384)', default: 500, min: 10, max: 8000 },
			],
			callback: async ({ options }) => {
				const step = Math.max(1, +options.step || 500)
				const cur = Math.max(0, Math.min(16384, +self.state.zoomPos || 0))
				const next = Math.min(16384, cur + step)
				self.state.zoomPos = next
				updateZoomVars(self)
				await self.send(C.zoomDirect(next))
			},
		},
		zoom_rotary_tick_out: {
			name: 'Rotary TICK: Zoom Out (Wide) — discrete step, updates zoom_percent instantly',
			options: [
				{ type: 'number', id: 'step', label: 'Units per click (max 16384)', default: 500, min: 10, max: 8000 },
			],
			callback: async ({ options }) => {
				const step = Math.max(1, +options.step || 500)
				const cur = Math.max(0, Math.min(16384, +self.state.zoomPos || 0))
				const next = Math.max(0, cur - step)
				self.state.zoomPos = next
				updateZoomVars(self)
				await self.send(C.zoomDirect(next))
			},
		},

		/* ───────── Focus ───────── */
		focus_auto: {
			name: 'Focus: Auto On',
			options: [],
			callback: async () => {
				await self.send(C.focusAuto())
				self.state.af = 'on'
				self.setVariableValues({ af: 'on', focus_mode: 'Auto' })
				self.checkFeedbacks('af_state')
				// Give AF a moment to converge, then re-sync focus_position from the camera.
				// On non-NDI this updates the tracker to the real focal distance; on NDI the
				// inquiry is silently dropped, so we clear the tracker so users see it's stale.
				setTimeout(() => refreshFocusFromCamera(self), 1200)
			},
		},
		focus_manual: {
			name: 'Focus: Manual',
			options: [],
			callback: async () => {
				await self.send(C.focusManual())
				self.state.af = 'off'
				self.setVariableValues({ af: 'off', focus_mode: 'Manual' })
				self.checkFeedbacks('af_state')
				setTimeout(() => refreshFocusFromCamera(self), 400)
			},
		},
		focus_toggle: {
			name: 'Focus: Auto Toggle',
			options: [],
			callback: async () => {
				await self.send(C.focusAutoToggle())
				const next = self.state.af === 'on' ? 'off' : 'on'
				self.state.af = next
				self.setVariableValues({ af: next, focus_mode: next === 'on' ? 'Auto' : 'Manual' })
				self.checkFeedbacks('af_state')
				setTimeout(() => refreshFocusFromCamera(self), 1200)
			},
		},
		focus_one_push: {
			name: 'Focus: One-Push AF (auto-focus once)',
			options: [],
			callback: async () => {
				await self.send(C.focusOnePush())
				self.setVariableValues({ focus_mode: 'One-Push' })
				// One-push typically takes 1-2 seconds to complete
				setTimeout(async () => {
					await refreshFocusFromCamera(self)
					self.setVariableValues({ focus_mode: self.state.af === 'on' ? 'Auto' : 'Manual' })
				}, 2000)
			},
		},
		focus_near: {
			name: 'Focus: Near',
			options: [{ type: 'dropdown', id: 'speed', label: 'Speed', default: 4, choices: ZOOM_SPEEDS }],
			callback: async ({ options }) => {
				self._focusDriveDir = 'near'
				self._focusDriveSpeed = +options.speed
				self._focusDriveStart = Date.now()
				await self.send(C.focusNearVar(+options.speed))
			},
		},
		focus_far: {
			name: 'Focus: Far',
			options: [{ type: 'dropdown', id: 'speed', label: 'Speed', default: 4, choices: ZOOM_SPEEDS }],
			callback: async ({ options }) => {
				self._focusDriveDir = 'far'
				self._focusDriveSpeed = +options.speed
				self._focusDriveStart = Date.now()
				await self.send(C.focusFarVar(+options.speed))
			},
		},
		focus_stop: {
			name: 'Focus: Stop',
			options: [],
			callback: async () => {
				if (self._focusStopTimer) { clearTimeout(self._focusStopTimer); self._focusStopTimer = null }
				const startTime = self._focusDriveStart
				const spd = self._focusDriveSpeed || 0
				const dir = self._focusDriveDir
				self._focusDriveDir = null
				self._focusDriveSpeed = 0
				self._focusDriveStart = null
				await self.send(C.focusStop())
				if (dir && startTime) {
					const elapsed = (Date.now() - startTime) / 1000
					const delta = elapsed * focusUnitsPerSec(self, spd) * (dir === 'far' ? 1 : -1)
					self.state.focusPos = Math.max(0, Math.min(16384, (self.state.focusPos || 0) + delta))
					updateFocusVars(self)
				}
			},
		},
		focus_lock_on: { name: 'Focus: Lock On', options: [], callback: async () => self.send(C.focusLockOn()) },
		focus_lock_off: { name: 'Focus: Lock Off', options: [], callback: async () => self.send(C.focusLockOff()) },
		focus_direct: {
			name: 'Focus: Direct Position',
			options: [{ type: 'number', id: 'pos', label: 'Position (0-16384)', default: 0, min: 0, max: 16384 }],
			callback: async ({ options }) => {
				const pos = Math.max(0, Math.min(16384, +options.pos))
				self.state.focusPos = pos
				self.setVariableValues({
					focus_position: pos,
					focus_percent: Math.round((pos / 16384) * 100),
				})
				await self.send(C.focusDirect(pos))
			},
		},
		focus_rotary_near: {
			name: 'Rotary HOLD: Focus Near (tracked)',
			options: [
				{ type: 'dropdown', id: 'speed', label: 'Speed', default: 4, choices: ZOOM_SPEEDS },
				{ type: 'number', id: 'holdMs', label: 'Idle before auto-stop (ms)', default: 200, min: 50, max: 2000 },
			],
			callback: async ({ options }) => {
				focusDriveStep(self, 'near', +options.speed, +options.holdMs)
			},
		},
		focus_rotary_far: {
			name: 'Rotary HOLD: Focus Far (tracked)',
			options: [
				{ type: 'dropdown', id: 'speed', label: 'Speed', default: 4, choices: ZOOM_SPEEDS },
				{ type: 'number', id: 'holdMs', label: 'Idle before auto-stop (ms)', default: 200, min: 50, max: 2000 },
			],
			callback: async ({ options }) => {
				focusDriveStep(self, 'far', +options.speed, +options.holdMs)
			},
		},
		focus_step_near: {
			name: 'Rotary STEP: Focus Near — variable-speed drive + auto-stop',
			options: [
				{ type: 'dropdown', id: 'speed', label: 'Focus speed', default: 4, choices: ZOOM_SPEEDS },
				{ type: 'number', id: 'idleMs', label: 'Idle time before auto-stop (ms)', default: 250, min: 40, max: 500 },
			],
			callback: async ({ options }) => {
				focusDriveStep(self, 'near', +options.speed, +options.idleMs)
			},
		},
		focus_step_far: {
			name: 'Rotary STEP: Focus Far — variable-speed drive + auto-stop',
			options: [
				{ type: 'dropdown', id: 'speed', label: 'Focus speed', default: 4, choices: ZOOM_SPEEDS },
				{ type: 'number', id: 'idleMs', label: 'Idle time before auto-stop (ms)', default: 250, min: 40, max: 500 },
			],
			callback: async ({ options }) => {
				focusDriveStep(self, 'far', +options.speed, +options.idleMs)
			},
		},
		focus_reset_tracker: {
			name: 'Focus: Reset tracker (no camera movement)',
			options: [
				{ type: 'number', id: 'pos', label: 'Seed focus_position at (0-16384)', default: 0, min: 0, max: 16384 },
			],
			callback: async ({ options }) => {
				self.state.focusPos = Math.max(0, Math.min(16384, +options.pos))
				updateFocusVars(self)
			},
		},

		/* ───────── Presets (variant-aware) ───────── */
		preset_recall: {
			name: 'Preset: Recall',
			options: [{ type: 'number', id: 'n', label: 'Preset (1-255)', default: 1, min: 1, max: 255 }],
			callback: async ({ options }) => {
				const n = +options.n
				if (isNdi(self)) {
					await self.send(C.presetRecall(n))
				} else if (self.onvif) {
					try { await self.onvif.gotoPreset(String(n)) } catch (e) { self.log('error', `ONVIF GotoPreset ${n}: ${e.message}`) }
				} else {
					await self.send(C.presetRecall(n))
				}
				self.state.lastPreset = n
				self.setVariableValues({ last_preset: n })
				self.checkFeedbacks('preset_recalled')
			},
		},
		preset_recall_var: {
			name: 'Preset: Recall (from variable)',
			options: [{ type: 'textinput', id: 'expr', label: 'Preset (expression)', default: '1', useVariables: true }],
			callback: async ({ options }, ctx) => {
				const raw = await ctx.parseVariablesInString(options.expr)
				const n = parseInt(raw, 10)
				if (Number.isNaN(n)) return self.log('warn', `Invalid preset expression: ${raw}`)
				if (isNdi(self)) {
					await self.send(C.presetRecall(n))
				} else if (self.onvif) {
					try { await self.onvif.gotoPreset(String(n)) } catch (e) { self.log('error', `ONVIF GotoPreset ${n}: ${e.message}`) }
				} else {
					await self.send(C.presetRecall(n))
				}
				self.state.lastPreset = n
				self.setVariableValues({ last_preset: n })
				self.checkFeedbacks('preset_recalled')
			},
		},
		preset_save: {
			name: 'Preset: Save',
			options: [
				{ type: 'number', id: 'n', label: 'Preset (1-255)', default: 1, min: 1, max: 255 },
				{ type: 'textinput', id: 'name', label: 'Preset name (ONVIF only)', default: '' },
			],
			callback: async ({ options }) => {
				const n = +options.n
				if (isNdi(self)) {
					await self.send(C.presetSet(n))
				} else if (self.onvif) {
					try { await self.onvif.setPreset(String(n), options.name || `Preset ${n}`) } catch (e) { self.log('error', `ONVIF SetPreset ${n}: ${e.message}`) }
				} else {
					await self.send(C.presetSet(n))
				}
			},
		},
		preset_clear: {
			name: 'Preset: Clear',
			options: [{ type: 'number', id: 'n', label: 'Preset (1-255)', default: 1, min: 1, max: 255 }],
			callback: async ({ options }) => {
				const n = +options.n
				if (isNdi(self)) {
					await self.send(C.presetReset(n))
				} else if (self.onvif) {
					try { await self.onvif.removePreset(String(n)) } catch (e) { self.log('error', `ONVIF RemovePreset ${n}: ${e.message}`) }
				} else {
					await self.send(C.presetReset(n))
				}
			},
		},

		/* ───────── Rotary preset browsing (v1.15.0) ─────────
		 * Two rotaries — one for SAVE, one for RECALL.
		 *   • Turn CW  → increments   preset_save_index / preset_recall_index (wraps at max→min)
		 *   • Turn CCW → decrements                                        (wraps at min→max)
		 *   • Push     → save   or   recall  the currently pointed preset.
		 * The pointed index is a Companion variable so you can show it on the button face,
		 * e.g. text  →  "Save\n$(tenveo:preset_save_index)"                */
		preset_save_scroll_up: {
			name: 'Preset SAVE rotary: Scroll → next index (no VISCA sent)',
			options: [
				{ type: 'number', id: 'min', label: 'Min preset', default: 1, min: 1, max: 255 },
				{ type: 'number', id: 'max', label: 'Max preset', default: 10, min: 1, max: 255 },
				{ type: 'number', id: 'step', label: 'Step per click', default: 1, min: 1, max: 20 },
			],
			callback: async ({ options }) => {
				const min = Math.max(1, +options.min || 1)
				const max = Math.min(255, Math.max(min, +options.max || 10))
				const step = Math.max(1, +options.step || 1)
				let cur = +self.state.presetSaveIdx || min
				cur += step
				if (cur > max) cur = min + ((cur - max - 1) % (max - min + 1))
				self.state.presetSaveIdx = cur
				self.setVariableValues({ preset_save_index: cur })
			},
		},
		preset_save_scroll_down: {
			name: 'Preset SAVE rotary: Scroll ← previous index (no VISCA sent)',
			options: [
				{ type: 'number', id: 'min', label: 'Min preset', default: 1, min: 1, max: 255 },
				{ type: 'number', id: 'max', label: 'Max preset', default: 10, min: 1, max: 255 },
				{ type: 'number', id: 'step', label: 'Step per click', default: 1, min: 1, max: 20 },
			],
			callback: async ({ options }) => {
				const min = Math.max(1, +options.min || 1)
				const max = Math.min(255, Math.max(min, +options.max || 10))
				const step = Math.max(1, +options.step || 1)
				let cur = +self.state.presetSaveIdx || min
				cur -= step
				if (cur < min) cur = max - ((min - cur - 1) % (max - min + 1))
				self.state.presetSaveIdx = cur
				self.setVariableValues({ preset_save_index: cur })
			},
		},
		preset_save_confirm: {
			name: 'Preset SAVE rotary: PUSH → save preset at current index',
			options: [
				{ type: 'textinput', id: 'name', label: 'Preset name (ONVIF only, "$INDEX" is replaced)', default: 'Preset $INDEX' },
			],
			callback: async ({ options }) => {
				const n = +self.state.presetSaveIdx || 1
				const label = String(options.name || '').replace(/\$INDEX/gi, String(n)) || `Preset ${n}`
				if (isNdi(self)) {
					await self.send(C.presetSet(n))
				} else if (self.onvif) {
					try { await self.onvif.setPreset(String(n), label) } catch (e) { self.log('error', `ONVIF SetPreset ${n}: ${e.message}`) }
				} else {
					await self.send(C.presetSet(n))
				}
				self.log('info', `Preset SAVE rotary → saved preset ${n} ("${label}")`)
			},
		},
		preset_save_set_index: {
			name: 'Preset SAVE rotary: Jump index directly',
			options: [{ type: 'number', id: 'n', label: 'Set index to', default: 1, min: 1, max: 255 }],
			callback: async ({ options }) => {
				const n = Math.max(1, Math.min(255, +options.n || 1))
				self.state.presetSaveIdx = n
				self.setVariableValues({ preset_save_index: n })
			},
		},
		preset_recall_scroll_up: {
			name: 'Preset RECALL rotary: Scroll → next index (no VISCA sent)',
			options: [
				{ type: 'number', id: 'min', label: 'Min preset', default: 1, min: 1, max: 255 },
				{ type: 'number', id: 'max', label: 'Max preset', default: 10, min: 1, max: 255 },
				{ type: 'number', id: 'step', label: 'Step per click', default: 1, min: 1, max: 20 },
			],
			callback: async ({ options }) => {
				const min = Math.max(1, +options.min || 1)
				const max = Math.min(255, Math.max(min, +options.max || 10))
				const step = Math.max(1, +options.step || 1)
				let cur = +self.state.presetRecallIdx || min
				cur += step
				if (cur > max) cur = min + ((cur - max - 1) % (max - min + 1))
				self.state.presetRecallIdx = cur
				self.setVariableValues({ preset_recall_index: cur })
			},
		},
		preset_recall_scroll_down: {
			name: 'Preset RECALL rotary: Scroll ← previous index (no VISCA sent)',
			options: [
				{ type: 'number', id: 'min', label: 'Min preset', default: 1, min: 1, max: 255 },
				{ type: 'number', id: 'max', label: 'Max preset', default: 10, min: 1, max: 255 },
				{ type: 'number', id: 'step', label: 'Step per click', default: 1, min: 1, max: 20 },
			],
			callback: async ({ options }) => {
				const min = Math.max(1, +options.min || 1)
				const max = Math.min(255, Math.max(min, +options.max || 10))
				const step = Math.max(1, +options.step || 1)
				let cur = +self.state.presetRecallIdx || min
				cur -= step
				if (cur < min) cur = max - ((min - cur - 1) % (max - min + 1))
				self.state.presetRecallIdx = cur
				self.setVariableValues({ preset_recall_index: cur })
			},
		},
		preset_recall_confirm: {
			name: 'Preset RECALL rotary: PUSH → recall preset at current index',
			options: [],
			callback: async () => {
				const n = +self.state.presetRecallIdx || 1
				if (isNdi(self)) {
					await self.send(C.presetRecall(n))
				} else if (self.onvif) {
					try { await self.onvif.gotoPreset(String(n)) } catch (e) { self.log('error', `ONVIF GotoPreset ${n}: ${e.message}`) }
				} else {
					await self.send(C.presetRecall(n))
				}
				self.state.lastPreset = n
				self.setVariableValues({ last_preset: n })
				self.checkFeedbacks('preset_recalled')
				self.log('info', `Preset RECALL rotary → recalled preset ${n}`)
			},
		},
		preset_recall_set_index: {
			name: 'Preset RECALL rotary: Jump index directly',
			options: [{ type: 'number', id: 'n', label: 'Set index to', default: 1, min: 1, max: 255 }],
			callback: async ({ options }) => {
				const n = Math.max(1, Math.min(255, +options.n || 1))
				self.state.presetRecallIdx = n
				self.setVariableValues({ preset_recall_index: n })
			},
		},

		/* ───────── Power / OSD / IR ───────── */
		power_on: { name: 'Power: On', options: [], callback: async () => self.send(C.powerOn()) },
		power_off: { name: 'Power: Off (Standby)', options: [], callback: async () => self.send(C.powerOff()) },
		power_toggle: {
			name: 'Power: Toggle',
			options: [],
			callback: async () => self.send(self.state.power === 'on' ? C.powerOff() : C.powerOn()),
		},
		menu_on: {
			name: 'OSD: Open Menu',
			options: [],
			callback: async () => {
				await self.send(C.menuOn())
				self.state.menuOpen = true
			},
		},
		menu_off: {
			name: 'OSD: Close Menu',
			options: [],
			callback: async () => {
				await self.send(C.menuOff())
				self.state.menuOpen = false
			},
		},
		menu_toggle: {
			name: 'OSD: Toggle Menu (open ↔ close, tracked locally)',
			options: [],
			callback: async () => {
				// The preset-95 (81 01 04 3F 02 5F FF) VISCA-toggle hack does
				// not work on Tenveo VHD20HAN. Use the reliable on/off pair
				// and track state locally.
				if (self.state.menuOpen) {
					await self.send(C.menuOff())
					self.state.menuOpen = false
				} else {
					await self.send(C.menuOn())
					self.state.menuOpen = true
				}
			},
		},
		menu_up: { name: 'OSD: Navigate Up', options: [], callback: async () => osdNav(self, 'up') },
		menu_down: { name: 'OSD: Navigate Down', options: [], callback: async () => osdNav(self, 'down') },
		menu_left: { name: 'OSD: Navigate Left', options: [], callback: async () => osdNav(self, 'left') },
		menu_right: { name: 'OSD: Navigate Right', options: [], callback: async () => osdNav(self, 'right') },
		menu_enter: { name: 'OSD: Enter', options: [], callback: async () => self.send(C.menuEnter()) },
		menu_back: { name: 'OSD: Back', options: [], callback: async () => self.send(C.menuBack()) },
		ir_on: { name: 'IR Remote: Enable', options: [], callback: async () => self.send(C.irOn()) },
		ir_off: { name: 'IR Remote: Disable', options: [], callback: async () => self.send(C.irOff()) },

		/* ───────── Image Flip / Mirror (v1.18.0) ─────────
		 * Sony VISCA CAM_PictureFlip (0x04 0x66) = vertical flip (upside-down)
		 * Sony VISCA CAM_LR_Reverse (0x04 0x61) = horizontal mirror (left↔right)
		 * All three toggle actions track state locally (self.state.flipOn /
		 * self.state.mirrorOn) since Tenveo VHD firmware often ignores the
		 * corresponding inquiries silently. */
		image_flip_toggle: {
			name: 'Image: Toggle Flip (upside-down on ↔ off)',
			options: [],
			callback: async () => {
				const next = !self.state.flipOn
				self.state.flipOn = next
				self.setVariableValues({ image_flip: next ? 'on' : 'off' })
				await self.send(next ? C.flipOn() : C.flipOff())
			},
		},
		image_mirror_toggle: {
			name: 'Image: Toggle Mirror (left↔right on ↔ off)',
			options: [],
			callback: async () => {
				const next = !self.state.mirrorOn
				self.state.mirrorOn = next
				self.setVariableValues({ image_mirror: next ? 'on' : 'off' })
				await self.send(next ? C.mirrorOn() : C.mirrorOff())
			},
		},
		image_flip_mirror_toggle: {
			name: 'Image: Toggle Flip + Mirror (both on ↔ both off, single button)',
			options: [],
			callback: async () => {
				// Use flipOn as the master state — flip both together.
				const next = !self.state.flipOn
				self.state.flipOn = next
				self.state.mirrorOn = next
				self.setVariableValues({
					image_flip: next ? 'on' : 'off',
					image_mirror: next ? 'on' : 'off',
				})
				await self.send(next ? C.flipOn() : C.flipOff())
				await self.send(next ? C.mirrorOn() : C.mirrorOff())
			},
		},
		image_flip_on: { name: 'Image: Flip ON', options: [], callback: async () => {
			self.state.flipOn = true
			self.setVariableValues({ image_flip: 'on' })
			await self.send(C.flipOn())
		} },
		image_flip_off: { name: 'Image: Flip OFF', options: [], callback: async () => {
			self.state.flipOn = false
			self.setVariableValues({ image_flip: 'off' })
			await self.send(C.flipOff())
		} },
		image_mirror_on: { name: 'Image: Mirror ON', options: [], callback: async () => {
			self.state.mirrorOn = true
			self.setVariableValues({ image_mirror: 'on' })
			await self.send(C.mirrorOn())
		} },
		image_mirror_off: { name: 'Image: Mirror OFF', options: [], callback: async () => {
			self.state.mirrorOn = false
			self.setVariableValues({ image_mirror: 'off' })
			await self.send(C.mirrorOff())
		} },

		/* ───────── Exposure ───────── */
		exposure_mode: {
			name: 'Exposure: Mode',
			options: [
				{
					type: 'dropdown',
					id: 'mode',
					label: 'Mode',
					default: C.AE_MODE.FULL_AUTO,
					choices: [
						{ id: C.AE_MODE.FULL_AUTO, label: 'Full Auto' },
						{ id: C.AE_MODE.MANUAL, label: 'Manual' },
						{ id: C.AE_MODE.SHUTTER_PRI, label: 'Shutter Priority' },
						{ id: C.AE_MODE.IRIS_PRI, label: 'Iris Priority' },
						{ id: C.AE_MODE.BRIGHT, label: 'Bright' },
					],
				},
			],
			callback: async ({ options }) => {
				const m = +options.mode
				await self.send(C.aeMode(m))
				self.state.aeMode = m
				const label = m === C.AE_MODE.FULL_AUTO ? 'Full Auto' :
					m === C.AE_MODE.MANUAL ? 'Manual' :
					m === C.AE_MODE.SHUTTER_PRI ? 'Shutter Pri' :
					m === C.AE_MODE.IRIS_PRI ? 'Iris Pri' :
					m === C.AE_MODE.BRIGHT ? 'Bright' : `0x${m.toString(16)}`
				self.setVariableValues({ exposure_mode: label })
				self.checkFeedbacks('exposure_mode')
			},
		},
		ae_mode_toggle: {
			name: 'Exposure: Toggle Auto ↔ Manual (AE mode)',
			options: [],
			callback: async () => {
				const isAuto = self.state.aeMode === C.AE_MODE.FULL_AUTO
				const next = isAuto ? C.AE_MODE.MANUAL : C.AE_MODE.FULL_AUTO
				await self.send(C.aeMode(next))
				self.state.aeMode = next
				self.setVariableValues({ exposure_mode: isAuto ? 'Manual' : 'Full Auto' })
				self.checkFeedbacks('exposure_mode')
			},
		},
		iris_up: {
			name: 'Iris: Up (opens aperture, wider)',
			options: [],
			callback: async () => {
				self.state.iris = Math.min(13, (+self.state.iris || 0) + 1)
				updateIrisVars(self)
				await self.send(C.irisUp())
			},
		},
		iris_down: {
			name: 'Iris: Down (closes aperture, narrower)',
			options: [],
			callback: async () => {
				self.state.iris = Math.max(0, (+self.state.iris || 0) - 1)
				updateIrisVars(self)
				await self.send(C.irisDown())
			},
		},
		iris_reset: {
			name: 'Iris: Reset',
			options: [],
			callback: async () => {
				await self.send(C.irisReset())
			},
		},
		iris_direct: {
			name: 'Iris: Direct Value (0=Off, 13=f1.6)',
			options: [{ type: 'number', id: 'v', label: 'Value', default: 7, min: 0, max: 13 }],
			callback: async ({ options }) => {
				self.state.iris = Math.max(0, Math.min(13, +options.v))
				updateIrisVars(self)
				await self.send(C.irisDirect(+options.v))
			},
		},
		iris_rotary_up: {
			name: 'Rotary STEP: Iris Up',
			options: [],
			callback: async () => {
				self.state.iris = Math.min(13, (+self.state.iris || 0) + 1)
				updateIrisVars(self)
				await self.send(C.irisUp())
			},
		},
		iris_rotary_down: {
			name: 'Rotary STEP: Iris Down',
			options: [],
			callback: async () => {
				self.state.iris = Math.max(0, (+self.state.iris || 0) - 1)
				updateIrisVars(self)
				await self.send(C.irisDown())
			},
		},

		shutter_up: { name: 'Shutter: Up', options: [], callback: async () => self.send(C.shutterUp()) },
		shutter_down: { name: 'Shutter: Down', options: [], callback: async () => self.send(C.shutterDown()) },
		shutter_reset: { name: 'Shutter: Reset', options: [], callback: async () => self.send(C.shutterReset()) },
		shutter_direct: {
			name: 'Shutter: Direct Value (0-21)',
			options: [{ type: 'number', id: 'v', label: 'Value', default: 11, min: 0, max: 21 }],
			callback: async ({ options }) => self.send(C.shutterDirect(+options.v)),
		},
		shutter_rotary_up:   { name: 'Rotary STEP: Shutter Up',   options: [], callback: async () => self.send(C.shutterUp()) },
		shutter_rotary_down: { name: 'Rotary STEP: Shutter Down', options: [], callback: async () => self.send(C.shutterDown()) },

		gain_up: {
			name: 'Gain: Up (routes to ExpComp on NDI variant)',
			options: [],
			callback: async () => {
				if (isNdi(self)) {
					self.state.expComp = Math.min(7, (+self.state.expComp || 0) + 1)
					updateExpCompVar(self)
					await self.send(C.expCompUp())
				} else {
					await self.send(C.gainUp())
				}
			},
		},
		gain_down: {
			name: 'Gain: Down (routes to ExpComp on NDI variant)',
			options: [],
			callback: async () => {
				if (isNdi(self)) {
					self.state.expComp = Math.max(-7, (+self.state.expComp || 0) - 1)
					updateExpCompVar(self)
					await self.send(C.expCompDown())
				} else {
					await self.send(C.gainDown())
				}
			},
		},
		gain_reset: {
			name: 'Gain: Reset (routes to ExpComp on NDI variant)',
			options: [],
			callback: async () => {
				if (isNdi(self)) {
					self.state.expComp = 0
					updateExpCompVar(self)
					await self.send(C.expCompReset())
				} else {
					await self.send(C.gainReset())
				}
			},
		},
		gain_direct: {
			name: 'Gain: Direct Value (0-14) — Standard variant only',
			options: [{ type: 'number', id: 'v', label: 'Value', default: 4, min: 0, max: 14 }],
			callback: async ({ options }) => self.send(C.gainDirect(+options.v)),
		},
		gain_limit: {
			name: 'Gain: Set Gain Limit — Standard variant only',
			options: [{ type: 'number', id: 'v', label: 'Limit (4-15)', default: 9, min: 4, max: 15 }],
			callback: async ({ options }) => self.send(C.gainLimit(+options.v)),
		},
		gain_rotary_up: {
			name: 'Rotary STEP: Gain Up (auto-routes to ExpComp on NDI)',
			options: [],
			callback: async () => {
				if (isNdi(self)) {
					self.state.expComp = Math.min(7, (+self.state.expComp || 0) + 1)
					updateExpCompVar(self)
					await self.send(C.expCompUp())
				} else {
					await self.send(C.gainUp())
				}
			},
		},
		gain_rotary_down: {
			name: 'Rotary STEP: Gain Down (auto-routes to ExpComp on NDI)',
			options: [],
			callback: async () => {
				if (isNdi(self)) {
					self.state.expComp = Math.max(-7, (+self.state.expComp || 0) - 1)
					updateExpCompVar(self)
					await self.send(C.expCompDown())
				} else {
					await self.send(C.gainDown())
				}
			},
		},

		bright_up: { name: 'Bright: Up', options: [], callback: async () => self.send(C.brightUp()) },
		bright_down: { name: 'Bright: Down', options: [], callback: async () => self.send(C.brightDown()) },
		bright_direct: {
			name: 'Bright: Direct Value (0-27)',
			options: [{ type: 'number', id: 'v', label: 'Value', default: 13, min: 0, max: 27 }],
			callback: async ({ options }) => self.send(C.brightDirect(+options.v)),
		},
		expcomp_on: {
			name: 'ExpComp: Enable compensation ON — invisible unless ExpComp value ≠ 0',
			options: [],
			callback: async () => {
				self.state.expCompMode = 'on'
				self.setVariableValues({ exposure_compensation_mode: 'on' })
				await self.send(C.expCompOn())
				self.checkFeedbacks('expcomp_mode_state')
			},
		},
		expcomp_off: {
			name: 'ExpComp: Disable compensation OFF — camera ignores ExpComp value',
			options: [],
			callback: async () => {
				self.state.expCompMode = 'off'
				self.setVariableValues({ exposure_compensation_mode: 'off' })
				await self.send(C.expCompOff())
				self.checkFeedbacks('expcomp_mode_state')
			},
		},
		expcomp_toggle: {
			name: 'ExpComp: Toggle compensation ON ↔ OFF (image only changes if value ≠ 0 — for AE Auto/Manual use "Exposure: Toggle Auto ↔ Manual (AE mode)")',
			options: [],
			callback: async () => {
				const next = self.state.expCompMode === 'on' ? 'off' : 'on'
				self.state.expCompMode = next
				self.setVariableValues({ exposure_compensation_mode: next })
				await self.send(next === 'on' ? C.expCompOn() : C.expCompOff())
				self.checkFeedbacks('expcomp_mode_state')
			},
		},
		expcomp_up: {
			name: 'ExpComp: Up',
			options: [],
			callback: async () => {
				self.state.expComp = Math.min(7, (+self.state.expComp || 0) + 1)
				updateExpCompVar(self)
				await self.send(C.expCompUp())
			},
		},
		expcomp_down: {
			name: 'ExpComp: Down',
			options: [],
			callback: async () => {
				self.state.expComp = Math.max(-7, (+self.state.expComp || 0) - 1)
				updateExpCompVar(self)
				await self.send(C.expCompDown())
			},
		},
		expcomp_reset: {
			name: 'ExpComp: Reset (to 0)',
			options: [],
			callback: async () => {
				self.state.expComp = 0
				updateExpCompVar(self)
				await self.send(C.expCompReset())
			},
		},
		expcomp_direct: {
			name: 'ExpComp: Direct Value (-7 to +7)',
			options: [{ type: 'number', id: 'v', label: 'Value', default: 0, min: -7, max: 7 }],
			callback: async ({ options }) => {
				const v = Math.max(-7, Math.min(7, +options.v))
				self.state.expComp = v
				updateExpCompVar(self)
				// Camera stores raw 0..14 with 7 = neutral; convert display value → raw
				await self.send(C.expCompDirect(v + 7))
			},
		},
		expcomp_rotary_up: {
			name: 'Rotary STEP: ExpComp Up',
			options: [],
			callback: async () => {
				self.state.expComp = Math.min(7, (+self.state.expComp || 0) + 1)
				updateExpCompVar(self)
				await self.send(C.expCompUp())
			},
		},
		expcomp_rotary_down: {
			name: 'Rotary STEP: ExpComp Down',
			options: [],
			callback: async () => {
				self.state.expComp = Math.max(-7, (+self.state.expComp || 0) - 1)
				updateExpCompVar(self)
				await self.send(C.expCompDown())
			},
		},
		blc_on: {
			name: 'Backlight: On',
			options: [],
			callback: async () => {
				self.state.blc = 'on'
				self.setVariableValues({ backlight: 'on' })
				await self.send(C.blcOn())
				self.checkFeedbacks('backlight_state')
			},
		},
		blc_off: {
			name: 'Backlight: Off',
			options: [],
			callback: async () => {
				self.state.blc = 'off'
				self.setVariableValues({ backlight: 'off' })
				await self.send(C.blcOff())
				self.checkFeedbacks('backlight_state')
			},
		},
		blc_toggle: {
			name: 'Backlight: Toggle',
			options: [],
			callback: async () => {
				const next = self.state.blc === 'on' ? 'off' : 'on'
				self.state.blc = next
				self.setVariableValues({ backlight: next })
				await self.send(next === 'on' ? C.blcOn() : C.blcOff())
				self.checkFeedbacks('backlight_state')
			},
		},

		/* ───────── White Balance ───────── */
		wb_mode: {
			name: 'White Balance: Mode',
			options: [
				{
					type: 'dropdown',
					id: 'mode',
					label: 'Mode',
					default: C.WB_MODE.AUTO,
					choices: [
						{ id: C.WB_MODE.AUTO, label: 'Auto' },
						{ id: C.WB_MODE.INDOOR, label: 'Indoor (3200K)' },
						{ id: C.WB_MODE.OUTDOOR, label: 'Outdoor (5800K)' },
						{ id: C.WB_MODE.ONE_PUSH, label: 'One-Push' },
						{ id: C.WB_MODE.ATW, label: 'ATW' },
						{ id: C.WB_MODE.MANUAL, label: 'Manual' },
						{ id: C.WB_MODE.SODIUM, label: 'Sodium' },
						{ id: C.WB_MODE.COLOR_TEMP, label: 'Color Temperature' },
					],
				},
			],
			callback: async ({ options }) => self.send(C.wbMode(+options.mode)),
		},
		wb_one_push: { name: 'WB: One-Push Trigger', options: [], callback: async () => self.send(C.wbOnePushTrigger()) },
		rgain_up: { name: 'WB: R-Gain Up', options: [], callback: async () => self.send(C.rGainUp()) },
		rgain_down: { name: 'WB: R-Gain Down', options: [], callback: async () => self.send(C.rGainDown()) },
		rgain_reset: { name: 'WB: R-Gain Reset', options: [], callback: async () => self.send(C.rGainReset()) },
		rgain_direct: {
			name: 'WB: R-Gain Direct',
			options: [{ type: 'number', id: 'v', label: 'Value (0-255)', default: 128, min: 0, max: 255 }],
			callback: async ({ options }) => self.send(C.rGainDirect(+options.v)),
		},
		bgain_up: { name: 'WB: B-Gain Up', options: [], callback: async () => self.send(C.bGainUp()) },
		bgain_down: { name: 'WB: B-Gain Down', options: [], callback: async () => self.send(C.bGainDown()) },
		bgain_reset: { name: 'WB: B-Gain Reset', options: [], callback: async () => self.send(C.bGainReset()) },
		bgain_direct: {
			name: 'WB: B-Gain Direct',
			options: [{ type: 'number', id: 'v', label: 'Value (0-255)', default: 128, min: 0, max: 255 }],
			callback: async ({ options }) => self.send(C.bGainDirect(+options.v)),
		},
		color_temp_direct: {
			name: 'WB: Color Temperature (K) — Standard variant only',
			options: [{ type: 'number', id: 'k', label: 'Kelvin (2500-8000)', default: 5600, min: 2500, max: 8000, step: 100 }],
			callback: async ({ options }) => {
				await self.send(C.colorTempDirect(+options.k))
				self.state.colorTemp = +options.k
				self.setVariableValues({ color_temp: self.state.colorTemp })
			},
		},
		color_temp_rotary_up: {
			name: 'Rotary STEP: Color Temp Up (Standard variant only)',
			options: [{ type: 'number', id: 'step', label: 'Kelvin per click', default: 100, min: 100, max: 1000, step: 100 }],
			callback: async ({ options }) => {
				if (self.state.wbMode !== C.WB_MODE.COLOR_TEMP) {
					await self.send(C.wbMode(C.WB_MODE.COLOR_TEMP))
					self.state.wbMode = C.WB_MODE.COLOR_TEMP
				}
				const cur = self.state.colorTemp || 5600
				const next = Math.min(8000, cur + +options.step)
				await self.send(C.colorTempDirect(next))
				self.state.colorTemp = next
				self.setVariableValues({ color_temp: next })
			},
		},
		color_temp_rotary_down: {
			name: 'Rotary STEP: Color Temp Down (Standard variant only)',
			options: [{ type: 'number', id: 'step', label: 'Kelvin per click', default: 100, min: 100, max: 1000, step: 100 }],
			callback: async ({ options }) => {
				if (self.state.wbMode !== C.WB_MODE.COLOR_TEMP) {
					await self.send(C.wbMode(C.WB_MODE.COLOR_TEMP))
					self.state.wbMode = C.WB_MODE.COLOR_TEMP
				}
				const cur = self.state.colorTemp || 5600
				const next = Math.max(2500, cur - +options.step)
				await self.send(C.colorTempDirect(next))
				self.state.colorTemp = next
				self.setVariableValues({ color_temp: next })
			},
		},

		/* ───────── Warmth (R-Gain/B-Gain) — works on both variants ───────── */
		warmth_rotary_up: {
			name: 'Rotary STEP: Warmth Up (warmer per click)',
			options: [{ type: 'number', id: 'step', label: 'Step size (1-16)', default: 4, min: 1, max: 16 }],
			callback: async ({ options }) => {
				if (self.state.wbMode !== C.WB_MODE.MANUAL) {
					await self.send(C.wbMode(C.WB_MODE.MANUAL))
					self.state.wbMode = C.WB_MODE.MANUAL
				}
				const w = Math.min(64, (self.state.warmth || 0) + +options.step)
				self.state.warmth = w
				await self.send(C.rGainDirect(128 + w))
				await self.send(C.bGainDirect(128 - w))
				self.setVariableValues({ warmth: w })
			},
		},
		warmth_rotary_down: {
			name: 'Rotary STEP: Warmth Down (cooler per click)',
			options: [{ type: 'number', id: 'step', label: 'Step size (1-16)', default: 4, min: 1, max: 16 }],
			callback: async ({ options }) => {
				if (self.state.wbMode !== C.WB_MODE.MANUAL) {
					await self.send(C.wbMode(C.WB_MODE.MANUAL))
					self.state.wbMode = C.WB_MODE.MANUAL
				}
				const w = Math.max(-64, (self.state.warmth || 0) - +options.step)
				self.state.warmth = w
				await self.send(C.rGainDirect(128 + w))
				await self.send(C.bGainDirect(128 - w))
				self.setVariableValues({ warmth: w })
			},
		},
		warmth_reset: {
			name: 'Warmth: Reset to neutral',
			options: [],
			callback: async () => {
				if (self.state.wbMode !== C.WB_MODE.MANUAL) {
					await self.send(C.wbMode(C.WB_MODE.MANUAL))
					self.state.wbMode = C.WB_MODE.MANUAL
				}
				self.state.warmth = 0
				await self.send(C.rGainDirect(128))
				await self.send(C.bGainDirect(128))
				self.setVariableValues({ warmth: 0 })
			},
		},

		/* ───────── Raw VISCA ───────── */
		raw_visca: {
			name: 'Custom: Send Raw VISCA hex',
			options: [
				{
					type: 'textinput',
					id: 'hex',
					label: 'Hex bytes (e.g. "81 01 04 00 02 FF")',
					default: '81 01 04 00 02 FF',
					useVariables: true,
				},
			],
			callback: async ({ options }, ctx) => {
				const raw = await ctx.parseVariablesInString(options.hex)
				const bytes = raw
					.split(/[\s,]+/)
					.filter(Boolean)
					.map((b) => parseInt(b, 16))
					.filter((b) => !Number.isNaN(b))
				if (bytes.length < 2 || bytes[bytes.length - 1] !== 0xff) {
					self.log('warn', `Raw VISCA must end with 0xFF: got ${raw}`)
					return
				}
				return self.send(bytes)
			},
		},
	}, self)
}

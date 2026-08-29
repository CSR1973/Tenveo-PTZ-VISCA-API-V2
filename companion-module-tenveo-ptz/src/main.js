import { InstanceBase, InstanceStatus, runEntrypoint } from '@companion-module/base'

import { getConfigFields } from './config.js'
import { getActions } from './actions.js'
import { getFeedbacks } from './feedbacks.js'
import { getVariables } from './variables.js'
import { getPresets } from './presets.js'
import { ViscaIP } from './visca.js'
import { OnvifClient } from './onvif.js'
import * as C from './commands.js'

const AE_NAME = {
	[C.AE_MODE.FULL_AUTO]: 'Full Auto',
	[C.AE_MODE.MANUAL]: 'Manual',
	[C.AE_MODE.SHUTTER_PRI]: 'Shutter Pri',
	[C.AE_MODE.IRIS_PRI]: 'Iris Pri',
	[C.AE_MODE.BRIGHT]: 'Bright',
}

const WB_NAME = {
	[C.WB_MODE.AUTO]: 'Auto',
	[C.WB_MODE.INDOOR]: 'Indoor',
	[C.WB_MODE.OUTDOOR]: 'Outdoor',
	[C.WB_MODE.ONE_PUSH]: 'One-Push',
	[C.WB_MODE.ATW]: 'ATW',
	[C.WB_MODE.MANUAL]: 'Manual',
	[C.WB_MODE.SODIUM]: 'Sodium',
	[C.WB_MODE.COLOR_TEMP]: 'Color Temp',
}

class TenveoInstance extends InstanceBase {
	/** Returns { fieldId: defaultValue } for every input in getConfigFields().
	 *  Used to backfill any config keys that were added by newer module versions
	 *  but are missing from the user's persisted connection config (which would
	 *  otherwise fail Companion's "A value must be provided" validation and
	 *  freeze the Save button in the connection-edit panel). */
	_configDefaults() {
		const out = {}
		for (const f of getConfigFields()) {
			if (f && f.id && f.type !== 'static-text' && f.default !== undefined) {
				out[f.id] = f.default
			}
		}
		return out
	}

	/** Merge missing defaults into config and persist back so the Save button
	 *  can enable on the very first config-panel open after a module upgrade. */
	_backfillConfig(config) {
		const defaults = this._configDefaults()
		let dirty = false
		const merged = { ...config }
		for (const [k, v] of Object.entries(defaults)) {
			if (merged[k] === undefined || merged[k] === null || merged[k] === '') {
				merged[k] = v
				dirty = true
			}
		}
		if (dirty) {
			try {
				this.saveConfig(merged)
				this.log('info', 'Backfilled missing config defaults for keys: ' +
					Object.keys(defaults).filter((k) => config[k] === undefined || config[k] === null || config[k] === '').join(', '))
			} catch (e) {
				this.log('warn', `saveConfig(backfill) failed: ${e?.message || e}`)
			}
		}
		return merged
	}

	async init(config) {
		this.config = this._backfillConfig(config)
		this.state = {
			connected: false,
			onvifReady: false,
			power: 'unknown',
			af: 'unknown',
			aeMode: null,
			wbMode: null,
			lastPreset: null,
			gain: null,
			iris: null,
			irisFstop: 'unknown',
			shutter: null,
			expComp: 0,
			expCompMode: 'unknown',
			zoomPos: 0,
			focusPos: 0,
			blc: 'unknown',
			panPos: null,
			tiltPos: null,
			panDeg: 0,
			tiltDeg: 0,
			colorTemp: 5600,
			presetSaveIdx: 1,
			presetRecallIdx: 1,
			menuOpen: false,
			flipOn: false,
			mirrorOn: false,
		}
		this._pulseTimers = {}

		this.setActionDefinitions(getActions(this))
		this.setFeedbackDefinitions(getFeedbacks(this))
		this.setVariableDefinitions(getVariables())
		this.setPresetDefinitions(getPresets())

		this._publishStaticVars()
		await this._connect()
		await this._initOnvif()
	}

	async destroy() {
		this._stopPolling()
		for (const t of Object.values(this._pulseTimers)) clearTimeout(t)
		this._pulseTimers = {}
		if (this.visca) {
			this.visca.close()
			this.visca = null
		}
		this.onvif = null
	}

	async configUpdated(config) {
		this.config = this._backfillConfig(config)
		this._publishStaticVars()
		this._stopPolling()
		if (this.visca) this.visca.close()
		await this._connect()
		await this._initOnvif()
	}

	getConfigFields() {
		return getConfigFields()
	}

	/* ─── Internal helpers ─── */

	_publishStaticVars() {
		this.setVariableValues({
			camera_name: this.config.name || 'Tenveo',
			host: this.config.host || '',
			pan_degrees: '0.0',
			tilt_degrees: '0.0',
			zoom_position: this.state?.zoomPos ?? 0,
			zoom_percent: Math.round(((this.state?.zoomPos ?? 0) / 16384) * 100),
			focus_position: this.state?.focusPos ?? 0,
			focus_percent: Math.round(((this.state?.focusPos ?? 0) / 16384) * 100),
			focus_mode: this.state?.af === 'on' ? 'Auto' : this.state?.af === 'off' ? 'Manual' : 'unknown',
			backlight: this.state?.blc ?? 'unknown',
			iris_fstop: this.state?.irisFstop ?? 'unknown',
			exposure_compensation: this.state?.expComp ?? 0,
			exposure_compensation_mode: this.state?.expCompMode ?? 'unknown',
			color_temp: this.state?.colorTemp ?? 5600,
			warmth: 0,
			preset_save_index: this.state?.presetSaveIdx ?? 1,
			preset_recall_index: this.state?.presetRecallIdx ?? 1,
			image_flip: this.state?.flipOn ? 'on' : 'off',
			image_mirror: this.state?.mirrorOn ? 'on' : 'off',
		})
	}

	async _connect() {
		if (!this.config.host) {
			this.updateStatus(InstanceStatus.BadConfig, 'No IP address')
			return
		}
		this.updateStatus(InstanceStatus.Connecting)

		const transport = this.config.transport || 'tcp'
		this.visca = new ViscaIP({
			host: this.config.host,
			port: this.config.port || 52381,
			transport,
			cameraId: this.config.cameraId || 1,
			logger: {
				debug: (...a) => this.log('debug', a.join(' ')),
				info: (...a) => this.log('info', a.join(' ')),
				warn: (...a) => this.log('warn', a.join(' ')),
				error: (...a) => this.log('error', a.join(' ')),
			},
			verbose: !!this.config.verbose,
		})
		this.visca.on('connected', () => {
			this.state.connected = true
			this.setVariableValues({ connected: 'true' })
			this.updateStatus(InstanceStatus.Ok)
			this.checkFeedbacks('connected')
			this._startPolling()
		})
		this.visca.on('disconnected', (err) => {
			this.state.connected = false
			this.setVariableValues({ connected: 'false' })
			this.updateStatus(InstanceStatus.ConnectionFailure, err?.message)
			this.checkFeedbacks('connected')
		})
		this.visca.open()
	}

	async _initOnvif() {
		if (!this.config.host) return
		this.onvif = new OnvifClient({
			host: this.config.host,
			port: this.config.onvifPort || 2000,
			username: this.config.onvifUser || 'admin',
			password: this.config.onvifPass || 'admin',
			logger: {
				debug: (...a) => this.log('debug', a.join(' ')),
				info: (...a) => this.log('info', a.join(' ')),
				warn: (...a) => this.log('warn', a.join(' ')),
				error: (...a) => this.log('error', a.join(' ')),
			},
			verbose: !!this.config.verbose,
		})
		try {
			const token = await this.onvif.getProfileToken()
			this.state.onvifReady = true
			this.setVariableValues({ onvif_ready: 'true' })
			this.log('info', `ONVIF ready (profile token: ${token})`)
		} catch (e) {
			this.state.onvifReady = false
			this.setVariableValues({ onvif_ready: 'false' })
			this.log('warn', `ONVIF init failed: ${e.message} — presets will not work until this succeeds`)
		}
	}

	send(bytes) {
		if (!this.visca) return Promise.resolve()
		return this.visca.command(bytes).catch((e) => this.log('error', `VISCA send failed: ${e.message}`))
	}

	/* ─── Polling (chained, never overlaps) ─── */

	_startPolling() {
		this._stopPolling()
		const interval = parseInt(this.config.pollInterval, 10) || 0
		if (interval < 250) return
		this._pollStopped = false
		const loop = async () => {
			if (this._pollStopped) return
			await this._pollOnce()
			if (this._pollStopped) return
			this._poll = setTimeout(loop, interval)
		}
		loop()
	}

	_stopPolling() {
		this._pollStopped = true
		if (this._poll) {
			clearTimeout(this._poll)
			this._poll = null
		}
	}

	async _pollOnce() {
		if (!this.visca) return
		try {
			const queries = [
				{ q: C.inqPower(), set: (r) => this._setPower(r) },
				{ q: C.inqAF(), set: (r) => this._setAF(r) },
				{ q: C.inqAeMode(), set: (r) => this._setAeMode(r) },
				{ q: C.inqWbMode(), set: (r) => this._setWbMode(r) },
				{ q: C.inqZoomPos(), set: (r) => this._setZoomPos(r) },
				{ q: C.inqFocusPos(), set: (r) => this._setFocusPos(r) },
				{ q: C.inqGain(), set: (r) => this._setGain(r) },
				{ q: C.inqIris(), set: (r) => this._setIris(r) },
				{ q: C.inqShutter(), set: (r) => this._setShutter(r) },
				{ q: C.inqPtPos(), set: (r) => this._setPtPos(r) },
				{ q: C.inqBLC(), set: (r) => this._setBLC(r) },
				{ q: C.inqExpComp(), set: (r) => this._setExpComp(r) },
				{ q: C.inqExpCompMode(), set: (r) => this._setExpCompMode(r) },
			]
			for (const { q, set } of queries) {
				const r = await this.visca.inquiry(q)
				if (r && r.payload) set(r.payload)
			}
		} catch (e) {
			this.log('debug', `Poll error: ${e.message}`)
		}
	}

	_setPower(buf) {
		const data = C.parseInqReply(buf)
		if (!data) return
		const v = data[0] === 0x02 ? 'on' : data[0] === 0x03 ? 'off' : 'unknown'
		this.state.power = v
		this.setVariableValues({ power: v })
		this.checkFeedbacks('power_state')
	}
	_setAF(buf) {
		const data = C.parseInqReply(buf)
		if (!data) return
		const v = data[0] === 0x02 ? 'on' : 'off'
		this.state.af = v
		this.setVariableValues({ af: v, focus_mode: v === 'on' ? 'Auto' : 'Manual' })
		this.checkFeedbacks('af_state')
	}
	_setAeMode(buf) {
		const data = C.parseInqReply(buf)
		if (!data) return
		this.state.aeMode = data[0]
		this.setVariableValues({ exposure_mode: AE_NAME[data[0]] || `0x${data[0].toString(16)}` })
		this.checkFeedbacks('exposure_mode')
	}
	_setWbMode(buf) {
		const data = C.parseInqReply(buf)
		if (!data) return
		this.state.wbMode = data[0]
		this.setVariableValues({ wb_mode: WB_NAME[data[0]] || `0x${data[0].toString(16)}` })
		this.checkFeedbacks('wb_mode')
	}
	_setZoomPos(buf) {
		const data = C.parseInqReply(buf)
		if (!data || data.length < 4) return
		const v = C.denibble16(data)
		// Don't clobber the tracker while a drive is in progress or its auto-stop is pending —
		// the module-side estimate is authoritative during those windows.
		if (this._zoomDriveDir || this._zoomStopTimer) return
		this.state.zoomPos = v
		this.setVariableValues({
			zoom_position: v,
			zoom_percent: Math.round((Math.max(0, Math.min(16384, v)) / 16384) * 100),
		})
	}
	_setFocusPos(buf) {
		const data = C.parseInqReply(buf)
		if (!data || data.length < 4) return
		const v = C.denibble16(data)
		if (this._focusDriveDir || this._focusStopTimer) return
		this.state.focusPos = v
		this.setVariableValues({
			focus_position: v,
			focus_percent: Math.round((Math.max(0, Math.min(16384, v)) / 16384) * 100),
		})
	}
	_setPtPos(buf) {
		const data = C.parseInqReply(buf)
		if (!data || data.length < 8) return
		const rawPan = C.denibble16(data.slice(0, 4))
		const rawTilt = C.denibble16(data.slice(4, 8))
		// Convert unsigned nibbles → signed 16-bit
		const panS = rawPan >= 0x8000 ? rawPan - 0x10000 : rawPan
		const tiltS = rawTilt >= 0x8000 ? rawTilt - 0x10000 : rawTilt
		// Convert raw units back to degrees using the connection's calibration
		const panC = Number.isFinite(+this.config.panCenter) ? +this.config.panCenter : 19050
		const tiltC = Number.isFinite(+this.config.tiltCenter) ? +this.config.tiltCenter : 8000
		const panUPD = Number.isFinite(+this.config.panUnitsPerDeg) ? +this.config.panUnitsPerDeg : 108.74
		const tiltUPD = Number.isFinite(+this.config.tiltUnitsPerDeg) ? +this.config.tiltUnitsPerDeg : 86.66
		if (panUPD !== 0) this.state.panDeg = (panS - panC) / panUPD
		if (tiltUPD !== 0) this.state.tiltDeg = (tiltS - tiltC) / tiltUPD
		this.state.panU = panS
		this.state.tiltU = tiltS
		this.setVariableValues({
			pan_degrees: (this.state.panDeg ?? 0).toFixed(1),
			tilt_degrees: (this.state.tiltDeg ?? 0).toFixed(1),
		})
	}
	_setBLC(buf) {
		const data = C.parseInqReply(buf)
		if (!data) return
		const v = data[0] === 0x02 ? 'on' : data[0] === 0x03 ? 'off' : 'unknown'
		this.state.blc = v
		this.setVariableValues({ backlight: v })
		this.checkFeedbacks('backlight_state')
	}
	_setGain(buf) {
		const data = C.parseInqReply(buf)
		if (!data || data.length < 4) return
		const v = C.denibble16(data)
		this.state.gain = v
		this.setVariableValues({ gain: v })
	}
	_setIris(buf) {
		const data = C.parseInqReply(buf)
		if (!data || data.length < 4) return
		const v = C.denibble16(data)
		this.state.iris = v
		// Guard the lookup — some cameras return values > 13 for edge/error states
		const idx = Math.max(0, Math.min(C.IRIS_FSTOP.length - 1, v))
		const fstop = C.IRIS_FSTOP[idx]
		this.state.irisFstop = fstop
		this.setVariableValues({ iris: v, iris_fstop: fstop })
	}
	_setExpComp(buf) {
		const data = C.parseInqReply(buf)
		if (!data || data.length < 4) return
		// Raw value 0..14, where 7 = neutral 0
		const raw = C.denibble16(data)
		const v = Math.max(-7, Math.min(7, raw - 7))
		this.state.expComp = v
		this.setVariableValues({ exposure_compensation: v })
	}
	_setExpCompMode(buf) {
		const data = C.parseInqReply(buf)
		if (!data) return
		const v = data[0] === 0x02 ? 'on' : data[0] === 0x03 ? 'off' : 'unknown'
		this.state.expCompMode = v
		this.setVariableValues({ exposure_compensation_mode: v })
		this.checkFeedbacks('expcomp_mode_state')
	}
	_setShutter(buf) {
		const data = C.parseInqReply(buf)
		if (!data || data.length < 4) return
		const v = C.denibble16(data)
		this.state.shutter = v
		this.setVariableValues({ shutter: v })
	}
}

runEntrypoint(TenveoInstance, [
	// v1.14.0 — migrate any legacy ExpComp action IDs to their current names.
	// Companion persists the actionId inside each button; if the module was
	// upgraded from an earlier build where an ID had a different name, the
	// button would keep firing the OLD id (which no longer exists) and show
	// a yellow triangle. This script rewrites the id in place.
	function migrateExpCompActionIds(_context, props) {
		const rename = {
			expcomp_step_up: 'expcomp_up',
			expcomp_step_down: 'expcomp_down',
			expcomp_step_reset: 'expcomp_reset',
			expcomp_mode_toggle: 'expcomp_toggle',
			expcomp_ae_toggle: 'expcomp_toggle',
			expcomp_manual: 'expcomp_on',
			expcomp_auto: 'expcomp_off',
			gain_up_ndi: 'gain_up',
			gain_down_ndi: 'gain_down',
			gain_reset_ndi: 'gain_reset',
		}
		const updatedActions = []
		const actionsList = Array.isArray(props.actions) ? props.actions : []
		for (const action of actionsList) {
			if (action && rename[action.actionId]) {
				action.actionId = rename[action.actionId]
				updatedActions.push(action)
			}
		}
		return { updatedConfig: null, updatedActions, updatedFeedbacks: [] }
	},
])

/**
 * v1.8.0 tests — verifies:
 *   1. tilt_home_only queries pan/tilt from camera FIRST, then sends ptAbsolute with the
 *      fresh pan value (not the stale tracker) — fixes "tilt home also homes pan" bug.
 *   2. pan_home_only similarly refreshes before firing.
 *   3. Backlight actions have display names 'Backlight: On/Off/Toggle' (not 'BLC').
 *   4. blc_toggle flips state.blc between on/off and emits the correct VISCA command.
 *   5. focus_direct emits focus_position + focus_percent variables.
 *   6. _setPtPos (main.js reply handler) computes panDeg/tiltDeg from the raw camera reply.
 *   7. inqBLC command bytes are exactly 81 09 04 33 FF.
 *   8. _setBLC parses 02→'on' and 03→'off'.
 *   9. Zoom step idleMs default is 800 ms (raised in v1.15.0 for slow-spin smoothness).
 *  10. Backlight feedback is registered with id 'backlight_state'.
 */
import { getActions } from '../src/actions.js'
import { getFeedbacks } from '../src/feedbacks.js'
import * as C from '../src/commands.js'

const results = []
function assert(name, cond, extra = '') {
	results.push({ name, ok: !!cond, extra })
	if (cond) console.log(`  \u2713 ${name}${extra ? ' — ' + extra : ''}`)
	else console.error(`  \u2717 ${name}${extra ? ' — ' + extra : ''}`)
}

function makeFakeSelf(overrides = {}) {
	const sent = []
	const varUpdates = []
	const feedbackChecks = []
	const self = {
		config: {
			panSpeed: 12,
			tiltSpeed: 10,
			zoomSpeed: 4,
			variant: 'ndi',
			panCenter: 19050,
			panUnitsPerDeg: 108.74,
			panMinDeg: -175,
			panMaxDeg: 175,
			tiltCenter: 8000,
			tiltUnitsPerDeg: 86.66,
			tiltMinDeg: -90,
			tiltMaxDeg: 90,
			panDegPerSec: 100,
			tiltDegPerSec: 60,
			zoomUnitsPerSec: 3200,
			...overrides,
		},
		state: { panDeg: 0, tiltDeg: 0, zoomPos: 0, focusPos: 0, blc: 'off' },
		_pulseTimers: {},
		visca: overrides.visca || null,
		send: async (bytes) => sent.push(Array.from(bytes)),
		setVariableValues: (v) => varUpdates.push(v),
		checkFeedbacks: (id) => feedbackChecks.push(id),
		log: () => {},
		sent,
		varUpdates,
		feedbackChecks,
	}
	return self
}

function decodePtAbsolute(bytes) {
	if (bytes.length !== 15 || bytes[0] !== 0x81 || bytes[2] !== 0x06 || bytes[3] !== 0x02) return null
	const p = ((bytes[6] & 0xf) << 12) | ((bytes[7] & 0xf) << 8) | ((bytes[8] & 0xf) << 4) | (bytes[9] & 0xf)
	const t = ((bytes[10] & 0xf) << 12) | ((bytes[11] & 0xf) << 8) | ((bytes[12] & 0xf) << 4) | (bytes[13] & 0xf)
	return {
		panU: p >= 0x8000 ? p - 0x10000 : p,
		tiltU: t >= 0x8000 ? t - 0x10000 : t,
	}
}

/** Build a fake inqPtPos reply payload: 90 50 0p 0p 0p 0p 0t 0t 0t 0t FF for given (pan, tilt) 16-bit signed. */
function fakePtPosReply(panU, tiltU) {
	const p = (panU & 0xffff) >>> 0
	const t = (tiltU & 0xffff) >>> 0
	return Buffer.from([
		0x90,
		0x50,
		(p >> 12) & 0x0f,
		(p >> 8) & 0x0f,
		(p >> 4) & 0x0f,
		p & 0x0f,
		(t >> 12) & 0x0f,
		(t >> 8) & 0x0f,
		(t >> 4) & 0x0f,
		t & 0x0f,
		0xff,
	])
}

async function test1_tiltHomeOnlyRefreshesPanFromCamera() {
	console.log('\n[TEST 1] tilt_home_only queries camera first → uses fresh pan, not stale tracker')
	// Simulate: camera physically at panDeg = +60 (panU = 19050 + 60×108.74 = 25574),
	// but our tracker is stale at panDeg = 0.
	const camPanU = Math.round(19050 + 60 * 108.74) // 25574
	const camTiltU = Math.round(8000 + 25 * 86.66) // 10167
	const fakeInqPtPos = fakePtPosReply(camPanU, camTiltU)
	const self = makeFakeSelf({
		visca: {
			inquiry: async () => ({ payload: fakeInqPtPos }),
		},
	})
	self.state.panDeg = 0
	self.state.tiltDeg = 0
	const acts = getActions(self)
	self.sent.length = 0

	await acts.tilt_home_only.callback({ options: { tiltSpeed: 10 } })

	assert('1 packet sent', self.sent.length === 1)
	const dec = decodePtAbsolute(self.sent[0])
	assert(`panU is camera's real position (~${camPanU})`, dec && Math.abs(dec.panU - camPanU) <= 1, `got ${dec?.panU}`)
	assert('tiltU = tiltCenter (8000)', dec && dec.tiltU === 8000, `got ${dec?.tiltU}`)
	assert('state.tiltDeg reset to 0', self.state.tiltDeg === 0)
	assert('state.panDeg reflects camera (~60°)', Math.abs(self.state.panDeg - 60) < 0.1, `got ${self.state.panDeg}`)
}

async function test2_panHomeOnlyRefreshesTiltFromCamera() {
	console.log('\n[TEST 2] pan_home_only queries camera first → uses fresh tilt, not stale tracker')
	const camPanU = Math.round(19050 + -30 * 108.74) // 15788
	const camTiltU = Math.round(8000 + -15 * 86.66) // 6700
	const self = makeFakeSelf({
		visca: {
			inquiry: async () => ({ payload: fakePtPosReply(camPanU, camTiltU) }),
		},
	})
	self.state.panDeg = 0
	self.state.tiltDeg = 0
	const acts = getActions(self)
	self.sent.length = 0

	await acts.pan_home_only.callback({ options: { panSpeed: 12 } })

	assert('1 packet sent', self.sent.length === 1)
	const dec = decodePtAbsolute(self.sent[0])
	assert('panU = panCenter (19050)', dec && dec.panU === 19050, `got ${dec?.panU}`)
	assert(`tiltU is camera's real tilt (~${camTiltU})`, dec && Math.abs(dec.tiltU - camTiltU) <= 1, `got ${dec?.tiltU}`)
	assert('state.tiltDeg reflects camera (~-15°)', Math.abs(self.state.tiltDeg - -15) < 0.1, `got ${self.state.tiltDeg}`)
}

async function test3_tiltHomeOnlyFallsBackWhenNoVisca() {
	console.log('\n[TEST 3] tilt_home_only gracefully falls back when visca not available')
	const self = makeFakeSelf({ visca: null })
	self.state.panDeg = 42 // stale tracker
	self.state.tiltDeg = -20
	const acts = getActions(self)
	self.sent.length = 0

	await acts.tilt_home_only.callback({ options: { tiltSpeed: 10 } })

	assert('still sends 1 packet', self.sent.length === 1)
	const dec = decodePtAbsolute(self.sent[0])
	const expectedPanU = Math.round(19050 + 42 * 108.74)
	assert(`uses tracker pan (~${expectedPanU})`, dec && Math.abs(dec.panU - expectedPanU) <= 1, `got ${dec?.panU}`)
	assert('tiltU = tiltCenter', dec && dec.tiltU === 8000)
}

async function test4_backlightRenamed() {
	console.log('\n[TEST 4] BLC actions renamed to Backlight in display names')
	const self = makeFakeSelf()
	const acts = getActions(self)
	assert('blc_on.name = "Backlight: On"', acts.blc_on && acts.blc_on.name === 'Backlight: On', `got ${acts.blc_on?.name}`)
	assert('blc_off.name = "Backlight: Off"', acts.blc_off && acts.blc_off.name === 'Backlight: Off', `got ${acts.blc_off?.name}`)
	assert('blc_toggle exists', !!acts.blc_toggle)
	assert('blc_toggle.name = "Backlight: Toggle"', acts.blc_toggle && acts.blc_toggle.name === 'Backlight: Toggle', `got ${acts.blc_toggle?.name}`)
}

async function test5_backlightToggle() {
	console.log('\n[TEST 5] blc_toggle flips state.blc and sends the right VISCA command')
	const self = makeFakeSelf()
	self.state.blc = 'off'
	const acts = getActions(self)
	self.sent.length = 0
	self.varUpdates.length = 0
	self.feedbackChecks.length = 0

	await acts.blc_toggle.callback()
	assert('state.blc flipped to on', self.state.blc === 'on', `got ${self.state.blc}`)
	assert('blcOn command sent', self.sent[0] && self.sent[0][3] === 0x33 && self.sent[0][4] === 0x02)
	assert('backlight variable = on', self.varUpdates.some((v) => v.backlight === 'on'))
	assert('backlight_state feedback checked', self.feedbackChecks.includes('backlight_state'))

	await acts.blc_toggle.callback()
	assert('state.blc flipped back to off', self.state.blc === 'off', `got ${self.state.blc}`)
	assert('blcOff command sent', self.sent[1] && self.sent[1][3] === 0x33 && self.sent[1][4] === 0x03)
}

async function test6_backlightOnOffAlsoUpdateStateAndFeedback() {
	console.log('\n[TEST 6] blc_on/blc_off actions also update state.blc, variable, and feedback')
	const self = makeFakeSelf()
	self.state.blc = 'off'
	const acts = getActions(self)
	self.sent.length = 0
	self.varUpdates.length = 0
	self.feedbackChecks.length = 0

	await acts.blc_on.callback()
	assert('blc_on → state = on', self.state.blc === 'on')
	assert('blc_on → variable = on', self.varUpdates.some((v) => v.backlight === 'on'))
	assert('blc_on → feedback checked', self.feedbackChecks.includes('backlight_state'))

	await acts.blc_off.callback()
	assert('blc_off → state = off', self.state.blc === 'off')
	assert('blc_off → variable = off', self.varUpdates.some((v) => v.backlight === 'off'))
}

async function test7_focusDirectUpdatesFocusPercent() {
	console.log('\n[TEST 7] focus_direct updates focus_position and focus_percent variables')
	const self = makeFakeSelf()
	const acts = getActions(self)
	self.varUpdates.length = 0
	await acts.focus_direct.callback({ options: { pos: 8192 } })
	const last = self.varUpdates[self.varUpdates.length - 1]
	assert('focus_position = 8192', last && last.focus_position === 8192, JSON.stringify(last))
	assert('focus_percent = 50', last && last.focus_percent === 50, JSON.stringify(last))
	assert('state.focusPos = 8192', self.state.focusPos === 8192)
}

async function test8_inqBLCBytes() {
	console.log('\n[TEST 8] inqBLC command is 81 09 04 33 FF')
	const bytes = C.inqBLC()
	assert('length 5', bytes.length === 5)
	assert('bytes match spec', bytes[0] === 0x81 && bytes[1] === 0x09 && bytes[2] === 0x04 && bytes[3] === 0x33 && bytes[4] === 0xff, JSON.stringify(bytes))
}

async function test9_zoomIdleMsDefault250() {
	console.log('\n[TEST 9] zoom_step_in/out default idleMs = 800 ms')
	const self = makeFakeSelf()
	const acts = getActions(self)
	const inIdle = acts.zoom_step_in.options.find((o) => o.id === 'idleMs')
	const outIdle = acts.zoom_step_out.options.find((o) => o.id === 'idleMs')
	assert('zoom_step_in idleMs default = 800', inIdle && inIdle.default === 800, `got ${inIdle?.default}`)
	assert('zoom_step_out idleMs default = 800', outIdle && outIdle.default === 800, `got ${outIdle?.default}`)
}

async function test10_backlightFeedbackRegistered() {
	console.log('\n[TEST 10] backlight_state feedback registered')
	const self = makeFakeSelf()
	const fbs = getFeedbacks(self)
	assert('backlight_state feedback exists', !!fbs.backlight_state)
	assert('feedback name = "Backlight State"', fbs.backlight_state && fbs.backlight_state.name === 'Backlight State')
	// Verify callback behaviour
	self.state.blc = 'on'
	assert('callback returns true for "on" when state.blc=on', fbs.backlight_state.callback({ options: { state: 'on' } }) === true)
	assert('callback returns false for "off" when state.blc=on', fbs.backlight_state.callback({ options: { state: 'off' } }) === false)
}

async function test11_focusPercentVariableRegistered() {
	console.log('\n[TEST 11] focus_percent variable is registered')
	const { getVariables } = await import('../src/variables.js')
	const vars = getVariables()
	const fp = vars.focus_percent
	assert('focus_percent variable registered', !!fp, JSON.stringify(Object.keys(vars)))
	const bl = vars.backlight
	assert('backlight variable registered', !!bl)
}

async function run() {
	await test1_tiltHomeOnlyRefreshesPanFromCamera()
	await test2_panHomeOnlyRefreshesTiltFromCamera()
	await test3_tiltHomeOnlyFallsBackWhenNoVisca()
	await test4_backlightRenamed()
	await test5_backlightToggle()
	await test6_backlightOnOffAlsoUpdateStateAndFeedback()
	await test7_focusDirectUpdatesFocusPercent()
	await test8_inqBLCBytes()
	await test9_zoomIdleMsDefault250()
	await test10_backlightFeedbackRegistered()
	await test11_focusPercentVariableRegistered()

	const failed = results.filter((r) => !r.ok)
	console.log(`\n───── ${results.length - failed.length}/${results.length} assertions passed ─────`)
	if (failed.length) {
		console.log('Failed:')
		for (const f of failed) console.log(`  ✗ ${f.name} — ${f.extra}`)
		process.exit(1)
	}
	process.exit(0)
}

run().catch((e) => {
	console.error('FATAL:', e)
	process.exit(2)
})

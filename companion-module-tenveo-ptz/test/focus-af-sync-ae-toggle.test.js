/**
 * v1.13.0 tests — Focus AF sync + AE Mode Auto/Manual toggle.
 *
 * Verifies:
 *   1. focus_auto sends focusAuto (81 01 04 38 02 FF), sets state.af='on', publishes af + focus_mode='Auto'.
 *   2. focus_auto schedules an inqFocusPos refresh via setTimeout — if visca.inquiry returns a value,
 *      state.focusPos gets updated to that value AND focus_position/focus_percent variables are published.
 *   3. focus_manual sends focusManual and sets state.af='off' + focus_mode='Manual'.
 *   4. focus_one_push sets focus_mode='One-Push' immediately, then refreshes focus after ~2s.
 *   5. focus_toggle flips state.af and focus_mode label.
 *   6. ae_mode_toggle exists as a new action.
 *   7. ae_mode_toggle flips between AE_MODE.FULL_AUTO (0x00) and AE_MODE.MANUAL (0x03) via aeMode command.
 *   8. exposure_mode action now publishes the label variable + triggers exposure_mode feedback.
 *   9. focus_mode variable is registered in variables.js.
 *  10. refreshFocusFromCamera helper silently handles missing visca (no throw).
 */
import { getActions } from '../src/actions.js'
import { getVariables } from '../src/variables.js'
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
	return {
		config: { panSpeed: 12, tiltSpeed: 10, zoomSpeed: 4, variant: 'ndi', ...overrides },
		state: { panDeg: 0, tiltDeg: 0, zoomPos: 0, focusPos: 0, iris: 7, irisFstop: 'f3.4', expComp: 0, expCompMode: 'off', blc: 'off', af: 'off', aeMode: C.AE_MODE.FULL_AUTO },
		_pulseTimers: {},
		visca: overrides.visca || null,
		send: async (bytes) => sent.push(Array.from(bytes)),
		setVariableValues: (v) => varUpdates.push(v),
		checkFeedbacks: (id) => feedbackChecks.push(id),
		log: () => {},
		sent, varUpdates, feedbackChecks,
	}
}

function fakeFocusPosReply(v) {
	const p = (v & 0xffff) >>> 0
	return Buffer.from([0x90, 0x50, (p >> 12) & 0x0f, (p >> 8) & 0x0f, (p >> 4) & 0x0f, p & 0x0f, 0xff])
}

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

async function test1_focusAutoSyncs() {
	console.log('\n[TEST 1] focus_auto → sets state.af=on, focus_mode=Auto, refreshes focus from camera')
	const self = makeFakeSelf({
		visca: { inquiry: async () => ({ payload: fakeFocusPosReply(9500) }) },
	})
	self.state.af = 'off'
	self.state.focusPos = 0
	const acts = getActions(self)
	self.sent.length = 0
	self.varUpdates.length = 0

	await acts.focus_auto.callback()
	assert('focusAuto sent (81 01 04 38 02 FF)', self.sent[0] && self.sent[0][3] === 0x38 && self.sent[0][4] === 0x02)
	assert('state.af = on', self.state.af === 'on')
	assert('af variable published as on', self.varUpdates.some((v) => v.af === 'on'))
	assert('focus_mode published as "Auto"', self.varUpdates.some((v) => v.focus_mode === 'Auto'))
	assert('af_state feedback triggered', self.feedbackChecks.includes('af_state'))

	// Wait for the 1200ms scheduled refresh
	await sleep(1350)
	assert('state.focusPos updated from camera (9500)', self.state.focusPos === 9500, `got ${self.state.focusPos}`)
	assert('focus_position variable published from camera value', self.varUpdates.some((v) => v.focus_position === 9500))
	assert('focus_percent published (58 for 9500/16384)', self.varUpdates.some((v) => v.focus_percent === 58))
}

async function test2_focusManualSyncs() {
	console.log('\n[TEST 2] focus_manual → state.af=off, focus_mode=Manual, refreshes focus')
	const self = makeFakeSelf({
		visca: { inquiry: async () => ({ payload: fakeFocusPosReply(2000) }) },
	})
	self.state.af = 'on'
	const acts = getActions(self)
	await acts.focus_manual.callback()
	assert('focusManual sent (81 01 04 38 03 FF)', self.sent[0] && self.sent[0][3] === 0x38 && self.sent[0][4] === 0x03)
	assert('state.af = off', self.state.af === 'off')
	assert('focus_mode = Manual published', self.varUpdates.some((v) => v.focus_mode === 'Manual'))
	await sleep(500)
	assert('state.focusPos updated from camera (2000)', self.state.focusPos === 2000, `got ${self.state.focusPos}`)
}

async function test3_focusOnePush() {
	console.log('\n[TEST 3] focus_one_push → focus_mode=One-Push, then Auto/Manual + refresh')
	const self = makeFakeSelf({
		visca: { inquiry: async () => ({ payload: fakeFocusPosReply(4000) }) },
	})
	self.state.af = 'off'
	const acts = getActions(self)
	self.varUpdates.length = 0
	await acts.focus_one_push.callback()
	assert('focus_mode = One-Push initial', self.varUpdates.some((v) => v.focus_mode === 'One-Push'))
	// Wait for the delayed refresh
	await sleep(2100)
	assert('focus_mode reverts to Manual (af=off)', self.varUpdates[self.varUpdates.length - 1].focus_mode === 'Manual')
	assert('focus_position updated to 4000', self.state.focusPos === 4000, `got ${self.state.focusPos}`)
}

async function test4_focusToggle() {
	console.log('\n[TEST 4] focus_toggle flips state.af + focus_mode')
	const self = makeFakeSelf({ visca: { inquiry: async () => ({ payload: fakeFocusPosReply(1000) }) } })
	self.state.af = 'off'
	const acts = getActions(self)
	await acts.focus_toggle.callback()
	assert('state.af = on', self.state.af === 'on')
	assert('focus_mode = Auto', self.varUpdates.some((v) => v.focus_mode === 'Auto'))
	await acts.focus_toggle.callback()
	assert('state.af = off after 2nd toggle', self.state.af === 'off')
	assert('focus_mode = Manual after 2nd toggle', self.varUpdates.filter((v) => v.focus_mode === 'Manual').length >= 1)
}

async function test5_aeModeToggleExists() {
	console.log('\n[TEST 5] ae_mode_toggle exists as an action')
	const self = makeFakeSelf()
	const acts = getActions(self)
	assert('ae_mode_toggle registered', !!acts.ae_mode_toggle)
	assert('name mentions Auto ↔ Manual', /auto.*manual|manual.*auto/i.test(acts.ae_mode_toggle?.name || ''), acts.ae_mode_toggle?.name)
}

async function test6_aeModeToggleFlips() {
	console.log('\n[TEST 6] ae_mode_toggle flips Full Auto ↔ Manual + publishes label + triggers feedback')
	const self = makeFakeSelf()
	self.state.aeMode = C.AE_MODE.FULL_AUTO
	const acts = getActions(self)
	self.sent.length = 0
	self.varUpdates.length = 0
	self.feedbackChecks.length = 0

	await acts.ae_mode_toggle.callback()
	assert('state.aeMode = MANUAL (0x03)', self.state.aeMode === C.AE_MODE.MANUAL, `got 0x${self.state.aeMode.toString(16)}`)
	// aeMode command: 81 01 04 39 03 FF
	assert('aeMode(MANUAL) sent', self.sent[0] && self.sent[0][3] === 0x39 && self.sent[0][4] === 0x03)
	assert('exposure_mode = Manual', self.varUpdates.some((v) => v.exposure_mode === 'Manual'))
	assert('exposure_mode feedback triggered', self.feedbackChecks.includes('exposure_mode'))

	await acts.ae_mode_toggle.callback()
	assert('state.aeMode = FULL_AUTO', self.state.aeMode === C.AE_MODE.FULL_AUTO)
	assert('aeMode(FULL_AUTO=0) sent', self.sent[1] && self.sent[1][3] === 0x39 && self.sent[1][4] === 0x00)
	assert('exposure_mode = Full Auto', self.varUpdates.some((v) => v.exposure_mode === 'Full Auto'))
}

async function test7_focusModeVariableRegistered() {
	console.log('\n[TEST 7] focus_mode variable registered')
	const vars = getVariables()
	assert('focus_mode registered', !!vars.focus_mode, JSON.stringify(Object.keys(vars)))
}

async function test8_focusAutoWithoutViscaDoesntCrash() {
	console.log('\n[TEST 8] focus_auto with no visca inquiry service does NOT crash the module')
	const self = makeFakeSelf({ visca: null })
	const acts = getActions(self)
	await acts.focus_auto.callback()
	await sleep(1300)
	assert('no crash', true)
	// state.af should still be set
	assert('state.af = on', self.state.af === 'on')
}

async function test9_exposureModeUpdatesLabel() {
	console.log('\n[TEST 9] exposure_mode action now publishes label variable')
	const self = makeFakeSelf()
	const acts = getActions(self)
	self.varUpdates.length = 0
	await acts.exposure_mode.callback({ options: { mode: C.AE_MODE.SHUTTER_PRI } })
	assert('state.aeMode = SHUTTER_PRI', self.state.aeMode === C.AE_MODE.SHUTTER_PRI)
	assert('exposure_mode label = "Shutter Pri"', self.varUpdates.some((v) => v.exposure_mode === 'Shutter Pri'))
}

async function run() {
	await test1_focusAutoSyncs()
	await test2_focusManualSyncs()
	await test3_focusOnePush()
	await test4_focusToggle()
	await test5_aeModeToggleExists()
	await test6_aeModeToggleFlips()
	await test7_focusModeVariableRegistered()
	await test8_focusAutoWithoutViscaDoesntCrash()
	await test9_exposureModeUpdatesLabel()

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

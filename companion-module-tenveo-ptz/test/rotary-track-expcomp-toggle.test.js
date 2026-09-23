/**
 * v1.11.2 tests — verifies:
 *   1. focus_rotary_near / focus_rotary_far now route through focusDriveStep and PUBLISH
 *      focus_position / focus_percent variables on every click (was: pulse() with no tracking).
 *   2. zoom_rotary_in / zoom_rotary_out now route through zoomDriveStep and publish zoom vars.
 *   3. inqExpCompMode command = 81 09 04 3E FF.
 *   4. expcomp_toggle flips state.expCompMode between 'on' and 'off' and emits correct VISCA bytes.
 *   5. expcomp_on / expcomp_off actions update state.expCompMode + publish + trigger feedback.
 *   6. expcomp_mode_state feedback registered.
 *   7. exposure_compensation_mode variable registered.
 */
import { getActions } from '../src/actions.js'
import { getVariables } from '../src/variables.js'
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
	const fb = []
	return {
		config: {
			panSpeed: 12, tiltSpeed: 10, zoomSpeed: 4, variant: 'ndi',
			panCenter: 19050, panUnitsPerDeg: 108.74, tiltCenter: 8000, tiltUnitsPerDeg: 86.66,
			zoomUnitsPerSec: 3200, focusUnitsPerSec: 3200,
			...overrides,
		},
		state: { panDeg: 0, tiltDeg: 0, zoomPos: 0, focusPos: 0, iris: 7, irisFstop: 'f3.4', expComp: 0, expCompMode: 'off', blc: 'off' },
		_pulseTimers: {},
		send: async (bytes) => sent.push(Array.from(bytes)),
		setVariableValues: (v) => varUpdates.push(v),
		checkFeedbacks: (id) => fb.push(id),
		log: () => {},
		sent, varUpdates, feedbackChecks: fb,
	}
}

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

async function test1_focusRotaryPublishes() {
	console.log('\n[TEST 1] focus_rotary_near NOW publishes focus_position on every click')
	const self = makeFakeSelf()
	const acts = getActions(self)
	self.varUpdates.length = 0
	// 5 clicks spaced 15ms apart
	for (let i = 0; i < 5; i++) {
		await acts.focus_rotary_near.callback({ options: { speed: 4, holdMs: 300 } })
		await sleep(15)
	}
	const pubs = self.varUpdates.filter((v) => 'focus_position' in v)
	assert('at least 5 focus_position pubs', pubs.length >= 5, `got ${pubs.length}`)
	// Near direction → focus_position should be non-increasing (heading toward 0)
	// state.focusPos started at 0 (clamped) so we can only check pub count
	const last = pubs[pubs.length - 1]
	assert('focus_position published (non-negative)', last && last.focus_position >= 0)
	assert('focus_percent published', last && typeof last.focus_percent === 'number')
}

async function test2_focusRotaryFarPublishes() {
	console.log('\n[TEST 2] focus_rotary_far publishes focus_position; value grows over clicks')
	const self = makeFakeSelf()
	const acts = getActions(self)
	self.state.focusPos = 0
	self.varUpdates.length = 0
	for (let i = 0; i < 6; i++) {
		await acts.focus_rotary_far.callback({ options: { speed: 7, holdMs: 300 } })
		await sleep(20)
	}
	const pubs = self.varUpdates.filter((v) => 'focus_position' in v)
	assert('≥ 6 focus_position pubs', pubs.length >= 6)
	// Non-decreasing
	let prev = -1, monotonic = true
	for (const p of pubs) { if (p.focus_position < prev) monotonic = false; prev = p.focus_position }
	assert('focus_position non-decreasing (far direction)', monotonic)
	assert('final focus_position > 0', pubs[pubs.length - 1].focus_position > 0, JSON.stringify(pubs[pubs.length - 1]))
}

async function test3_zoomRotaryPublishes() {
	console.log('\n[TEST 3] zoom_rotary_in publishes zoom_position on every click')
	const self = makeFakeSelf()
	const acts = getActions(self)
	self.state.zoomPos = 0
	self.varUpdates.length = 0
	for (let i = 0; i < 5; i++) {
		await acts.zoom_rotary_in.callback({ options: { speed: 4, holdMs: 300 } })
		await sleep(15)
	}
	const pubs = self.varUpdates.filter((v) => 'zoom_position' in v)
	assert('≥ 5 zoom_position pubs from rotary_in', pubs.length >= 5)
}

async function test4_inqExpCompMode() {
	console.log('\n[TEST 4] inqExpCompMode command = 81 09 04 3E FF')
	const b = C.inqExpCompMode()
	assert('bytes match spec', b[0] === 0x81 && b[1] === 0x09 && b[2] === 0x04 && b[3] === 0x3e && b[4] === 0xff && b.length === 5)
}

async function test5_expcompToggle() {
	console.log('\n[TEST 5] expcomp_toggle flips state.expCompMode and emits correct VISCA + feedback')
	const self = makeFakeSelf()
	self.state.expCompMode = 'off'
	const acts = getActions(self)
	self.sent.length = 0; self.varUpdates.length = 0; self.feedbackChecks.length = 0

	await acts.expcomp_toggle.callback()
	assert('flipped to on', self.state.expCompMode === 'on')
	assert('expCompOn sent (81 01 04 3E 02 FF)', self.sent[0] && self.sent[0][3] === 0x3e && self.sent[0][4] === 0x02)
	assert('variable = on', self.varUpdates.some((v) => v.exposure_compensation_mode === 'on'))
	assert('feedback checked', self.feedbackChecks.includes('expcomp_mode_state'))

	await acts.expcomp_toggle.callback()
	assert('flipped to off', self.state.expCompMode === 'off')
	assert('expCompOff sent', self.sent[1] && self.sent[1][3] === 0x3e && self.sent[1][4] === 0x03)
	assert('variable = off', self.varUpdates.some((v) => v.exposure_compensation_mode === 'off'))
}

async function test6_expcompOnOffTracks() {
	console.log('\n[TEST 6] expcomp_on/off actions update state + publish + trigger feedback')
	const self = makeFakeSelf()
	const acts = getActions(self)
	self.state.expCompMode = 'off'
	self.varUpdates.length = 0; self.feedbackChecks.length = 0

	await acts.expcomp_on.callback()
	assert('state = on', self.state.expCompMode === 'on')
	assert('variable published', self.varUpdates.some((v) => v.exposure_compensation_mode === 'on'))
	assert('feedback triggered', self.feedbackChecks.includes('expcomp_mode_state'))

	await acts.expcomp_off.callback()
	assert('state = off', self.state.expCompMode === 'off')
	assert('variable = off', self.varUpdates.some((v) => v.exposure_compensation_mode === 'off'))
}

async function test7_feedbackRegistered() {
	console.log('\n[TEST 7] expcomp_mode_state feedback registered')
	const self = makeFakeSelf()
	const fbs = getFeedbacks(self)
	assert('expcomp_mode_state exists', !!fbs.expcomp_mode_state)
	assert('name = "Exposure Compensation Mode"', fbs.expcomp_mode_state && fbs.expcomp_mode_state.name === 'Exposure Compensation Mode')
	self.state.expCompMode = 'on'
	assert('callback true when expCompMode=on & options.state=on', fbs.expcomp_mode_state.callback({ options: { state: 'on' } }) === true)
	assert('callback false for off when on', fbs.expcomp_mode_state.callback({ options: { state: 'off' } }) === false)
}

async function test8_variableRegistered() {
	console.log('\n[TEST 8] exposure_compensation_mode variable registered')
	const vars = getVariables()
	assert('exposure_compensation_mode registered', !!vars.exposure_compensation_mode, JSON.stringify(Object.keys(vars)))
}

async function test9_focusRotaryDisplayNames() {
	console.log('\n[TEST 9] focus_rotary_* + zoom_rotary_* display names indicate tracked mode')
	const self = makeFakeSelf()
	const acts = getActions(self)
	assert('focus_rotary_near name mentions tracked', /tracked/i.test(acts.focus_rotary_near?.name || ''), acts.focus_rotary_near?.name)
	assert('focus_rotary_far name mentions tracked', /tracked/i.test(acts.focus_rotary_far?.name || ''))
	assert('zoom_rotary_in name mentions tracked', /tracked/i.test(acts.zoom_rotary_in?.name || ''))
	assert('zoom_rotary_out name mentions tracked', /tracked/i.test(acts.zoom_rotary_out?.name || ''))
}

async function run() {
	await test1_focusRotaryPublishes()
	await test2_focusRotaryFarPublishes()
	await test3_zoomRotaryPublishes()
	await test4_inqExpCompMode()
	await test5_expcompToggle()
	await test6_expcompOnOffTracks()
	await test7_feedbackRegistered()
	await test8_variableRegistered()
	await test9_focusRotaryDisplayNames()

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

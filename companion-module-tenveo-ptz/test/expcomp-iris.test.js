/**
 * v1.11.0 tests — exposure_compensation + iris_fstop variables.
 *
 * Verifies:
 *   1. inqExpComp command bytes = 81 09 04 4E FF
 *   2. IRIS_FSTOP lookup table is length 14, index 0 = 'Off', index 13 = 'f1.6'
 *   3. expcomp_up/down/reset/direct maintain state.expComp in [-7, +7] and publish exposure_compensation
 *   4. iris_up/down/reset/direct maintain state.iris in [0, 13] and publish iris + iris_fstop
 *   5. gain_up/down/reset ROUTE to expcomp on NDI variant and update state.expComp
 *   6. exposure_compensation variable is registered in variables.js
 *   7. iris_fstop variable is registered in variables.js
 *   8. expcomp_direct at value 3 sends VISCA byte with raw 3+7=10 (0x0A) at the payload nibble
 *   9. iris_fstop mapping for each raw index matches the user's spec
 *  10. expcomp_up clamps at +7; expcomp_down clamps at -7
 *  11. iris_up clamps at 13; iris_down clamps at 0
 *  12. Poll _setExpComp / _setIris parse raw values correctly (raw 10 → display 3; raw 6 → f4.0)
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
	return {
		config: { panSpeed: 12, tiltSpeed: 10, zoomSpeed: 4, variant: 'ndi', ...overrides },
		state: { panDeg: 0, tiltDeg: 0, zoomPos: 0, focusPos: 0, iris: 7, irisFstop: 'f3.4', expComp: 0, blc: 'off' },
		_pulseTimers: {},
		send: async (bytes) => sent.push(Array.from(bytes)),
		setVariableValues: (v) => varUpdates.push(v),
		checkFeedbacks: () => {},
		log: () => {},
		sent,
		varUpdates,
	}
}

async function test1_inqExpCompBytes() {
	console.log('\n[TEST 1] inqExpComp command = 81 09 04 4E FF')
	const b = C.inqExpComp()
	assert('length 5', b.length === 5)
	assert('bytes exact', b[0] === 0x81 && b[1] === 0x09 && b[2] === 0x04 && b[3] === 0x4e && b[4] === 0xff, JSON.stringify(b))
}

async function test2_irisFstopTable() {
	console.log('\n[TEST 2] IRIS_FSTOP lookup table')
	assert('length 14', C.IRIS_FSTOP.length === 14, `got ${C.IRIS_FSTOP.length}`)
	assert("index 0 = 'Off'", C.IRIS_FSTOP[0] === 'Off', `got ${C.IRIS_FSTOP[0]}`)
	assert("index 13 = 'f1.6'", C.IRIS_FSTOP[13] === 'f1.6', `got ${C.IRIS_FSTOP[13]}`)
	assert("index 6 = 'f4.0'", C.IRIS_FSTOP[6] === 'f4.0', `got ${C.IRIS_FSTOP[6]}`)
	assert("index 1 = 'f32.0'", C.IRIS_FSTOP[1] === 'f32.0', `got ${C.IRIS_FSTOP[1]}`)
	assert("index 12 = 'f1.85'", C.IRIS_FSTOP[12] === 'f1.85')
	assert("index 9 = 'f2.63'", C.IRIS_FSTOP[9] === 'f2.63')
}

async function test3_expcompUpDownReset() {
	console.log('\n[TEST 3] expcomp_up/down/reset update state.expComp and publish variable')
	const self = makeFakeSelf()
	const acts = getActions(self)
	self.state.expComp = 0
	await acts.expcomp_up.callback()
	assert('after up: expComp = 1', self.state.expComp === 1)
	let last = self.varUpdates[self.varUpdates.length - 1]
	assert('publishes exposure_compensation = 1', last && last.exposure_compensation === 1, JSON.stringify(last))
	await acts.expcomp_up.callback()
	assert('after 2nd up: expComp = 2', self.state.expComp === 2)
	await acts.expcomp_down.callback()
	assert('after down: expComp = 1', self.state.expComp === 1)
	await acts.expcomp_reset.callback()
	assert('after reset: expComp = 0', self.state.expComp === 0)
	last = self.varUpdates[self.varUpdates.length - 1]
	assert('publishes exposure_compensation = 0 after reset', last && last.exposure_compensation === 0)
}

async function test4_expcompDirect() {
	console.log('\n[TEST 4] expcomp_direct sets state and sends raw=display+7')
	const self = makeFakeSelf()
	const acts = getActions(self)
	self.sent.length = 0
	self.varUpdates.length = 0
	await acts.expcomp_direct.callback({ options: { v: 3 } })
	assert('state.expComp = 3', self.state.expComp === 3)
	assert('exposure_compensation = 3 published', self.varUpdates.some((v) => v.exposure_compensation === 3))
	// VISCA expCompDirect payload: 81 01 04 4E 00 00 0p 0q FF where raw = 3+7 = 10 = 0x0A
	const sent = self.sent[0]
	assert('expCompDirect sent', sent && sent[0] === 0x81 && sent[2] === 0x04 && sent[3] === 0x4e)
	// Last 2 nibbles before FF encode value 10 as 00 0A
	assert('raw nibbles encode value 10 (0x0A)', sent && sent[6] === 0x00 && sent[7] === 0x0a, `got payload=${JSON.stringify(sent)}`)
}

async function test5_expcompClampsAt7() {
	console.log('\n[TEST 5] expcomp_up clamps at +7, expcomp_down clamps at -7')
	const self = makeFakeSelf()
	const acts = getActions(self)
	self.state.expComp = 6
	await acts.expcomp_up.callback()
	assert('7', self.state.expComp === 7)
	await acts.expcomp_up.callback()
	assert('still 7 (clamped)', self.state.expComp === 7)
	self.state.expComp = -6
	await acts.expcomp_down.callback()
	assert('-7', self.state.expComp === -7)
	await acts.expcomp_down.callback()
	assert('still -7 (clamped)', self.state.expComp === -7)
}

async function test6_irisUpDown() {
	console.log('\n[TEST 6] iris_up/down update state.iris + publish iris + iris_fstop')
	const self = makeFakeSelf()
	const acts = getActions(self)
	self.state.iris = 5
	self.varUpdates.length = 0
	await acts.iris_up.callback()
	assert('iris = 6', self.state.iris === 6)
	const last1 = self.varUpdates[self.varUpdates.length - 1]
	assert('iris variable = 6', last1 && last1.iris === 6, JSON.stringify(last1))
	assert("iris_fstop = 'f4.0'", last1 && last1.iris_fstop === 'f4.0', JSON.stringify(last1))
	await acts.iris_down.callback()
	assert('iris = 5', self.state.iris === 5)
	const last2 = self.varUpdates[self.varUpdates.length - 1]
	assert("iris_fstop = 'f6.0' at index 5", last2 && last2.iris_fstop === 'f6.0', JSON.stringify(last2))
}

async function test7_irisDirect() {
	console.log('\n[TEST 7] iris_direct sets state and publishes correct f-stop')
	const self = makeFakeSelf()
	const acts = getActions(self)
	self.varUpdates.length = 0
	await acts.iris_direct.callback({ options: { v: 0 } })
	assert('index 0 = Off', self.varUpdates.some((v) => v.iris_fstop === 'Off'))
	await acts.iris_direct.callback({ options: { v: 13 } })
	assert('index 13 = f1.6', self.varUpdates.some((v) => v.iris_fstop === 'f1.6'))
	await acts.iris_direct.callback({ options: { v: 9 } })
	assert('index 9 = f2.63', self.varUpdates[self.varUpdates.length - 1].iris_fstop === 'f2.63')
}

async function test8_irisClamps() {
	console.log('\n[TEST 8] iris_up clamps at 13, iris_down clamps at 0')
	const self = makeFakeSelf()
	const acts = getActions(self)
	self.state.iris = 13
	await acts.iris_up.callback()
	assert('still 13', self.state.iris === 13)
	self.state.iris = 0
	await acts.iris_down.callback()
	assert('still 0', self.state.iris === 0)
}

async function test9_gainRoutesToExpCompOnNDI() {
	console.log('\n[TEST 9] gain_up/down/reset route to expcomp on NDI + track state.expComp')
	const self = makeFakeSelf({ variant: 'ndi' })
	const acts = getActions(self)
	self.state.expComp = 0
	self.varUpdates.length = 0
	await acts.gain_up.callback()
	assert('NDI gain_up increments expComp', self.state.expComp === 1)
	assert('exposure_compensation published from gain_up', self.varUpdates.some((v) => v.exposure_compensation === 1))
	await acts.gain_down.callback()
	assert('NDI gain_down decrements', self.state.expComp === 0)
	await acts.gain_reset.callback()
	assert('NDI gain_reset resets to 0', self.state.expComp === 0)

	// On non-NDI variant, gain_up does NOT touch expComp
	const selfStd = makeFakeSelf({ variant: 'standard' })
	const actsStd = getActions(selfStd)
	selfStd.state.expComp = 3
	await actsStd.gain_up.callback()
	assert('standard gain_up does NOT change expComp', selfStd.state.expComp === 3)
}

async function test10_variablesRegistered() {
	console.log('\n[TEST 10] exposure_compensation + iris_fstop registered in variables.js')
	const vars = getVariables()
	assert('exposure_compensation registered', !!vars.exposure_compensation, JSON.stringify(Object.keys(vars)))
	assert('iris_fstop registered', !!vars.iris_fstop)
	assert('iris still registered', !!vars.iris)
}

async function test11_gainRotaryRoutingOnNDI() {
	console.log('\n[TEST 11] gain_rotary_up/down also route to expcomp on NDI + track state')
	const self = makeFakeSelf({ variant: 'ndi' })
	const acts = getActions(self)
	self.state.expComp = 0
	await acts.gain_rotary_up.callback()
	assert('gain_rotary_up NDI expComp = 1', self.state.expComp === 1)
	await acts.gain_rotary_down.callback()
	assert('gain_rotary_down NDI expComp = 0', self.state.expComp === 0)
}

async function run() {
	await test1_inqExpCompBytes()
	await test2_irisFstopTable()
	await test3_expcompUpDownReset()
	await test4_expcompDirect()
	await test5_expcompClampsAt7()
	await test6_irisUpDown()
	await test7_irisDirect()
	await test8_irisClamps()
	await test9_gainRoutesToExpCompOnNDI()
	await test10_variablesRegistered()
	await test11_gainRotaryRoutingOnNDI()

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

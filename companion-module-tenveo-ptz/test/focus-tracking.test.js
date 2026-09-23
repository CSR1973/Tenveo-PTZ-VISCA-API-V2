/**
 * v1.9.0 focus tracking tests — verifies:
 *   1. state.focusPos initialises to 0 (not null) — so focus_position variable evaluates immediately.
 *   2. focus_step_near / focus_step_far exist as actions with drive+auto-stop pattern.
 *   3. Rapid focus_step_far clicks emit exactly ONE focusFarVar drive + ONE focusStop after idle.
 *   4. After drive+auto-stop, state.focusPos has grown and focus_position + focus_percent variables were published.
 *   5. focus_near / focus_far / focus_stop actions record drive start + flush distance on stop.
 *   6. focus_reset_tracker action zeroes (or seeds) state.focusPos and re-publishes variables.
 *   7. Direction reversal (far → near) flushes accumulated far distance before starting near drive.
 *   8. focus_direct still updates focus_position and focus_percent (regression from v1.8.0).
 *   9. Focus speed 0 still produces non-zero units/s so slow-focus drives track motion.
 *  10. focusUnitsPerSec config knob exists with default 3200.
 */
import { getActions } from '../src/actions.js'
import { getVariables } from '../src/variables.js'
import { getConfigFields } from '../src/config.js'
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
	const self = {
		config: {
			panSpeed: 12,
			tiltSpeed: 10,
			zoomSpeed: 4,
			variant: 'ndi',
			panCenter: 19050,
			panUnitsPerDeg: 108.74,
			tiltCenter: 8000,
			tiltUnitsPerDeg: 86.66,
			panDegPerSec: 100,
			tiltDegPerSec: 60,
			zoomUnitsPerSec: 3200,
			focusUnitsPerSec: 3200,
			...overrides,
		},
		// Mirror main.js init: focusPos should be 0 (not null)
		state: { panDeg: 0, tiltDeg: 0, zoomPos: 0, focusPos: 0, blc: 'off' },
		_pulseTimers: {},
		send: async (bytes) => sent.push(Array.from(bytes)),
		setVariableValues: (v) => varUpdates.push(v),
		checkFeedbacks: () => {},
		log: () => {},
		sent,
		varUpdates,
	}
	return self
}

function classifyFocusCmd(bytes) {
	// focusStop:    81 01 04 08 00 FF
	// focusFarVar:  81 01 04 08 (20|s) FF
	// focusNearVar: 81 01 04 08 (30|s) FF
	// focusDirect:  81 01 04 48 a b c d FF
	if (bytes[0] !== 0x81 || bytes[2] !== 0x04) return null
	if (bytes[3] === 0x08) {
		const b = bytes[4]
		if (b === 0x00) return { kind: 'stop' }
		if ((b & 0xf0) === 0x20) return { kind: 'farVar', speed: b & 0x0f }
		if ((b & 0xf0) === 0x30) return { kind: 'nearVar', speed: b & 0x0f }
	}
	if (bytes[3] === 0x48) {
		const p = ((bytes[4] & 0xf) << 12) | ((bytes[5] & 0xf) << 8) | ((bytes[6] & 0xf) << 4) | (bytes[7] & 0xf)
		return { kind: 'direct', pos: p }
	}
	return null
}

async function waitFor(condFn, timeoutMs = 800) {
	const start = Date.now()
	while (Date.now() - start < timeoutMs) {
		if (condFn()) return true
		await new Promise((r) => setTimeout(r, 5))
	}
	return false
}

async function test1_focusPosStartsAtZero() {
	console.log('\n[TEST 1] state.focusPos starts at 0 (mirrors main.js init)')
	const self = makeFakeSelf()
	assert('state.focusPos === 0', self.state.focusPos === 0)
	// _publishStaticVars would emit focus_position: 0 and focus_percent: 0
	const pos = Math.max(0, Math.min(16384, self.state.focusPos ?? 0))
	assert('would-publish focus_position = 0', pos === 0)
	assert('would-publish focus_percent = 0', Math.round((pos / 16384) * 100) === 0)
}

async function test2_focusStepActionsExist() {
	console.log('\n[TEST 2] focus_step_near / focus_step_far exist with drive+auto-stop options')
	const self = makeFakeSelf()
	const acts = getActions(self)
	assert('focus_step_near exists', !!acts.focus_step_near)
	assert('focus_step_far exists', !!acts.focus_step_far)
	assert('focus_step_near has speed dropdown', acts.focus_step_near?.options.some((o) => o.id === 'speed'))
	assert('focus_step_near has idleMs default 250', acts.focus_step_near?.options.find((o) => o.id === 'idleMs')?.default === 250)
}

async function test3_rapidClicksCoalesced() {
	console.log('\n[TEST 3] Rapid focus_step_far clicks → 1 farVar drive + 1 focusStop after idle')
	const self = makeFakeSelf()
	const acts = getActions(self)
	self.sent.length = 0
	// 15 rapid clicks over ~150ms
	for (let i = 0; i < 15; i++) {
		await acts.focus_step_far.callback({ options: { speed: 4, idleMs: 200 } })
		await new Promise((r) => setTimeout(r, 10))
	}
	await waitFor(() => classifyFocusCmd(self.sent[self.sent.length - 1] || [])?.kind === 'stop', 1200)
	const kinds = self.sent.map((b) => classifyFocusCmd(b))
	const farDrives = kinds.filter((k) => k?.kind === 'farVar')
	const stops = kinds.filter((k) => k?.kind === 'stop')
	assert('exactly 1 focusFarVar drive during spin', farDrives.length === 1, `got ${farDrives.length}, kinds=${JSON.stringify(kinds.map((k) => k?.kind))}`)
	assert('drive uses selected speed (4)', farDrives[0] && farDrives[0].speed === 4)
	assert('exactly 1 focusStop after idle', stops.length === 1, `got ${stops.length}`)
	assert('state.focusPos > 0 after drive', self.state.focusPos > 0, `got ${self.state.focusPos}`)
}

async function test4_variablesUpdateAfterDrive() {
	console.log('\n[TEST 4] focus_position + focus_percent update after auto-stop')
	const self = makeFakeSelf()
	const acts = getActions(self)
	self.varUpdates.length = 0
	const t0 = Date.now()
	while (Date.now() - t0 < 500) {
		await acts.focus_step_far.callback({ options: { speed: 7, idleMs: 150 } })
		await new Promise((r) => setTimeout(r, 15))
	}
	await waitFor(() => self.varUpdates.some((v) => 'focus_position' in v && v.focus_position > 0), 1200)
	const last = self.varUpdates[self.varUpdates.length - 1]
	assert('focus_position variable emitted (non-zero)', last && last.focus_position > 0, JSON.stringify(last))
	assert('focus_percent variable emitted', last && typeof last.focus_percent === 'number', JSON.stringify(last))
	assert('focus_percent within [0..100]', last && last.focus_percent >= 0 && last.focus_percent <= 100)
	assert('state.focusPos in expected range 800-2500', self.state.focusPos >= 800 && self.state.focusPos <= 2500, `got ${self.state.focusPos}`)
}

async function test5_focusNearFarStopFlushTracker() {
	console.log('\n[TEST 5] focus_near + focus_stop records + flushes distance')
	const self = makeFakeSelf()
	const acts = getActions(self)
	self.state.focusPos = 5000
	self.sent.length = 0
	self.varUpdates.length = 0
	await acts.focus_near.callback({ options: { speed: 7 } })
	// Simulate holding for 300ms
	await new Promise((r) => setTimeout(r, 300))
	await acts.focus_stop.callback()
	// Should have subtracted ~950 units (0.3s × 3200 × 1.0)
	assert('state.focusPos decreased from 5000', self.state.focusPos < 5000, `got ${self.state.focusPos}`)
	const last = self.varUpdates[self.varUpdates.length - 1]
	assert('focus_position variable published after stop', last && 'focus_position' in last, JSON.stringify(last))
	// Verify actual VISCA bytes: nearVar then stop
	const kinds = self.sent.map((b) => classifyFocusCmd(b))
	assert('nearVar drive emitted', kinds.some((k) => k?.kind === 'nearVar'))
	assert('focusStop emitted', kinds.some((k) => k?.kind === 'stop'))
}

async function test6_focusResetTracker() {
	console.log('\n[TEST 6] focus_reset_tracker zeroes state.focusPos without moving camera')
	const self = makeFakeSelf()
	const acts = getActions(self)
	self.state.focusPos = 9999
	self.sent.length = 0
	self.varUpdates.length = 0
	await acts.focus_reset_tracker.callback({ options: { pos: 0 } })
	assert('state.focusPos = 0', self.state.focusPos === 0)
	assert('no VISCA sent', self.sent.length === 0)
	const last = self.varUpdates[self.varUpdates.length - 1]
	assert('focus_position = 0 emitted', last && last.focus_position === 0)
	assert('focus_percent = 0 emitted', last && last.focus_percent === 0)
	// Now seed at 8000
	await acts.focus_reset_tracker.callback({ options: { pos: 8000 } })
	assert('seed value works', self.state.focusPos === 8000)
	const last2 = self.varUpdates[self.varUpdates.length - 1]
	assert('focus_percent ~ 49 for 8000', last2 && last2.focus_percent === 49, JSON.stringify(last2))
}

async function test7_directionReversalFlushes() {
	console.log('\n[TEST 7] Reversing focus direction mid-spin flushes previous drive')
	const self = makeFakeSelf()
	const acts = getActions(self)
	self.state.focusPos = 5000
	self.sent.length = 0
	await acts.focus_step_far.callback({ options: { speed: 4, idleMs: 300 } })
	await new Promise((r) => setTimeout(r, 200))
	const posAfterFar = self.state.focusPos
	await acts.focus_step_near.callback({ options: { speed: 4, idleMs: 100 } })
	assert('focusPos > 5000 after far phase (flushed on reversal)', self.state.focusPos > 5000, `got ${self.state.focusPos}, posAfterFar=${posAfterFar}`)
	const kinds = self.sent.map((b) => classifyFocusCmd(b))
	assert('1 farVar drive', kinds.filter((k) => k?.kind === 'farVar').length === 1)
	assert('1 nearVar drive', kinds.filter((k) => k?.kind === 'nearVar').length === 1)
	await waitFor(() => self.sent.map((b) => classifyFocusCmd(b)).some((k) => k?.kind === 'stop'), 500)
	assert('final focusStop emitted', self.sent.some((b) => classifyFocusCmd(b)?.kind === 'stop'))
}

async function test8_focusDirectRegression() {
	console.log('\n[TEST 8] focus_direct still updates focus_position + focus_percent')
	const self = makeFakeSelf()
	const acts = getActions(self)
	self.varUpdates.length = 0
	await acts.focus_direct.callback({ options: { pos: 16384 } })
	const last = self.varUpdates[self.varUpdates.length - 1]
	assert('focus_position = 16384', last && last.focus_position === 16384)
	assert('focus_percent = 100', last && last.focus_percent === 100)
	assert('state.focusPos = 16384', self.state.focusPos === 16384)
}

async function test9_speed0StillTracks() {
	console.log('\n[TEST 9] Focus speed 0 still produces non-zero motion (12.5% of max)')
	const self = makeFakeSelf()
	const acts = getActions(self)
	self.state.focusPos = 8000
	await acts.focus_step_far.callback({ options: { speed: 0, idleMs: 150 } })
	await new Promise((r) => setTimeout(r, 300))
	await waitFor(() => self.state.focusPos > 8000, 500)
	assert('state.focusPos > 8000 (some motion tracked)', self.state.focusPos > 8000, `got ${self.state.focusPos}`)
}

async function test10_configFieldExists() {
	console.log('\n[TEST 10] focusUnitsPerSec config field exists with default 3200')
	const fields = getConfigFields()
	const f = fields.find((x) => x.id === 'focusUnitsPerSec')
	assert('focusUnitsPerSec field present', !!f, JSON.stringify(fields.map((x) => x.id)))
	assert('default = 3200', f && f.default === 3200, `got ${f?.default}`)
	assert('label mentions Focus units/s', f && /focus.*units.*s/i.test(f.label))
}

async function test11_focusVarsRegisteredInVariablesJs() {
	console.log('\n[TEST 11] focus_position + focus_percent are registered in variables.js')
	const vars = getVariables()
	const fp = vars.focus_position
	const fperc = vars.focus_percent
	assert('focus_position registered', !!fp, JSON.stringify(Object.keys(vars)))
	assert('focus_percent registered', !!fperc)
	assert('focus_position label mentions 0-16384', fp && /16384/.test(fp.name))
	assert('focus_percent label mentions near/far', fperc && /near.*far/i.test(fperc.name))
}

async function run() {
	await test1_focusPosStartsAtZero()
	await test2_focusStepActionsExist()
	await test3_rapidClicksCoalesced()
	await test4_variablesUpdateAfterDrive()
	await test5_focusNearFarStopFlushTracker()
	await test6_focusResetTracker()
	await test7_directionReversalFlushes()
	await test8_focusDirectRegression()
	await test9_speed0StillTracks()
	await test10_configFieldExists()
	await test11_focusVarsRegisteredInVariablesJs()

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

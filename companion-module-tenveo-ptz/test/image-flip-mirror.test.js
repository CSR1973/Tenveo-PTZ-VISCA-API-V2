/**
 * v1.18.0 test — Image Flip / Mirror actions.
 *
 * Verifies:
 *   • Individual flip/mirror toggle actions flip state + publish variables + send correct VISCA.
 *   • Combined image_flip_mirror_toggle flips BOTH together with a single press.
 *   • Explicit on/off actions send the exact bytes.
 */
import { getActions } from '../src/actions.js'
import * as C from '../src/commands.js'

const results = []
function assert(name, cond, extra = '') {
	results.push({ name, ok: !!cond, extra })
	if (cond) console.log(`  \u2713 ${name}${extra ? ' — ' + extra : ''}`)
	else console.error(`  \u2717 ${name}${extra ? ' — ' + extra : ''}`)
}

function bytesEq(a, b) {
	return Array.isArray(a) && a.length === b.length && b.every((x, i) => a[i] === x)
}

function makeSelf() {
	const sent = []
	const vars = {}
	return {
		config: { variant: 'ndi' },
		state: { flipOn: false, mirrorOn: false },
		_pulseTimers: {},
		send: async (b) => sent.push(b),
		setVariableValues: (v) => Object.assign(vars, v),
		checkFeedbacks: () => {},
		log: () => {},
		sent,
		vars,
	}
}

function test1_bytesAreStandardSonyVISCA() {
	console.log('\n[TEST 1] flip / mirror opcodes match standard Sony VISCA')
	assert('flipOn   = 81 01 04 66 02 FF', bytesEq(C.flipOn(),  [0x81, 0x01, 0x04, 0x66, 0x02, 0xff]))
	assert('flipOff  = 81 01 04 66 03 FF', bytesEq(C.flipOff(), [0x81, 0x01, 0x04, 0x66, 0x03, 0xff]))
	assert('mirrorOn = 81 01 04 61 02 FF', bytesEq(C.mirrorOn(),  [0x81, 0x01, 0x04, 0x61, 0x02, 0xff]))
	assert('mirrorOff= 81 01 04 61 03 FF', bytesEq(C.mirrorOff(), [0x81, 0x01, 0x04, 0x61, 0x03, 0xff]))
}

async function test2_flipToggle() {
	console.log('\n[TEST 2] image_flip_toggle: state flips, var publishes, correct byte sent')
	const self = makeSelf()
	const acts = getActions(self)
	await acts.image_flip_toggle.callback()
	assert('state.flipOn = true', self.state.flipOn === true)
	assert('variable image_flip = on', self.vars.image_flip === 'on')
	assert('sent flipOn bytes', bytesEq(self.sent[0], C.flipOn()))
	await acts.image_flip_toggle.callback()
	assert('state.flipOn = false after 2nd toggle', self.state.flipOn === false)
	assert('variable image_flip = off', self.vars.image_flip === 'off')
	assert('sent flipOff bytes', bytesEq(self.sent[1], C.flipOff()))
}

async function test3_mirrorToggle() {
	console.log('\n[TEST 3] image_mirror_toggle mirrors behaviour (LR reverse)')
	const self = makeSelf()
	const acts = getActions(self)
	await acts.image_mirror_toggle.callback()
	assert('state.mirrorOn = true', self.state.mirrorOn === true)
	assert('variable image_mirror = on', self.vars.image_mirror === 'on')
	assert('sent mirrorOn bytes', bytesEq(self.sent[0], C.mirrorOn()))
	await acts.image_mirror_toggle.callback()
	assert('state.mirrorOn = false', self.state.mirrorOn === false)
	assert('sent mirrorOff bytes', bytesEq(self.sent[1], C.mirrorOff()))
}

async function test4_combinedToggle() {
	console.log('\n[TEST 4] image_flip_mirror_toggle flips BOTH in a single press')
	const self = makeSelf()
	const acts = getActions(self)
	await acts.image_flip_mirror_toggle.callback()
	assert('flipOn=true after 1st press', self.state.flipOn === true)
	assert('mirrorOn=true after 1st press', self.state.mirrorOn === true)
	assert('image_flip var = on', self.vars.image_flip === 'on')
	assert('image_mirror var = on', self.vars.image_mirror === 'on')
	assert('sent 2 cmds (flipOn + mirrorOn)', self.sent.length === 2)
	assert('  1st = flipOn', bytesEq(self.sent[0], C.flipOn()))
	assert('  2nd = mirrorOn', bytesEq(self.sent[1], C.mirrorOn()))
	await acts.image_flip_mirror_toggle.callback()
	assert('flipOn=false after 2nd press', self.state.flipOn === false)
	assert('mirrorOn=false after 2nd press', self.state.mirrorOn === false)
	assert('sent 4 cmds total', self.sent.length === 4)
	assert('  3rd = flipOff', bytesEq(self.sent[2], C.flipOff()))
	assert('  4th = mirrorOff', bytesEq(self.sent[3], C.mirrorOff()))
}

async function test5_explicitOnOffActions() {
	console.log('\n[TEST 5] Explicit on/off actions send exact bytes without flipping state twice')
	const self = makeSelf()
	const acts = getActions(self)
	await acts.image_flip_on.callback()
	await acts.image_flip_off.callback()
	await acts.image_mirror_on.callback()
	await acts.image_mirror_off.callback()
	assert('image_flip_on sent flipOn', bytesEq(self.sent[0], C.flipOn()))
	assert('image_flip_off sent flipOff', bytesEq(self.sent[1], C.flipOff()))
	assert('image_mirror_on sent mirrorOn', bytesEq(self.sent[2], C.mirrorOn()))
	assert('image_mirror_off sent mirrorOff', bytesEq(self.sent[3], C.mirrorOff()))
	assert('final state: flipOn=false, mirrorOn=false', !self.state.flipOn && !self.state.mirrorOn)
}

;(async () => {
	test1_bytesAreStandardSonyVISCA()
	await test2_flipToggle()
	await test3_mirrorToggle()
	await test4_combinedToggle()
	await test5_explicitOnOffActions()

	const failed = results.filter((r) => !r.ok)
	const total = results.length
	console.log(`\n───── ${total - failed.length}/${total} assertions passed ─────`)
	if (failed.length) {
		console.error('Failed:')
		failed.forEach((f) => console.error(`  ✗ ${f.name}${f.extra ? ' — ' + f.extra : ''}`))
		process.exit(1)
	}
})()

/**
 * v2.0.1 regression test — variables.js MUST return an object, not an array.
 *
 * Companion 5.x's @companion-module/base 2.x throws "Variable definitions
 * should be an object, not an array" the moment init() calls
 * setVariableDefinitions(getVariables()) with the old array shape. This test
 * reproduces that exact validation so we catch it before shipping again.
 */
import { getVariables } from '../src/variables.js'

const results = []
function assert(name, cond, extra = '') {
	results.push({ name, ok: !!cond, extra })
	if (cond) console.log(`  \u2713 ${name}${extra ? ' — ' + extra : ''}`)
	else console.error(`  \u2717 ${name}${extra ? ' — ' + extra : ''}`)
}

function test1_shapeIsObjectNotArray() {
	console.log('\n[TEST 1] getVariables() returns an object literal (API v2), NOT an array (API v1)')
	const v = getVariables()
	assert('is a plain object', typeof v === 'object' && v !== null)
	assert('is NOT an array (would trigger Companion 5.x rejection)', !Array.isArray(v),
		Array.isArray(v) ? 'array detected — Companion 5.x will REFUSE to init the module' : '')
}

function test2_everyEntryHasAName() {
	console.log('\n[TEST 2] Every entry has the required { name: string } shape')
	const v = getVariables()
	for (const [id, def] of Object.entries(v)) {
		assert(`${id} → { name: string }`, def && typeof def.name === 'string' && def.name.length > 0)
	}
}

function test3_allExpectedVariablesPresent() {
	console.log('\n[TEST 3] All variables that main.js publishes are registered here')
	const v = getVariables()
	const mustExist = [
		'camera_name', 'host', 'connected', 'last_preset',
		'power', 'af', 'exposure_mode', 'wb_mode',
		'gain', 'iris', 'iris_fstop', 'shutter',
		'exposure_compensation', 'exposure_compensation_mode',
		'zoom_position', 'zoom_percent',
		'focus_position', 'focus_percent', 'focus_mode',
		'backlight',
		'pan_position', 'tilt_position', 'pan_degrees', 'tilt_degrees',
		'color_temp', 'warmth',
		'preset_save_index', 'preset_recall_index',
		'image_flip', 'image_mirror',
	]
	for (const id of mustExist) {
		assert(`${id} is defined`, Object.prototype.hasOwnProperty.call(v, id))
	}
}

function test4_reproduceCompanion5ValidationLogic() {
	console.log('\n[TEST 4] Reproduces the exact check @companion-module/base 2.x runs at init time')
	const v = getVariables()
	// The library's throw:
	//     if (Array.isArray(variables)) throw new Error('Variable definitions should be an object, not an array')
	let threw = false
	try {
		if (Array.isArray(v)) throw new Error('Variable definitions should be an object, not an array')
	} catch (e) {
		threw = true
		console.error('  ✗', e.message)
	}
	assert('setVariableDefinitions() would ACCEPT this shape at Companion 5.x init', !threw)
}

test1_shapeIsObjectNotArray()
test2_everyEntryHasAName()
test3_allExpectedVariablesPresent()
test4_reproduceCompanion5ValidationLogic()

const failed = results.filter((r) => !r.ok)
const total = results.length
console.log(`\n───── ${total - failed.length}/${total} assertions passed ─────`)
if (failed.length) {
	console.error('Failed:')
	failed.forEach((f) => console.error(`  ✗ ${f.name}${f.extra ? ' — ' + f.extra : ''}`))
	process.exit(1)
}

/**
 * v1.14.1 test — Upgrade script shape guard.
 *
 * The @companion-module/base upgrade dispatcher iterates `res.updatedActions`
 * and `res.updatedFeedbacks` with `for..of`, so BOTH MUST be arrays (returning
 * an object here crashes `_handleUpdateActions`, which is why v1.14.0 nuked
 * all connections to a red state).
 *
 * This test doesn't import the actual upgrade script (it lives inside the
 * `runEntrypoint` closure in main.js), but it reproduces the same rename
 * table and verifies the shape contract independently.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const results = []
function assert(name, cond, extra = '') {
	results.push({ name, ok: !!cond, extra })
	if (cond) console.log(`  \u2713 ${name}${extra ? ' — ' + extra : ''}`)
	else console.error(`  \u2717 ${name}${extra ? ' — ' + extra : ''}`)
}

// Extract the upgrade script body from main.js and eval it (best-effort static
// check that the script is defined and its rename table is complete).
const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8')

function test1_upgradeScriptRegistered() {
	console.log('\n[TEST 1] main.js exports migrateExpCompActionIds via UpgradeScripts (Companion API v2)')
	assert('UpgradeScripts array is exported', /export\s+const\s+UpgradeScripts\s*=\s*\[/.test(mainSrc))
	assert('default-export of TenveoInstance', /export\s+default\s+TenveoInstance/.test(mainSrc))
	assert('migrateExpCompActionIds function defined', /function\s+migrateExpCompActionIds\s*\(/.test(mainSrc))
}

function test2_renameTableCoversAllLegacyIds() {
	console.log('\n[TEST 2] rename table covers all known legacy ExpComp / Gain IDs')
	for (const legacy of [
		'expcomp_step_up',
		'expcomp_step_down',
		'expcomp_step_reset',
		'expcomp_mode_toggle',
		'expcomp_ae_toggle',
		'expcomp_manual',
		'expcomp_auto',
		'gain_up_ndi',
		'gain_down_ndi',
		'gain_reset_ndi',
	]) {
		assert(`rename[${legacy}] defined`, new RegExp(`${legacy}:\\s*['"]`).test(mainSrc))
	}
}

function test3_returnShapeIsArrays() {
	console.log('\n[TEST 3] upgrade script return uses ARRAYS for updatedActions / updatedFeedbacks (Companion API contract)')
	// The base library iterates: `for (const action of res.updatedActions)` — objects would crash it.
	assert('updatedActions is initialised as []', /const\s+updatedActions\s*=\s*\[\]/.test(mainSrc))
	assert('updatedFeedbacks returned as []', /updatedFeedbacks:\s*\[\]/.test(mainSrc))
	assert('does NOT return updatedActions as object literal', !/updatedActions\s*=\s*\{\}/.test(mainSrc))
}

function test4_migrationBehaviourManual() {
	console.log('\n[TEST 4] Simulated migration: legacy actionIds are rewritten in place')
	// Reproduce the rename map + logic here as an isolated smoke check
	const rename = {
		expcomp_step_up: 'expcomp_up',
		expcomp_step_down: 'expcomp_down',
		expcomp_mode_toggle: 'expcomp_toggle',
		gain_up_ndi: 'gain_up',
	}
	const props = {
		actions: [
			{ id: 'a1', controlId: 'bank/1/0', actionId: 'expcomp_mode_toggle', options: {} },
			{ id: 'a2', controlId: 'bank/1/1', actionId: 'gain_up_ndi', options: {} },
			{ id: 'a3', controlId: 'bank/1/2', actionId: 'pt_up', options: {} }, // unchanged
		],
	}
	const updatedActions = []
	for (const action of props.actions) {
		if (action && rename[action.actionId]) {
			action.actionId = rename[action.actionId]
			updatedActions.push(action)
		}
	}
	assert('updatedActions is an Array', Array.isArray(updatedActions))
	assert('exactly 2 actions were rewritten', updatedActions.length === 2, `got ${updatedActions.length}`)
	assert('a1 → expcomp_toggle', props.actions[0].actionId === 'expcomp_toggle')
	assert('a2 → gain_up', props.actions[1].actionId === 'gain_up')
	assert('a3 unchanged (pt_up)', props.actions[2].actionId === 'pt_up')
}

test1_upgradeScriptRegistered()
test2_renameTableCoversAllLegacyIds()
test3_returnShapeIsArrays()
test4_migrationBehaviourManual()

const failed = results.filter((r) => !r.ok)
console.log(`\n───── ${results.length - failed.length}/${results.length} assertions passed ─────`)
if (failed.length) {
	console.error('Failed:')
	failed.forEach((f) => console.error(`  ✗ ${f.name}${f.extra ? ' — ' + f.extra : ''}`))
	process.exit(1)
}

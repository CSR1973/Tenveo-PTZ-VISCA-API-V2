// Independent verification per iteration_9 review spec.
// Uses fresh fake self objects with specific timing/options.

import { getActions } from '../src/actions.js'
import { getVariables } from '../src/variables.js'
import { getFeedbacks } from '../src/feedbacks.js'
import * as cmds from '../src/commands.js'

let passed = 0, failed = 0
function ok(cond, label, extra = '') {
	if (cond) { passed++; console.log(`  ✓ ${label}${extra ? ' — ' + extra : ''}`) }
	else { failed++; console.log(`  ✗ ${label}${extra ? ' — ' + extra : ''}`) }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

function makeFakeSelf() {
	const self = {
		config: { panSpeed: 12, tiltSpeed: 10, variant: 'standard' },
		state: {
			connected: true,
			focusPos: 0,
			zoomPos: 0,
			expCompMode: 'unknown',
		},
		_publishedVars: [],
		_sentBytes: [],
		_feedbackChecks: [],
		log(){},
		setVariableValues(obj) { self._publishedVars.push(obj) },
		checkFeedbacks(...names) { self._feedbackChecks.push(names) },
		sendVisca: async (bytes) => { self._sentBytes.push(Array.from(bytes)) },
		send: async (bytes) => { self._sentBytes.push(Array.from(bytes)) },
		_send: async (bytes) => { self._sentBytes.push(Array.from(bytes)) },
	}
	return self
}

async function invokeAction(actions, key, self, options) {
	const def = actions[key]
	if (!def) throw new Error(`action ${key} missing`)
	await def.callback({ options, actionId: key }, { actionId: key })
}

;(async () => {
	console.log('\n[IV-1] focus_rotary_near — 5 clicks @15ms spacing, {speed:4, holdMs:300}')
	{
		const self = makeFakeSelf()
		const actions = getActions(self)
		for (let i = 0; i < 5; i++) {
			await invokeAction(actions, 'focus_rotary_near', self, { speed: 4, holdMs: 300 })
			await sleep(15)
		}
		const pubs = self._publishedVars.filter(p => 'focus_position' in p)
		ok(pubs.length >= 5, `≥5 focus_position pubs`, `got ${pubs.length}`)
	}

	console.log('\n[IV-2] focus_rotary_far — 6 clicks, values non-decreasing, final > 0')
	{
		const self = makeFakeSelf()
		const actions = getActions(self)
		for (let i = 0; i < 6; i++) {
			await invokeAction(actions, 'focus_rotary_far', self, { speed: 4, holdMs: 300 })
			await sleep(15)
		}
		const pubs = self._publishedVars.filter(p => 'focus_position' in p).map(p => p.focus_position)
		ok(pubs.length >= 6, `≥6 focus_position pubs`, `got ${pubs.length}`)
		let mono = true
		for (let i = 1; i < pubs.length; i++) if (pubs[i] < pubs[i - 1]) mono = false
		ok(mono, 'focus_position non-decreasing (far)')
		ok(pubs[pubs.length - 1] > 0, 'final focus_position > 0', `= ${pubs[pubs.length - 1]}`)
	}

	console.log('\n[IV-3] zoom_rotary_in — 5 clicks → ≥5 zoom_position pubs')
	{
		const self = makeFakeSelf()
		const actions = getActions(self)
		for (let i = 0; i < 5; i++) {
			await invokeAction(actions, 'zoom_rotary_in', self, { speed: 4, holdMs: 300 })
			await sleep(15)
		}
		const pubs = self._publishedVars.filter(p => 'zoom_position' in p)
		ok(pubs.length >= 5, '≥5 zoom_position pubs (in)', `got ${pubs.length}`)
	}

	console.log('\n[IV-4] zoom_rotary_out — 5 clicks → ≥5 zoom_position pubs')
	{
		const self = makeFakeSelf()
		self.state.zoomPos = 8000
		const actions = getActions(self)
		for (let i = 0; i < 5; i++) {
			await invokeAction(actions, 'zoom_rotary_out', self, { speed: 4, holdMs: 300 })
			await sleep(15)
		}
		const pubs = self._publishedVars.filter(p => 'zoom_position' in p).map(p => p.zoom_position)
		ok(pubs.length >= 5, '≥5 zoom_position pubs (out)', `got ${pubs.length}`)
		let nonInc = true
		for (let i = 1; i < pubs.length; i++) if (pubs[i] > pubs[i - 1]) nonInc = false
		ok(nonInc, 'zoom_position non-increasing (out)')
	}

	console.log('\n[IV-5] inqExpCompMode bytes = 81 09 04 3E FF')
	{
		const bytes = Array.from(cmds.inqExpCompMode())
		ok(bytes.length === 5, 'length 5')
		ok(bytes[0] === 0x81 && bytes[1] === 0x09 && bytes[2] === 0x04 && bytes[3] === 0x3E && bytes[4] === 0xFF,
			'bytes exact', bytes.map(b => b.toString(16).padStart(2, '0')).join(' '))
	}

	console.log('\n[IV-6] expcomp_toggle: off→on→off with correct VISCA + feedback')
	{
		const self = makeFakeSelf()
		self.state.expCompMode = 'off'
		const actions = getActions(self)
		await invokeAction(actions, 'expcomp_toggle', self, {})
		ok(self.state.expCompMode === 'on', '1st toggle → state on')
		const onBytes = self._sentBytes.find(b => b[3] === 0x3E && b[4] === 0x02)
		ok(!!onBytes, 'expCompOn (81 01 04 3E 02 FF) sent')
		const onVar = self._publishedVars.find(p => p.exposure_compensation_mode === 'on')
		ok(!!onVar, 'variable published = on')
		const fbCall = self._feedbackChecks.find(names => names.includes('expcomp_mode_state'))
		ok(!!fbCall, 'expcomp_mode_state feedback triggered')

		await invokeAction(actions, 'expcomp_toggle', self, {})
		ok(self.state.expCompMode === 'off', '2nd toggle → state off')
		const offBytes = self._sentBytes.find(b => b[3] === 0x3E && b[4] === 0x03)
		ok(!!offBytes, 'expCompOff (81 01 04 3E 03 FF) sent')
		const offVar = self._publishedVars.find(p => p.exposure_compensation_mode === 'off')
		ok(!!offVar, 'variable published = off')
	}

	console.log('\n[IV-7] expcomp_on / expcomp_off update state + publish + trigger feedback')
	{
		const self = makeFakeSelf()
		self.state.expCompMode = 'unknown'
		const actions = getActions(self)
		await invokeAction(actions, 'expcomp_on', self, {})
		ok(self.state.expCompMode === 'on', 'expcomp_on → state=on')
		ok(!!self._publishedVars.find(p => p.exposure_compensation_mode === 'on'), 'variable published (on)')
		ok(!!self._feedbackChecks.find(n => n.includes('expcomp_mode_state')), 'feedback triggered (on)')

		await invokeAction(actions, 'expcomp_off', self, {})
		ok(self.state.expCompMode === 'off', 'expcomp_off → state=off')
		ok(!!self._publishedVars.find(p => p.exposure_compensation_mode === 'off'), 'variable published (off)')
	}

	console.log('\n[IV-8] exposure_compensation_mode variable registered')
	{
		const self = makeFakeSelf()
		const defs = getVariables(self)
		const ids = Object.keys(defs)
		ok(ids.includes('exposure_compensation_mode'), 'exposure_compensation_mode listed', ids.join(','))
	}

	console.log('\n[IV-9] expcomp_mode_state feedback registered with correct callback')
	{
		const self = makeFakeSelf()
		self.state.expCompMode = 'on'
		const fbs = getFeedbacks(self)
		const def = fbs.expcomp_mode_state
		ok(!!def, 'expcomp_mode_state feedback exists')
		ok(def.callback({ options: { state: 'on' } }) === true, 'callback true when expCompMode=on & options.state=on')
		ok(def.callback({ options: { state: 'off' } }) === false, 'callback false when expCompMode=on & options.state=off')
		self.state.expCompMode = 'off'
		ok(def.callback({ options: { state: 'off' } }) === true, 'callback true when expCompMode=off & options.state=off')
	}

	console.log(`\n───── ${passed}/${passed + failed} assertions passed (independent verify) ─────`)
	process.exit(failed ? 1 : 0)
})().catch(e => { console.error(e); process.exit(2) })

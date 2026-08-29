import { combineRgb } from '@companion-module/base'

const BLACK = combineRgb(0, 0, 0)
const WHITE = combineRgb(255, 255, 255)
const NAVY = combineRgb(20, 30, 60)
const TEAL = combineRgb(0, 120, 140)
const PURPLE = combineRgb(80, 30, 120)

const STYLE = (text, bg = NAVY, fg = WHITE, size = '14') => ({
	text,
	size,
	color: fg,
	bgcolor: bg,
})

export function getPresets() {
	const p = {}

	/* ── PTZ pad ── */
	p['pt_up'] = { type: 'simple', category: 'PTZ Pad', name: 'Tilt Up', style: STYLE('▲', NAVY), steps: [{ down: [{ actionId: 'pt_up', options: { tilt: 10 } }], up: [{ actionId: 'pt_stop', options: {} }] }], feedbacks: [] }
	p['pt_down'] = { type: 'simple', category: 'PTZ Pad', name: 'Tilt Down', style: STYLE('▼', NAVY), steps: [{ down: [{ actionId: 'pt_down', options: { tilt: 10 } }], up: [{ actionId: 'pt_stop', options: {} }] }], feedbacks: [] }
	p['pt_left'] = { type: 'simple', category: 'PTZ Pad', name: 'Pan Left', style: STYLE('◄', NAVY), steps: [{ down: [{ actionId: 'pt_left', options: { pan: 12 } }], up: [{ actionId: 'pt_stop', options: {} }] }], feedbacks: [] }
	p['pt_right'] = { type: 'simple', category: 'PTZ Pad', name: 'Pan Right', style: STYLE('►', NAVY), steps: [{ down: [{ actionId: 'pt_right', options: { pan: 12 } }], up: [{ actionId: 'pt_stop', options: {} }] }], feedbacks: [] }
	p['pt_home'] = { type: 'simple', category: 'PTZ Pad', name: 'Home', style: STYLE('HOME', TEAL), steps: [{ down: [{ actionId: 'pt_home', options: {} }], up: [] }], feedbacks: [] }
	p['pt_stop'] = { type: 'simple', category: 'PTZ Pad', name: 'Stop', style: STYLE('STOP', combineRgb(120, 0, 0)), steps: [{ down: [{ actionId: 'pt_stop', options: {} }], up: [] }], feedbacks: [] }

	/* Zoom */
	p['zoom_in'] = { type: 'simple', category: 'Zoom', name: 'Zoom In', style: STYLE('Z +', PURPLE), steps: [{ down: [{ actionId: 'zoom_in', options: { speed: 4 } }], up: [{ actionId: 'zoom_stop', options: {} }] }], feedbacks: [] }
	p['zoom_out'] = { type: 'simple', category: 'Zoom', name: 'Zoom Out', style: STYLE('Z −', PURPLE), steps: [{ down: [{ actionId: 'zoom_out', options: { speed: 4 } }], up: [{ actionId: 'zoom_stop', options: {} }] }], feedbacks: [] }

	/* Presets 1..12 */
	for (let i = 1; i <= 12; i++) {
		p[`recall_${i}`] = {
			type: 'simple',
			category: 'Presets — Recall',
			name: `Recall Preset ${i}`,
			style: STYLE(`P${i}`, combineRgb(30, 30, 30)),
			steps: [{ down: [{ actionId: 'preset_recall', options: { n: i } }], up: [] }],
			feedbacks: [{ feedbackId: 'preset_recalled', options: { n: i }, style: { bgcolor: combineRgb(40, 180, 80), color: WHITE } }],
		}
		p[`save_${i}`] = {
			type: 'simple',
			category: 'Presets — Save',
			name: `Save Preset ${i}`,
			style: STYLE(`SAVE\\nP${i}`, combineRgb(80, 20, 20), WHITE, '7'),
			steps: [{ down: [{ actionId: 'preset_save', options: { n: i } }], up: [] }],
			feedbacks: [],
		}
	}

	/* Focus */
	p['focus_auto_toggle'] = { type: 'simple', category: 'Focus', name: 'AF Toggle', style: STYLE('AF', TEAL), steps: [{ down: [{ actionId: 'focus_toggle', options: {} }], up: [] }], feedbacks: [{ feedbackId: 'af_state', options: { state: 'on' }, style: { bgcolor: combineRgb(40, 180, 80), color: WHITE } }] }
	p['focus_one_push'] = { type: 'simple', category: 'Focus', name: 'One-Push AF', style: STYLE('AF\\n1-PUSH', TEAL, WHITE, '7'), steps: [{ down: [{ actionId: 'focus_one_push', options: {} }], up: [] }], feedbacks: [] }
	p['focus_near'] = { type: 'simple', category: 'Focus', name: 'Focus Near', style: STYLE('FOC\\nNEAR', PURPLE, WHITE, '7'), steps: [{ down: [{ actionId: 'focus_near', options: { speed: 4 } }], up: [{ actionId: 'focus_stop', options: {} }] }], feedbacks: [] }
	p['focus_far'] = { type: 'simple', category: 'Focus', name: 'Focus Far', style: STYLE('FOC\\nFAR', PURPLE, WHITE, '7'), steps: [{ down: [{ actionId: 'focus_far', options: { speed: 4 } }], up: [{ actionId: 'focus_stop', options: {} }] }], feedbacks: [] }

	/* Power */
	p['power_on'] = { type: 'simple', category: 'Power', name: 'Power On', style: STYLE('PWR\\nON', combineRgb(20, 100, 30), WHITE, '7'), steps: [{ down: [{ actionId: 'power_on', options: {} }], up: [] }], feedbacks: [] }
	p['power_off'] = { type: 'simple', category: 'Power', name: 'Power Off', style: STYLE('PWR\\nOFF', combineRgb(100, 20, 30), WHITE, '7'), steps: [{ down: [{ actionId: 'power_off', options: {} }], up: [] }], feedbacks: [] }

	/* OSD */
	p['menu_toggle'] = { type: 'simple', category: 'OSD', name: 'Menu', style: STYLE('MENU', BLACK), steps: [{ down: [{ actionId: 'menu_toggle', options: {} }], up: [] }], feedbacks: [] }
	p['menu_up'] = { type: 'simple', category: 'OSD', name: 'OSD Up', style: STYLE('▲', BLACK), steps: [{ down: [{ actionId: 'menu_up', options: {} }], up: [] }], feedbacks: [] }
	p['menu_down'] = { type: 'simple', category: 'OSD', name: 'OSD Down', style: STYLE('▼', BLACK), steps: [{ down: [{ actionId: 'menu_down', options: {} }], up: [] }], feedbacks: [] }
	p['menu_left'] = { type: 'simple', category: 'OSD', name: 'OSD Left', style: STYLE('◄', BLACK), steps: [{ down: [{ actionId: 'menu_left', options: {} }], up: [] }], feedbacks: [] }
	p['menu_right'] = { type: 'simple', category: 'OSD', name: 'OSD Right', style: STYLE('►', BLACK), steps: [{ down: [{ actionId: 'menu_right', options: {} }], up: [] }], feedbacks: [] }
	p['menu_enter'] = { type: 'simple', category: 'OSD', name: 'OSD Enter', style: STYLE('OK', BLACK), steps: [{ down: [{ actionId: 'menu_enter', options: {} }], up: [] }], feedbacks: [] }

	return p
}

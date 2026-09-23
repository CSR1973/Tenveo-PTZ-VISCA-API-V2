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

/**
 * Companion 5.x API v2 requires `setPresetDefinitions(structure, presets)`:
 *  - `presets`   : { [presetId]: PresetDefinition }   (no `category` field on the preset)
 *  - `structure` : Section[]  each section groups preset IDs under a display name
 * Returning `{ structure, presets }` here so main.js can spread the two args.
 */
export function getPresets() {
        const presets = {}
        // sectionId -> { id, name, presets: [presetId, ...] }
        const sectionMap = {}

        const add = (id, category, def) => {
                presets[id] = def
                const secId = category.replace(/\s+/g, '_').toLowerCase()
                if (!sectionMap[secId]) {
                        sectionMap[secId] = { id: secId, name: category, type: 'simple', presets: [] }
                }
                sectionMap[secId].presets.push(id)
        }

        /* ── PTZ pad ── */
        add('pt_up', 'PTZ Pad', { type: 'simple', name: 'Tilt Up', style: STYLE('▲', NAVY), steps: [{ down: [{ actionId: 'pt_up', options: { tilt: 10 } }], up: [{ actionId: 'pt_stop', options: {} }] }], feedbacks: [] })
        add('pt_down', 'PTZ Pad', { type: 'simple', name: 'Tilt Down', style: STYLE('▼', NAVY), steps: [{ down: [{ actionId: 'pt_down', options: { tilt: 10 } }], up: [{ actionId: 'pt_stop', options: {} }] }], feedbacks: [] })
        add('pt_left', 'PTZ Pad', { type: 'simple', name: 'Pan Left', style: STYLE('◄', NAVY), steps: [{ down: [{ actionId: 'pt_left', options: { pan: 12 } }], up: [{ actionId: 'pt_stop', options: {} }] }], feedbacks: [] })
        add('pt_right', 'PTZ Pad', { type: 'simple', name: 'Pan Right', style: STYLE('►', NAVY), steps: [{ down: [{ actionId: 'pt_right', options: { pan: 12 } }], up: [{ actionId: 'pt_stop', options: {} }] }], feedbacks: [] })
        add('pt_home', 'PTZ Pad', { type: 'simple', name: 'Home', style: STYLE('HOME', TEAL), steps: [{ down: [{ actionId: 'pt_home', options: {} }], up: [] }], feedbacks: [] })
        add('pt_stop', 'PTZ Pad', { type: 'simple', name: 'Stop', style: STYLE('STOP', combineRgb(120, 0, 0)), steps: [{ down: [{ actionId: 'pt_stop', options: {} }], up: [] }], feedbacks: [] })

        /* Zoom */
        add('zoom_in', 'Zoom', { type: 'simple', name: 'Zoom In', style: STYLE('Z +', PURPLE), steps: [{ down: [{ actionId: 'zoom_in', options: { speed: 4 } }], up: [{ actionId: 'zoom_stop', options: {} }] }], feedbacks: [] })
        add('zoom_out', 'Zoom', { type: 'simple', name: 'Zoom Out', style: STYLE('Z −', PURPLE), steps: [{ down: [{ actionId: 'zoom_out', options: { speed: 4 } }], up: [{ actionId: 'zoom_stop', options: {} }] }], feedbacks: [] })

        /* Presets 1..12 */
        for (let i = 1; i <= 12; i++) {
                add(`recall_${i}`, 'Presets — Recall', {
                        type: 'simple',
                        name: `Recall Preset ${i}`,
                        style: STYLE(`P${i}`, combineRgb(30, 30, 30)),
                        steps: [{ down: [{ actionId: 'preset_recall', options: { n: i } }], up: [] }],
                        feedbacks: [{ feedbackId: 'preset_recalled', options: { n: i }, style: { bgcolor: combineRgb(40, 180, 80), color: WHITE } }],
                })
                add(`save_${i}`, 'Presets — Save', {
                        type: 'simple',
                        name: `Save Preset ${i}`,
                        style: STYLE(`SAVE\\nP${i}`, combineRgb(80, 20, 20), WHITE, '7'),
                        steps: [{ down: [{ actionId: 'preset_save', options: { n: i } }], up: [] }],
                        feedbacks: [],
                })
        }

        /* Focus */
        add('focus_auto_toggle', 'Focus', { type: 'simple', name: 'AF Toggle', style: STYLE('AF', TEAL), steps: [{ down: [{ actionId: 'focus_toggle', options: {} }], up: [] }], feedbacks: [{ feedbackId: 'af_state', options: { state: 'on' }, style: { bgcolor: combineRgb(40, 180, 80), color: WHITE } }] })
        add('focus_one_push', 'Focus', { type: 'simple', name: 'One-Push AF', style: STYLE('AF\\n1-PUSH', TEAL, WHITE, '7'), steps: [{ down: [{ actionId: 'focus_one_push', options: {} }], up: [] }], feedbacks: [] })
        add('focus_near', 'Focus', { type: 'simple', name: 'Focus Near', style: STYLE('FOC\\nNEAR', PURPLE, WHITE, '7'), steps: [{ down: [{ actionId: 'focus_near', options: { speed: 4 } }], up: [{ actionId: 'focus_stop', options: {} }] }], feedbacks: [] })
        add('focus_far', 'Focus', { type: 'simple', name: 'Focus Far', style: STYLE('FOC\\nFAR', PURPLE, WHITE, '7'), steps: [{ down: [{ actionId: 'focus_far', options: { speed: 4 } }], up: [{ actionId: 'focus_stop', options: {} }] }], feedbacks: [] })

        /* Power */
        add('power_on', 'Power', { type: 'simple', name: 'Power On', style: STYLE('PWR\\nON', combineRgb(20, 100, 30), WHITE, '7'), steps: [{ down: [{ actionId: 'power_on', options: {} }], up: [] }], feedbacks: [] })
        add('power_off', 'Power', { type: 'simple', name: 'Power Off', style: STYLE('PWR\\nOFF', combineRgb(100, 20, 30), WHITE, '7'), steps: [{ down: [{ actionId: 'power_off', options: {} }], up: [] }], feedbacks: [] })

        /* OSD */
        add('menu_toggle', 'OSD', { type: 'simple', name: 'Menu', style: STYLE('MENU', BLACK), steps: [{ down: [{ actionId: 'menu_toggle', options: {} }], up: [] }], feedbacks: [] })
        add('menu_up', 'OSD', { type: 'simple', name: 'OSD Up', style: STYLE('▲', BLACK), steps: [{ down: [{ actionId: 'menu_up', options: {} }], up: [] }], feedbacks: [] })
        add('menu_down', 'OSD', { type: 'simple', name: 'OSD Down', style: STYLE('▼', BLACK), steps: [{ down: [{ actionId: 'menu_down', options: {} }], up: [] }], feedbacks: [] })
        add('menu_left', 'OSD', { type: 'simple', name: 'OSD Left', style: STYLE('◄', BLACK), steps: [{ down: [{ actionId: 'menu_left', options: {} }], up: [] }], feedbacks: [] })
        add('menu_right', 'OSD', { type: 'simple', name: 'OSD Right', style: STYLE('►', BLACK), steps: [{ down: [{ actionId: 'menu_right', options: {} }], up: [] }], feedbacks: [] })
        add('menu_enter', 'OSD', { type: 'simple', name: 'OSD Enter', style: STYLE('OK', BLACK), steps: [{ down: [{ actionId: 'menu_enter', options: {} }], up: [] }], feedbacks: [] })

        // Build the section structure array in the order sections were first added.
        const structure = Object.values(sectionMap).map((s) => ({
                id: s.id,
                name: s.name,
                definitions: s.presets,
        }))

        return { structure, presets }
}

/**
 * v2.0.2 regression test — getPresets() MUST return { structure, presets }
 * where `structure` is a CompanionPresetSection[] and `presets` is a
 * plain object keyed by preset id.
 *
 * The old API v1 shape (returning a bare `{ [id]: preset }` object) makes
 * Companion 5.x's @companion-module/base 2.x host throw:
 *     TypeError: Cannot convert undefined or null to object
 *     at sanitisePresetDefinitions (host/src/internal/presets.ts:336)
 * because the new signature is setPresetDefinitions(structure, presets)
 * and passing only one arg leaves `presets` = undefined.
 */
import { getPresets } from '../src/presets.js'

const results = []
function assert(name, cond, extra = '') {
        results.push({ name, ok: !!cond, extra })
        if (cond) console.log(`  \u2713 ${name}${extra ? ' — ' + extra : ''}`)
        else console.error(`  \u2717 ${name}${extra ? ' — ' + extra : ''}`)
}

function test1_returnsStructureAndPresetsPair() {
        console.log('\n[TEST 1] getPresets() returns { structure, presets } (API v2 two-arg call)')
        const r = getPresets()
        assert('return value is a plain object', typeof r === 'object' && r !== null && !Array.isArray(r))
        assert('has `structure` array', Array.isArray(r.structure))
        assert('has `presets` object (not array)',
                r.presets && typeof r.presets === 'object' && !Array.isArray(r.presets))
        assert('structure has at least one section', r.structure.length > 0)
        assert('presets has at least one entry', Object.keys(r.presets).length > 0)
}

function test2_sectionShape() {
        console.log('\n[TEST 2] Every section has { id, name, definitions: string[] }')
        const { structure, presets } = getPresets()
        for (const s of structure) {
                assert(`section ${s.id}: id is string`, typeof s.id === 'string' && s.id.length > 0)
                assert(`section ${s.id}: name is string`, typeof s.name === 'string' && s.name.length > 0)
                assert(`section ${s.id}: definitions is array`, Array.isArray(s.definitions))
                for (const ref of s.definitions) {
                        assert(`section ${s.id}: ref "${ref}" is a string`, typeof ref === 'string')
                        assert(`section ${s.id}: ref "${ref}" resolves in presets map`,
                                Object.prototype.hasOwnProperty.call(presets, ref))
                }
        }
}

function test3_noCategoryFieldOnPresets() {
        console.log('\n[TEST 3] Individual presets carry NO `category` field (moved to sections)')
        const { presets } = getPresets()
        for (const [id, p] of Object.entries(presets)) {
                assert(`${id} has no legacy 'category' field`, !('category' in p))
        }
}

function test4_presetHasRequiredFields() {
        console.log('\n[TEST 4] Every preset has { type: "simple", name, style, steps[], feedbacks[] }')
        const { presets } = getPresets()
        for (const [id, p] of Object.entries(presets)) {
                assert(`${id}: type === 'simple'`, p.type === 'simple')
                assert(`${id}: name is string`, typeof p.name === 'string' && p.name.length > 0)
                assert(`${id}: style is object`, p.style && typeof p.style === 'object')
                assert(`${id}: steps is array`, Array.isArray(p.steps))
                assert(`${id}: feedbacks is array`, Array.isArray(p.feedbacks))
        }
}

function test5_reproduceHostSanitiseCall() {
        console.log('\n[TEST 5] Reproduces sanitisePresetDefinitions() — Object.entries(presets) must not throw')
        const { structure, presets } = getPresets()
        let threw = null
        try {
                // This is exactly what host sanitisePresetDefinitions does at line 336
                for (const _entry of Object.entries(presets)) { /* noop */ }
                for (const _section of structure) {
                        if (!Array.isArray(_section.definitions)) throw new Error('section.definitions must be array')
                }
        } catch (e) {
                threw = e
                console.error('  ✗', e.message)
        }
        assert('Companion 5.x host would accept this shape', threw === null)
}

test1_returnsStructureAndPresetsPair()
test2_sectionShape()
test3_noCategoryFieldOnPresets()
test4_presetHasRequiredFields()
test5_reproduceHostSanitiseCall()

const failed = results.filter((r) => !r.ok)
const total = results.length
console.log(`\n───── ${total - failed.length}/${total} assertions passed ─────`)
if (failed.length) {
        console.error('Failed:')
        failed.forEach((f) => console.error(`  ✗ ${f.name}${f.extra ? ' — ' + f.extra : ''}`))
        process.exit(1)
}

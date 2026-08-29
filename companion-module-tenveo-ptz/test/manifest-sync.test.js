/**
 * v1.11.1 tests — manifest.json sync guarantee.
 *
 * Root cause of "new variables don't show in Companion after reinstall":
 * companion/manifest.json had a stale version ("1.3.2") that didn't update between builds.
 * Companion reads the manifest version and — when it hasn't changed — will not refresh
 * variable / action / feedback definitions for that connection. The `npm run build` script
 * now auto-syncs the manifest version from package.json before packaging.
 *
 * Verifies:
 *   1. companion/manifest.json and package.json have the same version string.
 *   2. Both are semver-ish (1.11.x or newer — no lingering "1.3.2").
 *   3. The bundled tarball's pkg/companion/manifest.json contains the same version.
 *   4. All new variable IDs (exposure_compensation, iris_fstop, focus_percent, zoom_percent,
 *      backlight) are present as string literals in the bundled pkg/main.js.
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

const results = []
function assert(name, cond, extra = '') {
	results.push({ name, ok: !!cond, extra })
	if (cond) console.log(`  \u2713 ${name}${extra ? ' — ' + extra : ''}`)
	else console.error(`  \u2717 ${name}${extra ? ' — ' + extra : ''}`)
}

async function test1_manifestMatchesPackage() {
	console.log('\n[TEST 1] manifest.json version matches package.json')
	const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
	const mani = JSON.parse(fs.readFileSync(path.join(ROOT, 'companion/manifest.json'), 'utf8'))
	assert('package.json.version present', typeof pkg.version === 'string' && pkg.version.length > 0)
	assert('manifest.json.version present', typeof mani.version === 'string' && mani.version.length > 0)
	assert(`versions match (${pkg.version} === ${mani.version})`, pkg.version === mani.version, `pkg=${pkg.version}, manifest=${mani.version}`)
	assert('version is NOT the stale 1.3.2', pkg.version !== '1.3.2', `got ${pkg.version}`)
	assert('version is ≥ 1.11.1', compareSemver(pkg.version, '1.11.1') >= 0, `got ${pkg.version}`)
}

function compareSemver(a, b) {
	const [aM, am, ap] = a.split('.').map((x) => parseInt(x, 10))
	const [bM, bm, bp] = b.split('.').map((x) => parseInt(x, 10))
	return aM - bM || am - bm || ap - bp
}

async function test2_syncManifestScriptExists() {
	console.log('\n[TEST 2] build script auto-syncs manifest version from package.json')
	const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
	assert('scripts.sync-manifest exists', typeof pkg.scripts?.['sync-manifest'] === 'string')
	assert('scripts.build calls sync-manifest first', /sync-manifest/.test(pkg.scripts?.build || ''), `got: ${pkg.scripts?.build}`)
}

async function test3_syncManifestExecutable() {
	console.log('\n[TEST 3] sync-manifest script runs cleanly and updates the file')
	// Temporarily set manifest to a bogus version
	const maniPath = path.join(ROOT, 'companion/manifest.json')
	const original = fs.readFileSync(maniPath, 'utf8')
	const pkgVer = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version
	try {
		const tampered = JSON.parse(original)
		tampered.version = '9.9.9-tamper'
		fs.writeFileSync(maniPath, JSON.stringify(tampered, null, '\t') + '\n')
		// Run the sync script
		execSync('npm run sync-manifest --silent', { cwd: ROOT })
		const after = JSON.parse(fs.readFileSync(maniPath, 'utf8'))
		assert(`sync restored manifest.version to ${pkgVer}`, after.version === pkgVer, `got ${after.version}`)
	} finally {
		fs.writeFileSync(maniPath, original)
	}
}

async function test4_builtTarballHasCorrectManifest() {
	console.log('\n[TEST 4] Built .tgz contains manifest with correct version + new variable IDs in main.js')
	const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
	const tgz = path.join(ROOT, `tenveo-ptz-${pkg.version}.tgz`)
	assert(`tarball ${path.basename(tgz)} exists`, fs.existsSync(tgz))
	if (!fs.existsSync(tgz)) return

	// Extract in a temp folder
	const tmp = path.join(ROOT, `.tmp-verify-${Date.now()}`)
	fs.mkdirSync(tmp, { recursive: true })
	try {
		execSync(`tar -xzf "${tgz}" -C "${tmp}"`)
		// @companion-module/tools 3.x uses the manifest id ('tenveo-ptz') as
		// the tarball's top-level folder instead of the legacy 'pkg/'.
		const maniPath = path.join(tmp, 'tenveo-ptz/companion/manifest.json')
		const mainJs = path.join(tmp, 'tenveo-ptz/main.js')
		assert('tenveo-ptz/companion/manifest.json exists in tarball', fs.existsSync(maniPath))
		assert('tenveo-ptz/main.js exists in tarball', fs.existsSync(mainJs))
		if (fs.existsSync(maniPath)) {
			const mani = JSON.parse(fs.readFileSync(maniPath, 'utf8'))
			assert(`tarball manifest version = ${pkg.version}`, mani.version === pkg.version, `got ${mani.version}`)
		}
		if (fs.existsSync(mainJs)) {
			const body = fs.readFileSync(mainJs, 'utf8')
			for (const id of ['exposure_compensation', 'iris_fstop', 'focus_percent', 'zoom_percent', 'backlight', 'pan_degrees', 'tilt_degrees']) {
				assert(`bundled main.js contains "${id}" string literal`, body.includes(id))
			}
		}
	} finally {
		execSync(`rm -rf "${tmp}"`)
	}
}

async function test5_noStaleReferences() {
	console.log('\n[TEST 5] no lingering 1.3.2 in tracked files')
	const pkgVer = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version
	assert(`package.json version = ${pkgVer}, not 1.3.2`, pkgVer !== '1.3.2')
	const mani = JSON.parse(fs.readFileSync(path.join(ROOT, 'companion/manifest.json'), 'utf8'))
	assert('manifest.json version not 1.3.2', mani.version !== '1.3.2')
}

async function run() {
	await test1_manifestMatchesPackage()
	await test2_syncManifestScriptExists()
	await test3_syncManifestExecutable()
	await test4_builtTarballHasCorrectManifest()
	await test5_noStaleReferences()

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

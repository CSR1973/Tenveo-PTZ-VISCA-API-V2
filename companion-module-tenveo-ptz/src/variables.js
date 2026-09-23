/** Companion API v2 variable definitions.
 *  Shape: `{ variableId: { name: 'friendly description' }, … }`
 *  (v1's array-of-`{variableId,name}` is rejected in @companion-module/base 2.x
 *  with "Variable definitions should be an object, not an array".) */
export function getVariables() {
	return {
		camera_name: { name: 'Camera friendly name' },
		host: { name: 'Camera IP address' },
		connected: { name: 'Connected (true/false)' },
		onvif_ready: { name: 'ONVIF ready (true/false) — needed for presets' },
		last_preset: { name: 'Last recalled preset' },
		power: { name: 'Power state (on/off)' },
		af: { name: 'Auto-focus state (on/off)' },
		exposure_mode: { name: 'Exposure mode name' },
		wb_mode: { name: 'White-balance mode name' },
		gain: { name: 'Gain value' },
		iris: { name: 'Iris raw index (0-13)' },
		iris_fstop: { name: 'Iris f-stop label (Off, f1.6...f32.0)' },
		shutter: { name: 'Shutter value' },
		exposure_compensation: { name: 'Exposure Compensation (-7 to +7, 0 = neutral)' },
		exposure_compensation_mode: { name: 'Exposure Compensation Mode (on = Manual, off = Auto)' },
		zoom_position: { name: 'Zoom position (0-16384)' },
		zoom_percent: { name: 'Zoom position as percent (0=wide, 100=tele)' },
		focus_position: { name: 'Focus position (0-16384)' },
		focus_percent: { name: 'Focus position as percent (0=near, 100=far)' },
		focus_mode: { name: 'Focus mode (Auto / Manual / One-Push / Locked)' },
		backlight: { name: 'Backlight compensation (on/off)' },
		pan_position: { name: 'Pan position (raw VISCA units)' },
		tilt_position: { name: 'Tilt position (raw VISCA units)' },
		pan_degrees: { name: 'Pan position in degrees (Home = 0°)' },
		tilt_degrees: { name: 'Tilt position in degrees (Home = 0°)' },
		color_temp: { name: 'Current color temperature (K)' },
		warmth: { name: 'Warmth offset (-64 cool ↔ +64 warm, 0 neutral)' },
		preset_save_index: { name: 'Save-rotary current preset index (turn to scroll, push to save)' },
		preset_recall_index: { name: 'Recall-rotary current preset index (turn to scroll, push to recall)' },
		image_flip: { name: 'Image Flip state (on = upside-down, off = normal)' },
		image_mirror: { name: 'Image Mirror state (on = LR reversed, off = normal)' },
	}
}

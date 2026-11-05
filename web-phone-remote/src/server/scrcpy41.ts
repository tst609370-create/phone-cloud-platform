/**
 * Control types implemented by vanilla scrcpy 4.1 ControlMessageReader.
 * 101 and 102 are this project's extensions. Sending them makes 4.1 throw
 * "Unknown event type" and stop the control thread.
 */
const VANILLA_SCRCPY_41_CONTROL_TYPES = new Set([
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22,
]);

export function acceptScrcpy41Control(payload: Uint8Array): boolean {
    if (payload.length < 1) return false;
    return VANILLA_SCRCPY_41_CONTROL_TYPES.has(payload[0]!);
}

/** Option keys accepted by scrcpy 4.1 Options.parse. Unknown keys are only warnings, but removed keys must not be sent. */
export const SCRCPY_41_OPTION_KEYS = [
    'scid',
    'log_level',
    'video',
    'audio',
    'video_codec',
    'audio_codec',
    'video_source',
    'audio_source',
    'audio_dup',
    'max_size',
    'min_size_alignment',
    'video_bit_rate',
    'audio_bit_rate',
    'max_fps',
    'angle',
    'tunnel_forward',
    'crop',
    'control',
    'display_id',
    'show_touches',
    'stay_awake',
    'screen_off_timeout',
    'video_codec_options',
    'audio_codec_options',
    'video_encoder',
    'audio_encoder',
    'power_off_on_close',
    'clipboard_autosync',
    'downsize_on_error',
    'cleanup',
    'power_on',
    'list_encoders',
    'list_displays',
    'list_cameras',
    'list_camera_sizes',
    'list_apps',
    'camera_id',
    'camera_size',
    'camera_facing',
    'camera_ar',
    'camera_zoom',
    'camera_fps',
    'camera_high_speed',
    'camera_torch',
    'new_display',
    'vd_destroy_content',
    'vd_system_decorations',
    'flex_display',
    'capture_orientation',
    'display_ime_policy',
    'keep_active',
    'ignore_video_encoder_constraints',
    'send_device_meta',
    'send_frame_meta',
    'send_dummy_byte',
    'send_stream_meta',
    'raw_stream',
] as const;

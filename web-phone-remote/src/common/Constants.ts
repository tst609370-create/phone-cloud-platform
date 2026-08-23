// src/common/Constants.ts
export const SERVER_PACKAGE = 'com.genymobile.scrcpy.Server';
export const SERVER_VERSION = '3.3.4';
export const SERVER_PROCESS_NAME = 'app_process';
export const DEVICE_SERVER_PATH = '/data/local/tmp/scrcpy-server.jar';

// Sentinel passed to the device-side scrcpy server's `remote=tcp:<port>` adb-forward
// argument. `0` means "let the server pick a port"; the actual port is reported back
// over the control socket. Used by DeviceTracker + StreamClientScrcpy.
export const SERVER_PORT = 0;

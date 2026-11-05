import { describe, expect, it } from 'vitest';
import {
    isBridgeInstalled,
    isRootId,
    parseForwardPort,
    parseShellProbe,
    probeMicFacts,
    resolveVirtualMicJar,
    selectMicRoute,
    shellMicCommand,
} from '../route';

describe('mic route selection', () => {
    it('prefers the LSPosed bridge and keeps shell as a fallback', () => {
        const plan = selectMicRoute({
            sdkInt: 34,
            rooted: true,
            bridgeInstalled: true,
            shellDexPresent: true,
            shellVerified: 'unknown',
        });
        expect(plan.supported).toBe(true);
        expect(plan.routes).toEqual(['lsposed', 'shell']);
        expect(plan.reason).toContain('LSPosed');
    });

    it('offers shell injection on Android 13+ when the jar is present', () => {
        const plan = selectMicRoute({
            sdkInt: 33,
            rooted: false,
            bridgeInstalled: false,
            shellDexPresent: true,
            shellVerified: 'unknown',
        });
        expect(plan.routes).toEqual(['shell']);
        expect(plan.supported).toBe(true);
    });

    it('explains why a non-root phone below Android 13 cannot inject', () => {
        const plan = selectMicRoute({
            sdkInt: 28,
            rooted: false,
            bridgeInstalled: false,
            shellDexPresent: true,
            shellVerified: 'unknown',
        });
        expect(plan.supported).toBe(false);
        expect(plan.routes).toEqual([]);
        expect(plan.reason).toContain('未安装虚拟麦克风模块');
        expect(plan.reason).toContain('低于 13');
    });

    it('stays unavailable after shell registration was refused and no module is installed', () => {
        const plan = selectMicRoute({
            sdkInt: 34,
            rooted: false,
            bridgeInstalled: false,
            shellDexPresent: true,
            shellVerified: false,
        });
        expect(plan.supported).toBe(false);
        expect(plan.reason).toContain('shell 音频策略注册失败');
    });

    it('does not offer shell injection when the jar is missing', () => {
        const plan = selectMicRoute({
            sdkInt: 34,
            rooted: false,
            bridgeInstalled: false,
            shellDexPresent: false,
            shellVerified: 'unknown',
        });
        expect(plan.routes).toEqual([]);
        expect(plan.reason).toContain('缺少 shell 注入组件');
    });
});

describe('mic probe parsers', () => {
    it('recognizes root, the bridge package, and shell status lines', () => {
        expect(isRootId('uid=0(root) gid=0(root)')).toBe(true);
        expect(isRootId('uid=2000(shell)')).toBe(false);
        expect(isBridgeInstalled('package:/data/app/com.wsphone.virtualmic/base.apk')).toBe(true);
        expect(isBridgeInstalled('Error: package not found')).toBe(false);
        expect(parseShellProbe('noise\nSHELL_MIC_OK\n').ok).toBe(true);
        expect(parseShellProbe('SHELL_MIC_READY').ready).toBe(true);
        expect(parseShellProbe('SHELL_MIC_NO:registerAudioPolicy=null').reason).toContain('registerAudioPolicy');
        expect(parseForwardPort('34567\n')).toBe(34567);
        expect(() => parseForwardPort('not a port')).toThrow(/端口/);
    });

    it('builds a shell command that does not interpolate the serial', () => {
        expect(shellMicCommand('probe')).toBe(
            'CLASSPATH=/data/local/tmp/ws-virtual-mic.jar app_process / com.wsphone.shellmic.ShellMicMain probe',
        );
        expect(shellMicCommand('serve')).toContain('ShellMicMain serve');
    });

    it('reads sdk, root, and the bridge package from adb', async () => {
        const facts = await probeMicFacts(
            {
                shell: async (_serial, command) => {
                    if (command.startsWith('su ')) return 'uid=0(root)';
                    if (command === 'id') return 'uid=2000(shell)';
                    if (command.startsWith('pm path')) return 'package:/data/app/com.wsphone.virtualmic/base.apk';
                    if (command.startsWith('getprop')) return '34';
                    throw new Error(command);
                },
            },
            'SERIAL',
            true,
            0,
        );
        expect(facts).toMatchObject({ sdkInt: 34, rooted: true, bridgeInstalled: true, shellDexPresent: true });
    });

    it('treats a missing su as not rooted', async () => {
        const facts = await probeMicFacts(
            {
                shell: async (_serial, command) => {
                    if (command.startsWith('su ') || command === 'id') throw new Error('not found');
                    if (command.startsWith('pm path')) throw new Error('not found');
                    return '30';
                },
            },
            'SERIAL',
            false,
            0,
        );
        expect(facts.rooted).toBe(false);
        expect(facts.bridgeInstalled).toBe(false);
        expect(facts.sdkInt).toBe(30);
    });
});

describe('resolveVirtualMicJar', () => {
    it('returns the first candidate that exists', () => {
        expect(resolveVirtualMicJar(() => false)).toBeUndefined();
        const found = resolveVirtualMicJar((file) => file.endsWith('virtual-mic.jar'));
        expect(found?.endsWith('virtual-mic.jar')).toBe(true);
    });
});

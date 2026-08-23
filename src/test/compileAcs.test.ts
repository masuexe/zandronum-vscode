import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import { resolveAccExecutablePath } from '../tools/compileAcs';

suite('ACC executable path', () => {
    const workspaceRoot = path.join(path.sep, 'workspace', 'mod');

    test('keeps the PATH command unchanged', () => {
        assert.strictEqual(resolveAccExecutablePath('acc', workspaceRoot), 'acc');
    });

    test('expands a home-relative path', () => {
        assert.strictEqual(
            resolveAccExecutablePath('~/appfiles/acc/acc', workspaceRoot),
            path.join(os.homedir(), 'appfiles', 'acc', 'acc')
        );
    });

    test('keeps an absolute path unchanged', () => {
        const absolute = path.join(path.sep, 'opt', 'acc', 'acc');
        assert.strictEqual(resolveAccExecutablePath(absolute, workspaceRoot), absolute);
    });

    test('resolves a relative path from the workspace', () => {
        assert.strictEqual(
            resolveAccExecutablePath('tools/acc', workspaceRoot),
            path.join(workspaceRoot, 'tools', 'acc')
        );
    });
});

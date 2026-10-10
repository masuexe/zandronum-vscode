import { defineConfig } from '@vscode/test-cli';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export default defineConfig({
	files: 'out/test/**/*.test.js',
	workspaceFolder: mkdtempSync(join(tmpdir(), 'zandronum-vscode-tests-')),
	mocha: { timeout: 15000 },
});

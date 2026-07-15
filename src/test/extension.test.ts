import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Extension Test Suite', () => {
	test('registers primary project workflow commands', async () => {
		const ext = vscode.extensions.all.find(
			(e) => e.packageJSON?.name === 'zandronum-vscode'
		);
		assert.ok(ext, 'zandronum-vscode extension should be present');
		await ext.activate();

		const commands = await vscode.commands.getCommands(true);
		for (const id of [
			'acs.compile',
			'zandronum.buildProject',
			'zandronum.runProject',
		]) {
			assert.ok(commands.includes(id), `missing primary command: ${id}`);
		}
	});

	test('keeps legacy build/run aliases registered', async () => {
		const commands = await vscode.commands.getCommands(true);
		for (const id of [
			'decorate.buildPK3',
			'acs.compileAllAndBuild',
			'acs.compileCurrentAndBuild',
			'zandronum.run',
			'zandronum.buildAndRun',
			'acs.compileAllBuildAndRun',
		]) {
			assert.ok(commands.includes(id), `missing legacy command: ${id}`);
		}
	});
});

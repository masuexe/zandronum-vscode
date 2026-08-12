import * as assert from 'assert';
import { resolveCompound, type RunConfig, type RunCompound } from '../run/launchProvider';

const configs: RunConfig[] = [
	{ name: 'Host local', postArgs: ['-host'] },
	{ name: 'Join local', postArgs: ['-connect', '127.0.0.1:10666'] },
	{ name: 'Offline', postArgs: ['+map', 'MAP01'] },
];

suite('resolveCompound', () => {
	test('resolves host then client by name', () => {
		const compound: RunCompound = {
			name: 'Local net test',
			configurations: ['Host local', 'Join local'],
		};
		const result = resolveCompound(compound, configs);
		assert.strictEqual(result.ok, true);
		if (!result.ok) { return; }
		assert.strictEqual(result.host.name, 'Host local');
		assert.strictEqual(result.client.name, 'Join local');
	});

	test('rejects wrong count', () => {
		const one = resolveCompound({ name: 'bad', configurations: ['Host local'] }, configs);
		assert.strictEqual(one.ok, false);
		if (one.ok) { return; }
		assert.ok(one.error.includes('exactly 2'));

		const three = resolveCompound(
			{ name: 'bad', configurations: ['Host local', 'Join local', 'Offline'] },
			configs
		);
		assert.strictEqual(three.ok, false);
	});

	test('rejects missing configuration names', () => {
		const missingHost = resolveCompound(
			{ name: 'Local', configurations: ['No Host', 'Join local'] },
			configs
		);
		assert.strictEqual(missingHost.ok, false);
		if (missingHost.ok) { return; }
		assert.ok(missingHost.error.includes('No Host'));

		const missingClient = resolveCompound(
			{ name: 'Local', configurations: ['Host local', 'No Client'] },
			configs
		);
		assert.strictEqual(missingClient.ok, false);
		if (missingClient.ok) { return; }
		assert.ok(missingClient.error.includes('No Client'));
	});
});

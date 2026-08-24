import * as assert from 'assert';
import {
	buildRunArguments,
	convertWslPathArguments,
	isWindowsAbsolutePath,
	isWslWindowsExecutable,
	resolveCompound,
	resolvePlatformRunConfig,
	type RunConfig,
	type RunCompound,
} from '../run/launchProvider';

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

suite('platform launch configuration', () => {
	const config: RunConfig = {
		name: 'Cross-platform',
		program: 'zandronum',
		preArgs: ['-iwad', 'shared.wad'],
		postArgs: ['+map', 'MAP01'],
		windows: {
			program: 'D:/Games/Zandronum/zandronum.exe',
			preArgs: ['-iwad', 'D:/Games/Doom 2/doom2.wad'],
		},
		linux: {
			program: '/opt/zandronum/zandronum',
			preArgs: ['-iwad', '/mnt/d/Games/Doom 2/doom2.wad'],
		},
	};

	test('selects Windows fields and inherits omitted fields', () => {
		const resolved = resolvePlatformRunConfig(config, 'win32');
		assert.strictEqual(resolved.program, 'D:/Games/Zandronum/zandronum.exe');
		assert.deepStrictEqual(resolved.preArgs, ['-iwad', 'D:/Games/Doom 2/doom2.wad']);
		assert.deepStrictEqual(resolved.postArgs, ['+map', 'MAP01']);
	});

	test('selects Linux fields and keeps legacy configs unchanged', () => {
		const resolved = resolvePlatformRunConfig(config, 'linux');
		assert.strictEqual(resolved.program, '/opt/zandronum/zandronum');
		assert.deepStrictEqual(resolved.preArgs, ['-iwad', '/mnt/d/Games/Doom 2/doom2.wad']);

		const legacy: RunConfig = { name: 'Legacy', program: 'zandronum' };
		assert.strictEqual(resolvePlatformRunConfig(legacy, 'linux'), legacy);
	});

	test('builds an argv array without shell quoting', () => {
		assert.deepStrictEqual(
			buildRunArguments(
				['-iwad', '/mnt/d/Games/Doom 2/doom2.wad'],
				['+map', 'MAP01'],
				'/home/user/My Mod/out/build.pk3'
			),
			[
				'-iwad', '/mnt/d/Games/Doom 2/doom2.wad',
				'-file', '/home/user/My Mod/out/build.pk3',
				'+map', 'MAP01',
			]
		);
	});

	test('recognizes Windows absolute program paths', () => {
		assert.strictEqual(isWindowsAbsolutePath('D:\\Games\\Zandronum\\zandronum.exe'), true);
		assert.strictEqual(isWindowsAbsolutePath('D:/Games/Zandronum/zandronum.exe'), true);
		assert.strictEqual(isWindowsAbsolutePath('/opt/zandronum/zandronum'), false);
		assert.strictEqual(isWindowsAbsolutePath('zandronum'), false);
	});

	test('detects Windows executables launched through WSL', () => {
		const program = '/mnt/d/Games/Zandronum/zandronum.exe';
		assert.strictEqual(isWslWindowsExecutable(program, 'linux', '6.1-microsoft', undefined), true);
		assert.strictEqual(isWslWindowsExecutable(program, 'linux', '6.1-generic', 'Ubuntu'), true);
		assert.strictEqual(isWslWindowsExecutable('/opt/zandronum/zandronum', 'linux', '6.1-microsoft'), false);
		assert.strictEqual(isWslWindowsExecutable(program, 'win32', 'windows', undefined), false);
	});

	test('converts only POSIX absolute path arguments for a Windows executable', () => {
		const converted = convertWslPathArguments(
			[
				'-iwad', '/mnt/d/wads/megagame.wad',
				'-file', '/home/user/My Mod/out/build.pk3',
				'+map', 'MAP01', '-connect', '127.0.0.1:10666',
			],
			value => `win:${value}`
		);
		assert.deepStrictEqual(converted, [
			'-iwad', 'win:/mnt/d/wads/megagame.wad',
			'-file', 'win:/home/user/My Mod/out/build.pk3',
			'+map', 'MAP01', '-connect', '127.0.0.1:10666',
		]);
	});
});

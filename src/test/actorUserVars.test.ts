import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ActorSymbolProvider } from '../base/actorProvider';
import { FolderPackage } from '../base/packages';
import { SymbolDatabase } from '../base/symbolDatabase';
import { ActorSymbol, SymbolKind } from '../base/types';
import {
	collectActorUserVars,
	visibleUserVarsForActor,
} from '../language/decorate/actorUserVars';

suite('ActorSymbolProvider — userVars', () => {
	test('indexes user_* from actor body', () => {
		const text = [
			'actor ThunderWoolRadius : BasicExplosion',
			'{',
			'\tvar int user_angle;',
			'\tvar int user_arcnum;',
			'\tStates { Spawn: TNT1 A 1 stop }',
			'}',
			'',
		].join('\n');
		const provider = new ActorSymbolProvider();
		const symbols = provider.parse('actors/tw.dec', Buffer.from(text));
		assert.strictEqual(symbols.length, 1);
		const actor = symbols[0] as ActorSymbol;
		assert.strictEqual(actor.name, 'ThunderWoolRadius');
		assert.strictEqual(actor.parentClass, 'BasicExplosion');
		assert.deepStrictEqual(
			(actor.userVars || []).map(v => v.toLowerCase()).sort(),
			['user_angle', 'user_arcnum']
		);
	});
});

suite('collectActorUserVars — inheritance', () => {
	async function buildDb(decorate: string): Promise<SymbolDatabase> {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zandro-uservar-'));
		fs.writeFileSync(path.join(dir, 'DECORATE'), decorate);
		const db = new SymbolDatabase();
		db.registerProvider(new ActorSymbolProvider());
		await db.build([new FolderPackage('test', 1, dir)]);
		return db;
	}

	test('child sees parent user vars', async () => {
		const db = await buildDb([
			'actor ThunderWoolRadius : Actor {',
			'  var int user_angle;',
			'  var int user_arcnum;',
			'}',
			'actor ThunderWoolRadiusU : ThunderWoolRadius {',
			'}',
		].join('\n'));

		const child = db.query<ActorSymbol>(SymbolKind.Actor, 'ThunderWoolRadiusU');
		assert.ok(child);
		assert.strictEqual(child!.parentClass, 'ThunderWoolRadius');

		const vars = collectActorUserVars(db, 'ThunderWoolRadiusU');
		assert.ok(vars.has('user_angle'));
		assert.ok(vars.has('user_arcnum'));
	});

	test('missing parent yields locals only without throw', async () => {
		const db = await buildDb([
			'actor Orphan : MissingParent {',
			'  var int user_local;',
			'}',
		].join('\n'));
		const vars = collectActorUserVars(db, 'Orphan');
		assert.ok(vars.has('user_local'));
		assert.strictEqual(vars.size, 1);
	});

	test('visibleUserVars merges local when child not in DB', async () => {
		const db = await buildDb([
			'actor ThunderWoolRadius : Actor {',
			'  var int user_arcnum;',
			'}',
		].join('\n'));
		const local = new Set<string>(['user_extra']);
		const visible = visibleUserVarsForActor(
			db,
			'ThunderWoolRadiusU',
			'ThunderWoolRadius',
			local
		);
		assert.ok(visible.has('user_extra'));
		assert.ok(visible.has('user_arcnum'));
	});
});

import * as assert from 'assert';
import {
	ACS_DIRECTIVES,
	directivesMatchingPrefix,
	hashDirectiveNameMatch,
} from '../language/acs/completion/acsDirectives';

suite('ACS preprocessor directives', () => {
	test('ACC Outside() set is complete and excludes C preprocessor', () => {
		const names = ACS_DIRECTIVES.map((d) => d.name);
		assert.deepStrictEqual(names, [
			'include',
			'import',
			'library',
			'define',
			'libdefine',
			'nocompact',
			'wadauthor',
			'nowadauthor',
			'encryptstrings',
		]);
		for (const bogus of ['ifdef', 'ifndef', 'undef', 'pragma', 'endif', 'region']) {
			assert.ok(!names.includes(bogus), bogus);
		}
	});

	test('matches prefix after #', () => {
		assert.deepStrictEqual(
			directivesMatchingPrefix('inc').map((d) => d.name),
			['include']
		);
		assert.deepStrictEqual(
			directivesMatchingPrefix('lib').map((d) => d.name),
			['library', 'libdefine']
		);
		assert.strictEqual(directivesMatchingPrefix('').length, ACS_DIRECTIVES.length);
	});

	test('hashDirectiveNameMatch only on the directive identifier', () => {
		assert.deepStrictEqual(hashDirectiveNameMatch('#'), { hashCol: 0, name: '' });
		assert.deepStrictEqual(hashDirectiveNameMatch('  #inc'), { hashCol: 2, name: 'inc' });
		assert.deepStrictEqual(hashDirectiveNameMatch('# include'), { hashCol: 0, name: 'include' });
		assert.strictEqual(hashDirectiveNameMatch('#include "zcommon.acs"'), null);
		assert.strictEqual(hashDirectiveNameMatch('#include "'), null);
		assert.strictEqual(hashDirectiveNameMatch('script 1 (void)'), null);
	});
});

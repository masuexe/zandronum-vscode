import * as assert from 'assert';
import {
	buildActionInsertText,
	hasExistingCallParen,
} from '../shared/snippetBuilder';
import { ParamData } from '../shared/dataLoader';

suite('snippetBuilder — hasExistingCallParen', () => {
	test('detects paren after incomplete name', () => {
		const line = 'TNT1 A 0 ACS_NamedExecuteWithRe("rz_SetPlayerSkin", 1)';
		const cursor = line.indexOf('WithRe') + 'WithRe'.length;
		assert.strictEqual(hasExistingCallParen(line, cursor), true);
	});

	test('false when no call paren follows', () => {
		const line = 'TNT1 A 0 ACS_NamedExecuteWithRe';
		const cursor = line.length;
		assert.strictEqual(hasExistingCallParen(line, cursor), false);
	});

	test('skips remainder of identifier before looking for paren', () => {
		const line = 'ACS_NamedExecuteWithResult("x")';
		const cursor = line.indexOf('Named');
		assert.strictEqual(hasExistingCallParen(line, cursor), true);
	});
});

suite('snippetBuilder — buildActionInsertText', () => {
	const required: ParamData[] = [{ name: 'script', type: 'string' }];

	test('adds paren snippet for required params', () => {
		const result = buildActionInsertText('ACS_NamedExecuteWithResult', required);
		assert.strictEqual(result.triggerSignatureHelp, true);
		assert.ok(typeof result.insertText !== 'string');
	});

	test('skips parens when call already has them', () => {
		const result = buildActionInsertText('ACS_NamedExecuteWithResult', required, {
			existingCallParen: true,
		});
		assert.strictEqual(result.insertText, 'ACS_NamedExecuteWithResult');
		assert.strictEqual(result.triggerSignatureHelp, false);
	});
});

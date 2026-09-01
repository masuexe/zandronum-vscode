import * as assert from 'assert';
import {
	AcsFormatOptions,
	buildFormattedDocumentText,
	formatAcsLines,
	structuralLine,
	trimTrailingBlankLines,
} from '../language/acs/formattingProvider';

const defaultOpts: AcsFormatOptions = {
	tabSize: 4,
	insertSpaces: true,
	braceStyle: 'nextLine',
	spaceInEmptyBraces: false,
	spaceAfterComma: true,
	spaceAfterControlKeyword: true,
	removeBlankLinesBeforeCloseBrace: true,
};

function format(src: string, opts: Partial<AcsFormatOptions> = {}): string {
	const options: AcsFormatOptions = { ...defaultOpts, ...opts };
	return formatAcsLines(src.split('\n'), options).join('\n');
}

function formatRange(
	src: string,
	startLine: number,
	endLine: number,
	endCharacter = 1,
	opts: Partial<AcsFormatOptions> = {}
): string {
	const options: AcsFormatOptions = { ...defaultOpts, ...opts };
	return formatAcsLines(src.split('\n'), options, {
		startLine,
		endLine,
		endCharacter,
	}).join('\n');
}

suite('acsFormat — structuralLine', () => {
	test('completed string list on one line is not a trailing comma', () => {
		const r = structuralLine('SomeCall("a", "b")', false);
		assert.strictEqual(r.code.trim().endsWith(','), false);
		assert.ok(r.code.includes('"b"'));
	});

	test('trailing comma after string is a continuation opener', () => {
		const r = structuralLine('SomeCall("a",', false);
		assert.strictEqual(r.code.trim().endsWith(','), true);
	});

	test('tracks multi-line block comments', () => {
		const a = structuralLine('int x; /* {', false);
		assert.strictEqual(a.inBlockComment, true);
		const b = structuralLine('  */ int y;', true);
		assert.strictEqual(b.inBlockComment, false);
	});
});

suite('acsFormat — library and script', () => {
	test('formats library header and Allman script', () => {
		const input = [
			'#library "foo"',
			'#include "zcommon.acs"',
			'',
			'script 1 (void)',
			'{',
			'Print(s:"Hi");',
			'}',
		].join('\n');

		const expected = [
			'#library "foo"',
			'#include "zcommon.acs"',
			'',
			'script 1 (void)',
			'{',
			'    Print(s:"Hi");',
			'}',
		].join('\n');

		assert.strictEqual(format(input), expected);
	});

	test('splits same-line script brace to next line', () => {
		const input = [
			'script 1 (void) {',
			'Print(s:"Hi");',
			'}',
		].join('\n');

		const expected = [
			'script 1 (void)',
			'{',
			'    Print(s:"Hi");',
			'}',
		].join('\n');

		assert.strictEqual(format(input), expected);
	});

	test('is idempotent', () => {
		const input = [
			'script 1 (void)',
			'{',
			'    Print(s:"Hi");',
			'}',
		].join('\n');
		const once = format(input);
		assert.strictEqual(format(once), once);
	});

	test('sameLine merges script brace', () => {
		const input = [
			'script 1 (void)',
			'{',
			'    Print(s:"Hi");',
			'}',
		].join('\n');

		const expected = [
			'script 1 (void) {',
			'    Print(s:"Hi");',
			'}',
		].join('\n');

		assert.strictEqual(format(input, { braceStyle: 'sameLine' }), expected);
	});

	test('keeps preprocessor at column 0', () => {
		const input = [
			'  #include "zcommon.acs"',
			'  #define FOO 1',
			'script 1 (void)',
			'{',
			'}',
		].join('\n');

		const out = format(input).split('\n');
		assert.strictEqual(out[0], '#include "zcommon.acs"');
		assert.strictEqual(out[1], '#define FOO 1');
	});

	test('keeps world and global index colons tight', () => {
		const input = [
			'world int 1: wadbadguycount;',
			'global int 3: IsTeamGame;',
		].join('\n');

		const expected = [
			'world int 1:wadbadguycount;',
			'global int 3:IsTeamGame;',
		].join('\n');

		assert.strictEqual(format(input), expected);
	});
});

suite('acsFormat — control flow', () => {
	test('formats if/else Allman braces', () => {
		const input = [
			'script 1 (void)',
			'{',
			'if (x) {',
			'Print(s:"yes");',
			'} else {',
			'Print(s:"no");',
			'}',
			'}',
		].join('\n');

		const expected = [
			'script 1 (void)',
			'{',
			'    if (x)',
			'    {',
			'        Print(s:"yes");',
			'    } else',
			'    {',
			'        Print(s:"no");',
			'    }',
			'}',
		].join('\n');

		assert.strictEqual(format(input), expected);
	});

	test('formats else if', () => {
		const input = [
			'script 1 (void)',
			'{',
			'if (a) {',
			'x = 1;',
			'} else if (b) {',
			'x = 2;',
			'}',
			'}',
		].join('\n');

		const out = format(input).split('\n');
		assert.strictEqual(out[2], '    if (a)');
		assert.strictEqual(out[3], '    {');
		assert.strictEqual(out[5], '    } else if (b)');
		assert.strictEqual(out[6], '    {');
	});

	test('formats while and for', () => {
		const input = [
			'script 1 (void)',
			'{',
			'while (x) {',
			'x--;',
			'}',
			'for (int i = 0; i < 10; i++) {',
			'x++;',
			'}',
			'}',
		].join('\n');

		const out = format(input).split('\n');
		assert.strictEqual(out[2], '    while (x)');
		assert.strictEqual(out[3], '    {');
		assert.strictEqual(out[5], '    }');
		assert.strictEqual(out[6], '    for (int i = 0; i < 10; i++)');
		assert.strictEqual(out[7], '    {');
	});

	test('formats do until', () => {
		const input = [
			'script 1 (void)',
			'{',
			'do {',
			'x++;',
			'} until (x > 5);',
			'}',
		].join('\n');

		const expected = [
			'script 1 (void)',
			'{',
			'    do',
			'    {',
			'        x++;',
			'    } until (x > 5);',
			'}',
		].join('\n');

		assert.strictEqual(format(input), expected);
	});

	test('formats switch with case labels at body indent', () => {
		const input = [
			'script 1 (void)',
			'{',
			'switch (x) {',
			'case 1:',
			'Print(s:"one");',
			'break;',
			'default:',
			'break;',
			'}',
			'}',
		].join('\n');

		const out = format(input).split('\n');
		assert.strictEqual(out[2], '    switch (x)');
		assert.strictEqual(out[3], '    {');
		assert.strictEqual(out[4], '        case 1:');
		assert.strictEqual(out[5], '            Print(s:"one");');
		assert.strictEqual(out[6], '            break;');
		assert.strictEqual(out[7], '        default:');
		assert.strictEqual(out[8], '            break;');
	});

	test('keeps trailing comment on case and indents the body', () => {
		const input = [
			'script 1 (void)',
			'{',
			'switch (x)',
			'{',
			'case 65:  // A=Player \'Custom\'',
			'spawnStr = StrParam(n:0, s:" ", s:B_MessStr);',
			'break;',
			'}',
			'}',
		].join('\n');

		const out = format(input).split('\n');
		assert.strictEqual(out[4], '        case 65:  // A=Player \'Custom\'');
		assert.strictEqual(out[5], '            spawnStr = StrParam(n:0, s:" ", s:B_MessStr);');
		assert.strictEqual(out[6], '            break;');
	});

	test('keeps a space after same-line case colon', () => {
		const input = [
			'script 1 (void)',
			'{',
			'switch (x)',
			'{',
			'case 2: spawnStr = StrParam(n:0, s:"\\ck was cursed to be ", s:B_NameStr, s:"\\ck."); break;',
			'}',
			'}',
		].join('\n');

		const out = format(input).split('\n');
		assert.strictEqual(
			out[4],
			'        case 2: spawnStr = StrParam(n:0, s:"\\ck was cursed to be ", s:B_NameStr, s:"\\ck."); break;'
		);
	});

	test('indents nested switch inside a case body', () => {
		const input = [
			'script 1 (void)',
			'{',
			'switch (x) {',
			'case -1:',
			'switch (y) {',
			'// inner',
			'case 0: a = 1; break;',
			'}',
			'break;',
			'}',
			'}',
		].join('\n');

		const expected = [
			'script 1 (void)',
			'{',
			'    switch (x)',
			'    {',
			'        case -1:',
			'            switch (y)',
			'            {',
			'                // inner',
			'                case 0: a = 1; break;',
			'            }',
			'            break;',
			'    }',
			'}',
		].join('\n');

		assert.strictEqual(format(input), expected);
		assert.strictEqual(
			format(input, { braceStyle: 'sameLine' }),
			[
				'script 1 (void) {',
				'    switch (x) {',
				'        case -1:',
				'            switch (y) {',
				'                // inner',
				'                case 0: a = 1; break;',
				'            }',
				'            break;',
				'    }',
				'}',
			].join('\n')
		);
	});

	test('indents braceless if body one level', () => {
		const input = [
			'script 1 (void)',
			'{',
			'if (whoisit >= 0 && whoisit <= 6666)',
			'SetInventory("ThisIsMyMagicBossNumber", whoisit);',
			'}',
		].join('\n');

		const expected = [
			'script 1 (void)',
			'{',
			'    if (whoisit >= 0 && whoisit <= 6666)',
			'        SetInventory("ThisIsMyMagicBossNumber", whoisit);',
			'}',
		].join('\n');

		assert.strictEqual(format(input), expected);
		assert.strictEqual(format(expected), expected);
	});

	test('keeps else aligned with braceless if', () => {
		const input = [
			'script 1 (void)',
			'{',
			'if (x)',
			'a = 1;',
			'else',
			'a = 2;',
			'}',
		].join('\n');

		const out = format(input).split('\n');
		assert.strictEqual(out[2], '    if (x)');
		assert.strictEqual(out[3], '        a = 1;');
		assert.strictEqual(out[4], '    else');
		assert.strictEqual(out[5], '        a = 2;');
	});

	test('does not extra-indent after same-line if body', () => {
		const input = [
			'script 1 (void)',
			'{',
			'if (x) a = 1;',
			'a = 2;',
			'}',
		].join('\n');

		const out = format(input).split('\n');
		assert.strictEqual(out[2], '    if (x) a = 1;');
		assert.strictEqual(out[3], '    a = 2;');
	});

	test('keeps a space after same-line else before the body', () => {
		const input = [
			'script 1 (void)',
			'{',
			'if (x) len = FixedDiv(y, sin(ang));',
			'else len = FixedDiv(x, cos(ang));',
			'}',
		].join('\n');

		const out = format(input).split('\n');
		assert.strictEqual(out[3], '    else len = FixedDiv(x, cos(ang));');
	});

	test('indents nested braceless if bodies', () => {
		const input = [
			'script 1 (void)',
			'{',
			'if (a)',
			'if (b)',
			'x = 1;',
			'}',
		].join('\n');

		const out = format(input).split('\n');
		assert.strictEqual(out[2], '    if (a)');
		assert.strictEqual(out[3], '        if (b)');
		assert.strictEqual(out[4], '            x = 1;');
	});

	test('does not extra-indent the body after a wrapped if condition', () => {
		const input = [
			'script 1 (void)',
			'{',
			'if (CheckInventory("A") <= 0 ||',
			'    CheckInventory("B") > 0) {',
			'Log(s:"unavailable");',
			'terminate;',
			'}',
			'}',
		].join('\n');

		const sameLine = format(input, { braceStyle: 'sameLine' }).split('\n');
		const ifLine = sameLine.findIndex((l) => l.includes('CheckInventory("A")'));
		assert.ok(ifLine >= 0);
		assert.ok(sameLine[ifLine].includes('if (CheckInventory("A") <= 0 ||'));
		assert.ok(sameLine[ifLine + 1].includes('CheckInventory("B") > 0) {'));
		assert.strictEqual(sameLine[ifLine + 2].trimStart(), 'Log(s:"unavailable");');
		assert.strictEqual(sameLine[ifLine + 3].trimStart(), 'terminate;');
		assert.strictEqual(sameLine[ifLine + 2], sameLine[ifLine + 3].replace('terminate;', 'Log(s:"unavailable");'));
		assert.strictEqual(sameLine[ifLine + 4].trim(), '}');
		assert.ok(sameLine[ifLine + 2].startsWith('        '));
		assert.ok(!sameLine[ifLine + 2].startsWith('            '));

		const nextLine = format(input).split('\n');
		const logLine = nextLine.findIndex((l) => l.includes('Log(s:"unavailable")'));
		assert.strictEqual(nextLine[logLine], '        Log(s:"unavailable");');
		assert.strictEqual(nextLine[logLine + 1], '        terminate;');
	});

	test('hanging-indents a braceless body after a wrapped if condition', () => {
		const input = [
			'script 1 (void)',
			'{',
			'if (a ||',
			'    b)',
			'x = 1;',
			'}',
		].join('\n');

		const out = format(input).split('\n');
		assert.strictEqual(out[2], '    if (a ||');
		assert.strictEqual(out[4], '        x = 1;');
	});
});

suite('acsFormat — control flow spacing', () => {
	test('inserts space after if before paren and before brace', () => {
		const input = [
			'script 1 (void)',
			'{',
			'if(x){',
			'Print(s:"yes");',
			'}',
			'}',
		].join('\n');

		const expected = [
			'script 1 (void)',
			'{',
			'    if (x)',
			'    {',
			'        Print(s:"yes");',
			'    }',
			'}',
		].join('\n');

		assert.strictEqual(format(input), expected);
	});

	test('sameLine keeps space before brace on one line', () => {
		const input = [
			'script 1 (void)',
			'{',
			'if(x){',
			'Print(s:"yes");',
			'}',
			'}',
		].join('\n');

		const expected = [
			'script 1 (void) {',
			'    if (x) {',
			'        Print(s:"yes");',
			'    }',
			'}',
		].join('\n');

		assert.strictEqual(format(input, { braceStyle: 'sameLine' }), expected);
	});

	test('normalizes else if and closing brace spacing', () => {
		const input = [
			'script 1 (void)',
			'{',
			'if(a){',
			'x = 1;',
			'}else if(b){',
			'x = 2;',
			'}',
			'}',
		].join('\n');

		const out = format(input).split('\n');
		assert.strictEqual(out[2], '    if (a)');
		assert.strictEqual(out[5], '    } else if (b)');
	});

	test('normalizes while for switch until and do', () => {
		const input = [
			'script 1 (void)',
			'{',
			'while(x){',
			'x--;',
			'}',
			'for(int i=0;i<10;i++){',
			'x++;',
			'}',
			'switch(x){',
			'case 1:',
			'break;',
			'}',
			'do{',
			'x++;',
			'}until(x>5);',
			'}',
		].join('\n');

		const out = format(input);
		assert.ok(out.includes('    while (x)'));
		assert.ok(out.includes('    for (int i = 0; i < 10; i++)'));
		assert.ok(out.includes('    switch (x)'));
		assert.ok(out.includes('    do'));
		assert.ok(out.includes('} until (x > 5);'));
	});

	test('does not space before paren in Print calls', () => {
		const input = [
			'script 1 (void)',
			'{',
			'Print(s:"Hi");',
			'}',
		].join('\n');

		const out = format(input).split('\n');
		assert.strictEqual(out[2], '    Print(s:"Hi");');
	});

	test('does not rewrite if inside strings', () => {
		const input = [
			'script 1 (void)',
			'{',
			'Print(s:"if(x)");',
			'}',
		].join('\n');

		const out = format(input).split('\n');
		assert.ok(out[2].includes('"if(x)"'));
	});

	test('leaves compact control keywords when setting is false', () => {
		const input = [
			'script 1 (void)',
			'{',
			'if(x){',
			'x = 1;',
			'}',
			'}',
		].join('\n');

		const out = format(input, { spaceAfterControlKeyword: false }).split('\n');
		assert.strictEqual(out[2], '    if(x)');
	});

	test('spaces script header before brace', () => {
		const input = 'script 1 (void){';
		assert.strictEqual(format(input, { braceStyle: 'sameLine' }), 'script 1 (void) {');
	});

	test('keeps space after named script string before args', () => {
		const input = [
			'script "sp_enemystart" (void) {',
			'}',
		].join('\n');

		const expected = [
			'script "sp_enemystart" (void)',
			'{',
			'}',
		].join('\n');

		assert.strictEqual(format(input), expected);
		assert.strictEqual(
			format(input, { braceStyle: 'sameLine' }),
			'script "sp_enemystart" (void) {\n}'
		);
		assert.strictEqual(
			format('script "sp_enemystart"(void) {', { braceStyle: 'sameLine' }),
			'script "sp_enemystart" (void) {'
		);
	});

	test('keeps space before comparison after a call', () => {
		const input = [
			'script 1 (void)',
			'{',
			'if (GetActorProperty(0, APROP_Health) > 0)',
			'{',
			'}',
			'}',
		].join('\n');

		const out = format(input).split('\n');
		assert.strictEqual(out[2], '    if (GetActorProperty(0, APROP_Health) > 0)');
	});

	test('does not split hexadecimal literals', () => {
		const input = [
			'script 1 (void)',
			'{',
			'int n = 0x7ffffffc;',
			'if (tid == 0XFF)',
			'{',
			'}',
			'}',
		].join('\n');

		const out = format(input).split('\n');
		assert.strictEqual(out[2], '    int n = 0x7ffffffc;');
		assert.strictEqual(out[3], '    if (tid == 0XFF)');
	});

	test('does not rewrite single-quoted string literals', () => {
		const input = [
			'script 1 (void)',
			'{',
			"if (GetChar(wep, len - 3) == '_')",
			'{',
			'}',
			'}',
		].join('\n');

		const out = format(input).split('\n');
		assert.strictEqual(out[2], "    if (GetChar(wep, len - 3) == '_')");
	});

	test('inserts space before comparison after a call', () => {
		const input = [
			'script 1 (void)',
			'{',
			'if (GetActorProperty(0, APROP_Health)> 0)',
			'{',
			'}',
			'}',
		].join('\n');

		const out = format(input).split('\n');
		assert.strictEqual(out[2], '    if (GetActorProperty(0, APROP_Health) > 0)');
	});

	test('tightens call parens and spaces binary operators', () => {
		const input = [
			'script 1 (void)',
			'{',
			'SetActorProperty(0, APROP_Health, GetActorProperty (0, APROP_Health)+ (GetActorProperty (0, APROP_Health)/4)* PlayerCount());',
			'}',
		].join('\n');

		const out = format(input).split('\n');
		assert.strictEqual(
			out[2],
			'    SetActorProperty(0, APROP_Health, GetActorProperty(0, APROP_Health) + (GetActorProperty(0, APROP_Health) / 4) * PlayerCount());'
		);
	});

	test('keeps shift operators as one token', () => {
		const input = [
			'script 1 (void)',
			'{',
			'int n = x >> 8;',
			'int m = y<<4;',
			'}',
		].join('\n');

		const out = format(input).split('\n');
		assert.strictEqual(out[2], '    int n = x >> 8;');
		assert.strictEqual(out[3], '    int m = y << 4;');
	});

	test('keeps compound assignment operators as one token', () => {
		const input = [
			'script 1 (void)',
			'{',
			'n += 1;',
			'n-=2;',
			'n *= 3;',
			'n/=4;',
			'}',
		].join('\n');

		const out = format(input).split('\n');
		assert.strictEqual(out[2], '    n += 1;');
		assert.strictEqual(out[3], '    n -= 2;');
		assert.strictEqual(out[4], '    n *= 3;');
		assert.strictEqual(out[5], '    n /= 4;');
	});

	test('keeps space after comparison before unary minus', () => {
		const input = [
			'script 1 (void)',
			'{',
			'if (PlayerNumber() == -1)',
			'{',
			'}',
			'}',
		].join('\n');

		const out = format(input).split('\n');
		assert.strictEqual(out[2], '    if (PlayerNumber() == -1)');
		assert.strictEqual(format('script 1 (void)\n{\nif (PlayerNumber() ==-1)\n{\n}\n}').split('\n')[2], '    if (PlayerNumber() == -1)');
	});

	test('spaces trailing line comments Google-style', () => {
		const input = [
			'script 1 (void)',
			'{',
			'GiveInventory("PowerProtectBoss", 1);  //If multi boss, protect them from each other.',
			'GiveInventory("PowerProtectBoss", 1);//If multi boss, protect them from each other.',
			'}',
		].join('\n');

		const out = format(input).split('\n');
		assert.strictEqual(
			out[2],
			'    GiveInventory("PowerProtectBoss", 1);  // If multi boss, protect them from each other.'
		);
		assert.strictEqual(out[3], out[2]);
		assert.strictEqual(format(out.join('\n')), out.join('\n'));
	});

	test('spaces full-line comments after // only', () => {
		const input = [
			'script 1 (void)',
			'{',
			'//If multi boss',
			'}',
		].join('\n');

		const out = format(input).split('\n');
		assert.strictEqual(out[2], '    // If multi boss');
	});

	test('preserves multiple spaces after //', () => {
		const input = '//      #library "YOUR_COPYDEFS"';
		assert.strictEqual(format(input).split('\n')[0], '//      #library "YOUR_COPYDEFS"');
	});

	test('does not rewrite slashes inside strings', () => {
		const input = [
			'script 1 (void)',
			'{',
			'Print(s:"//not a comment");',
			'}',
		].join('\n');

		const out = format(input).split('\n');
		assert.strictEqual(out[2], '    Print(s:"//not a comment");');
	});
});

suite('acsFormat — calls and continuations', () => {
	test('inserts space after commas in Print casts', () => {
		const input = [
			'script 1 (void)',
			'{',
			'Print(s:"a",n:0);',
			'}',
		].join('\n');

		const out = format(input).split('\n');
		assert.strictEqual(out[2], '    Print(s:"a", n:0);');
	});

	test('keeps palette translation remaps tight', () => {
		const input = [
			'script 1 (void)',
			'{',
			'CreateTranslation(1, 192:192 = 248:248);',
			'n = 1;',
			'}',
		].join('\n');

		const out = format(input).split('\n');
		assert.strictEqual(out[2], '    CreateTranslation(1, 192:192=248:248);');
		assert.strictEqual(out[3], '    n = 1;');
	});

	test('preserves HudMessage semicolon', () => {
		const input = [
			'script 1 (void)',
			'{',
			'HudMessage(s:"Hi";HUDMSG_PLAIN,0,CR_GOLD,0.5,0.5,3.0);',
			'}',
		].join('\n');

		const out = format(input).split('\n');
		assert.ok(out[2].includes('s:"Hi";'));
		assert.ok(out[2].includes('HUDMSG_PLAIN, 0'));
	});

	test('preserves wrapped parameter list alignment', () => {
		const input = [
			'function void Foo(str text, str fontName,',
			'                            int boxId)',
			'{',
			'}',
		].join('\n');

		const out = format(input).split('\n');
		assert.strictEqual(out[0], 'function void Foo(str text, str fontName,');
		assert.strictEqual(out[1], '                            int boxId)');
	});

	test('indents every row of a brace array initializer', () => {
		const input = [
			'str lmsListArray[2][2]={',
			'{"a","b"},',
			'{"c","d"}',
			'};',
		].join('\n');

		const expected = [
			'str lmsListArray[2][2] =',
			'{',
			'    {"a", "b"},',
			'    {"c", "d"}',
			'};',
		].join('\n');

		assert.strictEqual(format(input), expected);
		assert.strictEqual(
			format(input, { braceStyle: 'sameLine' }),
			[
				'str lmsListArray[2][2] = {',
				'    {"a", "b"},',
				'    {"c", "d"}',
				'};',
			].join('\n')
		);
	});

	test('does not treat next line after same-line string list as continuation indent skip', () => {
		const input = [
			'script 1 (void)',
			'{',
			'SomeCall("a", "b");',
			'int x = 1;',
			'}',
		].join('\n');

		const out = format(input).split('\n');
		assert.strictEqual(out[3], '    int x = 1;');
	});
});

suite('acsFormat — ifdef and blanks', () => {
	test('keeps #ifdef at column 0 with indented body', () => {
		const input = [
			'#ifdef FOO',
			'script 1 (void)',
			'{',
			'x = 1;',
			'}',
			'#endif',
		].join('\n');

		const out = format(input).split('\n');
		assert.strictEqual(out[0], '#ifdef FOO');
		assert.strictEqual(out[2], '{');
		assert.strictEqual(out[3], '    x = 1;');
		assert.strictEqual(out[5], '#endif');
	});

	test('removes blanks before closing brace', () => {
		const input = [
			'script 1 (void)',
			'{',
			'x = 1;',
			'',
			'',
			'}',
		].join('\n');

		const out = format(input).split('\n');
		assert.strictEqual(out[2], '    x = 1;');
		assert.strictEqual(out[3], '}');
		assert.ok(!out.includes(''));
	});

	test('leaves compact empty braces alone by default', () => {
		const input = 'script 1 (void) {}';
		assert.strictEqual(format(input, { braceStyle: 'sameLine' }), input);
	});
});

suite('acsFormat — range and document', () => {
	test('format selection only rewrites overlapping lines', () => {
		const input = [
			'script 1 (void)',
			'{',
			'x = 1;',
			'y = 2;',
			'}',
		].join('\n');

		const out = formatRange(input, 2, 2).split('\n');
		assert.strictEqual(out[2], '    x = 1;');
		assert.strictEqual(out[3], 'y = 2;');
	});

	test('buildFormattedDocumentText ends with exactly one newline', () => {
		assert.strictEqual(
			buildFormattedDocumentText(['script 1 (void)', ''], '\n'),
			'script 1 (void)\n'
		);
	});

	test('trimTrailingBlankLines removes EOF blank lines', () => {
		assert.deepStrictEqual(
			trimTrailingBlankLines(['script 1 (void)', '', '  ']),
			['script 1 (void)']
		);
	});
});

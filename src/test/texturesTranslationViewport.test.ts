import * as assert from 'assert';
import * as vscode from 'vscode';
import {
	collectKeywordPropertyTranslationSpans,
	collectTranslationColorsForSpan,
	provideTranslationColorPresentations,
} from '../language/shared/translationColorScan';
import { RgbColor } from '../tools/playpalReader';
import {
	BoundedColorCache,
	COLOR_BLOCK_LINES,
	VIEWPORT_RENDER_COLOR_BUDGET,
	cacheChunkKey,
	collectColorsForWindows,
	expandRangesWithPad,
	hexToColor,
	isAsyncResultCurrent,
	mergeLineWindows,
	selectColorsForDisplay,
	translationPreviewMode,
} from '../language/textures/translationViewportCore';

function fakeDoc(lines: string[]): vscode.TextDocument {
	return {
		uri: vscode.Uri.parse('untitled:textures-viewport-test'),
		version: 1,
		lineCount: lines.length,
		lineAt(line: number) {
			return { text: lines[line], lineNumber: line } as vscode.TextLine;
		},
		getText(range?: vscode.Range) {
			if (!range) {
				return lines.join('\n');
			}
			const line = lines[range.start.line] ?? '';
			return line.slice(range.start.character, range.end.character);
		},
	} as vscode.TextDocument;
}

const palette: RgbColor[] = Array.from({ length: 256 }, (_, i) => ({
	r: i, g: i, b: 255 - (i % 256),
}));

const KW = /\bTranslation\b/i;

suite('textures translation viewport — structure index', () => {
	test('indexes keyword-only Translation and quoted continuation lines', () => {
		const doc = fakeDoc([
			'texture BRSLT193,8, 56{offset -16,-8 patch B_4BARSX,0,0 {Translation',
			'    "192:192=138:138", "198:198=89:89",',
			'	"202:202=112:112"',
			'}}',
		]);
		const spans = collectKeywordPropertyTranslationSpans(doc, KW);
		assert.strictEqual(spans.length, 1);
		assert.strictEqual(spans[0].startLine, 0);
		assert.strictEqual(spans[0].endLine, 2);
		assert.ok(spans[0].keywordColumn > 0);
	});

	test('windowed color generation skips off-screen span lines', () => {
		const doc = fakeDoc([
			'Translation "1:1=2:2",',
			'"3:3=4:4",',
			'"5:5=6:6"',
		]);
		const spans = collectKeywordPropertyTranslationSpans(doc, KW);
		const visible = collectTranslationColorsForSpan(doc, spans[0], palette, 2, 2);
		assert.ok(visible.length >= 2);
		assert.ok(visible.every(c => c.range.start.line === 2));
	});

	test('mode is explicit and invalid or missing settings default to native', () => {
		assert.strictEqual(translationPreviewMode('viewport'), 'viewport');
		for (const value of ['native', 'auto', '', undefined, null, 10001]) {
			assert.strictEqual(translationPreviewMode(value), 'native');
		}
	});

	test('comments and patch coordinates stay outside spans and colors', () => {
		const doc = fakeDoc([
			'patch B_4BARSX,12,34 { // Translation "1:1=2:2"',
			'Translation "8:8=9:9"',
			'}',
		]);
		const spans = collectKeywordPropertyTranslationSpans(doc, KW);
		assert.strictEqual(spans.length, 1);
		assert.strictEqual(spans[0].startLine, 1);
		const colors = collectTranslationColorsForSpan(doc, spans[0], palette, 0, 2);
		assert.ok(!colors.some(c => c.range.start.line === 0));
		assert.ok(colors.some(c => c.range.start.line === 1));
	});
});

suite('textures translation viewport — cache and stale results', () => {
	test('bounded cache evicts by color count', () => {
		const cache = new BoundedColorCache(8, 6);
		const mk = (n: number) => Array.from({ length: n }, () =>
			new vscode.ColorInformation(
				new vscode.Range(0, 0, 0, 1),
				new vscode.Color(1, 0, 0, 1)
			)
		);
		cache.set('a', mk(3));
		cache.set('b', mk(3));
		assert.strictEqual(cache.stats().colors, 6);
		cache.set('c', mk(3));
		assert.ok(cache.stats().colors <= 6);
		assert.strictEqual(cache.get('a'), undefined);
	});

	test('oversized insert preserves useful entries, including replacement and zero capacity', () => {
		const c = new vscode.ColorInformation(new vscode.Range(0, 0, 0, 1), new vscode.Color(1, 0, 0, 1));
		const cache = new BoundedColorCache(2, 3);
		cache.set('a', [c]);
		cache.set('b', [c]);
		cache.set('a', [c, c, c, c]);
		cache.set('large', [c, c, c, c]);
		assert.deepStrictEqual(cache.stats(), { entries: 2, colors: 2 });
		assert.strictEqual(cache.get('a')?.length, 1);
		const disabled = new BoundedColorCache(0, 3);
		disabled.set('a', [c]);
		assert.deepStrictEqual(disabled.stats(), { entries: 0, colors: 0 });
		cache.set('c', []);
		assert.strictEqual(cache.stats().entries, 2);
	});

	test('long Translation preload 80–160 is reused by visible 110–140', () => {
		const doc = fakeDoc(['Translation', ...Array.from({ length: 200 }, () => '"1:1=2:2",')]);
		const spans = collectKeywordPropertyTranslationSpans(doc, KW);
		const cache = new BoundedColorCache();
		const preload = collectColorsForWindows(doc, spans, palette, [{ fromLine: 80, toLine: 160 }], cache, 1, undefined, { preload: true });
		assert.ok(preload.complete);
		const visible = collectColorsForWindows(doc, spans, palette, [{ fromLine: 110, toLine: 140 }], cache, 1);
		assert.strictEqual(visible.cacheMisses, 0);
		assert.strictEqual(visible.cacheHits, 2);
		assert.strictEqual(visible.generatedColors, 0);
		assert.strictEqual(visible.colors.length, 31 * 4);
	});

	test('dense blocks are bounded and partial preload cannot hide later visible lines', () => {
		const dense = '"1:1=2:2",'.repeat(10000);
		const doc = fakeDoc(['Translation ' + dense, ...Array.from({ length: COLOR_BLOCK_LINES }, () => '"3:3=4:4",')]);
		const spans = collectKeywordPropertyTranslationSpans(doc, KW);
		const cache = new BoundedColorCache();
		const preload = collectColorsForWindows(doc, spans, palette, [{ fromLine: 0, toLine: 10 }], cache, 1, undefined, { preload: true, budget: 20 });
		assert.strictEqual(preload.generatedColors, 20);
		assert.strictEqual(preload.colors.length, 20);
		assert.strictEqual(preload.complete, false);
		assert.strictEqual(cache.stats().entries, 0);
		const visible = collectColorsForWindows(doc, spans, palette, [{ fromLine: 8, toLine: 10 }], cache, 1, undefined, { budget: 20 });
		assert.strictEqual(visible.colors.length, 12);
		assert.ok(visible.complete);
		assert.ok(visible.colors.every(c => c.range.start.line >= 8));
		assert.strictEqual(cache.stats().entries, 0, 'a visible sub-block is not a complete cache entry');
	});

	test('miss statistics survive eviction without cache size growth', () => {
		const doc = fakeDoc(['Translation "1:1=2:2"', 'Translation "3:3=4:4"']);
		const spans = collectKeywordPropertyTranslationSpans(doc, KW);
		const cache = new BoundedColorCache(1, 10);
		collectColorsForWindows(doc, spans, palette, [{ fromLine: 0, toLine: 0 }], cache, 1);
		const result = collectColorsForWindows(doc, spans, palette, [{ fromLine: 1, toLine: 1 }], cache, 1);
		assert.strictEqual(result.cacheMisses, 1);
		assert.strictEqual(result.cacheHits, 0);
		assert.deepStrictEqual(cache.stats(), { entries: 1, colors: 4 });
	});

	test('document version and request id reject stale async results', () => {
		assert.ok(isAsyncResultCurrent({
			requestId: 4, currentRequestId: 4,
			documentVersion: 2, currentVersion: 2,
			paletteGeneration: 1, currentPaletteGeneration: 1,
		}));
		assert.ok(!isAsyncResultCurrent({
			requestId: 3, currentRequestId: 4,
			documentVersion: 2, currentVersion: 2,
			paletteGeneration: 1, currentPaletteGeneration: 1,
		}));
		assert.ok(!isAsyncResultCurrent({
			requestId: 4, currentRequestId: 4,
			documentVersion: 2, currentVersion: 3,
			paletteGeneration: 1, currentPaletteGeneration: 1,
		}));
		assert.ok(!isAsyncResultCurrent({
			requestId: 4, currentRequestId: 4,
			documentVersion: 2, currentVersion: 2,
			paletteGeneration: 1, currentPaletteGeneration: 2,
		}));
	});

	test('cache keys include uri, version, palette generation, and span window', () => {
		const span = { startLine: 10, endLine: 40, keywordColumn: 0 };
		const a = cacheChunkKey('u', 1, 1, span, 10, 20);
		const b = cacheChunkKey('u', 2, 1, span, 10, 20);
		const c = cacheChunkKey('u', 1, 2, span, 10, 20);
		assert.notStrictEqual(a, b);
		assert.notStrictEqual(a, c);
	});

	test('windows reuse cached chunks', () => {
		const doc = fakeDoc([
			'Translation "1:1=2:2",',
			'"3:3=4:4"',
		]);
		const spans = collectKeywordPropertyTranslationSpans(doc, KW);
		const cache = new BoundedColorCache();
		const first = collectColorsForWindows(doc, spans, palette, [{ fromLine: 0, toLine: 1 }], cache, 1);
		const second = collectColorsForWindows(doc, spans, palette, [{ fromLine: 0, toLine: 1 }], cache, 1);
		assert.strictEqual(first.colors.length, second.colors.length);
		assert.ok(first.colors.length >= 4);
		assert.strictEqual(first.cacheMisses, 1);
		assert.strictEqual(second.cacheHits, 1);
		assert.strictEqual(second.generatedColors, 0);
		assert.strictEqual(cache.stats().entries, 1);
	});
});

suite('textures translation viewport — visible selection', () => {
	test('display budget prefers the current visible range', () => {
		const visible = [new vscode.Range(10, 0, 12, 0)];
		const colors = [
			new vscode.ColorInformation(new vscode.Range(0, 0, 0, 1), new vscode.Color(1, 0, 0, 1)),
			new vscode.ColorInformation(new vscode.Range(11, 2, 11, 4), new vscode.Color(0, 1, 0, 1)),
			new vscode.ColorInformation(new vscode.Range(40, 0, 40, 1), new vscode.Color(0, 0, 1, 1)),
		];
		const selected = selectColorsForDisplay(colors, visible, 1);
		assert.strictEqual(selected.length, 1);
		assert.strictEqual(selected[0].range.start.line, 11);
		assert.ok(VIEWPORT_RENDER_COLOR_BUDGET > 0);
		assert.strictEqual(selectColorsForDisplay(colors, visible, 10).length, 1);
	});

	test('preload pad expands visible ranges without dropping fold gaps', () => {
		const ranges = [
			new vscode.Range(100, 0, 110, 10),
			new vscode.Range(200, 0, 210, 10),
		];
		const expanded = expandRangesWithPad(ranges, 5, 300);
		assert.strictEqual(expanded.length, 2);
		assert.strictEqual(expanded[0].start.line, 95);
		assert.strictEqual(expanded[1].start.line, 195);
		const merged = mergeLineWindows(expanded);
		assert.strictEqual(merged.length, 2);
	});
});

suite('textures translation viewport — color writeback formats', () => {
	test('palette index presentations replace only the index token', async () => {
		const doc = fakeDoc(['Translation "192:192=248:248"']);
		const range = new vscode.Range(0, 13, 0, 16);
		assert.strictEqual(doc.getText(range), '192');
		const color = new vscode.Color(1, 0, 0, 1);
		const pres = await provideTranslationColorPresentations(color, { document: doc, range }, palette);
		assert.ok(pres.some(p => /^\d{1,3}$/.test(p.label)));
		assert.ok(pres.some(p => p.label.startsWith('[')));
	});

	test('desat float presentations stay in 0–2 units', async () => {
		const doc = fakeDoc(['Translation "0:0=%[0.5,0.5,0.5]:[1,1,1]"']);
		const start = doc.getText().indexOf('[0.5');
		const range = new vscode.Range(0, start, 0, start + '[0.5,0.5,0.5]'.length);
		const color = hexToColor('#ffffff')!;
		const pres = await provideTranslationColorPresentations(color, { document: doc, range }, palette);
		assert.ok(pres[0].label.includes('2') || pres[0].label.includes('1'));
		assert.ok(!pres[0].label.includes('255'));
	});
});

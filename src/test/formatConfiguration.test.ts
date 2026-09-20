import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
    getFormatConfiguration,
    readBraceStyle,
    readSpaceAfterComma,
} from '../language/formatConfiguration';

const FORMAT_KEYS = [
    'format.braceStyle',
    'format.spaceAfterComma',
    'decorate.format.stateLabelIndent',
    'decorate.format.stateFrameIndent',
] as const;

const OLD_FORMAT_KEYS = [
    'decorate.format.braceStyle',
    'decorate.format.spaceInEmptyBraces',
    'decorate.format.spaceAfterComma',
    'decorate.format.removeBlankLinesBeforeCloseBrace',
    'acs.format.braceStyle',
    'acs.format.spaceInEmptyBraces',
    'acs.format.spaceAfterComma',
    'acs.format.spaceAfterControlKeyword',
    'acs.format.removeBlankLinesBeforeCloseBrace',
    'sbarinfo.format.braceStyle',
] as const;

async function openDocument(language: string): Promise<vscode.TextDocument> {
    return vscode.workspace.openTextDocument({
        language,
        content: '// formatConfiguration test',
    });
}

function configFor(document: vscode.TextDocument): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration('zandronum-vscode', document);
}

async function setGlobal(key: string, value: unknown): Promise<void> {
    await vscode.workspace
        .getConfiguration('zandronum-vscode')
        .update(key, value, vscode.ConfigurationTarget.Global);
}

async function setLanguageOverride(
    document: vscode.TextDocument,
    key: string,
    value: unknown
): Promise<void> {
    await configFor(document).update(
        key,
        value,
        vscode.ConfigurationTarget.Global,
        true
    );
}

suite('formatConfiguration — extension host', () => {
    const clearAll = async (): Promise<void> => {
        for (const key of FORMAT_KEYS) {
            await setGlobal(key, undefined);
            for (const language of ['decorate', 'acs', 'sbarinfo']) {
                const doc = await openDocument(language);
                await setLanguageOverride(doc, key, undefined);
            }
        }
    };

    suiteSetup(async function () {
        this.timeout(20000);
        // Clear leftovers from interrupted earlier runs.
        await clearAll();
    });

    suiteTeardown(async function () {
        this.timeout(20000);
        await clearAll();
    });

    suite('defaults', () => {
        test('nextLine brace style and comma spacing for all formatter languages', async () => {
            for (const language of ['decorate', 'acs', 'sbarinfo']) {
                const doc = await openDocument(language);
                const config = getFormatConfiguration(doc);
                assert.strictEqual(readBraceStyle(config), 'nextLine', language);
                assert.strictEqual(readSpaceAfterComma(config), true, language);
            }
        });
    });

    suite('global shared settings', () => {
        test('format.braceStyle applies to DECORATE, ACS, and SBARINFO', async () => {
            await setGlobal('format.braceStyle', 'sameLine');
            for (const language of ['decorate', 'acs', 'sbarinfo']) {
                const doc = await openDocument(language);
                assert.strictEqual(
                    readBraceStyle(getFormatConfiguration(doc)),
                    'sameLine',
                    language
                );
            }
        });

        test('format.spaceAfterComma=false applies to DECORATE and ACS', async () => {
            await setGlobal('format.spaceAfterComma', false);
            for (const language of ['decorate', 'acs']) {
                const doc = await openDocument(language);
                assert.strictEqual(
                    readSpaceAfterComma(getFormatConfiguration(doc)),
                    false,
                    language
                );
            }
        });

        test('invalid brace style falls back to nextLine', async () => {
            await setGlobal('format.braceStyle', 'bogus');
            const doc = await openDocument('acs');
            assert.strictEqual(readBraceStyle(getFormatConfiguration(doc)), 'nextLine');
            await setGlobal('format.braceStyle', 123);
            assert.strictEqual(readBraceStyle(getFormatConfiguration(doc)), 'nextLine');
        });
    });

    suite('language-level overrides', () => {
        test('[acs] braceStyle override does not affect DECORATE or SBARINFO', async () => {
            await setGlobal('format.braceStyle', 'nextLine');
            const acsDoc = await openDocument('acs');
            await setLanguageOverride(acsDoc, 'format.braceStyle', 'sameLine');

            assert.strictEqual(readBraceStyle(getFormatConfiguration(acsDoc)), 'sameLine');
            assert.strictEqual(
                readBraceStyle(getFormatConfiguration(await openDocument('decorate'))),
                'nextLine'
            );
            assert.strictEqual(
                readBraceStyle(getFormatConfiguration(await openDocument('sbarinfo'))),
                'nextLine'
            );
        });

        test('[decorate] spaceAfterComma override does not affect ACS', async () => {
            await setGlobal('format.spaceAfterComma', true);
            const decorateDoc = await openDocument('decorate');
            await setLanguageOverride(decorateDoc, 'format.spaceAfterComma', false);

            assert.strictEqual(readSpaceAfterComma(getFormatConfiguration(decorateDoc)), false);
            assert.strictEqual(
                readSpaceAfterComma(getFormatConfiguration(await openDocument('acs'))),
                true
            );
        });
    });

    suite('manifest', () => {
        const manifest: {
            contributes: {
                configuration: Array<{
                    title: string;
                    properties: Record<string, Record<string, unknown>>;
                }>;
            };
        } = JSON.parse(
            fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf-8')
        );
        const categories = manifest.contributes.configuration;
        const allProperties: Record<string, Record<string, unknown>> = {};
        for (const category of categories) {
            for (const [key, value] of Object.entries(category.properties)) {
                allProperties[key] = value;
            }
        }
        const formattingCategory = categories.find(c => c.title === 'Zandronum › Formatting');
        const formatPropertyKeys = Object.keys(allProperties).filter(key =>
            key.startsWith('zandronum-vscode.format.')
        );

        test('exactly four formatter settings, all in the Formatting category', () => {
            const formattingKeys = Object.keys(formattingCategory?.properties ?? {});
            assert.deepStrictEqual([...formattingKeys].sort(), [
                'zandronum-vscode.decorate.format.stateFrameIndent',
                'zandronum-vscode.decorate.format.stateLabelIndent',
                'zandronum-vscode.format.braceStyle',
                'zandronum-vscode.format.spaceAfterComma',
            ]);
        });

        test('formatter settings are language-overridable with correct defaults', () => {
            const braceStyle = allProperties['zandronum-vscode.format.braceStyle'];
            assert.deepStrictEqual(braceStyle['enum'], ['nextLine', 'sameLine']);
            assert.strictEqual(braceStyle['default'], 'nextLine');
            assert.strictEqual(braceStyle['scope'], 'language-overridable');

            const comma = allProperties['zandronum-vscode.format.spaceAfterComma'];
            assert.strictEqual(comma['type'], 'boolean');
            assert.strictEqual(comma['default'], true);
            assert.strictEqual(comma['scope'], 'language-overridable');

            const labelIndent = allProperties['zandronum-vscode.decorate.format.stateLabelIndent'];
            assert.strictEqual(labelIndent['type'], 'integer');
            assert.strictEqual(labelIndent['default'], 0);
            assert.strictEqual(labelIndent['minimum'], 0);
            assert.strictEqual(labelIndent['scope'], 'language-overridable');

            const frameIndent = allProperties['zandronum-vscode.decorate.format.stateFrameIndent'];
            assert.deepStrictEqual(frameIndent['type'], ['integer', 'null']);
            assert.strictEqual(frameIndent['default'], null);
            assert.strictEqual(frameIndent['minimum'], 0);
            assert.strictEqual(frameIndent['scope'], 'language-overridable');

            for (const key of formatPropertyKeys) {
                assert.strictEqual(typeof allProperties[key]['order'], 'number', key);
            }
        });

        test('old formatter settings are no longer contributed', () => {
            for (const key of OLD_FORMAT_KEYS) {
                assert.strictEqual(
                    allProperties[`zandronum-vscode.${key}`],
                    undefined,
                    key
                );
            }
        });
    });
});

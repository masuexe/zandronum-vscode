import * as vscode from 'vscode';
import { TexturesKeywordData, ParamData } from '../../shared/dataLoader';

const STYLE_DESCRIPTIONS: Record<string, string> = {
    'copy': 'Renders the patch as normal and solid. This is the default.',
    'translucent': 'Applies regular translucency to the patch.',
    'add': 'Draws with additive translucency, resulting in a brightening effect.',
    'subtract': 'Subtracts the patch from patches below, resulting in a darkening effect.',
    'reversesubtract': 'Same as Subtract, but re-inverts the patch so it appears normal.',
    'modulate': 'Extreme darkening effect, similar to Photoshop burn.',
    'copyalpha': 'Same as Copy, but respects a PNG alpha channel.',
    'copynewalpha': 'Like Copy, but multiplies each pixel alpha by the Alpha property.',
    'overlay': 'Same as CopyAlpha, but only copies where alpha is higher than what is underneath.'
};

const TRANSLATION_DESCRIPTIONS: Record<string, string> = {
    'inverse': 'Inverts the colors of the patch.',
    'gold': 'Translates the patch to gold tones.',
    'red': 'Translates the patch to red tones.',
    'green': 'Translates the patch to green tones.',
    'ice': 'Translates the patch to ice/blue tones.',
    'desaturate': 'Desaturates the patch. Takes an amount parameter (1-31).'
};

function findKeywordCaseInsensitive(
    data: Record<string, TexturesKeywordData>,
    name: string
): [string, TexturesKeywordData] | undefined {
    const lower = name.toLowerCase();
    for (const [key, value] of Object.entries(data)) {
        if (key.toLowerCase() === lower) { return [key, value]; }
    }
    return undefined;
}

function buildSignature(name: string, params?: ParamData[]): string {
    if (!params || params.length === 0) { return name; }
    const parts = params.map(p => {
        const opt = p.optional ? '?' : '';
        return `${p.type}${opt} ${p.name}`;
    });
    return `${name} ${parts.join(', ')}`;
}

function contextLabel(category: string): string {
    switch (category) {
        case 'definition': return 'Top Level';
        case 'textureProperty': return 'Texture Block';
        case 'patchProperty': return 'Patch Block';
        default: return category;
    }
}

export function registerTexturesHoverProvider(
    context: vscode.ExtensionContext,
    keywordsData: Record<string, TexturesKeywordData>
) {
    const provider = vscode.languages.registerHoverProvider(
        [{ language: 'textures' }],
        {
            provideHover(document, position) {
                const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_]*/);
                if (!wordRange) { return null; }
                const word = document.getText(wordRange);

                const entry = findKeywordCaseInsensitive(keywordsData, word);
                if (entry) {
                    return new vscode.Hover(buildKeywordHover(entry[0], entry[1]), wordRange);
                }

                const lowerWord = word.toLowerCase();
                if (STYLE_DESCRIPTIONS[lowerWord]) {
                    const md = new vscode.MarkdownString();
                    md.appendCodeblock(word, 'textures');
                    md.appendMarkdown(`\n\n${STYLE_DESCRIPTIONS[lowerWord]}`);
                    return new vscode.Hover(md, wordRange);
                }

                if (TRANSLATION_DESCRIPTIONS[lowerWord]) {
                    const md = new vscode.MarkdownString();
                    md.appendCodeblock(word, 'textures');
                    md.appendMarkdown(`\n\n${TRANSLATION_DESCRIPTIONS[lowerWord]}`);
                    return new vscode.Hover(md, wordRange);
                }

                return null;
            }
        }
    );

    context.subscriptions.push(provider);
}

function buildKeywordHover(name: string, data: TexturesKeywordData): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.isTrusted = true;

    const params = Array.isArray(data.params) ? data.params : [];
    md.appendCodeblock(buildSignature(name, params), 'textures');

    if (data.desc) {
        md.appendMarkdown(`\n\n${data.desc}\n`);
    }

    md.appendMarkdown(`\n\n**Context:** ${contextLabel(data.category)}\n`);

    if (params.length > 0) {
        md.appendMarkdown('\n**Parameters:**\n');
        for (const p of params) {
            const opt = p.optional ? ' *(optional)*' : '';
            md.appendMarkdown(`- \`${p.name}\`: ${p.type}${opt}\n`);
            if (p.mode === 'enum' && p.enum) {
                for (const e of p.enum) {
                    md.appendMarkdown(`  - \`${e.name}\`\n`);
                }
            }
        }
    }

    if (data.children && data.children.length > 0) {
        md.appendMarkdown(`\n**Valid child properties:**\n${data.children.join(', ')}\n`);
    }

    if (data.example) {
        md.appendMarkdown('\n**Example:**\n');
        md.appendCodeblock(data.example, 'textures');
    }

    return md;
}

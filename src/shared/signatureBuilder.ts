import { ParamData } from './dataLoader';

/** Non-zero defaults are stored in metadata; zero defaults are intentionally absent. */
function defaultSuffix(param: ParamData): string {
    return param.default !== undefined ? ` = ${param.default}` : '';
}

export function buildSignature(functionName: string, params?: ParamData[]): string {
    if (!Array.isArray(params) || params.length === 0) {
        return `${functionName}()`;
    }

    const paramStrings = params.map((param) => {
        const typeAndName = `${param.type} ${param.name}${defaultSuffix(param)}`;
        return param.optional ? `[${typeAndName}]` : typeAndName;
    });

    return `${functionName}(${paramStrings.join(', ')})`;
}

export function buildSignatureLabel(functionName: string, params?: ParamData[]): string {
    return buildSignature(functionName, params);
}

export function formatCompletionDetail(params?: ParamData[]): string {
    if (!Array.isArray(params) || params.length === 0) {
        return '()';
    }

    const paramStrings = params
        .filter(p => typeof p === 'object')
        .map(p => p.optional
            ? `[${p.name}: ${p.type}${defaultSuffix(p)}]`
            : `${p.name}: ${p.type}${defaultSuffix(p)}`);

    return `(${paramStrings.join(', ')})`;
}

export function buildParamLabel(param: ParamData): string {
    const base = param.optional
        ? `[${param.name}: ${param.type}${defaultSuffix(param)}]`
        : `${param.name}: ${param.type}${defaultSuffix(param)}`;

    if (param.mode === 'bitmask') {
        return `${base} (bitmask)`;
    } else if (param.mode === 'enum') {
        return `${base} (enum)`;
    }

    return base;
}

export function buildParamDocumentation(param: ParamData): string {
    let doc = `**Parameter:** ${param.name}\n\n`;
    doc += `**Type:** \`${param.type}\`\n\n`;

    if (param.optional) {
        doc += `**Optional:** Yes\n\n`;
    }

    if (param.default !== undefined) {
        doc += `**Default:** \`${param.default}\`\n\n`;
    }

    if (param.mode === 'bitmask' && Array.isArray(param.enum)) {
        doc += `**Mode:** Bitmask (combinable with |)\n\n`;
        doc += `**Values:**\n`;
        param.enum.forEach((v) => {
            doc += `- \`${v.name}\` = ${v.value}\n`;
        });
    } else if (param.mode === 'enum' && Array.isArray(param.enum)) {
        doc += `**Mode:** Enum (single choice)\n\n`;
        doc += `**Values:**\n`;
        param.enum.forEach((v) => {
            doc += `- \`${v.name}\` = ${v.value}\n`;
        });
    }

    return doc;
}

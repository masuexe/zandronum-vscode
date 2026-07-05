import { ActionData, findActionCaseInsensitive } from '../../../../shared/dataLoader';

export type CompletionMode = 'enum' | 'flags';

export interface FunctionRepository {
    find(name: string): ActionData | undefined;
    findByPrefix(prefix: string): Array<{ name: string; data: ActionData }>;
    getParamMode(fnName: string, paramIndex: number): CompletionMode | null;
}

export function createFunctionRepository(
    functionsData: Record<string, ActionData>
): FunctionRepository {
    const entries = Object.entries(functionsData);

    return {
        find(name: string) {
            return findActionCaseInsensitive(functionsData, name);
        },

        findByPrefix(prefix: string) {
            if (!prefix) return [];
            const lower = prefix.toLowerCase();
            const result: Array<{ name: string; data: ActionData }> = [];
            for (const [name, data] of entries) {
                if (name.toLowerCase().startsWith(lower)) {
                    result.push({ name, data });
                }
            }
            return result;
        },

        getParamMode(fnName: string, paramIndex: number): CompletionMode | null {
            const action = this.find(fnName);
            if (!action || !Array.isArray(action.params)) return null;
            const param = action.params[paramIndex] as any;
            if (!param || !param.mode) return null;
            if (param.mode === 'bitmask') return 'flags';
            if (param.mode === 'enum') return 'enum';
            return null;
        },
    };
}

import { AcsConstantData } from '../../../../shared/dataLoader';

export interface ConstantRepository {
    find(name: string): AcsConstantData | undefined;
    findByPrefix(prefix: string): Array<{ name: string; data: AcsConstantData }>;
}

export function createConstantRepository(
    constantsData: Record<string, AcsConstantData>
): ConstantRepository {
    const entries = Object.entries(constantsData);

    return {
        find(name: string) {
            const key = Object.keys(constantsData).find(
                k => k.toLowerCase() === name.toLowerCase()
            );
            return key ? constantsData[key] : undefined;
        },

        findByPrefix(prefix: string) {
            if (!prefix) return [];
            const lower = prefix.toLowerCase();
            const result: Array<{ name: string; data: AcsConstantData }> = [];
            for (const [name, data] of entries) {
                if (name.toLowerCase().startsWith(lower)) {
                    result.push({ name, data });
                }
            }
            return result;
        },
    };
}

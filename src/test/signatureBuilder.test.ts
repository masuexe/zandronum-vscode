import * as assert from 'assert';
import {
    buildParamDocumentation,
    buildParamLabel,
    buildSignature,
    formatCompletionDetail,
} from '../shared/signatureBuilder';
import { ParamData } from '../shared/dataLoader';

suite('signatureBuilder - defaults', () => {
    test('renders non-zero default in signature label', () => {
        const params: ParamData[] = [
            { name: 'amount', type: 'int' },
            { name: 'numrays', type: 'int', optional: true, default: '40' },
            { name: 'spraytype', type: 'string', optional: true, default: '"BFGExtra"' },
        ];
        assert.strictEqual(
            buildSignature('A_BFGSpray', params),
            'A_BFGSpray(int amount, [int numrays = 40], [string spraytype = "BFGExtra"])'
        );
    });

    test('omits default when absent', () => {
        const params: ParamData[] = [{ name: 'angle', type: 'float', optional: true }];
        assert.strictEqual(buildSignature('A_Turn', params), 'A_Turn([float angle])');
    });

    test('completion detail and param label include default', () => {
        const p: ParamData = { name: 'mask', type: 'int', optional: true, default: '-1' };
        assert.strictEqual(formatCompletionDetail([p]), '([mask: int = -1])');
        assert.strictEqual(buildParamLabel(p), '[mask: int = -1]');
    });

    test('param documentation lists default', () => {
        const p: ParamData = { name: 'numrays', type: 'int', optional: true, default: '40' };
        assert.ok(buildParamDocumentation(p).includes('**Default:** `40`'));
    });

    test('return type prefixes signature and completion detail', () => {
        assert.strictEqual(buildSignature('Delay', [{ name: 'tics', type: 'int' }], 'void'), 'void Delay(int tics)');
        assert.strictEqual(buildSignature('Random', [{ name: 'min', type: 'int' }, { name: 'max', type: 'int' }], 'int'), 'int Random(int min, int max)');
        assert.strictEqual(formatCompletionDetail([], 'void'), 'void ()');
        assert.strictEqual(formatCompletionDetail([{ name: 'x', type: 'int' }], 'fixed'), 'fixed (x: int)');
        // Omit returns → unchanged for DECORATE
        assert.strictEqual(buildSignature('A_Turn', [{ name: 'angle', type: 'float', optional: true }]), 'A_Turn([float angle])');
    });
});

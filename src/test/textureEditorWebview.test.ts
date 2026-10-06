import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

class ElementStub {
    children: ElementStub[] = [];
    textContent = '';
    className = '';
    scrollTop = 0;
    style = {};
    clientWidth = 640;
    clientHeight = 480;
    set innerHTML(_value: string) { this.children = []; }
    appendChild(child: ElementStub): void { this.children.push(child); }
    addEventListener(): void {}
    scrollIntoView(): void {}
    getBoundingClientRect() { return { width: 640, height: 480, left: 0, top: 0 }; }
    getContext() { return new Proxy({}, { get: () => () => undefined }); }
}

function webview() {
    const elements = new Map<string, ElementStub>();
    let onMessage!: (event: { data: unknown }) => void;
    const script = fs.readFileSync(path.resolve(__dirname, '../../media/textureEditor.js'), 'utf8');
    vm.runInNewContext(script, {
        acquireVsCodeApi: () => ({ postMessage() {} }),
        devicePixelRatio: 1,
        console,
        document: {
            getElementById(id: string) {
                if (!elements.has(id)) { elements.set(id, new ElementStub()); }
                return elements.get(id);
            },
            createElement: () => new ElementStub(),
            createTextNode: () => new ElementStub()
        },
        window: {
            addEventListener(type: string, listener: typeof onMessage) {
                if (type === 'message') { onMessage = listener; }
            }
        }
    });
    const texture = (name: string, width = 16) => ({
        name, width, height: 16, textureType: 'sprite', patches: [],
        offsetX: 0, offsetY: 0, xScale: 1, yScale: 1, revision: 1
    });
    const send = (data: unknown) => onMessage({ data });
    send({ type: 'init', textures: ['8h60a0', 'OTHER'], selected: texture('8h60a0') });
    return {
        send, texture,
        names: () => elements.get('texture-list')!.children.map(child => child.textContent),
        selected: () => elements.get('texture-list')!.children.filter(child => child.className.includes('selected')).map(child => child.textContent),
        width: () => (elements.get('tex-width') as unknown as { value: number }).value
    };
}

suite('Texture editor webview — list synchronization', () => {
    test('texture-only updates preserve the existing list and update the inspector', () => {
        const view = webview();
        view.send({ type: 'updateTexture', texture: view.texture('8h60a0', 32) });
        assert.deepStrictEqual(view.names(), ['8h60a0', 'OTHER']);
        assert.deepStrictEqual(view.selected(), ['8h60a0']);
        assert.strictEqual(view.width(), 32);
    });

    test('rename updates the list and selection together', () => {
        const view = webview();
        view.send({ type: 'updateTexture', textures: ['8h60b0', 'OTHER'], texture: view.texture('8h60b0') });
        assert.deepStrictEqual(view.names(), ['8h60b0', 'OTHER']);
        assert.deepStrictEqual(view.selected(), ['8h60b0']);
        view.send({ type: 'updateTexture', texture: view.texture('8h60b0', 64) });
        assert.deepStrictEqual(view.names(), ['8h60b0', 'OTHER']);
        assert.strictEqual(view.width(), 64);
    });
});

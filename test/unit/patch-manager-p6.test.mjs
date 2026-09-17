import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PatchManager } = require('../../src/managers/patchManager.js');

describe('P6: UI 层 BYOK 模型注入', () => {
    it('byokUiModelEntries 返回 4 个条目', () => {
        const entries = PatchManager.byokUiModelEntries();
        assert.equal(entries.length, 4);
        assert.equal(entries[0].uid, 'MODEL_CLAUDE_4_OPUS_BYOK');
        assert.equal(entries[0].label, 'Claude Opus 4 BYOK');
        assert.equal(entries[3].uid, 'MODEL_CLAUDE_4_SONNET_THINKING_BYOK');
    });

    it('buildByokConfigObject 包含所有 c8 字段', () => {
        const obj = PatchManager.buildByokConfigObject('Test', 'MODEL_TEST');
        assert.ok(obj.includes('label:"Test"'));
        assert.ok(obj.includes('modelUid:"MODEL_TEST"'));
        assert.ok(obj.includes('disabled:!1'));
        assert.ok(obj.includes('supportsImages:!0'));
        assert.ok(obj.includes('allowedTiers:[]'));
        assert.ok(obj.includes('modelDimensions:[]'));
        assert.ok(obj.includes('complianceLevels:[]'));
        assert.ok(obj.includes('creditMultiplier:0'));
        assert.ok(obj.includes('pricingType:0'));
        assert.ok(obj.includes('provider:0'));
        assert.ok(obj.includes('apiProvider:0'));
        assert.ok(obj.includes('maxTokens:0'));
    });

    it('buildByokConfigsString 生成 4 个逗号分隔的对象', () => {
        const str = PatchManager.buildByokConfigsString();
        const count = (str.match(/\{label:/g) || []).length;
        assert.equal(count, 4);
    });

    it('buildByokSortString 包含 BYOK 分组和 4 个 modelLabels', () => {
        const str = PatchManager.buildByokSortString();
        assert.ok(str.includes('name:"BYOK"'));
        assert.ok(str.includes('groupName:"BYOK"'));
        const labelCount = (str.match(/modelLabels:\[/g) || []).length;
        assert.equal(labelCount, 1);
        assert.ok(str.includes('"Claude Opus 4 BYOK"'));
        assert.ok(str.includes('"Claude Sonnet 4 Thinking BYOK"'));
    });

    it('chatClientPatchRegex 匹配 windsurf-chat-client 变量名 (o=r, s=r)', () => {
        const regex = PatchManager.chatClientPatchRegex();
        const sample = 'o=r?.clientModelConfigs||[],s=r?.clientModelSorts||[]';
        assert.ok(regex.test(sample));
    });

    it('chatClientPatchRegex 匹配 sessions 变量名 (Z6=am, Qv=am)', () => {
        const regex = PatchManager.chatClientPatchRegex();
        const sample = 'Z6=am?.clientModelConfigs||[],Qv=am?.clientModelSorts||[]';
        assert.ok(regex.test(sample));
    });

    it('chatClientPatchRegex 捕获组正确', () => {
        const regex = PatchManager.chatClientPatchRegex();
        const sample = 'o=r?.clientModelConfigs||[],s=r?.clientModelSorts||[]';
        const match = regex.exec(sample);
        assert.equal(match[1], 'o');
        assert.equal(match[2], 'r');
        assert.equal(match[3], 's');
    });

    it('chatClientPatchedRegex 检测已注入代码', () => {
        const regex = PatchManager.chatClientPatchedRegex();
        const patched = 'o=(r?.clientModelConfigs||[]).concat([{label:"Test"}]),s=...';
        assert.ok(regex.test(patched));
    });

    it('chatClientPatchedRegex 对未注入代码 → false', () => {
        const regex = PatchManager.chatClientPatchedRegex();
        const original = 'o=r?.clientModelConfigs||[],s=r?.clientModelSorts||[]';
        assert.equal(regex.test(original), false);
    });

    it('注入后代码语法正确 (eval 不抛)', () => {
        const regex = PatchManager.chatClientPatchRegex();
        const original = 'o=r?.clientModelConfigs||[],s=r?.clientModelSorts||[]';
        const match = regex.exec(original);
        const configs = PatchManager.buildByokConfigsString();
        const sort = PatchManager.buildByokSortString();
        const patched = match[1] + '=(' + match[2] + '?.clientModelConfigs||[]).concat([' + configs + ']),' + match[3] + '=(' + match[2] + '?.clientModelSorts||[]).concat([' + sort + '])';

        const fullCode = 'var r=void 0;var ' + patched + ';';
        assert.doesNotThrow(() => new Function(fullCode));
    });

    it('注入后 BYOK 模型在 r=undefined 时仍存在', () => {
        const regex = PatchManager.chatClientPatchRegex();
        const original = 'o=r?.clientModelConfigs||[],s=r?.clientModelSorts||[]';
        const match = regex.exec(original);
        const configs = PatchManager.buildByokConfigsString();
        const sort = PatchManager.buildByokSortString();
        const patched = 'var r=void 0;var ' + match[1] + '=(' + match[2] + '?.clientModelConfigs||[]).concat([' + configs + ']),' + match[3] + '=(' + match[2] + '?.clientModelSorts||[]).concat([' + sort + ']);';

        const fn = new Function(patched + ' return o.length;');
        const len = fn();
        assert.equal(len, 4);
    });
});
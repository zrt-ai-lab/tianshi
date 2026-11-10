import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { parseDefaultModel } from '../core/modelconfig.mjs';

test('模型 id 带斜杠时完整读取（曾被截断成「anthropic」导致 AI 分析失败）', () => {
  const yml = `- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: zyuncs-anthropic
    model: anthropic/claude-opus-5.5-cpr
- id: llm-pi-ai
  config:
    providers:
      zyuncs:
        models:
          - id: deepseek/deepseek-v4.1-flash
`;
  assert.deepEqual(parseDefaultModel(yml), { provider: 'zyuncs-anthropic', model: 'anthropic/claude-opus-5.5-cpr' });
});

test('只读 agent-default-model 段，不被其他段的 provider / model 干扰', () => {
  const yml = `- id: other
  config:
    provider: wrong
    model: wrong-model
- id: agent-default-model
  config:
    provider: deepseek-account
    model: deepseek-flash
`;
  assert.deepEqual(parseDefaultModel(yml), { provider: 'deepseek-account', model: 'deepseek-flash' });
});

test('带引号与行尾注释', () => {
  const yml = `- id: "agent-default-model"
  config:
    provider: "zyuncs"  # 网关
    model: 'qwen/qwen3.8-max'
`;
  assert.deepEqual(parseDefaultModel(yml), { provider: 'zyuncs', model: 'qwen/qwen3.8-max' });
});

test('没有该段时返回 null，由调用方走兜底', () => {
  assert.equal(parseDefaultModel('- id: x\n  config: {}\n'), null);
});

test('当前本机 desktop profile 能解析出完整模型 id', { skip: !existsSync(`${homedir()}/.dsh/profiles/desktop/cordis.patch.yml`) }, () => {
  const r = parseDefaultModel(readFileSync(`${homedir()}/.dsh/profiles/desktop/cordis.patch.yml`, 'utf8'));
  assert.ok(r && r.provider && r.model);
  assert.notEqual(r.model, 'anthropic');
});

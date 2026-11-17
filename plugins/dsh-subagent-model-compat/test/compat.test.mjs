import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { adaptDefinition, applyWithCompatibility, normalizeEmptyRouteFields } from '../lib/compat.js';

// Resolve all official packages from one running installation, never mixed copies.
const runtimeRequire = createRequire(process.env.DSH_INSTALL_DIR
  ? path.join(process.env.DSH_INSTALL_DIR, 'package.json')
  : import.meta.url);
const load = id => import(pathToFileURL(runtimeRequire.resolve(id)).href);
const [{ Context }, { ToolsService, defineTool }, { createScope }, official, { NativeToolExecutor }] = await Promise.all([
  load('@deepseek-ai/cordis'), load('@deepseek-ai/dsh-tools'), load('@deepseek-ai/dsh-scope'),
  load('@deepseek-ai/dsh-tool-subagent'), load('@deepseek-ai/dsh-tool-executor-native'),
]);
const config = { provider: 'spawn', toolName: 'subagent', modelSelection: true, modelDiscovery: true };
const route = { provider: 'authorized', model: 'flash' };
const signal = () => new AbortController().signal;
const textOf = result => result.content.map(block => block.text ?? '').join('\n');

async function fixture(t, { policy = [route], present = true } = {}) {
  const ctx = new Context();
  const sections = new Map();
  const contexts = new Map();
  ctx.provide('systemPrompt', {
    tools() {},
    section(section) { sections.set(section.name, section); return () => sections.delete(section.name); },
    context(section) { contexts.set(section.name, section); return () => contexts.delete(section.name); },
    getSectionOrder: () => 1, getContextOrder: () => 1,
  });
  const activations = [];
  const resolutions = [];
  let provider = present ? {
    name: 'spawn', inheritsParentContext: false,
    capabilities: { agentOptions: true, depthLimit: true, agentPreset: true },
  } : undefined;
  ctx.provide('subagents', {
    getProvider: name => name === 'spawn' ? provider : undefined,
    resolveMaxDepth: value => value === 'provider-managed' ? undefined : value ?? 2,
    async startActivation(request) { activations.push(request); return { name: request.name ?? 'test-child' }; },
  });
  ctx.provide('sessionProjections', { async register() { return { stateOf: session => session.policy }; } });
  const modelInfo = (id = 'flash') => ({
    id, name: id, reasoning: { defaultEffort: 'high', efforts: [{ id: 'high', name: 'High' }] },
  });
  ctx.provide('llm', {
    listProviders: () => [{ id: 'authorized', name: 'Authorized' }, { id: 'hidden', name: 'Hidden' }],
    listModels: async () => [modelInfo(), modelInfo('not-authorized')],
    resolveModelInfo: async (_provider, model) => modelInfo(model),
    async resolveCallConfig(selection) { resolutions.push(selection); return selection; },
  });
  ctx.plugin(ToolsService);
  await ctx.fiber.await();
  ctx.tools.setExecutor(new NativeToolExecutor(ctx));
  let host;
  const hostFiber = ctx.plugin({
    name: 'compat-test-host', inject: ['tools', 'systemPrompt', 'subagents', 'sessionProjections', 'llm'],
    apply(context) { host = context; },
  });
  await hostFiber.await();
  const presetKey = {};
  const preset = createScope(host, presetKey);
  await preset.ctx.fiber.await();
  const agent = {
    options: { provider: 'parent', model: 'parent-model', reasoningEffort: 'high' },
    session: { policy, header: { delegationDepth: 0 }, requestHeader: () => undefined },
  };
  const agentScope = createScope(host, agent, { parent: presetKey });
  await agentScope.ctx.fiber.await();
  await applyWithCompatibility(preset.ctx, config, official.apply);
  let disposed = false;
  async function dispose() {
    if (disposed) return;
    disposed = true;
    await agentScope.dispose();
    await preset.dispose();
    await ctx.fiber.dispose();
  }
  t.after(dispose);
  let callId = 0;
  async function invoke(name, args, toolSet) {
    const result = await ctx.tools.execute({
      calls: [{ type: 'tool-call', id: `call-${++callId}`, name, arguments: JSON.stringify(args) }],
      signal: signal(), agent, ...(toolSet ? { toolSet } : {}),
    });
    return result.results[0].result;
  }
  return {
    ctx, preset, presetKey, agent, agentScope, activations, resolutions, sections, contexts, invoke, dispose,
    async removeProvider() { provider = undefined; await ctx.parallel('subagent/provider-removed', 'spawn'); },
    async addProvider() {
      provider = { name: 'spawn', inheritsParentContext: false, capabilities: { agentOptions: true, depthLimit: true } };
      await ctx.parallel('subagent/provider-added', provider);
    },
  };
}

test('bundle overrides exactly the shipped presets with only spawn wrapping and skill-anchor changes', async () => {
  const { entryListSchema } = await load('@deepseek-ai/cordis-plugin-include');
  const includeRequire = createRequire(runtimeRequire.resolve('@deepseek-ai/cordis-plugin-include'));
  const yaml = includeRequire('js-yaml');
  const parse = source => yaml.load(source, { schema: entryListSchema });
  const patch = parse(readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8'));
  const webRoot = path.dirname(runtimeRequire.resolve('@deepseek-ai/dsh-web-app/package.json'));
  assert.deepEqual(patch.map(row => row.id), ['preset-standard', 'preset-ptc', 'preset-cordis']);
  let rewrites = 0;
  let skillAnchors = 0;
  function adaptExpected(node) {
    if (Array.isArray(node)) return node.map(adaptExpected);
    if (node === null || typeof node !== 'object') return node;
    const copy = Object.fromEntries(Object.entries(node).map(([key, value]) => [key, adaptExpected(value)]));
    if (copy.name === '@deepseek-ai/dsh-tool-subagent' && copy.config?.provider === 'spawn') {
      copy.name = 'dsh-subagent-model-compat';
      rewrites++;
    }
    if (typeof copy.__jsExpr === 'string' && copy.__jsExpr.includes('createRequire(baseUrl)')) {
      copy.__jsExpr = copy.__jsExpr.replace('createRequire(baseUrl)',
        "createRequire(process.getBuiltinModule('node:path').join(process.env.DSH_INSTALL_DIR, 'package.json'))");
      skillAnchors++;
    }
    return copy;
  }
  for (const id of ['standard', 'ptc', 'cordis']) {
    const officialPatch = parse(readFileSync(path.join(webRoot, 'presets', `${id}.patch.yml`), 'utf8'));
    const expected = adaptExpected(officialPatch[0].insert[0]);
    assert.deepEqual(patch.find(row => row.id === `preset-${id}`), expected, `${id} preserves all unrelated official config`);
  }
  assert.equal(rewrites, 3);
  assert.equal(skillAnchors, 2);
  function expressions(node) {
    if (node === null || typeof node !== 'object') return [];
    if ('__jsExpr' in node) return [node.__jsExpr];
    return Object.values(node).flatMap(expressions);
  }
  const expectedSkills = path.join(path.dirname(runtimeRequire.resolve('@deepseek-ai/dsh-agent-preset/package.json')), 'skills');
  const skillExpressions = expressions(patch).filter(source => source.includes('dsh-agent-preset/package.json'));
  assert.equal(skillExpressions.length, 2);
  for (const expression of skillExpressions) {
    const actual = new Function('process', `return (${expression});`)(process);
    assert.equal(actual, expectedSkills);
    assert.equal(statSync(actual).isDirectory(), true);
  }
});

test('public wrapper exports the exact installed official Config and injection requirements', async () => {
  const wrapper = await import('../index.js');
  assert.equal(wrapper.Config, official.Config);
  assert.equal(wrapper.inject, official.inject);
});

function assertError(result, pattern) {
  assert.equal(result.isError, true, textOf(result));
  assert.match(textOf(result), pattern);
}

test('normalization copies only exact empty own route fields and preserves frozen originals', () => {
  const original = Object.freeze({ provider: '', model: '', reasoning_effort: '', unrelated: '' });
  const normalized = normalizeEmptyRouteFields(original, ['provider', 'model']);
  assert.deepEqual(normalized, { reasoning_effort: '', unrelated: '' });
  assert.notEqual(normalized, original);
  assert.deepEqual(original, { provider: '', model: '', reasoning_effort: '', unrelated: '' });
  for (const candidate of [null, [], false, '']) {
    assert.equal(normalizeEmptyRouteFields(candidate, ['provider']), candidate);
  }
  const malformed = Object.freeze({ provider: ' ', model: null, reasoning_effort: false });
  assert.equal(normalizeEmptyRouteFields(malformed, ['provider', 'model', 'reasoning_effort']), malformed);
});

test('adaptation preserves definition identity, exec identity, and unrelated tools', async () => {
  const raw = Object.freeze({ provider: '', model: '' });
  const exec = Object.freeze({ arguments: raw, signal: signal() });
  let received;
  const definition = { name: 'list_subagent_models', description: 'Omit optional fields rather than sending empty strings.',
    async execute(args, execution) { received = { args, execution }; return 'ok'; } };
  const before = definition.execute;
  assert.equal(adaptDefinition(definition, config), definition);
  const adaptedExecute = definition.execute;
  assert.notEqual(adaptedExecute, before);
  adaptDefinition(definition, config);
  assert.equal(definition.execute, adaptedExecute, 'no double-wrapping on repeated registration');
  assert.equal(await definition.execute(raw, exec), 'ok');
  assert.deepEqual(received.args, {});
  assert.equal(received.execution, exec);
  assert.equal(exec.arguments, raw);
  const unrelated = { name: 'other', description: '', execute: before };
  assert.equal(adaptDefinition(unrelated, config), unrelated);
  assert.equal(unrelated.execute, before);
  const fork = { name: 'subagent_fork', description: '', execute: before };
  adaptDefinition(fork, { toolName: 'subagent_fork', modelSelection: false });
  assert.equal(fork.execute, before);
});

test('facade returns the exact official registration disposer without changing the shared service', async () => {
  const disposer = () => {};
  const options = { when: () => false };
  const definition = { name: 'list_subagent_models', description: '', async execute() {} };
  const tools = { register(received, receivedOptions) {
    assert.equal(received, definition);
    assert.equal(receivedOptions, options);
    return disposer;
  }, get() {} };
  const register = tools.register;
  const ctx = { tools, extend(meta) { return Object.assign(Object.create(this), meta); } };
  const returned = await applyWithCompatibility(ctx, config, wrapped => wrapped.tools.register(definition, options));
  assert.equal(returned, disposer);
  assert.equal(ctx.tools, tools);
  assert.equal(tools.register, register);
});

test('official discovery and deferred provider registration remain independently lifecycle-owned', async t => {
  const f = await fixture(t, { present: false });
  assert.equal(f.ctx.tools.get('subagent', f.agent), undefined);
  assert.equal((await f.invoke('list_subagent_models', { provider: '', model: '' })).value, 'authorized — Authorized');
  await f.addProvider();
  const result = await f.invoke('subagent', { description: 'Test', prompt: 'Test', ...route, reasoning_effort: '' });
  assert.equal(result.isError, false, textOf(result));
  assert.equal(f.activations.length, 1);
});

test('official discovery accepts empty filters while exposing only authorized routes', async t => {
  const f = await fixture(t);
  const all = await f.invoke('list_subagent_models', { provider: '', model: '' });
  assert.equal(all.isError, false, textOf(all));
  assert.equal(all.value, 'authorized — Authorized');
  const models = await f.invoke('list_subagent_models', { provider: 'authorized', model: '' });
  assert.equal(models.isError, false, textOf(models));
  assert.equal(models.value, 'authorized/flash — flash');
  const efforts = await f.invoke('list_subagent_models', route);
  assert.match(efforts.value, /high \(default\)/);
  assertError(await f.invoke('list_subagent_models', { provider: '', model: 'flash' }), /model.*requires.*provider/);
  assertError(await f.invoke('list_subagent_models', { provider: 'hidden', model: '' }), /not allowed/);
  assertError(await f.invoke('list_subagent_models', { provider: 'authorized', model: 'not-authorized' }), /not allowed/);
  assertError(await f.invoke('list_subagent_models', { provider: null, model: '' }), /string|type/i);
  assertError(await f.invoke('list_subagent_models', { provider: ' ', model: '' }), /not allowed/);
  assert.equal(f.activations.length, 0);
});

test('official spawn preserves defaults, validates partial selections and authorization', async t => {
  const f = await fixture(t);
  const base = { description: 'Test delegation', prompt: 'No real child is launched.' };
  const inherited = await f.invoke('subagent', { ...base, provider: '', model: '', reasoning_effort: '' });
  assert.equal(inherited.isError, false, textOf(inherited));
  assert.equal(f.activations.length, 1);
  assert.equal(Object.hasOwn(f.activations[0], 'agentOptions'), false, 'empty fields preserve native inheritance');
  assert.equal(f.resolutions.length, 0, 'implicit route does not become an explicit selection');
  const selected = await f.invoke('subagent', { ...base, ...route, reasoning_effort: '' });
  assert.equal(selected.isError, false, textOf(selected));
  assert.deepEqual(f.activations[1].agentOptions, { ...route, reasoningEffort: undefined });
  assert.deepEqual(f.resolutions[0], route, 'omitted effort uses selected model default');
  for (const fields of [{ provider: 'authorized', model: '' }, { provider: '', model: 'flash' },
    { provider: '', model: '', reasoning_effort: 'high' }]) {
    assertError(await f.invoke('subagent', { ...base, ...fields }), /must be supplied together|requires both/);
  }
  assertError(await f.invoke('subagent', { ...base, provider: 'hidden', model: 'flash', reasoning_effort: '' }), /not allowed/);
  assert.equal(f.activations.length, 2, 'failed calls never reach activation service');
});

test('no recorded policy retains official parent-only explicit route restriction', async t => {
  const f = await fixture(t, { policy: undefined });
  // Passing undefined to an option with a default would restore the fixture policy.
  f.agent.session.policy = undefined;
  assertError(await f.invoke('subagent', { description: 'Test', prompt: 'Test', ...route, reasoning_effort: '' }),
    /without a recorded model-selection policy/);
  assert.equal(f.activations.length, 0);
});

test('pipeline policies see original frozen raw arguments and cannot be mutated by compatibility', async t => {
  const f = await fixture(t);
  let preArgs;
  let postArgs;
  f.ctx.on('tools/pre-execute', async (exec, next) => {
    preArgs = exec.arguments;
    assert.equal(Object.isFrozen(preArgs), true);
    assert.deepEqual(preArgs, { provider: '', model: '' });
    return next();
  });
  f.ctx.on('tools/post-execute', async (exec, _result, next) => { postArgs = exec.arguments; return next(); });
  const result = await f.invoke('list_subagent_models', { provider: '', model: '' });
  assert.equal(result.isError, false, textOf(result));
  assert.equal(postArgs, preArgs);
  assert.deepEqual(postArgs, { provider: '', model: '' });
});

test('preset registration respects agent restrictions without same-scope shadowing', async t => {
  const f = await fixture(t);
  const original = f.ctx.tools.get('subagent', f.agent);
  const restore = f.agentScope.ctx.tools.restrict({ deny: ['subagent', 'list_subagent_models'] });
  assert.equal(f.ctx.tools.get('subagent', f.agent), undefined);
  assert.equal(f.ctx.tools.get('list_subagent_models', f.agent), undefined);
  assert.equal(f.ctx.tools.get('subagent', f.presetKey), original, 'preset remains available in its own scope');
  assertError(await f.invoke('subagent', { description: 'Test', prompt: 'Test', provider: '', model: '', reasoning_effort: '' }), /unknown|not found|not available/i);
  assert.equal(f.activations.length, 0);
  restore();
  assert.equal(f.ctx.tools.get('subagent', f.agent), original);
});

test('registration facade preserves conditions, original disposer and definition identity', async t => {
  const f = await fixture(t);
  let allow = false;
  let unregister;
  const definition = defineTool({ name: 'conditional_subagent', description: 'Conditional',
    parameters: { provider: { type: 'string' } }, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args) { return JSON.stringify(args); },
  });
  const localConfig = { toolName: definition.name, modelSelection: true };
  await applyWithCompatibility(f.preset.ctx, localConfig, async wrapped => {
    unregister = wrapped.tools.register(definition, { when: () => allow });
  });
  assert.equal(f.ctx.tools.get(definition.name, f.agent), definition);
  assert.equal(f.ctx.tools.executable(definition.name, f.agent), undefined, 'conditional tool requires step admission');
  const denied = await f.ctx.tools.resolve({ agent: f.agent, modelSelection: route, signal: signal() });
  assert.equal(f.ctx.tools.executable(definition.name, f.agent, denied), undefined);
  assertError(await f.invoke(definition.name, { provider: '' }, denied), /unknown|not found|not available/i);
  allow = true;
  const admitted = await f.ctx.tools.resolve({ agent: f.agent, modelSelection: route, signal: signal() });
  assert.equal(f.ctx.tools.executable(definition.name, f.agent, admitted), definition);
  const result = await f.invoke(definition.name, { provider: '' }, admitted);
  assert.equal(result.isError, false, textOf(result));
  assert.equal(result.value, '{}');
  unregister();
  assert.equal(f.ctx.tools.executable(definition.name, f.agent, admitted), undefined, 'old admission cannot revive removed registration');
  assert.equal(f.ctx.tools.get(definition.name, f.agent), undefined);
  denied.dispose(); admitted.dispose();
});

test('official provider remove/add and owning-scope disposal remove every wrapped registration', async t => {
  const f = await fixture(t);
  const initial = f.ctx.tools.get('subagent', f.agent);
  const admission = await f.ctx.tools.resolve({ agent: f.agent, modelSelection: route, signal: signal() });
  await f.removeProvider();
  assert.equal(f.ctx.tools.get('subagent', f.agent), undefined);
  assert.equal(f.ctx.tools.executable('subagent', f.agent, admission), undefined);
  assert.ok(f.ctx.tools.get('list_subagent_models', f.agent), 'discovery lives with official plugin, independently of provider');
  await f.addProvider();
  const remounted = f.ctx.tools.get('subagent', f.agent);
  assert.ok(remounted);
  assert.notEqual(remounted, initial);
  const result = await f.invoke('subagent', { description: 'Test', prompt: 'Test', provider: '', model: '', reasoning_effort: '' });
  assert.equal(result.isError, false, textOf(result));
  await f.preset.dispose();
  assert.equal(f.ctx.tools.get('subagent', f.agent), undefined);
  assert.equal(f.ctx.tools.get('list_subagent_models', f.agent), undefined);
  await f.removeProvider(); await f.addProvider();
  assert.equal(f.ctx.tools.get('subagent', f.agent), undefined, 'disposed official listeners cannot resurrect a wrapper');
  admission.dispose();
});

test('official identity-sensitive delegation and depth guidance survives wrapping', async t => {
  const f = await fixture(t);
  const guide = f.sections.get('tool:subagent');
  assert.match(guide.text({ scope: f.agent }), /`subagent`/);
  f.agent.session.header.delegationDepth = 2;
  const depth = f.contexts.get('tool:subagent:depth');
  assert.match(depth.text({ scope: f.agent, agent: f.agent }), /current 2, maximum 2/);
  await f.removeProvider();
  assert.equal(guide.text({ scope: f.agent }), '');
  assert.equal(depth.text({ scope: f.agent, agent: f.agent }), '');
});

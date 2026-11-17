// Normalize only the documented optional route fields. Preserve the logged call,
// nonempty IDs, unrelated arguments, and malformed values for official validation.
export function normalizeEmptyRouteFields(args, fields) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return args;
  let normalized = args;
  for (const field of fields) {
    if (!Object.hasOwn(args, field) || args[field] !== '') continue;
    if (normalized === args) normalized = { ...args };
    delete normalized[field];
  }
  return normalized === args ? args : Object.freeze(normalized);
}

const adapted = new WeakSet();

// Keep the official definition's identity: its prompt/depth contributions check
// registry.get(...) === definition. Adapt only before its first registration.
export function adaptDefinition(definition, config) {
  if (adapted.has(definition)) return definition;
  const discovery = config.modelDiscovery === true && definition.name === 'list_subagent_models';
  const selection = config.modelSelection === true && definition.name === (config.toolName ?? 'subagent');
  if (!discovery && !selection) return definition;

  const fields = discovery ? ['provider', 'model'] : ['provider', 'model', 'reasoning_effort'];
  const execute = definition.execute;
  definition.execute = function (args, exec) {
    return execute.call(this, normalizeEmptyRouteFields(args, fields), exec);
  };
  if (discovery) {
    definition.description = definition.description.replace(
      'Omit optional fields rather than sending empty strings.',
      'Omitted or empty-string optional fields mean no filter. Start with no filters to discover authorized provider IDs; never guess route IDs.'
    );
  } else {
    definition.description += ' Empty-string route fields are treated as omitted. Before explicitly selecting a model, query list_subagent_models and use its exact provider/model IDs. A fork inherits its parent route and is not a fallback for choosing an authorized model.';
  }
  adapted.add(definition);
  return definition;
}

// A local context facade intercepts only this official plugin's registrations.
// It neither mutates the shared service nor shadows a tool in an Agent scope.
export function applyWithCompatibility(ctx, config, officialApply) {
  const tools = ctx.tools;
  const facade = {
    register(definition, options) {
      return tools.register(adaptDefinition(definition, config), options);
    },
    get(...args) {
      return tools.get(...args);
    },
  };
  return officialApply(ctx.extend({ tools: facade }), config);
}

import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

export const name = 'playwright-per-agent';
export const inject = ['agents', 'subagents'];

export async function apply(ctx, config = {}) {
  const runtimeRequire = createRequire(realpathSync(process.argv[1]));
  const client = await import(pathToFileURL(runtimeRequire.resolve('@deepseek-ai/dsh-mcp-client')).href);
  const sessions = new Map();

  const isRootAgent = (agent) => {
    try {
      return ctx.subagents.rootOf(agent) === agent;
    } catch {
      return false;
    }
  };

  const mount = async ({ agent }) => {
    if (!isRootAgent(agent) || sessions.has(agent)) return;
    try {
      const fiber = agent.ctx.plugin(client, {
        serverName: 'playwright',
        transport: 'streamable-http',
        url: config.url ?? 'http://127.0.0.1:8931/mcp',
        startupTimeoutMs: 5000,
        toolCallTimeoutMs: 60000,
        failOnStartupError: false
      });
      sessions.set(agent, fiber);
      await fiber;
    } catch (error) {
      const fiber = sessions.get(agent);
      sessions.delete(agent);
      await fiber?.dispose();
      ctx.logger.warn('Playwright MCP mount failed: %s', error?.message ?? String(error));
    }
  };

  ctx.effect(() => async () => {
    const fibers = [...sessions.values()];
    sessions.clear();
    await Promise.all(fibers.map(fiber => fiber.dispose()));
  }, 'dispose session Playwright clients');
  ctx.on('agent/created', mount);
  ctx.on('agent/disposed', ({ agent }) => { sessions.delete(agent); });
  await Promise.all(ctx.agents.list().map(agent => mount({ agent })));
}

export default { name, inject, apply };

import { Type } from '@sinclair/typebox';
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { findGitNexusIndex, safeResolvePath } from './gitnexus';
import { mcpClient } from './mcp-client';

function text(msg: string) {
  return { content: [{ type: 'text' as const, text: msg }], details: undefined };
}

const NO_INDEX = 'No GitNexus index found. Run: /gitnexus analyze';

/**
 * Register all GitNexus tools with pi.
 * Called once from index.ts — this is the only way tools.ts accesses pi.
 *
 * TypeBox `default` values (e.g. `default: 5`) are JSON Schema annotations for
 * agent documentation only. TypeBox does not inject them into params at runtime.
 * Omitted optional params become undefined and are stripped by JSON.stringify,
 * so the MCP server receives no value and applies its own defaults.
 *
 * Not exposed:
 *   gitnexus_cypher  — raw graph queries; too open-ended, bypasses all validation
 *   gitnexus_rename  — automated multi-file rename; high blast radius
 */
export function registerTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: 'gitnexus_list_repos',
    label: 'GitNexus List Repos',
    description: 'List all repositories indexed by GitNexus. Use first when multiple repos may be indexed.',
    parameters: Type.Object({}),
    execute: async (_id, _params, _signal, _onUpdate, ctx) => {
      const out = await mcpClient.callTool('list_repos', {}, ctx.cwd);
      return text(out || 'No indexed repositories found.');
    },
  });

  pi.registerTool({
    name: 'gitnexus_query',
    label: 'GitNexus Query',
    description: 'Search the knowledge graph for execution flows related to a concept or error.',
    parameters: Type.Object({
      query:           Type.String({ minLength: 1, maxLength: 200, pattern: '^[^-]' }),
      task_context:    Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
      goal:            Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
      limit:           Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 5 })),
      include_content: Type.Optional(Type.Boolean()),
    }),
    execute: async (_id, params, _signal, _onUpdate, ctx) => {
      if (!findGitNexusIndex(ctx.cwd)) return text(NO_INDEX);
      const out = await mcpClient.callTool('query', params as Record<string, unknown>, ctx.cwd);
      return text(out || 'No results.');
    },
  });

  pi.registerTool({
    name: 'gitnexus_context',
    label: 'GitNexus Context',
    description: '360-degree view of a code symbol: callers, callees, processes it participates in.',
    parameters: Type.Object({
      name:            Type.Optional(Type.String({ minLength: 1, maxLength: 200, pattern: '^[^-]' })),
      uid:             Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
      file:            Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
      include_content: Type.Optional(Type.Boolean()),
    }),
    execute: async (_id, params, _signal, _onUpdate, ctx) => {
      if (!findGitNexusIndex(ctx.cwd)) return text(NO_INDEX);
      if (!params.name && !params.uid) return text('Provide either name or uid.');
      // Validate file path server-side is handled by gitnexus, but guard here too.
      let args: Record<string, unknown> = params as Record<string, unknown>;
      if (params.file) {
        const safe = safeResolvePath(params.file, ctx.cwd);
        if (!safe) return text('Invalid file path.');
        args = { ...params, file: safe };
      }
      const out = await mcpClient.callTool('context', args, ctx.cwd);
      return text(out || 'No results.');
    },
  });

  pi.registerTool({
    name: 'gitnexus_impact',
    label: 'GitNexus Impact',
    description: 'Blast radius analysis: what breaks at each depth if you change a symbol.',
    parameters: Type.Object({
      target:        Type.String({ minLength: 1, maxLength: 200, pattern: '^[^-]' }),
      direction:     Type.Optional(Type.Union([
        Type.Literal('upstream'),
        Type.Literal('downstream'),
      ])),
      depth:         Type.Optional(Type.Integer({ minimum: 1, maximum: 10, default: 3 })),
      include_tests: Type.Optional(Type.Boolean()),
    }),
    execute: async (_id, params, _signal, _onUpdate, ctx) => {
      if (!findGitNexusIndex(ctx.cwd)) return text(NO_INDEX);
      const out = await mcpClient.callTool('impact', params as Record<string, unknown>, ctx.cwd);
      return text(out || 'No results.');
    },
  });

  pi.registerTool({
    name: 'gitnexus_detect_changes',
    label: 'GitNexus Detect Changes',
    description: "Map a git diff to affected execution flows. Pass the output of `git diff HEAD` to find what breaks.",
    parameters: Type.Object({
      diff: Type.String({ minLength: 1, maxLength: 50_000 }),
    }),
    execute: async (_id, params, _signal, _onUpdate, ctx) => {
      if (!findGitNexusIndex(ctx.cwd)) return text(NO_INDEX);
      const out = await mcpClient.callTool('detect_changes', params as Record<string, unknown>, ctx.cwd);
      return text(out || 'No affected flows detected.');
    },
  });
}

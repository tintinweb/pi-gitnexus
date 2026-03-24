import { StringEnum } from '@mariozechner/pi-ai';
import type { ExtensionAPI, ExtensionContext } from '@mariozechner/pi-coding-agent';
import { Type } from '@sinclair/typebox';
import { isAbsolute } from 'path';
import { expandUserPath, findGitNexusIndex, findGitNexusRoot, normalizePathArg, safeResolvePath, toRepoRelativePath, validateRepoRelativePath } from './gitnexus';
import { mcpClient } from './mcp-client';

function text(msg: string) {
  return { content: [{ type: 'text' as const, text: msg }], details: undefined };
}

const NO_INDEX = 'No GitNexus index found. Run: /gitnexus analyze';

function normalizeRepoOverride(repo: string | undefined): string | undefined {
  if (!repo?.trim()) return undefined;
  return looksLikeRepoPath(repo) ? expandUserPath(repo) : repo;
}

function buildRepoArgs(
  ctx: ExtensionContext,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const normalizedRepo = typeof params.repo === 'string' ? normalizeRepoOverride(params.repo) : undefined;
  if (normalizedRepo) {
    return { ...params, repo: normalizedRepo };
  }
  const repoRoot = findGitNexusRoot(ctx.cwd);
  return repoRoot ? { ...params, repo: repoRoot } : params;
}

function hasRepoOverride(params: Record<string, unknown>): boolean {
  return typeof params.repo === 'string' && params.repo.trim().length > 0;
}

function looksLikeRepoPath(repo: string | undefined): boolean {
  if (!repo) return false;
  const expanded = expandUserPath(repo);
  return isAbsolute(expanded) || expanded.startsWith('./') || expanded.startsWith('../');
}

function shouldAllowQuery(ctx: ExtensionContext, params: Record<string, unknown>): boolean {
  return hasRepoOverride(params) || findGitNexusIndex(ctx.cwd);
}

function resolveFilePath(
  ctx: ExtensionContext,
  filePath: string,
  repo?: string,
): string | null {
  const normalizedPath = normalizePathArg(filePath);
  if (looksLikeRepoPath(repo)) {
    return toRepoRelativePath(normalizedPath, expandUserPath(repo!));
  }
  if (repo?.trim()) {
    return validateRepoRelativePath(normalizedPath);
  }

  const repoRoot = findGitNexusRoot(ctx.cwd);
  if (repoRoot) {
    return toRepoRelativePath(normalizedPath, repoRoot);
  }

  if (isAbsolute(normalizedPath)) {
    return safeResolvePath(normalizedPath, ctx.cwd);
  }
  return validateRepoRelativePath(normalizedPath);
}

function normalizeContextArgs(
  ctx: ExtensionContext,
  params: {
    name?: string;
    uid?: string;
    file?: string;
    file_path?: string;
    include_content?: boolean;
    repo?: string;
  },
): Record<string, unknown> | null {
  const filePath = params.file_path ?? params.file;
  const args: Record<string, unknown> = {
    ...(params.name ? { name: params.name } : {}),
    ...(params.uid ? { uid: params.uid } : {}),
    ...(params.include_content !== undefined ? { include_content: params.include_content } : {}),
  };

  if (filePath) {
    const safe = resolveFilePath(ctx, filePath, params.repo);
    if (!safe) return null;
    args.file_path = safe;
  }

  return buildRepoArgs(ctx, params.repo ? { ...args, repo: params.repo } : args);
}

function normalizeImpactArgs(
  ctx: ExtensionContext,
  params: {
    target: string;
    direction?: 'upstream' | 'downstream';
    depth?: number;
    maxDepth?: number;
    include_tests?: boolean;
    includeTests?: boolean;
    relationTypes?: string[];
    minConfidence?: number;
    repo?: string;
  },
): Record<string, unknown> {
  return buildRepoArgs(ctx, {
    target: params.target,
    ...(params.direction ? { direction: params.direction } : {}),
    ...((params.maxDepth ?? params.depth) !== undefined ? { maxDepth: params.maxDepth ?? params.depth } : {}),
    ...((params.includeTests ?? params.include_tests) !== undefined
      ? { includeTests: params.includeTests ?? params.include_tests }
      : {}),
    ...(params.relationTypes ? { relationTypes: params.relationTypes } : {}),
    ...(params.minConfidence !== undefined ? { minConfidence: params.minConfidence } : {}),
    ...(params.repo ? { repo: params.repo } : {}),
  });
}

/**
 * Register all GitNexus tools with pi.
 * Called once from index.ts — this is the only way tools.ts accesses pi.
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
      query: Type.String({ minLength: 1, maxLength: 200, pattern: '^[^-]' }),
      task_context: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
      goal: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 5 })),
      max_symbols: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 10 })),
      include_content: Type.Optional(Type.Boolean()),
      repo: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
    }),
    execute: async (_id, params, _signal, _onUpdate, ctx) => {
      if (!shouldAllowQuery(ctx, params as Record<string, unknown>)) return text(NO_INDEX);
      const out = await mcpClient.callTool('query', buildRepoArgs(ctx, params as Record<string, unknown>), ctx.cwd);
      return text(out || 'No results.');
    },
  });

  pi.registerTool({
    name: 'gitnexus_context',
    label: 'GitNexus Context',
    description: '360-degree view of a code symbol: callers, callees, processes it participates in.',
    parameters: Type.Object({
      name: Type.Optional(Type.String({ minLength: 1, maxLength: 200, pattern: '^[^-]' })),
      uid: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
      file: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
      file_path: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
      include_content: Type.Optional(Type.Boolean()),
      repo: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
    }),
    execute: async (_id, params, _signal, _onUpdate, ctx) => {
      if (!shouldAllowQuery(ctx, params as Record<string, unknown>)) return text(NO_INDEX);
      const typedParams = params as {
        name?: string;
        uid?: string;
        file?: string;
        file_path?: string;
        include_content?: boolean;
        repo?: string;
      };
      if (!typedParams.name && !typedParams.uid) return text('Provide either name or uid.');
      const args = normalizeContextArgs(ctx, typedParams);
      if (!args) throw new Error('Invalid file path.');
      const out = await mcpClient.callTool('context', args, ctx.cwd);
      return text(out || 'No results.');
    },
  });

  pi.registerTool({
    name: 'gitnexus_impact',
    label: 'GitNexus Impact',
    description: 'Blast radius analysis: what breaks at each depth if you change a symbol.',
    parameters: Type.Object({
      target: Type.String({ minLength: 1, maxLength: 200, pattern: '^[^-]' }),
      direction: StringEnum(['upstream', 'downstream'] as const),
      depth: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, default: 3 })),
      maxDepth: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
      include_tests: Type.Optional(Type.Boolean()),
      includeTests: Type.Optional(Type.Boolean()),
      relationTypes: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 50 }), { maxItems: 20 })),
      minConfidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
      repo: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
    }),
    execute: async (_id, params, _signal, _onUpdate, ctx) => {
      if (!shouldAllowQuery(ctx, params as Record<string, unknown>)) return text(NO_INDEX);
      const out = await mcpClient.callTool('impact', normalizeImpactArgs(ctx, params as {
        target: string;
        direction?: 'upstream' | 'downstream';
        depth?: number;
        maxDepth?: number;
        include_tests?: boolean;
        includeTests?: boolean;
        relationTypes?: string[];
        minConfidence?: number;
        repo?: string;
      }), ctx.cwd);
      return text(out || 'No results.');
    },
  });

  pi.registerTool({
    name: 'gitnexus_detect_changes',
    label: 'GitNexus Detect Changes',
    description: 'Analyze git changes and map them to affected execution flows.',
    parameters: Type.Object({
      scope: Type.Optional(StringEnum(['unstaged', 'staged', 'all', 'compare'] as const)),
      base_ref: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
      repo: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
    }),
    execute: async (_id, params, _signal, _onUpdate, ctx) => {
      if (!shouldAllowQuery(ctx, params as Record<string, unknown>)) return text(NO_INDEX);
      const out = await mcpClient.callTool('detect_changes', buildRepoArgs(ctx, params as Record<string, unknown>), ctx.cwd);
      return text(out || 'No affected flows detected.');
    },
  });

  pi.registerTool({
    name: 'gitnexus_rename',
    label: 'GitNexus Rename',
    description: 'Multi-file coordinated rename using the knowledge graph plus text search. Use dry_run first.',
    parameters: Type.Object({
      symbol_name: Type.Optional(Type.String({ minLength: 1, maxLength: 200, pattern: '^[^-]' })),
      symbol_uid: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
      new_name: Type.String({ minLength: 1, maxLength: 200, pattern: '^[^-]' }),
      file_path: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
      dry_run: Type.Optional(Type.Boolean()),
      repo: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
    }),
    execute: async (_id, params, _signal, _onUpdate, ctx) => {
      if (!shouldAllowQuery(ctx, params as Record<string, unknown>)) return text(NO_INDEX);
      const typedParams = params as {
        symbol_name?: string;
        symbol_uid?: string;
        new_name: string;
        file_path?: string;
        dry_run?: boolean;
        repo?: string;
      };
      if (!typedParams.symbol_name && !typedParams.symbol_uid) {
        return text('Provide either symbol_name or symbol_uid.');
      }
      let filePath: string | undefined;
      if (typedParams.file_path) {
        const safe = resolveFilePath(ctx, typedParams.file_path, typedParams.repo);
        if (!safe) throw new Error('Invalid file path.');
        filePath = safe;
      }
      const out = await mcpClient.callTool('rename', buildRepoArgs(ctx, {
        ...(typedParams.symbol_name ? { symbol_name: typedParams.symbol_name } : {}),
        ...(typedParams.symbol_uid ? { symbol_uid: typedParams.symbol_uid } : {}),
        new_name: typedParams.new_name,
        ...(filePath ? { file_path: filePath } : {}),
        ...(typedParams.dry_run !== undefined ? { dry_run: typedParams.dry_run } : {}),
        ...(typedParams.repo ? { repo: typedParams.repo } : {}),
      }), ctx.cwd);
      return text(out || 'No rename preview generated.');
    },
  });

  pi.registerTool({
    name: 'gitnexus_cypher',
    label: 'GitNexus Cypher',
    description: 'Execute a raw Cypher query against the code knowledge graph.',
    parameters: Type.Object({
      query: Type.String({ minLength: 1, maxLength: 10_000, pattern: '^[^-]' }),
      repo: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
    }),
    execute: async (_id, params, _signal, _onUpdate, ctx) => {
      if (!shouldAllowQuery(ctx, params as Record<string, unknown>)) return text(NO_INDEX);
      const out = await mcpClient.callTool('cypher', buildRepoArgs(ctx, params as Record<string, unknown>), ctx.cwd);
      return text(out || 'No results.');
    },
  });
}

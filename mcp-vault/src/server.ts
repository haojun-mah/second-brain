import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import type { McpToolDefinition } from './types.js';
import type { VaultBackend } from './backends/types.js';
import { filesTools } from './tools/files.js';
import { searchTools } from './tools/search.js';
import { deltaTools } from './tools/delta.js';

const SERVER_NAME = 'vault';
const SERVER_VERSION = '2.0.0';
export const LOG_PREFIX = '[vault]';

/** Build the full tool set bound to one backend. */
export function registerTools(backend: VaultBackend): McpToolDefinition[] {
  return [...filesTools(backend), ...searchTools(backend), ...deltaTools(backend)];
}

export async function startMcpServer(backend: VaultBackend): Promise<void> {
  const allTools = registerTools(backend);
  const toolMap = new Map<string, McpToolDefinition>();

  for (const t of allTools) {
    if (toolMap.has(t.tool.name)) {
      console.error(`${LOG_PREFIX} Warning: tool "${t.tool.name}" already registered, skipping duplicate`);
      continue;
    }
    toolMap.set(t.tool.name, t);
  }

  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: allTools.map((t) => t.tool),
  }));

  server.setRequestHandler(
    CallToolRequestSchema,
    async (request: { params: { name: string; arguments?: Record<string, unknown> } }) => {
      const { name, arguments: args } = request.params;
      const tool = toolMap.get(name);
      if (!tool) {
        return { content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
      }
      return tool.handler(args ?? {});
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error(
    `${LOG_PREFIX} MCP server started with ${allTools.length} tools over backend ` +
      `"${backend.kind}" (${backend.location}): ${allTools.map((t) => t.tool.name).join(', ')}`,
  );
}

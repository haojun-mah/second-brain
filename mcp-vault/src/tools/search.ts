import type { McpToolDefinition } from '../types.js';
import type { VaultBackend } from '../backends/types.js';

export function searchTools(backend: VaultBackend): McpToolDefinition[] {
  return [
    {
      tool: {
        name: 'search_vault',
        description: 'Search for notes in the vault',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query' },
            scope: { type: 'string', description: 'Subdirectory within the vault to limit search scope' },
          },
          required: ['query'],
        },
      },
      handler: async (args) => {
        const query = args['query'] as string;
        const scope = args['scope'] as string | undefined;

        try {
          const hits = await backend.search(query, scope);
          // Output shape kept identical to the original: path + snippet only.
          const results = hits.map((h) => ({ path: h.path, snippet: h.snippet }));
          return { content: [{ type: 'text', text: JSON.stringify(results) }] };
        } catch (err) {
          const text = err instanceof Error ? err.message : String(err);
          return { content: [{ type: 'text', text }] };
        }
      },
    },
  ];
}

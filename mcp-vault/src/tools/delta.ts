import type { McpToolDefinition } from '../types.js';
import type { VaultBackend } from '../backends/types.js';

export function deltaTools(backend: VaultBackend): McpToolDefinition[] {
  return [
    {
      tool: {
        name: 'get_changes',
        description: 'Get changed files in the vault since a previous change token',
        inputSchema: {
          type: 'object',
          properties: {
            delta_token: {
              type: 'string',
              description: 'Token from a previous get_changes call. Omit for initial full sync.',
            },
          },
          required: [],
        },
      },
      handler: async (args) => {
        const token = args['delta_token'] as string | undefined;

        try {
          const { changes, nextToken } = await backend.changes(token);
          const items = changes.map((c) => ({
            name: c.name,
            path: c.path,
            size: c.size,
            modified: c.modified,
            is_folder: c.isFolder,
            deleted: false,
          }));

          // `next_delta_token` keeps its original name: `.meta/delta_token.json` and the
          // ingester skill both read that key, and the value is opaque per backend.
          return {
            content: [
              { type: 'text', text: JSON.stringify({ changes: items, next_delta_token: nextToken }) },
            ],
          };
        } catch (err) {
          const text = err instanceof Error ? err.message : String(err);
          return { content: [{ type: 'text', text }] };
        }
      },
    },
  ];
}

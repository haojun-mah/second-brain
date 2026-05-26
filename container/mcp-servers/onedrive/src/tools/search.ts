import type { McpToolDefinition } from '../types.js';
import { registerTools } from '../server.js';
import { graphFetch } from '../graph-client.js';
import { OBSIDIAN_DRIVE_PREFIX, drivePathToVaultRelative } from '../vault-path.js';

registerTools([
  {
    tool: {
      name: 'search_vault',
      description: 'Search for notes in the Obsidian vault on OneDrive',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          scope: { type: 'string', description: 'Subdirectory within Obsidian/ to limit search scope' },
        },
        required: ['query'],
      },
    },
    handler: async (args) => {
      const query = args['query'] as string;
      const scope = args['scope'] as string | undefined;

      const encodedQuery = encodeURIComponent(query);
      const res = await graphFetch(
        `/me/drive/root/search(q='${encodedQuery}')?$select=name,file,parentReference,searchResult`,
      );

      if (!res.ok) {
        const text = await res.text();
        return { content: [{ type: 'text', text: `Error ${res.status}: ${text}` }] };
      }

      type SearchItem = {
        name: string;
        file?: unknown;
        parentReference?: { path?: string };
        searchResult?: { summary?: string };
      };

      const data = (await res.json()) as { value: SearchItem[] };

      const scopePrefix = scope
        ? `${OBSIDIAN_DRIVE_PREFIX}/${scope}`
        : OBSIDIAN_DRIVE_PREFIX;

      const results: Array<{ path: string; snippet: string }> = [];

      for (const item of data.value) {
        if (!item.file) continue;
        const parentPath = item.parentReference?.path ?? '';
        if (parentPath !== scopePrefix && !parentPath.startsWith(`${scopePrefix}/`)) continue;

        results.push({
          path: drivePathToVaultRelative(parentPath, item.name),
          snippet: item.searchResult?.summary ?? '',
        });
      }

      return { content: [{ type: 'text', text: JSON.stringify(results) }] };
    },
  } satisfies McpToolDefinition,
]);

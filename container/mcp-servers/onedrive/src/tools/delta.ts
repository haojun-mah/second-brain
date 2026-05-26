import type { McpToolDefinition } from '../types.js';
import { registerTools } from '../server.js';
import { graphFetch } from '../graph-client.js';
import { OBSIDIAN_DRIVE_PREFIX, drivePathToVaultRelative } from '../vault-path.js';

registerTools([
  {
    tool: {
      name: 'get_changes',
      description: 'Get changed files in the Obsidian vault since a previous delta token',
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
      const deltaToken = args['delta_token'] as string | undefined;

      type DeltaItem = {
        id: string;
        name: string;
        deleted?: { state: string };
        parentReference?: { path?: string };
        file?: unknown;
        folder?: unknown;
      };

      type DeltaPage = {
        value: DeltaItem[];
        '@odata.nextLink'?: string;
        '@odata.deltaLink'?: string;
      };

      let nextUrl: string = deltaToken
        ? deltaToken
        : `/me/drive/root/delta?$select=name,file,folder,deleted,parentReference`;

      const changes: Array<{ id: string; name: string; path: string; deleted: boolean }> = [];
      let finalDeltaLink = '';

      while (true) {
        const res = await graphFetch(nextUrl);
        if (!res.ok) {
          const text = await res.text();
          return { content: [{ type: 'text', text: `Error ${res.status}: ${text}` }] };
        }

        const page = (await res.json()) as DeltaPage;

        for (const item of page.value) {
          const parentPath = item.parentReference?.path ?? '';
          if (parentPath !== OBSIDIAN_DRIVE_PREFIX && !parentPath.startsWith(`${OBSIDIAN_DRIVE_PREFIX}/`)) continue;
          changes.push({
            id: item.id,
            name: item.name,
            path: drivePathToVaultRelative(parentPath, item.name),
            deleted: item.deleted !== undefined,
          });
        }

        if (page['@odata.nextLink']) {
          nextUrl = page['@odata.nextLink'];
        } else if (page['@odata.deltaLink']) {
          finalDeltaLink = page['@odata.deltaLink'];
          break;
        } else {
          break;
        }
      }

      return {
        content: [
          { type: 'text', text: JSON.stringify({ changes, next_delta_token: finalDeltaLink }) },
        ],
      };
    },
  } satisfies McpToolDefinition,
]);

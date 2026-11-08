import type { McpToolDefinition } from '../types.js';
import type { VaultBackend } from '../backends/types.js';
import { EtagMismatchError, VaultNotFoundError } from '../backends/types.js';

/**
 * Render a backend failure the way the original single-backend server did, so existing
 * skills and prompts that pattern-match on `Error 409:` / `Error 404:` keep working
 * regardless of which backend is selected.
 */
function errorText(err: unknown): string {
  if (err instanceof EtagMismatchError) return `Error 409: ${err.message}`;
  if (err instanceof VaultNotFoundError) return `Error 404: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

function fail(err: unknown) {
  return { content: [{ type: 'text' as const, text: errorText(err) }] };
}

export function filesTools(backend: VaultBackend): McpToolDefinition[] {
  return [
    {
      tool: {
        name: 'read_note',
        description: 'Read a note from the vault',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Path to the note relative to the vault root' },
          },
          required: ['path'],
        },
      },
      handler: async (args) => {
        const path = args['path'] as string;
        try {
          const file = await backend.readFile(path);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  content: file.content,
                  etag: file.etag,
                  last_modified: file.lastModified,
                }),
              },
            ],
          };
        } catch (err) {
          return fail(err);
        }
      },
    },

    {
      tool: {
        name: 'write_note',
        description: 'Write content to a note in the vault (creates parent folders as needed)',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Path to the note relative to the vault root' },
            content: { type: 'string', description: 'Content to write' },
            if_match: {
              type: 'string',
              description: 'ETag for conditional write (prevents overwrites)',
            },
          },
          required: ['path', 'content'],
        },
      },
      handler: async (args) => {
        const path = args['path'] as string;
        const content = args['content'] as string;
        const ifMatch = args['if_match'] as string | undefined;

        try {
          const etag = await backend.write(path, content, ifMatch);
          return { content: [{ type: 'text', text: JSON.stringify({ etag }) }] };
        } catch (err) {
          return fail(err);
        }
      },
    },

    {
      tool: {
        name: 'append_note',
        description: 'Append content to a note in the vault (creates it if absent)',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Path to the note relative to the vault root' },
            content: { type: 'string', description: 'Content to append' },
          },
          required: ['path', 'content'],
        },
      },
      handler: async (args) => {
        const path = args['path'] as string;
        const content = args['content'] as string;

        try {
          const etag = await backend.append(path, content);
          return { content: [{ type: 'text', text: JSON.stringify({ etag }) }] };
        } catch (err) {
          // Preserve the original distinction between "read failed" and "write conflicted".
          if (err instanceof EtagMismatchError) {
            return {
              content: [
                { type: 'text', text: 'Error 409: ETag mismatch — file was modified during append' },
              ],
            };
          }
          if (err instanceof VaultNotFoundError) {
            return { content: [{ type: 'text', text: `Error reading 404: ${err.message}` }] };
          }
          return fail(err);
        }
      },
    },

    {
      tool: {
        name: 'list_directory',
        description: 'List files and folders in a directory of the vault',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Directory path relative to the vault root' },
            recursive: { type: 'boolean', description: 'Whether to list recursively' },
          },
          required: ['path'],
        },
      },
      handler: async (args) => {
        const path = args['path'] as string;
        const recursive = (args['recursive'] as boolean | undefined) ?? false;

        try {
          const entries = await backend.list(path, { recursive });
          const items = entries.map((e) => ({
            name: e.name,
            path: e.path,
            size: e.size,
            modified: e.modified,
            is_folder: e.isFolder,
          }));
          return { content: [{ type: 'text', text: JSON.stringify(items) }] };
        } catch (err) {
          return { content: [{ type: 'text', text: String(err) }] };
        }
      },
    },

    {
      tool: {
        name: 'move_file',
        description: 'Move a file within the vault',
        inputSchema: {
          type: 'object',
          properties: {
            from: { type: 'string', description: 'Source path relative to the vault root' },
            to: { type: 'string', description: 'Destination path relative to the vault root' },
          },
          required: ['from', 'to'],
        },
      },
      handler: async (args) => {
        const from = args['from'] as string;
        const to = args['to'] as string;

        try {
          await backend.move(from, to);
          return { content: [{ type: 'text', text: JSON.stringify({ new_path: to }) }] };
        } catch (err) {
          if (err instanceof VaultNotFoundError) {
            return { content: [{ type: 'text', text: `Error getting metadata 404: ${err.message}` }] };
          }
          return fail(err);
        }
      },
    },

    {
      tool: {
        name: 'delete_note',
        description: 'Delete a note from the vault',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Path to the note relative to the vault root' },
          },
          required: ['path'],
        },
      },
      handler: async (args) => {
        const path = args['path'] as string;
        try {
          await backend.remove(path);
          return { content: [{ type: 'text', text: JSON.stringify({ success: true }) }] };
        } catch (err) {
          return fail(err);
        }
      },
    },
  ];
}

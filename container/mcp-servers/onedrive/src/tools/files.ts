import type { McpToolDefinition } from '../types.js';
import { registerTools } from '../server.js';
import { graphFetch } from '../graph-client.js';
import { vaultContentPath, vaultMetaPath, vaultChildrenPath, OBSIDIAN_DRIVE_PREFIX } from '../vault-path.js';

registerTools([
  {
    tool: {
      name: 'read_note',
      description: 'Read a note from the Obsidian vault on OneDrive',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the note relative to Obsidian/ root' },
        },
        required: ['path'],
      },
    },
    handler: async (args) => {
      const path = args['path'] as string;
      const res = await graphFetch(vaultContentPath(path));
      if (!res.ok) {
        const text = await res.text();
        return { content: [{ type: 'text', text: `Error ${res.status}: ${text}` }] };
      }
      const content = await res.text();
      const etag = res.headers.get('ETag') ?? '';
      const last_modified = res.headers.get('Last-Modified') ?? '';
      return {
        content: [{ type: 'text', text: JSON.stringify({ content, etag, last_modified }) }],
      };
    },
  } satisfies McpToolDefinition,

  {
    tool: {
      name: 'write_note',
      description: 'Write content to a note in the Obsidian vault on OneDrive',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the note relative to Obsidian/ root' },
          content: { type: 'string', description: 'Content to write' },
          if_match: { type: 'string', description: 'ETag for conditional write (prevents overwrites)' },
        },
        required: ['path', 'content'],
      },
    },
    handler: async (args) => {
      const path = args['path'] as string;
      const content = args['content'] as string;
      const ifMatch = args['if_match'] as string | undefined;

      const headers: Record<string, string> = { 'Content-Type': 'text/plain' };
      if (ifMatch) headers['If-Match'] = ifMatch;

      const res = await graphFetch(vaultContentPath(path), { method: 'PUT', headers, body: content });

      if (res.status === 409) {
        return { content: [{ type: 'text', text: 'Error 409: ETag mismatch — file was modified' }] };
      }
      if (!res.ok) {
        const text = await res.text();
        return { content: [{ type: 'text', text: `Error ${res.status}: ${text}` }] };
      }

      const data = (await res.json()) as { eTag?: string };
      return { content: [{ type: 'text', text: JSON.stringify({ etag: data.eTag ?? '' }) }] };
    },
  } satisfies McpToolDefinition,

  {
    tool: {
      name: 'append_note',
      description: 'Append content to a note in the Obsidian vault on OneDrive',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the note relative to Obsidian/ root' },
          content: { type: 'string', description: 'Content to append' },
        },
        required: ['path', 'content'],
      },
    },
    handler: async (args) => {
      const path = args['path'] as string;
      const appendContent = args['content'] as string;

      const readRes = await graphFetch(vaultContentPath(path));
      if (!readRes.ok) {
        const text = await readRes.text();
        return { content: [{ type: 'text', text: `Error reading ${readRes.status}: ${text}` }] };
      }

      const existing = await readRes.text();
      const etag = readRes.headers.get('ETag') ?? '*';

      const writeRes = await graphFetch(vaultContentPath(path), {
        method: 'PUT',
        headers: { 'Content-Type': 'text/plain', 'If-Match': etag },
        body: existing + appendContent,
      });

      if (writeRes.status === 409) {
        return { content: [{ type: 'text', text: 'Error 409: ETag mismatch — file was modified during append' }] };
      }
      if (!writeRes.ok) {
        const text = await writeRes.text();
        return { content: [{ type: 'text', text: `Error ${writeRes.status}: ${text}` }] };
      }

      const data = (await writeRes.json()) as { eTag?: string };
      return { content: [{ type: 'text', text: JSON.stringify({ etag: data.eTag ?? '' }) }] };
    },
  } satisfies McpToolDefinition,

  {
    tool: {
      name: 'list_directory',
      description: 'List files and folders in a directory of the Obsidian vault on OneDrive',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path relative to Obsidian/ root' },
          recursive: { type: 'boolean', description: 'Whether to list recursively' },
        },
        required: ['path'],
      },
    },
    handler: async (args) => {
      const path = args['path'] as string;
      const recursive = (args['recursive'] as boolean | undefined) ?? false;

      const SELECT = '$select=name,size,lastModifiedDateTime,folder,file,parentReference';

      type DriveItem = {
        name: string;
        size?: number;
        lastModifiedDateTime?: string;
        folder?: unknown;
        parentReference?: { path?: string };
      };

      type DirEntry = { name: string; path: string; size: number; modified: string; is_folder: boolean };

      const listDir = async (dirPath: string): Promise<DirEntry[]> => {
        const res = await graphFetch(vaultChildrenPath(dirPath, SELECT));
        if (!res.ok) {
          const text = await res.text();
          throw new Error(`Error ${res.status}: ${text}`);
        }

        const { value: items } = (await res.json()) as { value: DriveItem[] };
        const entries: DirEntry[] = items.map((item) => ({
          name: item.name,
          path: dirPath === '' ? item.name : `${dirPath}/${item.name}`,
          size: item.size ?? 0,
          modified: item.lastModifiedDateTime ?? '',
          is_folder: item.folder !== undefined,
        }));

        if (!recursive) return entries;

        const subfolderResults = await Promise.all(
          entries.filter((e) => e.is_folder).map((e) => listDir(e.path)),
        );
        for (const children of subfolderResults) entries.push(...children);

        return entries;
      };

      try {
        const items = await listDir(path);
        return { content: [{ type: 'text', text: JSON.stringify(items) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: String(err) }] };
      }
    },
  } satisfies McpToolDefinition,

  {
    tool: {
      name: 'move_file',
      description: 'Move a file within the Obsidian vault on OneDrive',
      inputSchema: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'Source path relative to Obsidian/ root' },
          to: { type: 'string', description: 'Destination path relative to Obsidian/ root' },
        },
        required: ['from', 'to'],
      },
    },
    handler: async (args) => {
      const from = args['from'] as string;
      const to = args['to'] as string;

      const metaRes = await graphFetch(vaultMetaPath(from));
      if (!metaRes.ok) {
        const text = await metaRes.text();
        return { content: [{ type: 'text', text: `Error getting metadata ${metaRes.status}: ${text}` }] };
      }

      const { id: itemId } = (await metaRes.json()) as { id: string };
      const toName = to.split('/').pop() ?? to;
      const toParent = to.includes('/') ? to.slice(0, to.lastIndexOf('/')) : '';
      const parentPath = toParent === '' ? OBSIDIAN_DRIVE_PREFIX : `${OBSIDIAN_DRIVE_PREFIX}/${toParent}`;

      const patchRes = await graphFetch(`/me/drive/items/${itemId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: toName, parentReference: { path: parentPath } }),
      });

      if (!patchRes.ok) {
        const text = await patchRes.text();
        return { content: [{ type: 'text', text: `Error moving ${patchRes.status}: ${text}` }] };
      }

      return { content: [{ type: 'text', text: JSON.stringify({ new_path: to }) }] };
    },
  } satisfies McpToolDefinition,

  {
    tool: {
      name: 'delete_note',
      description: 'Delete a note from the Obsidian vault on OneDrive',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the note relative to Obsidian/ root' },
        },
        required: ['path'],
      },
    },
    handler: async (args) => {
      const path = args['path'] as string;
      const res = await graphFetch(vaultMetaPath(path), { method: 'DELETE' });

      if (!res.ok) {
        const text = await res.text();
        return { content: [{ type: 'text', text: `Error ${res.status}: ${text}` }] };
      }

      return { content: [{ type: 'text', text: JSON.stringify({ success: true }) }] };
    },
  } satisfies McpToolDefinition,
]);

/**
 * Bootstrap the three second-brain agent groups (ingester, query, linter)
 * in the NanoClaw v2 database. Idempotent — skips groups that already exist.
 *
 * Usage:
 *   pnpm exec tsx scripts/setup-second-brain.ts
 *
 * Run once after NanoClaw is set up. Does not require the service to be running.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../src/config.js';
import { createAgentGroup, getAgentGroup, getAgentGroupByFolder } from '../src/db/agent-groups.js';
import { initDb } from '../src/db/connection.js';
import {
  updateContainerConfigJson,
  updateContainerConfigScalars,
} from '../src/db/container-configs.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroupByPlatform,
} from '../src/db/messaging-groups.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { openInboundDb } from '../src/db/session-db.js';
import { initGroupFilesystem } from '../src/group-init.js';
import { insertTask } from '../src/modules/scheduling/db.js';
import { inboundDbPath, resolveSession } from '../src/session-manager.js';
import type { AgentGroup } from '../src/types.js';

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const onedriveMcpConfig = {
  command: 'bun',
  args: ['run', '/app/mcp-servers/onedrive/src/index.ts'],
  env: {},
  instructions: `# OneDrive Vault Tools

You have access to an Obsidian vault stored in OneDrive via these tools (prefixed mcp__onedrive__):

- mcp__onedrive__read_note(path) → { content, etag, last_modified }
- mcp__onedrive__write_note(path, content, if_match?) → { etag }
- mcp__onedrive__append_note(path, content) → { etag }
- mcp__onedrive__list_directory(path, recursive?) → [{ name, path, size, modified, is_folder }]
- mcp__onedrive__move_file(from, to) → { new_path }
- mcp__onedrive__delete_note(path) → { success }
- mcp__onedrive__search_vault(query, scope?) → [{ path, snippet }]
- mcp__onedrive__get_changes(delta_token?) → { changes, next_delta_token }

All paths are relative to the Obsidian vault root (e.g. "sources/_inbox/note.md", "wiki/index.md").
Vault root in OneDrive: OneDrive/Obsidian/
`,
};

interface GroupSpec {
  name: string;
  folder: string;
  model: string;
  needsInternalMessagingGroup: boolean;
  instructionsTemplate?: string;
}

const TEMPLATES_DIR = path.resolve(import.meta.dirname, '../docs/agent-templates');

const GROUP_SPECS: GroupSpec[] = [
  {
    name: 'Ingester',
    folder: 'ingester',
    model: 'claude-sonnet-4-6',
    needsInternalMessagingGroup: true,
    instructionsTemplate: path.join(TEMPLATES_DIR, 'ingester-instructions.md'),
  },
  {
    name: 'Query',
    folder: 'query',
    model: 'claude-sonnet-4-6',
    needsInternalMessagingGroup: false,
    instructionsTemplate: path.join(TEMPLATES_DIR, 'query-instructions.md'),
  },
  {
    name: 'Linter',
    folder: 'linter',
    model: 'claude-sonnet-4-6',
    needsInternalMessagingGroup: true,
    instructionsTemplate: path.join(TEMPLATES_DIR, 'linter-instructions.md'),
  },
];

function createGroup(spec: GroupSpec, now: string): AgentGroup {
  const existing = getAgentGroupByFolder(spec.folder);
  if (existing) {
    console.log(`Skipping agent group '${spec.folder}' — already exists: ${existing.id}`);
    return existing;
  }

  const agId = generateId('ag');
  createAgentGroup({
    id: agId,
    name: spec.name,
    folder: spec.folder,
    agent_provider: null,
    created_at: now,
  });

  const ag = getAgentGroup(agId)!;
  console.log(`Created agent group: ${ag.id} (${spec.folder})`);

  let instructions: string | undefined;
  if (spec.instructionsTemplate) {
    try {
      instructions = fs.readFileSync(spec.instructionsTemplate, 'utf-8');
    } catch {
      console.warn(`Warning: instructions template not found: ${spec.instructionsTemplate}`);
    }
  }

  initGroupFilesystem(ag, { instructions });

  updateContainerConfigScalars(ag.id, { model: spec.model });
  updateContainerConfigJson(ag.id, 'mcp_servers', { onedrive: onedriveMcpConfig });

  return ag;
}

function ensureInternalMessagingGroup(ag: AgentGroup, spec: GroupSpec, now: string): string {
  const platformId = `internal:${spec.folder}`;
  const existing = getMessagingGroupByPlatform('internal', platformId);
  if (existing) {
    console.log(
      `Skipping internal messaging group for '${spec.folder}' — already exists: ${existing.id}`,
    );
    return existing.id;
  }

  const mgId = generateId('mg');
  createMessagingGroup({
    id: mgId,
    channel_type: 'internal',
    platform_id: platformId,
    name: `${spec.name} Internal`,
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: now,
  });
  console.log(`Created internal messaging group: ${mgId} (${platformId})`);

  createMessagingGroupAgent({
    id: generateId('mga'),
    messaging_group_id: mgId,
    agent_group_id: ag.id,
    engage_mode: 'pattern',
    engage_pattern: '.',
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    created_at: now,
  });
  console.log(`Wired ${mgId} -> ${ag.id}`);
  return mgId;
}

function bootstrapRecurringTask(
  ag: AgentGroup,
  mgId: string,
  cron: string,
  prompt: string,
  label: string,
): void {
  const existing = resolveSession(ag.id, mgId, null, 'shared');
  const { session, created } = existing;
  const dbPath = inboundDbPath(ag.id, session.id);
  const db = openInboundDb(dbPath);
  try {
    // Skip if a pending recurring task already exists for this session.
    const already = db
      .prepare("SELECT COUNT(*) as n FROM messages_in WHERE kind='task' AND status='pending' AND recurrence IS NOT NULL")
      .get() as { n: number };
    if (!created && already.n > 0) {
      console.log(`${label}: recurring task already present — skipping.`);
      return;
    }
    insertTask(db, {
      id: generateId('task'),
      processAfter: new Date().toISOString(),
      recurrence: cron,
      platformId: null,
      channelType: null,
      threadId: null,
      content: JSON.stringify({ prompt }),
    });
    console.log(`${label}: recurring task created (${cron}, fires immediately).`);
  } finally {
    db.close();
  }
}

async function main(): Promise<void> {
  const db = initDb(path.join(DATA_DIR, 'v2.db'));
  runMigrations(db);

  const now = new Date().toISOString();
  const agentGroups: Array<{ spec: GroupSpec; ag: AgentGroup }> = [];

  for (const spec of GROUP_SPECS) {
    const ag = createGroup(spec, now);
    if (spec.needsInternalMessagingGroup) {
      const mgId = ensureInternalMessagingGroup(ag, spec, now);
      if (spec.folder === 'ingester') {
        bootstrapRecurringTask(
          ag, mgId, '*/10 * * * *',
          'Check for new files in sources/_inbox/ and ingest any that are found.',
          'Ingester',
        );
      }
      if (spec.folder === 'linter') {
        bootstrapRecurringTask(
          ag, mgId, '0 3 * * 0',
          'Run a full lint of the wiki vault. Check for broken wikilinks, orphan pages, contradictions, and stale content. Auto-fix what is unambiguous; file anything uncertain in wiki/questions/.',
          'Linter',
        );
      }
    }
    agentGroups.push({ spec, ag });
  }

  console.log('');
  console.log('Setup complete. Agent groups:');
  for (const { spec, ag } of agentGroups) {
    console.log(`  ${spec.folder.padEnd(10)} ${ag.id}  model=${spec.model}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

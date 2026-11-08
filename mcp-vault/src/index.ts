/**
 * Entry point: resolve config → build the backend → register tools → serve stdio.
 *
 * Configuration failures exit here with a message naming the missing variables, because a
 * half-started MCP server shows up in the agent as "no such tool" rather than as a
 * configuration problem — the worst possible failure mode to debug.
 */

import { loadConfig, ConfigError } from './config.js';
import { createBackend } from './backends/index.js';
import { startMcpServer, LOG_PREFIX } from './server.js';

async function main(): Promise<void> {
  let backend;
  try {
    const config = loadConfig();
    backend = createBackend(config);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`${LOG_PREFIX} configuration error: ${err.message}`);
    } else {
      console.error(`${LOG_PREFIX} failed to start: ${err instanceof Error ? err.message : String(err)}`);
    }
    process.exit(1);
  }

  await startMcpServer(backend);
}

main().catch((err) => {
  console.error(`${LOG_PREFIX} fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

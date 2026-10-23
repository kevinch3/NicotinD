#!/usr/bin/env bun
import { writeFileSync } from 'node:fs';
import { ConfigError, loadConfig } from './config.js';
import { McpClient } from './mcp-client.js';
import { anthropicModel, openAiCompatModel } from './model.js';
import { renderReport } from './report.js';
import { runCuration } from './run.js';
import { AttemptStore } from './state.js';

const USAGE = `Usage: nicotind-curator [--dry-run] [--report <file>]

One unattended curation run against a NicotinD library over MCP. Configured
by environment variables; see docs/curator-runner.md.

  --dry-run         ask the model and print what would happen; write nothing
  --report <file>   also write the markdown run report to <file>`;

async function main(argv: string[]): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return 0;
  }
  const reportIdx = argv.indexOf('--report');
  const reportFile = reportIdx >= 0 ? argv[reportIdx + 1] : undefined;

  let cfg;
  try {
    cfg = loadConfig(process.env);
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(e.message);
      return 2;
    }
    throw e;
  }

  const model =
    cfg.provider === 'anthropic'
      ? anthropicModel({ ...cfg, baseUrl: cfg.modelBaseUrl, apiKey: cfg.modelApiKey! })
      : openAiCompatModel({ ...cfg, baseUrl: cfg.modelBaseUrl, apiKey: cfg.modelApiKey });
  const store = new AttemptStore(cfg.stateDb);
  try {
    const report = await runCuration(
      cfg,
      {
        mcp: new McpClient(cfg.mcpUrl, cfg.mcpToken),
        model,
        store,
        now: Date.now,
        log: (line) => console.error(line),
      },
      { dryRun: argv.includes('--dry-run') },
    );
    const text = renderReport(report);
    console.log(text);
    if (reportFile) writeFileSync(reportFile, text);
    return 0;
  } catch (e) {
    console.error(`curator-runner failed: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  } finally {
    store.close();
  }
}

process.exit(await main(process.argv.slice(2)));

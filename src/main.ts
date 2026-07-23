/**
 * AI Code Review Census — collector.
 *
 * Measures, from real GitHub data: how many active repositories run an AI code
 * reviewer, how many run more than one, how often those reviewers land on the
 * same lines, and how often their comments precede an actual code change.
 *
 * Designed to run unattended on a schedule. Each run consumes the next slice
 * of the search space, appends raw scans to an append-only log, and recomputes
 * the report over everything collected so far — so the sample grows over time
 * instead of being re-sampled from scratch.
 *
 *   node --experimental-strip-types src/main.ts
 *
 * Flags: --repos=N  --prs=N  --min-stars=N  --analyze-only  --reset
 */

import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { GitHubClient, RateLimitedError } from './github.ts';
import { scanRepo } from './scan.ts';
import { analyze, vendorsInScan } from './analyze.ts';
import type { RepoScan, ScanState } from './types.ts';
import { toMarkdown, verdict } from './report.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data');
const SCANS = join(DATA, 'scans.jsonl');
const STATE = join(DATA, 'state.json');
const REPORT_JSON = join(DATA, 'report.json');
const REPORT_MD = join(ROOT, 'STUDY.md');

function flag(name: string, fallback: number): number {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split('=')[1]) : fallback;
}

async function loadState(): Promise<ScanState> {
  if (process.argv.includes('--reset') || !existsSync(STATE)) {
    return { nextSearchPage: 1, scannedRepoKeys: [], runs: [] };
  }
  return JSON.parse(await readFile(STATE, 'utf8')) as ScanState;
}

async function loadAllScans(): Promise<RepoScan[]> {
  if (!existsSync(SCANS)) return [];
  const text = await readFile(SCANS, 'utf8');
  const scans: RepoScan[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      scans.push(JSON.parse(line) as RepoScan);
    } catch {
      // A partially-written final line from a killed run is expected and
      // harmless — the append-only log tolerates it by design.
    }
  }
  return scans;
}

/**
 * Prefer an explicit token; fall back to whatever `gh` is already logged in as.
 * Removes setup friction entirely on a developer machine, and keeps scheduled
 * runs working without a secret sitting in a dotfile.
 */
function resolveToken(): string | null {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    const t = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return t || null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const token = resolveToken();
  if (!token) {
    console.error(
      'No GitHub credentials found.\n\n' +
        'Either run `gh auth login`, or create a classic token with the\n' +
        '`public_repo` scope (read-only) at https://github.com/settings/tokens\n' +
        'and put it in .env as GITHUB_TOKEN=ghp_...',
    );
    process.exit(1);
  }

  const repoTarget = flag('repos', 40);
  const prCount = flag('prs', 30);
  const minStars = flag('min-stars', 200);

  await mkdir(DATA, { recursive: true });

  // Vendor classification happens in analyze.ts, so extending the bot registry
  // reclassifies the entire existing corpus without touching GitHub.
  if (process.argv.includes('--analyze-only')) {
    const all = await loadAllScans();
    const result = analyze(all);
    await writeFile(REPORT_JSON, JSON.stringify(result, null, 2));
    await writeFile(REPORT_MD, toMarkdown(result));
    const v = verdict(result);
    console.log(`\nRe-analyzed ${result.sample.reposScanned} repos (no scanning).`);
    console.log(`2+ AI reviewers: ${result.coverage.pctReposWith2Plus}%  ·  ${v.label}\n`);
    return;
  }

  const state = await loadState();
  const seen = new Set(state.scannedRepoKeys);

  const client = new GitHubClient({ token, onLog: (m) => console.log(m) });

  // 90 days of push activity keeps the frame on live projects without
  // narrowing it so far that only hyperactive repos qualify.
  const pushedAfter = new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10);

  console.log(`\nDiffHawk premise study`);
  console.log(`  target: ${repoTarget} new repos × ${prCount} PRs, stars >= ${minStars}`);
  console.log(`  already scanned: ${seen.size} repos\n`);

  const fresh: RepoScan[] = [];
  let page = state.nextSearchPage;
  let consecutiveEmptyPages = 0;

  while (fresh.length < repoTarget && consecutiveEmptyPages < 3) {
    let candidates;
    try {
      candidates = await client.searchRepos({ page, perPage: 50, minStars, pushedAfter });
    } catch (err) {
      console.error(`  search failed on page ${page}: ${(err as Error).message}`);
      break;
    }

    // GitHub's search API caps out at 1000 results; wrap rather than stall.
    if (candidates.length === 0) {
      consecutiveEmptyPages++;
      page = page >= 20 ? 1 : page + 1;
      continue;
    }
    consecutiveEmptyPages = 0;

    const unseen = candidates.filter((r) => !seen.has(`${r.owner}/${r.name}`));
    if (unseen.length === 0) {
      page++;
      continue;
    }

    for (const repo of unseen) {
      if (fresh.length >= repoTarget) break;
      const key = `${repo.owner}/${repo.name}`;

      try {
        const scan = await scanRepo(client, repo, prCount);
        fresh.push(scan);
        seen.add(key);
        await appendFile(SCANS, JSON.stringify(scan) + '\n');

        const vendors = vendorsInScan(scan);
        const vendorList = vendors.length ? vendors.join(', ') : '—';
        const marker = vendors.length >= 2 ? '**' : '  ';
        console.log(
          `${marker} [${fresh.length}/${repoTarget}] ${key} · ${scan.pulls.length} PRs · ${vendorList}` +
            (scan.error ? ` · ERROR: ${scan.error.slice(0, 60)}` : ''),
        );
      } catch (err) {
        if (err instanceof RateLimitedError) {
          console.log(`\n  Rate limit exhausted (resets ${err.resetAt}). Checkpointing.`);
          page = Number.MAX_SAFE_INTEGER;
          break;
        }
        console.error(`  ${key} failed: ${(err as Error).message}`);
      }
    }
    page = page === Number.MAX_SAFE_INTEGER ? state.nextSearchPage : page + 1;
    if (page === Number.MAX_SAFE_INTEGER) break;
  }

  state.nextSearchPage = page > 20 ? 1 : page;
  state.scannedRepoKeys = [...seen];
  state.runs.push({
    startedAt: new Date().toISOString(),
    repos: fresh.length,
    pulls: fresh.reduce((n, s) => n + s.pulls.length, 0),
  });
  await writeFile(STATE, JSON.stringify(state, null, 2));

  // Recompute over the full accumulated corpus, not just this run.
  const all = await loadAllScans();
  const result = analyze(all);
  await writeFile(REPORT_JSON, JSON.stringify(result, null, 2));
  await writeFile(REPORT_MD, toMarkdown(result));

  const v = verdict(result);
  console.log(`\n${'─'.repeat(64)}`);
  console.log(`Corpus: ${result.sample.reposScanned} repos · ${result.sample.pullsScanned} PRs`);
  console.log(`Any AI reviewer:  ${result.coverage.pctReposWithAnyAi}%`);
  console.log(`2+ AI reviewers:  ${result.coverage.pctReposWith2Plus}%   <- headline`);
  console.log(`Duplicate rate:   ${result.duplication.pctOverlapping}%`);
  console.log(`Action rate:      AI ${result.action.aiActionRate}% vs human ${result.action.humanActionRate}%`);
  console.log(`\nVerdict: ${v.label} — ${v.detail}`);
  console.log(`\nWrote STUDY.md and data/report.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

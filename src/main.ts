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

/**
 * Star-band strata. Each gets its own 1000-result search window, so the
 * reachable population is roughly 1000 × strata rather than 1000 total.
 * Bands are deliberately uneven — repository counts fall off steeply with
 * stars, so the high bands are wider to hold a comparable population.
 */
const STRATA: Array<{ label: string; min: number; max: number | null }> = [
  { label: '100-249',    min: 100,   max: 249 },
  { label: '250-499',    min: 250,   max: 499 },
  { label: '500-999',    min: 500,   max: 999 },
  { label: '1k-2.4k',    min: 1000,  max: 2499 },
  { label: '2.5k-9.9k',  min: 2500,  max: 9999 },
  { label: '10k+',       min: 10000, max: null },
];

function emptyState(): ScanState {
  return { strataPages: {}, exhaustedStrata: [], scannedRepoKeys: [], runs: [] };
}

async function loadState(): Promise<ScanState> {
  if (process.argv.includes('--reset') || !existsSync(STATE)) return emptyState();

  const raw = JSON.parse(await readFile(STATE, 'utf8')) as Partial<ScanState> & {
    nextSearchPage?: number;
  };

  // Migrate state written before stratified sampling existed. The scanned-repo
  // set is the part worth keeping; the old single-frame page cursor is
  // meaningless now and is discarded rather than mapped onto a stratum.
  return {
    strataPages: raw.strataPages ?? {},
    exhaustedStrata: raw.exhaustedStrata ?? [],
    scannedRepoKeys: raw.scannedRepoKeys ?? [],
    runs: raw.runs ?? [],
  };
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

  const active = STRATA.filter(
    (s) => s.min >= minStars && !state.exhaustedStrata.includes(s.label),
  );

  console.log(`\nAI Code Review Census — collector`);
  console.log(`  target: ${repoTarget} new repos × ${prCount} PRs`);
  console.log(`  strata: ${active.map((s) => s.label).join(', ') || 'none left'}`);
  console.log(`  already scanned: ${seen.size} repos\n`);

  if (active.length === 0) {
    console.log('Every stratum is exhausted. Widen STRATA or shorten the push window.\n');
  }

  const fresh: RepoScan[] = [];
  // Round-robin across strata so the corpus stays balanced across star bands
  // rather than filling the smallest band first.
  let stratumIndex = 0;
  let consecutiveDry = 0;
  let rateLimited = false;

  while (fresh.length < repoTarget && active.length > 0 && consecutiveDry < active.length * 2) {
    const stratum = active[stratumIndex % active.length];
    stratumIndex++;
    const page = state.strataPages[stratum.label] ?? 1;

    let candidates;
    try {
      candidates = await client.searchRepos({
        page,
        perPage: 50,
        minStars: stratum.min,
        maxStars: stratum.max,
        pushedAfter,
      });
    } catch (err) {
      const msg = (err as Error).message;
      // 422 is GitHub refusing to page past its 1000-result ceiling. That
      // stratum is spent; retiring it is correct, not an error to retry.
      if (msg.includes('422') || msg.includes('1000 search results')) {
        console.log(`  stratum ${stratum.label} exhausted at page ${page}`);
        state.exhaustedStrata.push(stratum.label);
        active.splice(active.indexOf(stratum), 1);
        stratumIndex = 0;
      } else {
        console.error(`  search failed (${stratum.label} p${page}): ${msg}`);
        consecutiveDry++;
      }
      continue;
    }

    if (candidates.length === 0) {
      state.exhaustedStrata.push(stratum.label);
      active.splice(active.indexOf(stratum), 1);
      stratumIndex = 0;
      continue;
    }

    state.strataPages[stratum.label] = page + 1;

    const unseen = candidates.filter((r) => !seen.has(`${r.owner}/${r.name}`));
    if (unseen.length === 0) {
      consecutiveDry++;
      continue;
    }
    consecutiveDry = 0;

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
          rateLimited = true;
          break;
        }
        console.error(`  ${key} failed: ${(err as Error).message}`);
      }
    }
    if (rateLimited) break;
  }

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

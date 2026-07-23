/**
 * Detection self-test.
 *
 * The study's headline number is a percentage of repos running 2+ AI
 * reviewers. A broken bot registry produces 0% — which is indistinguishable
 * from a genuine negative result and would silently kill the project on bad
 * data. This scans repos known to run specific bots and asserts each one is
 * actually detected.
 *
 *   node --experimental-strip-types --no-warnings apps/study/src/validate.ts
 */

import { execFileSync } from 'node:child_process';
import { GitHubClient } from './github.ts';
import { scanRepo } from './scan.ts';
import { vendorsInScan } from './analyze.ts';
import type { RepoRef } from './types.ts';

/** Repos observed to carry each bot, found via `gh search prs --commenter`. */
const FIXTURES: Array<{ repo: string; expect: string }> = [
  { repo: 'maximhq/bifrost',                  expect: 'CodeRabbit' },
  { repo: 'kubeedge/kubeedge',                expect: 'Gemini' },
  { repo: 'datacommonsorg/website',           expect: 'Gemini' },
  { repo: 'duckduckgo/content-scope-scripts', expect: 'Cursor' },
  { repo: 'geins-io/geins-studio',            expect: 'Greptile' },
];

function token(): string {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
}

async function main(): Promise<void> {
  const client = new GitHubClient({ token: token() });
  let passed = 0;
  let failed = 0;

  console.log('\nBot detection self-test\n');

  for (const fx of FIXTURES) {
    const [owner, name] = fx.repo.split('/');
    const ref: RepoRef = { owner, name, stars: 0, primaryLanguage: null, pushedAt: '' };

    // 60 PRs: bots comment on a minority of PRs, so a shallow window can miss
    // a vendor that is genuinely present and produce a false failure.
    const scan = await scanRepo(client, ref, 60);

    if (scan.error) {
      console.log(`  ?? ${fx.repo} — scan error: ${scan.error.slice(0, 70)}`);
      failed++;
      continue;
    }

    const vendors = vendorsInScan(scan);
    const hit = vendors.includes(fx.expect);
    const detail = vendors.length ? vendors.join(', ') : 'none';
    console.log(
      `  ${hit ? 'PASS' : 'FAIL'}  ${fx.repo.padEnd(38)} expected ${fx.expect.padEnd(11)} found: ${detail}`,
    );
    hit ? passed++ : failed++;
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) {
    console.log('A failure means either the registry is missing a login, or the bot');
    console.log('no longer comments on that repo. Check before trusting any 0% result.\n');
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

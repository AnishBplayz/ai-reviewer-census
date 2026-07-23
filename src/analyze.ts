/**
 * Turns raw scans into the four numbers the study exists to produce:
 * coverage, volume, duplicate rate, and action rate.
 *
 * Every metric here is deterministic. No LLM is involved at any point, which
 * is what makes the result cheap to recompute and hard to argue with.
 */

import { identifyBot, isUnclassifiedBot } from './bots.ts';
import type { PullRecord, RepoScan, ThreadRecord } from './types.ts';

/**
 * Vendors that participated in a PR, resolved from raw logins at analysis
 * time so registry updates apply retroactively to the whole corpus.
 */
export function vendorsOnPull(pr: PullRecord): Set<string> {
  const out = new Set<string>();
  for (const p of pr.participants) {
    const bot = identifyBot(p.login);
    if (bot?.category === 'ai-review') out.add(bot.vendor);
  }
  return out;
}

/** Two threads on the same file within this many lines are treated as overlapping. */
export const OVERLAP_WINDOW = 5;

export interface VendorStats {
  vendor: string;
  repos: number;
  pulls: number;
  threads: number;
  /** Threads whose anchored code later changed. The action proxy. */
  outdated: number;
  resolved: number;
  avgBodyLength: number;
  avgRepliesPerThread: number;
  threadsPerPull: number;
  actionRate: number;
  resolveRate: number;
}

export interface StudyResult {
  generatedAt: string;
  sample: {
    reposScanned: number;
    reposWithError: number;
    pullsScanned: number;
    pullsWithAnyAiReview: number;
    threadsTotal: number;
    threadsFromAi: number;
    threadsFromHumans: number;
  };
  coverage: {
    reposWithAnyAi: number;
    reposWith2Plus: number;
    reposWith3Plus: number;
    pctReposWithAnyAi: number;
    /** THE headline number. Go/no-go threshold is 20%. */
    pctReposWith2Plus: number;
    pctReposWith3Plus: number;
  };
  duplication: {
    multiBotPulls: number;
    /** Distinct cross-vendor thread pairs landing on the same code region. */
    overlappingPairs: number;
    aiThreadsOnMultiBotPulls: number;
    /** Share of AI threads on multi-bot PRs that collide with a rival's. */
    pctOverlapping: number;
    topCollidingPairs: Array<{ pair: string; count: number }>;
  };
  action: {
    aiActionRate: number;
    humanActionRate: number;
    /** Ratio of human to AI action rate. >1 means humans are listened to more. */
    humanToAiRatio: number;
  };
  vendors: VendorStats[];
  unclassifiedBots: Array<{ login: string; count: number }>;
  languages: Array<{ language: string; repos: number; pctWith2Plus: number }>;
}

/** Every AI-reviewer vendor seen anywhere in a repo's sampled PRs. */
export function vendorsInScan(scan: RepoScan): string[] {
  const out = new Set<string>();
  for (const pr of scan.pulls) for (const v of vendorsOnPull(pr)) out.add(v);
  return [...out];
}

const pct = (n: number, d: number) => (d === 0 ? 0 : Math.round((n / d) * 1000) / 10);

/** Resolved at analysis time, not read from the stored field — see vendorsOnPull. */
function threadVendor(t: ThreadRecord): string | null {
  const bot = identifyBot(t.authorLogin);
  return bot?.category === 'ai-review' ? bot.vendor : null;
}

function aiThreads(threads: ThreadRecord[]): ThreadRecord[] {
  return threads.filter((t) => threadVendor(t) !== null);
}

/**
 * Count cross-vendor collisions on a single PR.
 *
 * Compares each unordered vendor pair once and counts a thread as colliding
 * at most once per rival vendor, so a bot that leaves ten threads on one hot
 * file cannot inflate the duplicate rate on its own.
 */
function countOverlaps(threads: ThreadRecord[]): { pairs: number; labels: string[] } {
  const ai = aiThreads(threads).filter((t) => t.line !== null);
  const labels: string[] = [];
  let pairs = 0;

  for (let i = 0; i < ai.length; i++) {
    for (let j = i + 1; j < ai.length; j++) {
      const a = ai[i];
      const b = ai[j];
      const va = threadVendor(a);
      const vb = threadVendor(b);
      if (va === vb) continue;
      if (a.path !== b.path) continue;
      if (Math.abs((a.line as number) - (b.line as number)) > OVERLAP_WINDOW) continue;
      pairs++;
      labels.push([va, vb].sort().join(' + '));
    }
  }
  return { pairs, labels };
}

export function analyze(scans: RepoScan[]): StudyResult {
  const ok = scans.filter((s) => !s.error);
  const vendorAgg = new Map<
    string,
    { repos: Set<string>; pulls: Set<string>; threads: number; outdated: number; resolved: number; bodyLen: number; replies: number }
  >();
  const unclassified = new Map<string, number>();
  const pairCounts = new Map<string, number>();
  const langAgg = new Map<string, { repos: number; with2Plus: number }>();

  let pullsScanned = 0;
  let pullsWithAi = 0;
  let threadsTotal = 0;
  let threadsFromAi = 0;
  let threadsFromHumans = 0;
  let humanOutdated = 0;
  let aiOutdated = 0;
  let multiBotPulls = 0;
  let overlappingPairs = 0;
  let aiThreadsOnMultiBotPulls = 0;

  let reposWithAnyAi = 0;
  let reposWith2Plus = 0;
  let reposWith3Plus = 0;

  for (const scan of ok) {
    const repoKey = `${scan.repo.owner}/${scan.repo.name}`;

    const repoVendors = new Set(vendorsInScan(scan));

    if (repoVendors.size >= 1) reposWithAnyAi++;
    if (repoVendors.size >= 2) reposWith2Plus++;
    if (repoVendors.size >= 3) reposWith3Plus++;

    const lang = scan.repo.primaryLanguage ?? 'Unknown';
    const l = langAgg.get(lang) ?? { repos: 0, with2Plus: 0 };
    l.repos++;
    if (repoVendors.size >= 2) l.with2Plus++;
    langAgg.set(lang, l);

    for (const pr of scan.pulls) {
      pullsScanned++;
      const prKey = `${repoKey}#${pr.number}`;

      const prVendors = vendorsOnPull(pr);
      if (prVendors.size >= 1) pullsWithAi++;

      for (const p of pr.participants) {
        if (isUnclassifiedBot(p.login, p.isBot ? 'Bot' : 'User')) {
          unclassified.set(p.login, (unclassified.get(p.login) ?? 0) + 1);
        }
      }

      const ai = aiThreads(pr.threads);
      threadsTotal += pr.threads.length;
      threadsFromAi += ai.length;

      for (const t of pr.threads) {
        const vendor = threadVendor(t);
        if (vendor) {
          if (t.isOutdated) aiOutdated++;
          const agg =
            vendorAgg.get(vendor) ??
            { repos: new Set<string>(), pulls: new Set<string>(), threads: 0, outdated: 0, resolved: 0, bodyLen: 0, replies: 0 };
          agg.repos.add(repoKey);
          agg.pulls.add(prKey);
          agg.threads++;
          if (t.isOutdated) agg.outdated++;
          if (t.isResolved) agg.resolved++;
          agg.bodyLen += t.bodyLength;
          agg.replies += t.replyCount;
          vendorAgg.set(vendor, agg);
        } else if (t.authorLogin && !t.authorIsBot) {
          // Human baseline. Unclassified bots are excluded from both sides
          // rather than being folded in here, which would depress the human
          // action rate and flatter the AI comparison.
          threadsFromHumans++;
          if (t.isOutdated) humanOutdated++;
        }
      }

      // Duplication is only meaningful where two bots could have collided.
      if (prVendors.size >= 2) {
        multiBotPulls++;
        aiThreadsOnMultiBotPulls += ai.length;
        const { pairs, labels } = countOverlaps(pr.threads);
        overlappingPairs += pairs;
        for (const label of labels) pairCounts.set(label, (pairCounts.get(label) ?? 0) + 1);
      }
    }
  }

  const vendors: VendorStats[] = [...vendorAgg.entries()]
    .map(([vendor, a]) => ({
      vendor,
      repos: a.repos.size,
      pulls: a.pulls.size,
      threads: a.threads,
      outdated: a.outdated,
      resolved: a.resolved,
      avgBodyLength: Math.round(a.bodyLen / Math.max(1, a.threads)),
      avgRepliesPerThread: Math.round((a.replies / Math.max(1, a.threads)) * 100) / 100,
      threadsPerPull: Math.round((a.threads / Math.max(1, a.pulls.size)) * 100) / 100,
      actionRate: pct(a.outdated, a.threads),
      resolveRate: pct(a.resolved, a.threads),
    }))
    .sort((x, y) => y.threads - x.threads);

  const aiActionRate = pct(aiOutdated, threadsFromAi);
  const humanActionRate = pct(humanOutdated, threadsFromHumans);

  return {
    generatedAt: new Date().toISOString(),
    sample: {
      reposScanned: ok.length,
      reposWithError: scans.length - ok.length,
      pullsScanned,
      pullsWithAnyAiReview: pullsWithAi,
      threadsTotal,
      threadsFromAi,
      threadsFromHumans,
    },
    coverage: {
      reposWithAnyAi,
      reposWith2Plus,
      reposWith3Plus,
      pctReposWithAnyAi: pct(reposWithAnyAi, ok.length),
      pctReposWith2Plus: pct(reposWith2Plus, ok.length),
      pctReposWith3Plus: pct(reposWith3Plus, ok.length),
    },
    duplication: {
      multiBotPulls,
      overlappingPairs,
      aiThreadsOnMultiBotPulls,
      pctOverlapping: pct(overlappingPairs, aiThreadsOnMultiBotPulls),
      topCollidingPairs: [...pairCounts.entries()]
        .map(([pair, count]) => ({ pair, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10),
    },
    action: {
      aiActionRate,
      humanActionRate,
      humanToAiRatio: aiActionRate === 0 ? 0 : Math.round((humanActionRate / aiActionRate) * 100) / 100,
    },
    vendors,
    unclassifiedBots: [...unclassified.entries()]
      .map(([login, count]) => ({ login, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 25),
    languages: [...langAgg.entries()]
      .filter(([, v]) => v.repos >= 3)
      .map(([language, v]) => ({ language, repos: v.repos, pctWith2Plus: pct(v.with2Plus, v.repos) }))
      .sort((a, b) => b.repos - a.repos)
      .slice(0, 15),
  };
}

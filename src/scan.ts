import { GitHubClient, PULLS_QUERY } from './github.ts';
import { identifyBot, isAiReviewer, isUnclassifiedBot } from './bots.ts';
import type { PullRecord, RepoRef, RepoScan, ThreadRecord } from './types.ts';

interface RawAuthor {
  login: string;
  __typename: string;
}

interface RawThread {
  isOutdated: boolean;
  isResolved: boolean;
  path: string;
  line: number | null;
  originalLine: number | null;
  comments: {
    totalCount: number;
    nodes: Array<{ author: RawAuthor | null; createdAt: string; body: string }>;
  };
}

interface RawPull {
  number: number;
  state: string;
  createdAt: string;
  mergedAt: string | null;
  changedFiles: number;
  additions: number;
  deletions: number;
  author: RawAuthor | null;
  reviewThreads: { nodes: RawThread[] };
  comments: { nodes: Array<{ author: RawAuthor | null }> };
  reviews: { nodes: Array<{ author: RawAuthor | null; state: string }> };
}

interface PullsResponse {
  repository: { pullRequests: { nodes: RawPull[] } } | null;
}

export async function scanRepo(
  client: GitHubClient,
  repo: RepoRef,
  prCount: number,
): Promise<RepoScan> {
  const scannedAt = new Date().toISOString();

  let data: PullsResponse;
  try {
    data = await client.graphql<PullsResponse>(PULLS_QUERY, {
      owner: repo.owner,
      name: repo.name,
      prCount,
    });
  } catch (err) {
    // A single unreadable repo must never abort a scheduled run — record the
    // failure as data and move on. Silent skips would quietly bias coverage.
    return { repo, scannedAt, pulls: [], error: (err as Error).message };
  }

  const rawPulls = data.repository?.pullRequests?.nodes ?? [];
  const pulls: PullRecord[] = [];

  for (const pr of rawPulls) {
    if (!pr) continue;

    const threads: ThreadRecord[] = [];
    for (const t of pr.reviewThreads?.nodes ?? []) {
      if (!t) continue;
      const opener = t.comments?.nodes?.[0];
      const login = opener?.author?.login ?? null;
      const bot = identifyBot(login);

      threads.push({
        path: t.path,
        line: t.line ?? t.originalLine,
        isOutdated: Boolean(t.isOutdated),
        isResolved: Boolean(t.isResolved),
        authorLogin: login,
        authorIsBot: opener?.author?.__typename === 'Bot',
        vendor: bot?.category === 'ai-review' ? bot.vendor : null,
        createdAt: opener?.createdAt ?? pr.createdAt,
        bodyLength: opener?.body?.length ?? 0,
        replyCount: Math.max(0, (t.comments?.totalCount ?? 1) - 1),
      });
    }

    // Bots announce themselves through either channel, and which one varies by
    // vendor — issue comments for some, formal PR reviews for others. Both are
    // captured raw; classification is analyze.ts's job.
    const participants = new Map<string, boolean>();
    const authors: Array<RawAuthor | null> = [
      ...(pr.comments?.nodes ?? []).map((c) => c?.author ?? null),
      ...(pr.reviews?.nodes ?? []).map((r) => r?.author ?? null),
      ...threads.map((t) =>
        t.authorLogin ? { login: t.authorLogin, __typename: t.authorIsBot ? 'Bot' : 'User' } : null,
      ),
    ];
    for (const a of authors) {
      if (a?.login) participants.set(a.login, a.__typename === 'Bot');
    }

    pulls.push({
      number: pr.number,
      state: pr.state,
      createdAt: pr.createdAt,
      mergedAt: pr.mergedAt,
      authorLogin: pr.author?.login ?? null,
      changedFiles: pr.changedFiles ?? 0,
      additions: pr.additions ?? 0,
      deletions: pr.deletions ?? 0,
      threads,
      participants: [...participants].map(([login, isBot]) => ({ login, isBot })),
    });
  }

  return { repo, scannedAt, pulls };
}

export { isAiReviewer };

/**
 * Minimal GitHub client — GraphQL for PR data, REST for repo search.
 *
 * Zero dependencies on purpose: this runs unattended on a schedule, and an
 * `npm install` step is one more thing that can break a cron job at 3am.
 */

import type { RepoRef } from './types.ts';

const GRAPHQL = 'https://api.github.com/graphql';
const REST = 'https://api.github.com';

export interface ClientOptions {
  token: string;
  /** Stop issuing GraphQL calls once the point budget drops below this. */
  reservePoints?: number;
  onLog?: (msg: string) => void;
}

export class RateLimitedError extends Error {
  resetAt: string;

  constructor(resetAt: string) {
    super(`GitHub rate limit exhausted; resets at ${resetAt}`);
    this.name = 'RateLimitedError';
    this.resetAt = resetAt;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class GitHubClient {
  private token: string;
  private reservePoints: number;
  private log: (msg: string) => void;

  /** Last observed GraphQL budget, for progress reporting. */
  public remainingPoints = Infinity;
  public rateLimitResetAt: string | null = null;

  constructor(opts: ClientOptions) {
    this.token = opts.token;
    this.reservePoints = opts.reservePoints ?? 100;
    this.log = opts.onLog ?? (() => {});
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `bearer ${this.token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'diffhawk-study',
      Accept: 'application/vnd.github+json',
    };
  }

  /**
   * POST a GraphQL query with retry on transient failure.
   *
   * GitHub answers secondary rate limits with 403 + Retry-After rather than
   * 429, and serves occasional 502s under load on large queries. Both are
   * retried; a genuine budget exhaustion throws so the caller can checkpoint
   * and stop cleanly instead of burning the remaining attempts.
   */
  async graphql<T>(query: string, variables: Record<string, unknown>, attempt = 0): Promise<T> {
    if (this.remainingPoints < this.reservePoints && this.rateLimitResetAt) {
      throw new RateLimitedError(this.rateLimitResetAt);
    }

    const res = await fetch(GRAPHQL, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ query, variables }),
    });

    if (res.status === 403 || res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after') ?? 60);
      if (attempt >= 4) throw new RateLimitedError(new Date(Date.now() + retryAfter * 1000).toISOString());
      this.log(`  secondary rate limit, waiting ${retryAfter}s`);
      await sleep(retryAfter * 1000);
      return this.graphql<T>(query, variables, attempt + 1);
    }

    if (res.status >= 500) {
      if (attempt >= 4) throw new Error(`GitHub ${res.status} after ${attempt} retries`);
      const backoff = Math.min(2 ** attempt * 1000, 16_000);
      await sleep(backoff);
      return this.graphql<T>(query, variables, attempt + 1);
    }

    if (!res.ok) {
      throw new Error(`GitHub ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }

    const json = (await res.json()) as {
      data?: T & { rateLimit?: { remaining: number; resetAt: string } };
      errors?: Array<{ message: string; type?: string }>;
    };

    if (json.data?.rateLimit) {
      this.remainingPoints = json.data.rateLimit.remaining;
      this.rateLimitResetAt = json.data.rateLimit.resetAt;
    }

    if (json.errors?.length) {
      // Partial data is normal: deleted branches, blocked repos, and
      // permission-scoped fields error individually while the rest resolves.
      const fatal = json.errors.filter(
        (e) => e.type !== 'NOT_FOUND' && e.type !== 'FORBIDDEN' && !/rate limit/i.test(e.message),
      );
      if (fatal.length && !json.data) {
        throw new Error(`GraphQL: ${fatal.map((e) => e.message).join('; ')}`);
      }
    }

    if (!json.data) throw new Error('GraphQL returned no data');
    return json.data;
  }

  /**
   * Search for active public repositories within one star band.
   *
   * Sampling frame: public, non-archived repos with a recent push, partitioned
   * into star strata. Biased toward popular open source and away from private
   * corporate monorepos — stated as a limitation rather than silently ignored.
   */
  async searchRepos(params: {
    page: number;
    perPage: number;
    minStars: number;
    /** Inclusive upper bound; null means unbounded (the top stratum). */
    maxStars: number | null;
    pushedAfter: string;
  }): Promise<RepoRef[]> {
    // GitHub serves at most 1000 results per distinct query. A single
    // `stars:>=200` frame therefore caps the reachable population at 1000 repos
    // no matter how many pages are requested — which is exactly the wall this
    // hit at n=462. Partitioning by star band gives each stratum its own
    // 1000-result window and removes the ceiling.
    const starQuery =
      params.maxStars === null
        ? `stars:>=${params.minStars}`
        : `stars:${params.minStars}..${params.maxStars}`;
    const q = `${starQuery} pushed:>${params.pushedAfter} is:public archived:false`;
    const url =
      `${REST}/search/repositories?q=${encodeURIComponent(q)}` +
      `&sort=updated&order=desc&per_page=${params.perPage}&page=${params.page}`;

    const res = await fetch(url, { headers: this.headers() });

    if (res.status === 403 || res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after') ?? 60);
      this.log(`  search rate limited, waiting ${retryAfter}s`);
      await sleep(retryAfter * 1000);
      return this.searchRepos(params);
    }
    if (!res.ok) throw new Error(`Repo search ${res.status}: ${(await res.text()).slice(0, 200)}`);

    const json = (await res.json()) as {
      items: Array<{
        owner: { login: string };
        name: string;
        stargazers_count: number;
        language: string | null;
        pushed_at: string;
      }>;
    };

    return json.items.map((r) => ({
      owner: r.owner.login,
      name: r.name,
      stars: r.stargazers_count,
      primaryLanguage: r.language,
      pushedAt: r.pushed_at,
    }));
  }
}

/**
 * Fetch recent PRs with their inline review threads.
 *
 * `isOutdated` is the key field and the reason this study needs no diff
 * walking at all: GitHub marks a review thread outdated precisely when the
 * code it anchors to has changed. That is the "did the comment lead to a code
 * change" signal, computed by GitHub, free, and deterministic.
 */
export const PULLS_QUERY = /* GraphQL */ `
  query ($owner: String!, $name: String!, $prCount: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequests(
        states: [MERGED, CLOSED, OPEN]
        first: $prCount
        orderBy: { field: UPDATED_AT, direction: DESC }
      ) {
        nodes {
          number
          state
          createdAt
          mergedAt
          changedFiles
          additions
          deletions
          author { login }
          reviewThreads(first: 40) {
            nodes {
              isOutdated
              isResolved
              path
              line
              originalLine
              comments(first: 6) {
                totalCount
                nodes {
                  author { login __typename }
                  createdAt
                  body
                }
              }
            }
          }
          comments(first: 30) {
            nodes {
              author { login __typename }
            }
          }
          # Many reviewers (Gemini, Cursor, Greptile) post their summary as a
          # formal PR review rather than an issue comment. Omitting this
          # connection undercounts them to zero.
          reviews(first: 30) {
            nodes {
              author { login __typename }
              state
            }
          }
        }
      }
    }
    rateLimit {
      remaining
      resetAt
    }
  }
`;

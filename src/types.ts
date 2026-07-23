export interface RepoRef {
  owner: string;
  name: string;
  stars: number;
  primaryLanguage: string | null;
  pushedAt: string;
}

/** One inline review thread, flattened from GitHub's nested shape. */
export interface ThreadRecord {
  path: string;
  /** Current line, or the original line when the thread has gone outdated. */
  line: number | null;
  /** True once the code the thread points at has changed. Our action proxy. */
  isOutdated: boolean;
  /** True when a human explicitly clicked resolve. */
  isResolved: boolean;
  authorLogin: string | null;
  /** From GraphQL `__typename` — authoritative, unlike the `[bot]` suffix. */
  authorIsBot: boolean;
  /** Canonical vendor name if the author is a known AI reviewer. */
  vendor: string | null;
  createdAt: string;
  bodyLength: number;
  /** Number of replies after the opening comment — a weak engagement signal. */
  replyCount: number;
}

export interface PullRecord {
  number: number;
  state: string;
  createdAt: string;
  mergedAt: string | null;
  authorLogin: string | null;
  changedFiles: number;
  additions: number;
  deletions: number;
  threads: ThreadRecord[];
  /**
   * Every distinct comment/review author on the PR, stored as raw logins.
   *
   * Deliberately NOT resolved to vendor names at scan time. The bot registry
   * grows as new reviewers are discovered, and baking today's classification
   * into the log would mean rescanning the whole corpus after every registry
   * change. Resolution happens in analyze.ts, so a registry fix reclassifies
   * all historical data for free.
   */
  participants: Array<{ login: string; isBot: boolean }>;
}

export interface RepoScan {
  repo: RepoRef;
  scannedAt: string;
  pulls: PullRecord[];
  error?: string;
}

export interface ScanState {
  /** Next page of the repo search to consume, so scheduled runs advance. */
  nextSearchPage: number;
  scannedRepoKeys: string[];
  runs: Array<{ startedAt: string; repos: number; pulls: number }>;
}

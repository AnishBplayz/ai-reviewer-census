/**
 * Registry of bot identities seen on GitHub pull requests.
 *
 * Categorisation matters more than it looks. The study's headline number is
 * "how many repos run 2+ *AI reviewers*" — if Dependabot and Codecov counted,
 * the number would be meaningless. Only `ai-review` counts toward coverage.
 */

export type BotCategory =
  | 'ai-review'   // LLM-based reviewers — the population under study
  | 'static'      // deterministic analysis (linters, SAST, coverage)
  | 'infra';      // dependency bumps, CI status, changelog, release automation

export interface BotIdentity {
  /** Canonical vendor name used in reports. */
  vendor: string;
  category: BotCategory;
  /** Exact GitHub logins, lowercased. */
  logins: string[];
  /** Substring fallbacks for logins we may not have enumerated. */
  patterns?: string[];
}

export const BOTS: BotIdentity[] = [
  // ─── AI reviewers ────────────────────────────────────────────────────────
  { vendor: 'CodeRabbit',  category: 'ai-review', logins: ['coderabbitai[bot]', 'coderabbitai'] },
  { vendor: 'Cursor',      category: 'ai-review', logins: ['cursor[bot]', 'cursoragent'] },
  { vendor: 'Copilot',     category: 'ai-review', logins: ['copilot-pull-request-reviewer[bot]', 'copilot', 'github-copilot[bot]'] },
  { vendor: 'Qodo',        category: 'ai-review', logins: ['qodo-ai[bot]', 'qodo-merge-pro[bot]', 'qodo-merge-pro-for-open-source[bot]', 'codiumai-pr-agent[bot]', 'codiumai-pr-agent-free[bot]'] },
  { vendor: 'Greptile',    category: 'ai-review', logins: ['greptile-apps[bot]', 'greptileai[bot]', 'greptile-apps-staging[bot]'] },
  { vendor: 'Ellipsis',    category: 'ai-review', logins: ['ellipsis-dev[bot]'] },
  { vendor: 'Sourcery',    category: 'ai-review', logins: ['sourcery-ai[bot]'] },
  { vendor: 'Gemini',      category: 'ai-review', logins: ['gemini-code-assist[bot]'] },
  { vendor: 'Claude',      category: 'ai-review', logins: ['claude[bot]', 'claude-code[bot]', 'anthropic-claude[bot]'] },
  { vendor: 'Devin',       category: 'ai-review', logins: ['devin-ai-integration[bot]'] },
  { vendor: 'Sweep',       category: 'ai-review', logins: ['sweep-ai[bot]'] },
  { vendor: 'CodeAnt',     category: 'ai-review', logins: ['codeant-ai[bot]'] },
  { vendor: 'Bito',        category: 'ai-review', logins: ['bito-ai[bot]', 'bitobot[bot]'] },
  { vendor: 'cubic',       category: 'ai-review', logins: ['cubic-dev-ai[bot]'] },
  { vendor: 'Korbit',      category: 'ai-review', logins: ['korbit-ai[bot]', 'korbit-ai-mentor[bot]'] },
  { vendor: 'Entelligence',category: 'ai-review', logins: ['entelligence-ai[bot]', 'entelligenceai[bot]'] },
  { vendor: 'Graphite',    category: 'ai-review', logins: ['graphite-app[bot]'] },
  { vendor: 'Baz',         category: 'ai-review', logins: ['baz-ai[bot]'] },
  { vendor: 'Panto',       category: 'ai-review', logins: ['panto-ai[bot]'] },
  { vendor: 'Matter',      category: 'ai-review', logins: ['matterai[bot]', 'matter-ai[bot]'] },
  { vendor: 'Trag',        category: 'ai-review', logins: ['trag-bot[bot]'] },
  { vendor: 'Callstack',   category: 'ai-review', logins: ['callstack-ai[bot]'] },
  { vendor: 'Pullfrog',    category: 'ai-review', logins: ['pullfrog[bot]', 'pullfrog-dev[bot]'] },
  { vendor: 'Codex',       category: 'ai-review', logins: ['chatgpt-codex-connector[bot]'] },
  { vendor: 'RoboRev',     category: 'ai-review', logins: ['roborev-ci[bot]'] },
  { vendor: 'CodSpeed',    category: 'static',    logins: ['codspeed-hq[bot]'] },
  { vendor: 'Aikido',      category: 'static',    logins: ['aikido-pr-checks[bot]'] },
  { vendor: 'Mergify',     category: 'infra',     logins: ['mergify[bot]'] },

  // ─── Static analysis — excluded from coverage, tracked for context ───────
  { vendor: 'SonarCloud',  category: 'static', logins: ['sonarcloud[bot]', 'sonarqubecloud[bot]'] },
  { vendor: 'DeepSource',  category: 'static', logins: ['deepsource-autofix[bot]', 'deepsource-io[bot]'] },
  { vendor: 'Codecov',     category: 'static', logins: ['codecov[bot]', 'codecov-commenter'] },
  { vendor: 'Snyk',        category: 'static', logins: ['snyk-bot'] },
  { vendor: 'CodeFactor',  category: 'static', logins: ['codefactor-io[bot]'] },
  { vendor: 'CodeScene',   category: 'static', logins: ['codescene-delta-analysis[bot]'] },
  { vendor: 'Semgrep',     category: 'static', logins: ['semgrep-app[bot]'] },
  { vendor: 'Codacy',      category: 'static', logins: ['codacy-production[bot]'] },

  // ─── Infrastructure — never relevant, excluded loudly ────────────────────
  { vendor: 'Dependabot',  category: 'infra', logins: ['dependabot[bot]', 'dependabot-preview[bot]'] },
  { vendor: 'Renovate',    category: 'infra', logins: ['renovate[bot]'] },
  { vendor: 'Vercel',      category: 'infra', logins: ['vercel[bot]'] },
  { vendor: 'Netlify',     category: 'infra', logins: ['netlify[bot]'] },
  { vendor: 'Changeset',   category: 'infra', logins: ['changeset-bot[bot]'] },
  { vendor: 'GitHubActions', category: 'infra', logins: ['github-actions[bot]'] },
  { vendor: 'CLA',         category: 'infra', logins: ['cla-bot[bot]', 'cla-assistant[bot]'] },
];

/**
 * GitHub reports bot logins inconsistently across APIs: REST and the search
 * endpoint return `gemini-code-assist[bot]`, while GraphQL returns the bare
 * `gemini-code-assist`. Registry entries are written in the REST form, so both
 * sides are normalised to the bare name before comparison.
 *
 * Getting this wrong silently matches nothing and reports 0% coverage, which
 * is indistinguishable from a real negative — see apps/study/src/validate.ts.
 */
export function normalizeLogin(login: string): string {
  return login.toLowerCase().replace(/\[bot\]$/, '');
}

const BY_LOGIN = new Map<string, BotIdentity>();
for (const bot of BOTS) {
  for (const login of bot.logins) BY_LOGIN.set(normalizeLogin(login), bot);
}

/**
 * Resolve a comment author login to a known bot, or null if it looks human.
 *
 * Unknown `[bot]` logins deliberately return null rather than being guessed
 * into `ai-review`. Inflating coverage with unclassified bots would corrupt
 * the one number this whole study exists to produce. Unknowns are surfaced
 * separately by the report so the registry can be extended deliberately.
 */
export function identifyBot(login: string | null | undefined): BotIdentity | null {
  if (!login) return null;
  const key = normalizeLogin(login);

  const exact = BY_LOGIN.get(key);
  if (exact) return exact;

  for (const bot of BOTS) {
    if (bot.patterns?.some((p) => key.includes(p))) return bot;
  }
  return null;
}

export function isAiReviewer(login: string | null | undefined): boolean {
  return identifyBot(login)?.category === 'ai-review';
}

/**
 * Looks like a bot but isn't in the registry — surfaced by the report so the
 * registry can be extended deliberately rather than by guesswork.
 *
 * `typename` is GraphQL's `__typename` on the author ("Bot" | "User"), which is
 * authoritative. The `[bot]` suffix check is a fallback for REST-shaped data.
 */
export function isUnclassifiedBot(
  login: string | null | undefined,
  typename?: string | null,
): boolean {
  if (!login) return false;
  const looksLikeBot = typename === 'Bot' || login.toLowerCase().endsWith('[bot]');
  return looksLikeBot && !BY_LOGIN.has(normalizeLogin(login));
}

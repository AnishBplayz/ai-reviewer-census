# AI Code Review Census

**How many repositories actually run AI code reviewers — and does anyone act on them?**

Every AI code review vendor publishes a benchmark showing it wins. None of them
publish how many teams run *more than one* reviewer, how often those reviewers
land on the same lines, or how their comments compare to a human's on the one
signal that matters: did the code actually change afterwards.

This measures that from real GitHub data. No LLM is used anywhere in the
analysis — every number is deterministic and reproducible from the raw scans
committed in `data/`.

> **Status: preliminary.** The corpus is still growing and the numbers below
> move as it does. Treat anything here as directional until the sample is
> several hundred repositories. Current n is stated on every table.

---

## Findings so far

<!-- Numbers regenerate from data/report.json on every collection run. -->
_Corpus: **120 repositories**, 2,595 pull requests, 1,223 AI review threads._

### Adoption is real, but running two reviewers is not common

| | Share of active repos |
| --- | --- |
| Run **at least one** AI reviewer | **35.8%** |
| Run **2 or more** | 13.3% |
| Run **3 or more** | 4.2% |

Roughly a third of active public repositories now have an AI reviewer commenting
on pull requests. That is a large population. The multi-reviewer scenario that
consolidation tools are built around is a much smaller one.

### Reviewers rarely step on each other

**9.3%** of AI review threads on multi-bot PRs land within five lines of a
different vendor's thread — 37 collisions across 100 pull requests where two or
more reviewers both commented.

The premise that teams are drowning in duplicate bot comments is not visible in
this data. Where two reviewers coexist, they mostly flag different things.

### Bot comments are acted on nearly as often as human ones

| Author | Threads | Code changed afterwards |
| --- | ---: | ---: |
| Humans | 1,255 | **60.7%** |
| AI reviewers | 1,223 | **51.9%** |

This is the finding most likely to be misread, so: it is **not** evidence that
AI reviewers are as *useful* as humans. It measures whether the anchored code
later changed, which is a proxy with a known bias — see Limitations. But the
gap is far narrower than the "AI review is just noise" consensus assumes.

### Per-vendor

> **The sample is too small for per-vendor conclusions.** Several vendors appear
> in fewer than five repositories. This table is published for transparency about
> what the corpus contains, not as a ranking. Do not cite it as one.

See [`STUDY.md`](STUDY.md) for the current generated table, and
[`data/report.json`](data/report.json) for the full machine-readable result.

---

## Method

1. **Sample.** Public, non-archived repositories with a push in the last 90
   days, drawn from GitHub search and **stratified into star bands**
   (100–249, 250–499, 500–999, 1k–2.4k, 2.5k–9.9k, 10k+), sampled round-robin.
   Stratification is not cosmetic: GitHub serves at most 1,000 results per
   distinct query, so an unpartitioned frame silently caps the study at 1,000
   repositories. Each run consumes the next page of each stratum, so the corpus
   grows rather than being re-sampled.
2. **Scan.** For each repository, the most recently updated pull requests. Every
   comment author, review author, and inline review thread is recorded as a raw
   login.
3. **Classify.** Logins are matched against an explicit allow-list of known bots
   ([`src/bots.ts`](src/bots.ts)), split into AI reviewers, static analysis, and
   infrastructure. Only AI reviewers count toward coverage.
4. **Measure.** Coverage, cross-vendor line collisions, and the action proxy.

Classification happens at **analysis** time, not scan time. Extending the bot
registry reclassifies the entire existing corpus without re-hitting the API:

```bash
npm run analyze
```

### The action proxy

GitHub marks a review thread `isOutdated` when the code it anchors to changes.
That is used as the "did this comment precede a code change" signal. It requires
no diff walking and no model, which is what makes the whole study cheap enough
to run continuously.

---

## Limitations

Stated plainly, because the numbers are wrong in knowable directions:

- **`isOutdated` is a proxy, not proof.** An unrelated edit to the same region
  also outdates a thread. It measures correlation with change, not usefulness.
- **It is biased toward bots.** Reviewers comment early in a pull request's life,
  so more subsequent commits can outdate their threads. Humans often comment
  later. This likely **inflates** the AI action rate — the true gap versus humans
  is probably wider than reported.
- **The sample is public open source.** It cannot see private corporate
  monorepos, which is exactly where paid multi-reviewer setups are most likely.
  The multi-reviewer figure is best read as a **lower bound**.
- **Coverage depends on the bot registry.** Adding two vendors moved the
  headline from 10% to 13.3% with no new data. Reviewers running under custom
  GitHub App names are undercounted. Unclassified bot logins are listed in
  `STUDY.md` so the gap stays visible.
- **Per-repo depth is shallow.** Only recent pull requests are scanned, so a
  repository that dropped a second reviewer long ago will not register.

If you think a number is wrong, the raw scans are in `data/scans.jsonl` — one
JSON object per repository. Recompute and open an issue.

---

## Run it yourself

Requires Node 22.6+. **No dependencies to install.**

```bash
gh auth login   # or set GITHUB_TOKEN in .env — public_repo scope, read-only
npm run study -- --repos=40 --prs=25
```

Verify that bot detection is working before trusting any low coverage number —
a stale registry produces a false negative that looks exactly like a real one:

```bash
npm run validate
```

The collector never writes to GitHub. It only reads public pull requests.

---

## Contributing

The most useful contribution is **a missing AI reviewer**. New tools launch
constantly, and every one that is missing from
[`src/bots.ts`](src/bots.ts) depresses the headline number.

To add one: find its GitHub App login, add an entry to `BOTS`, add a fixture to
`src/validate.ts` proving it is detected on a real repository, and run
`npm run analyze` to reclassify the existing corpus. No rescan needed.

Note that GitHub reports bot logins inconsistently — REST and search return
`example[bot]`, GraphQL returns `example`. Registry entries use the REST form
and both sides are normalized before comparison.

---

## License

Apache-2.0. The data in `data/` is derived from public GitHub activity.

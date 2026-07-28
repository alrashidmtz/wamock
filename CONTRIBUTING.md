# Contributing

## The most valuable bug report

**Fidelity bugs.** If wamock accepts something Meta rejects, rejects something
Meta accepts, or returns a different code, status or payload shape than Meta
does — that is the bug that matters most, because every one of them is a
production incident someone else is going to have.

Please include:

- what you sent
- what wamock returned
- what **Meta** actually returns (a sanitized real payload is ideal)

Sanitize before posting: no access tokens, no real phone numbers, no customer
data. Use the placeholders from `test/fixtures/README.md`.

## Ground rules

**Reproduce quirks; do not smooth them over.** The whole value of this project
is that it fails the way Meta fails. If a behaviour looks like a bug in Meta,
it probably is — and wamock should still reproduce it. Add a comment explaining
why, so nobody "fixes" it later.

**Every reading of time goes through the clock.** `Date.now()` and `new Date()`
are banned outside `src/core/clock.ts`, enforced by ESLint *and* by
`test/no-wall-clock.test.ts`. One stray call makes the 24h window untestable
and produces failures that appear months later in someone else's CI.

**Tests first.** Write the failing test, watch it fail for the right reason,
then implement. Coverage thresholds are enforced at 90% for `src/core`,
`src/errors` and `src/webhooks`.

**Coverage is not the bar; mutation score is.** `npm run test:mutation` runs
Stryker, which introduces defects on purpose and reports how many the suite
fails to notice. It found what coverage could not: `errors/graph-error.ts` had
100% line coverage and a 48% mutation score — every error message and `type`
could be reworded and nothing failed, even though that wording is the contract
integrations match on. It is slow by design, so it is not part of
`npm run check`; CI runs it weekly and the build breaks below the configured
threshold.

Not every survivor deserves a test. Pin things that are **observable contract**
— error codes and wording, payload field names and values, Meta's documented
limits. Do not pin developer-facing debug text: making that brittle costs
maintenance without making the product safer. When you decide to leave a
survivor alone, say why in the test file near the related cases.

**Determinism is a feature.** Ids are derived from a counter, randomness comes
from a seeded PRNG, and `reset()` rewinds both. A change that makes two
identical runs produce different output is a regression.

## Getting set up

```bash
npm ci
npm test          # watch mode: npm run test:watch
npm run check     # typecheck + lint + coverage — what CI runs
```

## Clean-room note

wamock was written from Meta's public documentation and from *observed
behaviour* of production integrations. No proprietary source was copied, and
none should be. Contributions must be your own work or derived from public
documentation.

## Commit style

Explain **why**, not what — the diff already says what. A commit that changes a
behaviour to match Meta should say which real failure it reproduces.

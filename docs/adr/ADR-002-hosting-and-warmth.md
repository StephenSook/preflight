# ADR-002: A free web service kept warm, with the loss written down

**Status:** Accepted
**Date:** 2026-09-03
**Author:** Stephen Sookra

## Context

The platform gives the answer webhook three seconds to connect and five to respond, retries twice,
tries the fallback URL twice, then disconnects the call. A free web service sleeps after fifteen
idle minutes and wakes in thirty to sixty seconds, which is longer than the whole budget. The
build window is five days and the project is judged for about two weeks afterwards, during which
nobody is watching a dashboard.

The database must outlive the judging period; the free database tier on the same host expires
after thirty days.

## Decision

The API runs on a free Render web service, the database on Neon's free Postgres, and the sleep is
mitigated four ways: the process fetches its own health endpoint every four minutes while it has a
public https base URL; a GitHub Actions cron on offset minutes pings the health endpoint, which
touches the database so the database stays warm too; a dead-man workflow every six hours fails
when the keepalive has not run for longer than the worst gap observed on this platform; and a
daily workflow proves the real path end to end through the deployed gateway. The residual risk (a
platform pause, or an exhausted free-hour pool during judging) is accepted and recorded, and the
upgrade is one setting.

## Alternatives Considered

### A paid always-on instance
- **Pros:** No sleep, no mitigations, no residual risk.
- **Cons:** Money every month for a challenge entry.
- **Rejected because:** the owner chose the free tier with the risk written down; the mitigations
  make the sleep measurable rather than invisible, and the upgrade path is one click if judging
  shows a problem.

### A serverless function
- **Pros:** No idle cost, scales to zero.
- **Cons:** A cold start inside the answer budget drops the call; the runtime does not offer a
  snapshot start for Node, so the only fix is provisioned concurrency, which is a paid instance by
  another name.
- **Rejected because:** the specification's own hosting section rules out scale-to-zero for a
  service that must answer in five seconds.

## Consequences

### Positive
- Zero hosting cost during the build and judging.
- Every mitigation is a visible, dated run in the repository's Actions history, so the platform's
  behaviour is measured (the cron fired far less often than scheduled; the self-ping is what keeps
  the host warm).

### Negative
- Outbound calls through the gateway depend on this host being awake; the accepted loss.
- The workspace's free hours are shared with other services; adding a second warm service in the
  same month would exhaust them.

### Neutral
- The health endpoint reports the store name, so a deployment can never silently run on the
  in-memory store.

## References

- .github/workflows/keepalive.yml, deadman.yml, daily-call.yml
- apps/api/src/main.ts (self-ping)

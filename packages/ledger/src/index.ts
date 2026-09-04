/**
 * @preflight/ledger
 * Canonical serialisation, the hash chain, and chain verification. The Postgres table, the
 * append-only guard and the transparency-log seal live in the api and in .github/workflows/seal.yml.
 */
export { canonicalize, type Canonical } from "./canonical.js";
export { GENESIS_HASH, hashBody, makeEntry, verifyChain, type LedgerBody, type LedgerEntry, type LedgerKind, type VerifyResult } from "./chain.js";

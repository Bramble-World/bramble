import { db } from '@/index';

/**
 * Either the database or an open transaction.
 *
 * Writers in this layer take one of these rather than reaching for `db`
 * directly, because several of them have to commit together: appending a beat
 * writes `events` and `eventParticipants`, and answering a turn writes
 * `story_turns` and `storyline_sessions`. A writer that closed over `db` could
 * not participate in its caller's transaction, and the half-written states that
 * produces are exactly the ones invariants.md describes as reading perfectly
 * valid.
 *
 * Derived from `db.transaction`'s own callback parameter rather than named
 * explicitly, so it keeps the relation graph — `tx.query.*` works inside a
 * transaction — and cannot drift from the drizzle version in use.
 */
export type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

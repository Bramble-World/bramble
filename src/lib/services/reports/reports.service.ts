import * as Sentry from '@sentry/nextjs';
import { and, asc, eq, sql } from 'drizzle-orm';
import { db } from '@/index';
import {
  storyReports,
  storyReportReasonEnum,
  storylines,
  storylineSessions,
  storyTemplates,
  storyTurns,
} from '@/db/schema/tables';
import { track } from '@/lib/analytics/analytics';
import { ConflictError, NotFoundError } from '@/lib/utils/errors';
import * as sessions from '../sessions/sessions.service';
import { StoryOrigin, storyOrigin } from '../storylines/storylines.reader';

/**
 * Players reporting stories (App Store guideline 1.2: content other players
 * wrote, and content an AI wrote, needs a way to report it).
 *
 * A report changes nothing about the story. It is filed, the team is told at
 * once (a Sentry warning per report, which mails whoever is on the project), and
 * the team reads it and keeps the story or pulls its pool template — review
 * first, the user's call on 2026-11-16. `src/scripts/review-reports.ts` is the
 * reviewing end.
 *
 * Nothing here logs, tracks or reports story text: ids and codes only.
 */

export const STORY_REPORT_REASONS = storyReportReasonEnum.enumValues;
export type StoryReportReason = (typeof STORY_REPORT_REASONS)[number];

export type StoryReport = {
  id: string;
  reason: StoryReportReason;
  status: 'open' | 'kept' | 'pulled';
};

/**
 * Files the reader's report on the story this session plays.
 *
 * One per reader per story: a second report on the same story replaces the
 * reason and the beat, and reopens it if the team had kept the story — the
 * reader is saying it again. `turnId`, when given, must be a beat of this
 * session; a beat from elsewhere is "not found", the same as `/answer`.
 */
export async function reportStory(
  userId: string,
  sessionId: string,
  input: { reason: StoryReportReason; turnId?: string }
): Promise<StoryReport> {
  const session = await sessions.getSession(userId, sessionId);

  if (input.turnId) {
    const [turn] = await db
      .select({ id: storyTurns.id })
      .from(storyTurns)
      .where(and(eq(storyTurns.id, input.turnId), eq(storyTurns.sessionId, session.id)));
    if (!turn) throw new NotFoundError('Turn', input.turnId);
  }

  const [report] = await db
    .insert(storyReports)
    .values({
      userId,
      storylineId: session.storylineId,
      turnId: input.turnId ?? null,
      reason: input.reason,
    })
    .onConflictDoUpdate({
      target: [storyReports.userId, storyReports.storylineId],
      set: {
        reason: input.reason,
        turnId: input.turnId ?? null,
        // A pulled story is already out of the pool; there is nothing to reopen.
        status: sql`CASE WHEN ${storyReports.status} = 'pulled' THEN 'pulled'::story_report_status ELSE 'open'::story_report_status END`,
        reviewedAt: sql`CASE WHEN ${storyReports.status} = 'pulled' THEN ${storyReports.reviewedAt} ELSE NULL END`,
        updatedAt: new Date(),
      },
    })
    .returning({ id: storyReports.id, reason: storyReports.reason, status: storyReports.status });

  const origin = await storyOrigin(session.storylineId);
  alertTeam(report.id, input.reason, origin);
  await track(userId, { name: 'story_reported', properties: { reason: input.reason, origin } });

  return report;
}

/**
 * One Sentry issue per report, so each one alerts rather than only the first:
 * Sentry mails on a new issue, and reports grouped by message would be one.
 */
function alertTeam(reportId: string, reason: StoryReportReason, origin: StoryOrigin): void {
  Sentry.captureMessage('A player reported a story', {
    level: 'warning',
    fingerprint: ['story-report', reportId],
    tags: { flow: 'story_report', reason, origin },
    extra: { reportId },
  });
  console.info(JSON.stringify({ event: 'story_reported', reportId, reason, origin }));
}

// ---------------------------------------------------------------------------
// The reviewing end, for src/scripts/review-reports.ts.

export type OpenReport = {
  id: string;
  createdAt: Date;
  reason: StoryReportReason;
  origin: StoryOrigin;
  templateId: string | null;
  /** Open reports on the same pool story, this one included. */
  reportsOnTemplate: number;
};

export async function listOpenReports(): Promise<OpenReport[]> {
  const rows = await db
    .select({
      id: storyReports.id,
      createdAt: storyReports.createdAt,
      reason: storyReports.reason,
      templateId: storylines.templateId,
      origin: storyTemplates.origin,
    })
    .from(storyReports)
    .innerJoin(storylines, eq(storylines.id, storyReports.storylineId))
    .leftJoin(storyTemplates, eq(storyTemplates.id, storylines.templateId))
    .where(eq(storyReports.status, 'open'))
    .orderBy(asc(storyReports.createdAt));

  const perTemplate = new Map<string, number>();
  for (const r of rows) {
    if (r.templateId) perTemplate.set(r.templateId, (perTemplate.get(r.templateId) ?? 0) + 1);
  }
  return rows.map((r) => ({
    id: r.id,
    createdAt: r.createdAt,
    reason: r.reason,
    origin: r.origin ?? 'none',
    templateId: r.templateId,
    reportsOnTemplate: r.templateId ? (perTemplate.get(r.templateId) ?? 0) : 0,
  }));
}

export type ReportedStory = {
  report: Omit<OpenReport, 'reportsOnTemplate'> & { status: StoryReport['status'] };
  title: string;
  reportedTurnOrder: number | null;
  beats: { turnOrder: number; headline: string | null; narrative: string; reported: boolean }[];
};

/**
 * The story a report is about, as the reporter saw it, for the reviewer to read.
 * This is the one place the team reads a player's story, and only because the
 * player asked them to (the privacy policy says so).
 */
export async function readReportedStory(reportId: string): Promise<ReportedStory> {
  const [row] = await db
    .select({
      id: storyReports.id,
      createdAt: storyReports.createdAt,
      reason: storyReports.reason,
      status: storyReports.status,
      turnId: storyReports.turnId,
      storylineId: storyReports.storylineId,
      title: storylines.title,
      templateId: storylines.templateId,
      origin: storyTemplates.origin,
    })
    .from(storyReports)
    .innerJoin(storylines, eq(storylines.id, storyReports.storylineId))
    .leftJoin(storyTemplates, eq(storyTemplates.id, storylines.templateId))
    .where(eq(storyReports.id, reportId));
  if (!row) throw new NotFoundError('Report', reportId);

  const turns = await db
    .select({
      id: storyTurns.id,
      turnOrder: storyTurns.turnOrder,
      headline: storyTurns.headline,
      narrative: storyTurns.narrativeContent,
    })
    .from(storyTurns)
    .innerJoin(storylineSessions, eq(storylineSessions.id, storyTurns.sessionId))
    .where(eq(storylineSessions.storylineId, row.storylineId))
    .orderBy(asc(storyTurns.createdAt), asc(storyTurns.turnOrder));

  const reported = turns.find((t) => t.id === row.turnId);
  return {
    report: {
      id: row.id,
      createdAt: row.createdAt,
      reason: row.reason,
      status: row.status,
      origin: row.origin ?? 'none',
      templateId: row.templateId,
    },
    title: row.title,
    reportedTurnOrder: reported?.turnOrder ?? null,
    beats: turns.map((t) => ({
      turnOrder: t.turnOrder,
      headline: t.headline,
      narrative: t.narrative,
      reported: t.id === row.turnId,
    })),
  };
}

/** Closes a report and leaves the story where it is. */
export async function keepReportedStory(reportId: string): Promise<void> {
  const closed = await db
    .update(storyReports)
    .set({ status: 'kept', reviewedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(storyReports.id, reportId), eq(storyReports.status, 'open')))
    .returning({ id: storyReports.id });
  if (closed.length === 0) throw new NotFoundError('Open report', reportId);
}

/**
 * Takes the reported story's template out of the pool, and closes every open
 * report on it. Nobody new is given it — `startNextStory` only copies a `ready`
 * template, so a reader already offered it is offered another — and players
 * already in it keep their copy, as when an author leaves.
 *
 * Only a pool story can be pulled. A scripted story (the first one) has no
 * template; fixing one is a code change, and its report is closed with keep.
 *
 * @returns how many reports it closed.
 */
export async function pullReportedStory(reportId: string): Promise<number> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ templateId: storylines.templateId })
      .from(storyReports)
      .innerJoin(storylines, eq(storylines.id, storyReports.storylineId))
      .where(eq(storyReports.id, reportId));
    if (!row) throw new NotFoundError('Report', reportId);
    if (!row.templateId) {
      throw new ConflictError('This story is not from the pool, so there is nothing to pull.');
    }

    await tx
      .update(storyTemplates)
      .set({ status: 'rejected', reason: 'reported', updatedAt: new Date() })
      .where(eq(storyTemplates.id, row.templateId));

    const closed = await tx
      .update(storyReports)
      .set({ status: 'pulled', reviewedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(storyReports.status, 'open'),
          sql`${storyReports.storylineId} IN (SELECT id FROM storylines WHERE template_id = ${row.templateId})`
        )
      )
      .returning({ id: storyReports.id });
    return closed.length;
  });
}

/**
 * Puts a pulled pool story back, for when a second look (or an edit to a seed's
 * file) says it can stay. Only undoes a pull: a template the writer declined or
 * the check rejected is not the team's to wave through.
 */
export async function restorePulledTemplate(templateId: string): Promise<void> {
  const restored = await db
    .update(storyTemplates)
    .set({ status: 'ready', reason: null, updatedAt: new Date() })
    .where(and(eq(storyTemplates.id, templateId), eq(storyTemplates.reason, 'reported')))
    .returning({ id: storyTemplates.id });
  if (restored.length === 0) throw new NotFoundError('Pulled template', templateId);
}

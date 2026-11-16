/**
 * Reviews the stories players have reported ("report this story" in the app).
 *
 * Every report also raises a Sentry warning, so the team hears about it at once.
 * A report changes nothing until someone has read it and run one of these:
 *
 *   list                     open reports, oldest first (ids and codes only)
 *   show <reportId>          the reported story as the reporter saw it
 *   keep <reportId>          close the report; the story stays
 *   pull <reportId>          take the story's pool template out of the pool, and
 *                            close every open report on it. Players already in it
 *                            keep their copy; nobody new is given it
 *   restore <templateId>     put a pulled template back in the pool
 *
 * Production's database is only reachable from inside the cluster:
 *
 *   porter app run bramble -- node dist/scripts/review-reports.js list
 *
 * `show` prints story text. It is the one place the team reads a player's story,
 * because that player asked us to (the privacy policy says so). Don't paste it
 * anywhere else.
 */
import {
  keepReportedStory,
  listOpenReports,
  pullReportedStory,
  readReportedStory,
  restorePulledTemplate,
} from '@/lib/services/reports/reports.service';

const USAGE =
  'usage: review-reports list | show <reportId> | keep <reportId> | pull <reportId> | restore <templateId>';

async function main() {
  const [command, id] = process.argv.slice(2);

  switch (command) {
    case 'list': {
      const reports = await listOpenReports();
      if (reports.length === 0) console.log('No open reports.');
      for (const r of reports) {
        const pool = r.templateId
          ? `pool ${r.origin} ${r.templateId} (${r.reportsOnTemplate} open)`
          : 'not from the pool';
        console.log(`${r.id}  ${r.createdAt.toISOString()}  ${r.reason.padEnd(11)}  ${pool}`);
      }
      break;
    }
    case 'show': {
      if (!id) return usage();
      const story = await readReportedStory(id);
      const { report } = story;
      console.log(`report   ${report.id} (${report.status}), ${report.reason}`);
      console.log(`story    ${story.title}`);
      console.log(
        `source   ${report.templateId ? `pool ${report.origin} ${report.templateId}` : 'not from the pool'}`
      );
      console.log(
        `reported ${story.reportedTurnOrder === null ? 'the story as a whole' : `beat ${story.reportedTurnOrder}`}\n`
      );
      for (const beat of story.beats) {
        console.log(`${beat.reported ? '▶' : ' '} ${beat.turnOrder}. ${beat.headline ?? ''}`);
        console.log(`    ${beat.narrative}\n`);
      }
      break;
    }
    case 'keep':
      if (!id) return usage();
      await keepReportedStory(id);
      console.log(`Closed ${id}; the story stays.`);
      break;
    case 'pull': {
      if (!id) return usage();
      const closed = await pullReportedStory(id);
      console.log(`Pulled the story from the pool and closed ${closed} report(s).`);
      break;
    }
    case 'restore':
      if (!id) return usage();
      await restorePulledTemplate(id);
      console.log(`Template ${id} is back in the pool.`);
      break;
    default:
      return usage();
  }
  process.exit(0);
}

function usage() {
  console.error(USAGE);
  process.exit(2);
}

main().catch((error) => {
  console.error('review-reports failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});

import { storyTemplateSchema, type StoryTemplate } from '../template';
import closeFriends from './close-friends.json';
import decisionDay from './decision-day.json';
import groupProject from './group-project.json';
import locationShared from './location-shared.json';
import newRoommate from './new-roommate.json';
import softLaunch from './soft-launch.json';
import summerShift from './summer-shift.json';
import theAccount from './the-account.json';
import theLeak from './the-leak.json';
import twoTickets from './two-tickets.json';

/**
 * The stories your team writes, so the pool is never empty.
 *
 * One file per story, named by its slug. The seed script upserts them by slug on
 * every deploy, so editing a file changes the story for players who have not
 * started it yet (a copy already started is theirs). Removing a file does not
 * remove its story: set it aside in the database instead.
 */
export const SEED_STORIES: Record<string, StoryTemplate> = Object.fromEntries(
  Object.entries({
    'close-friends': closeFriends,
    'decision-day': decisionDay,
    'group-project': groupProject,
    'location-shared': locationShared,
    'new-roommate': newRoommate,
    'soft-launch': softLaunch,
    'summer-shift': summerShift,
    'the-account': theAccount,
    'the-leak': theLeak,
    'two-tickets': twoTickets,
  }).map(([slug, story]) => [slug, storyTemplateSchema.parse(story)])
);

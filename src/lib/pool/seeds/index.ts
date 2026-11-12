import { storyTemplateSchema, type StoryTemplate } from '../template';
import lastShift from './last-shift.json';
import nightBus from './night-bus.json';
import theGroupChat from './the-group-chat.json';
import theInheritance from './the-inheritance.json';
import theLighthouse from './the-lighthouse.json';
import theReunion from './the-reunion.json';
import theSpareKey from './the-spare-key.json';
import theUnderstudy from './the-understudy.json';
import theWrongTable from './the-wrong-table.json';
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
    'last-shift': lastShift,
    'night-bus': nightBus,
    'the-group-chat': theGroupChat,
    'the-inheritance': theInheritance,
    'the-lighthouse': theLighthouse,
    'the-reunion': theReunion,
    'the-spare-key': theSpareKey,
    'the-understudy': theUnderstudy,
    'the-wrong-table': theWrongTable,
    'two-tickets': twoTickets,
  }).map(([slug, story]) => [slug, storyTemplateSchema.parse(story)])
);

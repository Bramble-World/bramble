import { duetPremiseSchema, type DuetPremise } from '../premise';
import springBreak from './spring-break.json';
import theScreenshot from './the-screenshot.json';
import theSurprise from './the-surprise.json';

/**
 * The duet premises, by slug. Hand-written for now; PR 2 generates more. Read
 * at startup and parsed, so a broken seed fails the build, not an accept.
 */
export const DUET_PREMISES: Record<string, DuetPremise> = Object.fromEntries(
  Object.entries({
    'spring-break': springBreak,
    'the-screenshot': theScreenshot,
    'the-surprise': theSurprise,
  }).map(([slug, premise]) => [slug, duetPremiseSchema.parse(premise)])
);

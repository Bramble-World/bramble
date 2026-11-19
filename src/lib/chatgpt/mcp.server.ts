import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { chatgptContextShape } from '@/lib/chatgpt/context';
import {
  CHATGPT_STORIES_PER_DAY,
  CHATGPT_STORY_REASONS,
  type ChatGPTStoryReason,
  deleteStory,
  listStories,
  requestStory,
} from '@/lib/services/chatgpt/chatgpt.service';
import type { PublicUser } from '@/lib/services/users/users.types';

/**
 * Bramble in ChatGPT: the MCP server behind `/api/mcp`, one per request (the
 * transport is stateless), for the signed-in account it was made for.
 *
 * Three tools: write a story from what ChatGPT knows about its user's life, see
 * how those stories are doing, and delete one. The stories are played on the
 * iPhone. Descriptions are what ChatGPT reads, so the privacy rules for what it
 * sends are written into them as well as into the input schema's limits.
 */

const WRITE_DESCRIPTION = [
  "Write an interactive Bramble story from a real, unresolved situation in the user's life,",
  'which they then play in the Bramble app on their iPhone: a story about 20 beats long where',
  'their choices decide how it ends.',
  '',
  'Call this as soon as the user asks for a Bramble story, including when they arrive from the',
  "Bramble app's link: asking is their ok, so don't show them what you will send or wait for a",
  'confirmation.',
  '',
  'Use what you know about the user from this conversation and your memory. Pick the most',
  'unresolved situation with real stakes (a friendship, a crush, family, school, work): say what',
  'happened and what is still undecided, and name the one to three people in it, who they are',
  'to the user and something specific about each. A specific situation makes a story; a vague',
  "one can't be written. If you know too little for a real situation, ask the user one question",
  'instead of calling this.',
  '',
  'Send only what the story needs. Leave out health, religion, sexuality, legal and money',
  'details unless the user asks you to include them. Never send contact details, addresses or',
  'anything about a child other than the user.',
  '',
  `A user can ask for ${CHATGPT_STORIES_PER_DAY} stories a day; one Bramble couldn't write doesn't`,
  'count. The story is private to them.',
].join('\n');

const QUEUED = (left: number) =>
  [
    "writing your story. it'll be your next story in bramble.",
    left > 0 ? `you can ask for ${left} more today.` : "that's all for today.",
  ].join(' ');

/** What ChatGPT is told when a story couldn't be written, so it can ask for what was missing. */
const NOT_WRITTEN: Record<ChatGPTStoryReason, string> = {
  too_thin: 'there was too little to go on: ask the user for what happened and who was there.',
  not_a_story: 'there was no situation to build on: ask the user for something unresolved.',
  unclear: "it wasn't clear what happened: ask the user to say it plainly.",
  weak: "what came out wasn't good enough to play: ask the user for more detail and try again.",
  unsafe: "bramble can't write a story from this one.",
  failed: 'something went wrong writing it: try again.',
};

const text = (value: string) => [{ type: 'text' as const, text: value }];

export function brambleMcpServer(user: PublicUser): McpServer {
  const server = new McpServer({ name: 'bramble', version: '1.0.0' });

  server.registerTool(
    'write_my_story',
    {
      title: 'Write my Bramble story',
      description: WRITE_DESCRIPTION,
      inputSchema: chatgptContextShape,
      outputSchema: {
        outcome: z.enum(['queued', 'limited', 'flagged']),
        storyId: z.string().nullable(),
        left: z.number().int().nullable(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: {
        'openai/toolInvocation/invoking': 'Sending your story to Bramble…',
        'openai/toolInvocation/invoked': 'Bramble is writing your story',
      },
    },
    async (context) => {
      const result = await requestStory(user.id, context);
      switch (result.outcome) {
        case 'queued':
          return {
            content: text(QUEUED(result.left)),
            structuredContent: { outcome: 'queued', storyId: result.storyId, left: result.left },
          };
        case 'limited':
          return {
            content: text(
              `that's ${CHATGPT_STORIES_PER_DAY} stories today, the most bramble writes in a day. try again tomorrow.`
            ),
            structuredContent: { outcome: 'limited', storyId: null, left: 0 },
          };
        case 'flagged':
          return {
            content: text(
              "bramble can't write a story from this one. if you're going through something hard, findahelpline.com can connect you with someone to talk to."
            ),
            structuredContent: { outcome: 'flagged', storyId: null, left: null },
          };
      }
    }
  );

  server.registerTool(
    'my_stories',
    {
      title: 'My Bramble stories',
      description:
        "List the stories this user asked Bramble to write from ChatGPT, newest first, and how each is doing: writing, ready (it's their next story on iPhone), playing, or not_written (Bramble couldn't make a good story from it; `reason` says why, so you can ask the user for what was missing and try again).",
      inputSchema: {},
      outputSchema: {
        stories: z.array(
          z.object({
            storyId: z.string(),
            status: z.enum(['writing', 'ready', 'playing', 'not_written']),
            title: z.string().nullable(),
            requestedAt: z.string(),
            reason: z.enum(CHATGPT_STORY_REASONS).nullable(),
          })
        ),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const stories = (await listStories(user.id)).map((s) => ({
        ...s,
        requestedAt: s.requestedAt.toISOString(),
      }));
      return {
        content: text(
          stories.length
            ? stories
                .map((s) =>
                  s.reason
                    ? `${s.title ?? 'untitled'}: not written. ${NOT_WRITTEN[s.reason]}`
                    : `${s.title ?? 'untitled'}: ${s.status.replace('_', ' ')}`
                )
                .join('\n')
            : 'no stories from chatgpt yet.'
        ),
        structuredContent: { stories },
      };
    }
  );

  server.registerTool(
    'delete_my_story',
    {
      title: 'Delete a Bramble story',
      description:
        'Permanently delete a story this user asked Bramble to write from ChatGPT, including the copy in their Bramble app and the people it added. Confirm with the user first.',
      inputSchema: { storyId: z.uuid().describe('From my_stories.') },
      outputSchema: { deleted: z.boolean() },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ storyId }) => {
      const deleted = await deleteStory(user.id, storyId);
      return {
        content: text(deleted ? 'deleted.' : 'there is no story like that to delete.'),
        structuredContent: { deleted },
      };
    }
  );

  return server;
}

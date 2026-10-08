import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { InternalServerError } from '@/lib/utils/errors';
import { createFakeGenerator, FakeGenerator } from './generator.fake';
import { PromptSpec } from './prompt';

type Vars = { title: string; beats: number };
type Out = { narrative: string; choices: string[] };

const spec: PromptSpec<Vars, Out> = {
  name: 'test.turn',
  stage: 'turn',
  schema: z.object({
    narrative: z.string().min(1),
    choices: z.array(z.string()).min(2).max(4),
  }),
  render: (vars) => ({
    system: 'You are narrating a story.',
    prompt: `Story: ${vars.title}. Beats so far: ${vars.beats}.`,
  }),
};

let fake: FakeGenerator;
beforeEach(() => {
  fake = createFakeGenerator();
});

describe('the fake generator', () => {
  it('returns the registered fixture', async () => {
    fake.register(spec, () => ({ narrative: 'She waited.', choices: ['Call', 'Wait'] }));

    const result = await fake.run(spec, { title: 'Unsent', beats: 3 });

    expect(result.value.narrative).toBe('She waited.');
    expect(result.meta.promptName).toBe('test.turn');
  });

  // The load-bearing property. Production parses model output through this same
  // schema, so a fixture that would not survive it is not a stand-in for
  // anything — and the failure would otherwise be invisible until a live call.
  it('rejects a fixture that does not satisfy its own schema', async () => {
    // Only one choice, where the schema demands at least two.
    fake.register(spec, () => ({ narrative: 'She waited.', choices: ['Call'] }) as Out);

    await expect(fake.run(spec, { title: 'Unsent', beats: 3 })).rejects.toBeInstanceOf(
      InternalServerError
    );
    await expect(fake.run(spec, { title: 'Unsent', beats: 3 })).rejects.toThrow(
      /does not satisfy its own schema/
    );
  });

  it('names the offending field, so a schema change says what broke', async () => {
    fake.register(spec, () => ({ narrative: '', choices: ['A', 'B'] }));

    await expect(fake.run(spec, { title: 'x', beats: 1 })).rejects.toThrow(/narrative/);
  });

  it('fails loudly when no fixture is registered', async () => {
    await expect(fake.run(spec, { title: 'x', beats: 1 })).rejects.toThrow(
      /No fake fixture registered/
    );
  });

  // Renders even though nothing reads the text: a prompt that throws while
  // building its string is a real bug the fake would otherwise hide until the
  // first live call.
  it('renders the prompt and records what it was called with', async () => {
    fake.register(spec, () => ({ narrative: 'x', choices: ['A', 'B'] }));

    await fake.run(spec, { title: 'Unsent', beats: 3 });

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].vars).toStrictEqual({ title: 'Unsent', beats: 3 });
    expect(fake.calls[0].prompt).toContain('Unsent');
    expect(fake.calls[0].system).toContain('narrating');
  });

  it('surfaces a throwing renderer instead of swallowing it', async () => {
    const broken: PromptSpec<Vars, Out> = {
      ...spec,
      name: 'test.broken',
      render: () => {
        throw new Error('renderer blew up');
      },
    };
    fake.register(broken, () => ({ narrative: 'x', choices: ['A', 'B'] }));

    await expect(fake.run(broken, { title: 'x', beats: 1 })).rejects.toThrow('renderer blew up');
  });

  describe('the seed', () => {
    const seedOf = async (vars: Vars): Promise<number> => {
      let captured = 0;
      fake.register(spec, ({ seed }) => {
        captured = seed;
        return { narrative: 'x', choices: ['A', 'B'] };
      });
      await fake.run(spec, vars);
      return captured;
    };

    it('is stable for the same input', async () => {
      expect(await seedOf({ title: 'Unsent', beats: 3 })).toBe(
        await seedOf({ title: 'Unsent', beats: 3 })
      );
    });

    it('differs for different input, so fixtures can vary by vars', async () => {
      expect(await seedOf({ title: 'Unsent', beats: 3 })).not.toBe(
        await seedOf({ title: 'Unsent', beats: 4 })
      );
    });

    // Object key order is not part of the input's meaning, and depending on it
    // would make a fixture's output differ between callers that built the same
    // vars in a different order.
    it('ignores key order', async () => {
      const a = await seedOf({ title: 'Unsent', beats: 3 });
      const b = await seedOf({ beats: 3, title: 'Unsent' } as Vars);
      expect(a).toBe(b);
    });
  });
});

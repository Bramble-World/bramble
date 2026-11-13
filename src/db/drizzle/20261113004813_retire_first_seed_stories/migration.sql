-- The first ten seed stories were written for a general adult audience; the
-- pool's seeds are now written for Bramble's players, Gen Z young women aged
-- 13-24 (src/lib/pool/seeds). Removing a seed file doesn't remove its story,
-- so the retired ones are deleted here. `two-tickets` keeps its slug and is
-- rewritten in place by the seed upsert after the migrations.
--
-- Players already playing one keep their copy: storylines.template_id and the
-- sessions' next_template_id are `on delete set null`, and a next story that
-- pointed at one of these is simply chosen again.
DELETE FROM "story_templates"
WHERE "origin" = 'seed'
  AND "slug" IN (
    'last-shift',
    'night-bus',
    'the-group-chat',
    'the-inheritance',
    'the-lighthouse',
    'the-reunion',
    'the-spare-key',
    'the-understudy',
    'the-wrong-table'
  );

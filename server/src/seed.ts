import { eq } from 'drizzle-orm';

import { db } from './db/client.ts';
import {
  conversations,
  entitlements,
  memories,
  messages,
  records,
  tasks,
  goalEntries,
  goals,
  users,
} from './db/schema.ts';
import { logger } from './logger.ts';
import { buildTemplateDefinition } from './lib/goals/templates.ts';
import type { GoalField } from './lib/goals/schema.ts';

// Same demo number as DEMO_PHONE_E164 in lib/constants.ts — kept as a literal
// here so the seed script has no dependency on the OTP flow's internals.
const DEMO_PHONE = '+15555550100';

async function main() {
  const [existing] = await db.select().from(users).where(eq(users.phoneE164, DEMO_PHONE)).limit(1);
  if (existing) {
    logger.info('Removing existing demo user before reseeding...');
    await db.delete(users).where(eq(users.id, existing.id));
  }

  const [user] = await db
    .insert(users)
    .values({
      phoneE164: DEMO_PHONE,
      displayName: 'Alex',
      timezone: 'America/Chicago',
      prefs: { communicationStyle: 'casual' },
    })
    .returning();
  if (!user) throw new Error('seed_user_insert_failed');

  await db.insert(entitlements).values({ userId: user.id, plan: 'free' });

  // --- the pre-install SMS-side relationship (the continuity story) ---
  const [smsConversation] = await db
    .insert(conversations)
    .values({ userId: user.id, channel: 'sms' })
    .returning();
  if (!smsConversation) throw new Error('seed_conversation_insert_failed');

  const dayMs = 24 * 60 * 60 * 1000;
  const base = Date.now() - dayMs - 6 * 60 * 60 * 1000; // ~yesterday evening

  const seedMessages: Array<{ role: 'assistant' | 'user'; content: string }> = [
    { role: 'assistant', content: "Hey — how's the day going?" },
    { role: 'user', content: 'honestly kinda tired. i really need to work out though 😮‍💨' },
    {
      role: 'assistant',
      content: 'Totally hear you. Want to commit to it today — even a short one? I can lock it in.',
    },
    { role: 'user', content: "yeah let's do chest today" },
    { role: 'assistant', content: 'Done. Added it to today.' },
  ];

  let lastMessageId: string | null = null;
  let offset = 0;
  for (const m of seedMessages) {
    const [inserted] = await db
      .insert(messages)
      .values({
        conversationId: smsConversation.id,
        role: m.role,
        content: m.content,
        createdAt: new Date(base + offset),
      })
      .returning();
    if (!inserted) throw new Error('seed_message_insert_failed');
    lastMessageId = inserted.id;
    offset += 60_000;
  }

  // --- memories learned from that relationship ---
  await db.insert(memories).values([
    {
      userId: user.id,
      kind: 'preference',
      content: 'Prefers casual, low-key check-ins over formal reminders.',
    },
    {
      userId: user.id,
      kind: 'goal',
      content: 'Trying to work out consistently — chest day is a recurring focus.',
    },
    {
      userId: user.id,
      kind: 'pattern',
      content: 'Tends to be most responsive to check-ins in the evening.',
    },
  ]);

  // --- open tasks; one of each type so the simulator shows the full spread ---
  // (one traceable straight back to that chat moment)
  await db.insert(tasks).values([
    {
      userId: user.id,
      type: 'completion',
      title: 'Chest workout (30 min)',
      icon: 'dumbbell',
      status: 'open',
      createdFromMessageId: lastMessageId,
    },
    {
      userId: user.id,
      type: 'completion',
      title: 'Drink 2L of water',
      icon: 'droplet',
      status: 'open',
    },
    {
      userId: user.id,
      type: 'checklist',
      title: 'Pack for the gym',
      icon: 'briefcase',
      status: 'open',
      config: {
        items: [
          { id: crypto.randomUUID(), text: 'Shoes', done: true },
          { id: crypto.randomUUID(), text: 'Towel', done: false },
          { id: crypto.randomUUID(), text: 'Water bottle', done: false },
        ],
      },
    },
    {
      userId: user.id,
      type: 'counter',
      title: 'Pushups',
      icon: 'flame',
      status: 'open',
      config: { count: 15, target: 50, unit: 'reps' },
    },
    {
      userId: user.id,
      type: 'duration',
      title: 'Study Spanish',
      icon: 'book',
      status: 'open',
      config: { loggedMinutes: 10, targetMinutes: 30, runningSince: null },
    },
    {
      userId: user.id,
      type: 'counter',
      title: 'Emergency fund',
      icon: 'wallet',
      status: 'open',
      config: { count: 320, target: 1000, unit: '$' },
    },
    // A recurring template — its dated instances materialize lazily on the
    // next read (GET /tasks / bootstrap), so nothing to spawn here.
    {
      userId: user.id,
      type: 'completion',
      title: 'Weekly grocery run',
      icon: 'wallet',
      status: 'open',
      recurrence: { freq: 'weekly', byWeekday: ['sa'], time: '10:00' },
    },
  ]);

  // --- a workout goal with history, so Goals isn't empty on first open ---
  // Uses the same template builder create_goal did pre-simplification
  // (lib/goals/templates.ts) so this stays schema-valid as GoalDefinition
  // evolves, instead of an ad-hoc shape drifting out of sync with it (a
  // stale ad-hoc { unit, exercises } shape here once crashed every chat
  // turn's goal-context build, since computeCardSummary assumes
  // definition.fields exists).
  const workoutDefinition = buildTemplateDefinition({
    template: 'workout',
    name: 'Strength tracker',
    unit: 'lb',
  });
  const fieldByLabel = new Map<string, GoalField>(workoutDefinition.fields.map((f) => [f.label, f]));

  const [workoutGoal] = await db
    .insert(goals)
    .values({
      userId: user.id,
      template: 'workout',
      name: 'Strength tracker',
      icon: 'dumbbell',
      definition: workoutDefinition,
    })
    .returning();
  if (!workoutGoal) throw new Error('seed_goal_insert_failed');

  const entries = [
    { daysAgo: 5, exercise: 'Bench Press', weight: 155, reps: 8 },
    { daysAgo: 2, exercise: 'Bench Press', weight: 165, reps: 8 },
  ];

  for (const entry of entries) {
    const occurredAt = new Date(Date.now() - entry.daysAgo * dayMs);
    const data = {
      [fieldByLabel.get('Exercise')!.id]: entry.exercise,
      [fieldByLabel.get('Weight')!.id]: entry.weight,
      [fieldByLabel.get('Reps')!.id]: entry.reps,
    };

    const [record] = await db
      .insert(records)
      .values({
        userId: user.id,
        kind: 'goal_entry',
        payload: { goalId: workoutGoal.id, name: workoutGoal.name, data, entryAt: occurredAt.toISOString() },
        source: 'goal_ui',
        occurredAt,
      })
      .returning();
    if (!record) throw new Error('seed_record_insert_failed');

    await db.insert(goalEntries).values({
      goalId: workoutGoal.id,
      recordId: record.id,
      data,
      entryAt: occurredAt,
    });
  }

  logger.info(`Seeded demo user ${DEMO_PHONE} (${user.id}). Verify with OTP code 000000.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error(err, 'Seed failed');
    process.exit(1);
  });

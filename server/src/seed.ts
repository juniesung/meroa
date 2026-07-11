import { eq } from 'drizzle-orm';

import { db } from './db/client.ts';
import {
  conversations,
  entitlements,
  memories,
  messages,
  records,
  tasks,
  toolEntries,
  tools,
  users,
} from './db/schema.ts';
import { logger } from './logger.ts';

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

  // --- open tasks; one traceable straight back to that chat moment ---
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
  ]);

  // --- a workout tool with history, so Tools isn't empty on first open ---
  const [workoutTool] = await db
    .insert(tools)
    .values({
      userId: user.id,
      template: 'workout',
      name: 'Strength tracker',
      icon: 'dumbbell',
      definition: { unit: 'lb', exercises: ['Bench Press', 'Squat'] },
    })
    .returning();
  if (!workoutTool) throw new Error('seed_tool_insert_failed');

  const entries = [
    { daysAgo: 5, exercise: 'Bench Press', weight: 155, reps: 8 },
    { daysAgo: 2, exercise: 'Bench Press', weight: 165, reps: 8 },
  ];

  for (const entry of entries) {
    const occurredAt = new Date(Date.now() - entry.daysAgo * dayMs);
    const payload = { exercise: entry.exercise, weight: entry.weight, reps: entry.reps };

    const [record] = await db
      .insert(records)
      .values({ userId: user.id, kind: 'tool_entry', payload, source: 'tool_ui', occurredAt })
      .returning();
    if (!record) throw new Error('seed_record_insert_failed');

    await db.insert(toolEntries).values({
      toolId: workoutTool.id,
      recordId: record.id,
      data: payload,
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

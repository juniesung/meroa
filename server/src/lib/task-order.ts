import { sql } from 'drizzle-orm';

import { tasks } from '../db/schema.ts';

// `asc(tasks.status)` sorts alphabetically ('done' < 'open'), which puts
// completed tasks above open ones — the opposite of what a task list
// should show. This orders open first, then done, then archived.
export const taskStatusOrder = sql`case ${tasks.status} when 'open' then 0 when 'done' then 1 else 2 end`;

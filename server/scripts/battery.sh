#!/usr/bin/env bash
#
# THE BATTERY — the live end-to-end pass this project actually relies on.
#
#   cd server && npm run battery            # fresh account, full run
#   cd server && npm run battery -- 42       # pin the account suffix (re-runnable)
#
# Requires the dev server up (`npm run dev`) and DATABASE_URL in server/.env.
#
# ---------------------------------------------------------------------------
# WHY THIS EXISTS
#
# `tsc` and the 153 unit tests have never once caught a real bug in this app.
# Every serious one was found here, or by a human driving the app:
#
#   · "delete all tasks" left 3 tasks on screen while chat said they were gone
#     (a cascade spared DONE instances; task-context then hid the orphans)
#   · a counter's target edit didn't cascade to today's instance (3 / 8 -> 3 / 10)
#   · milestone creation silently created nothing, 1 run in 4
#   · create_task rejected every call (a .strict() intersection bug)
#
# In every case the CODE was fine and the CONVERSATION was not. So this script
# does two things no unit test does:
#
#   1. drives the REAL server over HTTP with plain English, as the app does
#   2. asserts against POSTGRES after every step — never against what the reply
#      SAID, which has been wrong while the data was right, and right while the
#      data was wrong
#
# It also flags abnormal chat behaviour separately (prose on a turn that should
# be silent, a retraction, a tool-name leak), because that is what the user
# actually sees and the DB cannot tell you about it.
#
# ---------------------------------------------------------------------------
# LESSONS PAID FOR IN BLOOD — do not "clean these up"
#
#   · bash, not zsh. In zsh, GID is the process group id: `GID=$(...)` with a
#     UUID either throws "bad math expression" or tries to setgid.
#   · Quote every id: "$(...)". A UUID starting 0b/0x is read as a numeric
#     literal by some shells.
#   · A recurring task is TWO rows (template + today's instance). Count logical
#     tasks with `template_id is null`, or every count is off by one.
#   · Assert on what the app guarantees, not on the model's phrasing. The model
#     may write the unit as "lb" or "lbs" and both are correct.
# ---------------------------------------------------------------------------

set -uo pipefail
cd "$(dirname "$0")/.."

API="${API:-http://localhost:8787}"
# A fresh account per run by default: the suite asserts on absolute counts
# ("2 tasks exist"), so reusing one number makes every run after the first
# fail against the previous run's leftovers. Pass a 7-digit suffix explicitly
# to reattach to a specific account (e.g. to inspect state after a failure).
PHONE="+1555${1:-$(printf '%07d' $(( (RANDOM * 32768 + RANDOM) % 10000000 )))}"

if ! curl -s -o /dev/null --max-time 3 "$API/"; then
  echo "✗ no server at $API — run 'npm run dev' first" >&2
  exit 1
fi

npm run dev:token "$PHONE" 2>/dev/null | sed -n '/^{/,$p' > /tmp/battery.json
TOKEN="$(jq -r .accessToken /tmp/battery.json)"
USER_ID="$(jq -r .userId /tmp/battery.json)"
[[ "$TOKEN" == "null" || -z "$TOKEN" ]] && { echo "✗ could not mint a dev token" >&2; exit 1; }

R=$'\033[31m'; G=$'\033[32m'; Y=$'\033[33m'; C=$'\033[36m'; M=$'\033[35m'; B=$'\033[1m'; X=$'\033[0m'
PASS=0; FAIL=0; WEIRD=0
CARDS=0; KIND=""; PROSE=""

q() { npx tsx scripts/db-query.ts "$1" 2>/dev/null; }
val() { q "$1" | jq -r '.[0].v // "null"'; }

# say <message> — sends a turn, prints it, sets $CARDS/$KIND/$PROSE, flags weirdness
say() {
  local out
  out=$(curl -sN -X POST "$API/conversations/current/messages" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -d "$(jq -nc --arg t "$1" '{text:$t}')" \
    | awk '/^event: /{ev=substr($0,8);next} /^data: /{d=substr($0,7); if(ev=="segment")print "SEG\t"d; if(ev ~ /^action/)print "CARD\t"d}')

  CARDS=$(grep -c '^CARD' <<<"$out" || true)
  KIND=$(grep '^CARD' <<<"$out" | head -1 | cut -f2 | jq -r '.message.meta.kind' 2>/dev/null || echo "")
  PROSE=$(grep '^SEG' <<<"$out" | cut -f2 | jq -r '.message.content' 2>/dev/null | tr '\n' ' ')

  printf '\n  %s▶%s %s\n' "$C" "$X" "$1"
  grep '^CARD' <<<"$out" | cut -f2 | while read -r d; do
    printf '     %s[%s]%s %s\n' "$Y" "$(jq -r '.message.meta.kind' <<<"$d")" "$X" \
      "$(jq -r '.message.meta.task.title // .message.meta.goal.name // .message.meta.preview.name // ""' <<<"$d")"
  done
  [[ -n "${PROSE// }" ]] && printf '     %s💬%s %s\n' "$G" "$X" "$PROSE"

  # --- abnormal chat behaviour: what the user sees, which the DB cannot tell us
  if [[ $CARDS -gt 0 && -n "${PROSE// }" ]]; then
    printf '     %s⚠ PROSE ON AN ACTION TURN%s (the card is the confirmation — this should be silent)\n' "$R" "$X"
    WEIRD=$((WEIRD+1))
  fi
  if grep -qiE "didn't actually go through|don't think that actually went through" <<<"$PROSE"; then
    printf '     %s⚠ RETRACTION%s (a guard caught the reply contradicting server state)\n' "$R" "$X"
    WEIRD=$((WEIRD+1))
  fi
  if grep -qiE "create_task|create_goal|complete_task|calling create|\[showed|\[showing" <<<"$PROSE"; then
    printf '     %s⚠ TOOL/INTERNAL LEAK%s\n' "$R" "$X"
    WEIRD=$((WEIRD+1))
  fi
}

ck() {
  if [[ "$2" == "$3" ]]; then printf '     %s✓%s %s\n' "$G" "$X" "$1"; PASS=$((PASS+1))
  else printf '     %s✗ %s — got '"'"'%s'"'"', want '"'"'%s'"'"'%s\n' "$R" "$1" "$2" "$3" "$X"; FAIL=$((FAIL+1)); fi
}
# asked-a-question: no card, but words. The reply IS the product on these turns.
ck_asked() {
  if [[ $CARDS -eq 0 && -n "${PROSE// }" ]]; then printf '     %s✓%s %s\n' "$G" "$X" "$1"; PASS=$((PASS+1))
  else printf '     %s✗ %s — cards=%s (should have ASKED, not acted)%s\n' "$R" "$1" "$CARDS" "$X"; FAIL=$((FAIL+1)); fi
}

# logical task (template or one-off) — never a materialized instance
task() { val "select $2 as v from tasks where user_id='$USER_ID' and title ilike '%$1%' and deleted_at is null and template_id is null limit 1"; }
# today's instance of a recurring series
inst() { val "select $2 as v from tasks where user_id='$USER_ID' and title ilike '%$1%' and deleted_at is null and template_id is not null limit 1"; }
# the NEWEST non-archived goal of a template — sections E/G create more than
# one goal of the same template (a "run" and a "land an internship"
# milestone, a manual savings goal alongside the chat-created one), so this
# is deterministic only as "most recent"; a step that needs an OLDER one of
# the same type must capture its id right after creating it instead (see
# MILESTONE_ID below).
goal() { val "select $2 as v from goals where user_id='$USER_ID' and template='$1' and archived_at is null order by created_at desc limit 1"; }
goal_id() { val "select id as v from goals where user_id='$USER_ID' and template='$1' and name ilike '%$2%' and archived_at is null order by created_at desc limit 1"; }
goalcol() { val "select $2 as v from goals where id='$1'"; }
tap()  { curl -s -X POST "$API$1" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d "$2" > /dev/null; printf '     %s👆 tapped%s\n' "$M" "$X"; }
patch() { curl -s -X PATCH "$API$1" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d "$2" > /dev/null; printf '     %s👆 PATCHed%s\n' "$M" "$X"; }
post()  { curl -s -X POST "$API$1" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d "$2" > /dev/null; printf '     %s👆 POSTed%s\n' "$M" "$X"; }

# create_task via chat is ALWAYS a preview now, never an immediate save
# (lib/ai/actions.ts's create_task case — matches remove_task's own
# always-confirm pattern; a model apology in prose doesn't persist to the
# next turn, only a guarantee does). say <prompt>, then confirm_task taps
# Create on the newest un-consumed task_creation_pending card, mirroring
# the goal-preview tap pattern already used throughout this script.
confirm_task() {
  local msg
  msg="$(val "select m.id as v from messages m join conversations c on c.id=m.conversation_id where c.user_id='$USER_ID' and m.meta->>'kind'='task_creation_pending' and (m.meta->>'createdTaskId') is null order by m.created_at desc limit 1")"
  curl -s -X POST "$API/tasks" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d "{\"previewMessageId\":\"$msg\"}" > /dev/null
  printf '     %s👆 tapped Create%s\n' "$M" "$X"
}

printf '%s═══ A. TASK TYPES ═══%s\n' "$B" "$X"
say "add a task to call the dentist tomorrow at 3pm"
ck "preview card, nothing saved yet" "$KIND" "task_creation_pending"
confirm_task
ck "completion task" "$(task dentist type)" "completion"

say "add a daily task to drink 8 glasses of water"
confirm_task
ck "counter, target 8" "$(task water "config->>'target'")" "8"

say "drank 3"
ck "today's count = 3" "$(inst water "config->>'count'")" "3"

say "make it 10 instead"
ck "target cascades to today's instance" "$(inst water "config->>'target'")" "10"
ck "progress survives the edit" "$(inst water "config->>'count'")" "3"

say "add a 30 min reading task every day"
confirm_task
ck "duration, 30 min" "$(task read "config->>'targetMinutes'")" "30"

say "packing list: passport, charger, socks"
confirm_task
ck "checklist, 3 items" "$(val "select jsonb_array_length(config->'items') as v from tasks where user_id='$USER_ID' and type='checklist' and deleted_at is null limit 1")" "3"

say "check off the passport"
ck "item toggled" "$(val "select (config->'items'->0->>'done') as v from tasks where user_id='$USER_ID' and type='checklist' and deleted_at is null limit 1")" "true"

printf '\n%s═══ B. LIFECYCLE ═══%s\n' "$B" "$X"
say "rename the dentist task to call the dentist about the crown"
ck "title edited" "$(task crown title)" "Call the dentist about the crown"

say "delete the reading task"
ck "removal is a CARD — nothing deleted yet" "$(val "select count(*) as v from tasks where user_id='$USER_ID' and title ilike '%read%' and deleted_at is null")" "2"
TID="$(val "select m.meta->>'taskId' as v from messages m join conversations c on c.id=m.conversation_id where c.user_id='$USER_ID' and m.meta->>'kind'='task_removal_pending' order by m.created_at desc limit 1")"
curl -s -X DELETE "$API/tasks/$TID" -H "Authorization: Bearer $TOKEN" > /dev/null
printf '     %s👆 tapped Delete%s\n' "$M" "$X"
ck "now removed (series, so both rows)" "$(val "select count(*) as v from tasks where user_id='$USER_ID' and title ilike '%read%' and deleted_at is null")" "0"

say "undo that"
ck "undo restores the whole series" "$(val "select count(*) as v from tasks where user_id='$USER_ID' and title ilike '%read%' and deleted_at is null")" "2"

printf '\n%s═══ C. RECURRING ═══%s\n' "$B" "$X"
say "did my water for today"
ck "today's occurrence done" "$(inst water status)" "done"
ck "the template is untouched" "$(task water status)" "open"

printf '\n%s═══ D. GOALS — savings, habit, indirect ═══%s\n' "$B" "$X"
say "i want to save 500 for a monitor, 10 a day"
MSG="$(val "select m.id as v from messages m join conversations c on c.id=m.conversation_id where c.user_id='$USER_ID' and m.meta->>'kind'='goal_preview' and m.meta->>'createdGoalId' is null order by m.created_at desc limit 1")"
tap "/goals" "{\"previewMessageId\":\"$MSG\"}"
ck "savings goal, target 500" "$(goal savings "definition->>'targetValue'")" "500"

say "saved my 10 today"
ck "completing the linked task auto-logged 10" "$(val "select (data->>'amount') as v from goal_entries ge join goals g on g.id=ge.goal_id join records r on r.id=ge.record_id where g.user_id='$USER_ID' and g.template='savings' and r.reverted_at is null limit 1")" "10"
ck "ONE record — the entry points at the task completion" "$(val "select count(*) as v from goal_entries ge join records r on r.id=ge.record_id join goals g on g.id=ge.goal_id where g.user_id='$USER_ID' and r.kind='task_completion' and r.reverted_at is null")" "1"

say "also put in 40 birthday money"
ck "manual entry logged" "$(val "select count(*) as v from goal_entries ge join goals g on g.id=ge.goal_id join records r on r.id=ge.record_id where g.user_id='$USER_ID' and g.template='savings' and r.reverted_at is null")" "2"
say "undo that"
ck "undo reverts just that entry" "$(val "select count(*) as v from goal_entries ge join goals g on g.id=ge.goal_id join records r on r.id=ge.record_id where g.user_id='$USER_ID' and g.template='savings' and r.reverted_at is null")" "1"

say "i want to meditate every day"
MSG="$(val "select m.id as v from messages m join conversations c on c.id=m.conversation_id where c.user_id='$USER_ID' and m.meta->>'kind'='goal_preview' and m.meta->>'createdGoalId' is null order by m.created_at desc limit 1")"
tap "/goals" "{\"previewMessageId\":\"$MSG\"}"
ck "habit goal" "$(goal habit "definition->>'type'")" "habit"
say "meditated today"
ck "check-in recorded (the task IS the check-in)" "$(val "select count(*) as v from tasks t join goals g on g.id=t.goal_id where t.user_id='$USER_ID' and g.template='habit' and t.status='done'")" "1"

say "track my weight in lbs, want to hit 175"
MSG="$(val "select m.id as v from messages m join conversations c on c.id=m.conversation_id where c.user_id='$USER_ID' and m.meta->>'kind'='goal_preview' and m.meta->>'createdGoalId' is null order by m.created_at desc limit 1")"
tap "/goals" "{\"previewMessageId\":\"$MSG\"}"
# "lb" and "lbs" are both correct — assert the app's guarantee, not the model's wording
ck "indirect goal, unit is pounds" "$(goal indirect "definition->>'unit'" | grep -qi '^lb' && echo ok || echo no)" "ok"
say "weighed 183 this morning"
ck "measurement logged (the value, not a delta)" "$(val "select (data->>'amount') as v from goal_entries ge join goals g on g.id=ge.goal_id join records r on r.id=ge.record_id where g.user_id='$USER_ID' and g.template='indirect' and r.reverted_at is null limit 1")" "183"

printf '\n%s═══ E. MILESTONE — one message, no interrogation, plans live in Goals ═══%s\n' "$B" "$X"
# docs/goal-manual-editing-plan.md replaced the two-question chat build
# (commit 541054f): chat takes stages AND first-stage tasks from ONE
# message if given, otherwise makes a bare template — never a follow-up
# question either way. Planning tasks for a NOT-YET-active stage
# (stagePlans) is a Goals-tab-only concept the model never sees; advancing
# materializes whatever was planned automatically.

say "goal to land a summer internship: applying, interviewing, negotiating — for applying I'll update my resume and apply to 5 jobs a day"
ck "preview card on the FIRST message — no second question" "$KIND" "goal_preview"
MSG="$(val "select m.id as v from messages m join conversations c on c.id=m.conversation_id where c.user_id='$USER_ID' and m.meta->>'kind'='goal_preview' and m.meta->>'createdGoalId' is null order by m.created_at desc limit 1")"
ck "3 stages proposed, stated verbatim" "$(val "select jsonb_array_length(m.meta->'preview'->'definition'->'stages') as v from messages m where m.id='$MSG'")" "3"
tap "/goals" "{\"previewMessageId\":\"$MSG\"}"
MILESTONE_ID="$(goal_id milestone internship)"
ck "milestone goal, 3 stages, on stage 0" "$(goalcol "$MILESTONE_ID" "jsonb_array_length(definition->'stages')")" "3"
ck "on stage 0 (Applying)" "$(goalcol "$MILESTONE_ID" "definition->>'activeStageIndex'")" "0"
ck "stage-0 starter task created as a real task" "$(val "select count(*) as v from tasks where user_id='$USER_ID' and goal_id='$MILESTONE_ID' and title ilike '%resume%' and deleted_at is null")" "1"

say "goal to run a marathon"
ck "bare template — no stages invented, still one card" "$KIND" "goal_preview"
MSG="$(val "select m.id as v from messages m join conversations c on c.id=m.conversation_id where c.user_id='$USER_ID' and m.meta->>'kind'='goal_preview' and m.meta->>'createdGoalId' is null order by m.created_at desc limit 1")"
ck "0 stages in the preview" "$(val "select jsonb_array_length(m.meta->'preview'->'definition'->'stages') as v from messages m where m.id='$MSG'")" "0"
ck "handoff caption tells them where to add stages" "$(val "select (m.meta->>'detail') as v from messages m where m.id='$MSG'")" "Open in Goals to add your stages"
tap "/goals" "{\"previewMessageId\":\"$MSG\"}"
ck "bare milestone goal saved with 0 stages" "$(goal milestone "jsonb_array_length(definition->'stages')")" "0"

printf '  %s— stage editing over REST (Goals tab) —%s\n' "$C" "$X"
patch "/goals/$MILESTONE_ID" '{"stagePlans":[[],[{"title":"Mock interviews"}],[{"title":"Negotiate a higher salary"}]]}'
ck "stage 2 (Interviewing) plan saved" "$(goalcol "$MILESTONE_ID" "definition->'stagePlans'->1->0->>'title'")" "Mock interviews"
ck "stage 3 (Negotiation) plan saved" "$(goalcol "$MILESTONE_ID" "definition->'stagePlans'->2->0->>'title'")" "Negotiate a higher salary"

say "finished applying for the internship — I've got interviews lined up"
ck "advance card, materialized plan already attached" "$KIND" "goal_advance_pending"
ADV_MSG="$(val "select m.id as v from messages m join conversations c on c.id=m.conversation_id where c.user_id='$USER_ID' and m.meta->>'kind'='goal_advance_pending' and (m.meta->>'advancedRecordId') is null order by m.created_at desc limit 1")"
tap "/goals/$MILESTONE_ID/advance" "{\"proposalMessageId\":\"$ADV_MSG\"}"
ck "now on stage 1 (Interviewing)" "$(goalcol "$MILESTONE_ID" "definition->>'activeStageIndex'")" "1"
ck "stage-2's PLANNED task became a REAL task" "$(val "select count(*) as v from tasks where user_id='$USER_ID' and goal_id='$MILESTONE_ID' and title ilike '%mock interview%' and deleted_at is null")" "1"
ck "stage-1's tasks were retired" "$(val "select count(*) as v from tasks where user_id='$USER_ID' and goal_id='$MILESTONE_ID' and title ilike '%resume%' and deleted_at is null")" "0"
ck "consumed stagePlans entry cleared" "$(goalcol "$MILESTONE_ID" "jsonb_array_length(definition->'stagePlans'->1)")" "0"
ck "not-yet-consumed stagePlans entry survives the advance" "$(goalcol "$MILESTONE_ID" "definition->'stagePlans'->2->0->>'title'")" "Negotiate a higher salary"

printf '\n%s═══ F. SAFETY — the model must NOT act ═══%s\n' "$B" "$X"
say "i want to save for a laptop"
ck "no target stated -> no goal invented" "$(val "select count(*) as v from goals where user_id='$USER_ID' and name ilike '%laptop%' and archived_at is null")" "0"

say "add a task to water the plants"
confirm_task
# A SECOND genuinely open "water" task, made fresh right here — Section C's
# "did my water for today" already completed the daily water-counter's
# today's instance, so relying on it for ambiguity would be luck-of-timing,
# not a real test: an already-done task isn't a completable candidate
# (lib/tasks/executor.ts's listOpenTaskTitles is deliberately status='open'
# only), so the setup needs two OPEN water-titled tasks of its own.
say "add a task to check the water filter"
confirm_task
DONE_BEFORE="$(val "select count(*) as v from tasks where user_id='$USER_ID' and status='done' and deleted_at is null")"
say "mark water done"
ck "ambiguous ref -> nothing written" "$(val "select count(*) as v from tasks where user_id='$USER_ID' and status='done' and deleted_at is null")" "$DONE_BEFORE"
ck_asked "ambiguous ref -> asks which one"

say "hey what's up"
ck "plain conversation -> no cards" "$CARDS" "0"

printf '\n%s═══ G. MANUAL CREATE — REST, no chat preview ═══%s\n' "$B" "$X"
# docs/goal-manual-editing-plan.md §1: POST /goals also accepts a full
# definition directly (the Goals-tab "+" sheet), not just {previewMessageId}.
# It must route through the SAME executor as the chat path — same
# goal_created record shape, same undo, same recent-changes visibility — so
# a manually-created goal is indistinguishable downstream from a chat-made one.

post "/goals" '{"type":"savings","name":"Manual savings goal","currency":"$","targetValue":250}'
ck "manual savings goal row created" "$(val "select count(*) as v from goals where user_id='$USER_ID' and name='Manual savings goal' and archived_at is null")" "1"
ck "wrote a goal_created record (source goal_ui)" "$(val "select count(*) as v from records where user_id='$USER_ID' and kind='goal_created' and source='goal_ui' and payload->>'name'='Manual savings goal' and reverted_at is null")" "1"

post "/goals" '{"type":"habit","name":"Manual habit goal","starterTasks":[{"title":"Manual check-in","recurrence":{"freq":"daily"}}]}'
ck "manual habit goal row created" "$(val "select count(*) as v from goals where user_id='$USER_ID' and name='Manual habit goal' and archived_at is null")" "1"
ck "its check-in task was created too" "$(task "Manual check-in" "count(*)")" "1"

post "/goals" '{"type":"indirect","name":"Manual indirect goal","unit":"reps"}'
ck "manual indirect goal row created" "$(val "select count(*) as v from goals where user_id='$USER_ID' and name='Manual indirect goal' and archived_at is null")" "1"

post "/goals" '{"type":"milestone","name":"Manual milestone goal","stages":["Plan","Build","Ship"],"starterTasks":[{"title":"Write the manual plan"}],"stagePlans":[[],[{"title":"Build it manually"}],[]]}'
ck "manual milestone goal row created, 3 stages" "$(val "select count(*) as v from goals where user_id='$USER_ID' and name='Manual milestone goal' and archived_at is null and jsonb_array_length(definition->'stages')=3")" "1"
ck "its stage-0 starter task was created too" "$(val "select count(*) as v from tasks where user_id='$USER_ID' and title ilike '%write the manual plan%' and deleted_at is null")" "1"
ck "its stage-1 plan was saved (never a real task yet)" "$(val "select (g.definition->'stagePlans'->1->0->>'title') as v from goals g where g.user_id='$USER_ID' and g.name='Manual milestone goal'")" "Build it manually"
ck "the planned task is NOT a real task" "$(val "select count(*) as v from tasks where user_id='$USER_ID' and title ilike '%build it manually%' and deleted_at is null")" "0"

say "undo that"
ck "chat undo reverts a manually-created goal (the most recent one)" "$(val "select count(*) as v from goals where user_id='$USER_ID' and name='Manual milestone goal' and archived_at is null")" "0"
ck "and retracts its starter task cascade too (undo of a create soft-deletes what it made)" "$(val "select count(*) as v from tasks where user_id='$USER_ID' and title ilike '%write the manual plan%' and deleted_at is not null")" "1"

printf '\n%s══════════════════════════════════════%s\n' "$B" "$X"
printf '%s  DB assertions:  %s%s passed%s   %s%s failed%s\n' "$B" "$G" "$PASS" "$X" "$R" "$FAIL" "$X"
printf '%s  Abnormal chat:  %s flagged%s\n' "$B" "$WEIRD" "$X"
printf '%s══════════════════════════════════════%s\n' "$B" "$X"
printf '  account: %s\n' "$PHONE"
[[ $FAIL -eq 0 && $WEIRD -eq 0 ]] && exit 0 || exit 1

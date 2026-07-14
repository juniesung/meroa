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
PHONE="+1555${1:-9000001}"

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
goal() { val "select $2 as v from goals where user_id='$USER_ID' and template='$1' and archived_at is null limit 1"; }
tap()  { curl -s -X POST "$API$1" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d "$2" > /dev/null; printf '     %s👆 tapped%s\n' "$M" "$X"; }

printf '%s═══ A. TASK TYPES ═══%s\n' "$B" "$X"
say "add a task to call the dentist tomorrow at 3pm"
ck "completion task" "$(task dentist type)" "completion"

say "add a daily task to drink 8 glasses of water"
ck "counter, target 8" "$(task water "config->>'target'")" "8"

say "drank 3"
ck "today's count = 3" "$(inst water "config->>'count'")" "3"

say "make it 10 instead"
ck "target cascades to today's instance" "$(inst water "config->>'target'")" "10"
ck "progress survives the edit" "$(inst water "config->>'count'")" "3"

say "add a 30 min reading task every day"
ck "duration, 30 min" "$(task read "config->>'targetMinutes'")" "30"

say "packing list: passport, charger, socks"
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

printf '\n%s═══ E. MILESTONE ═══%s\n' "$B" "$X"
# NOTE: this section encodes the CURRENT chat-interrogation flow (commit 541054f).
# docs/goal-manual-editing-plan.md REPLACES it — chat will take stages if given
# and otherwise make a bare template, and stage tasks move into the Goals tab.
# Rewrite this section as part of that work; it is expected to fail until then.
say "goal to land a summer internship: applying, interviewing, negotiating"
say "update my resume, and apply to 5 jobs a day"
ck "preview card" "$KIND" "goal_preview"
MSG="$(val "select m.id as v from messages m join conversations c on c.id=m.conversation_id where c.user_id='$USER_ID' and m.meta->>'kind'='goal_preview' and m.meta->>'createdGoalId' is null order by m.created_at desc limit 1")"
tap "/goals" "{\"previewMessageId\":\"$MSG\"}"
ck "milestone goal, on stage 0" "$(goal milestone "definition->>'activeStageIndex'")" "0"

printf '\n%s═══ F. SAFETY — the model must NOT act ═══%s\n' "$B" "$X"
say "i want to save for a laptop"
ck "no target stated -> no goal invented" "$(val "select count(*) as v from goals where user_id='$USER_ID' and name ilike '%laptop%' and archived_at is null")" "0"

say "add a task to water the plants"
DONE_BEFORE="$(val "select count(*) as v from tasks where user_id='$USER_ID' and status='done' and deleted_at is null")"
say "mark water done"
ck "ambiguous ref -> nothing written" "$(val "select count(*) as v from tasks where user_id='$USER_ID' and status='done' and deleted_at is null")" "$DONE_BEFORE"
ck_asked "ambiguous ref -> asks which one"

say "hey what's up"
ck "plain conversation -> no cards" "$CARDS" "0"

printf '\n%s══════════════════════════════════════%s\n' "$B" "$X"
printf '%s  DB assertions:  %s%s passed%s   %s%s failed%s\n' "$B" "$G" "$PASS" "$X" "$R" "$FAIL" "$X"
printf '%s  Abnormal chat:  %s flagged%s\n' "$B" "$WEIRD" "$X"
printf '%s══════════════════════════════════════%s\n' "$B" "$X"
printf '  account: %s\n' "$PHONE"
[[ $FAIL -eq 0 && $WEIRD -eq 0 ]] && exit 0 || exit 1

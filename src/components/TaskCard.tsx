import * as Haptics from 'expo-haptics';
import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';

import { radii, theme } from '@/constants/theme';
import { useGoals } from '@/features/goals/queries';
import { useMe } from '@/features/profile/queries';
import { useLiveNow } from '@/hooks/use-live-now';
import { formatMoney } from '@/lib/format';
import type { ApiTask, ChecklistConfig, CounterConfig, DurationConfig } from '@/lib/api/types';
import { toIconName } from '@/lib/icon';
import { useRimHighlight } from './AnimatedPressable';
import { Icon } from './Icon';
import { Progress } from './Progress';

function haptic() {
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
}

// `undefined` here (not a real IANA name) is deliberate — every timeZone
// option below passes it straight through to Intl, which treats `undefined`
// as "use the runtime's own local zone." That's the only sane fallback for a
// task whose account has no stored timezone yet (a brand-new account, or a
// test account that never opened the app to trigger useTimezoneSync).
function tzOrLocal(timezone?: string | null): string | undefined {
  return timezone ?? undefined;
}

/** "YYYY-MM-DD" in `timezone` — comparable lexicographically like a real date. */
function ymdInTz(date: Date, timezone?: string | null): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tzOrLocal(timezone),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/**
 * Overdue only once the *entire calendar day* containing `dueAt` has
 * elapsed — not the instant the due time itself passes. A 9am task stays
 * "due 9am" (and can still fire its on-time notification) through the rest
 * of that day; it only flips to overdue at midnight, same as a task with no
 * explicit time at all.
 *
 * `timezone` should be the account's own stored timezone (`me.user.timezone`
 * from useMe()) — the same value the server uses for this exact
 * computation (task-context.ts's isOverdue). Falling back to the device's
 * local zone when omitted matches the old behavior, but the two can disagree
 * (rare — useTimezoneSync keeps them synced — but real during travel or
 * before that sync's first run), so callers that have the account's
 * timezone handy should always pass it.
 */
export function isOverdue(task: ApiTask, timezone?: string | null): boolean {
  if (task.status !== 'open' || !task.dueAt) return false;
  const dueYmd = ymdInTz(new Date(task.dueAt), timezone);
  const todayYmd = ymdInTz(new Date(), timezone);
  return dueYmd < todayYmd;
}

function formatTime(iso: string, timezone?: string | null): string {
  return new Date(iso).toLocaleString(undefined, {
    timeZone: tzOrLocal(timezone),
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** False only for AI-created tasks where no clock time was ever given — the
 * server defaulted dueAt to end-of-day rather than inventing an hour, and the
 * banner shouldn't show that fabricated time as if the user asked for it. */
function hasExplicitDueTime(task: ApiTask): boolean {
  const config = task.config as { dueTimeExplicit?: boolean };
  return config.dueTimeExplicit !== false;
}

/** "tomorrow" / a short weekday+date when `iso` isn't today in `timezone`, else null. */
function dueDayLabel(iso: string, timezone?: string | null): string | null {
  const dueYmd = ymdInTz(new Date(iso), timezone);
  const todayYmd = ymdInTz(new Date(), timezone);
  if (dueYmd === todayYmd) return null;
  const tomorrowYmd = ymdInTz(new Date(Date.now() + 24 * 60 * 60 * 1000), timezone);
  if (dueYmd === tomorrowYmd) return 'tomorrow';
  return new Date(iso).toLocaleDateString(undefined, {
    timeZone: tzOrLocal(timezone),
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

function formatDueLabel(iso: string, timezone?: string | null): string {
  const dayLabel = dueDayLabel(iso, timezone);
  return dayLabel ? `${formatTime(iso, timezone)} ${dayLabel}` : formatTime(iso, timezone);
}

/** "mm:ss" clock format (e.g. 25 minutes -> "25:00") — a running timer's seconds visibly count up between renders. */
function formatClock(minutes: number): string {
  const totalSeconds = Math.max(0, Math.round(minutes * 60));
  const mm = Math.floor(totalSeconds / 60);
  const ss = totalSeconds % 60;
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

// `now` is threaded in explicitly (never read via `Date.now()` inside these
// pure-looking functions) — with the React Compiler on, a value derived only
// from stable props/state (like `task`) gets memoized, so a hidden internal
// `Date.now()` read would silently freeze between ticks. Passing `now` makes
// the time dependency visible to the compiler. See hooks/use-live-now.ts.
function currentLoggedMinutes(d: DurationConfig, now: number): number {
  let logged = d.loggedMinutes;
  // Clamped to >= 0: `now` can briefly lag a fresh `runningSince` (it only
  // resyncs on the next tick after the timer starts), which would otherwise
  // produce a negative elapsed time and dip the progress ring below 0%.
  if (d.runningSince) logged += Math.max(0, (now - new Date(d.runningSince).getTime()) / 60_000);
  return logged;
}

function trimNum(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function progressMeta(task: ApiTask, now: number): string | undefined {
  switch (task.type) {
    case 'checklist': {
      const items = (task.config as ChecklistConfig).items;
      return `${items.filter((i) => i.done).length}/${items.length} done`;
    }
    case 'counter': {
      const c = task.config as CounterConfig;
      return `${trimNum(c.count)}/${trimNum(c.target)}${c.unit ? ` ${c.unit}` : ''}`;
    }
    case 'duration': {
      const d = task.config as DurationConfig;
      const logged = Math.min(currentLoggedMinutes(d, now), d.targetMinutes);
      return `${formatClock(logged)} / ${formatClock(d.targetMinutes)}`;
    }
    default:
      return undefined;
  }
}

function metaText(
  task: ApiTask,
  now: number,
  timezone?: string | null,
): { text: string; danger: boolean } | undefined {
  const explicit = hasExplicitDueTime(task);
  if (isOverdue(task, timezone)) {
    return {
      text: explicit && task.dueAt ? `Overdue · was due ${formatTime(task.dueAt, timezone)}` : 'Overdue',
      danger: true,
    };
  }
  const progress = progressMeta(task, now);
  const dueLabel = task.dueAt && explicit ? formatDueLabel(task.dueAt, timezone) : undefined;
  if (progress && dueLabel) return { text: `${progress} · ${dueLabel}`, danger: false };
  if (progress) return { text: progress, danger: false };
  if (dueLabel) return { text: dueLabel, danger: false };
  return undefined;
}

// "$5 → Rave savings" for a savings link, "→ Daily meditation" for habit/
// indirect (a linked task's own contribution is savings-only) — null when
// the task isn't goal-linked or its goal isn't loaded yet.
function goalLinkLabel(
  task: ApiTask,
  goals: { id: string; name: string; definition: { type: string; currency?: string } }[] | undefined,
): string | null {
  if (!task.goalId) return null;
  const goal = goals?.find((g) => g.id === task.goalId);
  if (!goal) return null;
  const contribution = (task.config as { goalContribution?: number }).goalContribution;
  if (goal.definition.type === 'savings' && typeof contribution === 'number') {
    return `${goal.definition.currency}${formatMoney(contribution)} → ${goal.name}`;
  }
  return `→ ${goal.name}`;
}

function counterPct(c: CounterConfig): number {
  return c.target > 0 ? Math.min(100, Math.round((c.count / c.target) * 100)) : 0;
}

function checklistPct(c: ChecklistConfig): number {
  return c.items.length ? Math.round((c.items.filter((i) => i.done).length / c.items.length) * 100) : 0;
}

function currentDurationPct(d: DurationConfig, now: number): number {
  return Math.min(100, (currentLoggedMinutes(d, now) / d.targetMinutes) * 100);
}

/**
 * Every task's overall progress toward "done," as a 0-1 fraction — used by
 * the Tasks tab's header ring so a partial counter/checklist/duration
 * contributes proportionally instead of only counting once fully complete.
 * `now` defaults to call time — pass a live-ticking value (useLiveNow) from
 * a caller that wants a running duration timer to visibly advance the ring.
 */
export function taskProgressFraction(task: ApiTask, now: number = Date.now()): number {
  if (task.status === 'done') return 1;
  switch (task.type) {
    case 'checklist':
      return checklistPct(task.config as ChecklistConfig) / 100;
    case 'counter':
      return counterPct(task.config as CounterConfig) / 100;
    case 'duration':
      return currentDurationPct(task.config as DurationConfig, now) / 100;
    default:
      return 0;
  }
}

export function TaskCard({
  task,
  onToggleComplete,
  onCounterIncrement,
  onCounterDecrement,
  onTimerStart,
  onTimerStop,
  onDurationReopen,
  onToggleItem,
}: {
  task: ApiTask;
  /** completion type: tap the banner to toggle done/open. */
  onToggleComplete?: () => void;
  /** counter type: tap the banner while open. */
  onCounterIncrement?: () => void;
  /** counter type: tap the banner again once done, to undo. */
  onCounterDecrement?: () => void;
  /** duration type: tap the banner to start the timer. */
  onTimerStart?: () => void;
  /** duration type: tap the banner again to pause. */
  onTimerStop?: () => void;
  /** duration type: tap the banner again once done, to undo. */
  onDurationReopen?: () => void;
  onToggleItem?: (itemId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const done = task.status === 'done';
  const running = task.type === 'duration' && !!(task.config as DurationConfig).runningSince;
  // Ticks every second while a duration timer is running so the "mm:ss"
  // readout visibly counts up — the progress bar itself animates
  // continuously on the UI thread (see LiveDurationBar) independent of this.
  const now = useLiveNow(running);
  const { data: me } = useMe();
  const { data: goals } = useGoals();
  const meta = metaText(task, now, me?.user.timezone);
  const goalLabel = goalLinkLabel(task, goals);
  const rim = useRimHighlight();

  // Server-side auto-complete only runs when a progress action actually
  // lands (duration_stop/add/set) — if the user just leaves the timer
  // running past the target with the app open, nothing ever tells the
  // server. Once the live-ticking clock shows target reached, stop it the
  // same way a manual tap would, so it doesn't run past the limit.
  //
  // Dedupes by the specific `runningSince` value already auto-stopped,
  // rather than a plain boolean — and deliberately never resets that on
  // `!running`. Undoing a just-auto-completed timer restores that exact
  // (already past-target) runningSince, which would otherwise re-trip this
  // effect within the next tick and silently re-stop it again. A genuine
  // new start always has a different runningSince, so it's unaffected.
  const autoStoppedForRef = useRef<string | null>(null);
  useEffect(() => {
    if (!running) return;
    const d = task.config as DurationConfig;
    const runningSince = d.runningSince ?? null;
    if (!runningSince || autoStoppedForRef.current === runningSince) return;
    if (currentLoggedMinutes(d, now) >= d.targetMinutes) {
      autoStoppedForRef.current = runningSince;
      onTimerStop?.();
    }
  }, [running, now, task.config, onTimerStop]);

  const handleBannerPress = () => {
    haptic();
    switch (task.type) {
      case 'completion':
        onToggleComplete?.();
        break;
      case 'checklist':
        setExpanded((e) => !e);
        break;
      case 'counter':
        (done ? onCounterDecrement : onCounterIncrement)?.();
        break;
      case 'duration':
        if (done) onDurationReopen?.();
        else if (running) onTimerStop?.();
        else onTimerStart?.();
        break;
    }
  };

  return (
    <View style={styles.card}>
      <View style={styles.headerRow}>
        <Pressable
          onPress={handleBannerPress}
          onPressIn={rim.onPressIn}
          onPressOut={rim.onPressOut}
          style={styles.headerTappable}
        >
          <Animated.View pointerEvents="none" style={[styles.rimHighlight, rim.highlightStyle]} />
          <View style={styles.iconChip}>
            <Icon name={toIconName(task.icon)} size={18} color={theme.blue} stroke={1.9} />
          </View>
          <View style={{ flex: 1 }}>
            <View style={styles.titleRow}>
              <Text style={[styles.title, done && styles.strike]} numberOfLines={1}>
                {task.title}
              </Text>
              {task.templateId && <Icon name="repeat" size={12} color={theme.faint} stroke={2.2} />}
            </View>
            {meta && <Text style={[styles.meta, meta.danger && styles.metaDanger]}>{meta.text}</Text>}
            {goalLabel && (
              <View style={styles.goalChip}>
                <Icon name="goals" size={10} color={theme.blue} stroke={2.4} />
                <Text style={styles.goalChipText} numberOfLines={1}>
                  {goalLabel}
                </Text>
              </View>
            )}
          </View>
        </Pressable>

        {task.type === 'completion' && <StatusDot done={done} />}
        {task.type === 'counter' && <StatusDot done={done} />}
        {task.type === 'checklist' && <StatusDot done={done} />}
        {task.type === 'duration' && <DurationStatusDot done={done} running={running} />}
      </View>

      {task.type === 'checklist' && (
        <ChecklistBody config={task.config as ChecklistConfig} expanded={expanded} onToggleItem={onToggleItem} />
      )}
      {task.type === 'counter' && (
        <View style={styles.progressWrap}>
          <Progress value={counterPct(task.config as CounterConfig)} />
        </View>
      )}
      {task.type === 'duration' && (
        <View style={styles.progressWrap}>
          <LiveDurationBar config={task.config as DurationConfig} now={now} />
        </View>
      )}
    </View>
  );
}

// A brief bounce + glow the instant a task flips to done — satisfying, not
// distracting (docs/goals-redesign-plan.md §2.5's micro-interactions).
// Watches the `done` transition itself (not just "is done") so it never
// replays on every re-render of an already-completed task, only the moment
// it actually completes.
function useCompletionPop(done: boolean) {
  const scale = useSharedValue(1);
  const glow = useSharedValue(0);
  const wasDone = useRef(done);

  useEffect(() => {
    if (done && !wasDone.current) {
      scale.value = withSequence(
        withTiming(1.35, { duration: 140, easing: Easing.out(Easing.cubic) }),
        withTiming(1, { duration: 220, easing: Easing.out(Easing.back(1.8)) }),
      );
      glow.value = withSequence(withTiming(1, { duration: 140 }), withTiming(0, { duration: 400 }));
    }
    wasDone.current = done;
  }, [done, scale, glow]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
    shadowColor: theme.blue,
    shadowOpacity: glow.value * 0.9,
    shadowRadius: glow.value * 10,
    shadowOffset: { width: 0, height: 0 },
  }));

  return animatedStyle;
}

/** Non-interactive status circle — filled + checked when done, empty ring when open. */
function StatusDot({ done }: { done: boolean }) {
  const popStyle = useCompletionPop(done);
  return (
    <Animated.View style={[styles.checkbox, done && styles.checkboxOn, popStyle]}>
      {done && <Icon name="check" size={14} color="#fff" stroke={2.6} />}
    </Animated.View>
  );
}

/** Duration's status indicator: blue while running, gray while idle, a checkmark once done. */
function DurationStatusDot({ done, running }: { done: boolean; running: boolean }) {
  const highlighted = done || running;
  const popStyle = useCompletionPop(done);
  return (
    <Animated.View style={[styles.checkbox, highlighted && styles.checkboxOn, popStyle]}>
      <Icon name={done ? 'check' : 'clock'} size={done ? 14 : 15} color={highlighted ? '#fff' : theme.dim} stroke={done ? 2.6 : 2} />
    </Animated.View>
  );
}

/**
 * A progress bar that animates continuously toward 100% over the exact real
 * time remaining while the timer runs — driven entirely on the UI thread
 * (no JS interval), so it keeps advancing smoothly between the 30s text
 * refreshes above.
 */
function LiveDurationBar({ config, now }: { config: DurationConfig; now: number }) {
  const progress = useSharedValue(currentDurationPct(config, now));

  useEffect(() => {
    const pct = currentDurationPct(config, Date.now());
    progress.value = pct;
    if (config.runningSince) {
      const elapsedMs = Date.now() - new Date(config.runningSince).getTime();
      const remainingMs = Math.max(0, config.targetMinutes * 60_000 - config.loggedMinutes * 60_000 - elapsedMs);
      if (remainingMs > 0) {
        progress.value = withTiming(100, { duration: remainingMs, easing: Easing.linear });
      } else {
        progress.value = 100;
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.runningSince, config.loggedMinutes, config.targetMinutes]);

  const animatedStyle = useAnimatedStyle(() => ({ width: `${Math.min(100, progress.value)}%` }));

  return (
    <View style={progressBarStyles.track}>
      <Animated.View style={[progressBarStyles.fill, animatedStyle]}>
        <LinearGradient colors={[theme.blue, theme.blueLight]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={{ flex: 1 }} />
      </Animated.View>
    </View>
  );
}

const progressBarStyles = StyleSheet.create({
  track: { height: 6, borderRadius: 999, backgroundColor: theme.border, overflow: 'hidden' },
  fill: { height: '100%', borderRadius: 999 },
});

function ChecklistBody({
  config,
  expanded,
  onToggleItem,
}: {
  config: ChecklistConfig;
  expanded: boolean;
  onToggleItem?: (itemId: string) => void;
}) {
  const doneCount = config.items.filter((i) => i.done).length;
  const pct = config.items.length ? Math.round((doneCount / config.items.length) * 100) : 0;

  return (
    <View>
      <View style={styles.progressWrap}>
        <Progress value={pct} />
      </View>
      {expanded && (
        <View style={styles.checklistItems}>
          {config.items.map((item) => (
            <Pressable
              key={item.id}
              onPress={() => {
                haptic();
                onToggleItem?.(item.id);
              }}
              style={styles.checklistItemRow}
              hitSlop={4}
            >
              <View style={[styles.itemCheckbox, item.done && styles.checkboxOn]}>
                {item.done && <Icon name="check" size={11} color="#fff" stroke={2.6} />}
              </View>
              <Text style={[styles.itemText, item.done && styles.strike]}>{item.text}</Text>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: theme.card,
    borderColor: theme.borderStrong,
    borderWidth: 1,
    borderRadius: radii.card,
    padding: 14,
  },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  headerTappable: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    position: 'relative',
  },
  rimHighlight: {
    position: 'absolute',
    top: -8,
    left: -8,
    right: -8,
    bottom: -8,
    borderRadius: radii.controlTight,
    borderWidth: 1.5,
    borderColor: theme.blue,
    backgroundColor: 'rgba(10,132,255,0.10)',
  },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  iconChip: {
    width: 34,
    height: 34,
    borderRadius: radii.chip,
    backgroundColor: 'rgba(10,132,255,0.14)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: { color: theme.text, fontSize: 15, fontWeight: '600', flexShrink: 1 },
  meta: { color: theme.dim, fontSize: 12, marginTop: 2 },
  metaDanger: { color: theme.danger },
  goalChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 4,
    alignSelf: 'flex-start',
  },
  goalChipText: { color: theme.blue, fontSize: 11, fontWeight: '600' },
  strike: { textDecorationLine: 'line-through', color: theme.dim },
  checkbox: {
    width: 24,
    height: 24,
    borderRadius: radii.pill,
    borderWidth: 1.5,
    borderColor: theme.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxOn: { backgroundColor: theme.blue, borderColor: theme.blue },
  progressWrap: { marginTop: 12 },
  checklistItems: { marginTop: 10, gap: 8 },
  checklistItemRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  itemCheckbox: {
    width: 18,
    height: 18,
    borderRadius: radii.pill,
    borderWidth: 1.5,
    borderColor: theme.borderStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  itemText: { color: theme.text, fontSize: 13.5, flexShrink: 1 },
});

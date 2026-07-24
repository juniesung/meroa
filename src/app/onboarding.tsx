import * as Haptics from 'expo-haptics';
import { useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import Animated, {
  FadeInDown,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AnimatedPressable, useTapFeedback } from '@/components/AnimatedPressable';
import { Bubble } from '@/components/Bubble';
import { Icon } from '@/components/Icon';
import { MeroaMark } from '@/components/MeroaMark';
import { PrimaryButton } from '@/components/PrimaryButton';
import { Ring } from '@/components/Ring';
import { radii, theme } from '@/constants/theme';
import { GoalTypeOption } from '@/components/GoalTypeOption';
import { useCreateMemory } from '@/features/memory/queries';
import { GOAL_TYPE_OPTIONS } from '@/features/goals/goal-type-options';
import { RecurrenceField } from '@/features/tasks/RecurrenceField';
import {
  buildRecurrence,
  describeRecurrence,
  type RecurrenceChoice,
} from '@/features/tasks/task-form-helpers';
import { ToneSlider } from '@/features/profile/ToneSlider';
import type { GoalTemplateKey, Weekday } from '@/lib/api/types';
import { useUpdatePrefs } from '@/features/profile/queries';
import { DEFAULT_TONE, toneLabel } from '@/features/profile/tone';

// First-run sell + questionnaire, shown before the paywall (root guard:
// absence of prefs.tone — server-persisted, survives reinstall; a legacy
// communicationStyle still counts, see app/_layout.tsx). Since the app is a
// hard paywall (docs/phases/phase-7-premium-
// billing.md), this is the ONLY chance a new user gets to see what they're
// buying before being asked to subscribe — so it walks through every real
// feature (chat, tasks, goals, reminders, consistency), not just the style
// pick. Every stat is a real, cited study — do not round further or invent
// new ones:
//   - Matthews (Dominican University, n=267): written goals 42% likelier
//     reached; written + shared progress check-ins 76% vs 43%.
//   - Gollwitzer & Sheeran (2006, meta-analysis, 94 tests): planning a
//     concrete next step (an "implementation intention") meaningfully raises
//     follow-through vs. a bare intention.
//   - Harkin et al. (2016, Psychological Bulletin, 138 studies, ~20,000
//     people): monitoring progress promotes goal attainment, more so when
//     progress is actually recorded, not just felt.
//   - Lally et al. (2010, UCL): median 66 days to automaticity; missing one
//     day doesn't break the curve.
//   - Reminders/cues: qualitative only (Wood & Neal cue-based habit
//     formation) — deliberately NO invented percentage for this one.
//
// The user creates a real goal + first task during this flow, but nothing
// is written to goals/tasks yet — the hard paywall's free-tier limits are
// zero, so a create here would 429. Instead the draft is captured in
// prefs.onboardingDraft (ungated) and OnboardingDraftFlush
// (features/profile/OnboardingDraftFlush.tsx) creates the real rows the
// instant the user subscribes. Finishing writes memories + prefs — the
// prefs write is what flips the root guard, so there's no router call here.
//
// The goal TYPE is picked explicitly (step 7, GOAL_TYPE_OPTIONS) rather than
// inferred from whether a number was typed — that old heuristic never
// produced habit/indirect goals and rarely produced savings either. This
// mirrors the real Goals-tab create sheet's own type/field conventions
// (src/features/goals/GoalFormSheet.tsx) so onboarding creates the same
// variety of goals the app actually supports.

type FocusKey = 'habit' | 'savings' | 'indirect' | 'milestone' | 'company';

const FOCUS_OPTIONS: {
  key: FocusKey;
  label: string;
  description: string;
  memory: string;
  reflection: string;
}[] = [
  {
    key: 'habit',
    label: 'Build a habit that sticks',
    description: 'Daily reps that finally hold.',
    memory: 'Wants help building a consistent habit',
    reflection: 'build a habit that sticks',
  },
  {
    key: 'savings',
    label: 'Save toward something',
    description: 'Put money aside and watch it stack up.',
    memory: 'Wants help saving toward something',
    reflection: 'save toward something',
  },
  {
    key: 'indirect',
    label: 'Track something over time',
    description: 'Weight, pages, minutes — see the trend.',
    memory: 'Wants to track their progress on something over time',
    reflection: 'watch your progress add up',
  },
  {
    key: 'milestone',
    label: 'Reach a big goal',
    description: 'Something big, taken in stages.',
    memory: 'Is working toward a big milestone goal',
    reflection: 'reach a big goal',
  },
  {
    key: 'company',
    label: 'Someone in my corner',
    description: 'Check-ins, encouragement, a nudge when it counts.',
    memory: 'Mostly wants a companion that checks in and keeps them on track',
    reflection: 'have someone in your corner',
  },
];

// The type list and its row rendering are shared with the Goals-tab create
// sheet (features/goals/goal-type-options.ts, components/GoalTypeOption.tsx)
// so a goal type reads the same wherever it's picked.
type GoalTypeKey = GoalTemplateKey;

const GOAL_FIELDS_COPY: Record<GoalTypeKey, { title: string; subtitle: string; namePlaceholder: string }> = {
  savings: {
    title: "Let's set up your savings goal.",
    subtitle: 'Name it and set a target — you can adjust later.',
    namePlaceholder: 'e.g. Emergency fund',
  },
  habit: {
    title: "Let's set up your habit.",
    subtitle: 'Name it, then tell me what the check-in looks like and how often.',
    namePlaceholder: 'e.g. Meditation',
  },
  indirect: {
    title: "Let's set up what you're tracking.",
    subtitle: "Name it and give it a unit — a target's optional.",
    namePlaceholder: 'e.g. Weight',
  },
  milestone: {
    title: "Let's set up your goal.",
    subtitle: 'Give it a name — add stages later in the Goals tab.',
    namePlaceholder: 'e.g. Land a new job',
  },
};

const STEP_COUNT = 12;

export default function OnboardingScreen() {
  const [step, setStep] = useState(0);
  const [focuses, setFocuses] = useState<FocusKey[]>([]);
  const [goalType, setGoalType] = useState<GoalTypeKey | null>(null);
  const [goalName, setGoalName] = useState('');
  const [goalTarget, setGoalTarget] = useState('');
  const [goalUnit, setGoalUnit] = useState('');
  // The emotional anchor: WHY this goal matters. Stored as a memory so every
  // later accountability nudge / check-in can pull on their own stated reason
  // ("you said you wanted this so you'd stop feeling behind") instead of
  // landing mechanically. Optional — never gates a step.
  const [goalWhy, setGoalWhy] = useState('');
  const [checkinTitle, setCheckinTitle] = useState('');
  // Habit cadence, mirroring GoalFormSheet's picker so a habit set up during
  // onboarding isn't stuck at daily when the real create form offers weekly
  // and every-N. Defaults to daily — the common case, and what this flow
  // hardcoded before.
  const [checkinChoice, setCheckinChoice] = useState<RecurrenceChoice>('daily');
  const [checkinWeekdays, setCheckinWeekdays] = useState<Weekday[]>([]);
  const [checkinEveryN, setCheckinEveryN] = useState('2');
  const [taskTitle, setTaskTitle] = useState('');
  // Voice tone slider (0 = warmest, 4 = edgiest). Always has a value, so the
  // tone step never blocks Continue the way the old required vibe pick did.
  const [tone, setTone] = useState<number>(DEFAULT_TONE);
  const [toneTrackWidth, setToneTrackWidth] = useState(0);
  const createMemory = useCreateMemory();
  const updatePrefs = useUpdatePrefs();

  const toggleFocus = (key: FocusKey) => {
    setFocuses((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  };

  const parsedTarget = parseFloat(goalTarget);
  const hasValidTarget = Number.isFinite(parsedTarget) && parsedTarget > 0;
  // undefined when the choice can't yet build one ("Weekdays" with no days
  // ticked) — a habit's check-in has to repeat, so that blocks Continue
  // rather than silently defaulting to a cadence nobody picked.
  const checkinRecurrence = buildRecurrence(checkinChoice, checkinWeekdays, checkinEveryN, '');

  // Same requirement each type's real create form enforces (GoalFormSheet.tsx /
  // server/src/lib/goals/schema.ts's refineCreateGoalParams) — used both to
  // gate the step-8 Continue button and to decide what finish() submits.
  const goalIsComplete =
    !!goalType &&
    !!goalName.trim() &&
    (goalType === 'savings'
      ? hasValidTarget
      : goalType === 'indirect'
        ? !!goalUnit.trim()
        : goalType === 'habit'
          ? !!checkinTitle.trim() && checkinRecurrence !== undefined
          : true);

  const goalFieldsStep = goalType ? GOAL_FIELDS_COPY[goalType] : null;
  // Habit's task IS its check-in, collected in the same step as the goal —
  // there's no separate task step to advance to for that type.
  const afterGoalFieldsStep = goalType === 'habit' ? 10 : 9;

  const finish = () => {
    if (updatePrefs.isPending) return;
    // Memory writes are fired but not awaited — losing one to a network blip
    // shouldn't strand the user in onboarding; the prefs write below is the
    // one that matters (its onSuccess merge into the cached `me` flips the
    // root guard's needsOnboarding, same reactive hand-off usePurchase uses).
    for (const key of focuses) {
      const option = FOCUS_OPTIONS.find((o) => o.key === key);
      if (option) createMemory.mutate({ content: option.memory, kind: 'preference' });
    }

    const trimmedWhy = goalWhy.trim();
    if (trimmedWhy) {
      const trimmedName = goalName.trim();
      createMemory.mutate({
        content: trimmedName
          ? `Why "${trimmedName}" matters to them: ${trimmedWhy}`
          : `Something that matters to them right now: ${trimmedWhy}`,
        kind: 'preference',
      });
    }

    const trimmedGoalName = goalName.trim();
    const trimmedTask = taskTitle.trim();
    const trimmedCheckin = checkinTitle.trim();
    const trimmedUnit = goalUnit.trim();

    const onboardingDraft =
      goalIsComplete || trimmedTask
        ? {
            ...(goalIsComplete
              ? {
                  goal: {
                    type: goalType as GoalTypeKey,
                    name: trimmedGoalName,
                    ...(goalType === 'savings' ? { targetValue: parsedTarget } : {}),
                    ...(goalType === 'indirect'
                      ? { unit: trimmedUnit, ...(hasValidTarget ? { targetValue: parsedTarget } : {}) }
                      : {}),
                    ...(goalType === 'habit'
                      ? { checkinTitle: trimmedCheckin, checkinRecurrence }
                      : {}),
                  },
                }
              : {}),
            // Habit has no separate task — its checkinTitle above is the task.
            ...(goalType !== 'habit' && trimmedTask ? { task: { title: trimmedTask } } : {}),
          }
        : null;

    updatePrefs.mutate({ tone, onboardingDraft });
  };

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Animated.View key={step} entering={FadeInDown.duration(280)}>
          {step === 0 && (
            <StepFrame>
              <BigStat value="42%" />
              <Text style={styles.statLine}>more likely to reach a goal when you write it down.</Text>
              <Text style={styles.subtitle}>
                That&apos;s the whole idea behind me. I&apos;m Meroa — tell me what you actually
                want, and I&apos;ll help you get there.
              </Text>
              <Text style={styles.ref}>Matthews, 2015 · n=267</Text>
              <PrimaryButton label="Let's do it" onPress={() => setStep(1)} style={styles.cta} />
            </StepFrame>
          )}

          {step === 1 && (
            <StepFrame>
              <Text style={styles.title}>What brings you to Meroa?</Text>
              <Text style={styles.subtitle}>
                Pick anything that fits — this shapes how I work with you.
              </Text>
              <View style={styles.optionList}>
                {FOCUS_OPTIONS.map((option) => (
                  <FocusOption
                    key={option.key}
                    label={option.label}
                    description={option.description}
                    isSelected={focuses.includes(option.key)}
                    onPress={() => toggleFocus(option.key)}
                  />
                ))}
              </View>
              <PrimaryButton
                label="Continue"
                onPress={focuses.length > 0 ? () => setStep(2) : undefined}
                style={StyleSheet.flatten([styles.cta, focuses.length === 0 && styles.ctaDisabled])}
              />
              <Text style={styles.skip} onPress={() => setStep(2)}>
                Skip
              </Text>
            </StepFrame>
          )}

          {step === 2 && (
            <StepFrame>
              <Text style={styles.title}>Talk to me like a friend.</Text>
              <Text style={styles.subtitle}>
                No forms, no menus — just tell me what&apos;s going on and I&apos;ll keep track.
              </Text>
              <ChatShowcase />
              <BigStat value="76% vs 43%" small />
              <Text style={styles.statLine}>
                reach a goal with someone checking in on you, versus going it alone.
              </Text>
              <Text style={styles.ref}>Matthews, 2015</Text>
              <PrimaryButton label="Keep going" onPress={() => setStep(3)} style={styles.cta} />
            </StepFrame>
          )}

          {step === 3 && (
            <StepFrame>
              <BigStat value="94 studies" small />
              <Text style={styles.statLine}>found that planning one concrete step beats just meaning to.</Text>
              <Text style={styles.subtitle}>
                So I turn a vague &quot;I should&quot; into a real, specific next step you&apos;ll
                actually do.
              </Text>
              <TaskShowcase />
              <Text style={styles.ref}>Gollwitzer &amp; Sheeran, 2006</Text>
              <PrimaryButton label="Keep going" onPress={() => setStep(4)} style={styles.cta} />
            </StepFrame>
          )}

          {step === 4 && (
            <StepFrame>
              <BigStat value="138 studies" small />
              <Text style={styles.statLine}>show that tracking your progress makes you more likely to reach the goal.</Text>
              <Text style={styles.subtitle}>
                Even more when it&apos;s actually recorded, not just felt — so I keep the score
                for you.
              </Text>
              <GoalShowcase />
              <Text style={styles.ref}>Harkin et al., 2016 · ~20,000 people</Text>
              <PrimaryButton label="Keep going" onPress={() => setStep(5)} style={styles.cta} />
            </StepFrame>
          )}

          {step === 5 && (
            <StepFrame>
              <Text style={styles.title}>The right nudge, right when it counts.</Text>
              <Text style={styles.subtitle}>I nudge you when autopilot would take over — not just whenever.</Text>
              <ReminderShowcase />
              <PrimaryButton label="Keep going" onPress={() => setStep(6)} style={styles.cta} />
            </StepFrame>
          )}

          {step === 6 && (
            <StepFrame>
              <BigStat value="66 days" />
              <Text style={styles.statLine}>is how long a habit really takes to stick — not 21.</Text>
              <Text style={styles.subtitle}>
                Missing one day doesn&apos;t break it. Showing up most days is what counts, and
                that&apos;s exactly what I&apos;m here for.
              </Text>
              <ConsistencyShowcase />
              <Text style={styles.ref}>Lally et al., 2010</Text>
              <PrimaryButton label="I'm in" onPress={() => setStep(7)} style={styles.cta} />
            </StepFrame>
          )}

          {step === 7 && (
            <StepFrame>
              <Text style={styles.title}>What kind of goal?</Text>
              <Text style={styles.subtitle}>Pick whichever fits.</Text>
              <View style={styles.optionList}>
                {GOAL_TYPE_OPTIONS.map((option) => (
                  <GoalTypeOption
                    key={option.key}
                    icon={option.icon}
                    label={option.label}
                    description={option.description}
                    example={option.example}
                    isSelected={goalType === option.key}
                    onPress={() => setGoalType(option.key)}
                  />
                ))}
              </View>
              <PrimaryButton
                label="Continue"
                onPress={goalType ? () => setStep(8) : undefined}
                style={StyleSheet.flatten([styles.cta, !goalType && styles.ctaDisabled])}
              />
              <Text
                style={styles.skip}
                onPress={() => {
                  setGoalType(null);
                  setStep(10);
                }}
              >
                Skip for now
              </Text>
            </StepFrame>
          )}

          {step === 8 && goalFieldsStep && (
            <StepFrame>
              <Text style={styles.title}>{goalFieldsStep.title}</Text>
              <Text style={styles.subtitle}>{goalFieldsStep.subtitle}</Text>
              <View style={styles.inputBlock}>
                <TextInput
                  value={goalName}
                  onChangeText={setGoalName}
                  placeholder={goalFieldsStep.namePlaceholder}
                  placeholderTextColor={theme.faint}
                  style={styles.input}
                />
                {goalType === 'savings' && (
                  <TextInput
                    value={goalTarget}
                    onChangeText={setGoalTarget}
                    placeholder="Target amount ($)"
                    placeholderTextColor={theme.faint}
                    keyboardType="decimal-pad"
                    style={[styles.input, styles.inputSpaced]}
                  />
                )}
                {goalType === 'indirect' && (
                  <>
                    <TextInput
                      value={goalUnit}
                      onChangeText={setGoalUnit}
                      placeholder="Unit (e.g. lbs, pages)"
                      placeholderTextColor={theme.faint}
                      style={[styles.input, styles.inputSpaced]}
                    />
                    <TextInput
                      value={goalTarget}
                      onChangeText={setGoalTarget}
                      placeholder="Target number (optional)"
                      placeholderTextColor={theme.faint}
                      keyboardType="decimal-pad"
                      style={[styles.input, styles.inputSpaced]}
                    />
                  </>
                )}
                {goalType === 'habit' && (
                  <>
                    <TextInput
                      value={checkinTitle}
                      onChangeText={setCheckinTitle}
                      placeholder="e.g. Meditate for 10 minutes"
                      placeholderTextColor={theme.faint}
                      style={[styles.input, styles.inputSpaced]}
                    />
                    <View style={styles.inputSpaced}>
                      <RecurrenceField
                        choice={checkinChoice}
                        weekdays={checkinWeekdays}
                        everyN={checkinEveryN}
                        onChoiceChange={setCheckinChoice}
                        onWeekdaysChange={setCheckinWeekdays}
                        onEveryNChange={setCheckinEveryN}
                        allowNever={false}
                      />
                    </View>
                  </>
                )}
                <TextInput
                  value={goalWhy}
                  onChangeText={setGoalWhy}
                  placeholder="Why does this matter to you right now? (optional)"
                  placeholderTextColor={theme.faint}
                  style={[styles.input, styles.inputSpaced]}
                  multiline
                />
              </View>
              <PrimaryButton
                label="Continue"
                onPress={goalIsComplete ? () => setStep(afterGoalFieldsStep) : undefined}
                style={StyleSheet.flatten([styles.cta, !goalIsComplete && styles.ctaDisabled])}
              />
              <Text style={styles.skip} onPress={() => setStep(afterGoalFieldsStep)}>
                Skip for now
              </Text>
            </StepFrame>
          )}

          {step === 9 && (
            <StepFrame>
              <Text style={styles.title}>
                {goalName.trim()
                  ? `What's one concrete step for "${goalName.trim()}"?`
                  : "What's one thing you want to get done?"}
              </Text>
              <Text style={styles.subtitle}>Small and specific beats big and vague.</Text>
              <View style={styles.inputBlock}>
                <TextInput
                  value={taskTitle}
                  onChangeText={setTaskTitle}
                  placeholder="e.g. Set up automatic transfer"
                  placeholderTextColor={theme.faint}
                  style={styles.input}
                />
              </View>
              <PrimaryButton
                label="Continue"
                onPress={taskTitle.trim() ? () => setStep(10) : undefined}
                style={StyleSheet.flatten([styles.cta, !taskTitle.trim() && styles.ctaDisabled])}
              />
              <Text style={styles.skip} onPress={() => setStep(10)}>
                Skip for now
              </Text>
            </StepFrame>
          )}

          {step === 10 && (
            <StepFrame>
              <Text style={styles.title}>How should I sound?</Text>
              <Text style={styles.subtitle}>Slide toward warm or edgy. Change it anytime.</Text>
              <View style={styles.optionList}>
                <ToneSlider
                  value={tone}
                  onChange={setTone}
                  trackWidth={toneTrackWidth}
                  onTrackLayout={setToneTrackWidth}
                />
              </View>
              <PrimaryButton label="Continue" onPress={() => setStep(11)} style={styles.cta} />
            </StepFrame>
          )}

          {step === 11 && (
            <StepFrame>
              <Text style={styles.title}>This is you, committing.</Text>
              <Text style={styles.subtitle}>Show up most days, not perfect days. That&apos;s the whole game.</Text>
              <View style={styles.recap}>
                {goalName.trim() && <RecapRow text={`Goal: ${goalName.trim()}`} />}
                {goalType === 'habit'
                  ? checkinTitle.trim() && (
                      <RecapRow
                        text={`${checkinRecurrence ? describeRecurrence(checkinRecurrence) : 'Daily'} check-in: ${checkinTitle.trim()}`}
                      />
                    )
                  : taskTitle.trim() && <RecapRow text={`First step: ${taskTitle.trim()}`} />}
                {focuses.length > 0 ? (
                  FOCUS_OPTIONS.filter((o) => focuses.includes(o.key)).map((o) => (
                    <RecapRow key={o.key} text={o.label} />
                  ))
                ) : (
                  <RecapRow text="Figure out my goals together" />
                )}
                <RecapRow text={`${toneLabel(tone)} tone`} />
              </View>
              <PrimaryButton
                label={updatePrefs.isPending ? 'Setting up your Meroa…' : "I'm ready to show up"}
                onPress={updatePrefs.isPending ? undefined : finish}
                style={StyleSheet.flatten([styles.cta, updatePrefs.isPending && styles.ctaDisabled])}
              />
            </StepFrame>
          )}
        </Animated.View>

        <View style={styles.dots}>
          {Array.from({ length: STEP_COUNT }, (_, i) => (
            <View key={i} style={[styles.dot, i === step && styles.dotActive]} />
          ))}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function StepFrame({ children }: { children: React.ReactNode }) {
  return (
    <View style={styles.step}>
      <MeroaMark size={48} glow />
      {children}
    </View>
  );
}

// Counts a single number up from 0 to `target` on mount (ease-out), reporting
// `done` once it lands — BigStat uses `done` to fire a haptic + glow exactly
// once, and only after every number in the stat has finished (so "76% vs
// 43%" doesn't haptic twice).
function useCountUp(target: number, active: boolean, durationMs = 900): { value: number; done: boolean } {
  const [value, setValue] = useState(active ? 0 : target);
  const [done, setDone] = useState(!active);

  useEffect(() => {
    // Initial state above already matches the inactive case (value=target,
    // done=true) — nothing to animate. Mount-only: each BigStat is keyed to
    // a step (`key={step}` on the wrapping Animated.View) so it always
    // remounts fresh rather than receiving a changed target/active on an
    // existing instance.
    if (!active) return;
    const start = Date.now();
    let raf: ReturnType<typeof requestAnimationFrame>;
    const tick = () => {
      const t = Math.min(1, (Date.now() - start) / durationMs);
      const eased = 1 - (1 - t) ** 3;
      setValue(Math.round(eased * target));
      if (t < 1) {
        raf = requestAnimationFrame(tick);
      } else {
        setDone(true);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { value, done };
}

// Splits "76% vs 43%" into text/number parts and animates each number
// counting up independently, then re-assembles the string — handles every
// stat shape used on this screen ("42%", "94 studies", "76% vs 43%") without
// hardcoding a format. A soft blue glow + one haptic fires once ALL numbers
// in the stat finish counting — the "lands" moment, same idea as Ring's own
// crossing-to-100 celebration (components/Ring.tsx).
function BigStat({ value, small }: { value: string; small?: boolean }) {
  const parts = value.split(/(\d+)/);
  const numberParts = parts.filter((_, i) => i % 2 === 1).map(Number);
  const textParts = parts.filter((_, i) => i % 2 === 0);

  const first = useCountUp(numberParts[0] ?? 0, numberParts.length > 0);
  const second = useCountUp(numberParts[1] ?? 0, numberParts.length > 1);

  const allDone = first.done && second.done;
  const hapticFired = useRef(false);
  const scale = useSharedValue(1);
  const glow = useSharedValue(0);

  useEffect(() => {
    if (!allDone || hapticFired.current) return;
    hapticFired.current = true;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    scale.value = withSequence(withTiming(1.12, { duration: 140 }), withTiming(1, { duration: 220 }));
    glow.value = withSequence(withTiming(1, { duration: 140 }), withTiming(0, { duration: 550 }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allDone]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
    textShadowRadius: 3 + glow.value * 16,
  }));

  const counts = numberParts.length > 1 ? [first.value, second.value] : [first.value];
  let rendered = textParts[0] ?? '';
  counts.forEach((n, i) => {
    rendered += String(n) + (textParts[i + 1] ?? '');
  });

  return (
    <Animated.Text
      style={[
        styles.bigStat,
        small && styles.bigStatSmall,
        { textShadowColor: theme.blue, textShadowOffset: { width: 0, height: 0 } },
        animatedStyle,
      ]}
    >
      {rendered}
    </Animated.Text>
  );
}

// A multi-select option row (membership toggles instead of replacing the
// selection) — used for the "what brings you to Meroa?" focus step.
function FocusOption({
  label,
  description,
  isSelected,
  onPress,
}: {
  label: string;
  description: string;
  isSelected: boolean;
  onPress: () => void;
}) {
  const { animatedStyle, onPressIn, onPressOut } = useTapFeedback(0.98);

  return (
    <AnimatedPressable
      onPress={() => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
        onPress();
      }}
      onPressIn={onPressIn}
      onPressOut={onPressOut}
      style={[styles.option, isSelected && styles.optionSelected, animatedStyle]}
    >
      <View style={{ flex: 1 }}>
        <Text style={[styles.optionLabel, isSelected && styles.optionLabelSelected]}>{label}</Text>
        <Text style={styles.optionDescription}>{description}</Text>
      </View>
      {isSelected && <Icon name="check" size={18} color={theme.blue} stroke={2.4} />}
    </AnimatedPressable>
  );
}

function RecapRow({ text }: { text: string }) {
  return (
    <View style={styles.recapRow}>
      <Icon name="check" size={16} color={theme.blue} stroke={2.4} />
      <Text style={styles.recapText}>{text}</Text>
    </View>
  );
}

// --- Feature showcases (illustrative only — not real data, never written
// anywhere). Built from real presentational components (Bubble, Ring,
// Progress) where those are pure/self-contained; TaskCard/GoalCard are not
// used here since they fetch live goals/timezone data internally and aren't
// meant to render fabricated content. ---

function ChatShowcase() {
  return (
    <View style={showcase.chatBlock}>
      <Bubble from="me">ugh, keep putting off going to the gym</Bubble>
      <Bubble from="ai">that&apos;s a mood. want to set something up so it actually sticks?</Bubble>
    </View>
  );
}

// Auto-checks itself a couple seconds after landing, so the "satisfying
// check-off" feel reads even if the user never taps it — still tappable
// (toggles either way) and cancels the pending auto-check the instant a real
// tap happens, so an early manual toggle can't be clobbered by it later.
function TaskShowcase() {
  const [done, setDone] = useState(false);
  const { animatedStyle, onPressIn, onPressOut } = useTapFeedback(0.97);
  const checkScale = useSharedValue(1);
  const autoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const pop = () => {
    checkScale.value = withSequence(withTiming(1.3, { duration: 120 }), withTiming(1, { duration: 200 }));
  };

  useEffect(() => {
    autoTimer.current = setTimeout(() => {
      setDone(true);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      pop();
    }, 1600);
    return () => {
      if (autoTimer.current) clearTimeout(autoTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const checkAnimatedStyle = useAnimatedStyle(() => ({ transform: [{ scale: checkScale.value }] }));

  return (
    <AnimatedPressable
      onPress={() => {
        if (autoTimer.current) clearTimeout(autoTimer.current);
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
        setDone((d) => {
          const next = !d;
          if (next) pop();
          return next;
        });
      }}
      onPressIn={onPressIn}
      onPressOut={onPressOut}
      style={[showcase.card, showcase.taskRow, animatedStyle]}
    >
      <Animated.View style={[showcase.checkbox, done && showcase.checkboxDone, checkAnimatedStyle]}>
        {done && <Icon name="check" size={14} color="#fff" stroke={3} />}
      </Animated.View>
      <Text style={[showcase.taskTitle, done && showcase.taskTitleDone]}>
        Hit the gym
      </Text>
    </AnimatedPressable>
  );
}

function GoalShowcase() {
  const [value, setValue] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => setValue(64), 150);
    return () => clearTimeout(t);
  }, []);

  return (
    <View style={[showcase.card, showcase.goalRow]}>
      <Ring value={value} size={52} label={`${value}%`} />
      <View style={{ flex: 1 }}>
        <Text style={showcase.goalTitle}>Emergency fund</Text>
        <Text style={showcase.goalSubtitle}>$640 of $1,000</Text>
      </View>
    </View>
  );
}

function ReminderShowcase() {
  return (
    <View style={[showcase.card, showcase.reminderRow]}>
      <View style={showcase.reminderIcon}>
        <Icon name="bell" size={16} color={theme.blue} stroke={2.2} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={showcase.reminderTitle}>Meroa</Text>
        <Text style={showcase.reminderBody}>Time for your evening check-in 🌙</Text>
      </View>
    </View>
  );
}

function ConsistencyShowcase() {
  const days = [true, true, true, false, true, true, true];
  return (
    <View style={[showcase.card, showcase.streakBlock]}>
      <View style={showcase.streakHeader}>
        <Icon name="flame" size={18} color={theme.blue} stroke={2.2} />
        <Text style={showcase.streakLabel}>6-day streak, and counting</Text>
      </View>
      <View style={showcase.dayRow}>
        {days.map((on, i) => (
          <View key={i} style={[showcase.dayPill, on && showcase.dayPillOn]} />
        ))}
      </View>
    </View>
  );
}

const showcase = StyleSheet.create({
  card: {
    alignSelf: 'stretch',
    marginTop: 16,
    padding: 14,
    borderRadius: radii.card,
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: theme.card,
  },
  chatBlock: { alignSelf: 'stretch', marginTop: 16, gap: 2 },
  taskRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 999,
    borderWidth: 2,
    borderColor: theme.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxDone: { backgroundColor: theme.blue, borderColor: theme.blue },
  taskTitle: { color: theme.text, fontSize: 15, fontWeight: '600' },
  taskTitleDone: { color: theme.dim, textDecorationLine: 'line-through' },
  goalRow: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  goalTitle: { color: theme.text, fontSize: 15, fontWeight: '600' },
  goalSubtitle: { color: theme.dim, fontSize: 13, marginTop: 2 },
  reminderRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  reminderIcon: {
    width: 32,
    height: 32,
    borderRadius: 10,
    backgroundColor: 'rgba(10,132,255,0.14)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  reminderTitle: { color: theme.text, fontSize: 13, fontWeight: '700' },
  reminderBody: { color: theme.dim, fontSize: 13, marginTop: 1 },
  streakBlock: { gap: 12 },
  streakHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  streakLabel: { color: theme.text, fontSize: 14, fontWeight: '600' },
  dayRow: { flexDirection: 'row', gap: 6 },
  dayPill: { flex: 1, height: 8, borderRadius: 4, backgroundColor: theme.border },
  dayPillOn: { backgroundColor: theme.blue },
});

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.bg },
  content: { flexGrow: 1, justifyContent: 'center', padding: 24, paddingBottom: 32 },
  step: { alignItems: 'center', gap: 8 },
  bigStat: { color: theme.blue, fontSize: 54, fontWeight: '800', marginTop: 16, letterSpacing: -1 },
  bigStatSmall: { fontSize: 34, marginTop: 12 },
  title: {
    color: theme.text,
    fontSize: 22,
    fontWeight: '700',
    marginTop: 12,
    textAlign: 'center',
  },
  subtitle: {
    color: theme.dim,
    fontSize: 14,
    lineHeight: 21,
    textAlign: 'center',
    paddingHorizontal: 8,
  },
  // The line that says what the big number actually MEANS — prominent white,
  // right under the stat, so the takeaway reads before the gray supporting copy.
  statLine: {
    color: theme.text,
    fontSize: 17,
    fontWeight: '600',
    lineHeight: 23,
    textAlign: 'center',
    paddingHorizontal: 8,
    marginTop: 6,
  },
  // Compact source citation under a big stat — the study is referenced, not
  // explained (keeps the flow stat-forward and un-wordy).
  ref: {
    color: theme.faint,
    fontSize: 12,
    textAlign: 'center',
    marginTop: 10,
  },
  optionList: { alignSelf: 'stretch', marginTop: 16 },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderRadius: radii.controlTight,
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: theme.surface,
    marginBottom: 10,
  },
  optionSelected: { borderColor: theme.blue, backgroundColor: 'rgba(10,132,255,0.14)' },
  optionLabel: { color: theme.text, fontSize: 15, fontWeight: '600' },
  optionLabelSelected: { color: theme.blue },
  optionDescription: { color: theme.dim, fontSize: 13, marginTop: 2 },
  inputBlock: { alignSelf: 'stretch', marginTop: 18 },
  input: {
    color: theme.text,
    fontSize: 15,
    paddingHorizontal: 14,
    paddingVertical: 12,
    backgroundColor: theme.surface,
    borderRadius: radii.controlTight,
    borderWidth: 1,
    borderColor: theme.border,
  },
  inputSpaced: { marginTop: 10 },
  recap: { alignSelf: 'stretch', gap: 10, marginTop: 20, paddingHorizontal: 12 },
  recapRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  recapText: { color: theme.text, fontSize: 15, fontWeight: '600' },
  cta: { alignSelf: 'stretch', marginTop: 24 },
  ctaDisabled: { opacity: 0.5 },
  skip: { color: theme.faint, fontSize: 13, textAlign: 'center', marginTop: 18 },
  dots: { flexDirection: 'row', justifyContent: 'center', gap: 7, marginTop: 28 },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: theme.border },
  dotActive: { backgroundColor: theme.blue },
});

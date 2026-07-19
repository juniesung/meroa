import * as Haptics from 'expo-haptics';
import { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AnimatedPressable, useTapFeedback } from '@/components/AnimatedPressable';
import { Icon } from '@/components/Icon';
import { MeroaMark } from '@/components/MeroaMark';
import { PrimaryButton } from '@/components/PrimaryButton';
import { radii, theme } from '@/constants/theme';
import { useCreateMemory } from '@/features/memory/queries';
import { VibeOptionList } from '@/features/profile/VibeOptionList';
import { useUpdatePrefs } from '@/features/profile/queries';
import { vibeLabel, type VibePreset } from '@/features/profile/vibes';

// First-run questionnaire, shown before the paywall (root guard: absence of
// prefs.communicationStyle — server-persisted, survives reinstall). Two real
// questions (focus areas, communication style) wrapped in motivational
// screens whose stats are real studies — Matthews (Dominican University,
// n=267): written goals 42% likelier reached, written + shared progress
// check-ins 76% vs 43%; Lally et al. (UCL 2010): median 66 days to
// automaticity, one missed day doesn't break the curve. Don't round these
// further or add new ones. Finishing writes one preference memory per picked
// focus and the style pref — the prefs write is what flips the root guard,
// so there's no router call anywhere here.

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

function reflectionSentence(keys: FocusKey[]): string {
  const parts = FOCUS_OPTIONS.filter((o) => keys.includes(o.key)).map((o) => o.reflection);
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

const STEP_COUNT = 6;

export default function OnboardingScreen() {
  const [step, setStep] = useState(0);
  const [focuses, setFocuses] = useState<FocusKey[]>([]);
  const [style, setStyle] = useState<VibePreset | null>(null);
  const createMemory = useCreateMemory();
  const updatePrefs = useUpdatePrefs();

  const toggleFocus = (key: FocusKey) => {
    setFocuses((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  };

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
    updatePrefs.mutate({ communicationStyle: style ?? 'balanced' });
  };

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.content}>
        <Animated.View key={step} entering={FadeInDown.duration(280)}>
          {step === 0 && (
            <StepFrame>
              <BigStat value="42%" />
              <Text style={styles.title}>Goals that get written down get reached.</Text>
              <Text style={styles.subtitle}>
                In a 267-person study, people who wrote their goals down were 42% more likely to
                achieve them. I&apos;m Meroa — a companion that works with you toward your goals.
                Let&apos;s write yours down. It takes a minute.
              </Text>
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
              {/* Nothing picked means nothing to reflect back — skip step 2 too. */}
              <Text style={styles.skip} onPress={() => setStep(3)}>
                Skip
              </Text>
            </StepFrame>
          )}

          {step === 2 && (
            <StepFrame>
              <Text style={styles.title}>So you want to {reflectionSentence(focuses)}.</Text>
              <Text style={styles.subtitle}>
                Good — that&apos;s exactly what I&apos;m for. I&apos;m not a tracker you fill in.
                I&apos;m a companion that works alongside you, day by day, until you get there.
              </Text>
              <BigStat value="76% vs 43%" small />
              <Text style={styles.subtitle}>
                In that same study, people who wrote their goals down and checked in on progress
                with someone hit 76% of them — versus 43% going it alone. That someone? That&apos;s
                me. Every day.
              </Text>
              <PrimaryButton label="Keep going" onPress={() => setStep(3)} style={styles.cta} />
            </StepFrame>
          )}

          {step === 3 && (
            <StepFrame>
              <BigStat value="66 days" />
              <Text style={styles.title}>Consistency beats intensity.</Text>
              <Text style={styles.subtitle}>
                Real habits take a median of 66 days of showing up — not 21. And the research is
                clear: missing one day doesn&apos;t break it. Showing up most days is what makes it
                stick. Keeping you consistent is my whole job — daily check-ins, no judgment, back
                on track the next day.
              </Text>
              <PrimaryButton label="I'm in" onPress={() => setStep(4)} style={styles.cta} />
            </StepFrame>
          )}

          {step === 4 && (
            <StepFrame>
              <Text style={styles.title}>Last thing — how should I talk to you?</Text>
              <Text style={styles.subtitle}>
                Pick a starting point — you can change this any time in the You tab.
              </Text>
              <View style={styles.optionList}>
                <VibeOptionList selected={style} onSelect={setStyle} />
              </View>
              <PrimaryButton
                label="Continue"
                onPress={style ? () => setStep(5) : undefined}
                style={StyleSheet.flatten([styles.cta, !style && styles.ctaDisabled])}
              />
              <Text style={styles.skip} onPress={() => setStep(5)}>
                Skip for now
              </Text>
            </StepFrame>
          )}

          {step === 5 && (
            <StepFrame>
              <Text style={styles.title}>Let&apos;s make it official.</Text>
              <Text style={styles.subtitle}>
                You show up, I keep you consistent — a companion working with you toward your
                goals, from day one.
              </Text>
              <View style={styles.recap}>
                {focuses.length > 0 ? (
                  FOCUS_OPTIONS.filter((o) => focuses.includes(o.key)).map((o) => (
                    <RecapRow key={o.key} text={o.label} />
                  ))
                ) : (
                  <RecapRow text="Figure out my goals together" />
                )}
                <RecapRow text={`${vibeLabel(style ?? 'balanced')} check-ins`} />
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

function BigStat({ value, small }: { value: string; small?: boolean }) {
  return <Text style={[styles.bigStat, small && styles.bigStatSmall]}>{value}</Text>;
}

// Same row anatomy as VibeOption (features/profile/VibeOptionList.tsx), but
// multi-select — membership toggles instead of replacing the selection.
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

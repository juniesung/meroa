import * as Haptics from 'expo-haptics';
import { StyleSheet, Text, View } from 'react-native';

import { AnimatedPressable, useTapFeedback } from '@/components/AnimatedPressable';
import { Icon, type IconName } from '@/components/Icon';
import { radii, theme } from '@/constants/theme';

// One goal-type row: icon, name, what it does, and a concrete example.
// Shared by onboarding's picker and the Goals-tab create sheet so choosing a
// type reads identically in both — the create sheet used to show bare chips,
// which meant the only place that ever explained the difference between
// "Savings" and "Tracked" was a flow you see once.
export function GoalTypeOption({
  icon,
  label,
  description,
  example,
  isSelected,
  onPress,
}: {
  icon: IconName;
  label: string;
  description: string;
  example: string;
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
      <View style={[styles.typeIconChip, isSelected && styles.typeIconChipSelected]}>
        <Icon name={icon} size={17} color={isSelected ? theme.blue : theme.dim} stroke={2.2} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[styles.optionLabel, isSelected && styles.optionLabelSelected]}>{label}</Text>
        <Text style={styles.optionDescription}>{description}</Text>
        <Text style={styles.optionExample}>{example}</Text>
      </View>
      {isSelected && <Icon name="check" size={18} color={theme.blue} stroke={2.4} />}
    </AnimatedPressable>
  );
}

const styles = StyleSheet.create({
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
  optionExample: { color: theme.faint, fontSize: 12, marginTop: 4 },
  typeIconChip: {
    width: 34,
    height: 34,
    borderRadius: radii.chip,
    backgroundColor: theme.card,
    alignItems: 'center',
    justifyContent: 'center',
  },
  typeIconChipSelected: { backgroundColor: 'rgba(10,132,255,0.14)' },
});

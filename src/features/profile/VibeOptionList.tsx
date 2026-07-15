import * as Haptics from 'expo-haptics';
import { StyleSheet, Text, View } from 'react-native';

import { AnimatedPressable, useTapFeedback } from '@/components/AnimatedPressable';
import { Icon } from '@/components/Icon';
import { radii, theme } from '@/constants/theme';
import { VIBE_OPTIONS, type VibePreset } from './vibes';

export function VibeOptionList({
  selected,
  onSelect,
}: {
  selected: VibePreset | null;
  onSelect: (key: VibePreset) => void;
}) {
  return (
    <View style={{ gap: 10 }}>
      {VIBE_OPTIONS.map((option) => (
        <VibeOption
          key={option.key}
          label={option.label}
          description={option.description}
          isSelected={selected === option.key}
          onPress={() => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
            onSelect(option.key);
          }}
        />
      ))}
    </View>
  );
}

function VibeOption({
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
      onPress={onPress}
      onPressIn={onPressIn}
      onPressOut={onPressOut}
      style={[styles.option, isSelected && styles.optionSelected, animatedStyle]}
    >
      <View style={{ flex: 1 }}>
        <Text style={[styles.label, isSelected && styles.labelSelected]}>{label}</Text>
        <Text style={styles.description}>{description}</Text>
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
  },
  optionSelected: {
    borderColor: theme.blue,
    backgroundColor: 'rgba(10,132,255,0.14)',
  },
  label: { color: theme.text, fontSize: 15, fontWeight: '600' },
  labelSelected: { color: theme.blue },
  description: { color: theme.dim, fontSize: 13, marginTop: 2 },
});

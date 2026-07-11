import * as Haptics from 'expo-haptics';
import { StyleSheet, Text, View } from 'react-native';

import { radii, theme } from '@/constants/theme';
import { AnimatedPressable, useTapFeedback } from './AnimatedPressable';
import { Icon, type IconName } from './Icon';

export function TaskCard({
  icon,
  title,
  meta,
  done,
  onToggle,
}: {
  icon: IconName;
  title: string;
  meta?: string;
  done?: boolean;
  onToggle?: () => void;
}) {
  const { animatedStyle, onPressIn, onPressOut } = useTapFeedback(0.85);

  return (
    <View style={styles.card}>
      <View style={styles.iconChip}>
        <Icon name={icon} size={18} color={theme.blue} stroke={1.9} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[styles.title, done && styles.strike]}>{title}</Text>
        {meta && <Text style={styles.meta}>{meta}</Text>}
      </View>
      <AnimatedPressable
        onPressIn={onPressIn}
        onPressOut={onPressOut}
        onPress={() => {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
          onToggle?.();
        }}
        style={[styles.checkbox, done && { backgroundColor: theme.blue, borderColor: theme.blue }, animatedStyle]}
        hitSlop={8}
      >
        {done && <Icon name="check" size={14} color="#fff" stroke={2.6} />}
      </AnimatedPressable>
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
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  iconChip: {
    width: 34,
    height: 34,
    borderRadius: radii.chip,
    backgroundColor: 'rgba(10,132,255,0.14)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: { color: theme.text, fontSize: 15, fontWeight: '600' },
  meta: { color: theme.dim, fontSize: 12, marginTop: 2 },
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
});

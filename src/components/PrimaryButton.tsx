import { LinearGradient } from 'expo-linear-gradient';
import { StyleSheet, Text, type ViewStyle } from 'react-native';

import { radii, theme } from '@/constants/theme';
import { AnimatedPressable, useTapFeedback } from './AnimatedPressable';

export function PrimaryButton({
  label,
  onPress,
  style,
}: {
  label: string;
  onPress?: () => void;
  style?: ViewStyle;
}) {
  const { animatedStyle, onPressIn, onPressOut } = useTapFeedback();

  return (
    <AnimatedPressable onPress={onPress} onPressIn={onPressIn} onPressOut={onPressOut} style={[style, animatedStyle]}>
      <LinearGradient
        colors={theme.gradient}
        start={{ x: 0, y: 0 }}
        end={{ x: 0, y: 1 }}
        style={styles.button}
      >
        <Text style={styles.label}>{label}</Text>
      </LinearGradient>
    </AnimatedPressable>
  );
}

const styles = StyleSheet.create({
  button: {
    paddingVertical: 14,
    borderRadius: radii.controlTight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: { color: '#fff', fontWeight: '600', fontSize: 16 },
});

import { StyleSheet, Text, View } from 'react-native';

import { radii, theme } from '@/constants/theme';
import { haptics } from '@/lib/haptics';
import { AnimatedPressable, useTapFeedback } from './AnimatedPressable';
import { Icon, type IconName } from './Icon';

export function Row({
  icon,
  label,
  right,
  danger,
  onPress,
}: {
  icon?: IconName;
  label: string;
  right?: React.ReactNode;
  danger?: boolean;
  onPress?: () => void;
}) {
  const { animatedStyle, onPressIn, onPressOut } = useTapFeedback(0.98);

  const handlePress = onPress
    ? () => {
        haptics.tap();
        onPress();
      }
    : undefined;

  return (
    <AnimatedPressable
      onPress={handlePress}
      onPressIn={onPressIn}
      onPressOut={onPressOut}
      style={[styles.row, animatedStyle]}
    >
      {icon && (
        <View
          style={[
            styles.iconChip,
            { backgroundColor: danger ? 'rgba(255,69,58,0.14)' : 'rgba(10,132,255,0.14)' },
          ]}
        >
          <Icon name={icon} size={16} color={danger ? '#FF6B60' : theme.blue} stroke={1.9} />
        </View>
      )}
      <Text style={[styles.label, danger && { color: '#FF6B60' }]}>{label}</Text>
      {right ?? <Icon name="chevron" size={16} color={theme.faint} stroke={2} />}
    </AnimatedPressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 13,
    borderBottomWidth: 1,
    borderBottomColor: theme.border,
    minHeight: 52,
  },
  iconChip: {
    width: 34,
    height: 34,
    borderRadius: radii.chip,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: { flex: 1, color: theme.text, fontSize: 15, fontWeight: '500' },
});

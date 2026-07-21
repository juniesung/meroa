import { StyleSheet } from 'react-native';

import { theme } from '@/constants/theme';
import { haptics } from '@/lib/haptics';
import { AnimatedPressable, useTapFeedback } from './AnimatedPressable';
import { Icon } from './Icon';

/**
 * The floating "+" create button, bottom-right above the tab bar. Shared by the
 * Tasks and Goals tabs so the add action sits in the same reachable spot on
 * both. `bottom` is the offset above the screen's bottom edge — pass
 * `tabBarHeight + <gap>` so it clears the translucent tab bar.
 */
export function AddFab({ onPress, bottom }: { onPress: () => void; bottom: number }) {
  const feedback = useTapFeedback(0.9);
  return (
    <AnimatedPressable
      onPressIn={feedback.onPressIn}
      onPressOut={feedback.onPressOut}
      onPress={() => {
        haptics.tap();
        onPress();
      }}
      style={[styles.fab, { bottom }, feedback.animatedStyle]}
      hitSlop={8}
    >
      <Icon name="plus" size={24} color="#fff" stroke={2.2} />
    </AnimatedPressable>
  );
}

const styles = StyleSheet.create({
  fab: {
    position: 'absolute',
    right: 20,
    width: 56,
    height: 56,
    borderRadius: 999,
    backgroundColor: theme.blue,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: theme.blue,
    shadowOpacity: 0.5,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
  },
});

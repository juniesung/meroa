import { View } from 'react-native';
import Svg, { Circle, Defs, LinearGradient, Path, Stop } from 'react-native-svg';

export function MeroaMark({ size = 28, glow = false }: { size?: number; glow?: boolean }) {
  return (
    <View
      style={
        glow
          ? {
              shadowColor: '#0A84FF',
              shadowOpacity: 0.55,
              shadowRadius: 10,
              shadowOffset: { width: 0, height: 0 },
            }
          : undefined
      }
    >
      <Svg width={size} height={size} viewBox="0 0 64 64">
        <Defs>
          <LinearGradient id="meroaMarkGradient" x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0%" stopColor="#5AB0FF" />
            <Stop offset="100%" stopColor="#0A6DF0" />
          </LinearGradient>
        </Defs>
        <Path
          d="M10 12 C10 10 12 8 14 8 C17 8 19 10 20 13 L26 34 C27 37 29 37 30 34 L36 13 C37 10 39 8 42 8 C44 8 46 10 46 12 L46 40 C46 46 42 50 36 50 L34 50 L30 56 L28 50 L20 50 C14 50 10 46 10 40 Z"
          fill="url(#meroaMarkGradient)"
        />
        <Circle cx="24" cy="42" r="1.6" fill="#0A2540" />
        <Circle cx="28" cy="42" r="1.6" fill="#0A2540" />
        <Circle cx="32" cy="42" r="1.6" fill="#0A2540" />
      </Svg>
    </View>
  );
}

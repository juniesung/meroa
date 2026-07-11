import Svg, { Path } from 'react-native-svg';

export const iconPaths = {
  chat: 'M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v8A2.5 2.5 0 0 1 17.5 17H12l-4 3v-3H6.5A2.5 2.5 0 0 1 4 14.5v-8Z',
  tasks: 'M4 6h4M4 12h4M4 18h4M11 5l2 2 5-5M11 11l2 2 5-5M11 17l2 2 5-5',
  tools: 'M6 4h4v4H6zM14 4h4v4h-4zM6 12h4v4H6zM14 12h4v4h-4zM6 20h4M14 20h4',
  you: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM4 21a8 8 0 0 1 16 0',
  plus: 'M12 5v14M5 12h14',
  send: 'M4 12l16-8-6 18-2-8-8-2Z',
  mic: 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3ZM5 11a7 7 0 0 0 14 0M12 18v3',
  paperclip: 'M21 12.5 12.5 21a5 5 0 0 1-7-7L14 5.5a3.5 3.5 0 1 1 5 5L10.5 19',
  ellipsis: 'M6 12h.01M12 12h.01M18 12h.01',
  check: 'M5 12l5 5L20 6',
  droplet: 'M12 3s6 7 6 11a6 6 0 1 1-12 0c0-4 6-11 6-11Z',
  clock: 'M12 7v5l3 2M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18Z',
  briefcase: 'M4 8h16v11H4zM8 8V6a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2',
  dumbbell: 'M3 10v4M21 10v4M6 7v10M18 7v10M6 12h12',
  wallet: 'M4 7h13a3 3 0 0 1 3 3v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7ZM4 7a2 2 0 0 1 2-2h10M17 13h.01',
  book: 'M4 5a2 2 0 0 1 2-2h12v18H6a2 2 0 0 1-2-2V5ZM4 17h14',
  chevron: 'M9 6l6 6-6 6',
  bell: 'M6 8a6 6 0 1 1 12 0c0 5 2 6 2 7H4c0-1 2-2 2-7ZM10 20a2 2 0 0 0 4 0',
  moon: 'M20 15A8 8 0 1 1 9 4a7 7 0 0 0 11 11Z',
  lock: 'M6 10V8a6 6 0 1 1 12 0v2M5 10h14v10H5z',
  crown: 'M4 18h16M4 7l4 4 4-6 4 6 4-4-2 11H6L4 7Z',
  logout: 'M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l-5-5 5-5M5 12h11',
  sparkle: 'M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2 2M16 16l2 2M6 18l2-2M16 8l2-2',
  flame: 'M12 3s5 5 5 10a5 5 0 1 1-10 0c0-2 1-3 2-4 0 2 1 3 2 3 0-3 1-6 1-9Z',
  repeat: 'M17 2l4 4-4 4M7 22l-4-4 4-4M3 6h13a4 4 0 0 1 4 4v1M21 18H8a4 4 0 0 1-4-4v-1',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6',
} as const;

export type IconName = keyof typeof iconPaths;

export function Icon({
  name,
  size = 20,
  color = '#F5F7FA',
  stroke = 1.6,
  fill = 'none',
}: {
  name: IconName;
  size?: number;
  color?: string;
  stroke?: number;
  fill?: string;
}) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill={fill}>
      <Path
        d={iconPaths[name]}
        stroke={color}
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

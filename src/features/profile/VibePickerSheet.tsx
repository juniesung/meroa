import { ScrollView } from 'react-native';

import { Sheet } from '@/components/Sheet';
import { useMe, useUpdatePrefs } from './queries';
import { VibeOptionList } from './VibeOptionList';
import type { VibePreset } from './vibes';

export function VibePickerSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  return (
    <Sheet visible={visible} onClose={onClose} title="Communication style">
      <VibePickerBody onClose={onClose} />
    </Sheet>
  );
}

// Remounted per open (key on the sheet below) so the selection reads fresh
// prefs each time — same idiom as GoalFormSheet's body.
function VibePickerBody({ onClose }: { onClose: () => void }) {
  const { data } = useMe();
  const updatePrefs = useUpdatePrefs();
  const current =
    typeof data?.user.prefs.communicationStyle === 'string'
      ? (data.user.prefs.communicationStyle as VibePreset)
      : null;

  return (
    // Sheet caps itself at maxHeight: '86%' and doesn't scroll its own
    // content — five option rows plus the sheet's own title/handle can
    // exceed that on a smaller device, clipping the last option with no
    // way to reach it. This is what actually makes it scrollable.
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 12 }}>
      <VibeOptionList
        selected={current}
        onSelect={(style) => updatePrefs.mutate({ communicationStyle: style }, { onSuccess: onClose })}
      />
    </ScrollView>
  );
}

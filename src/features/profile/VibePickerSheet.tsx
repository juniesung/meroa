import { useState } from 'react';
import { ScrollView } from 'react-native';

import { Sheet } from '@/components/Sheet';
import { useMe, useUpdatePrefs } from './queries';
import { ToneSlider } from './ToneSlider';
import { toneFromPrefs } from './tone';

export function VibePickerSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  return (
    <Sheet visible={visible} onClose={onClose} title="Voice tone">
      <TonePickerBody />
    </Sheet>
  );
}

// Reads the current tone from prefs on mount. Dragging the slider writes the
// new level immediately (no Save button) — the sheet stays open so the user can
// feel the difference across a few positions before dismissing it.
function TonePickerBody() {
  const { data } = useMe();
  const updatePrefs = useUpdatePrefs();
  const [value, setValue] = useState(() => toneFromPrefs(data?.user.prefs));
  const [trackWidth, setTrackWidth] = useState(0);

  return (
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 12 }}>
      <ToneSlider
        value={value}
        onChange={(level) => {
          setValue(level);
          updatePrefs.mutate({ tone: level });
        }}
        trackWidth={trackWidth}
        onTrackLayout={setTrackWidth}
      />
    </ScrollView>
  );
}

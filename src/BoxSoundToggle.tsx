/**
 * Box trade sound controls, styled to sit among the existing Box toolbar controls
 * (mirrors ThemeToggle: `btn` + a size-16 Phosphor icon + a label).
 *
 * Two buttons:
 *  - the on/off TOGGLE (announces its current state via aria-pressed), and
 *  - a TEST button, which plays a cue so the user can confirm audio works. The test
 *    click also unlocks the browser AudioContext, which browsers keep suspended until the
 *    first user gesture — so after a page refresh, pressing Test lets later event-driven
 *    entry/exit cues play.
 */

import { SpeakerHighIcon, SpeakerSlashIcon, PlayIcon } from "@phosphor-icons/react";

interface BoxSoundToggleProps {
  enabled: boolean;
  onToggle: () => void;
  onTest: () => void;
}

export default function BoxSoundToggle({ enabled, onToggle, onTest }: BoxSoundToggleProps) {
  // The toggle announces its CURRENT state; the action is implied by the pressed state.
  const label = enabled ? "Box sounds enabled" : "Box sounds disabled";
  const actionLabel = enabled ? "Disable Box trade sounds" : "Enable Box trade sounds";

  return (
    <>
      <button
        type="button"
        className="btn btn--quiet box-sound-toggle"
        aria-label={actionLabel}
        aria-pressed={enabled}
        title={label}
        onClick={onToggle}
      >
        {enabled ? (
          <SpeakerHighIcon size={16} weight="regular" aria-hidden="true" />
        ) : (
          <SpeakerSlashIcon size={16} weight="regular" aria-hidden="true" />
        )}
        <span>Sounds</span>
      </button>
      <button
        type="button"
        className="btn btn--quiet box-sound-test"
        aria-label="Play a test Box sound"
        title="Play a test sound. Also re-enables sound playback after a page refresh."
        onClick={onTest}
      >
        <PlayIcon size={16} weight="regular" aria-hidden="true" />
        <span>Test</span>
      </button>
    </>
  );
}

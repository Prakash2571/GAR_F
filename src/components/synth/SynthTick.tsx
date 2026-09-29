/**
 * A live number that flashes briefly when it changes: green when it rose, red when it fell.
 * The flash is a CSS animation replayed by re-keying one <span>, so a change costs one tiny
 * DOM swap and nothing else re-renders. Motion is off under `prefers-reduced-motion`.
 */

import { memo, useState } from "react";

export const SynthTick = memo(function SynthTick({
  value,
  text,
  className = "",
}: {
  value: number | null | undefined;
  text: string;
  className?: string;
}) {
  // "Storing information from previous renders": setState during render is React's own
  // pattern for this, and it is replay-safe under concurrent rendering.
  const [prev, setPrev] = useState(value);
  const [flash, setFlash] = useState<{ dir: "up" | "down"; n: number } | null>(null);
  if (!Object.is(prev, value)) {
    setPrev(value);
    if (typeof prev === "number" && typeof value === "number") {
      setFlash({ dir: value > prev ? "up" : "down", n: (flash?.n ?? 0) + 1 });
    }
  }
  const cls = `${className}${flash ? ` synth-tick synth-tick--${flash.dir}` : ""}`;
  return (
    <span key={flash?.n ?? 0} className={cls || undefined}>
      {text}
    </span>
  );
});

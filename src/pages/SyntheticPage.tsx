/**
 * /synth: the synthetic-futures arbitrage workspace (gts-synth). It sits behind the
 * service's OWN gate (SynthAccessGate): a separate passcode, session and CSRF token.
 */

import Synthetic from "../components/synth/Synthetic.tsx";
import SynthAccessGate from "../components/synth/SynthAccessGate.tsx";

export default function SyntheticPage() {
  return <SynthAccessGate render={(lock) => <Synthetic onLock={lock} />} />;
}

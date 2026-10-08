// Rótulo fixo do modo demo, presente em todas as telas (spec 10.2, R4; AC-39).
import { DEMO_LABEL } from "@contracts";

export function ModeBanner() {
  return (
    <div className="mode-banner" role="status">
      <strong>Demo mode:</strong> {DEMO_LABEL}
    </div>
  );
}

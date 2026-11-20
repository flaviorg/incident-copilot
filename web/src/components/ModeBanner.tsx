// Fixed demo-mode label, present on every screen (spec 10.2, R4; AC-39).
import { DEMO_LABEL } from "@contracts";

export function ModeBanner() {
  return (
    <div className="mode-banner" role="status">
      <div className="wrap">
        <strong>Replay</strong>
        <span>{`${DEMO_LABEL}. No real action is executed.`}</span>
      </div>
    </div>
  );
}

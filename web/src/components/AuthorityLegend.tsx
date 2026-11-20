// Legend of the strip holder colors: who acted. Color is never alone: each strip also names its role.
import { AUTHORITY_LABELS } from "../labels.ts";

export function AuthorityLegend() {
  return (
    <ul className="legend" aria-label="Strip colors">
      <li>
        <span className="swatch auth-model" aria-hidden="true" />
        <span><b>Blue</b> {AUTHORITY_LABELS.model}</span>
      </li>
      <li>
        <span className="swatch auth-code" aria-hidden="true" />
        <span><b>Green</b> code computes and enforces</span>
      </li>
      <li>
        <span className="swatch auth-human" aria-hidden="true" />
        <span><b>Amber</b> {AUTHORITY_LABELS.human}</span>
      </li>
    </ul>
  );
}

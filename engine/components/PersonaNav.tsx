import { PERSONA_LABELS, type NavTarget } from '../lib/nav.ts';

/**
 * Navigation, scoped to the personas a viewer actually holds.
 *
 * The scoping is a courtesy, not a control. A link that is absent is a surface
 * this person has no business in; a request they craft by hand is still refused by
 * the policy matrix on the server. Hiding a tab is never the reason something is
 * safe.
 *
 * The persona label is text, not a colour, so somebody holding several hats can
 * tell which surface they are on without relying on a hue.
 */
export const PersonaNav = ({ targets }: { targets: readonly NavTarget[] }) => (
  <nav aria-label="Main">
    {targets.map((target) => (
      <a className="tab" href={target.href} key={target.href}>
        {target.label}
        {target.persona === undefined ? null : (
          <span className="tab-persona">{PERSONA_LABELS[target.persona]}</span>
        )}
      </a>
    ))}
  </nav>
);

import type { Persona } from './persona.ts';

/**
 * Navigation targets for a viewer's personas.
 *
 * A plain module rather than part of the component, so it is directly testable —
 * Node's type stripping does not run JSX, and this is the piece whose behaviour
 * matters. It takes personas and organizations and nothing else: it cannot see an
 * actor, so it cannot become the thing that decides what somebody may do. The
 * policy matrix does that, on every request.
 */
export interface NavTarget {
  readonly href: string;
  readonly label: string;
  /** Shown so a person can tell which hat a surface belongs to. */
  readonly persona?: Persona;
}

export const PERSONA_LABELS: Readonly<Record<Persona, string>> = {
  consumer: 'You',
  community: 'Community',
  organization: 'Organization',
  operator: 'Operator',
  intelligence: 'Review',
};

export const navFor = (
  personas: readonly Persona[],
  organizations: readonly { readonly id: string; readonly displayName: string }[],
): readonly NavTarget[] => {
  const targets: NavTarget[] = [
    { href: '/', label: 'Explore' },
    { href: '/compose', label: 'Create' },
  ];

  // One entry per organization rather than a single "Organization" tab: someone
  // who answers for two entities must never be in doubt about which one they are
  // speaking as.
  for (const organization of organizations) {
    targets.push({
      href: `/organizations/${organization.id}`,
      label: organization.displayName,
      persona: 'organization',
    });
  }

  if (personas.includes('operator')) {
    targets.push({ href: '/operate', label: 'Review queue', persona: 'operator' });
  }
  if (personas.includes('intelligence')) {
    targets.push({ href: '/operate/proposals', label: 'Proposals', persona: 'intelligence' });
  }

  return targets;
};

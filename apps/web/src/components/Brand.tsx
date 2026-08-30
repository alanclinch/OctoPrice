/** Reusable OctoAgile Advisor identity lockup. */

import type { JSX } from 'react';

export function Brand({
  level = 1,
  subtitle,
}: {
  level?: 1 | 2;
  subtitle?: string | undefined;
}): JSX.Element {
  const Heading: 'h1' | 'h2' = level === 1 ? 'h1' : 'h2';

  return (
    <div className="brand-lockup">
      <div className="brand-copy">
        <Heading className="brand-name">
          OctoAgile <span>Advisor</span>
        </Heading>
        {subtitle && <span className="region">{subtitle}</span>}
      </div>
    </div>
  );
}

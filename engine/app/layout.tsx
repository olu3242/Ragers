import type { ReactNode } from 'react';
import './globals.css';
import { PersonaNav } from '../components/PersonaNav.tsx';
import { navFor } from '../lib/nav.ts';
import { resolveViewer } from '../lib/persona.ts';

export const metadata = {
  title: 'Ragers',
  description: 'Share the moment without exposing the person.',
};

export const viewport = { width: 'device-width', initialScale: 1 };

/**
 * Async so navigation can be scoped to the viewer's personas on the server. The
 * alternative — shipping every tab and hiding some in the browser — would leak
 * the shape of the operator and organization surfaces to everyone.
 */
const RootLayout = async ({ children }: { children: ReactNode }) => {
  const viewer = await resolveViewer();
  return (
  <html lang="en">
    <body>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <div className="shell">
        <header className="masthead">
          <a className="wordmark" href="/">
            Ragers
          </a>
          <PersonaNav targets={navFor(viewer.personas, viewer.organizations)} />
        </header>
        <main id="main">{children}</main>
        <p className="principle">Critique the behavior. Protect the human.</p>
      </div>
    </body>
  </html>
  );
};

export default RootLayout;

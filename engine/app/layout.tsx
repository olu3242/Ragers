import type { ReactNode } from 'react';
import './globals.css';

export const metadata = {
  title: 'Ragers',
  description: 'Share the moment without exposing the person.',
};

export const viewport = { width: 'device-width', initialScale: 1 };

const RootLayout = ({ children }: { children: ReactNode }) => (
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
          <nav aria-label="Main">
            <a className="tab" href="/">
              Explore
            </a>
            <a className="tab" href="/compose">
              Create
            </a>
          </nav>
        </header>
        <main id="main">{children}</main>
        <p className="principle">Critique the behavior. Protect the human.</p>
      </div>
    </body>
  </html>
);

export default RootLayout;

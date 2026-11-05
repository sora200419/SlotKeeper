import type { ReactNode } from 'react';
import '@/app/site.css';

const REPO_URL = 'https://github.com/sora200419/SlotKeeper';

/** Top bar and footer shared by the customer pages; the staff board has its own layout. */
export function SiteShell({ children }: { children: ReactNode }) {
  return (
    <div className="sk-site">
      <header className="site-top">
        <div className="site-wrap">
          <a className="site-brand" href="/">
            SlotKeeper
          </a>
          <nav className="site-nav" aria-label="Main">
            <a href="/book">Book</a>
            <a href="/staff">Staff</a>
          </nav>
        </div>
      </header>
      <main>
        <div className="site-wrap">{children}</div>
      </main>
      <footer className="site-footer">
        <div className="site-wrap">
          <span>PayPal sandbox only: no real money moves.</span>
          <nav aria-label="Project">
            <a href={REPO_URL}>Code on GitHub</a>
            <a href="/api/health">PayPal sandbox status</a>
          </nav>
        </div>
      </footer>
    </div>
  );
}

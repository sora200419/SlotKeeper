import { SiteShell } from '@/components/SiteShell';

// Every sentence here describes behaviour in the code; the wording follows the reviewed README.
export default function Home() {
  return (
    <SiteShell>
      <section className="site-hero">
        <p className="site-eyebrow">PayPal AI Hackathon · sandbox demo</p>
        <h1>Every booking backed by a PayPal deposit.</h1>
        <p className="site-lead">
          An AI front desk for small appointment businesses. Customers, or their AI assistants, book a slot
          and PayPal holds a deposit. The owner describes a change, an AI copilot proposes a plan, and
          nothing runs until the owner approves.
        </p>
        <div className="site-actions">
          <a className="site-button site-button-primary" href="/book">
            Book a slot
          </a>
          <a className="site-button" href="/staff">
            Staff board
          </a>
        </div>
      </section>

      <section className="site-grid" aria-label="Features">
        <article className="site-card">
          <h2>Deposit holds</h2>
          <p>A customer books a slot and PayPal holds a deposit on their account (Orders v2 AUTHORIZE). Nothing is charged yet.</p>
        </article>
        <article className="site-card">
          <h2>Owner copilot</h2>
          <p>
            The owner types what changed, like &ldquo;Maria is sick tomorrow, move her clients to Ken&rdquo;. Claude
            proposes a plan, it is previewed on the schedule, and it runs only after the owner approves. Every
            step that runs is written to an audit log.
          </p>
        </article>
        <article className="site-card">
          <h2>Bookings by AI assistants</h2>
          <p>
            An assistant connects to our MCP server at <code>/api/mcp</code>, holds a slot and gets a PayPal
            approval link. The customer approves the deposit; the assistant never moves money.
          </p>
        </article>
      </section>

      <section className="site-section">
        <h2>How the deposit works</h2>
        <ol className="site-steps">
          <li>The customer books and approves in PayPal. PayPal holds the deposit.</li>
          <li>
            After the appointment the owner captures it. If the customer doesn&rsquo;t show up, the owner
            charges a no-show fee up to the deposit, and the rest of the hold is released.
          </li>
          <li>If the booking is cancelled, any hold is released and nothing is charged.</li>
        </ol>
        <p className="site-muted">Staff screens need a staff token.</p>
      </section>
    </SiteShell>
  );
}

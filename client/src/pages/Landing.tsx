import { useLocation } from "wouter";
import { goToLogin } from "@/const";
import { useEffect, useRef, useState } from "react";
import { RotateCcw, ZoomIn, ZoomOut } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { readNetworkMode, writeNetworkMode, type NetworkMode } from "@/lib/networkMode";

function LandingLogo({ wordmark = true }: { wordmark?: boolean }) {
  return <a className="landing-logo" href="#top" aria-label="Voltra Finance home"><img src="/voltralogo.png" alt="" />{wordmark && <span>Voltra Finance</span>}</a>;
}

function ProductMockup() {
  const [open, setOpen] = useState(false);
  const [zoom, setZoom] = useState(1);
  const adjustZoom = (amount: number) => setZoom((current) => Math.min(3, Math.max(1, Number((current + amount).toFixed(2)))));
  return <>
    <button type="button" className="landing-visual" aria-label="Open a larger view of the completed payroll payouts" onClick={() => { setZoom(window.matchMedia("(max-width: 680px)").matches ? 2 : 1); setOpen(true); }}>
      <img className="landing-visual-photo" src="/images/payroll-payout-detail.png" alt="Completed payroll payout table showing requested amounts, estimated payouts in BCH, PUSD, USDC, and XLM, and verified statuses" fetchPriority="high" />
      <span className="landing-photo-caption">Five payouts verified</span>
      <span className="landing-photo-zoom-hint"><ZoomIn size={15} /> Click to enlarge</span>
    </button>
    <Dialog open={open} onOpenChange={(nextOpen) => { setOpen(nextOpen); if (nextOpen) setZoom(window.matchMedia("(max-width: 680px)").matches ? 2 : 1); }}>
      <DialogContent className="landing-image-dialog" aria-describedby={undefined}>
        <DialogTitle className="landing-image-title">Completed Voltra Finance payment</DialogTitle>
        <div className="landing-image-toolbar" aria-label="Image zoom controls">
          <button type="button" aria-label="Zoom out" onClick={() => adjustZoom(-0.25)} disabled={zoom <= 1}><ZoomOut size={18} /></button>
          <span>{Math.round(zoom * 100)}%</span>
          <button type="button" aria-label="Zoom in" onClick={() => adjustZoom(0.25)} disabled={zoom >= 3}><ZoomIn size={18} /></button>
          <button type="button" aria-label="Reset zoom" onClick={() => setZoom(1)}><RotateCcw size={17} /></button>
        </div>
        <div className="landing-image-viewport">
          <img
            className="landing-image-full"
            src="/images/payroll-review.png"
            alt="Completed payment with BCH, PUSD, USDC, and XLM on Stellar, showing verified recipient payouts"
            style={{ width: `${zoom * 100}%` }}
            onDoubleClick={() => setZoom((current) => current === 1 ? 2 : 1)}
            onWheel={(event) => { if (event.ctrlKey || event.metaKey) { event.preventDefault(); adjustZoom(event.deltaY < 0 ? 0.1 : -0.1); } }}
          />
        </div>
      </DialogContent>
    </Dialog>
  </>;
}

const settlementSteps = [
  { number: "01", title: "Prepare and approve", body: "Set up payroll or review an invoice. Approve the details when everything is ready." },
  { number: "02", title: "Recipients choose", body: "Each person selects a supported payout option that works for them." },
  { number: "03", title: "Track completion", body: "Follow payment progress and keep each payout with its invoice or payroll run." },
];

function Landing() {
  const [, setLocation] = useLocation();
  const [networkMode, setNetworkMode] = useState<NetworkMode>(readNetworkMode);
  const [menuOpen, setMenuOpen] = useState(false);
  const [submitLinkCopied, setSubmitLinkCopied] = useState(false);
  const mainRef = useRef<HTMLElement>(null);
  const enterApp = () => { setMenuOpen(false); setLocation("/login?mode=signup"); };
  const closeMenu = () => setMenuOpen(false);
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") closeMenu(); };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    const revealItems = mainRef.current?.querySelectorAll<HTMLElement>("[data-reveal], [data-reveal-stagger]");
    if (!revealItems?.length) return;
    if (!("IntersectionObserver" in window)) {
      revealItems.forEach((item) => item.classList.add("is-visible"));
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.06, rootMargin: "0px 0px -10% 0px" });
    revealItems.forEach((item) => observer.observe(item));
    return () => observer.disconnect();
  }, []);

  return <div className="landing-page" id="top">
    <header className="landing-nav">
      <LandingLogo wordmark={false} />
      <nav id="landing-navigation" className={menuOpen ? "landing-nav-open" : ""}>
        <a href="#product" onClick={closeMenu}>Payout options</a>
        <a href="#how-it-works" onClick={closeMenu}>How it works</a>
        <a href="#use-cases" onClick={closeMenu}>Use cases</a>
        <a href="#faq" onClick={closeMenu}>FAQ</a>
      </nav>
      <div className="landing-nav-actions">
        <button className="landing-login" onClick={() => { writeNetworkMode("testnet"); setNetworkMode("testnet"); setLocation("/app"); }}>Testnet</button>
        <button className="landing-login" onClick={() => setLocation("/pay")}>Pay</button>
        <button className="landing-login" onClick={() => setLocation("/submit-invoice")}>Submit an invoice</button>
        <button className="landing-login" onClick={goToLogin}>Sign in</button>
        <button className="landing-nav-cta" onClick={enterApp}>Create your workspace</button>
      </div>
      <button className="landing-menu" type="button" onClick={() => setMenuOpen(!menuOpen)} aria-expanded={menuOpen} aria-label={menuOpen ? "Close navigation menu" : "Open navigation menu"} aria-controls="landing-navigation">
        <span className={menuOpen ? "landing-menu-lines is-open" : "landing-menu-lines"} aria-hidden="true"><i /><i /><i /></span>
      </button>
    </header>

    <main ref={mainRef}>
      <section className="landing-presentation-banner" aria-label="BCH BLAZE project presentation" data-reveal>
        <div><span className="landing-eyebrow">BCH BLAZE 2026 | Project presentation</span><p>See how Voltra helps businesses pay their teams and suppliers.</p></div>
        <a href="https://docs.google.com/presentation/d/1dwAefBX9cy4a3RDElP8Iwf2vgrNhreKBTNejhX474XU/edit?slide=id.g38c6463b456_0_170&pli=1#slide=id.g38c6463b456_0_170" target="_blank" rel="noopener noreferrer">View the pitch deck</a>
      </section>

      <section className="landing-hero" data-reveal>
        <div className="landing-hero-glow" />
        <div className="landing-hero-copy-column">
          <div className="landing-kicker">Business payments made easier</div>
          <h1>Pay your team<br />and suppliers in BCH.<br /><span>They choose how to receive it.</span></h1>
          <p className="landing-hero-copy">Manage payroll and supplier invoices in one workspace. Pay in BCH while each recipient chooses a supported payout option that works for them.</p>
          <div className="landing-hero-actions">
            <button className="landing-primary" onClick={enterApp}>Create your workspace</button>
            <button className="landing-secondary" onClick={() => document.getElementById("how-it-works")?.scrollIntoView({ behavior: "smooth" })}>See how it works</button>
          </div>
          <div className="landing-proof"><span>BCH payments</span><span>Recipient choice</span><span>Payroll and invoices</span></div>
        </div>
        <ProductMockup />
      </section>

      <section className="landing-section landing-payment-flow" id="how-it-works" data-reveal>
        <div className="landing-section-heading">
          <span className="landing-eyebrow">How it works</span>
          <h2>From preparing a payment<br /><em>to knowing it is complete.</em></h2>
          <p>Handle the work in one place, from the first review to the final payment record.</p>
        </div>
        <div className="landing-flow-grid" data-reveal-stagger>
          {settlementSteps.map((step) => <article className="landing-flow-card" key={step.number}>
            <span className="settlement-number">{step.number}</span>
            <h3>{step.title}</h3>
            <p>{step.body}</p>
          </article>)}
        </div>
      </section>

      <section className="landing-workflows" id="use-cases" data-reveal>
        <div className="landing-workflows-heading">
          <span className="landing-eyebrow">Primary use cases</span>
          <h2>Payroll and invoices<br /><em>in one place.</em></h2>
          <p>Give your team a clear way to prepare, make, and follow business payments.</p>
        </div>
        <div className="workflow-grid" data-reveal-stagger>
          <article><span>01</span><strong>Payroll</strong><p>Prepare team payouts together and let each person choose an available option.</p></article>
          <article><span>02</span><strong>Invoicing</strong><p>Create and follow one-off or recurring invoices for your suppliers.</p></article>
        </div>
      </section>

      <section className="landing-dark-break" id="product" data-reveal>
        <div>
          <span className="landing-eyebrow">Supported payout options</span>
          <h2>Pay in BCH or PUSD.<br /><em>They choose where it lands.</em></h2>
          <p>{networkMode === "mainnet" ? "Mainnet payments use BCH or PUSD. Recipients can receive BCH, CashTokens, or USDC on Arc Mainnet." : "Testnet recipients can receive BCH, CashTokens, XLM or USDC on Stellar, USDC or ETH on Base Sepolia, and USDC on Arc Testnet."}</p>
          <button className="landing-primary" onClick={enterApp}>Create your workspace</button>
        </div>
        <div className="control-cards">
          <div><span className="control-label">PAYMENT SOURCES</span><strong>BCH or PUSD</strong><span>Choose what your business holds.</span></div>
          <div><span className="control-label">BITCOIN CASH PAYOUTS</span><strong>BCH and CashTokens</strong><span>Recipients select a supported asset.</span></div>
          <div><span className="control-label">CROSS-CHAIN PAYOUTS</span><strong>{networkMode === "mainnet" ? "Arc Mainnet" : "Stellar, Base, or Arc"}</strong><span>{networkMode === "mainnet" ? "USDC payouts are available on Arc Mainnet." : "Testnet routes include Stellar, Base Sepolia, and Arc."}</span></div>
        </div>
      </section>

      <section className="landing-supplier-invoices" data-reveal>
        <div><span className="landing-eyebrow">For suppliers</span><h2>Send an invoice<br /><em>without an account.</em></h2><p>Send an invoice to a Voltra Finance business. They can review the details and follow it from their workspace.</p></div>
        <div className="landing-supplier-actions">
          <button className="landing-primary" onClick={() => setLocation("/submit-invoice")}>Submit an invoice</button>
          <button className="landing-secondary" onClick={() => { void navigator.clipboard.writeText(`${window.location.origin}/submit-invoice`).then(() => { setSubmitLinkCopied(true); window.setTimeout(() => setSubmitLinkCopied(false), 2200); }); }}>{submitLinkCopied ? "Link copied" : "Copy submission link"}</button>
          <small>The recipient’s email is entered after the invoice is ready to send.</small>
        </div>
      </section>

      <section className="landing-faq" id="faq" data-reveal>
        <div className="landing-section-heading compact"><span className="landing-eyebrow">Frequently asked questions</span><h2>Clear answers<br /><em>about payments.</em></h2></div>
        <div className="faq-list">
          <details open><summary>What is Voltra Finance?</summary><p>Voltra Finance helps businesses manage payroll and invoices, pay in BCH, and give staff and suppliers a choice of supported payout assets.</p></details>
          <details><summary>Do staff and suppliers need to exchange assets themselves?</summary><p>No. They choose an available payout option when setting up how they want to be paid.</p></details>
          <details><summary>Which assets and networks are supported?</summary><p>{networkMode === "mainnet" ? "Mainnet supports BCH and CashTokens on Bitcoin Cash, plus USDC on Arc Mainnet." : "Testnet options include BCH and CashTokens, XLM and USDC on Stellar, USDC and ETH on Base Sepolia, and USDC on Arc Testnet."}</p></details>
          <details><summary>Do I need a wallet?</summary><p>Create an account to manage your workspace. Connect a BCH wallet when you are ready to approve a payment.</p></details>
        </div>
      </section>

      <section className="landing-final" data-reveal>
        <div className="landing-final-orb" />
        <span className="landing-eyebrow">Payments that work for everyone</span>
        <h2>Pay with what you have.<br /><em>Deliver what they want.</em></h2>
        <p>Start with BCH. Let each recipient choose their asset.</p>
        <button className="landing-primary" onClick={enterApp}>Create your workspace</button>
      </section>
    </main>
    <footer className="landing-footer"><LandingLogo /><span>Business payments for the BCH economy.</span><div><a href="#how-it-works">How it works</a><a href="#use-cases">Use cases</a><a href="#faq">FAQ</a><button onClick={enterApp}>Create your workspace</button></div></footer>
  </div>;
}

export default Landing;

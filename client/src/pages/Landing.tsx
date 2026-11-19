import { useLocation } from "wouter";
import { goToLogin } from "@/const";
import { ArrowRight, ArrowUpRight, BarChart3, Check, ChevronDown, CircleDollarSign, LockKeyhole, Menu, MoveRight, ShieldCheck, Sparkles, WalletCards, X, Zap } from "lucide-react";
import { useState } from "react";

function LandingLogo() {
  return <a className="landing-logo" href="#top" aria-label="Volta Finance home"><span className="landing-mark"><i /><i /><i /></span><span>Volta Finance</span></a>;
}

function ProductMockup() {
  return <div className="landing-visual" aria-label="Volta Finance workspace and financial operations preview">
    <img className="landing-visual-photo" src="/images/finance-desk.svg" alt="Illustration of a business owner reviewing financial reports at a laptop" fetchPriority="high" />
    <div className="landing-visual-shade" />
    <span className="landing-photo-caption">A clearer view of business finance</span>
    <div className="visual-asset-stamp"><span className="visual-stamp-mark">₿</span><span><small>BUILT AROUND</small><strong>Bitcoin Cash</strong></span></div>
    <div className="visual-dashboard"><div className="visual-dashboard-top"><span><i /> VOLTA FINANCE WORKSPACE</span><small>Wallet not connected</small></div><div className="visual-balance"><small>VERIFIED WALLET BALANCE</small><strong>Connect to view</strong><span>Balances appear after wallet connection.</span></div><div className="visual-route"><div><small>PAYMENT ROUTE</small><strong>One workspace. Three assets.</strong></div><div className="visual-route-assets"><b>BCH</b><i /><b>PUSD</b><i /><b>MUSD</b></div></div><div className="visual-dashboard-foot"><span><ShieldCheck size={14} /> Verification-first</span><span>Invoices · Payroll · Records</span></div></div>
  </div>;
}

const features = [
  { icon: CircleDollarSign, title: "Payments that land right", body: "Request BCH, PUSD, or MUSD and let recipients receive the asset they actually need.", image: "/images/payment-routes.svg", alt: "Illustration of BCH and CashToken payment routes" },
  { icon: BarChart3, title: "A clearer operating view", body: "Bring invoices, payroll, treasury, and records into one calm financial workspace.", image: "/images/operating-finance.svg", alt: "Illustration of a financial dashboard and cashflow chart" },
  { icon: ShieldCheck, title: "Verified by design", body: "Balances, routes, and settlement states stay honest from quote to confirmation.", image: "/images/verified-ledger.svg", alt: "Illustration of verified financial records" },
];

function Landing() {
  const [, setLocation] = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [submitLinkCopied, setSubmitLinkCopied] = useState(false);
  const enterApp = () => { setMenuOpen(false); setLocation("/login?mode=signup"); };
  return <div className="landing-page" id="top">
    <header className="landing-nav"><LandingLogo /><nav className={menuOpen ? "landing-nav-open" : ""}><a href="#product" onClick={() => setMenuOpen(false)}>Product</a><a href="#how-it-works" onClick={() => setMenuOpen(false)}>How it works</a><a href="#security" onClick={() => setMenuOpen(false)}>Security</a><a href="#faq" onClick={() => setMenuOpen(false)}>FAQ</a></nav><div className="landing-nav-actions"><button className="landing-login" onClick={() => setLocation("/submit-invoice")}>Submit an invoice</button><button className="landing-login" onClick={goToLogin}>Sign in</button><button className="landing-nav-cta" onClick={enterApp}>Create account <ArrowUpRight size={14} /></button></div><button className="landing-menu" onClick={() => setMenuOpen(!menuOpen)} aria-label="Toggle navigation">{menuOpen ? <X size={20} /> : <Menu size={20} />}</button></header>

    <main>
      <section className="landing-presentation-banner" aria-label="BCH BLAZE project presentation"><div><span className="landing-eyebrow">BCH BLAZE 2026 · Project presentation</span><p>See how Volta Finance brings BCH payments and business finance into one workspace.</p></div><a href="/volta-presentation.html" target="_blank" rel="noopener noreferrer">View the presentation <ArrowUpRight size={16} /></a></section>
      <section className="landing-hero">
        <div className="landing-hero-glow" />
        <div className="landing-hero-copy-column"><div className="landing-kicker"><span><Sparkles size={13} /> Financial operations, made clearer</span></div>
        <h1>Money work,<br /><span>made more human.</span></h1>
        <p className="landing-hero-copy">Invoices, BCH payments, payroll, and financial records in one composed workspace. Connect a wallet only when you’re ready to move money.</p>
        <div className="landing-hero-actions"><button className="landing-primary" onClick={enterApp}>Explore Volta Finance <ArrowRight size={16} /></button><button className="landing-secondary" onClick={() => document.getElementById("product")?.scrollIntoView({ behavior: "smooth" })}>See how it works <MoveRight size={16} /></button></div>
        <div className="landing-proof"><span><Check size={13} /> Bitcoin Cash native</span><span><Check size={13} /> Verified settlement states</span><span><Check size={13} /> Your wallet stays yours</span></div></div>
        <ProductMockup />
      </section>

      <section className="landing-stats" aria-label="Volta Finance product principles"><div><strong>01</strong><span>One clear view<br />of your money</span></div><div><strong>02</strong><span>Payments that<br />move with intent</span></div><div><strong>03</strong><span>Control without<br />the complexity</span></div><div><strong>04</strong><span>Built for<br />Bitcoin Cash</span></div></section>

      <section className="landing-section" id="product"><div className="landing-section-heading"><span className="landing-eyebrow">One composed workspace</span><h2>Finance in focus.<br /><em>Work in motion.</em></h2><p>From the first invoice to the final record, Volta Finance brings the important money work into view.</p></div><div className="feature-grid">{features.map(({ icon: Icon, title, body, image, alt }) => <article className="feature-card" key={title}><div className="feature-image"><img src={image} alt={alt} loading="lazy" /></div><span className="feature-icon"><Icon size={19} /></span><h3>{title}</h3><p>{body}</p><a href="#how-it-works">Explore <ArrowUpRight size={14} /></a></article>)}</div></section>

      <section className="landing-dark-break" id="how-it-works"><div><span className="landing-eyebrow">Simple finance. Smart control.</span><h2>Make every financial<br /><em>decision count.</em></h2><p>Know what is happening, what needs your attention, and what is still waiting for verification.</p><button className="landing-primary" onClick={enterApp}>Explore the workspace <ArrowRight size={16} /></button></div><div className="control-cards"><div><Zap size={16} /><strong>Payment control</strong><span>Choose the asset you want to receive.</span></div><div><LockKeyhole size={16} /><strong>Wallet privacy</strong><span>Sign only when you approve.</span></div><div><BarChart3 size={16} /><strong>Financial clarity</strong><span>See the state behind every number.</span></div></div></section>

      <section className="landing-section landing-security" id="security"><div className="landing-section-heading compact"><span className="landing-eyebrow">Confidence in every transaction</span><h2>Built for a better<br /><em>financial standard.</em></h2><p>Volta Finance keeps the interface simple without hiding the details that matter.</p></div><div className="trust-grid"><div className="trust-card"><ShieldCheck size={21} /><strong>Verification-first</strong><p>No invented balances, fake confirmations, or unclear settlement states.</p></div><div className="trust-card"><WalletCards size={21} /><strong>Your wallet, your approval</strong><p>Connect with a compatible BCH wallet and keep signing in your hands.</p></div><div className="trust-card"><CircleDollarSign size={21} /><strong>One native ecosystem</strong><p>Bitcoin Cash, CashTokens, and the tools built around them.</p></div></div></section>

      <section className="landing-workflows"><div className="landing-workflows-heading"><span className="landing-eyebrow">The work behind every healthy operation</span><h2>One workspace.<br /><em>Four clear workflows.</em></h2><p>Keep the day-to-day organized while real balances and settlement wait for verified data.</p></div><div className="workflow-grid"><article><span>01</span><strong>Get paid</strong><p>Create invoices and follow each payment through verification.</p><ArrowUpRight size={16} /></article><article><span>02</span><strong>Pay your team</strong><p>Organize employee details, prepare payroll, and track payout status.</p><ArrowUpRight size={16} /></article><article><span>03</span><strong>Move with intent</strong><p>See asset routes and review the transaction before signing.</p><ArrowUpRight size={16} /></article><article><span>04</span><strong>Keep the record</strong><p>Bring payments, invoices, and workspace activity into one view.</p><ArrowUpRight size={16} /></article></div></section>

      <section className="landing-supplier-invoices"><div><span className="landing-eyebrow">For outside suppliers</span><h2>Send an invoice<br /><em>without an account.</em></h2><p>Fill in the invoice and send it to a registered Volta Finance user. They’ll receive it in their dashboard to review, then accept or decline.</p></div><div className="landing-supplier-actions"><button className="landing-primary" onClick={() => setLocation("/submit-invoice")}>Submit an invoice <ArrowRight size={16} /></button><button className="landing-secondary" onClick={() => { void navigator.clipboard.writeText(`${window.location.origin}/submit-invoice`).then(() => { setSubmitLinkCopied(true); window.setTimeout(() => setSubmitLinkCopied(false), 2200); }); }}>{submitLinkCopied ? "Link copied" : "Copy submission link"} <ArrowUpRight size={14} /></button><small>The recipient’s email is entered after the invoice is ready to send.</small></div></section>

      <section className="landing-faq" id="faq"><div className="landing-section-heading compact"><span className="landing-eyebrow">Frequently asked questions</span><h2>Good questions<br /><em>deserve clear answers.</em></h2></div><div className="faq-list"><details open><summary>What is Volta Finance? <ChevronDown size={17} /></summary><p>Volta Finance is a financial operating system for BCH-native payments, invoicing, payroll, treasury planning, and financial records.</p></details><details><summary>Do I need a wallet to use Volta Finance? <ChevronDown size={17} /></summary><p>Create an account with email and password to enter your private workspace. Connect a compatible wallet only when you need verified balances or on-chain signing.</p></details><details><summary>Which assets are supported? <ChevronDown size={17} /></summary><p>Volta Finance is built around Bitcoin Cash and CashTokens, with BCH, PUSD, and MUSD as receiving assets. Invoice values can be denominated in USDT, BCH, PUSD, or MUSD.</p></details></div></section>

      <section className="landing-final"><div className="landing-final-orb" /><span className="landing-eyebrow">Build financial growth you can trust</span><h2>Move with more<br /><em>clarity.</em></h2><p>Start with a better view of your money.</p><button className="landing-primary" onClick={enterApp}>Open Volta Finance <ArrowRight size={16} /></button></section>
    </main>
    <footer className="landing-footer"><LandingLogo /><span>Financial operations for the BCH economy.</span><div><a href="#product">Product</a><a href="#security">Security</a><a href="#faq">FAQ</a><button onClick={enterApp}>Workspace</button></div></footer>
  </div>;
}

export default Landing;

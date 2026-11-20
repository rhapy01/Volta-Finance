import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useLocation } from "wouter";
import { ArrowLeft, ArrowRight, CircleAlert, LockKeyhole } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { toast } from "sonner";

function safeNextPath() {
  const value = new URLSearchParams(window.location.search).get("next");
  return value && value.startsWith("/") && !value.startsWith("//") && value !== "/" ? value : "/app";
}

function authErrorMessage(message: string) {
  if (message.includes("Use a password with at least 12 characters.")) return "Use a password with at least 12 characters.";
  if (message.includes("password") && (/minimum[\"']?\s*:\s*12/.test(message) || message.includes("expected string to have >=12 characters"))) {
    return "Use a password with at least 12 characters.";
  }
  return message;
}

export default function AuthPage() {
  const [, setLocation] = useLocation();
  const { isAuthenticated } = useAuth();
  const utils = trpc.useUtils();
  const authParams = new URLSearchParams(window.location.search);
  const inviteToken = authParams.get("invite");
  const resetToken = authParams.get("token") || "";
  const inviteAttempted = useRef(false);
  const [mode, setMode] = useState<"signin" | "signup">(() => new URLSearchParams(window.location.search).get("mode") === "signup" ? "signup" : "signin");
  const [authView, setAuthView] = useState<"account" | "forgot" | "reset">(() => authParams.get("mode") === "reset" ? (resetToken ? "reset" : "forgot") : "account");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");

  const acceptInvite = trpc.organization.acceptInvite.useMutation({ onSuccess: async () => { await utils.invalidate(); toast.success("You joined the organization"); setLocation("/app"); }, onError: (error) => setError(error.message) });
  const onSuccess = (user: { id: number; email: string; name: string | null; role: "user" | "admin"; createdAt: Date }) => {
    setError("");
    utils.auth.me.setData(undefined, user);
    if (inviteToken && !inviteAttempted.current) { inviteAttempted.current = true; acceptInvite.mutate({ token: inviteToken }); return; }
    setLocation(safeNextPath());
  };
  const signIn = trpc.auth.signIn.useMutation({ onSuccess, onError: (e) => setError(e.message) });
  const signUp = trpc.auth.signUp.useMutation({ onSuccess, onError: (e) => setError(authErrorMessage(e.message)) });
  const requestReset = trpc.auth.requestPasswordReset.useMutation();
  const resetPassword = trpc.auth.resetPassword.useMutation({
    onSuccess: () => {
      setError("");
      setAuthView("account");
      setMode("signin");
      setNewPassword("");
      setConfirmPassword("");
      window.history.replaceState({}, "", "/login");
      setLocation("/login");
      toast.success("Your password has been changed. Sign in with your new password.");
    },
    onError: (e) => setError(e.message),
  });

  useEffect(() => {
    if (authView !== "account") return;
    if (!isAuthenticated) return;
    if (inviteToken && !inviteAttempted.current) { inviteAttempted.current = true; acceptInvite.mutate({ token: inviteToken }); return; }
    if (!inviteToken) setLocation(safeNextPath());
  }, [isAuthenticated, setLocation, inviteToken, authView]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setError("");
    if (mode === "signup" && password.length < 12) { setError("Use a password with at least 12 characters."); return; }
    if (mode === "signup") signUp.mutate({ name: name.trim() || undefined, email, password });
    else signIn.mutate({ email, password });
  };
  const submitResetRequest = (event: FormEvent) => {
    event.preventDefault();
    setError("");
    requestReset.mutate({ email });
  };
  const submitNewPassword = (event: FormEvent) => {
    event.preventDefault();
    setError("");
    if (newPassword !== confirmPassword) { setError("The passwords do not match."); return; }
    resetPassword.mutate({ token: resetToken, password: newPassword });
  };
  const pending = signIn.isPending || signUp.isPending || acceptInvite.isPending || requestReset.isPending || resetPassword.isPending;

  const openResetRequest = () => { setError(""); requestReset.reset(); setAuthView("forgot"); };
  const backToSignIn = () => { setError(""); setAuthView("account"); setMode("signin"); window.history.replaceState({}, "", "/login"); setLocation("/login"); };

  return <main className="auth-page">
    <div className="auth-layout">
      <section className="auth-story" aria-labelledby="auth-story-title">
        <Link className="auth-brand" href="/"><img src="/voltralogo.png" alt="" /><span>Voltra Finance</span></Link>
        <span className="auth-story-eyebrow">BUSINESS PAYMENTS, MADE EASIER</span>
        <h1 id="auth-story-title">Pay in BCH.<br /><em>They choose how to receive it.</em></h1>
        <p className="auth-story-copy">Run payroll, pay suppliers, and manage invoices from one workspace. Each recipient can choose a supported payout option that works for them.</p>
        <div className="auth-story-preview">
          <img src="/images/payroll-payout-detail.png" alt="Completed Voltra payroll showing recipient payouts verified across supported assets" />
          <span>One completed payroll. Multiple payout choices.</span>
        </div>
        <div className="auth-story-points"><span>Payroll for your team</span><span>Invoices for your suppliers</span><span>Flexible recipient payouts</span></div>
        <Link className="auth-story-back" href="/"><ArrowLeft size={14} /> Back to Voltra Finance</Link>
      </section>
      <section className="auth-card" aria-labelledby="auth-form-title">
        <span className="landing-eyebrow">{inviteToken ? "WORKSPACE INVITATION" : mode === "signup" ? "GET STARTED" : "YOUR WORKSPACE"}</span>
        <h2 id="auth-form-title">{authView === "forgot" ? "Forgot your password?" : authView === "reset" ? "Choose a new password" : inviteToken ? "Join your organization" : mode === "signup" ? "Create your account" : "Welcome back"}</h2>
        <p>{authView === "forgot" ? "Enter the email address for your Voltra account. We’ll send a password reset link if an account matches." : authView === "reset" ? "Choose a new password for your Voltra Finance account." : inviteToken ? "Sign in or create an account using the email address that received the invitation." : mode === "signup" ? "Create an account to set up your Voltra workspace." : "Sign in to continue to your Voltra workspace."}</p>
        {authView === "forgot" ? requestReset.isSuccess ? <div className="auth-reset-success"><span>Check your email</span><p>If an account matches <strong>{email}</strong>, we’ve sent a password reset link. It expires in 30 minutes.</p><button type="button" onClick={backToSignIn}>Back to sign in</button></div> : <form onSubmit={submitResetRequest} className="auth-form">
          <label>Email <input type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} maxLength={320} placeholder="you@example.com" /></label>
          {error && <div className="auth-error"><CircleAlert size={15} />{error}</div>}
          <button className="landing-primary auth-submit" type="submit" disabled={pending}>{pending ? "Sending link…" : "Send password reset link"}</button>
          <button className="auth-inline-link" type="button" onClick={backToSignIn}>Back to sign in</button>
        </form> : authView === "reset" ? <form onSubmit={submitNewPassword} className="auth-form">
          <label>New password <input type="password" autoComplete="new-password" required value={newPassword} onChange={(event) => setNewPassword(event.target.value)} minLength={12} maxLength={128} placeholder="At least 12 characters" /><small className="auth-field-hint">Use at least 12 characters.</small></label>
          <label>Confirm new password <input type="password" autoComplete="new-password" required value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} minLength={12} maxLength={128} placeholder="Enter the new password again" /></label>
          {error && <div className="auth-error"><CircleAlert size={15} />{error}</div>}
          <button className="landing-primary auth-submit" type="submit" disabled={pending}>{pending ? "Saving password…" : "Save new password"}</button>
          <button className="auth-inline-link" type="button" onClick={backToSignIn}>Back to sign in</button>
        </form> : <>
          <form onSubmit={submit} className="auth-form">
            {mode === "signup" && <label>Name <input autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} maxLength={120} placeholder="Your name" /></label>}
            <label>Email <input type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} maxLength={320} placeholder="you@example.com" /></label>
            <label>Password <input type="password" autoComplete={mode === "signup" ? "new-password" : "current-password"} required value={password} onChange={(event) => setPassword(event.target.value)} minLength={mode === "signup" ? 12 : 1} maxLength={128} placeholder={mode === "signup" ? "At least 12 characters" : "Your password"} />{mode === "signup" && <small className="auth-field-hint">Use at least 12 characters.</small>}</label>
            {mode === "signin" && <button className="auth-inline-link auth-forgot-link" type="button" onClick={openResetRequest}>Forgot your password?</button>}
            {error && <div className="auth-error"><CircleAlert size={15} />{error}</div>}
            <button className="landing-primary auth-submit" type="submit" disabled={pending}>{mode === "signup" ? "Create account" : "Sign in"} {pending ? <span className="auth-spinner" /> : <ArrowRight size={16} />}</button>
          </form>
          <div className="auth-security"><LockKeyhole size={15} /> Passwords are protected with a one-way password hash. Wallet keys remain in your wallet.</div>
          <button className="auth-switch" type="button" onClick={() => { setMode(mode === "signup" ? "signin" : "signup"); setError(""); }}>{mode === "signup" ? "Already have an account? Sign in" : "New to Voltra Finance? Create an account"}</button>
        </>}
      </section>
    </div>
  </main>;
}

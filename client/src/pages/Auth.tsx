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
  const inviteToken = new URLSearchParams(window.location.search).get("invite");
  const inviteAttempted = useRef(false);
  const [mode, setMode] = useState<"signin" | "signup">(() => new URLSearchParams(window.location.search).get("mode") === "signup" ? "signup" : "signin");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
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

  useEffect(() => {
    if (!isAuthenticated) return;
    if (inviteToken && !inviteAttempted.current) { inviteAttempted.current = true; acceptInvite.mutate({ token: inviteToken }); return; }
    if (!inviteToken) setLocation(safeNextPath());
  }, [isAuthenticated, setLocation, inviteToken]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setError("");
    if (mode === "signup" && password.length < 12) { setError("Use a password with at least 12 characters."); return; }
    if (mode === "signup") signUp.mutate({ name: name.trim() || undefined, email, password });
    else signIn.mutate({ email, password });
  };
  const pending = signIn.isPending || signUp.isPending || acceptInvite.isPending;

  return <main className="auth-page"><a className="auth-back" href="/"><ArrowLeft size={15} /> Back to Volta Finance</a><section className="auth-card"><div className="auth-brand"><span className="landing-mark"><i /><i /><i /></span><span>Volta Finance</span></div><span className="landing-eyebrow">Your BCH financial workspace</span><h1>{inviteToken ? "Join your organization" : mode === "signup" ? "Create your account" : "Welcome back"}</h1><p>{inviteToken ? "Sign in or create an account using the email address that received the invitation." : mode === "signup" ? "Use your email and password to set up your workspace. Connect wallets after you sign in." : "Sign in to continue to your workspace."}</p>
    <form onSubmit={submit} className="auth-form">
      {mode === "signup" && <label>Name <input autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} maxLength={120} placeholder="Your name" /></label>}
      <label>Email <input type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} maxLength={320} placeholder="you@example.com" /></label>
      <label>Password <input type="password" autoComplete={mode === "signup" ? "new-password" : "current-password"} required value={password} onChange={(event) => setPassword(event.target.value)} minLength={mode === "signup" ? 12 : 1} maxLength={128} placeholder={mode === "signup" ? "At least 12 characters" : "Your password"} />{mode === "signup" && <small className="auth-field-hint">Use at least 12 characters.</small>}</label>
      {error && <div className="auth-error"><CircleAlert size={15} />{error}</div>}
      <button className="landing-primary auth-submit" type="submit" disabled={pending}>{mode === "signup" ? "Create account" : "Sign in"} {pending ? <span className="auth-spinner" /> : <ArrowRight size={16} />}</button>
    </form>
    <div className="auth-security"><LockKeyhole size={15} /> Passwords are protected with a one-way password hash. Wallet keys remain in your wallet.</div>
    <button className="auth-switch" type="button" onClick={() => { setMode(mode === "signup" ? "signin" : "signup"); setError(""); }}>{mode === "signup" ? "Already have an account? Sign in" : "New to Volta Finance? Create an account"}</button>
  </section></main>;
}

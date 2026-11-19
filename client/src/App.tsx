import { lazy, Suspense } from "react";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";

const NotFound = lazy(() => import("@/pages/NotFound"));
const Home = lazy(() => import("@/pages/Home"));
const Landing = lazy(() => import("@/pages/Landing"));
const AuthPage = lazy(() => import("@/pages/Auth"));
const SubmitInvoice = lazy(() => import("@/pages/SubmitInvoice"));

function Router() {
  return (
    <Suspense fallback={<main className="grid min-h-screen place-items-center bg-[#f7f7f4] text-slate-600">Loading Volta Finance…</main>}>
      <Switch>
        <Route path="/" component={Landing} />
        <Route path="/login" component={AuthPage} />
        <Route path="/submit-invoice" component={SubmitInvoice} />
        <Route path="/app" component={Home} />
        <Route path="/payments" component={Home} />
        <Route path="/payroll" component={Home} />
        <Route path="/treasury" component={Home} />
        <Route path="/local-currency" component={Home} />
        <Route path="/records" component={Home} />
        <Route path="/settings" component={Home} />
        <Route path="/404" component={NotFound} />
        <Route component={NotFound} />
      </Switch>
    </Suspense>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="light">
        <TooltipProvider>
          <Toaster />
          <Router />
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;

import { Component, Suspense, lazy, useEffect, useState } from "react";

const StarMap = lazy(() => import("./GlobalStarMapBackground"));

class BackgroundBoundary extends Component {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

export default function DeferredStarMapBackground() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    // Decorative WebGL must never block the login form or compete with its
    // resources on a narrow connection. Keep a CSS background in the meantime.
    if (matchMedia("(prefers-reduced-motion: reduce)").matches || navigator.connection?.saveData) return;
    let timer;
    let idle;
    const schedule = () => {
      timer = setTimeout(() => {
        if (window.requestIdleCallback) {
          idle = requestIdleCallback(() => setReady(true), { timeout: 5000 });
        } else {
          setReady(true);
        }
      }, 3000);
    };
    if (document.readyState === "complete") schedule();
    else window.addEventListener("load", schedule, { once: true });
    return () => {
      window.removeEventListener("load", schedule);
      clearTimeout(timer);
      if (idle !== undefined) cancelIdleCallback(idle);
    };
  }, []);

  return (
    <>
      <div aria-hidden="true" style={{ position: "fixed", inset: 0, zIndex: -1, pointerEvents: "none", background: "radial-gradient(circle at 50% 50%, #0c0812 0%, #030305 60%, #000 100%)" }} />
      <BackgroundBoundary>
        <Suspense fallback={null}>{ready ? <StarMap /> : null}</Suspense>
      </BackgroundBoundary>
    </>
  );
}

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { ToastProvider, ToastHost } from "../toast-provider";
import { useUIStore, clearToastDeduplication } from "@/stores/ui-store";

// ── Helpers ──────────────────────────────────────────────────────────────────

function resetStore() {
  // Clear dedup map so cross-test identical toasts are never silently dropped
  clearToastDeduplication();
  useUIStore.setState({
    theme: "system",
    density: "comfortable",
    fontSize: "medium",
    sidebarOpen: false,
    commandPaletteOpen: false,
    toasts: [],
  });
}

/** A minimal stand-in for a Next.js page component. */
function PageA() {
  return <div data-testid="page-a">Page A</div>;
}
function PageB() {
  return <div data-testid="page-b">Page B</div>;
}

function getToastHost() {
  return document.querySelector("[data-testid='toast-host']");
}

function getAlerts() {
  return document.querySelectorAll("[data-testid='toast-host'] [role='alert']");
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("ToastProvider / ToastHost", () => {
  beforeEach(() => {
    // Reset store BEFORE enabling fake timers so the Zustand persist
    // middleware's localStorage.setItem runs against the real storage API.
    resetStore();
    vi.useFakeTimers();
  });

  afterEach(() => {
    // Only flush pending timers if fake timers are still active (guards against
    // a test that already called useRealTimers).
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  // ── Rendering ───────────────────────────────────────────────────────────────

  it("renders children", () => {
    render(
      <ToastProvider>
        <div data-testid="child">hello</div>
      </ToastProvider>
    );
    expect(screen.getByTestId("child")).toBeDefined();
  });

  it("renders the toast host in the document after mount", () => {
    render(
      <ToastProvider>
        <div />
      </ToastProvider>
    );
    // ToastHost portals into document.body — query the document, not the container
    expect(getToastHost()).not.toBeNull();
  });

  it("shows a toast once addToast is called", () => {
    render(
      <ToastProvider>
        <div />
      </ToastProvider>
    );

    act(() => {
      useUIStore.getState().addToast({ type: "success", title: "Saved!" });
    });

    expect(getToastHost()?.textContent).toContain("Saved!");
  });

  // ── Persistence across route changes ────────────────────────────────────────

  it("toasts persist when the page child is replaced (simulated route change)", () => {
    const { rerender } = render(
      <ToastProvider>
        <PageA />
      </ToastProvider>
    );

    // Add a toast while on Page A
    act(() => {
      useUIStore.getState().addToast({ type: "info", title: "Navigation toast" });
    });

    // Simulate a route change by swapping the child — this is what Next.js does
    // on soft navigation: the root layout stays mounted but the page slot rerenders
    rerender(
      <ToastProvider>
        <PageB />
      </ToastProvider>
    );

    // Page B is now rendered
    expect(screen.getByTestId("page-b")).toBeDefined();

    // The toast must still be visible — it should NOT have vanished
    expect(getToastHost()?.textContent).toContain("Navigation toast");
  });

  it("toast added on Page A is still present after navigating to Page B before its duration expires", () => {
    const { rerender } = render(
      <ToastProvider>
        <PageA />
      </ToastProvider>
    );

    act(() => {
      useUIStore.getState().addToast({
        type: "success",
        title: "Transfer confirmed",
        duration: 8000,
      });
    });

    // Advance time partially (2s of the 8s duration)
    act(() => {
      vi.advanceTimersByTime(2000);
    });

    // Route change
    rerender(
      <ToastProvider>
        <PageB />
      </ToastProvider>
    );

    // Toast should still be there — 6s remain on its timer
    expect(getToastHost()?.textContent).toContain("Transfer confirmed");

    // Advance remaining time — now it should auto-dismiss
    act(() => {
      vi.advanceTimersByTime(7000);
    });

    expect(getAlerts().length).toBe(0);
  });

  /**
   * KEY REGRESSION — the actual failure mode.
   *
   * The original bug: ToastProvider interleaved {children} with the portal
   * inside one component. A route change could destroy the mounted portal and
   * its in-flight toast stack in the same React commit that mounted the new
   * page. The symptom was a toast raised *during* navigation being lost
   * immediately after it appeared.
   *
   * This test triggers addToast() *synchronously inside the rerender call*
   * (i.e. the store update and the tree swap happen in the same batch), which
   * reproduces the exact commit ordering that caused the original loss.
   */
  it("toast raised during navigation (same React batch as route change) survives", () => {
    const { rerender } = render(
      <ToastProvider>
        <PageA />
      </ToastProvider>
    );

    // Raise the toast and swap the page child in the same act() — one React commit.
    act(() => {
      useUIStore.getState().addToast({
        type: "error",
        title: "Transaction failed",
        duration: 5000,
      });
      rerender(
        <ToastProvider>
          <PageB />
        </ToastProvider>
      );
    });

    // Page B must be mounted
    expect(screen.getByTestId("page-b")).toBeDefined();

    // The toast raised during the navigation commit must still be visible
    expect(getToastHost()?.textContent).toContain("Transaction failed");
    expect(getAlerts().length).toBe(1);
  });

  /**
   * Hard-refresh scenario: the entire app-shell tree mounts fresh.
   *
   * After a hard refresh the root layout re-executes and every provider
   * mounts from scratch, including ToastHost. Verify it renders correctly
   * on that first mount (i.e. setMounted(true) fires and the portal appears)
   * and that toasts added immediately after are visible.
   */
  it("host renders and accepts toasts on a fresh mount (hard refresh)", () => {
    // Mount only ToastHost, simulating the app shell mounting from scratch
    render(<ToastHost />);

    // Host itself should be present in the document
    expect(getToastHost()).not.toBeNull();

    // Add a toast — it should appear immediately on this fresh mount
    act(() => {
      useUIStore.getState().addToast({ type: "info", title: "Welcome back" });
    });

    expect(getToastHost()?.textContent).toContain("Welcome back");
  });

  // ── No duplicate hosts ───────────────────────────────────────────────────────

  it("only one toast host exists in the document at any time", () => {
    const { rerender } = render(
      <ToastProvider>
        <PageA />
      </ToastProvider>
    );

    rerender(
      <ToastProvider>
        <PageB />
      </ToastProvider>
    );

    rerender(
      <ToastProvider>
        <PageA />
      </ToastProvider>
    );

    const hosts = document.querySelectorAll("[data-testid='toast-host']");
    expect(hosts.length).toBe(1);
  });

  it("only one toast host exists when ToastHost is rendered directly multiple times in sequence", () => {
    const { rerender } = render(<ToastHost />);
    rerender(<ToastHost />);
    rerender(<ToastHost />);

    const hosts = document.querySelectorAll("[data-testid='toast-host']");
    expect(hosts.length).toBe(1);
  });

  // ── Dismiss ──────────────────────────────────────────────────────────────────

  it("dismiss button removes the toast from the host", async () => {
    render(
      <ToastProvider>
        <div />
      </ToastProvider>
    );

    act(() => {
      useUIStore.getState().addToast({ type: "error", title: "Oops" });
    });

    const dismissBtn = document.querySelector(
      "[data-testid='toast-host'] button[aria-label='Dismiss notification']"
    ) as HTMLButtonElement;
    expect(dismissBtn).not.toBeNull();

    // Use act + click() directly — userEvent.setup with fake timers can deadlock
    // when pointer-event delays aren't resolved by advanceTimers alone.
    act(() => {
      dismissBtn.click();
    });

    expect(getAlerts().length).toBe(0);
    expect(useUIStore.getState().toasts).toHaveLength(0);
  });

  // ── Auto-dismiss ─────────────────────────────────────────────────────────────

  it("toasts auto-dismiss after their duration", () => {
    render(
      <ToastProvider>
        <div />
      </ToastProvider>
    );

    act(() => {
      useUIStore.getState().addToast({ type: "success", title: "Quick", duration: 3000 });
    });

    expect(getToastHost()?.textContent).toContain("Quick");

    act(() => {
      vi.advanceTimersByTime(3500);
    });

    expect(getAlerts().length).toBe(0);
  });

  // ── Accessibility ─────────────────────────────────────────────────────────────

  it("error toasts are in an assertive live region for immediate screen-reader announcement", () => {
    render(
      <ToastProvider>
        <div />
      </ToastProvider>
    );

    act(() => {
      useUIStore.getState().addToast({ type: "error", title: "Auth failure" });
    });

    // The error toast must be inside an aria-live="assertive" container
    const assertiveRegion = document.querySelector(
      "[data-testid='toast-host'] [aria-live='assertive']"
    );
    expect(assertiveRegion).not.toBeNull();
    expect(assertiveRegion?.textContent).toContain("Auth failure");
  });

  it("non-error toasts are in a polite live region", () => {
    render(
      <ToastProvider>
        <div />
      </ToastProvider>
    );

    act(() => {
      useUIStore.getState().addToast({ type: "success", title: "Saved" });
    });

    const politeRegion = document.querySelector(
      "[data-testid='toast-host'] [aria-live='polite']"
    );
    expect(politeRegion).not.toBeNull();
    expect(politeRegion?.textContent).toContain("Saved");
  });

  it("error toasts do NOT appear in the polite region", () => {
    render(
      <ToastProvider>
        <div />
      </ToastProvider>
    );

    act(() => {
      useUIStore.getState().addToast({ type: "error", title: "Tx rejected" });
    });

    const politeRegion = document.querySelector(
      "[data-testid='toast-host'] [aria-live='polite']"
    );
    // The polite region must be empty — the error lives in the assertive region
    expect(politeRegion?.querySelectorAll("[role='alert']").length).toBe(0);
  });

  it("individual toasts have role alert", () => {
    render(
      <ToastProvider>
        <div />
      </ToastProvider>
    );

    act(() => {
      useUIStore.getState().addToast({ type: "warning", title: "Heads up" });
    });

    expect(getAlerts().length).toBe(1);
  });
});

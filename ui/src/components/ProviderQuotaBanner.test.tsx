// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { ProviderQuotaBanner } from "./ProviderQuotaBanner";
import type { HealthStatus } from "../api/health";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
  }
  root = null;
  container?.remove();
  container = null;
});

function render(providerQuota: HealthStatus["providerQuota"]) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<ProviderQuotaBanner providerQuota={providerQuota} />));
  return container;
}

describe("ProviderQuotaBanner", () => {
  it("renders nothing when providerQuota is undefined", () => {
    const node = render(undefined);
    expect(node.textContent).toBe("");
  });

  it("renders nothing when every window is below the warning threshold", () => {
    const node = render({
      fetchedAt: "2026-07-31T12:00:00.000Z",
      results: [
        {
          provider: "anthropic",
          ok: true,
          windows: [{ label: "5h", usedPercent: 42, resetsAt: null, valueLabel: null }],
        },
      ],
    });
    expect(node.textContent).toBe("");
  });

  it("ignores windows from providers that failed to report", () => {
    const node = render({
      fetchedAt: "2026-07-31T12:00:00.000Z",
      results: [
        {
          provider: "anthropic",
          ok: false,
          error: "quota polling timed out after 20s",
          windows: [{ label: "5h", usedPercent: 99, resetsAt: null, valueLabel: null }],
        },
      ],
    });
    expect(node.textContent).toBe("");
  });

  it("names the provider, window, percent used, and reset time once a window hits the warning threshold", () => {
    const node = render({
      fetchedAt: "2026-07-31T12:00:00.000Z",
      results: [
        {
          provider: "anthropic",
          ok: true,
          windows: [{ label: "7d", usedPercent: 95, resetsAt: "2026-08-03T14:00:00.000Z", valueLabel: null }],
        },
      ],
    });

    expect(node.textContent).toContain("Shared quota at cap");
    expect(node.textContent).toContain("Anthropic");
    expect(node.textContent).toContain("7d");
    expect(node.textContent).toContain("95% used");
    expect(node.textContent).toContain("expect stalls until");
  });

  it("surfaces the highest-usage window first and counts additional windows at/above threshold", () => {
    const node = render({
      fetchedAt: "2026-07-31T12:00:00.000Z",
      results: [
        {
          provider: "anthropic",
          ok: true,
          windows: [
            { label: "5h", usedPercent: 91, resetsAt: null, valueLabel: null },
            { label: "7d", usedPercent: 98, resetsAt: null, valueLabel: null },
          ],
        },
      ],
    });

    expect(node.textContent).toContain("7d");
    expect(node.textContent).toContain("98% used");
    expect(node.textContent).toContain("+1 more window near cap");
  });

  it("omits the reset clause when no reset time is reported", () => {
    const node = render({
      fetchedAt: "2026-07-31T12:00:00.000Z",
      results: [
        {
          provider: "openai",
          ok: true,
          windows: [{ label: "5h", usedPercent: 90, resetsAt: null, valueLabel: null }],
        },
      ],
    });

    expect(node.textContent).toContain("90% used");
    expect(node.textContent).not.toContain("expect stalls until");
  });
});

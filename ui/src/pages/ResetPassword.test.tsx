// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ResetPasswordPage } from "./ResetPassword";

const mockAuthApi = vi.hoisted(() => ({
  resetPassword: vi.fn(),
}));

vi.mock("../api/auth", () => ({
  authApi: mockAuthApi,
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompany: null,
    selectedCompanyId: null,
    companies: [],
    selectionSource: "manual",
    loading: false,
    error: null,
    setSelectedCompanyId: vi.fn(),
    reloadCompanies: vi.fn(),
    createCompany: vi.fn(),
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function setValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("ResetPasswordPage", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("shows an invalid-link message when the URL has no token", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={["/reset-password"]}>
          <QueryClientProvider client={queryClient}>
            <Routes>
              <Route path="/reset-password" element={<ResetPasswordPage />} />
            </Routes>
          </QueryClientProvider>
        </MemoryRouter>,
      );
    });
    await flushReact();

    expect(container.textContent).toContain("Invalid reset link");
    expect(mockAuthApi.resetPassword).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
  });

  it("submits the token from the query string with the new password", async () => {
    mockAuthApi.resetPassword.mockResolvedValue(undefined);
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={["/reset-password?token=tok_abc123"]}>
          <QueryClientProvider client={queryClient}>
            <Routes>
              <Route path="/reset-password" element={<ResetPasswordPage />} />
            </Routes>
          </QueryClientProvider>
        </MemoryRouter>,
      );
    });
    await flushReact();

    const newPasswordInput = container.querySelector("#new-password") as HTMLInputElement | null;
    const confirmPasswordInput = container.querySelector("#confirm-password") as HTMLInputElement | null;
    expect(newPasswordInput).not.toBeNull();
    expect(confirmPasswordInput).not.toBeNull();

    await act(async () => {
      setValue(newPasswordInput as HTMLInputElement, "brand-new-password");
      setValue(confirmPasswordInput as HTMLInputElement, "brand-new-password");
    });

    const form = newPasswordInput?.closest("form");
    await act(async () => {
      form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await flushReact();
    await flushReact();

    expect(mockAuthApi.resetPassword).toHaveBeenCalledWith({
      newPassword: "brand-new-password",
      token: "tok_abc123",
    });
    expect(container.textContent).toContain("Password updated");

    await act(async () => {
      root.unmount();
    });
  });
});

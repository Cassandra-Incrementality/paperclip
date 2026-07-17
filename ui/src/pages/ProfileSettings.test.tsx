// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProfileSettings } from "./ProfileSettings";

const mockAuthApi = vi.hoisted(() => ({
  getSession: vi.fn(),
  signInEmail: vi.fn(),
  signUpEmail: vi.fn(),
  getProfile: vi.fn(),
  updateProfile: vi.fn(),
  changePassword: vi.fn(),
  signOut: vi.fn(),
}));

const mockAssetsApi = vi.hoisted(() => ({
  uploadImage: vi.fn(),
  uploadCompanyLogo: vi.fn(),
}));

const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());

vi.mock("@/api/auth", () => ({
  authApi: mockAuthApi,
}));

vi.mock("@/api/assets", () => ({
  assetsApi: mockAssetsApi,
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({
    setBreadcrumbs: mockSetBreadcrumbs,
  }),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: { id: "company-1", name: "Paperclip", issuePrefix: "PAP" },
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

describe("ProfileSettings", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);

    mockAuthApi.getSession.mockResolvedValue({
      session: { id: "session-1", userId: "user-1" },
      user: {
        id: "user-1",
        name: "Jane Example",
        email: "jane@example.com",
        image: "https://example.com/jane.png",
      },
    });
    mockAssetsApi.uploadImage.mockResolvedValue({
      assetId: "asset-1",
      contentPath: "/api/assets/asset-1/content",
    });
    mockAuthApi.updateProfile.mockImplementation(async (input: { name: string; image: string | null }) => ({
      id: "user-1",
      name: input.name,
      email: "jane@example.com",
      image: input.image,
    }));
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("uploads a clicked avatar into Paperclip storage and persists the returned asset path", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ProfileSettings />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).not.toContain("Avatar image URL");

    const avatarInput = container.querySelector('input[type="file"]') as HTMLInputElement | null;
    expect(avatarInput).not.toBeNull();

    const file = new File(["avatar"], "avatar.png", { type: "image/png" });
    Object.defineProperty(avatarInput, "files", {
      configurable: true,
      value: [file],
    });

    await act(async () => {
      avatarInput?.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flushReact();
    await flushReact();

    expect(mockAssetsApi.uploadImage).toHaveBeenCalledWith("company-1", file, "profiles/user-1");
    expect(mockAuthApi.updateProfile).toHaveBeenCalledWith({
      name: "Jane Example",
      image: "/api/assets/asset-1/content",
    });

    await act(async () => {
      root.unmount();
    });
  });

  it("changes the password via the already-live change-password endpoint", async () => {
    mockAuthApi.changePassword.mockResolvedValue(undefined);

    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ProfileSettings />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    const currentPasswordInput = container.querySelector("#current-password") as HTMLInputElement | null;
    const newPasswordInput = container.querySelector("#new-password") as HTMLInputElement | null;
    const confirmPasswordInput = container.querySelector("#confirm-new-password") as HTMLInputElement | null;
    expect(currentPasswordInput).not.toBeNull();
    expect(newPasswordInput).not.toBeNull();
    expect(confirmPasswordInput).not.toBeNull();

    function setValue(input: HTMLInputElement, value: string) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }

    await act(async () => {
      setValue(currentPasswordInput as HTMLInputElement, "old-password-123");
      setValue(newPasswordInput as HTMLInputElement, "new-password-456");
      setValue(confirmPasswordInput as HTMLInputElement, "new-password-456");
    });

    const passwordForm = currentPasswordInput?.closest("form");
    expect(passwordForm).not.toBeNull();

    await act(async () => {
      passwordForm?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await flushReact();
    await flushReact();

    expect(mockAuthApi.changePassword).toHaveBeenCalledWith({
      currentPassword: "old-password-123",
      newPassword: "new-password-456",
    });
    expect(container.textContent).toContain("Password changed.");

    await act(async () => {
      root.unmount();
    });
  });
});

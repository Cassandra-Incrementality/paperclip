import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Link, useSearchParams } from "@/lib/router";
import { authApi } from "../api/auth";
import { Button } from "@/components/ui/button";

export function ResetPasswordPage() {
  const [searchParams] = useSearchParams();
  const token = (searchParams.get("token") ?? "").trim();
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  const resetMutation = useMutation({
    mutationFn: () => authApi.resetPassword({ newPassword, token }),
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Couldn't reset your password");
    },
  });

  const canSubmit = newPassword.length >= 8 && newPassword === confirmPassword;

  if (!token) {
    return (
      <div className="mx-auto max-w-xl py-10">
        <div className="rounded-lg border border-border bg-card p-6">
          <h1 className="text-lg font-semibold">Invalid reset link</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            This link is missing or malformed. Request a new one from the sign-in page.
          </p>
          <Button asChild className="mt-4">
            <Link to="/auth">Back to sign in</Link>
          </Button>
        </div>
      </div>
    );
  }

  if (resetMutation.isSuccess) {
    return (
      <div className="mx-auto max-w-xl py-10">
        <div className="rounded-lg border border-border bg-card p-6">
          <h1 className="text-lg font-semibold">Password updated</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Your password has been reset. Sign in with your new password.
          </p>
          <Button asChild className="mt-4">
            <Link to="/auth">Sign in</Link>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-xl py-10">
      <div className="rounded-lg border border-border bg-card p-6">
        <h1 className="text-lg font-semibold">Set a new password</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Choose a new password for your account. This link expires one hour after it was requested.
        </p>

        <form
          className="mt-6 space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (resetMutation.isPending) return;
            if (!canSubmit) {
              setError(
                newPassword.length < 8
                  ? "Password must be at least 8 characters."
                  : "Passwords don't match.",
              );
              return;
            }
            setError(null);
            resetMutation.mutate();
          }}
        >
          <div>
            <label htmlFor="new-password" className="text-xs text-muted-foreground mb-1 block">New password</label>
            <input
              id="new-password"
              className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
              type="password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              autoComplete="new-password"
              autoFocus
            />
          </div>
          <div>
            <label htmlFor="confirm-password" className="text-xs text-muted-foreground mb-1 block">Confirm password</label>
            <input
              id="confirm-password"
              className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
              type="password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              autoComplete="new-password"
            />
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <Button
            type="submit"
            disabled={resetMutation.isPending}
            aria-disabled={!canSubmit || resetMutation.isPending}
            className={`w-full ${!canSubmit && !resetMutation.isPending ? "opacity-50" : ""}`}
          >
            {resetMutation.isPending ? "Saving…" : "Reset password"}
          </Button>
        </form>
      </div>
    </div>
  );
}

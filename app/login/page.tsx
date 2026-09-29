"use client";

import { useSyncExternalStore, useState } from "react";
import Image from "next/image";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export default function LoginPage() {
  const router = useRouter();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const mounted = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false
  );

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setLoading(true);
    setError("");

    const formData = new FormData(e.currentTarget);
    const result = await signIn("credentials", {
      username: formData.get("username"),
      password: formData.get("password"),
      redirect: false,
    });

    if (result?.error) {
      setError("Invalid username or password");
      setLoading(false);
    } else {
      router.push("/shows");
      router.refresh();
    }
  };

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center px-6 pt-safe pb-safe">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex flex-col items-center gap-3">
          <Image
            src="/icon.svg?v=14"
            alt=""
            width={72}
            height={72}
            unoptimized
            className="rounded-[1.35rem] shadow-xl shadow-black/50"
          />
          <h1 className="text-center text-3xl font-bold">LeviOsa</h1>
        </div>
        <form onSubmit={handleSubmit} method="post" action="#" className="space-y-4">
          <Input
            name="username"
            placeholder="Username"
            required
            className="h-12 border-border bg-card text-foreground placeholder:text-muted-foreground"
          />
          <Input
            name="password"
            type="password"
            placeholder="Password"
            required
            className="h-12 border-border bg-card text-foreground placeholder:text-muted-foreground"
          />
          {error && <p className="text-sm text-red-500">{error}</p>}
          <Button
            type="submit"
            disabled={!mounted || loading}
            suppressHydrationWarning
            className="h-12 w-full bg-primary text-black hover:bg-primary/90"
          >
            {loading ? "Signing in..." : mounted ? "Sign In" : "Loading..."}
          </Button>
        </form>
      </div>
    </div>
  );
}

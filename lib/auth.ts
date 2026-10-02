import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { redirect } from "next/navigation";
import { db } from "./db";
import { users } from "./schema";
import { eq } from "drizzle-orm";

export async function requireAuth(): Promise<string> {
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/login");
  }
  return session.user.id;
}

/**
 * Session user id, or null when signed out — for pages that render publicly
 * (detail pages are crawlable/shareable; user rows are only read when a
 * session exists, so nothing personal renders for anonymous visitors).
 */
export async function optionalAuth(): Promise<string | null> {
  const session = await auth();
  return session?.user?.id ?? null;
}

export const {
  handlers: { GET, POST },
  auth,
  signIn,
  signOut,
} = NextAuth({
  // Trust host only in non-production or when explicitly enabled (tunnels/dev).
  trustHost:
    process.env.AUTH_TRUST_HOST === "true" ||
    process.env.NODE_ENV !== "production",
  providers: [
    Credentials({
      name: "credentials",
      credentials: {
        username: { label: "Username", type: "text" },
        password: { label: "Password", type: "password" },
      },
      authorize: async (credentials) => {
        const username = credentials?.username as string;
        const password = credentials?.password as string;

        if (!username || !password) return null;

        const user = await db.query.users.findFirst({
          where: eq(users.username, username),
        });

        if (!user) return null;

        const valid = await bcrypt.compare(password, user.passwordHash);
        if (!valid) return null;

        return {
          id: user.id,
          name: user.username,
        };
      },
    }),
  ],
  pages: {
    signIn: "/login",
  },
  session: {
    strategy: "jwt",
  },
  callbacks: {
    jwt: async ({ token, user }) => {
      if (user) {
        token.sub = user.id;
        // Keep username on the token so session.user.name survives refreshes
        if (user.name) token.name = user.name;
      }
      return token;
    },
    session: async ({ session, token }) => {
      if (token?.sub) {
        session.user.id = token.sub;
      }
      if (token?.name) {
        session.user.name = token.name as string;
      }
      return session;
    },
  },
});

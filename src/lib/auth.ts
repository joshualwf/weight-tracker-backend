import { NextRequest } from "next/server";
import { supabaseAdmin } from "./supabase";
import { AccountTier, SubscriptionStatus } from "@prisma/client";

export async function verifyToken(
  request: NextRequest
): Promise<{ userId: string } | { error: string; status: number }> {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return { error: "Missing authorization header", status: 401 };
  }
  const token = authHeader.slice(7);
  const {
    data: { user },
    error,
  } = await supabaseAdmin().auth.getUser(token);
  if (error || !user) {
    return { error: "Invalid or expired token", status: 401 };
  }
  return { userId: user.id };
}

export function deriveAccountTier(
  status: SubscriptionStatus,
  currentTier: AccountTier
): AccountTier {
  if (currentTier === "admin") return "admin";
  if (status === "trial" || status === "active") return "pro";
  if (status === "expired" || status === "cancelled") return "free";
  return currentTier;
}

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyToken, deriveAccountTier } from "@/lib/auth";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ appleUserId: string }> }
) {
  const auth = await verifyToken(request);
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const { appleUserId } = await params;

  const user = await prisma.weight_User.findUnique({
    where: { appleUserId },
  });

  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  // Server-side trial expiry check
  let { subscriptionStatus, accountTier } = user;
  if (
    subscriptionStatus === "trial" &&
    user.trialStartAt &&
    Date.now() > user.trialStartAt.getTime() + 7 * 24 * 60 * 60 * 1000
  ) {
    subscriptionStatus = "expired";
    accountTier = "free";
    await prisma.weight_User.update({
      where: { id: user.id },
      data: { subscriptionStatus: "expired", accountTier: "free" },
    });
  }

  return NextResponse.json({
    userId: user.id,
    email: user.email,
    accountTier,
    subscriptionStatus,
    trialStartAt: user.trialStartAt,
  });
}

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyToken } from "@/lib/auth";

export async function POST(
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

  // Idempotent — return existing trial start date if already started
  if (user.trialStartAt) {
    return NextResponse.json({
      trialStartAt: user.trialStartAt,
      subscriptionStatus: user.subscriptionStatus,
    });
  }

  const updated = await prisma.weight_User.update({
    where: { id: user.id },
    data: {
      subscriptionStatus: "trial",
      accountTier: "pro",
      trialStartAt: new Date(),
    },
  });

  return NextResponse.json({
    trialStartAt: updated.trialStartAt,
    subscriptionStatus: updated.subscriptionStatus,
  });
}

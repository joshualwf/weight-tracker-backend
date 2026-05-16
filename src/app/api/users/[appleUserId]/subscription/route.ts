import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyToken, deriveAccountTier } from "@/lib/auth";
import { SubscriptionStatus } from "@prisma/client";

const ALLOWED_STATUSES: SubscriptionStatus[] = ["expired", "active", "cancelled"];

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ appleUserId: string }> }
) {
  const auth = await verifyToken(request);
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  let body: { subscriptionStatus?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { subscriptionStatus } = body;
  if (!subscriptionStatus || !ALLOWED_STATUSES.includes(subscriptionStatus as SubscriptionStatus)) {
    return NextResponse.json(
      { error: `subscriptionStatus must be one of: ${ALLOWED_STATUSES.join(", ")}` },
      { status: 400 }
    );
  }

  const { appleUserId } = await params;

  const user = await prisma.weight_User.findUnique({
    where: { appleUserId },
  });

  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const newStatus = subscriptionStatus as SubscriptionStatus;
  const newTier = deriveAccountTier(newStatus, user.accountTier);

  const updated = await prisma.weight_User.update({
    where: { id: user.id },
    data: { subscriptionStatus: newStatus, accountTier: newTier },
  });

  return NextResponse.json({
    subscriptionStatus: updated.subscriptionStatus,
    accountTier: updated.accountTier,
  });
}

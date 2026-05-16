import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// Called by Stripe/RevenueCat after a charge or cancellation. Not called by the iOS app.
export async function POST(request: NextRequest) {
  let body: {
    event?: string;
    userId?: string;
    providerName?: string;
    providerSubId?: string;
    providerPaymentId?: string;
    amountCents?: number;
    currency?: string;
    currentPeriodStart?: string;
    currentPeriodEnd?: string;
  };

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const {
    event,
    userId,
    providerName,
    providerSubId,
    providerPaymentId,
    amountCents,
    currency = "USD",
    currentPeriodStart,
    currentPeriodEnd,
  } = body;

  if (!event || !userId) {
    return NextResponse.json({ error: "event and userId are required" }, { status: 400 });
  }

  const user = await prisma.weight_User.findUnique({ where: { id: userId } });
  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  if (event === "payment.succeeded") {
    if (!amountCents || !currentPeriodStart || !currentPeriodEnd) {
      return NextResponse.json(
        { error: "amountCents, currentPeriodStart, currentPeriodEnd required for payment.succeeded" },
        { status: 400 }
      );
    }

    const subscription = await prisma.weight_Subscription.create({
      data: {
        userId,
        status: "active",
        priceAmountCents: amountCents,
        currency,
        currentPeriodStart: new Date(currentPeriodStart),
        currentPeriodEnd: new Date(currentPeriodEnd),
        providerName: providerName ?? null,
        providerSubId: providerSubId ?? null,
      },
    });

    await prisma.weight_Payment.create({
      data: {
        userId,
        subscriptionId: subscription.id,
        amountCents,
        currency,
        status: "succeeded",
        providerName: providerName ?? null,
        providerPaymentId: providerPaymentId ?? null,
        paidAt: new Date(),
      },
    });

    await prisma.weight_User.update({
      where: { id: userId },
      data: {
        subscriptionStatus: "active",
        accountTier: user.accountTier === "admin" ? "admin" : "pro",
      },
    });

    return NextResponse.json({ received: true });
  }

  if (event === "subscription.cancelled") {
    if (!providerSubId) {
      return NextResponse.json({ error: "providerSubId required for cancellation" }, { status: 400 });
    }

    await prisma.weight_Subscription.update({
      where: { providerSubId },
      data: { cancelledAt: new Date(), status: "cancelled" },
    });

    // Keep accountTier = pro until currentPeriodEnd — the app or a scheduled
    // job should call POST /api/users/:id/subscription with "expired" after that.

    return NextResponse.json({ received: true });
  }

  return NextResponse.json({ error: `Unknown event: ${event}` }, { status: 400 });
}

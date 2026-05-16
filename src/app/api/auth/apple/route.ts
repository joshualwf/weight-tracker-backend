import { NextRequest, NextResponse } from "next/server";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { createClient } from "@supabase/supabase-js";
import { prisma } from "@/lib/prisma";
import { supabaseAdmin } from "@/lib/supabase";

const APPLE_JWKS = createRemoteJWKSet(
  new URL("https://appleid.apple.com/auth/keys")
);

export async function POST(request: NextRequest) {
  let body: {
    identityToken?: string;
    appleUserId?: string;
    email?: string;
    fullName?: string;
  };

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { identityToken, appleUserId, email, fullName } = body;

  if (!identityToken || !appleUserId) {
    return NextResponse.json(
      { error: "identityToken and appleUserId are required" },
      { status: 400 }
    );
  }

  // 1. Verify Apple identity token
  try {
    const { payload } = await jwtVerify(identityToken, APPLE_JWKS, {
      issuer: "https://appleid.apple.com",
      audience: process.env.APPLE_BUNDLE_ID,
    });
    if (payload.sub !== appleUserId) {
      return NextResponse.json(
        { error: "Invalid identity token" },
        { status: 401 }
      );
    }
  } catch {
    return NextResponse.json(
      { error: "Invalid identity token" },
      { status: 401 }
    );
  }

  // 2. Find or create user
  const admin = supabaseAdmin();
  let supabaseUserId: string;
  let isNew = false;

  // Check weight_User by appleUserId
  let weightUser = await prisma.weight_User.findUnique({
    where: { appleUserId },
  });

  if (!weightUser && email) {
    // Check weight_User by email
    weightUser = await prisma.weight_User.findFirst({
      where: { email },
    });
  }

  if (weightUser) {
    supabaseUserId = weightUser.id;
  } else {
    // Create new Supabase auth user
    const { data: createData, error: createError } =
      await admin.auth.admin.createUser({
        email: email ?? undefined,
        email_confirm: true,
        user_metadata: fullName ? { full_name: fullName } : undefined,
      });

    if (createError) {
      // User may already exist in auth.users but not in weight_User
      const { data: listData } = await admin.auth.admin.listUsers({
        page: 1,
        perPage: 1000,
      });
      const existing = listData?.users?.find((u) => u.email === email);
      if (!existing) {
        return NextResponse.json(
          { error: "Failed to create user" },
          { status: 500 }
        );
      }
      supabaseUserId = existing.id;
    } else {
      supabaseUserId = createData.user.id;
      isNew = true;
    }
  }

  // 3. Upsert weight_User
  const upserted = await prisma.weight_User.upsert({
    where: { id: supabaseUserId },
    update: {
      appleUserId,
      ...(email ? { email } : {}),
    },
    create: {
      id: supabaseUserId,
      appleUserId,
      email: email ?? null,
    },
  });

  // 4. Generate Supabase session via magic link
  const userEmail = upserted.email;
  if (!userEmail) {
    return NextResponse.json(
      { error: "No email available to generate session" },
      { status: 500 }
    );
  }

  const { data: linkData, error: linkError } =
    await admin.auth.admin.generateLink({
      type: "magiclink",
      email: userEmail,
    });

  if (linkError || !linkData?.properties?.hashed_token) {
    return NextResponse.json(
      { error: "Failed to generate session" },
      { status: 500 }
    );
  }

  const anonClient = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

  const { data: sessionData, error: sessionError } =
    await anonClient.auth.verifyOtp({
      token_hash: linkData.properties.hashed_token,
      type: "magiclink",
    });

  if (sessionError || !sessionData.session) {
    return NextResponse.json(
      { error: "Failed to create session" },
      { status: 500 }
    );
  }

  return NextResponse.json({
    accessToken: sessionData.session.access_token,
    refreshToken: sessionData.session.refresh_token,
    userId: supabaseUserId,
    subscriptionStatus: upserted.subscriptionStatus,
    trialStartAt: upserted.trialStartAt,
    isNew,
  });
}

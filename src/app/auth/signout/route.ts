import { NextResponse, type NextRequest } from "next/server";
import { createUserClient } from "@/lib/supabase/server";
export async function POST(req: NextRequest) {
  const db = await createUserClient();
  await db.auth.signOut();
  return NextResponse.redirect(new URL("/login", req.url), { status: 303 });
}

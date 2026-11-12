import { describe, it, expect, vi, beforeEach } from "vitest";
import { HttpError } from "@/lib/auth/context";

const requireContext = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/context", async (orig) => ({ ...(await orig<typeof import("@/lib/auth/context")>()), requireContext: (r: string) => requireContext(r) }));
vi.mock("./mfa", async (orig) => ({ ...(await orig<typeof import("./mfa")>()), ownerMfaEnforced: () => false }));
const save = vi.fn(async () => ({ changed: 1 }));
vi.mock("./ai-policy", async (orig) => ({ ...(await orig<typeof import("./ai-policy")>()), saveAiPolicy: (...a: unknown[]) => save(...(a as [])) }));

import { saveAiPolicyAction } from "./actions/ai-policy";
import { modesFromForm, overridesOnly } from "./ai-policy";

const fakeCtx = (role: string) => ({ db: { auth: { mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: "aal1", nextLevel: "aal1" } }) } } }, userId: "u", workspaceId: "w", role });

describe("/settings/ai save action", () => {
  beforeEach(() => { save.mockClear(); requireContext.mockReset(); });
  it("rejects non-admins (editor/viewer) without saving", async () => {
    requireContext.mockImplementation(async () => { throw new HttpError(403, "requires admin"); });
    const r = await saveAiPolicyAction(null, new FormData());
    expect(r?.error).toMatch(/admin/);
    expect(save).not.toHaveBeenCalled();
    expect(requireContext).toHaveBeenCalledWith("admin");
  });
  it("admin saves the posted modes", async () => {
    requireContext.mockResolvedValue(fakeCtx("admin"));
    const fd = new FormData(); fd.set("mode_brief.synthesis", "on"); fd.set("version", "v1");
    const r = await saveAiPolicyAction(null, fd);
    expect(r?.ok).toBe(true);
    const [, , , modes, version] = save.mock.calls[0] as unknown as [unknown, unknown, unknown, Record<string, string>, string];
    expect(modes["brief.synthesis"]).toBe("on");
    expect(version).toBe("v1");
  });
  it("reset ignores posted values; only overrides are stored", () => {
    const fd = new FormData(); fd.set("mode_brief.synthesis", "on");
    expect(modesFromForm(fd, true)["brief.synthesis"]).toBe("off");
    expect(overridesOnly(modesFromForm(fd))).toEqual({ "brief.synthesis": "on" });
  });
});

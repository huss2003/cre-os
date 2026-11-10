import "server-only";
import type { JobHandler } from "./queue";
import * as imports from "@/modules/imports/jobs";
import * as capture from "@/modules/capture/jobs";
import * as brief from "@/modules/brief/jobs";
import * as deals from "@/modules/deals/jobs";
import * as integrations from "@/modules/integrations/jobs";
import * as intelligence from "@/modules/intelligence/jobs";
import * as admin from "@/modules/admin/jobs";
import * as signals from "@/modules/signals/jobs";
import * as scoring from "@/modules/scoring/jobs";
import * as contacts from "@/modules/contacts/jobs";
import * as outreach from "@/modules/outreach/jobs";
import * as meetings from "@/modules/meetings/jobs";
import * as assistant from "@/modules/assistant/jobs";

const modules = [imports, capture, brief, deals, integrations, intelligence, admin, signals, scoring, contacts, outreach, meetings, assistant];

export const handlers: Record<string, JobHandler> = Object.assign({}, ...modules.map((m) => m.handlers));
export const schedulers: ((now: Date) => Promise<unknown>)[] = modules.map((m) => (now: Date) => m.schedule(now));

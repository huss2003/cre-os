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
import * as workflows from "@/modules/workflows/jobs";
import * as tutorials from "@/modules/tutorials/jobs";
import * as assistant from "@/modules/assistant/jobs";
import * as orchestrator from "@/modules/orchestrator/jobs";
import * as orchestratorSchedule from "@/modules/orchestrator/schedule/jobs";
import * as transactions from "@/modules/transactions/jobs";
import * as leases from "@/modules/leases/jobs";
import { guardHandlers } from "@/modules/orchestrator/budget/service";

const modules = [imports, capture, brief, deals, integrations, intelligence, admin, signals, scoring, contacts, outreach, meetings, assistant, workflows, tutorials, orchestrator, orchestratorSchedule, transactions, leases];

/** Budget guard (spec §12): budgeted non-critical job types pause when their budget is exhausted; others pass through. */
export const handlers: Record<string, JobHandler> = guardHandlers(Object.assign({}, ...modules.map((m) => m.handlers)));
export const schedulers: ((now: Date) => Promise<unknown>)[] = modules.map((m) => (now: Date) => m.schedule(now));

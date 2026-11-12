import type { Tour } from "../types";
import { tour as database } from "./database";
import { tour as signals } from "./signals";
import { tour as scoring } from "./scoring";
import { tour as contacts } from "./contacts";
import { tour as outreach } from "./outreach";
import { tour as meetings } from "./meetings";
import { tour as toolkit } from "./toolkit";
import { tour as automation } from "./automation";
import { tour as input } from "./input-engine";
import { tour as intelligence } from "./intelligence";
import { tour as leases } from "./leases";
import { tour as transactions } from "./transactions";
import { tour as supply } from "./supply";

export const TOURS: Tour[] = [database, signals, scoring, contacts, outreach, meetings, toolkit, automation, input, intelligence, leases, transactions, supply];
export function tourByKey(key: string | null | undefined): Tour | undefined {
  return TOURS.find((t) => t.key === key);
}

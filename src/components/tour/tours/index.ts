import type { Tour } from "../types";
import { tour as database } from "./database";
import { tour as signals } from "./signals";
import { tour as scoring } from "./scoring";
import { tour as contacts } from "./contacts";
import { tour as outreach } from "./outreach";
import { tour as meetings } from "./meetings";

export const TOURS: Tour[] = [database, signals, scoring, contacts, outreach, meetings];
export function tourByKey(key: string | null | undefined): Tour | undefined {
  return TOURS.find((t) => t.key === key);
}

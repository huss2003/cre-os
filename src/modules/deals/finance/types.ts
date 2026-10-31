/**
 * Finance engine input/output contract (spec Part I §11, Part II §5). Engine version "fin-1.0".
 * All money in the scenario currency. Numbers may be passed as number or decimal string; the engine
 * computes with decimal.js and emits strings rounded to 2 dp (rates to 10 dp).
 *
 * Timeline convention: period 0 = base date (time zero, upfront items). Period t (1..horizon) is the t-th month
 * after the base date; monthly recurring items fall in periods 1..horizon. Cash flows are positive for costs
 * (outflows) and negative for refunds/inflows. Discounting: C_t / (1 + r_m)^t with r_m = (1 + r_a)^(1/12) - 1.
 */
export type Num = number | string;

export const ENGINE_VERSION = "fin-1.0";

export type ScenarioKind = "conventional" | "managed" | "coworking" | "renew" | "relocate";
export type AreaBasis = "chargeable" | "carpet" | "seat" | "lumpsum";

export interface Escalation {
  /** Percentage per step, e.g. 15 for 15 %. */
  pct: Num;
  /** Step length in lease months (e.g. 12 or 36). First escalated lease month = everyMonths + 1. */
  everyMonths: number;
}

export interface RentInput {
  basis: AreaBasis;
  /** Seat basis: committed (billed) seats; defaults to area.plannedSeats. */
  committedSeats?: number | null;
  /** ₹ per unit of basis per month (per SF or per seat); for "lumpsum" the monthly amount. */
  rate: Num;
  /** Period index of lease month 1 (commencement). Default 1. */
  startPeriod?: number;
  escalation?: Escalation | null;
  /** Explicit step schedule (lease month → rate). Overrides escalation when present. */
  schedule?: { fromLeaseMonth: number; rate: Num }[];
  /** Rent-free lease months counted from commencement (1..n). */
  rentFreeMonths?: number;
  /** When true, CAM is also waived during rent-free months. Default false (CAM still payable). */
  rentFreeIncludesCam?: boolean;
}

export interface CamInput {
  mode: "none" | "fixed" | "per_sf" | "mixed";
  /** Fixed monthly amount (fixed/mixed). */
  fixedMonthly?: Num;
  /** ₹/SF/month (per_sf/mixed). */
  ratePerSf?: Num;
  /** Area basis used for per_sf component. Default "chargeable". */
  basis?: "chargeable" | "carpet";
  escalation?: Escalation | null;
}

export interface ParkingInput { slots: number; ratePerSlot: Num; escalation?: Escalation | null }

export interface RecurringItem { label: string; monthly: Num; fromPeriod?: number; toPeriod?: number; category?: string }
export interface OneOffItem { label: string; amount: Num; period: number; category?: string }

export interface DepositInput {
  /** Months of the first full monthly base rent (after rent-free) — or give amount. */
  months?: Num;
  amount?: Num;
  paidPeriod?: number;           // default 0
  /** Period of contractual refund. Default = end of tenure (startPeriod + tenureMonths - 1). */
  refundPeriod?: number;
}

export interface CapexInput {
  fitoutCost: Num;               // gross fit-out/capex
  spendPeriod?: number;          // default 0
  landlordContribution?: Num;    // capex support received by occupier
  contributionPeriod?: number;   // default = spendPeriod
  reinstatement?: { amount: Num; period: number } | null;
}

export interface FinancingInput {
  partnerName: string;           // tenant-configured partner (partner table) or "cash"; never hardcoded
  partnerId?: string | null;
  principal: Num;                // amount the lender pays on the client's behalf
  annualInterestRate: Num;       // nominal % p.a.; monthly loan rate = annual / 12 (stated loan convention)
  termMonths: number;
  drawPeriod?: number;           // default = capex spendPeriod
  firstRepaymentPeriod?: number; // default drawPeriod + 1
  repayment?: "annuity" | "straight_line";
  upfrontFee?: Num;              // absolute fee paid at draw
  securityDeposit?: Num;         // lender deposit, refunded at end of term
  residualBuyout?: Num;          // paid at end of term to own fit-out
  earlyTerminationPeriod?: number | null; // if set, outstanding principal is repaid at this period
}

export interface MoveInput {
  parallelRentMonthly?: Num;     // cost of the old premises while overlapping
  parallelFromPeriod?: number;
  parallelMonths?: number;
  moveCost?: Num;
  movePeriod?: number;
  brokerageLegal?: Num;
  brokerageLegalPeriod?: number;
}

export interface TaxInput {
  /** "excluded": quoted rates exclude GST → add GST on the selected categories at gstRatePct.
   *  "included": quoted rates already include GST → nothing added.
   *  "recoverable": input credit available → GST not a cost. */
  treatment: "excluded" | "included" | "recoverable";
  gstRatePct?: Num | null;       // must be supplied by finance/legal input; never defaulted
  appliesTo?: ("rent" | "cam" | "parking" | "recurring")[];
}

export interface FinanceInput {
  name: string;
  kind: ScenarioKind;
  currency?: string;             // default INR
  baseDate: string;              // YYYY-MM-DD (period 0)
  horizonMonths: number;         // common comparison horizon
  annualDiscountRatePct: Num;    // e.g. 12 for 12 % p.a.
  area: { chargeableSf?: Num | null; carpetSf?: Num | null; plannedSeats?: number | null };
  tenureMonths?: number | null;  // lease term from commencement; default horizon
  /** What happens if the tenure ends before the horizon. Must be explicit when tenure < horizon. */
  afterTenure?: "continue_same_terms" | "vacate" | null;
  rent?: RentInput | null;
  cam?: CamInput | null;
  parking?: ParkingInput | null;
  recurring?: RecurringItem[];
  oneOffs?: OneOffItem[];
  deposit?: DepositInput | null;
  capex?: CapexInput | null;
  financing?: FinancingInput | null;
  move?: MoveInput | null;
  taxes?: TaxInput | null;
  /** Provenance only (not used in maths): quote ids/versions the inputs came from. */
  quoteRefs?: { quoteId: string; version: number; validUntil?: string | null }[];
}

export interface CashflowRow { period: number; date: string; category: string; amount: string }

export interface FinanceResult {
  engineVersion: string;
  name: string;
  kind: ScenarioKind;
  currency: string;
  baseDate: string;
  horizonMonths: number;
  monthlyDiscountRate: string;
  /** Per-period totals (index = period 0..horizon). */
  periodTotals: string[];
  cashflows: CashflowRow[];
  categoryTotals: Record<string, string>;
  totals: {
    nominalTco: string;          // undiscounted sum of all flows over horizon
    npv: string;
    annuityFactor: string;       // Σ_{t=1..n} (1+r_m)^-t (or n when zero rate)
    equivalentMonthly: string;   // NPV / annuity factor
    perChargeableSfMonth: string | null;
    perCarpetSfMonth: string | null;
    perPlannedSeatMonth: string | null;
    effectiveRentPerSfMonth: string | null; // rent-only equivalent level monthly / billing area (rent-free & escalation included)
    peakMonthlyOutflow: string;
    peakMonthlyOutflowPeriod: number;
    peakCumulativeOutflow: string;
    financingInterestTotal: string | null;
  };
  warnings: string[];
  outputHash: string;
}

export interface Sensitivity { label: string; parameter: string; delta: string; npv: string; npvChange: string }

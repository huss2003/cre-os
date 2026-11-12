/** Test fixture: a 3-page executed lease (synthetic) + an amendment + a draft LOI that disagrees on dates. */
export const EXECUTED_LEASE_PAGES = [
  `LEASE DEED
This Lease Deed is executed on 15th December 2026 at Pune between Landlord Realty Pvt Ltd (the Lessor) and Acme Analytics Pvt Ltd (the Lessee).

1. TERM
1.1 The term of the lease shall be 108 (one hundred and eight) months commencing on 1st January 2027 (the Commencement Date).
1.2 The lease shall expire on 31st December 2035 unless renewed.`,
  `2. RENT AND DEPOSIT
2.1 The monthly rent of Rs. 10,00,000/- shall be payable on or before the 7th day of each month.
2.2 Common area maintenance (CAM) charges of Rs. 1,20,000/- per month shall be paid separately.
2.3 The Lessee shall pay an interest-free refundable security deposit of Rs. 60,00,000/-.
2.4 The rent shall be escalated by 15% after every 36 months on the last paid rent.

3. LOCK-IN
3.1 The lock-in period shall be 36 (thirty six) months from the Commencement Date.`,
  `4. TERMINATION AND RENEWAL
4.1 After the lock-in period, the Lessee may terminate this lease by giving notice of not less than six (6) months prior to the expiry of the term or such date of termination.
4.2 The Lessee shall have the option to renew the lease for a further term by giving written notice not less than 6 months prior to the expiry of the term.
4.3 Break option: the Lessee may exercise a break option after 60 months subject to payment of the break fee.

5. COVENANTS
5.1 The Lessee shall maintain insurance for its fit-out and contents.
5.2 The Lessor shall carry out structural repairs of the building.
5.3 The Lessee shall not sub-let the premises without consent.
5.4 On expiry the Lessee shall restore the premises to their original bare shell condition.`,
];

export const AMENDMENT_PAGES = [
  `FIRST AMENDMENT TO LEASE DEED
With effect from 1st January 2028 the monthly rent of Rs. 10,50,000/- shall be payable.
Common area maintenance (CAM) charges of Rs. 1,30,000/- per month shall be paid.`,
];

export const DRAFT_LOI_PAGES = [
  `LETTER OF INTENT (DRAFT — NOT BINDING)
The lease shall commence on 1st February 2027 and the monthly rent of Rs. 9,50,000/- is proposed.
The lease shall expire on 31st January 2036.`,
];

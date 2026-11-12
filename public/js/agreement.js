// The annual service agreement: its default terms and the exact text a
// client reads and signs. Shared by the server (which builds and fingerprints
// it) and the browser (which displays it).
//
// IMPORTANT for the owner: the default terms below are a plain-English
// starting point, not legal advice. Have a Tennessee attorney review them
// before you rely on them. You can edit them in Admin → Agreement.

export const BUSINESS_NAME = 'Curb Appeal Franklin';
export const BUSINESS_PHONE = '(615) 945-1614';
export const BUSINESS_SMS = 'sms:+16159451614';

export const DEFAULT_TERMS = `Payment. You will be billed the monthly price shown above once a month. The yearly cost of your plan is spread over twelve equal payments, so the amount is the same in busy and quiet months.

Schedule. We visit weekly from March through November and every other week in winter. Visits may move for weather or holidays; if we miss a visit we make it up.

Access. You agree to give our crew access to the property on service days, including unlocked gates, and to keep pets secured while we work.

What is not included. Work that is not listed in this agreement is quoted separately and is only done with your approval.

Visit reports. After each visit we post a report to your dashboard listing what was completed, with photographs of the property taken for that purpose.

Concerns. If something is not right, tell us within seven days of the visit and we will come back and correct it.

Ending the agreement. Either of us may end this agreement by giving thirty days' written notice. A text message or a note through your dashboard counts as written notice.`;

const money = (n) => `$${Math.round(Number(n) || 0).toLocaleString('en-US')}`;
const longDate = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

/**
 * The agreement as plain text. This exact string is what gets fingerprinted
 * and signed, so any change to it produces a different fingerprint.
 * @param a { clientName, address, monthly, startDate, termMonths, services: [{label, cadence}], tasks: [string], terms }
 */
export function agreementText(a) {
  return [
    'ANNUAL SERVICE AGREEMENT',
    '',
    `Between ${BUSINESS_NAME} ("we", "us") and ${a.clientName} ("you").`,
    `Property: ${a.address}`,
    '',
    '1. TERM',
    `This agreement runs for ${a.termMonths} months beginning ${longDate(a.startDate)}.`,
    '',
    '2. SERVICES',
    ...a.services.map((s) => `   - ${s.label} (${s.cadence})`),
    '',
    'At each visit our crew works from this checklist, as the season requires:',
    ...a.tasks.map((t) => `   - ${t}`),
    '',
    '3. PRICE',
    `${money(a.monthly)} per month, in ${a.termMonths} equal monthly payments (${money(a.monthly * a.termMonths)} over the term).`,
    '',
    '4. TERMS',
    a.terms,
    '',
    '5. ELECTRONIC SIGNATURE',
    'By typing your name and choosing "Sign agreement" you agree to do business with us electronically, and you agree that your typed name is your signature and has the same effect as signing on paper. You can view and print the signed agreement from your dashboard at any time, and you may ask us for a paper copy.',
  ].join('\n');
}

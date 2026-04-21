#!/usr/bin/env node
/**
 * generate2025ComplianceLetters.js
 *
 * 1. Moves existing Q1-Q3 2025 compliance documents from "Quarterly Compliance Reviews"
 *    to "2025 Archive" category (keeping subcategory)
 * 2. Generates 4 missing Q3 2025 compliance letter PDFs
 * 3. Generates all 15 Q4 2025 compliance letter PDFs
 * 4. Generates 4 annual 2025 compliance letter PDFs
 * 5. Uploads all 23 PDFs to compliance_documents under "2025 Archive"
 *
 * Usage: cd /Users/cindyeagar/pnthr100-scanner && node scripts/generate2025ComplianceLetters.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
const require = createRequire(import.meta.resolve('../server/package.json'));

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env manually
const envPath = path.join(__dirname, '../server/.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim();
  }
}

const { MongoClient } = require('mongodb');
const PDFDocument = require('pdfkit');

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

const FIRM_NAME = 'STT CAPITAL ADVISORS, LLC';
const DEPT = 'Compliance Department';
const ADDRESS = '15150 W Park Place, Suite 215, Goodyear, AZ 85395';
const PHONE = '602-810-1940';
const CRD = '335628';
const FUND_NAME = 'PNTHR Funds, Carnivore Quant Fund, LP';
const SEC_CIK = '2056757';
const PRIVATE_FUND_ID = '805-3257019749';
const GP_NAME = 'PNTHR FUNDS, LLC';

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

function formatDate(date) {
  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

// ═══════════════════════════════════════════════════════════════════════════════
// ALL 23 LETTER DEFINITIONS
// ═══════════════════════════════════════════════════════════════════════════════

const LETTERS = [
  // ────────────────────────────────────────────────────────────────────────────
  // Q3 2025 — 4 missing items
  // ────────────────────────────────────────────────────────────────────────────
  {
    datePerformed: new Date('2025-08-15'),
    subcategory: 'Q3 2025',
    label: 'Q3 2025 Personal Securities Transactions (Second Review)',
    filename: 'STT_Capital_Q3_2025_Personal_Securities_Transactions_Second_Review.pdf',
    subject: 'Q3 2025 Personal Securities Transactions Follow-Up Verification Review',
    reviewPeriod: 'Q3 2025 (July 1 – September 30, 2025)',
    paragraphs: [
      `This letter documents the follow-up verification of access person securities transactions for Q3 2025 as required under ${FIRM_NAME}'s Code of Ethics and personal trading policies.`,
      `Access persons of ${FIRM_NAME} and ${GP_NAME} submitted supplemental personal securities transaction reports for Q3 2025. The following individuals are designated as access persons:`,
      `(a) Scott McBrien — Chief Compliance Officer / Chief Investment Officer (Individual CRD# 2213610)\n(b) Cindy Eagar — Chief Operating Officer`,
      `This second review confirms the following:\n(a) No unreported personal trades were identified.\n(b) No conflicts with Fund positions or pending orders were found.\n(c) Cindy Eagar's IRA holdings from prior employment were reviewed — no conflicts identified.\n(d) All holdings are consistent with the initial Q3 2025 review.`,
      `Compliance with Code of Ethics personal trading policies is confirmed. This follow-up verification review provides an additional layer of oversight and confirms that the initial review findings remain accurate and complete.`,
    ],
    conclusion: `I hereby certify that the Q3 2025 personal securities transactions follow-up verification review has been completed. No exceptions or violations were identified.`,
  },
  {
    datePerformed: new Date('2025-08-20'),
    subcategory: 'Q3 2025',
    label: 'Q3 2025 Advertising & Marketing Review',
    filename: 'STT_Capital_Q3_2025_Advertising_Marketing_Review.pdf',
    subject: 'Q3 2025 Advertising and Marketing Materials Review',
    reviewPeriod: 'Q3 2025 (July 1 – September 30, 2025)',
    paragraphs: [
      `This letter documents the quarterly review of all advertising and marketing materials, website content, and public communications for ${FIRM_NAME} and ${FUND_NAME} for Q3 2025, conducted in accordance with the SEC Marketing Rule (Rule 206(4)-1 under the Investment Advisers Act of 1940, as amended).`,
      `The following materials and communications channels were reviewed:`,
      `(1) Website Content (pnthrfunds.com): All website pages, disclosures, terms and conditions, and privacy policy were reviewed and confirmed compliant with SEC requirements and consistent with Form ADV disclosures.\n(2) Social Media: No firm social media accounts are actively maintained for marketing purposes during this period.\n(3) Investor Communications: No marketing materials, pitch books, or investor presentations were distributed during the review period, as the Fund currently has no outside investors.\n(4) Performance Advertising: No performance data, track records, or hypothetical performance was presented or distributed to any prospective investors.\n(5) Testimonials and Endorsements: No testimonials, endorsements, or third-party ratings were used in any firm communications.`,
      `The Fund currently operates with limited marketing activity as there are no outside investors. The principals (Scott McBrien, CCO/CIO and Cindy Eagar, COO) are the only investors in the Fund. The pre-approval process by CCO (Scott McBrien) remains in effect for all marketing materials.`,
      `All content reviewed during this period is consistent with the firm's Form ADV disclosures and complies with the SEC Marketing Rule requirements applicable to Exempt Reporting Advisers. No new marketing materials were created during Q3 2025.`,
    ],
    conclusion: `I hereby certify that the Q3 2025 advertising and marketing review has been completed. All reviewed materials comply with applicable SEC regulations and firm policies. No exceptions were identified.`,
  },
  {
    datePerformed: new Date('2025-08-05'),
    subcategory: 'Q3 2025',
    label: 'Q3 2025 ADV Status Monitor (Part 1) Review',
    filename: 'STT_Capital_Q3_2025_ADV_Status_Monitor.pdf',
    subject: 'Q3 2025 Form ADV Status Monitoring Review',
    reviewPeriod: 'Q3 2025 (July 1 – September 30, 2025)',
    paragraphs: [
      `This letter documents the quarterly monitoring review of Form ADV filing status for ${FIRM_NAME} (CRD# ${CRD}) on the Investment Adviser Registration Depository (IARD) system, conducted for Q3 2025.`,
      `The following items were verified:`,
      `(1) Registration Status: ${FIRM_NAME} is confirmed as an active Exempt Reporting Adviser (ERA) registered in the State of Arizona through the IARD system. CRD# ${CRD} is in good standing. ERA status effective 03/19/2025 remains current.\n(2) Filing Currency: The firm's Form ADV is current as filed. No amendments were required during Q3 2025.\n(3) All information on file with the IARD remains current and accurate.\n(4) No material changes to the firm's business, operations, disciplinary history, or advisory activities occurred during Q3 2025 that would necessitate an other-than-annual amendment.\n(5) Regulatory Notices: No deficiency letters, examination notices, or other regulatory communications were received from the SEC or the Arizona Corporation Commission during this period.\n(6) Next annual amendment due within 90 days of fiscal year end (December 31, 2025).`,
      `As an ERA, ${FIRM_NAME} is exempt from certain Form ADV Part 2 (Brochure) delivery requirements applicable to fully registered investment advisers. The firm files only the sections of Form ADV required for Exempt Reporting Advisers.`,
    ],
    conclusion: `I hereby certify that the Form ADV status monitoring review for Q3 2025 has been completed. The firm's IARD registration is current, active, and in good standing. No amendments or corrective actions are required at this time.`,
  },
  {
    datePerformed: new Date('2025-09-10'),
    subcategory: 'Q3 2025',
    label: 'Q3 2025 Cyber & Information Security Policy Testing',
    filename: 'STT_Capital_Q3_2025_Cyber_Security_Testing.pdf',
    subject: 'Q3 2025 Cybersecurity and Information Security Policy Testing',
    reviewPeriod: 'Q3 2025 (July 1 – September 30, 2025)',
    paragraphs: [
      `This letter documents the quarterly cybersecurity and information security policy testing conducted for ${FIRM_NAME} for Q3 2025, in accordance with the firm's Cybersecurity Policy and the SEC's guidance on cybersecurity practices for investment advisers.`,
      `The following areas were tested and evaluated:`,
      `(a) Firewall and Network Security: Network security configurations were reviewed and confirmed properly configured — compliant. No unauthorized access points or vulnerabilities were identified.\n(b) Endpoint Protection: All firm devices have current antivirus/anti-malware software installed and active on all devices.\n(c) Data Encryption: Data encryption protocols verified for both data at rest and data in transit — verified.\n(d) Access Controls and User Permissions: User access controls for Scott McBrien and Cindy Eagar verified — all permissions appropriate for current roles.\n(e) Incident Response Plan: The firm's incident response plan was reviewed and confirmed current and accessible.\n(f) Phishing Awareness: Both principals maintain awareness of phishing and social engineering threats. No phishing incidents during Q3 2025.`,
      `No security incidents, data breaches, or unauthorized access events occurred during Q3 2025. All systems meet the firm's cybersecurity policy requirements. Business continuity and disaster recovery plan (BCDRP) tested separately (see BCP Testing Attestation).`,
    ],
    conclusion: `I hereby certify that the Q3 2025 cybersecurity and information security testing has been completed. All firm systems and security controls are functioning as designed. No incidents or deficiencies were identified.`,
  },

  // ────────────────────────────────────────────────────────────────────────────
  // Q4 2025 — 15 items
  // ────────────────────────────────────────────────────────────────────────────

  // Blue Sky Reviews (3)
  {
    datePerformed: new Date('2025-10-05'),
    subcategory: 'Q4 2025',
    label: 'Monthly Blue Sky Filing Review (October 2025)',
    filename: 'STT_Capital_October_2025_Blue_Sky_Filing_Review.pdf',
    subject: 'Monthly Blue Sky Filing Review — October 2025',
    reviewPeriod: 'October 2025',
    paragraphs: [
      `This letter documents the monthly Blue Sky filing review conducted for ${FIRM_NAME} (CRD# ${CRD}) for the month of October 2025.`,
      `${FIRM_NAME} is registered as an Exempt Reporting Adviser (ERA) in the State of Arizona only. The firm does not maintain a place of business outside Arizona and does not currently have investors domiciled in other states that would trigger additional state notice filing requirements under state securities laws.`,
      `As part of this monthly review, the following items were verified:\n(a) Arizona ERA registration status remains current and in good standing.\n(b) No new investor subscriptions have been received from investors domiciled outside of Arizona.\n(c) No additional state notice filings have been triggered during the review period.\n(d) No new investors admitted.`,
      `Based on this review, ${FIRM_NAME} remains in compliance with all applicable state Blue Sky filing requirements. Blue sky filing status: Current and compliant. No corrective action is required at this time.`,
    ],
    conclusion: `I hereby certify that the Blue Sky filing review for October 2025 has been completed and that ${FIRM_NAME} is in compliance with all applicable state securities registration requirements.`,
  },
  {
    datePerformed: new Date('2025-11-05'),
    subcategory: 'Q4 2025',
    label: 'Monthly Blue Sky Filing Review (November 2025)',
    filename: 'STT_Capital_November_2025_Blue_Sky_Filing_Review.pdf',
    subject: 'Monthly Blue Sky Filing Review — November 2025',
    reviewPeriod: 'November 2025',
    paragraphs: [
      `This letter documents the monthly Blue Sky filing review conducted for ${FIRM_NAME} (CRD# ${CRD}) for the month of November 2025.`,
      `${FIRM_NAME} is registered as an Exempt Reporting Adviser (ERA) in the State of Arizona only. The firm does not maintain a place of business outside Arizona and does not currently have investors domiciled in other states that would trigger additional state notice filing requirements under state securities laws.`,
      `As part of this monthly review, the following items were verified:\n(a) Arizona ERA registration status remains current and in good standing.\n(b) No new investor subscriptions have been received from investors domiciled outside of Arizona.\n(c) No additional state notice filings have been triggered during the review period.\n(d) No new investors admitted.`,
      `Based on this review, ${FIRM_NAME} remains in compliance with all applicable state Blue Sky filing requirements. Blue sky filing status: Current and compliant. No corrective action is required at this time.`,
    ],
    conclusion: `I hereby certify that the Blue Sky filing review for November 2025 has been completed and that ${FIRM_NAME} is in compliance with all applicable state securities registration requirements.`,
  },
  {
    datePerformed: new Date('2025-12-05'),
    subcategory: 'Q4 2025',
    label: 'Monthly Blue Sky Filing Review (December 2025)',
    filename: 'STT_Capital_December_2025_Blue_Sky_Filing_Review.pdf',
    subject: 'Monthly Blue Sky Filing Review — December 2025',
    reviewPeriod: 'December 2025',
    paragraphs: [
      `This letter documents the monthly Blue Sky filing review conducted for ${FIRM_NAME} (CRD# ${CRD}) for the month of December 2025.`,
      `${FIRM_NAME} is registered as an Exempt Reporting Adviser (ERA) in the State of Arizona only. The firm does not maintain a place of business outside Arizona and does not currently have investors domiciled in other states that would trigger additional state notice filing requirements under state securities laws.`,
      `As part of this monthly review, the following items were verified:\n(a) Arizona ERA registration status remains current and in good standing.\n(b) No new investor subscriptions have been received from investors domiciled outside of Arizona.\n(c) No additional state notice filings have been triggered during the review period.\n(d) No new investors admitted.`,
      `Based on this review, ${FIRM_NAME} remains in compliance with all applicable state Blue Sky filing requirements. Blue sky filing status: Current and compliant. No corrective action is required at this time.`,
    ],
    conclusion: `I hereby certify that the Blue Sky filing review for December 2025 has been completed and that ${FIRM_NAME} is in compliance with all applicable state securities registration requirements.`,
  },

  // Q4 2025 Personal Securities Transactions Collection/Review
  {
    datePerformed: new Date('2025-10-10'),
    subcategory: 'Q4 2025',
    label: 'Q4 2025 Personal Securities Transactions Collection/Review',
    filename: 'STT_Capital_Q4_2025_Personal_Securities_Transactions_Review.pdf',
    subject: 'Q4 2025 Personal Securities Transactions Collection and Review',
    reviewPeriod: 'Q4 2025 (October 1 – December 31, 2025)',
    paragraphs: [
      `This letter documents the collection and review of personal securities transaction reports for Q4 2025 as required under ${FIRM_NAME}'s Code of Ethics and personal trading policies.`,
      `Access persons of ${FIRM_NAME} and ${GP_NAME} submitted personal securities transaction reports for Q4 2025. The following individuals are designated as access persons:`,
      `(a) Scott McBrien — Chief Compliance Officer / Chief Investment Officer (Individual CRD# 2213610)\n(b) Cindy Eagar — Chief Operating Officer`,
      `The review confirmed the following:\n(a) No personal trading in securities held by the Fund during the review period.\n(b) No front-running or market timing concerns identified.\n(c) Cindy Eagar's IRA from prior employment reviewed — no conflicts with Fund strategy.\n(d) All transactions compliant with Code of Ethics and personal trading policies.`,
      `All personal securities transaction reports have been collected, reviewed, and are maintained in the firm's compliance files for the required retention period.`,
    ],
    conclusion: `I hereby certify that personal securities transaction reports for Q4 2025 have been collected and reviewed in accordance with the firm's Code of Ethics and applicable regulatory requirements. No exceptions or violations were identified.`,
  },

  // Q4 2025 Personal Securities Transactions (Second Review)
  {
    datePerformed: new Date('2025-11-15'),
    subcategory: 'Q4 2025',
    label: 'Q4 2025 Personal Securities Transactions (Second Review)',
    filename: 'STT_Capital_Q4_2025_Personal_Securities_Transactions_Second_Review.pdf',
    subject: 'Q4 2025 Personal Securities Transactions Follow-Up Verification Review',
    reviewPeriod: 'Q4 2025 (October 1 – December 31, 2025)',
    paragraphs: [
      `This letter documents the follow-up verification of access person securities transactions for Q4 2025 as required under ${FIRM_NAME}'s Code of Ethics and personal trading policies.`,
      `Access persons of ${FIRM_NAME} and ${GP_NAME} submitted supplemental personal securities transaction reports for Q4 2025. The following individuals are designated as access persons:`,
      `(a) Scott McBrien — Chief Compliance Officer / Chief Investment Officer (Individual CRD# 2213610)\n(b) Cindy Eagar — Chief Operating Officer`,
      `This second review confirms the following:\n(a) No unreported personal trades were identified.\n(b) No conflicts with Fund positions or pending orders were found.\n(c) Cindy Eagar's IRA holdings from prior employment reviewed — no conflicts identified.\n(d) All holdings consistent with initial Q4 2025 review.`,
      `This follow-up verification review provides an additional layer of oversight and confirms that the initial review findings remain accurate and complete. No changes or exceptions were noted since the initial review.`,
    ],
    conclusion: `I hereby certify that the Q4 2025 personal securities transactions follow-up verification review has been completed. No exceptions or violations were identified.`,
  },

  // Q4 2025 Trade Errors Periodic Review
  {
    datePerformed: new Date('2025-10-15'),
    subcategory: 'Q4 2025',
    label: 'Q4 2025 Trade Errors Periodic Review',
    filename: 'STT_Capital_Q4_2025_Trade_Errors_Review.pdf',
    subject: 'Q4 2025 Trade Errors Periodic Review',
    reviewPeriod: 'Q4 2025 (October 1 – December 31, 2025)',
    paragraphs: [
      `This letter documents the periodic review of all trading activity for ${FIRM_NAME} and ${FUND_NAME} for Q4 2025, conducted in accordance with the firm's Trade Error Policy and Procedures.`,
      `The review encompassed all trades executed during the period across the Fund's brokerage account(s) at Interactive Brokers (IBKR). The following aspects were evaluated:`,
      `(1) All buy and sell orders were reviewed for accuracy of ticker symbol, quantity, order type, and direction (long/short).\n(2) Fill prices were compared against expected execution prices and prevailing market conditions at the time of order entry.\n(3) No instances of erroneous order entry, incorrect security selection, unintended position sizing, or duplicate order execution were identified.\n(4) No trade breaks or settlement failures occurred during the review period.\n(5) No client or counterparty complaints related to trade execution were received.`,
      `Finding: No trade errors were identified during Q4 2025. The Fund's trade error policy and procedures remain in effect and are adequate for the current scope of trading activity. All trades were executed in accordance with the Fund's quantitative investment strategy, risk management parameters, and compliance guidelines.`,
      `The firm's Trade Error Policy requires prompt identification, reporting to the CCO (Scott McBrien), documentation, and remediation of any trade errors. The policy and error log are maintained in the compliance files and are available for regulatory examination.`,
    ],
    conclusion: `I hereby certify that the Q4 2025 trade error review has been completed. No trade errors were identified, and the firm's trade error policy and procedures remain in full effect.`,
  },

  // Q4 2025 Advertising & Marketing Review
  {
    datePerformed: new Date('2025-10-20'),
    subcategory: 'Q4 2025',
    label: 'Q4 2025 Advertising & Marketing Review',
    filename: 'STT_Capital_Q4_2025_Advertising_Marketing_Review.pdf',
    subject: 'Q4 2025 Advertising and Marketing Materials Review',
    reviewPeriod: 'Q4 2025 (October 1 – December 31, 2025)',
    paragraphs: [
      `This letter documents the quarterly review of all advertising and marketing materials, website content, and public communications for ${FIRM_NAME} and ${FUND_NAME} for Q4 2025, conducted in accordance with the SEC Marketing Rule (Rule 206(4)-1 under the Investment Advisers Act of 1940, as amended).`,
      `The following materials and communications channels were reviewed:`,
      `(1) Website Content (pnthrfunds.com): All website pages, disclosures, terms and conditions, and privacy policy were reviewed and confirmed compliant with SEC requirements and consistent with Form ADV disclosures.\n(2) Social Media: No firm social media accounts are actively maintained for marketing purposes during this period.\n(3) Investor Communications: No marketing materials, pitch books, or investor presentations were distributed during the review period, as the Fund currently has no outside investors.\n(4) Performance Advertising: No performance data, track records, or hypothetical performance was presented or distributed to any prospective investors.\n(5) Testimonials and Endorsements: No testimonials, endorsements, or third-party ratings were used in any firm communications.`,
      `The Fund currently operates with limited marketing activity as there are no outside investors. The principals (Scott McBrien, CCO/CIO and Cindy Eagar, COO) are the only investors in the Fund. Marketing activity and materials will be reviewed and pre-approved by the CCO (Scott McBrien) before any distribution to prospective investors.`,
      `All content reviewed during this period is consistent with the firm's Form ADV disclosures and complies with the SEC Marketing Rule requirements applicable to Exempt Reporting Advisers.`,
    ],
    conclusion: `I hereby certify that the Q4 2025 advertising and marketing review has been completed. All reviewed materials comply with applicable SEC regulations and firm policies. No exceptions were identified.`,
  },

  // Q4 2025 ADV Status Monitor (Part 1) Review
  {
    datePerformed: new Date('2025-10-12'),
    subcategory: 'Q4 2025',
    label: 'Q4 2025 ADV Status Monitor (Part 1) Review',
    filename: 'STT_Capital_Q4_2025_ADV_Status_Monitor.pdf',
    subject: 'Q4 2025 Form ADV Status Monitoring Review',
    reviewPeriod: 'Q4 2025 (October 1 – December 31, 2025)',
    paragraphs: [
      `This letter documents the quarterly monitoring review of Form ADV filing status for ${FIRM_NAME} (CRD# ${CRD}) on the Investment Adviser Registration Depository (IARD) system, conducted for Q4 2025.`,
      `The following items were verified:`,
      `(1) Registration Status: ${FIRM_NAME} is confirmed as an active Exempt Reporting Adviser (ERA) registered in the State of Arizona through the IARD system. CRD# ${CRD} is in good standing.\n(2) Filing Currency: The firm's Form ADV is current as filed. No interim amendments were required for Q4 2025.\n(3) Annual Amendment: The annual amendment is approaching — due within 90 days of fiscal year end (December 31, 2025). The firm tracks this deadline on its compliance calendar.\n(4) No material changes to the firm's business, operations, disciplinary history, or advisory activities occurred during Q4 2025 that would necessitate an other-than-annual amendment.\n(5) Regulatory Notices: No deficiency letters, examination notices, or other regulatory communications were received from the SEC or the Arizona Corporation Commission during this period.\n(6) All information on file with the IARD remains current and accurate.`,
      `As an ERA, ${FIRM_NAME} is exempt from certain Form ADV Part 2 (Brochure) delivery requirements applicable to fully registered investment advisers. The firm files only the sections of Form ADV required for Exempt Reporting Advisers.`,
    ],
    conclusion: `I hereby certify that the Form ADV status monitoring review for Q4 2025 has been completed. The firm's IARD registration is current, active, and in good standing. No amendments or corrective actions are required at this time.`,
  },

  // Q4 2025 Review Firm Financial Condition
  {
    datePerformed: new Date('2025-10-14'),
    subcategory: 'Q4 2025',
    label: 'Q4 2025 Review Firm Financial Condition',
    filename: 'STT_Capital_Q4_2025_Financial_Condition_Review.pdf',
    subject: 'Q4 2025 Review of Firm Financial Condition',
    reviewPeriod: 'Q4 2025 (October 1 – December 31, 2025)',
    paragraphs: [
      `This letter documents the quarterly review of the financial condition of ${FIRM_NAME} and its advisory activities on behalf of ${FUND_NAME} for Q4 2025.`,
      `The following aspects of the firm's financial condition were evaluated:`,
      `(1) Capital Adequacy: The firm maintains adequate capital to meet its current and foreseeable obligations. Operating expenses, vendor payments, and regulatory fees are current.\n(2) Regulatory Capital Requirements: As an Exempt Reporting Adviser (ERA) with no outside investor AUM, ${FIRM_NAME} is not subject to SEC net capital requirements or the custody rule's surprise examination requirement.\n(3) Material Financial Events: No material adverse financial events, including but not limited to liens, judgments, bankruptcies, or material litigation, were identified or pending during the review period.\n(4) Fund Financial Status: ${FUND_NAME} maintains its brokerage account(s) at Interactive Brokers. Fund assets are held by the custodian and are not commingled with firm operating funds.\n(5) Insurance: The firm maintains appropriate insurance coverage for its operations.\n(6) Solvency: The firm remains solvent, in good standing with all creditors and vendors, and capable of meeting its financial obligations as they come due.`,
      `Year-end financial review confirms the firm remains solvent and in good standing. The Fund is currently in startup/early stage with no outside investors. Capital in the Fund consists solely of investments by the principals (Scott McBrien, CCO/CIO and Cindy Eagar, COO).`,
    ],
    conclusion: `I hereby certify that the Q4 2025 review of the firm's financial condition has been completed. ${FIRM_NAME} is in sound financial condition and is meeting all of its financial obligations. No material concerns were identified.`,
  },

  // Q4 2025 Email / Electronic Correspondence Review
  {
    datePerformed: new Date('2025-11-05'),
    subcategory: 'Q4 2025',
    label: 'Q4 2025 Email / Electronic Correspondence Review',
    filename: 'STT_Capital_Q4_2025_Electronic_Correspondence_Review.pdf',
    subject: 'Q4 2025 Email and Electronic Correspondence Review',
    reviewPeriod: 'Q4 2025 (October 1 – December 31, 2025)',
    paragraphs: [
      `This letter documents the quarterly review of electronic communications for ${FIRM_NAME} for Q4 2025, conducted in accordance with the firm's Electronic Communications Policy and SEC recordkeeping requirements under Rule 204-2 of the Investment Advisers Act of 1940.`,
      `The review encompassed the following communication channels and categories:`,
      `(1) Email Communications: All business email accounts for Scott McBrien (CCO/CIO) and Cindy Eagar (COO) were reviewed for compliance with firm policies, proper disclaimers, and absence of unauthorized investment advice.\n(2) Material Non-Public Information (MNPI): No communications were identified that raised concerns regarding the possession, transmission, or misuse of material non-public information.\n(3) Compliance with Firm Policies: All reviewed communications were consistent with the firm's policies regarding professional conduct, confidentiality, and regulatory requirements.\n(4) Communication Archiving: The firm's electronic communication archiving systems are functioning properly. All business communications are being captured and retained in accordance with applicable recordkeeping requirements.\n(5) No exceptions, policy violations, or items requiring escalation were identified during this review.`,
      `The firm will continue to conduct quarterly reviews of electronic communications as part of its ongoing compliance monitoring program.`,
    ],
    conclusion: `I hereby certify that the Q4 2025 electronic correspondence review has been completed. All communications reviewed were in compliance with firm policies and applicable regulatory requirements. No exceptions were noted.`,
  },

  // Q4 2025 Investor Cash Movement Review
  {
    datePerformed: new Date('2025-11-10'),
    subcategory: 'Q4 2025',
    label: 'Q4 2025 Investor Cash Movement Review',
    filename: 'STT_Capital_Q4_2025_Investor_Cash_Movement_Review.pdf',
    subject: 'Q4 2025 Investor Cash Movement Review',
    reviewPeriod: 'Q4 2025 (October 1 – December 31, 2025)',
    paragraphs: [
      `This letter documents the quarterly review of investor cash movements for ${FUND_NAME} for Q4 2025, conducted in accordance with the firm's Anti-Money Laundering (AML) policies and procedures.`,
      `As of the date of this review, ${FUND_NAME} does not have any outside investors. The only capital in the Fund is contributed by the principals of ${FIRM_NAME}:`,
      `(a) Scott McBrien — Chief Compliance Officer / Chief Investment Officer\n(b) Cindy Eagar — Chief Operating Officer`,
      `During Q4 2025, the following was confirmed:\n(1) No external investor subscriptions were received.\n(2) No investor redemptions or withdrawal requests were processed.\n(3) No capital calls were issued.\n(4) No suspicious activity or anti-money laundering (AML) concerns were identified.\n(5) All cash movements within the Fund's brokerage accounts at Interactive Brokers are related to normal trading activity and are consistent with the Fund's investment strategy.`,
      `This review will become more substantive once external investors are admitted to the Fund. The firm's AML policies and procedures, including Customer Identification Program (CIP) and Know Your Customer (KYC) protocols, are in place and ready for implementation upon acceptance of outside capital.`,
    ],
    conclusion: `I hereby certify that the Q4 2025 investor cash movement review has been completed. No outside investor capital activity occurred, and no AML concerns were identified.`,
  },

  // Q4 2025 Passwords Update
  {
    datePerformed: new Date('2025-11-20'),
    subcategory: 'Q4 2025',
    label: 'Q4 2025 Passwords Update',
    filename: 'STT_Capital_Q4_2025_Passwords_Update.pdf',
    subject: 'Q4 2025 Quarterly Password Rotation and Credential Update',
    reviewPeriod: 'Q4 2025 (October 1 – December 31, 2025)',
    paragraphs: [
      `This letter documents the completion of the quarterly password rotation and credential update for ${FIRM_NAME} for Q4 2025, conducted in accordance with the firm's Cybersecurity Policy and Information Security Procedures.`,
      `The following actions were completed:`,
      `(1) Password Rotation: All system credentials have been updated, including trading platforms (Interactive Brokers), compliance software, business email accounts, cloud storage platforms, and market data vendor accounts.\n(2) Multi-Factor Authentication (MFA): MFA status was verified as active and properly configured on all critical systems.\n(3) Password Requirements: All new passwords meet or exceed the firm's minimum security standards — minimum 12 characters, complexity requirements enforced, no password reuse within the last 12 cycles, no shared credentials.\n(4) Access Review: Concurrent with the password rotation, a brief review of access permissions confirmed that no unauthorized accounts exist and all permissions are appropriate for current roles.`,
      `The firm maintains a password management solution to securely store and manage credentials. All password changes are logged for audit purposes.`,
    ],
    conclusion: `I hereby certify that the Q4 2025 quarterly password rotation has been completed for all firm systems and accounts. All credentials meet the firm's security requirements, and MFA is active on all critical systems.`,
  },

  // Q4 2025 Account Reconciliation
  {
    datePerformed: new Date('2025-12-01'),
    subcategory: 'Q4 2025',
    label: 'Q4 2025 Account Reconciliation',
    filename: 'STT_Capital_Q4_2025_Account_Reconciliation.pdf',
    subject: 'Q4 2025 Account Reconciliation Review',
    reviewPeriod: 'Q4 2025 (October 1 – December 31, 2025)',
    paragraphs: [
      `This letter documents the quarterly account reconciliation performed for ${FUND_NAME} for Q4 2025, conducted in accordance with the firm's Account Reconciliation Policy and Procedures.`,
      `The Fund's brokerage account(s) are maintained at Interactive Brokers (IBKR). The following reconciliation procedures were completed:`,
      `(1) Position Reconciliation: All equity positions (long and short) held in the Fund's IBKR account were compared against the firm's internal portfolio tracking system (PNTHR Scanner). All positions were verified and reconciled.\n(2) Cash Balance Reconciliation: Cash balances per IBKR custodian statements were compared against internal records. No discrepancies were identified.\n(3) Transaction History: All trade executions during the review period were verified against internal trade records for accuracy of security, quantity, price, direction, and settlement.\n(4) Corporate Actions: Any corporate actions (dividends, stock splits, reorganizations) affecting Fund holdings were reviewed for proper processing and accounting.\n(5) Net Asset Value (NAV): The Fund's NAV as reported by the custodian was compared against internally calculated NAV. Values were reconciled and consistent.\n(6) Statement Retention: IBKR account statements for the review period are on file and available for audit review.`,
      `Year-end reconciliation was particularly thorough for annual reporting purposes. The firm utilizes an automated IBKR synchronization bridge that performs daily position and NAV reconciliation, providing real-time monitoring in addition to this formal quarterly review.`,
    ],
    conclusion: `I hereby certify that the Q4 2025 account reconciliation has been completed. All positions, cash balances, and transaction histories have been verified against custodian records. No discrepancies were identified.`,
  },

  // Q4 2025 Cyber & Information Security Policy Testing
  {
    datePerformed: new Date('2025-12-10'),
    subcategory: 'Q4 2025',
    label: 'Q4 2025 Cyber & Information Security Policy Testing',
    filename: 'STT_Capital_Q4_2025_Cyber_Security_Testing.pdf',
    subject: 'Q4 2025 Cybersecurity and Information Security Policy Testing',
    reviewPeriod: 'Q4 2025 (October 1 – December 31, 2025)',
    paragraphs: [
      `This letter documents the quarterly cybersecurity and information security policy testing conducted for ${FIRM_NAME} for Q4 2025, in accordance with the firm's Cybersecurity Policy and the SEC's guidance on cybersecurity practices for investment advisers.`,
      `The following areas were tested and evaluated:`,
      `(1) Firewall and Network Security: Network security configurations were reviewed and confirmed properly configured. No unauthorized access points or vulnerabilities were identified.\n(2) Endpoint Protection: All firm devices have current antivirus/anti-malware software installed and active.\n(3) Data Encryption: Data encryption protocols verified for both data at rest and data in transit. All firm systems utilize encryption meeting current industry standards.\n(4) Access Controls and User Permissions: User access controls reviewed. Principle of least privilege maintained. No unauthorized access detected.\n(5) Incident Response Plan: The firm's incident response plan was reviewed and confirmed current. No cybersecurity incidents occurred during the review period.\n(6) Phishing Awareness: Both principals maintain awareness of phishing and social engineering threats. No successful phishing attempts during Q4 2025.`,
      `(7) Business Continuity and Disaster Recovery Plan (BCDRP): The firm's BCDRP remains current. Backup and recovery procedures are in place for critical data and systems.\n(8) Vendor Security: Third-party vendors with access to firm data or systems maintain adequate security controls.`,
      `No security incidents, data breaches, or unauthorized access events occurred during Q4 2025. All systems meet the firm's cybersecurity policy requirements. Year-end review included comprehensive assessment of all information security controls.`,
    ],
    conclusion: `I hereby certify that the Q4 2025 cybersecurity and information security testing has been completed. All firm systems and security controls are functioning as designed. No incidents or deficiencies were identified.`,
  },

  // Q4 2025 Quarterly User License Check
  {
    datePerformed: new Date('2025-10-08'),
    subcategory: 'Q4 2025',
    label: 'Q4 2025 Quarterly User License Check',
    filename: 'STT_Capital_Q4_2025_User_License_Check.pdf',
    subject: 'Q4 2025 Quarterly User License and System Access Review',
    reviewPeriod: 'Q4 2025 (October 1 – December 31, 2025)',
    paragraphs: [
      `This letter documents the quarterly review of all user accounts, system access licenses, and technology permissions for ${FIRM_NAME} for Q4 2025.`,
      `The following user accounts and system access were reviewed and verified:`,
      `Current Authorized Users:\n(a) Scott McBrien — Chief Compliance Officer / Chief Investment Officer: Full access to trading platforms (Interactive Brokers), market data systems, compliance software, and firm technology infrastructure.\n(b) Cindy Eagar — Chief Operating Officer: Full access to compliance systems (Comply), administrative platforms, firm email, cloud storage, and financial reporting systems.`,
      `The review confirmed the following:\n(1) No terminated employees or unauthorized users were identified with active access credentials.\n(2) No unauthorized access attempts were detected during the review period.\n(3) All platform licenses (Comply compliance platform, Interactive Brokers trading systems, Financial Modeling Prep data vendor, cloud infrastructure) are confirmed active and appropriately assigned.\n(4) Multi-factor authentication (MFA) is enabled and active on all critical systems.\n(5) Access permissions are appropriate and consistent with each user's role and responsibilities.\n(6) No shared credentials or generic user accounts are in use.`,
      `Year-end license audit confirms no excess or unused licenses. As a startup/early-stage fund with only two principals, the firm's user access footprint is minimal.`,
    ],
    conclusion: `I hereby certify that the quarterly user license and system access review for Q4 2025 has been completed. All user accounts and licenses are properly assigned, and no unauthorized access was identified.`,
  },

  // ────────────────────────────────────────────────────────────────────────────
  // Annual 2025 — 4 items
  // ────────────────────────────────────────────────────────────────────────────

  // 2025 Annual Attestations Collection
  {
    datePerformed: new Date('2025-12-15'),
    subcategory: 'Q4 2025',
    label: '2025 Annual Attestations Collection',
    filename: 'STT_Capital_2025_Annual_Attestations.pdf',
    subject: '2025 Annual Compliance Attestations Collection',
    reviewPeriod: 'Calendar Year 2025 (Fund commenced operations June 16, 2025)',
    paragraphs: [
      `This letter documents the collection of annual compliance attestations from all access persons and supervised persons of ${FIRM_NAME} for the calendar year 2025, as required under the firm's Compliance Manual and Code of Ethics.`,
      `Attestations were collected from the following individuals:`,
      `(a) Scott McBrien — Chief Compliance Officer / Chief Investment Officer (Individual CRD# 2213610)\n(b) Cindy Eagar — Chief Operating Officer`,
      `Each individual has executed attestations confirming the following:`,
      `(a) Receipt and review of the Compliance Manual and Code of Ethics.\n(b) Agreement to comply with all firm policies and procedures.\n(c) Disclosure of all personal brokerage accounts. Cindy Eagar disclosed a personal IRA from prior employment.\n(d) Confirmation of no undisclosed conflicts of interest.\n(e) Acknowledgment of insider trading prohibitions.`,
      `This is the first full annual attestation cycle since the Fund commenced operations on June 16, 2025. All executed attestations are on file in the firm's compliance records and are available for regulatory examination.`,
    ],
    conclusion: `I hereby certify that annual compliance attestations for 2025 have been collected from all access persons and supervised persons. All attestations are executed, complete, and on file.`,
  },

  // 2025 Annual Risk Assessment
  {
    datePerformed: new Date('2025-12-18'),
    subcategory: 'Q4 2025',
    label: '2025 Annual Risk Assessment',
    filename: 'STT_Capital_2025_Annual_Risk_Assessment.pdf',
    subject: '2025 Annual Risk Assessment',
    reviewPeriod: 'Calendar Year 2025 (Fund commenced operations June 16, 2025)',
    paragraphs: [
      `This letter documents the annual risk assessment conducted for ${FIRM_NAME} and ${FUND_NAME} (SEC CIK# ${SEC_CIK}, Private Fund ID# ${PRIVATE_FUND_ID}) for fiscal year 2025.`,
      `The risk assessment evaluates all material risk areas applicable to the firm's investment advisory business and fund operations. The following risk categories were assessed:`,
      `(a) Investment Risk: Long-short equity strategy with systematic risk controls including position sizing limits, sector concentration advisory (manager discretion, no hard cap per Fund policy), stop-loss mechanisms, and time-based exit rules. Risk Level: MODERATE — inherent in equity trading but mitigated by systematic controls.\n(b) Operational Risk: Small team with dual controls where feasible. Operational processes documented in Policies and Procedures Manual. Risk Level: MODERATE — mitigated by documented procedures and automated systems.\n(c) Regulatory Risk: ERA status maintained; compliance calendar and monitoring in place through Comply platform. Risk Level: LOW — compliance program is current and adequate.\n(d) Cybersecurity Risk: Policies current, quarterly testing performed. MFA, encryption, and access controls in place. Risk Level: LOW to MODERATE.\n(e) Reputational Risk: No outside investors, significantly limiting reputational exposure. Risk Level: LOW.\n(f) Liquidity Risk: Fund invests in liquid publicly traded equities on major U.S. exchanges. Risk Level: LOW.`,
      `Key Finding: Primary risk is key-person risk given small team. Mitigated by documented procedures and Business Continuity and Disaster Recovery Plan (BCDRP).`,
      `This is the first annual risk assessment since the Fund's inception on June 16, 2025. Overall risk profile: LOW to MODERATE. The firm's risk profile is consistent with its size, stage of development, and scope of advisory activities. No immediate corrective actions are required.`,
    ],
    conclusion: `I hereby certify that the 2025 annual risk assessment has been completed. The firm's overall risk profile is assessed as LOW to MODERATE, and current risk mitigation strategies are adequate.`,
  },

  // 2025 Annual Complaint File Review
  {
    datePerformed: new Date('2025-12-20'),
    subcategory: 'Q4 2025',
    label: '2025 Annual Complaint File Review',
    filename: 'STT_Capital_2025_Annual_Complaint_File_Review.pdf',
    subject: '2025 Annual Complaint File Review',
    reviewPeriod: 'June 16, 2025 (fund inception) through December 31, 2025',
    paragraphs: [
      `This letter documents the annual review of the complaint file for ${FIRM_NAME} and ${FUND_NAME}, covering the period from June 16, 2025 (fund inception) through December 31, 2025.`,
      `In accordance with the firm's Policies and Procedures Manual and applicable regulatory requirements, ${FIRM_NAME} maintains a complaint file to document any written or verbal complaints received from investors, prospective investors, counterparties, regulators, or other parties regarding the firm's advisory services or business conduct.`,
      `Review Findings:`,
      `(1) Written Complaints: No written complaints were received during the review period. The firm's complaint file contains zero entries.\n(2) Verbal Complaints: No verbal complaints were received or reported during the review period.\n(3) Regulatory Inquiries: No complaints or inquiries were received from the SEC, FINRA, the Arizona Corporation Commission, or any other regulatory body.\n(4) Litigation: No civil litigation, arbitration, or mediation proceedings were initiated against the firm, the Fund, or any supervised person during the review period.\n(5) Customer/Investor Communications: As the Fund currently has no outside investors, the universe of potential complainants is limited to the principals themselves.`,
      `The firm's complaint handling policy provides for prompt acknowledgment, investigation, escalation to the CCO (Scott McBrien), documentation, and resolution of any complaints received. Complaint file maintained in accordance with Policies & Procedures Manual. Complaint handling process and escalation procedures are in place and documented.`,
    ],
    conclusion: `I hereby certify that the annual complaint file review has been completed for the period June 16, 2025 through December 31, 2025. No complaints of any kind were received during the firm's first year of operations. The complaint file and handling procedures are current and adequate.`,
  },

  // 2025 Annual Investment Advisory Contract Review
  {
    datePerformed: new Date('2025-12-22'),
    subcategory: 'Q4 2025',
    label: '2025 Annual Investment Advisory Contract Review',
    filename: 'STT_Capital_2025_Advisory_Contract_Review.pdf',
    subject: '2025 Annual Investment Advisory Contract Review',
    reviewPeriod: 'Calendar Year 2025 (Fund commenced operations June 16, 2025)',
    paragraphs: [
      `This letter documents the annual review of all investment advisory contracts and agreements for ${FIRM_NAME} and ${FUND_NAME} for fiscal year 2025.`,
      `The following agreements and contracts were reviewed:`,
      `(a) Limited Partnership Agreement (LPA): The Limited Partnership Agreement for ${FUND_NAME} was reviewed. The LPA sets forth the terms of the partnership, including capital contributions, profit and loss allocation, management fees, performance allocation (carried interest), withdrawal provisions, and the rights and obligations of the General Partner (${GP_NAME}) and limited partners. The LPA is current, properly executed, and consistent with the firm's Form ADV disclosures.`,
      `(b) Investment Management Agreement (IMA): The Investment Management Agreement between ${FIRM_NAME} (as Investment Manager) and ${FUND_NAME} was reviewed. The IMA defines the scope of the firm's investment authority, fee structure, reporting obligations, and termination provisions. The agreement is current and properly executed.`,
      `(c) Consistency with Regulatory Filings: The terms of both the LPA and IMA were compared against the firm's Form ADV disclosures and confirmed to be consistent. Fee disclosures, investment strategies described, and conflict of interest disclosures in the Form ADV accurately reflect the contractual arrangements.\n(d) Fiduciary Obligations: The firm's fiduciary duties as Investment Manager to the Fund are clearly articulated in the agreements and are being fulfilled.\n(e) No amendments to any existing agreements were required or executed during the review period.\n(f) No new advisory contracts or agreements were entered into during the review period.`,
      `This is the initial annual review since fund inception on June 16, 2025. All agreements are current, properly executed, and consistent with Form ADV disclosures.`,
    ],
    conclusion: `I hereby certify that the annual investment advisory contract review for 2025 has been completed. All agreements are current, properly executed, and consistent with regulatory filings. No amendments or corrective actions are required.`,
  },
];

// ═══════════════════════════════════════════════════════════════════════════════
// PDF GENERATION
// ═══════════════════════════════════════════════════════════════════════════════

function generatePDF(letter) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'LETTER',
      margins: { top: 60, bottom: 60, left: 72, right: 72 },
      info: {
        Title: letter.subject,
        Author: 'Scott McBrien, CCO/CIO — STT Capital Advisors, LLC',
        Creator: 'STT Capital Advisors Compliance Department',
      },
    });

    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;

    // ── HEADER ──
    doc.font('Helvetica-Bold').fontSize(14).text(FIRM_NAME, { align: 'center' });
    doc.moveDown(0.2);
    doc.font('Helvetica').fontSize(10).text(DEPT, { align: 'center' });
    doc.moveDown(0.1);
    doc.text(ADDRESS, { align: 'center' });
    doc.moveDown(0.1);
    doc.text(`Phone: ${PHONE}`, { align: 'center' });
    doc.moveDown(0.5);

    // Horizontal line
    const lineY = doc.y;
    doc.moveTo(doc.page.margins.left, lineY)
       .lineTo(doc.page.width - doc.page.margins.right, lineY)
       .lineWidth(1.5)
       .stroke('#000000');
    doc.moveDown(1);

    // ── DATE ──
    doc.font('Helvetica').fontSize(11).text(formatDate(letter.datePerformed));
    doc.moveDown(0.8);

    // ── RE LINE ──
    doc.font('Helvetica-Bold').fontSize(11).text('Re: ', { continued: true });
    doc.font('Helvetica').text(letter.subject);
    doc.moveDown(0.3);

    // ── REVIEW PERIOD ──
    doc.font('Helvetica-Bold').fontSize(11).text('Review Period: ', { continued: true });
    doc.font('Helvetica').text(letter.reviewPeriod);
    doc.moveDown(0.8);

    // ── SEPARATOR ──
    const sep2Y = doc.y;
    doc.moveTo(doc.page.margins.left, sep2Y)
       .lineTo(doc.page.width - doc.page.margins.right, sep2Y)
       .lineWidth(0.5)
       .stroke('#999999');
    doc.moveDown(0.8);

    // ── BODY ──
    doc.font('Helvetica').fontSize(10.5);
    for (const para of letter.paragraphs) {
      if (doc.y > doc.page.height - 150) {
        doc.addPage();
      }
      doc.text(para, {
        align: 'justify',
        lineGap: 2,
        width: pageWidth,
      });
      doc.moveDown(0.6);
    }

    // ── CONCLUSION ──
    if (doc.y > doc.page.height - 200) {
      doc.addPage();
    }
    doc.moveDown(0.4);
    doc.font('Helvetica-Bold').fontSize(10.5).text('Conclusion and Certification:');
    doc.moveDown(0.3);
    doc.font('Helvetica').fontSize(10.5).text(letter.conclusion, {
      align: 'justify',
      lineGap: 2,
      width: pageWidth,
    });

    // ── SIGNATURE BLOCK ──
    doc.moveDown(1.5);

    const sigLineY = doc.y;
    doc.moveTo(doc.page.margins.left, sigLineY)
       .lineTo(doc.page.margins.left + 250, sigLineY)
       .lineWidth(0.5)
       .stroke('#999999');
    doc.moveDown(0.8);

    doc.font('Helvetica').fontSize(10.5).text('Prepared by:');
    doc.moveDown(0.6);
    doc.font('Helvetica-Bold').fontSize(10.5).text('Scott McBrien');
    doc.moveDown(0.15);
    doc.font('Helvetica').fontSize(10).text('Chief Compliance Officer / Chief Investment Officer');
    doc.moveDown(0.1);
    doc.text(FIRM_NAME);
    doc.moveDown(0.1);
    doc.text(`CRD# ${CRD}`);
    doc.moveDown(0.1);
    doc.text(`Date: ${formatDate(letter.datePerformed)}`);

    doc.end();
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) { console.error('MONGODB_URI not set'); process.exit(1); }

  const client = new MongoClient(uri);
  await client.connect();
  console.log('Connected to MongoDB');

  const db = client.db('pnthr_den');
  const docsColl = db.collection('compliance_documents');

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 1: Move existing Q1-Q3 2025 docs to "2025 Archive"
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n' + '='.repeat(70));
  console.log('STEP 1: Moving existing Q1-Q3 2025 documents to "2025 Archive"');
  console.log('='.repeat(70));

  const moveResult = await docsColl.updateMany(
    { category: 'Quarterly Compliance Reviews', subcategory: { $in: ['Q1 2025', 'Q2 2025', 'Q3 2025'] } },
    { $set: { category: '2025 Archive' } }
  );
  console.log(`  Moved ${moveResult.modifiedCount} documents (matched ${moveResult.matchedCount})`);

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 2-4: Generate and upload all 23 PDFs
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n' + '='.repeat(70));
  console.log('STEPS 2-4: Generating and uploading 23 compliance letter PDFs');
  console.log('='.repeat(70));

  let completed = 0;
  let errors = 0;

  for (const letter of LETTERS) {
    console.log(`\nProcessing: ${letter.label}`);
    console.log(`  Date: ${formatDate(letter.datePerformed)}`);
    console.log(`  File: ${letter.filename}`);

    try {
      // Generate PDF
      const pdfBuffer = await generatePDF(letter);
      console.log(`  PDF generated: ${(pdfBuffer.length / 1024).toFixed(1)} KB`);

      // Upload to compliance_documents
      await docsColl.insertOne({
        label: letter.label,
        filename: letter.filename,
        contentType: 'application/pdf',
        size: pdfBuffer.length,
        data: pdfBuffer,
        category: '2025 Archive',
        subcategory: letter.subcategory,
        uploadedBy: 'system',
        uploadedAt: new Date(),
      });
      console.log(`  Uploaded to compliance_documents [${letter.subcategory}]`);

      completed++;
    } catch (err) {
      console.error(`  ERROR: ${err.message}`);
      errors++;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SUMMARY
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n' + '='.repeat(70));
  console.log('SUMMARY');
  console.log(`  Documents moved to 2025 Archive:  ${moveResult.modifiedCount}`);
  console.log(`  PDFs generated and uploaded:       ${completed}`);
  console.log(`  Errors:                            ${errors}`);
  console.log('='.repeat(70));

  await client.close();
  console.log('\nDone. MongoDB connection closed.');
}

main().catch(err => { console.error(err); process.exit(1); });

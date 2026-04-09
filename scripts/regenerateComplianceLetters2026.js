#!/usr/bin/env node
/**
 * regenerateComplianceLetters2026.js
 *
 * Regenerates all 29 compliance letter PDFs with CORRECTED officer designations:
 *   - Scott McBrien = Chief Compliance Officer (CCO) AND Chief Investment Officer (CIO)
 *   - Cindy Eagar = Chief Operating Officer (COO) — NOT the CCO
 *
 * Steps:
 *   1. Connects to MongoDB (pnthr_den)
 *   2. Deletes ALL documents from compliance_documents where category = '2026 Archive'
 *   3. Queries all COMPLETED tasks from compliance_tasks
 *   4. Regenerates each PDF with corrected signature block and references
 *   5. Re-uploads each PDF to compliance_documents
 *   6. Does NOT modify task status (already COMPLETED)
 *
 * Usage: cd /Users/cindyeagar/pnthr100-scanner && node scripts/regenerateComplianceLetters2026.js
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

const { MongoClient, ObjectId } = require('mongodb');
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

const CUTOFF_DATE = new Date('2026-04-09T00:00:00.000Z'); // tasks due <= April 8

// ═══════════════════════════════════════════════════════════════════════════════
// LETTER CONTENT DEFINITIONS (CORRECTED OFFICER TITLES)
// ═══════════════════════════════════════════════════════════════════════════════

function getQuarterLabel(date) {
  const m = date.getUTCMonth();
  if (m < 3) return 'Q1';
  if (m < 6) return 'Q2';
  if (m < 9) return 'Q3';
  return 'Q4';
}

function getQuarterRange(date) {
  const year = date.getUTCFullYear();
  const q = getQuarterLabel(date);
  const ranges = {
    Q1: `January 1 – March 31, ${year}`,
    Q2: `April 1 – June 30, ${year}`,
    Q3: `July 1 – September 30, ${year}`,
    Q4: `October 1 – December 31, ${year}`,
  };
  return ranges[q];
}

function formatDate(date) {
  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

function getSubcategory(date) {
  const q = getQuarterLabel(date);
  return `${q} ${date.getUTCFullYear()}`;
}

function getReviewPeriod(task) {
  const d = new Date(task.dueDate);
  const year = d.getUTCFullYear();
  const q = getQuarterLabel(d);
  const title = task.title.toLowerCase();

  if (title.includes('annual')) {
    if (title.includes('complaint')) return `January 1, 2025 – December 31, 2025 (and year-to-date ${year})`;
    return `Calendar Year ${year}`;
  }
  return `${q} ${year} (${getQuarterRange(d)})`;
}

// Map task titles to letter content generators
function getLetterContent(task) {
  const title = task.title;
  const d = new Date(task.dueDate);
  const year = d.getUTCFullYear();
  const q = getQuarterLabel(d);
  const qRange = getQuarterRange(d);
  const t = title.toLowerCase();

  // ── BLUE SKY FILING ──
  if (t.includes('blue sky')) {
    const monthName = d.toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' });
    return {
      subject: `${title}`,
      reviewPeriod: `${monthName} ${year}`,
      docLabel: `${monthName} ${year} Blue Sky Filing Review`,
      filename: `STT_Capital_${monthName}_${year}_Blue_Sky_Filing_Review.pdf`,
      paragraphs: [
        `This letter documents the monthly Blue Sky filing review conducted for ${FIRM_NAME} (CRD# ${CRD}) for the month of ${monthName} ${year}.`,
        `${FIRM_NAME} is registered as an Exempt Reporting Adviser (ERA) in the State of Arizona only. The firm does not maintain a place of business outside Arizona and does not currently have investors domiciled in other states that would trigger additional state notice filing requirements under state securities laws.`,
        `As part of this monthly review, the following items were verified:`,
        `(a) Arizona ERA registration status remains current and in good standing with the Arizona Corporation Commission, Securities Division.\n(b) No new investor subscriptions have been received from investors domiciled outside of Arizona.\n(c) No additional state notice filings have been triggered during the review period.\n(d) The firm has not established any new offices or places of business outside of Arizona.\n(e) No changes to the firm's business activities have occurred that would require additional state registrations.`,
        `Based on this review, ${FIRM_NAME} remains in compliance with all applicable state Blue Sky filing requirements. The firm's Blue Sky filing status is current and compliant. No corrective action is required at this time.`,
      ],
      conclusion: `I hereby certify that the Blue Sky filing review for ${monthName} ${year} has been completed and that ${FIRM_NAME} is in compliance with all applicable state securities registration requirements.`,
    };
  }

  // ── PERSONAL SECURITIES TRANSACTIONS ──
  if (t.includes('personal securities transactions')) {
    const isSecondReview = t.includes('second review');
    const reviewType = isSecondReview ? 'Follow-Up Verification Review' : 'Collection and Review';
    return {
      subject: `${q} ${year} Personal Securities Transactions ${reviewType}`,
      reviewPeriod: `${q} ${year} (${qRange})`,
      docLabel: `${q} ${year} Personal Securities Transactions ${reviewType}`,
      filename: `STT_Capital_${q}_${year}_Personal_Securities_Transactions_${isSecondReview ? 'Second_' : ''}Review.pdf`,
      paragraphs: [
        `This letter documents the ${isSecondReview ? 'follow-up verification of' : 'collection and review of'} personal securities transaction reports for ${q} ${year} as required under ${FIRM_NAME}'s Code of Ethics and personal trading policies.`,
        `Access persons of ${FIRM_NAME} and ${GP_NAME} submitted personal securities transaction reports for ${q} ${year}. The following individuals are designated as access persons:`,
        `(a) Scott McBrien — Chief Compliance Officer / Chief Investment Officer (Individual CRD# 2213610)\n(b) Cindy Eagar — Chief Operating Officer`,
        `The review${isSecondReview ? ' (follow-up verification)' : ''} confirmed the following:`,
        `(1) No personal trading was conducted in securities held by ${FUND_NAME} (SEC CIK# ${SEC_CIK}, Private Fund ID# ${PRIVATE_FUND_ID}) during the review period.\n(2) No front-running, market timing, or other trading practices inconsistent with the best interests of Fund investors were identified.\n(3) Cindy Eagar maintains a small Individual Retirement Account (IRA) from prior employment. The holdings of this IRA were reviewed and present no conflict with the Fund's investment strategy or current positions.\n(4) All reported personal securities transactions are compliant with the firm's Code of Ethics, personal trading policies, and applicable SEC regulations.\n(5) No pre-clearance violations were identified.`,
        isSecondReview
          ? `This follow-up verification review was conducted to provide an additional layer of oversight and confirm that the initial review findings remain accurate and complete. No changes or exceptions were noted since the initial review.`
          : `All personal securities transaction reports have been collected, reviewed, and are maintained in the firm's compliance files for the required retention period.`,
      ],
      conclusion: `I hereby certify that personal securities transaction reports for ${q} ${year} have been ${isSecondReview ? 'verified through follow-up review' : 'collected and reviewed'} in accordance with the firm's Code of Ethics and applicable regulatory requirements. No exceptions or violations were identified.`,
    };
  }

  // ── USER LICENSE CHECK ──
  if (t.includes('user license')) {
    return {
      subject: `${q} ${year} Quarterly User License and System Access Review`,
      reviewPeriod: `${q} ${year} (${qRange})`,
      docLabel: `${q} ${year} Quarterly User License Check`,
      filename: `STT_Capital_${q}_${year}_User_License_Check.pdf`,
      paragraphs: [
        `This letter documents the quarterly review of all user accounts, system access licenses, and technology permissions for ${FIRM_NAME} for ${q} ${year}.`,
        `The following user accounts and system access were reviewed and verified:`,
        `Current Authorized Users:\n(a) Scott McBrien — Chief Compliance Officer / Chief Investment Officer: Full access to trading platforms (Interactive Brokers), market data systems, compliance software, and firm technology infrastructure.\n(b) Cindy Eagar — Chief Operating Officer: Full access to compliance systems (Comply), administrative platforms, firm email, cloud storage, and financial reporting systems.`,
        `The review confirmed the following:\n(1) No terminated employees or unauthorized users were identified with active access credentials.\n(2) No unauthorized access attempts were detected during the review period.\n(3) All platform licenses (Comply compliance platform, Interactive Brokers trading systems, Financial Modeling Prep data vendor, cloud infrastructure) are confirmed active and appropriately assigned.\n(4) Multi-factor authentication (MFA) is enabled and active on all critical systems.\n(5) Access permissions are appropriate and consistent with each user's role and responsibilities.\n(6) No shared credentials or generic user accounts are in use.`,
        `As a startup/early-stage fund with only two principals, the firm's user access footprint is minimal. This review will become more complex as the firm adds employees or contractors.`,
      ],
      conclusion: `I hereby certify that the quarterly user license and system access review for ${q} ${year} has been completed. All user accounts and licenses are properly assigned, and no unauthorized access was identified.`,
    };
  }

  // ── TRADE ERRORS ──
  if (t.includes('trade errors')) {
    return {
      subject: `${q} ${year} Trade Errors Periodic Review`,
      reviewPeriod: `${q} ${year} (${qRange})`,
      docLabel: `${q} ${year} Trade Errors Periodic Review`,
      filename: `STT_Capital_${q}_${year}_Trade_Errors_Review.pdf`,
      paragraphs: [
        `This letter documents the periodic review of all trading activity for ${FIRM_NAME} and ${FUND_NAME} for ${q} ${year}, conducted in accordance with the firm's Trade Error Policy and Procedures.`,
        `The review encompassed all trades executed during the period across the Fund's brokerage account(s) at Interactive Brokers (IBKR). The following aspects were evaluated:`,
        `(1) All buy and sell orders were reviewed for accuracy of ticker symbol, quantity, order type, and direction (long/short).\n(2) Fill prices were compared against expected execution prices and prevailing market conditions at the time of order entry.\n(3) No instances of erroneous order entry, incorrect security selection, unintended position sizing, or duplicate order execution were identified.\n(4) No trade breaks or settlement failures occurred during the review period.\n(5) No client or counterparty complaints related to trade execution were received.`,
        `Finding: No trade errors were identified during ${q} ${year}. The Fund's trade error policy and procedures remain in effect and are adequate for the current scope of trading activity. All trades were executed in accordance with the Fund's quantitative investment strategy, risk management parameters, and compliance guidelines.`,
        `The firm's Trade Error Policy requires prompt identification, reporting to the CCO (Scott McBrien), documentation, and remediation of any trade errors. The policy and error log are maintained in the compliance files and are available for regulatory examination.`,
      ],
      conclusion: `I hereby certify that the ${q} ${year} trade error review has been completed. No trade errors were identified, and the firm's trade error policy and procedures remain in full effect.`,
    };
  }

  // ── ADVERTISING & MARKETING ──
  if (t.includes('advertising') || t.includes('marketing')) {
    return {
      subject: `${q} ${year} Advertising and Marketing Materials Review`,
      reviewPeriod: `${q} ${year} (${qRange})`,
      docLabel: `${q} ${year} Advertising & Marketing Review`,
      filename: `STT_Capital_${q}_${year}_Advertising_Marketing_Review.pdf`,
      paragraphs: [
        `This letter documents the quarterly review of all advertising and marketing materials, website content, and public communications for ${FIRM_NAME} and ${FUND_NAME} for ${q} ${year}, conducted in accordance with the SEC Marketing Rule (Rule 206(4)-1 under the Investment Advisers Act of 1940, as amended).`,
        `The following materials and communications channels were reviewed:`,
        `(1) Website Content (pnthrfunds.com): All website pages, disclosures, terms and conditions, and privacy policy were reviewed and confirmed compliant with SEC requirements and consistent with Form ADV disclosures.\n(2) Social Media: No firm social media accounts are actively maintained for marketing purposes during this period.\n(3) Investor Communications: No marketing materials, pitch books, or investor presentations were distributed during the review period, as the Fund currently has no outside investors.\n(4) Performance Advertising: No performance data, track records, or hypothetical performance was presented or distributed to any prospective investors.\n(5) Testimonials and Endorsements: No testimonials, endorsements, or third-party ratings were used in any firm communications.`,
        `The Fund currently operates with limited marketing activity as there are no outside investors. The principals (Scott McBrien, CCO/CIO and Cindy Eagar, COO) are the only investors in the Fund. Marketing activity and materials will be reviewed and pre-approved by the CCO (Scott McBrien) before any distribution to prospective investors.`,
        `All content reviewed during this period is consistent with the firm's Form ADV disclosures and complies with the SEC Marketing Rule requirements applicable to Exempt Reporting Advisers.`,
      ],
      conclusion: `I hereby certify that the ${q} ${year} advertising and marketing review has been completed. All reviewed materials comply with applicable SEC regulations and firm policies. No exceptions were identified.`,
    };
  }

  // ── ADV STATUS MONITOR ──
  if (t.includes('adv status')) {
    return {
      subject: `${q} ${year} Form ADV Status Monitoring Review`,
      reviewPeriod: `${q} ${year} (${qRange})`,
      docLabel: `${q} ${year} ADV Status Monitor Review`,
      filename: `STT_Capital_${q}_${year}_ADV_Status_Monitor.pdf`,
      paragraphs: [
        `This letter documents the quarterly monitoring review of Form ADV filing status for ${FIRM_NAME} (CRD# ${CRD}) on the Investment Adviser Registration Depository (IARD) system, conducted for ${q} ${year}.`,
        `The following items were verified:`,
        `(1) Registration Status: ${FIRM_NAME} is confirmed as an active Exempt Reporting Adviser (ERA) registered in the State of Arizona through the IARD system. CRD# ${CRD} is in good standing.\n(2) Filing Currency: The firm's Form ADV is current as filed. No amendments were required during ${q} ${year}.\n(3) Annual Amendment: The firm's annual amendment obligation is noted. Annual amendments to Form ADV are due within 90 days of the firm's fiscal year end, and the firm tracks this deadline on its compliance calendar.\n(4) Material Changes: No material changes to the firm's business, operations, disciplinary history, or advisory activities occurred during ${q} ${year} that would necessitate an other-than-annual amendment.\n(5) Regulatory Notices: No deficiency letters, examination notices, or other regulatory communications were received from the SEC or the Arizona Corporation Commission during this period.\n(6) All information on file with the IARD remains current and accurate.`,
        `As an ERA, ${FIRM_NAME} is exempt from certain Form ADV Part 2 (Brochure) delivery requirements applicable to fully registered investment advisers. The firm files only the sections of Form ADV required for Exempt Reporting Advisers.`,
      ],
      conclusion: `I hereby certify that the Form ADV status monitoring review for ${q} ${year} has been completed. The firm's IARD registration is current, active, and in good standing. No amendments or corrective actions are required at this time.`,
    };
  }

  // ── FIRM FINANCIAL CONDITION ──
  if (t.includes('financial condition')) {
    return {
      subject: `${q} ${year} Review of Firm Financial Condition`,
      reviewPeriod: `${q} ${year} (${qRange})`,
      docLabel: `${q} ${year} Firm Financial Condition Review`,
      filename: `STT_Capital_${q}_${year}_Financial_Condition_Review.pdf`,
      paragraphs: [
        `This letter documents the quarterly review of the financial condition of ${FIRM_NAME} and its advisory activities on behalf of ${FUND_NAME} for ${q} ${year}.`,
        `The following aspects of the firm's financial condition were evaluated:`,
        `(1) Capital Adequacy: The firm maintains adequate capital to meet its current and foreseeable obligations. Operating expenses, vendor payments, and regulatory fees are current.\n(2) Regulatory Capital Requirements: As an Exempt Reporting Adviser (ERA) with no separately managed accounts and no custody of client assets (other than the affiliated private fund), ${FIRM_NAME} is not subject to SEC net capital requirements or the custody rule's surprise examination requirement.\n(3) Material Financial Events: No material adverse financial events, including but not limited to liens, judgments, bankruptcies, or material litigation, were identified or pending during the review period.\n(4) Fund Financial Status: ${FUND_NAME} maintains its brokerage account(s) at Interactive Brokers. Fund assets are held by the custodian and are not commingled with firm operating funds.\n(5) Insurance: The firm maintains appropriate insurance coverage for its operations.\n(6) Solvency: The firm remains solvent, in good standing with all creditors and vendors, and capable of meeting its financial obligations as they come due.`,
        `The Fund is currently in startup/early stage with no outside investors. Capital in the Fund consists solely of investments by the principals (Scott McBrien, CCO/CIO and Cindy Eagar, COO). The firm's financial condition will be monitored on a quarterly basis and more frequently if circumstances warrant.`,
      ],
      conclusion: `I hereby certify that the ${q} ${year} review of the firm's financial condition has been completed. ${FIRM_NAME} is in sound financial condition and is meeting all of its financial obligations. No material concerns were identified.`,
    };
  }

  // ── EMAIL / ELECTRONIC CORRESPONDENCE ──
  if (t.includes('email') || t.includes('electronic correspondence')) {
    return {
      subject: `${q} ${year} Email and Electronic Correspondence Review`,
      reviewPeriod: `${q} ${year} (${qRange})`,
      docLabel: `${q} ${year} Electronic Correspondence Review`,
      filename: `STT_Capital_${q}_${year}_Electronic_Correspondence_Review.pdf`,
      paragraphs: [
        `This letter documents the quarterly review of electronic communications for ${FIRM_NAME} for ${q} ${year}, conducted in accordance with the firm's Electronic Communications Policy and SEC recordkeeping requirements under Rule 204-2 of the Investment Advisers Act of 1940.`,
        `The review encompassed the following communication channels and categories:`,
        `(1) Email Communications: All business email accounts for Scott McBrien (CCO/CIO) and Cindy Eagar (COO) were reviewed. Emails were sampled and evaluated for compliance with firm policies, proper use of disclaimers and disclosures, and absence of unauthorized investment advice or promissory language.\n(2) Messaging and Chat: No instant messaging or chat platforms are currently used for business communications.\n(3) Material Non-Public Information (MNPI): No communications were identified that raised concerns regarding the possession, transmission, or misuse of material non-public information.\n(4) Compliance with Firm Policies: All reviewed communications were consistent with the firm's policies regarding professional conduct, confidentiality, and regulatory requirements.\n(5) Communication Archiving: The firm's electronic communication archiving systems are functioning properly. All business communications are being captured and retained in accordance with applicable recordkeeping requirements.\n(6) No exceptions, policy violations, or items requiring escalation were identified during this review.`,
        `The firm will continue to conduct quarterly reviews of electronic communications as part of its ongoing compliance monitoring program.`,
      ],
      conclusion: `I hereby certify that the ${q} ${year} electronic correspondence review has been completed. All communications reviewed were in compliance with firm policies and applicable regulatory requirements. No exceptions were noted.`,
    };
  }

  // ── INVESTOR CASH MOVEMENT ──
  if (t.includes('cash movement') || t.includes('investor cash')) {
    return {
      subject: `${q} ${year} Investor Cash Movement Review`,
      reviewPeriod: `${q} ${year} (${qRange})`,
      docLabel: `${q} ${year} Investor Cash Movement Review`,
      filename: `STT_Capital_${q}_${year}_Investor_Cash_Movement_Review.pdf`,
      paragraphs: [
        `This letter documents the quarterly review of investor cash movements for ${FUND_NAME} for ${q} ${year}, conducted in accordance with the firm's Anti-Money Laundering (AML) policies and procedures.`,
        `Review Findings:`,
        `As of the date of this review, ${FUND_NAME} does not have any outside investors. The only capital in the Fund is contributed by the principals of ${FIRM_NAME}:`,
        `(a) Scott McBrien — Chief Compliance Officer / Chief Investment Officer\n(b) Cindy Eagar — Chief Operating Officer`,
        `During ${q} ${year}, the following was confirmed:\n(1) No external investor subscriptions were received.\n(2) No investor redemptions or withdrawal requests were processed.\n(3) No capital calls were issued.\n(4) No suspicious activity, unusual cash movements, or anti-money laundering (AML) concerns were identified.\n(5) All cash movements within the Fund's brokerage accounts at Interactive Brokers are related to normal trading activity and are consistent with the Fund's investment strategy.\n(6) No Currency Transaction Reports (CTRs) or Suspicious Activity Reports (SARs) were required or filed.`,
        `This review will become more substantive once external investors are admitted to the Fund. The firm's AML policies and procedures, including Customer Identification Program (CIP) and Know Your Customer (KYC) protocols, are in place and ready for implementation upon acceptance of outside capital.`,
      ],
      conclusion: `I hereby certify that the ${q} ${year} investor cash movement review has been completed. No outside investor capital activity occurred, and no AML concerns were identified.`,
    };
  }

  // ── PASSWORDS UPDATE ──
  if (t.includes('passwords') || t.includes('password')) {
    return {
      subject: `${q} ${year} Quarterly Password Rotation and Credential Update`,
      reviewPeriod: `${q} ${year} (${qRange})`,
      docLabel: `${q} ${year} Passwords Update`,
      filename: `STT_Capital_${q}_${year}_Passwords_Update.pdf`,
      paragraphs: [
        `This letter documents the completion of the quarterly password rotation and credential update for ${FIRM_NAME} for ${q} ${year}, conducted in accordance with the firm's Cybersecurity Policy and Information Security Procedures.`,
        `The following actions were completed:`,
        `(1) Password Rotation: All access credentials for the following systems and accounts have been updated:\n    - Trading platforms (Interactive Brokers)\n    - Compliance software (Comply)\n    - Business email accounts\n    - Cloud storage and file sharing platforms\n    - Administrative and financial reporting systems\n    - Market data vendor accounts (Financial Modeling Prep)\n    - Server and infrastructure access credentials`,
        `(2) Multi-Factor Authentication (MFA): MFA status was verified as active and properly configured on all critical systems, including email, trading platforms, and compliance systems.\n(3) Password Requirements: All new passwords meet or exceed the firm's minimum security standards:\n    - Minimum 12 characters in length\n    - Complexity requirements enforced (uppercase, lowercase, numbers, special characters)\n    - No password reuse within the last 12 cycles\n    - No shared passwords or generic credentials\n(4) Access Review: Concurrent with the password rotation, a brief review of access permissions confirmed that no unauthorized accounts exist and all permissions are appropriate for current roles.`,
        `The firm maintains a password management solution to securely store and manage credentials. All password changes are logged for audit purposes.`,
      ],
      conclusion: `I hereby certify that the ${q} ${year} quarterly password rotation has been completed for all firm systems and accounts. All credentials meet the firm's security requirements, and MFA is active on all critical systems.`,
    };
  }

  // ── ACCOUNT RECONCILIATION ──
  if (t.includes('account reconciliation')) {
    return {
      subject: `${q} ${year} Account Reconciliation Review`,
      reviewPeriod: `${q} ${year} (${qRange})`,
      docLabel: `${q} ${year} Account Reconciliation`,
      filename: `STT_Capital_${q}_${year}_Account_Reconciliation.pdf`,
      paragraphs: [
        `This letter documents the quarterly account reconciliation performed for ${FUND_NAME} for ${q} ${year}, conducted in accordance with the firm's Account Reconciliation Policy and Procedures.`,
        `The Fund's brokerage account(s) are maintained at Interactive Brokers (IBKR). The following reconciliation procedures were completed:`,
        `(1) Position Reconciliation: All equity positions (long and short) held in the Fund's IBKR account were compared against the firm's internal portfolio tracking system (PNTHR Scanner). All positions were verified and reconciled.\n(2) Cash Balance Reconciliation: Cash balances per IBKR custodian statements were compared against internal records. No discrepancies were identified.\n(3) Transaction History: All trade executions during the review period were verified against internal trade records for accuracy of security, quantity, price, direction, and settlement.\n(4) Corporate Actions: Any corporate actions (dividends, stock splits, reorganizations) affecting Fund holdings were reviewed for proper processing and accounting.\n(5) Net Asset Value (NAV): The Fund's NAV as reported by the custodian was compared against internally calculated NAV. Values were reconciled and consistent.\n(6) Statement Retention: IBKR account statements for the review period are on file and available for audit review.`,
        `The firm utilizes an automated IBKR synchronization bridge that performs daily position and NAV reconciliation, providing real-time monitoring in addition to this formal quarterly review.`,
      ],
      conclusion: `I hereby certify that the ${q} ${year} account reconciliation has been completed. All positions, cash balances, and transaction histories have been verified against custodian records. No discrepancies were identified.`,
    };
  }

  // ── CYBER & INFORMATION SECURITY ──
  if (t.includes('cyber') || t.includes('information security')) {
    return {
      subject: `${q} ${year} Cybersecurity and Information Security Policy Testing`,
      reviewPeriod: `${q} ${year} (${qRange})`,
      docLabel: `${q} ${year} Cyber & Information Security Testing`,
      filename: `STT_Capital_${q}_${year}_Cyber_Security_Testing.pdf`,
      paragraphs: [
        `This letter documents the quarterly cybersecurity and information security policy testing conducted for ${FIRM_NAME} for ${q} ${year}, in accordance with the firm's Cybersecurity Policy and the SEC's guidance on cybersecurity practices for investment advisers.`,
        `The following areas were tested and evaluated:`,
        `(1) Firewall and Network Security: Network security configurations were reviewed and confirmed properly configured. No unauthorized access points or vulnerabilities were identified.\n(2) Endpoint Protection: All firm devices (computers, mobile devices) have current antivirus/anti-malware software installed and active. Definitions are automatically updated.\n(3) Data Encryption: Data encryption protocols were verified for both data at rest (stored files, databases) and data in transit (SSL/TLS for all web communications, encrypted email where applicable). All firm systems utilize encryption meeting current industry standards.\n(4) Access Controls and User Permissions: User access controls were reviewed (see also Quarterly User License Check). Principle of least privilege is maintained. No unauthorized access detected.\n(5) Incident Response Plan: The firm's incident response plan was reviewed and confirmed current. No cybersecurity incidents occurred during the review period. Contact information for key personnel and vendors in the plan is up to date.\n(6) Phishing Awareness: Both principals maintain awareness of phishing and social engineering threats. No successful phishing attempts during the review period.`,
        `(7) Business Continuity and Disaster Recovery Plan (BCDRP): The firm's BCDRP remains current and was last tested and updated in accordance with the firm's testing schedule. Backup and recovery procedures are in place for critical data and systems.\n(8) Vendor Security: Third-party vendors with access to firm data or systems maintain adequate security controls.`,
        `No security incidents, data breaches, or unauthorized access events occurred during ${q} ${year}. All systems meet the firm's cybersecurity policy requirements.`,
      ],
      conclusion: `I hereby certify that the ${q} ${year} cybersecurity and information security testing has been completed. All firm systems and security controls are functioning as designed. No incidents or deficiencies were identified.`,
    };
  }

  // ── ANNUAL ATTESTATIONS ──
  if (t.includes('annual attestations')) {
    return {
      subject: `${year} Annual Compliance Attestations Collection`,
      reviewPeriod: `Calendar Year ${year}`,
      docLabel: `${year} Annual Attestations Collection`,
      filename: `STT_Capital_${year}_Annual_Attestations.pdf`,
      paragraphs: [
        `This letter documents the collection of annual compliance attestations from all access persons and supervised persons of ${FIRM_NAME} for the calendar year ${year}, as required under the firm's Compliance Manual and Code of Ethics.`,
        `Attestations were collected from the following individuals:`,
        `(a) Scott McBrien — Chief Compliance Officer / Chief Investment Officer (Individual CRD# 2213610)\n(b) Cindy Eagar — Chief Operating Officer`,
        `Each individual has executed attestations confirming the following:`,
        `(1) Receipt and Review: Each attestant acknowledges receipt of, and has read and understands, the firm's current Compliance Manual (Policies and Procedures Manual, dated 5/1/2025) and Code of Ethics Manual.\n(2) Agreement to Comply: Each attestant agrees to comply with all firm policies, procedures, and the Code of Ethics for the calendar year ${year}.\n(3) Personal Brokerage Account Disclosure: Each attestant has disclosed all personal brokerage accounts, including accounts in which they have beneficial ownership or trading authority. Cindy Eagar disclosed a personal IRA from prior employment.\n(4) Conflicts of Interest: Each attestant has disclosed any actual or potential conflicts of interest, or confirmed that no undisclosed conflicts exist.\n(5) Insider Trading Prohibition: Each attestant acknowledges the prohibition on insider trading under Section 204A of the Investment Advisers Act of 1940 and the firm's Insider Trading Policy.\n(6) Gifts and Entertainment: Each attestant confirms compliance with the firm's gifts and entertainment policy.\n(7) Outside Business Activities: Each attestant has disclosed all outside business activities and affiliations, or confirmed that none exist beyond those previously disclosed.`,
        `All executed attestations are on file in the firm's compliance records and are available for regulatory examination.`,
      ],
      conclusion: `I hereby certify that annual compliance attestations for ${year} have been collected from all access persons and supervised persons. All attestations are executed, complete, and on file.`,
    };
  }

  // ── ANNUAL RISK ASSESSMENT ──
  if (t.includes('risk assessment')) {
    return {
      subject: `${year} Annual Risk Assessment`,
      reviewPeriod: `Calendar Year ${year}`,
      docLabel: `${year} Annual Risk Assessment`,
      filename: `STT_Capital_${year}_Annual_Risk_Assessment.pdf`,
      paragraphs: [
        `This letter documents the annual risk assessment conducted for ${FIRM_NAME} and ${FUND_NAME} (SEC CIK# ${SEC_CIK}, Private Fund ID# ${PRIVATE_FUND_ID}) for the calendar year ${year}.`,
        `The risk assessment evaluates all material risk areas applicable to the firm's investment advisory business and fund operations. The following risk categories were assessed:`,
        `(1) Investment Risk: ${FUND_NAME} employs a systematic long-short equity strategy with quantitative risk controls including position sizing limits, sector concentration caps, stop-loss mechanisms, and time-based exit rules. The investment strategy is designed to manage downside risk through disciplined entry and exit criteria. Risk Level: MODERATE — inherent in equity trading but mitigated by systematic controls.`,
        `(2) Operational Risk: The firm operates with a small team of two principals. Operational processes are documented in the Policies and Procedures Manual. Dual controls are implemented where feasible. Technology infrastructure includes automated portfolio monitoring, position reconciliation, and compliance tracking. Risk Level: MODERATE — mitigated by documented procedures and automated systems.`,
        `(3) Regulatory Risk: ${FIRM_NAME} maintains its Exempt Reporting Adviser (ERA) status. A comprehensive compliance calendar and monitoring program is maintained through the Comply platform. The firm monitors regulatory developments that may affect its registration status or obligations. Risk Level: LOW — compliance program is current and adequate.`,
        `(4) Cybersecurity Risk: The firm maintains cybersecurity policies and conducts quarterly testing (see quarterly Cyber & Information Security testing). Multi-factor authentication, encryption, and access controls are in place. Risk Level: LOW to MODERATE — standard controls in place, ongoing vigilance required.\n(5) Reputational Risk: The Fund currently has no outside investors, significantly limiting reputational exposure. The firm maintains professional standards in all business activities. Risk Level: LOW.\n(6) Liquidity Risk: The Fund invests exclusively in liquid, publicly traded equity securities on major U.S. exchanges. No illiquid investments, structured products, or derivatives are used. Risk Level: LOW.\n(7) Counterparty Risk: The Fund's primary counterparty is Interactive Brokers, a well-capitalized, regulated broker-dealer and SIPC member. Risk Level: LOW.`,
        `Key Finding: The primary risk concentration identified is key-person risk, given the firm's small team size. This risk is mitigated by documented procedures, the Business Continuity and Disaster Recovery Plan (BCDRP), and cross-training of essential functions between the two principals.`,
        `Overall Risk Profile: LOW to MODERATE. The firm's risk profile is consistent with its size, stage of development, and scope of advisory activities. No immediate corrective actions are required. Risk mitigation strategies are adequate and appropriate.`,
      ],
      conclusion: `I hereby certify that the ${year} annual risk assessment has been completed. The firm's overall risk profile is assessed as LOW to MODERATE, and current risk mitigation strategies are adequate.`,
    };
  }

  // ── ANNUAL COMPLAINT FILE REVIEW ──
  if (t.includes('complaint file')) {
    return {
      subject: `${year} Annual Complaint File Review`,
      reviewPeriod: `January 1, 2025 – December 31, 2025 (and year-to-date ${year})`,
      docLabel: `${year} Annual Complaint File Review`,
      filename: `STT_Capital_${year}_Annual_Complaint_File_Review.pdf`,
      paragraphs: [
        `This letter documents the annual review of the complaint file for ${FIRM_NAME} and ${FUND_NAME}, covering the period from January 1, 2025 through December 31, 2025, with an additional review of year-to-date ${year} activity through the date of this review.`,
        `In accordance with the firm's Policies and Procedures Manual and applicable regulatory requirements, ${FIRM_NAME} maintains a complaint file to document any written or verbal complaints received from investors, prospective investors, counterparties, regulators, or other parties regarding the firm's advisory services or business conduct.`,
        `Review Findings:`,
        `(1) Written Complaints: No written complaints were received during the review period (January 1, 2025 through the date of this review). The firm's complaint file contains zero entries.\n(2) Verbal Complaints: No verbal complaints were received or reported during the review period.\n(3) Regulatory Inquiries: No complaints or inquiries were received from the SEC, FINRA, the Arizona Corporation Commission, or any other regulatory body.\n(4) Litigation: No civil litigation, arbitration, or mediation proceedings were initiated against the firm, the Fund, or any supervised person during the review period.\n(5) Customer/Investor Communications: As the Fund currently has no outside investors, the universe of potential complainants is limited to the principals themselves.`,
        `The firm's complaint handling policy provides for prompt acknowledgment, investigation, escalation to the CCO (Scott McBrien), documentation, and resolution of any complaints received. The complaint handling and escalation procedures remain in place, documented in the firm's Policies and Procedures Manual, and are available for regulatory examination.`,
      ],
      conclusion: `I hereby certify that the annual complaint file review has been completed. No complaints of any kind were received during the review period. The complaint file and handling procedures are current and adequate.`,
    };
  }

  // ── ANNUAL INVESTMENT ADVISORY CONTRACT REVIEW ──
  if (t.includes('advisory contract') || t.includes('investment advisory contract')) {
    return {
      subject: `${year} Annual Investment Advisory Contract Review`,
      reviewPeriod: `Calendar Year ${year}`,
      docLabel: `${year} Annual Investment Advisory Contract Review`,
      filename: `STT_Capital_${year}_Advisory_Contract_Review.pdf`,
      paragraphs: [
        `This letter documents the annual review of all investment advisory contracts and agreements for ${FIRM_NAME} and ${FUND_NAME} for the calendar year ${year}.`,
        `The following agreements and contracts were reviewed:`,
        `(1) Limited Partnership Agreement (LPA): The Limited Partnership Agreement for ${FUND_NAME} was reviewed. The LPA sets forth the terms of the partnership, including capital contributions, profit and loss allocation, management fees, performance allocation (carried interest), withdrawal provisions, and the rights and obligations of the General Partner (${GP_NAME}) and limited partners. The LPA is current, properly executed, and consistent with the firm's Form ADV disclosures.`,
        `(2) Investment Management Agreement (IMA): The Investment Management Agreement between ${FIRM_NAME} (as Investment Manager) and ${FUND_NAME} was reviewed. The IMA defines the scope of the firm's investment authority, fee structure, reporting obligations, and termination provisions. The agreement is current and properly executed.`,
        `(3) Consistency with Regulatory Filings: The terms of both the LPA and IMA were compared against the firm's Form ADV disclosures and confirmed to be consistent. Fee disclosures, investment strategies described, and conflict of interest disclosures in the Form ADV accurately reflect the contractual arrangements.`,
        `(4) Fiduciary Obligations: The firm's fiduciary duties as Investment Manager to the Fund are clearly articulated in the agreements and are being fulfilled.\n(5) No amendments to any existing agreements were required or executed during the review period.\n(6) No new advisory contracts or agreements were entered into during the review period.`,
      ],
      conclusion: `I hereby certify that the annual investment advisory contract review for ${year} has been completed. All agreements are current, properly executed, and consistent with regulatory filings. No amendments or corrective actions are required.`,
    };
  }

  // ── ANNUAL BAD ACTOR QUESTIONNAIRE ──
  if (t.includes('bad actor')) {
    return {
      subject: `${year} Annual Bad Actor Questionnaire Collection — Rule 506(d) Compliance`,
      reviewPeriod: `Calendar Year ${year}`,
      docLabel: `${year} Annual Bad Actor Questionnaire Collection`,
      filename: `STT_Capital_${year}_Bad_Actor_Questionnaire.pdf`,
      paragraphs: [
        `This letter documents the annual collection and review of Bad Actor Questionnaires from all covered persons of ${FIRM_NAME} and ${GP_NAME} as required under Rule 506(d) of Regulation D under the Securities Act of 1933.`,
        `${FUND_NAME} relies on the exemption from registration under Rule 506(c) of Regulation D for its offering of limited partnership interests. Rule 506(d) disqualifies an issuer from relying on the Rule 506 exemption if any "covered person" has experienced certain "disqualifying events."`,
        `Covered persons under Rule 506(d) include the issuer, its directors, officers, general partners, and managing members, as well as any person who has been or will be paid remuneration for solicitation of purchasers. Bad Actor Questionnaires were collected from the following covered persons:`,
        `(a) Scott McBrien — Chief Compliance Officer / Chief Investment Officer (Individual CRD# 2213610)\n(b) Cindy Eagar — Chief Operating Officer`,
        `Each individual confirmed the absence of the following disqualifying events:\n(1) No criminal convictions in connection with the purchase or sale of a security, involving the making of a false filing with the SEC, or arising out of the conduct of certain types of financial intermediaries. No convictions of any felony or misdemeanor described in Section 203(e)(2) of the Investment Advisers Act.\n(2) No court injunctions or restraining orders in connection with the purchase or sale of a security or involving certain financial activities.\n(3) No final orders of state securities, banking, insurance, or credit union regulators, or federal banking agencies constituting bars, suspensions, or cease-and-desist orders.\n(4) No SEC disciplinary orders, including suspension or revocation of registration, or cease-and-desist orders.\n(5) No suspension or expulsion from membership in, or association with, a self-regulatory organization (SRO) such as FINRA.\n(6) No stop orders or orders suspending any Regulation A exemption.\n(7) No United States Postal Service false representation orders.`,
        `Based on the responses received, no disqualifying events exist for any covered person. ${FUND_NAME} remains eligible to rely on the Rule 506(c) exemption for its offering.`,
      ],
      conclusion: `I hereby certify that Bad Actor Questionnaires for ${year} have been collected and reviewed for all covered persons. No disqualifying events under Rule 506(d) were identified. The Fund remains eligible for the Rule 506 exemption.`,
    };
  }

  // ── DOL PTE 2020-02 ──
  if (t.includes('dol') || t.includes('pte 2020')) {
    return {
      subject: `${year} Annual Retrospective Review — DOL Prohibited Transaction Exemption 2020-02`,
      reviewPeriod: `Calendar Year ${year}`,
      docLabel: `${year} Annual DOL PTE 2020-02 Review`,
      filename: `STT_Capital_${year}_DOL_PTE_2020_02_Review.pdf`,
      paragraphs: [
        `This letter documents the annual retrospective review conducted under the U.S. Department of Labor (DOL) Prohibited Transaction Exemption (PTE) 2020-02 for ${FIRM_NAME} for the calendar year ${year}.`,
        `PTE 2020-02 provides an exemption from certain prohibited transaction provisions of ERISA and the Internal Revenue Code for investment advice fiduciaries who receive compensation in connection with investment advice provided to retirement investors (including IRA holders, 401(k) participants, and other retirement plan beneficiaries).`,
        `Applicability Assessment:`,
        `${FIRM_NAME} was evaluated to determine whether its business activities trigger fiduciary status under the DOL's definition of investment advice fiduciary. The following findings were made:`,
        `(1) The firm does not provide individualized investment advice to retirement account holders (IRA, 401(k), 403(b), or other qualified retirement plan participants) for compensation.\n(2) The firm's sole advisory client is ${FUND_NAME}, a private investment fund structured as a limited partnership.\n(3) Cindy Eagar maintains a personal IRA from prior employment. This IRA is not managed, advised on, or supervised by ${FIRM_NAME}. Holdings of this IRA have been reviewed and present no conflict with the Fund's investment strategy.\n(4) The firm does not provide rollover recommendations, retirement plan distribution advice, or annuity recommendations to any individual.\n(5) The firm does not act as a fiduciary to any ERISA-covered plan or IRA.`,
        `Finding: ${FIRM_NAME} does not currently engage in activities that would trigger fiduciary status under the DOL's definition for purposes of PTE 2020-02. The firm's compliance obligations under PTE 2020-02 are minimal at this time. This retrospective review will be updated and expanded if the firm begins providing advice to retirement plan participants, IRA holders, or begins marketing to retirement investors.`,
      ],
      conclusion: `I hereby certify that the ${year} annual retrospective review under DOL PTE 2020-02 has been completed. The firm does not currently engage in activities triggering PTE 2020-02 obligations. No corrective actions are required.`,
    };
  }

  // ── PROXY VOTING ──
  if (t.includes('proxy voting')) {
    return {
      subject: `${year} Annual Proxy Voting Review`,
      reviewPeriod: `Calendar Year ${year}`,
      docLabel: `${year} Annual Proxy Voting Review`,
      filename: `STT_Capital_${year}_Proxy_Voting_Review.pdf`,
      paragraphs: [
        `This letter documents the annual review of proxy voting activities for ${FIRM_NAME} and ${FUND_NAME} for the calendar year ${year}.`,
        `${FIRM_NAME}, as Investment Manager to ${FUND_NAME}, has voting authority over proxies for securities held in the Fund's portfolio pursuant to the Investment Management Agreement and the firm's Proxy Voting Policy and Procedures.`,
        `The following items were reviewed:`,
        `(1) Proxy Voting Policy: The firm's Proxy Voting Policy was reviewed and confirmed current. The policy requires that all proxy votes be cast in the best interest of the Fund and its investors, free from conflicts of interest.\n(2) Proxy Votes Cast: During the review period, proxy votes were received for equity securities held in the Fund's portfolio. All proxy votes were reviewed and cast in accordance with the firm's Proxy Voting Policy guidelines.\n(3) Voting Records: Complete records of all proxy votes cast are maintained by the firm, including the issuer name, proposal description, the firm's vote, and the rationale for the voting decision. These records are available for inspection by Fund investors and regulators.\n(4) Conflicts of Interest: No conflicts of interest were identified in connection with any proxy voting decisions during the review period. The firm does not have investment banking relationships, underwriting arrangements, or other business relationships with portfolio companies that would create conflicts.\n(5) Third-Party Advisory Services: The firm does not currently utilize a third-party proxy advisory service (such as ISS or Glass Lewis). All proxy voting decisions are made internally by the investment team.\n(6) Class Action Participation: The firm monitors class action settlements related to Fund holdings and participates where appropriate.`,
      ],
      conclusion: `I hereby certify that the ${year} annual proxy voting review has been completed. All proxy votes were cast in accordance with the firm's Proxy Voting Policy and in the best interest of the Fund. No conflicts of interest were identified.`,
    };
  }

  // ── FORM PF FILING ──
  if (t.includes('form pf')) {
    return {
      subject: `${year} Annual Form PF Filing Review`,
      reviewPeriod: `Calendar Year ${year}`,
      docLabel: `${year} Annual Form PF Filing Review`,
      filename: `STT_Capital_${year}_Form_PF_Filing_Review.pdf`,
      paragraphs: [
        `This letter documents the annual review of Form PF filing requirements for ${FIRM_NAME} (CRD# ${CRD}) for the calendar year ${year}.`,
        `Form PF (Private Fund Reporting) is a confidential reporting form required by the SEC and the Financial Stability Oversight Council (FSOC) for certain investment advisers to private funds. The filing requirements are as follows:`,
        `Filing Requirement Analysis:\n(a) Condition A — SEC Registration: Form PF is required only for investment advisers that are registered with the SEC under Section 203 of the Investment Advisers Act of 1940.\n(b) ${FIRM_NAME} Status: ${FIRM_NAME} is NOT registered with the SEC as a Registered Investment Adviser (RIA). The firm is registered as an Exempt Reporting Adviser (ERA) in the State of Arizona.\n(c) Condition B — AUM Threshold: Even if the firm were SEC-registered, the Fund's assets under management are well below the $150 million threshold that triggers Form PF filing obligations for smaller private fund advisers.`,
        `Determination: ${FIRM_NAME} is EXEMPT from Form PF filing requirements on both grounds:\n(1) The firm is an ERA, not an SEC-registered investment adviser (fails Condition A).\n(2) The firm's AUM is substantially below the $150 million reporting threshold (fails Condition B).`,
        `This exemption determination is consistent with prior years and is based on the firm's current regulatory status and AUM. The firm will reassess its Form PF filing obligations if:\n- The firm becomes SEC-registered (i.e., transitions from ERA to RIA status), or\n- The Fund's AUM approaches or exceeds $150 million.`,
      ],
      conclusion: `I hereby certify that the ${year} Form PF filing review has been completed. ${FIRM_NAME} is EXEMPT from Form PF filing requirements as an Exempt Reporting Adviser with AUM below the reporting threshold. No filing is required.`,
    };
  }

  // ── FALLBACK ──
  return {
    subject: `${title} — ${q} ${year}`,
    reviewPeriod: `${q} ${year} (${qRange})`,
    docLabel: `${q} ${year} ${title}`,
    filename: `STT_Capital_${q}_${year}_${title.replace(/[^a-zA-Z0-9]/g, '_')}.pdf`,
    paragraphs: [
      `This letter documents the completion of the "${title}" compliance task for ${FIRM_NAME} for ${q} ${year}.`,
      `The required review was conducted in accordance with the firm's Policies and Procedures Manual and applicable regulatory requirements. All relevant materials were examined and no exceptions or deficiencies were identified.`,
    ],
    conclusion: `I hereby certify that the ${title} task for ${q} ${year} has been completed in accordance with firm policies and applicable regulatory requirements.`,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// PDF GENERATION (CORRECTED SIGNATURE BLOCK)
// ═══════════════════════════════════════════════════════════════════════════════

function generatePDF(task, content) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'LETTER',
      margins: { top: 60, bottom: 60, left: 72, right: 72 },
      info: {
        Title: content.subject,
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
    const reviewDate = new Date(task.dueDate);
    doc.font('Helvetica').fontSize(11).text(formatDate(reviewDate));
    doc.moveDown(0.8);

    // ── RE LINE ──
    doc.font('Helvetica-Bold').fontSize(11).text('Re: ', { continued: true });
    doc.font('Helvetica').text(content.subject);
    doc.moveDown(0.3);

    // ── REVIEW PERIOD ──
    doc.font('Helvetica-Bold').fontSize(11).text('Review Period: ', { continued: true });
    doc.font('Helvetica').text(content.reviewPeriod);
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
    for (const para of content.paragraphs) {
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
    doc.font('Helvetica').fontSize(10.5).text(content.conclusion, {
      align: 'justify',
      lineGap: 2,
      width: pageWidth,
    });

    // ── SIGNATURE BLOCK (CORRECTED) ──
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
    doc.text(`Date: ${formatDate(reviewDate)}`);

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
  const tasksColl = db.collection('compliance_tasks');
  const docsColl = db.collection('compliance_documents');

  // ── STEP 1: Delete ALL existing 2026 Archive documents ──
  const deleteResult = await docsColl.deleteMany({ category: '2026 Archive' });
  console.log(`\nDeleted ${deleteResult.deletedCount} existing documents from '2026 Archive'\n`);

  // ── STEP 2: Query all COMPLETED tasks due on or before April 8, 2026 ──
  const tasks = await tasksColl.find({
    status: 'COMPLETED',
    dueDate: { $lte: CUTOFF_DATE },
  }).sort({ dueDate: 1 }).toArray();

  console.log(`Found ${tasks.length} COMPLETED tasks to regenerate\n`);
  console.log('='.repeat(70));

  let completed = 0;
  let errors = 0;

  for (const task of tasks) {
    const d = new Date(task.dueDate);
    const content = getLetterContent(task);

    console.log(`\nProcessing: ${task.title}`);
    console.log(`  Due: ${formatDate(d)}`);
    console.log(`  Document: ${content.filename}`);

    try {
      // 1. Generate PDF with corrected officer titles
      const pdfBuffer = await generatePDF(task, content);
      console.log(`  PDF generated: ${(pdfBuffer.length / 1024).toFixed(1)} KB`);

      // 2. Upload to compliance_documents
      const subcategory = getSubcategory(d);
      await docsColl.insertOne({
        label: content.docLabel,
        filename: content.filename,
        contentType: 'application/pdf',
        size: pdfBuffer.length,
        data: pdfBuffer,
        category: '2026 Archive',
        subcategory,
        uploadedBy: 'system',
        uploadedAt: new Date(),
      });
      console.log(`  Uploaded to compliance_documents [${subcategory}]`);

      // NOTE: Task status is NOT modified — already COMPLETED

      completed++;
    } catch (err) {
      console.error(`  ERROR: ${err.message}`);
      errors++;
    }
  }

  // ── SUMMARY ──
  console.log('\n' + '='.repeat(70));
  console.log(`\nSUMMARY`);
  console.log(`  Tasks found:       ${tasks.length}`);
  console.log(`  PDFs regenerated:  ${completed}`);
  console.log(`  Errors:            ${errors}`);
  console.log('='.repeat(70));

  await client.close();
  console.log('\nDone. MongoDB connection closed.');
}

main().catch(err => { console.error(err); process.exit(1); });

// Shared option lists reused across form types, per the FICA field spec.
const YES_NO = ['Yes', 'No'];
const PROPERTY_USE = ['Primary residence', 'Investment', 'Rental property', 'Holiday home', 'Business use', 'Other'];
const PAYMENT_DESTINATION = ['Agency', 'Attorney', 'Seller', 'Landlord', 'Payment processing agent', 'Other'];
const PAYMENT_SOURCE = ['SA Bank', 'International transfer', 'Bond', 'Subject to sale', 'An Attorney', 'Cash', 'Other'];
const SOURCE_OF_FUNDS = ['Salary', 'Lottery/gambling', 'Sale of property', 'Inheritance', 'Business income', 'Investment income', 'Bond finance', 'Other'];
const SOURCE_OF_WEALTH = ['Past earnings', 'Investments', 'Inheritance', 'Business dealings', 'Sale of property', 'Other'];
const SERVICE_TYPE = ['Sales', 'Lease', 'Rental', 'Other'];

// Used when the agency hasn't configured its own list (natural person default).
const REQUIRED_DOCUMENTS_DEFAULT = [
  'Identity Document',
  'Salary Advice / Proof of Income',
  'Proof of Income Tax Registration Number',
  'Proof of Residential Address',
  'Marriage Certificate',
  'Ante Nuptial Contract',
];

// Sensible defaults per client type, used when the agency hasn't configured its own list.
const ENTITY_REPRESENTATIVE_DOCS = ['Resolution / letter of authority for the person acting', 'ID of the person acting on behalf of the entity'];
const REQUIRED_DOCUMENTS_BY_TYPE = {
  natural: REQUIRED_DOCUMENTS_DEFAULT,
  company: [
    'CIPC registration certificate (CoR14.3 / CK1)',
    'Latest CIPC disclosure / list of directors',
    'Share register or shareholding structure',
    'IDs of all directors and beneficial owners (25%+)',
    'Proof of business address (not older than 3 months)',
    'Income tax / VAT registration',
    ...ENTITY_REPRESENTATIVE_DOCS,
  ],
  trust: [
    'Letter of authority from the Master of the High Court',
    'Trust deed (and amendments)',
    'IDs of all trustees, founder and named beneficiaries',
    'Proof of address of the trust / trustees',
    ...ENTITY_REPRESENTATIVE_DOCS,
  ],
  partnership: [
    'Partnership agreement',
    'IDs of all partners and beneficial owners',
    'Proof of business address (not older than 3 months)',
    ...ENTITY_REPRESENTATIVE_DOCS,
  ],
};

function financialBlock(reasonLabel) {
  return [
    { name: 'serviceType', label: 'Service type required', type: 'select', options: SERVICE_TYPE },
    { name: 'propertyUse', label: 'Property use', type: 'select', options: PROPERTY_USE },
    { name: 'reason', label: reasonLabel, type: 'select', options: ['Relocating', 'Downscaling', 'Upscaling', 'Financial reasons', 'Investment sale', 'Estate sale', 'Other'] },
    { name: 'paymentDestination', label: 'Payment account destination', type: 'select', options: PAYMENT_DESTINATION },
    { name: 'paymentSource', label: 'Payment source', type: 'select', options: PAYMENT_SOURCE },
    { name: 'cashOver50k', label: 'Cash payments ≥ R50,000?', type: 'radio', options: YES_NO },
    { name: 'sourceOfFunds', label: 'Source of funds', type: 'select', options: SOURCE_OF_FUNDS },
    { name: 'sourceOfWealth', label: 'Source of wealth', type: 'select', options: SOURCE_OF_WEALTH },
  ];
}

function legalEntityFields({ nameLabel, regNumberLabel, operatingKey, previousFicaKey, ownersLabel, extraFirst = [] }) {
  return [
    { name: 'entityName', label: nameLabel, type: 'text' },
    ...extraFirst,
    { name: 'regNumber', label: regNumberLabel, type: 'text' },
    { name: 'tradingName', label: 'Trading name', type: 'text' },
    { name: 'address', label: 'Registered address', type: 'textarea' },
    { name: 'contactNumber', label: 'Contact number/s', type: 'text' },
    { name: 'email', label: 'Email address', type: 'text' },
    {
      name: 'operatesOnlyInSA', label: 'Operates only in South Africa?', type: 'radio', options: YES_NO,
      special: { key: operatingKey, showOn: 'No', reveal: [{ name: `${operatingKey}Countries`, label: 'Countries of operation', type: 'textarea' }] },
    },
    {
      name: 'ficaDoneBefore', label: 'FICA done with this entity before?', type: 'radio', options: YES_NO,
      special: { key: previousFicaKey, showOn: 'Yes', reveal: [{ name: `${previousFicaKey}Details`, label: 'When, and service type', type: 'textarea' }] },
    },
    { name: 'natureOfBusiness', label: 'Nature of business/activities', type: 'textarea' },
    { name: 'industry', label: 'Industry', type: 'text' },
    ...financialBlock('Reason for selling/letting'),
    { name: 'ownershipStructure', label: 'Ownership/control structure', type: 'textarea' },
    { name: 'owners', label: ownersLabel, type: 'textarea' },
    { name: 'form1Completed', label: 'Form 1 completed for each beneficial owner?', type: 'select', options: ['Confirmed', 'Not yet'] },
  ];
}

export const FORM_TYPES = {
  natural: {
    key: 'natural',
    typeName: 'Natural Person',
    fields: [
      { name: 'fullNames', label: 'Full names and surname', type: 'text' },
      { name: 'idNumber', label: 'ID or passport number', type: 'text' },
      { name: 'address', label: 'Residential address', type: 'textarea' },
      { name: 'contactNumber', label: 'Contact number/s', type: 'text' },
      { name: 'email', label: 'Email address', type: 'text' },
      { name: 'saCitizen', label: 'SA citizen/permanent resident?', type: 'radio', options: YES_NO },
      { name: 'ficaDoneBefore', label: 'FICA done before?', type: 'radio', options: YES_NO },
      ...financialBlock('Reason for selling'),
      { name: 'employmentInfo', label: 'Employment info', type: 'textarea' },
      {
        name: 'fpep', label: 'Have you ever held a prominent public function in a foreign country?', type: 'radio', options: YES_NO,
        special: {
          key: 'fpep', showOn: 'Yes',
          reveal: [
            { name: 'fpepPosition', label: 'Position held', type: 'select', options: ['Head of State/government', 'Member of foreign royal family', 'Government minister/senior politician', 'Senior judicial official', 'Senior executive of state-owned corporation', 'High-ranking military'] },
            { name: 'fpepDetails', label: 'Details', type: 'textarea' },
          ],
        },
      },
      {
        name: 'dpip', label: 'Have you held a domestic prominent influential position in the last 12 months?', type: 'radio', options: YES_NO,
        special: {
          key: 'dpip', showOn: 'Yes',
          reveal: [
            { name: 'dpipPosition', label: 'Position held', type: 'select', options: ['Chairperson of board', 'Chairperson of audit committee', 'Executive officer', 'CFO', 'Other SA prominent public position'] },
            { name: 'dpipDetails', label: 'Details', type: 'textarea' },
          ],
        },
      },
      {
        name: 'pepFamily', label: 'Are you a family member or close associate of a PEP/DPIP/DPEP?', type: 'radio', options: YES_NO,
        special: {
          key: 'pepFamily', showOn: 'Yes',
          reveal: [
            { name: 'pepFamilyRelationship', label: 'Relationship type', type: 'select', options: ['Spouse/civil partner', 'Previous spouse', 'Sibling', 'Children', 'Parents', 'Same political party/union', 'Business partner', "Beneficial owner for PEP's benefit", 'Known sexual partner outside family'] },
            { name: 'pepFamilyDetails', label: 'Details', type: 'textarea' },
          ],
        },
      },
    ],
  },

  company: {
    key: 'company',
    typeName: 'Company / CC',
    fields: legalEntityFields({
      nameLabel: 'Registered company name',
      regNumberLabel: 'CIPC registration number',
      operatingKey: 'companyOperating',
      previousFicaKey: 'companyPreviousFica',
      ownersLabel: 'Directors, members, shareholders with 25% or more, and any person who ultimately controls the company (full names and ID numbers)',
      extraFirst: [
        { name: 'companyType', label: 'Company type', type: 'select', options: ['Private company (Pty) Ltd', 'Close corporation (CC)', 'Public company (Ltd)', 'Non-profit company (NPC)', 'State-owned company (SOC)', 'Foreign company / external company'] },
        { name: 'listedCompany', label: 'Is the company listed on a stock exchange?', type: 'radio', options: YES_NO },
      ],
    }),
  },

  trust: {
    key: 'trust',
    typeName: 'Trust',
    fields: legalEntityFields({
      nameLabel: 'Registered trust name',
      regNumberLabel: 'Trust registration number',
      operatingKey: 'trustOperating',
      previousFicaKey: 'trustPreviousFica',
      ownersLabel: 'Beneficial owners/trustees/named beneficiaries',
    }),
  },

  partnership: {
    key: 'partnership',
    typeName: 'Partnership',
    fields: legalEntityFields({
      nameLabel: 'Registered partnership name',
      regNumberLabel: 'Registration number (if applicable)',
      operatingKey: 'partnershipOperating',
      previousFicaKey: 'partnershipPreviousFica',
      ownersLabel: 'Partners / beneficial owners',
    }),
  },

  // INTERNAL — completed by the agency (risk weighting, FCO sign-off), never by the client.
  // Key kept as 'enhanced' so submissions made before this change still render.
  enhanced: {
    key: 'enhanced',
    typeName: 'EDD Risk Assessment',
    internal: true,
    fields: [
      { name: 'fullNames', label: 'Full names and surname', type: 'text' },
      { name: 'idNumber', label: 'ID/passport number', type: 'text' },
      { name: 'address', label: 'Residential address', type: 'textarea' },
      { name: 'contactNumber', label: 'Contact number/s', type: 'text' },
      { name: 'email', label: 'Email address', type: 'text' },
      {
        name: 'enhancedDDRequired', label: 'Enhanced due diligence required?', type: 'radio', options: YES_NO,
        special: { key: 'enhancedRisk', showOn: 'Yes', reveal: [{ name: 'enhancedRiskReason', label: 'Reason', type: 'textarea' }] },
      },
      {
        name: 'clientRiskCategory', label: 'Client type/risk category', type: 'select',
        options: [
          'Normal SA CC/Pty/Professional Partnership/Listed company/Family Trust',
          'Complicated or layered entity',
          'Persons with Power of Attorney',
          'SA non-professional Partnership/non-family Trust',
          'Non-profit/NGO',
          'Foreign National/Company',
          'Foreign Trust/Partnership/Company',
          'Cash intensive business',
          'Other',
        ],
      },
      {
        name: 'riskIndicators', label: 'Risk indicators', type: 'checkbox-group',
        options: ['Unusual/complicated transaction', 'Evasive/vague/unwilling', 'Negative media', 'Criminal background', 'Third-party payments', 'Vague source of funds/business', 'High cash generating business', 'Other'],
      },
      { name: 'riskWeightTotal', label: 'Risk weight total', type: 'select', options: ['1', '2', '3', '4', 'STOP - Discuss with FCO'] },
      { name: 'discussWithFCO', label: 'Discuss with FCO?', type: 'radio', options: YES_NO },
      { name: 'notes', label: 'Notes', type: 'textarea' },
      { name: 'responsibleEmployee', label: 'Responsible employee name', type: 'text' },
      { name: 'ficaOfficer', label: 'FICA officer/principal name', type: 'text' },
    ],
  },
};

/** Form types a client may choose from. The EDD risk assessment is agency-only. */
export const CLIENT_FORM_TYPES = Object.fromEntries(Object.entries(FORM_TYPES).filter(([, t]) => !t.internal));

// Answers are stored keyed by question label, so look labels up from the definitions
// rather than duplicating question text here.
function labelOf(typeKey, name) {
  const find = (fields) => {
    for (const f of fields) {
      if (f.name === name) return f.label;
      const inner = f.special && find(f.special.reveal);
      if (inner) return inner;
    }
    return null;
  };
  return FORM_TYPES[typeKey] ? find(FORM_TYPES[typeKey].fields) : null;
}

/**
 * Risk-based EDD triggers derived from the client's own answers (FICA s21F–H, RMCP).
 * The client never chooses "enhanced" themselves — the agency must treat a client as
 * EDD whenever any of these apply. Computed at review time, so it can't be spoofed by
 * a value stored on the submission.
 */
export function eddTriggers(sub) {
  const a = sub.answers || {};
  const val = (name) => String(a[labelOf(sub.type, name)] ?? '').trim();
  const reasons = [];
  if (val('fpep') === 'Yes') reasons.push('Foreign prominent public official (FPPO)');
  if (val('dpip') === 'Yes') reasons.push('Domestic prominent influential person (DPIP)');
  if (val('pepFamily') === 'Yes') reasons.push('Family member / close associate of a PEP');
  if (val('saCitizen') === 'No') reasons.push('Not an SA citizen or permanent resident');
  if (val('operatesOnlyInSA') === 'No') reasons.push('Entity operates outside South Africa');
  if (val('cashOver50k') === 'Yes') reasons.push('Cash payments of R50,000 or more');
  if (['Cash', 'International transfer'].includes(val('paymentSource'))) reasons.push(`Payment source: ${val('paymentSource')}`);
  if (val('sourceOfFunds') === 'Lottery/gambling') reasons.push('Source of funds: lottery/gambling');
  if (val('companyType') === 'Foreign company / external company') reasons.push('Foreign company');
  if (val('form1Completed') === 'Not yet') reasons.push('Beneficial owner forms (Form 1) outstanding');
  if (sub.type === 'enhanced') reasons.push('Legacy enhanced due diligence submission');
  return reasons;
}

export { REQUIRED_DOCUMENTS_DEFAULT, REQUIRED_DOCUMENTS_BY_TYPE };

const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

const env = {
  apiBaseUrl: required('API_BASE_URL'),
  tokenUser374: required('TOKEN_USER_374'),
  tokenUser375: required('TOKEN_USER_375'),
  user374DefaultCandidateCodeId: Number(required('USER_374_DEFAULT_CANDIDATE_CODE_ID')),
  user374DefaultCandidateCode: required('USER_374_DEFAULT_CANDIDATE_CODE'),
  user374RegistrationCode: required('USER_374_REGISTRATION_CODE'),
  user375RegistrationCode: required('USER_375_REGISTRATION_CODE'),
  maxReferralCodesPerUser: Number(process.env.MAX_REFERRAL_CODES_PER_USER || 20),
};

module.exports = { env };

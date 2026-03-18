const { test, expect } = require('@playwright/test');
const { env } = require('../utils/env');
const {
  createAuthedContext,
  createPublicContext,
  expectBusinessError,
  expectBusinessSuccess,
  expectSecondTimestamps,
  expectSortedByCreatedDesc,
  getJson,
  postJson,
  uniqueCode,
} = require('../utils/api');

test.describe.serial('User 374 regression flows', () => {
  let context;

  test.beforeAll(async () => {
    context = await createAuthedContext(env.tokenUser374, env.apiBaseUrl);
  });

  test.afterAll(async () => {
    await context.dispose();
  });

  test('list returns second-based timestamps and default code first', async () => {
    const { body } = await getJson(context, '/api/affiliate/referral-code/list');
    expectBusinessSuccess(body);
    expect(Array.isArray(body.data)).toBeTruthy();
    expect(body.data.length).toBeGreaterThan(0);
    expectSecondTimestamps(body.data);

    expect(body.data[0].is_default).toBe(1);
    expect(body.data[0].id).toBe(env.user374DefaultCandidateCodeId);

    const nonDefaultItems = body.data.filter((item) => item.is_default === 0);
    expectSortedByCreatedDesc(nonDefaultItems);
  });

  test('update can change, clear, and restore remark', async () => {
    const listBefore = await getJson(context, '/api/affiliate/referral-code/list');
    expectBusinessSuccess(listBefore.body);
    const target = listBefore.body.data.find((item) => item.id === env.user374DefaultCandidateCodeId);
    expect(target).toBeTruthy();
    const originalRemark = target.remark;

    const updateResult = await postJson(context, '/api/affiliate/referral-code/update', {
      codeId: env.user374DefaultCandidateCodeId,
      remark: 'playwright update smoke',
    });
    expectBusinessSuccess(updateResult.body, 'Remark updated');
    expect(updateResult.body.data.remark).toBe('playwright update smoke');

    const listAfterUpdate = await getJson(context, '/api/affiliate/referral-code/list');
    const updated = listAfterUpdate.body.data.find((item) => item.id === env.user374DefaultCandidateCodeId);
    expect(updated.remark).toBe('playwright update smoke');

    const clearResult = await postJson(context, '/api/affiliate/referral-code/update', {
      codeId: env.user374DefaultCandidateCodeId,
      remark: '',
    });
    expectBusinessSuccess(clearResult.body, 'Remark updated');
    expect(clearResult.body.data.remark).toBeNull();

    const restoreResult = await postJson(context, '/api/affiliate/referral-code/update', {
      codeId: env.user374DefaultCandidateCodeId,
      remark: originalRemark || '',
    });
    expectBusinessSuccess(restoreResult.body, 'Remark updated');
  });

  test('set-default succeeds for the known referral code', async () => {
    const result = await postJson(context, '/api/affiliate/referral-code/set-default', {
      codeId: env.user374DefaultCandidateCodeId,
    });
    expectBusinessSuccess(result.body, 'Default code updated');
    expect(result.body.data.id).toBe(env.user374DefaultCandidateCodeId);
    expect(result.body.data.is_default).toBe(1);

    const listResult = await getJson(context, '/api/affiliate/referral-code/list');
    const currentDefault = listResult.body.data.find((item) => item.is_default === 1);
    expect(currentDefault).toBeTruthy();
    expect(currentDefault.id).toBe(env.user374DefaultCandidateCodeId);
  });
});

test.describe.serial('User 375 create and no-default sort flows', () => {
  let context;
  let createdCode;

  test.beforeAll(async () => {
    context = await createAuthedContext(env.tokenUser375, env.apiBaseUrl);
  });

  test.afterAll(async () => {
    await context.dispose();
  });

  test('create rejects decimal rebate values', async () => {
    const code = uniqueCode('D');
    const result = await postJson(context, '/api/affiliate/referral-code/create', {
      referralCode: code,
      personalRebate: 60.5,
      invitationRebate: 9,
      remark: 'decimal should fail',
    });
    expectBusinessError(result.body, 400, 'Rebate percentages must be non-negative integers');
  });

  test('create succeeds with a unique code when capacity allows', async () => {
    const listResult = await getJson(context, '/api/affiliate/referral-code/list');
    expectBusinessSuccess(listResult.body);
    test.skip(
      listResult.body.data.length >= env.maxReferralCodesPerUser,
      `User 375 already has ${listResult.body.data.length} codes; create success test skipped.`,
    );

    createdCode = uniqueCode('P');
    const createResult = await postJson(context, '/api/affiliate/referral-code/create', {
      referralCode: createdCode,
      personalRebate: 60,
      invitationRebate: 10,
      remark: 'playwright create smoke',
    });
    expectBusinessSuccess(createResult.body, 'Referral code created');
    expect(createResult.body.data.referral_code).toBe(createdCode);
    expect(createResult.body.data.is_default).toBe(0);
  });

  test('list sorts by createdAt desc when there is no default code', async () => {
    const { body } = await getJson(context, '/api/affiliate/referral-code/list');
    expectBusinessSuccess(body);
    expect(body.data.length).toBeGreaterThan(0);
    expectSecondTimestamps(body.data);

    const hasDefault = body.data.some((item) => item.is_default === 1);
    test.skip(hasDefault, 'User 375 now has a default code; no-default sorting precondition no longer holds.');

    expect(body.data.every((item) => item.is_default === 0)).toBeTruthy();
    expectSortedByCreatedDesc(body.data);
  });
});

test.describe('Public code-info flows', () => {
  let publicContext;

  test.beforeAll(async () => {
    publicContext = await createPublicContext(env.apiBaseUrl);
  });

  test.afterAll(async () => {
    await publicContext.dispose();
  });

  test('code-info works for uppercase and lowercase codes', async () => {
    const upper = await getJson(publicContext, `/api/affiliate/code-info/${env.user374DefaultCandidateCode}`);
    expectBusinessSuccess(upper.body);
    expect(upper.body.data.referral_code).toBe(env.user374DefaultCandidateCode);
    expect(upper.body.data.inviter.wallet_address).toMatch(/^0x[0-9A-Fa-f]{4}.*\.\.\..+/);

    const lower = await getJson(
      publicContext,
      `/api/affiliate/code-info/${env.user374DefaultCandidateCode.toLowerCase()}`,
    );
    expectBusinessSuccess(lower.body);
    expect(lower.body.data.referral_code).toBe(env.user374DefaultCandidateCode);
  });

  test('code-info returns not-found message for unknown code', async () => {
    const result = await getJson(publicContext, '/api/affiliate/code-info/NOTEXIST123');
    expectBusinessError(result.body, 404, 'Referral code not found or inactive');
  });
});

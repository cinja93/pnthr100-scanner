// Tests for the data-room entitlement gate (2026-07-06 audit, member IDOR fix).
// Run: node dataroomGate.test.mjs — mocks the den_investors collection, no real DB.
import { buildDocGate } from './routes/dataroom.js';

let pass = 0, fail = 0;
const ok = (name, got, want) => {
  const good = got === want;
  console.log((good ? '✅' : '❌') + ' ' + name + (good ? '' : `  got ${got}, want ${want}`));
  good ? pass++ : fail++;
};

// Doc ids: GEN = general (nobody's list), A1/A2 = investor A's restricted, B1 = investor B's.
const GEN = 'aaaaaaaaaaaaaaaaaaaaaaaa', A1 = 'a1a1a1a1a1a1a1a1a1a1a1a1', A2 = 'a2a2a2a2a2a2a2a2a2a2a2a2', B1 = 'b1b1b1b1b1b1b1b1b1b1b1b1';
const ID_A = 'aaaa1111aaaa1111aaaa1111', ID_B = 'bbbb2222bbbb2222bbbb2222';
const investorA = { _id: ID_A, allowedDocIds: [A1, A2] };
const investorB = { _id: ID_B, allowedDocIds: [B1] };
const investors = [investorA, investorB];

// Minimal mock: supports find({allowedDocIds:{$exists,$ne:[]}}) via async-iterable, and findOne by _id.
const mockDb = {
  collection() {
    return {
      find() { return { async *[Symbol.asyncIterator]() { for (const i of investors) yield i; } }; },
      async findOne(q) { return investors.find(i => i._id === q._id?.toString?.() || i._id === q._id) || null; },
    };
  },
};
// ObjectId in the route calls .toString(); our ids are strings, so wrap findOne _id to match.
mockDb.collection = () => ({
  find: () => ({ async *[Symbol.asyncIterator]() { for (const i of investors) yield i; } }),
  findOne: async (q) => investors.find(i => i._id === String(q._id)) || null,
});

const admin = await buildDocGate(mockDb, { role: 'admin' });
ok('admin sees a general doc', admin.canSee(GEN), true);
ok('admin sees any restricted doc', admin.canSee(B1), true);
ok('admin isAdmin flag', admin.isAdmin, true);

const member = await buildDocGate(mockDb, { role: 'member', email: 'm@x.com' });
ok('member sees GENERAL doc', member.canSee(GEN), true);
ok('member BLOCKED from investor A restricted doc (the IDOR)', member.canSee(A1), false);
ok('member BLOCKED from investor B restricted doc', member.canSee(B1), false);

const invA = await buildDocGate(mockDb, { role: 'investor', source: 'den_investors', userId: ID_A });
ok('investor A sees their own restricted doc', invA.canSee(A1), true);
ok('investor A sees their other assigned doc', invA.canSee(A2), true);
ok('investor A does NOT see general doc (scoped to their list only)', invA.canSee(GEN), false);
ok('investor A does NOT see investor B doc', invA.canSee(B1), false);

const invNoList = await buildDocGate(mockDb, { role: 'investor', source: 'den_investors', userId: 'ffffffffffffffffffffffff' });
ok('investor with no list sees general docs', invNoList.canSee(GEN), true);
ok('investor with no list still blocked from another party restricted doc', invNoList.canSee(A1), false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

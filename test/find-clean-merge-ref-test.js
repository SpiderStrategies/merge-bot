const tap = require('tap')

const findCleanMergeRef = require('../find-clean-merge-ref')
const { isRelevantConflict } = require('../find-clean-merge-ref')

const branch = 'branch'

class ActionStub {

	constructor(logOutput) {
		this.logOutput = logOutput
	}

	async exec(cmd) {
		if (cmd.startsWith('git log')) {
			return this.logOutput
		}
	}
}

// Unit tests for isRelevantConflict helper function
tap.test('isRelevantConflict - no merge-conflict prefix', t => {
	const line = '616a75e1c27cecb46f05acbe2cfa11c6bf5e5b14  (HEAD -> release-5.8.0)'
	const result = isRelevantConflict(line, null)
	t.equal(result, false)
	t.end()
})

tap.test('isRelevantConflict - backwards compatibility mode (no pattern)', t => {
	const line = '427a3532cf813d43ba97b85a1a7e186efed50e61  (origin/merge-conflicts-45133)'
	const result = isRelevantConflict(line, null)
	t.equal(result, true)
	t.end()
})

tap.test('isRelevantConflict - old format branch (no encoding)', t => {
	const line = '9f32de6531d32091b43bf7910b7a2ed069e5bff1  (merge-conflicts-48357)'
	const pattern = 'merge-conflicts-\\d+-release-5-8-0-to-main'
	const result = isRelevantConflict(line, pattern)
	t.equal(result, true, 'old format should be treated as relevant')
	t.end()
})

tap.test('isRelevantConflict - matches pattern exactly', t => {
	const line = 'f8f591de2d7ff1ee154fbd486a2c5afab972e5ea  (origin/merge-conflicts-68586-release-5-8-0-to-main)'
	const pattern = 'merge-conflicts-\\d+-release-5-8-0-to-main'
	const result = isRelevantConflict(line, pattern)
	t.equal(result, true)
	t.end()
})

tap.test('isRelevantConflict - different source branch', t => {
	const line = '9f32de6531d32091b43bf7910b7a2ed069e5bff1  (origin/merge-conflicts-68590-release-5-7-2-to-release-5-8-0)'
	const pattern = 'merge-conflicts-\\d+-release-5-8-0-to-main'
	const result = isRelevantConflict(line, pattern)
	t.equal(result, false, 'should ignore conflicts from different source branch')
	t.end()
})

tap.test('isRelevantConflict - different target branch', t => {
	const line = '06e93ad498b0eef956edfa6b73b1a5d79cf7b95d  (origin/merge-conflicts-68600-release-5-8-0-to-some-other-branch)'
	const pattern = 'merge-conflicts-\\d+-release-5-8-0-to-main'
	const result = isRelevantConflict(line, pattern)
	t.equal(result, false, 'should ignore conflicts to different target branch')
	t.end()
})

tap.test('isRelevantConflict - multiple branch refs in line', t => {
	const line = 'c9cde4bd47b828ec84b3a0374e24fbd8dbfdf626  (origin/branch-here-release-5.8.0, foo, bar)'
	const pattern = 'merge-conflicts-\\d+-release-5-8-0-to-main'
	const result = isRelevantConflict(line, pattern)
	t.equal(result, false, 'should return false when no merge-conflicts branch present')
	t.end()
})

tap.test('isRelevantConflict - relevant conflict among multiple refs', t => {
	const line = 'f8f591de  (origin/merge-conflicts-68586-release-5-8-0-to-main, some-other-ref)'
	const pattern = 'merge-conflicts-\\d+-release-5-8-0-to-main'
	const result = isRelevantConflict(line, pattern)
	t.equal(result, true, 'should find relevant conflict even with other refs')
	t.end()
})

// Integration tests for findCleanMergeRef
tap.test(`merge-conflict at n-2`, async t => {

	const logOutput = `2bdff7d6aab099c32608c5e20b4b5ed796f84c6f
427a3532cf813d43ba97b85a1a7e186efed50e61  (origin/merge-conflicts-45133)
c9ab394289bb141f3eb99413fa967d0fc54f7597  (origin/branch-here-branch)`

	const action = new ActionStub(logOutput)
	const cleanMergePoint = await findCleanMergeRef(action, branch)
	t.equal(cleanMergePoint, null)
})

tap.test(`merge-conflict at n-1`, async t => {

	const logOutput = `c9ab394289bb141f3eb99413fa967d0fc54f7597  (origin/branch-here-branch, origin/merge-conflicts-45133)`

	const action = new ActionStub(logOutput)
	const cleanMergePoint = await findCleanMergeRef(action, branch)
	t.equal(cleanMergePoint, null)
})

tap.test(`merge-conflict greater than n-2`, async t => {

	const logOutput = `114a5e426f3e9007bd72f58effb648dd69833e10  (HEAD -> release-2021-commercial-sp, origin/release-2021-commercial-sp)
2bdff7d6aab099c32608c5e20b4b5ed796f84c6f
52a6609dc8b7ccf4002bc239144e9a1f10b8da18
416252254f80c1b346e5562fcf892a4657c698cd
c9cde4bd47b828ec84b3a0374e24fbd8dbfdf626
427a3532cf813d43ba97b85a1a7e186efed50e61  (origin/merge-conflicts-issue-branch)
ffdd39b5907e01a7705b28dc45e101b1a8670ed0
b28ec6fc613a33909752167c2fa8473e167346e2
72a477702d17edacda9f2486cbdbaa80815576c9
10ef5994529ad9648b789c617b515cc5d8c4da0f
c97cecf267256e56e141eb4932810e446e584d59
c9ab394289bb141f3eb99413fa967d0fc54f7597  (origin/branch-here-release-2021-commercial-emergency)`

	const action = new ActionStub(logOutput)
	const cleanMergePoint = await findCleanMergeRef(action, branch)
	t.equal(cleanMergePoint, "ffdd39b5907e01a7705b28dc45e101b1a8670ed0")
})

// Validates this scenario won't happen again: https://github.com/SpiderStrategies/Scoreboard/runs/5496240629?check_suite_focus=true
tap.test(`clean merge point has another branch(es)`, async t => {

	const logOutput = `114a5e426f3e9007bd72f58effb648dd69833e10  (HEAD -> release-2021-commercial-sp, origin/release-2021-commercial-sp)
416252254f80c1b346e5562fcf892a4657c698cd  (origin/merge-conflicts-issue)
c9cde4bd47b828ec84b3a0374e24fbd8dbfdf626  (origin/branch-here-release-2021-commercial-emergency, foo, bar)
c9ab394289bb141f3eb99413fa967d0fc54f7597  (origin/branch-here-branch)`

	const action = new ActionStub(logOutput)
	const cleanMergePoint = await findCleanMergeRef(action, branch)
	t.equal(cleanMergePoint, "c9cde4bd47b828ec84b3a0374e24fbd8dbfdf626")
})

tap.test(`merge-conflict first of 3 commits`, async t => {

	const logOutput = `427a3532cf813d43ba97b85a1a7e186efed50e61  (origin/merge-conflicts-issue)
10ef5994529ad9648b789c617b515cc5d8c4da0f
c97cecf267256e56e141eb4932810e446e584d59`

	const action = new ActionStub(logOutput)
	const cleanMergePoint = await findCleanMergeRef(action, branch)
	t.equal(cleanMergePoint, "10ef5994529ad9648b789c617b515cc5d8c4da0f")
})

// This output was created when we started using `--topo-order` on the git log
tap.test(`merge-conflict with merge conflicts`, async t => {
	const logOutput = `616a75e1c27cecb46f05acbe2cfa11c6bf5e5b14  (HEAD -> testing)
550b8a8b563627006af63ccf35ade57e1ecb6332
06e93ad498b0eef956edfa6b73b1a5d79cf7b95d
f8f591de2d7ff1ee154fbd486a2c5afab972e5ea
bec64b93e613f2525f0c1ef7acaf9d890e7f81f5
9f32de6531d32091b43bf7910b7a2ed069e5bff1  (merge-conflicts-48357)
9243d7e7877578b47a5437110271376b64847c05
375300be2e3853c230387758afe0fc6aee7bfbd6  (merge-conflicts-48356)
5da246f8231fb0f79ac66a9b345e6052759faa44
f66da07bc48828ed320f7dae79965004f4c9ce16
f9dccb36edd252a68a9b09957155b1b1cce11e53
df05e8531bbe7896917157a1590ee4794688bde1  (tag: 5.0.0.222)`

	const action = new ActionStub(logOutput)

	const cleanMergePoint = await findCleanMergeRef(action, branch)
	// Finds the oldest relevant conflict to be most conservative
	t.equal(cleanMergePoint, "5da246f8231fb0f79ac66a9b345e6052759faa44")
})

// This test describes situation in
// https://github.com/SpiderStrategies/gh-action-branch-maintainer/issues/4
tap.test(`merge-conflict prevents finding a commit in the past`, async t => {
	t.plan(2)
	const logOutput = `616a75e1c27cecb46f05acbe2cfa11c6bf5e5b14  (HEAD -> testing)
550b8a8b563627006af63ccf35ade57e1ecb6332
06e93ad498b0eef956edfa6b73b1a5d79cf7b95d
f8f591de2d7ff1ee154fbd486a2c5afab972e5ea
bec64b93e613f2525f0c1ef7acaf9d890e7f81f5
9f32de6531d32091b43bf7910b7a2ed069e5bff1  (merge-conflicts-48357)
9243d7e7877578b47a5437110271376b64847c05
375300be2e3853c230387758afe0fc6aee7bfbd6  (merge-conflicts-48356)
5da246f8231fb0f79ac66a9b345e6052759faa44
f66da07bc48828ed320f7dae79965004f4c9ce16
f9dccb36edd252a68a9b09957155b1b1cce11e53
df05e8531bbe7896917157a1590ee4794688bde1  (tag: 5.0.0.222)`

	const action = new ActionStub(logOutput)
	action.exec = async function (cmd) {
		console.log(cmd)
		if (cmd.startsWith('git log')) {
			return this.logOutput
		} else if (cmd.includes('5da246f8231fb0f79ac66a9b345e6052759faa44')) {
			// Mock to pretend this commit isn't an ancestor
			throw new Error('Not an ancestor')
		}
	}
	action.core = {
		info: () => {
			t.ok('info logged')
		}
	}
	const cleanMergePoint = await findCleanMergeRef(action, branch)
	// Searches from oldest conflict (48356) to be most conservative
	t.equal(cleanMergePoint, "f66da07bc48828ed320f7dae79965004f4c9ce16")
})

tap.test(`no conflicts`, async t => {
	const logOutput = `427a3532cf813d43ba97b85a1a7e186efed50e61  (origin/some-branch)
10ef5994529ad9648b789c617b515cc5d8c4da0f
c97cecf267256e56e141eb4932810e446e584d59`

	const action = new ActionStub(logOutput)
	const cleanMergePoint = await findCleanMergeRef(action, branch)
	t.equal(cleanMergePoint, "origin/branch")
})

tap.test(`no output`, async t => {
	const logOutput = ``
	const action = new ActionStub(logOutput)
	const cleanMergePoint = await findCleanMergeRef(action, branch)
	t.equal(cleanMergePoint, "origin/branch")
})

tap.test(`empty line`, async t => {
	const logOutput = `\n`
	const action = new ActionStub(logOutput)
	const cleanMergePoint = await findCleanMergeRef(action, branch)
	t.equal(cleanMergePoint, "origin/branch")
})

// Tests for encoded branch names (Option 2 - #63954 fix)
tap.test(`ignores merge-conflicts from different source branches`, async t => {
	// Scenario: We're maintaining branch-here-release-5.8.0
	// There are conflicts from release-5.7.2 -> release-5.8.0 (irrelevant)
	// And conflicts from release-5.8.0 -> main (relevant)
	const logOutput = `616a75e1c27cecb46f05acbe2cfa11c6bf5e5b14  (HEAD -> release-5.8.0)
550b8a8b563627006af63ccf35ade57e1ecb6332
06e93ad498b0eef956edfa6b73b1a5d79cf7b95d
f8f591de2d7ff1ee154fbd486a2c5afab972e5ea  (origin/merge-conflicts-68586-release-5-8-0-to-main)
bec64b93e613f2525f0c1ef7acaf9d890e7f81f5
9f32de6531d32091b43bf7910b7a2ed069e5bff1  (origin/merge-conflicts-68590-release-5-7-2-to-release-5-8-0)
9243d7e7877578b47a5437110271376b64847c05
df05e8531bbe7896917157a1590ee4794688bde1  (origin/branch-here-release-5.8.0)`

	const action = new ActionStub(logOutput)
	// When maintaining branch-here for release-5.8.0 which merges TO main
	const cleanMergePoint = await findCleanMergeRef(action, 'release-5.8.0', 'main')

	// Should stop at the conflict that's FROM release-5.8.0 TO main
	// Should ignore the conflict from release-5.7.2 to release-5.8.0
	t.equal(cleanMergePoint, "bec64b93e613f2525f0c1ef7acaf9d890e7f81f5")
})

tap.test(`ignores merge-conflicts to different target branches`, async t => {
	// Scenario: Conflicts exist for merging to different downstream branches
	const logOutput = `616a75e1c27cecb46f05acbe2cfa11c6bf5e5b14  (HEAD -> release-5.8.0)
550b8a8b563627006af63ccf35ade57e1ecb6332
06e93ad498b0eef956edfa6b73b1a5d79cf7b95d  (origin/merge-conflicts-68600-release-5-8-0-to-some-other-branch)
f8f591de2d7ff1ee154fbd486a2c5afab972e5ea
bec64b93e613f2525f0c1ef7acaf9d890e7f81f5  (origin/merge-conflicts-68586-release-5-8-0-to-main)
9f32de6531d32091b43bf7910b7a2ed069e5bff1
df05e8531bbe7896917157a1590ee4794688bde1  (origin/branch-here-release-5.8.0)`

	const action = new ActionStub(logOutput)
	const cleanMergePoint = await findCleanMergeRef(action, 'release-5.8.0', 'main')

	// Should stop at the conflict TO main, ignore the conflict to some-other-branch
	t.equal(cleanMergePoint, "9f32de6531d32091b43bf7910b7a2ed069e5bff1")
})

tap.test(`handles multiple relevant conflicts`, async t => {
	// Multiple conflicts from release-5.8.0 to main
	const logOutput = `616a75e1c27cecb46f05acbe2cfa11c6bf5e5b14  (HEAD -> release-5.8.0)
550b8a8b563627006af63ccf35ade57e1ecb6332  (origin/merge-conflicts-68602-release-5-8-0-to-main)
06e93ad498b0eef956edfa6b73b1a5d79cf7b95d
f8f591de2d7ff1ee154fbd486a2c5afab972e5ea
bec64b93e613f2525f0c1ef7acaf9d890e7f81f5  (origin/merge-conflicts-68586-release-5-8-0-to-main)
9f32de6531d32091b43bf7910b7a2ed069e5bff1
df05e8531bbe7896917157a1590ee4794688bde1  (origin/branch-here-release-5.8.0)`

	const action = new ActionStub(logOutput)
	const cleanMergePoint = await findCleanMergeRef(action, 'release-5.8.0', 'main')

	// Should stop at the OLDEST relevant conflict (most conservative)
	// 68586 is older than 68602, so stop before 68586
	t.equal(cleanMergePoint, "9f32de6531d32091b43bf7910b7a2ed069e5bff1")
})

tap.test(`backwards compatible with old branch names`, async t => {
	// Old merge-conflicts branches without encoding should still work
	const logOutput = `616a75e1c27cecb46f05acbe2cfa11c6bf5e5b14  (HEAD -> release-5.8.0)
550b8a8b563627006af63ccf35ade57e1ecb6332
06e93ad498b0eef956edfa6b73b1a5d79cf7b95d  (origin/merge-conflicts-68586)
f8f591de2d7ff1ee154fbd486a2c5afab972e5ea
df05e8531bbe7896917157a1590ee4794688bde1  (origin/branch-here-release-5.8.0)`

	const action = new ActionStub(logOutput)
	const cleanMergePoint = await findCleanMergeRef(action, 'release-5.8.0', 'main')

	// Should treat old format as relevant (conservative approach)
	t.equal(cleanMergePoint, "f8f591de2d7ff1ee154fbd486a2c5afab972e5ea")
})

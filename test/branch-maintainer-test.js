const tap = require('tap')

const { mockCore } = require('gh-action-components')
const { TestBranchMaintainer, createMockShell } = require('./test-helpers')
const BranchMaintainer = require('../src/branch-maintainer')
const { buildDownstreamBranchChain } = require('../src/branch-maintainer')

process.env.GITHUB_REPOSITORY = 'spiderstrategies/unittest'

function createDeleteBranchMocks() {
	const deletedBranches = []
	const core = mockCore({})
	const mockShell = {
		core,
		async execQuietly(cmd) {
			if (cmd.startsWith('git push origin --delete ')) {
				const branchName = cmd.replace('git push origin --delete ', '')
				deletedBranches.push(branchName)
			}
		}
	}
	return { deletedBranches, core, mockShell }
}

tap.test('maintainBranches', async t => {
	const maintainer = new TestBranchMaintainer({
		config: {
			branches: { t: {} },
			mergeOperations: {}
		}
	})
	await maintainer.maintainBranches()
	// no blowup is the assertion, we expect an immediate break
})

tap.test('maintainBranches errors', async t => {
	const coreMock = mockCore({})
	const mockShell = {
		core: coreMock,
		async exec(cmd) {
			throw new Error('Shell error')
		}
	}

	const maintainer = new TestBranchMaintainer({
		config: {
			branches: { abc123: {}, efg456: {} },
			mergeOperations: {}
		},
		core: coreMock,
		shell: mockShell
	})

	await t.rejects(maintainer.maintainBranches(), 'should throw on error')
})

tap.test('cleanupMergeConflictsBranch detects simple merge-conflicts branches', async t => {
	const { deletedBranches, core, mockShell } = createDeleteBranchMocks()

	const maintainer = new BranchMaintainer({
		pullRequest: {
			number: 1,
			title: 'Merge conflicts #68875',
			head: {
				ref: 'merge-conflicts-68875'
			},
			body: 'Fixes #68875'
		},
		config: { branches: {}, mergeOperations: {} },
		core,
		shell: mockShell
	})

	await maintainer.cleanupMergeConflictsBranch()

	t.equal(deletedBranches.length, 1, 'should delete the merge-conflicts branch')
	t.equal(deletedBranches[0], 'merge-conflicts-68875', 'should delete the correct branch')
})

tap.test('cleanupMergeConflictsBranch detects encoded merge-conflicts branches', async t => {
	const { deletedBranches, core, mockShell } = createDeleteBranchMocks()

	const maintainer = new BranchMaintainer({
		pullRequest: {
			number: 2,
			title: 'Merge conflicts #68895',
			head: {
				ref: 'merge-conflicts-68895-release-5-7-2-to-release-5-8-0'
			},
			body: 'Fixes #68895'
		},
		config: { branches: {}, mergeOperations: {} },
		core,
		shell: mockShell
	})

	await maintainer.cleanupMergeConflictsBranch()

	t.equal(deletedBranches.length, 1, 'should delete the merge-conflicts branch')
	t.equal(deletedBranches[0], 'merge-conflicts-68895', 'should delete the correct branch')
})

tap.test('cleanupMergeConflictsBranch ignores non-merge-conflict branches', async t => {
	const { deletedBranches, core, mockShell } = createDeleteBranchMocks()

	const maintainer = new BranchMaintainer({
		pullRequest: {
			number: 3,
			head: {
				ref: 'feature-my-awesome-feature'
			},
			body: 'Fixes #12345'
		},
		config: { branches: {}, mergeOperations: {} },
		core,
		shell: mockShell
	})

	await maintainer.cleanupMergeConflictsBranch()

	t.equal(deletedBranches.length, 0, 'should not delete non-merge-conflicts branches')
})

tap.test('buildDownstreamBranchChain', async t => {

	t.test('single hop chain', async t => {
		const mergeOperations = {
			'release-5.7': 'main'
		}
		const chain = buildDownstreamBranchChain(mergeOperations, 'release-5.7')
		t.same(['main'], chain)
	})

	t.test('multi-hop chain', async t => {
		const mergeOperations = {
			'release-5.6': 'release-5.7',
			'release-5.7': 'release-5.8',
			'release-5.8': 'main'
		}
		const chain = buildDownstreamBranchChain(mergeOperations, 'release-5.6')
		t.same(['release-5.7', 'release-5.8', 'main'], chain)
	})

	t.test('terminal branch returns empty chain', async t => {
		const mergeOperations = {
			'release-5.7': 'main'
		}
		const chain = buildDownstreamBranchChain(mergeOperations, 'main')
		t.same([], chain)
	})

	t.test('mid-chain branch', async t => {
		const mergeOperations = {
			'release-5.6': 'release-5.7',
			'release-5.7': 'release-5.8',
			'release-5.8': 'main'
		}
		const chain = buildDownstreamBranchChain(mergeOperations, 'release-5.7')
		t.same(['release-5.8', 'main'], chain)
	})
})

tap.test('fastForward', async t => {
	t.test('creates new branch when branch does not exist', async t => {
		const execCalls = []
		const core = mockCore({})

		const mockShell = {
			core,
			async exec(cmd) {
				execCalls.push(cmd)
				if (cmd.includes('git ls-remote')) {
					return ''  // Branch doesn't exist
				}
				return ''
			}
		}

		const maintainer = new TestBranchMaintainer({
			core,
			shell: mockShell
		})

		await maintainer.fastForward('branch-here-release-5.7', 'abc123')

		t.ok(execCalls.find(c => c.includes('git checkout -b branch-here-release-5.7 abc123')),
			'should create new branch')
		t.ok(execCalls.find(c => c.includes('git push --set-upstream')),
			'should push new branch')
	})

	t.test('fast-forwards existing branch', async t => {
		const execCalls = []
		const core = mockCore({})

		const mockShell = {
			core,
			async exec(cmd) {
				execCalls.push(cmd)
				if (cmd.includes('git ls-remote')) {
					return 'refs/heads/branch-here-release-5.7'  // Branch exists
				}
				return ''
			}
		}

		const maintainer = new TestBranchMaintainer({
			core,
			shell: mockShell
		})

		await maintainer.fastForward('branch-here-release-5.7', 'def456')

		t.ok(execCalls.find(c => c.includes('git checkout branch-here-release-5.7')),
			'should checkout existing branch')
		t.ok(execCalls.find(c => c.includes('git pull')),
			'should pull latest changes')
		t.ok(execCalls.find(c => c.includes('git merge --ff-only def456')),
			'should fast-forward merge')
		t.ok(execCalls.find(c => c.includes('git push --set-upstream')),
			'should push changes')
	})
})

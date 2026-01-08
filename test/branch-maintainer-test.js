const tap = require('tap')

const { mockCore } = require('gh-action-components')
const { TestBranchMaintainer, createMockShell, createGitShellBehavior } = require('./test-helpers')
const BranchMaintainer = require('../src/branch-maintainer')

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

tap.test('cleanupMergeForwardBranches', async t => {
	t.test('deletes all merge-forward branches for a PR', async t => {
		const deletedBranches = []
		const core = mockCore({})

		const execBehavior = createGitShellBehavior({
			mergeForwardBranches: {
				'12345': [
					{ branch: 'release-5-7', sha: 'sha1' },
					{ branch: 'release-5-8', sha: 'sha2' },
					{ branch: 'main', sha: 'sha3' }
				]
			}
		})

		const mockShell = createMockShell(core, (cmd) => {
			if (cmd.startsWith('git push origin --delete ')) {
				const branchName = cmd.replace('git push origin --delete ', '')
				deletedBranches.push(branchName)
				return
			}
			return execBehavior(cmd)
		})

		const maintainer = new BranchMaintainer({
			pullRequest: {
				number: 12345,
				head: { ref: 'feature-branch' },
				base: { ref: 'release-5.7' },
				merged: true
			},
			config: { branches: {}, mergeOperations: {} },
			core,
			shell: mockShell
		})

		await maintainer.cleanupMergeForwardBranches()

		t.equal(deletedBranches.length, 3, 'should delete all three merge-forward branches')
		t.ok(deletedBranches.includes('merge-forward-pr-12345-release-5-7'), 'should delete release-5-7 branch')
		t.ok(deletedBranches.includes('merge-forward-pr-12345-release-5-8'), 'should delete release-5-8 branch')
		t.ok(deletedBranches.includes('merge-forward-pr-12345-main'), 'should delete main branch')
	})

	t.test('handles case when no merge-forward branches exist', async t => {
		const deletedBranches = []
		const core = mockCore({})

		const execBehavior = createGitShellBehavior({
			mergeForwardBranches: {}  // No branches for any PR
		})

		const mockShell = createMockShell(core, (cmd) => {
			if (cmd.startsWith('git push origin --delete ')) {
				const branchName = cmd.replace('git push origin --delete ', '')
				deletedBranches.push(branchName)
				return
			}
			return execBehavior(cmd)
		})

		const maintainer = new BranchMaintainer({
			pullRequest: {
				number: 99999,
				head: { ref: 'feature-branch' },
				base: { ref: 'main' },
				merged: true
			},
			config: { branches: {}, mergeOperations: {} },
			core,
			shell: mockShell
		})

		await maintainer.cleanupMergeForwardBranches()

		t.equal(deletedBranches.length, 0, 'should not attempt to delete non-existent branches')
	})
})

tap.test('run calls cleanup when commits reach main', async t => {
	const deletedBranches = []
	const core = mockCore({})

	const execBehavior = createGitShellBehavior({
		mergeForwardBranches: {
			'555': [
				{ branch: 'release-5-7', sha: 'sha1' },
				{ branch: 'main', sha: 'sha2' }
			]
		}
	})

	const mockShell = createMockShell(core, (cmd) => {
		if (cmd.startsWith('git push origin --delete ')) {
			const branchName = cmd.replace('git push origin --delete ', '')
			deletedBranches.push(branchName)
			return
		}
		return execBehavior(cmd)
	})

	const maintainer = new TestBranchMaintainer({
		pullRequest: {
			number: 555,
			head: { ref: 'feature-branch' },
			base: { ref: 'release-5.7' },
			merged: true
		},
		config: {
			branches: { main: {} },
			mergeOperations: {}
		},
		core,
		shell: mockShell
	})

	// Override maintainBranches to avoid complex test setup
	maintainer.maintainBranches = async () => {}

	await maintainer.run({ automergeConflictBranch: undefined })

	t.ok(deletedBranches.length > 0, 'should cleanup merge-forward branches when commits reach main')
	t.ok(deletedBranches.includes('merge-forward-pr-555-release-5-7'), 'should delete merge-forward branches')
})

tap.test('run does not cleanup when commits blocked', async t => {
	const deletedBranches = []
	const core = mockCore({})

	const execBehavior = createGitShellBehavior({
		mergeForwardBranches: {
			'666': [
				{ branch: 'release-5-7', sha: 'sha1' }
			]
		}
	})

	const mockShell = createMockShell(core, (cmd) => {
		if (cmd.startsWith('git push origin --delete merge-forward')) {
			const branchName = cmd.replace('git push origin --delete ', '')
			deletedBranches.push(branchName)
			return
		}
		return execBehavior(cmd)
	})

	const maintainer = new TestBranchMaintainer({
		pullRequest: {
			number: 666,
			head: { ref: 'feature-branch' },
			base: { ref: 'release-5.7' },
			merged: true
		},
		config: {
			branches: { 'release-5.8': {}, main: {} },
			mergeOperations: {}
		},
		core,
		shell: mockShell
	})

	// Commits blocked at release-5.8
	await maintainer.run({ automergeConflictBranch: 'release-5.8' })

	t.equal(deletedBranches.length, 0, 'should not cleanup merge-forward branches when commits are blocked')
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

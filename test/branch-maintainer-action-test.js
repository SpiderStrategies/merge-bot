const tap = require('tap')

const { mockCore } = require('gh-action-components')

const BranchMaintainerAction = require('../src/maintain-branches')

const serverUrl = 'https://github.com'
const runId = 1935306317

process.env.GITHUB_REPOSITORY = 'spiderstrategies/unittest'

class ActionStub extends BranchMaintainerAction {

	constructor(options = {}) {
		super(options)
		this.repoUrl = `https://github.com/sample/repo`
		this.conflictBranch = 'conflict-branch'
		this.issueUrl = 'https://github.com/sample/repo/1#issuecomment-123xyz'
		this.actionUrl = `${serverUrl}/sample/repo/actions/runs/${runId}`
	}

	async exec(cmd) {
		if (cmd.startsWith('git log')) {
			return this.logOutput
		}
	}
}

tap.test(`maintainBranches`, async t => {
	let action = new ActionStub({})
	action.config = {
		branches: ['t']
	}
	action.terminalBranch = 't'
	await action.maintainBranches()
	// no blowup is the assertion, we expect an immediate break
})

tap.test(`maintainBranches errors`, async t => {
	let action = new ActionStub({})
	  , coreMock = mockCore({})

	action.config = {
		branches: ['abc123', 'efg456']
	}
	action.core = coreMock
	action.terminalBranch = 't'
	await action.maintainBranches()
	t.equal(coreMock.outputs['status'], 'failure')
})

tap.test('deleteBranch detects simple merge-conflicts branches', async t => {
	const deletedBranches = []

	class TestAction extends BranchMaintainerAction {
		constructor(options) {
			super(options)
		}

		async fetchCommits() {
			return { data: [] }
		}

		async execQuietly(cmd) {
			if (cmd.startsWith('git push origin --delete ')) {
				const branchName = cmd.replace('git push origin --delete ', '')
				deletedBranches.push(branchName)
			}
		}
	}

	const action = new TestAction({
		pullRequest: {
			number: 1,
			title: 'Merge conflicts #68875',
			head: {
				ref: 'merge-conflicts-68875'
			},
			body: 'Fixes #68875'
		}
	})

	await action.deleteBranch()

	t.equal(deletedBranches.length, 1, 'should delete the merge-conflicts branch')
	t.equal(deletedBranches[0], 'merge-conflicts-68875', 'should delete the correct branch')
})

tap.test('deleteBranch detects encoded merge-conflicts branches', async t => {
	const deletedBranches = []

	class TestAction extends BranchMaintainerAction {
		constructor(options) {
			super(options)
		}

		async fetchCommits() {
			return { data: [] }
		}

		async execQuietly(cmd) {
			if (cmd.startsWith('git push origin --delete ')) {
				const branchName = cmd.replace('git push origin --delete ', '')
				deletedBranches.push(branchName)
			}
		}
	}

	const action = new TestAction({
		pullRequest: {
			number: 2,
			title: 'Merge conflicts #68895',
			head: {
				ref: 'merge-conflicts-68895-release-5-7-2-to-release-5-8-0'
			},
			body: 'Fixes #68895'
		}
	})

	await action.deleteBranch()

	t.equal(deletedBranches.length, 1, 'should delete the merge-conflicts branch')
	t.equal(deletedBranches[0], 'merge-conflicts-68895', 'should delete the correct branch')
})

tap.test('deleteBranch ignores non-merge-conflict branches', async t => {
	const deletedBranches = []

	class TestAction extends BranchMaintainerAction {
		constructor(options) {
			super(options)
		}

		async fetchCommits() {
			return { data: [] }
		}

		async execQuietly(cmd) {
			if (cmd.startsWith('git push origin --delete ')) {
				const branchName = cmd.replace('git push origin --delete ', '')
				deletedBranches.push(branchName)
			}
		}
	}

	const action = new TestAction({
		pullRequest: {
			number: 3,
			head: {
				ref: 'feature-my-awesome-feature'
			},
			body: 'Fixes #12345'
		}
	})

	await action.deleteBranch()

	t.equal(deletedBranches.length, 0, 'should not delete non-merge-conflicts branches')
})

tap.test('buildDownstreamBranchChain', async t => {
	const action = new ActionStub({})

	t.test('single hop chain', async t => {
		action.config = {
			mergeOperations: {
				'release-5.7': 'main'
			}
		}
		const chain = action.buildDownstreamBranchChain('release-5.7')
		t.same(['main'], chain)
	})

	t.test('multi-hop chain', async t => {
		action.config = {
			mergeOperations: {
				'release-5.6': 'release-5.7',
				'release-5.7': 'release-5.8',
				'release-5.8': 'main'
			}
		}
		const chain = action.buildDownstreamBranchChain('release-5.6')
		t.same(['release-5.7', 'release-5.8', 'main'], chain)
	})

	t.test('terminal branch returns empty chain', async t => {
		action.config = {
			mergeOperations: {
				'release-5.7': 'main'
			}
		}
		const chain = action.buildDownstreamBranchChain('main')
		t.same([], chain)
	})

	t.test('mid-chain branch', async t => {
		action.config = {
			mergeOperations: {
				'release-5.6': 'release-5.7',
				'release-5.7': 'release-5.8',
				'release-5.8': 'main'
			}
		}
		const chain = action.buildDownstreamBranchChain('release-5.7')
		t.same(['release-5.8', 'main'], chain)
	})
})

tap.test('readConfig', async t => {
	t.test('skips config when no configFile provided', async t => {
		const action = new ActionStub({
			baseBranch: 'main'
		})

		await action.readConfig()

		// When no configFile, config is not set by readConfig
		// (config would be set directly in tests)
		t.pass('should not throw when no configFile')
	})
})

tap.test('fastForward', async t => {
	t.test('creates new branch when branch does not exist', async t => {
		const execCalls = []

		class TestAction extends ActionStub {
			async exec(cmd) {
				execCalls.push(cmd)
				if (cmd.includes('git ls-remote')) {
					return ''  // Branch doesn't exist
				}
				return ''
			}
		}

		const action = new TestAction({})
		action.core = mockCore({})

		await action.fastForward('branch-here-release-5.7', 'abc123')

		t.ok(execCalls.find(c => c.includes('git checkout -b branch-here-release-5.7 abc123')),
			'should create new branch')
		t.ok(execCalls.find(c => c.includes('git push --set-upstream')),
			'should push new branch')
	})

	t.test('fast-forwards existing branch', async t => {
		const execCalls = []

		class TestAction extends ActionStub {
			async exec(cmd) {
				execCalls.push(cmd)
				if (cmd.includes('git ls-remote')) {
					return 'refs/heads/branch-here-release-5.7'  // Branch exists
				}
				return ''
			}
		}

		const action = new TestAction({})
		action.core = mockCore({})

		await action.fastForward('branch-here-release-5.7', 'def456')

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
